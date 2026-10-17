function be32(bytes, offset) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, false);
}
async function readRange(file, offset, length) {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset + length > file.size) {
    throw new Error('Requested range is outside the selected file: offset=' + offset + ', length=' + length);
  }
  return new Uint8Array(await file.slice(offset, offset + length).arrayBuffer());
}
self.onmessage = async (event) => {
  const file = event.data && event.data.file;
  if (!file) {
    self.postMessage({type:'error', message:'No File object was received.'});
    return;
  }
  try {
    const sizeGiB = (file.size / (1024 ** 3)).toFixed(2);
    self.postMessage({type:'status', message:'Selected: ' + file.name + '\nSize: ' + file.size.toLocaleString() + ' bytes (' + sizeGiB + ' GiB)\nReading 0x440-byte disc header…'});
    const header = await readRange(file, 0, 0x440);
    const wiiMagic = Array.from(header.slice(0x18, 0x1c)).map(x=>x.toString(16).padStart(2,'0')).join('').toUpperCase();
    const gcMagic = Array.from(header.slice(0x1c, 0x20)).map(x=>x.toString(16).padStart(2,'0')).join('').toUpperCase();
    const isWii = wiiMagic === '5D1C9EA3';
    const isGc = gcMagic === 'C2339F3D';
    if (!isWii && !isGc) {
      throw new Error('Disc magic not recognized. Wii magic at 0x18: ' + wiiMagic + '; GameCube magic at 0x1C: ' + gcMagic + '. The file may be an unsupported/repacked image.');
    }
    // Wii disc headers store these offsets/sizes in units of 4 bytes; GameCube headers store byte values.
    // Gecko's unshift_wii_header_offsets() applies this same << 2 conversion to 0x420..0x434.
    const rawFstOffset = be32(header, 0x424);
    const rawFstSize = be32(header, 0x428);
    const fstOffset = isWii ? rawFstOffset * 4 : rawFstOffset;
    const fstSize = isWii ? rawFstSize * 4 : rawFstSize;
    if (isWii && (!fstOffset || !fstSize)) {
      // Wii discs normally keep game files inside an encrypted data partition;
      // the GameCube-style header FST fields can be zero and are not the right path.
      const partitionInfo = await readRange(file, 0x40000, 0x20);
      const groups = [];
      for (let group = 0; group < 4; group++) {
        const base = group * 8;
        const count = be32(partitionInfo, base);
        const tableOffsetRaw = be32(partitionInfo, base + 4);
        const tableOffset = tableOffsetRaw * 4;
        let firstPartition = null;
        if (count > 0 && tableOffset > 0 && tableOffset + 8 <= file.size) {
          const entry = await readRange(file, tableOffset, 8);
          firstPartition = {
            offset: be32(entry, 0) * 4,
            type: be32(entry, 4)
          };
        }
        groups.push('Group ' + group + ': count=' + count +
          ', tableOffsetRaw=0x' + tableOffsetRaw.toString(16) +
          ', tableOffset=0x' + tableOffset.toString(16) +
          (firstPartition ? ', firstPartition=0x' + firstPartition.offset.toString(16) +
            ', type=' + firstPartition.type : ''));
      }
      self.postMessage({type:'result', ok:true, message:
        'Wii disc header recognized, but its header FST offset/size are zero.\n' +
        'This can be normal for Wii discs: the game filesystem is inside the encrypted data partition, not at the GameCube-style header FST range.\n' +
        'Header bytes read: ' + header.length.toLocaleString() +
        '\nPartition table bytes read: ' + partitionInfo.length.toLocaleString() +
        '\nTotal bytes read by test: ' + (header.length + partitionInfo.length).toLocaleString() +
        '\nWhole file copied: NO\n\nPartition table diagnostics:\n' + groups.join('\n') +
        '\n\nThis confirms only disc-header/partition-table range reads. Reading game files requires Wii partition handling/decryption and possibly NKit-specific support.'
      });
      return;
    }
    if (!fstOffset || !fstSize || fstOffset + fstSize > file.size) {
      throw new Error('Filesystem table range is invalid for this file. Offset=' + fstOffset + ', size=' + fstSize + ', file=' + file.size + ' bytes.');
    }
    if (fstSize > 128 * 1024 * 1024) {
      throw new Error('Filesystem table is unusually large (' + fstSize + ' bytes); stopped before allocating a large buffer.');
    }
    self.postMessage({type:'status', message:'Disc header recognized (' + (isWii ? 'Wii' : 'GameCube') + ').\nReading filesystem table range only…\nFST offset: 0x' + fstOffset.toString(16) + '\nFST size: ' + fstSize.toLocaleString() + ' bytes'});
    const fst = await readRange(file, fstOffset, fstSize);
    if (fst.length < 12) throw new Error('Filesystem table is too short to contain its root entry.');
    const entries = be32(fst, 8);
    const entryBytes = entries * 12;
    if (!entries || entryBytes > fst.length) {
      throw new Error('FST entry count is invalid: ' + entries + ' entries require ' + entryBytes + ' bytes, but FST size is ' + fst.length + '.');
    }
    const stringTableBytes = fst.length - entryBytes;
    const sampleNames = [];
    const maxEntries = Math.min(entries, 2000);
    for (let i = 0; i < maxEntries; i++) {
      const base = i * 12;
      const nameOffset = fst[base] * 0x1000000 + fst[base + 1] * 0x10000 + fst[base + 2] * 0x100 + fst[base + 3];
      if (nameOffset >= stringTableBytes) continue;
      const start = entryBytes + nameOffset;
      let end = start;
      while (end < fst.length && fst[end] !== 0) end++;
      if (end > start) {
        const name = new TextDecoder('utf-8').decode(fst.subarray(start, Math.min(end, start + 160)));
        if (name && sampleNames.length < 12) sampleNames.push(name);
      }
    }
    self.postMessage({type:'result', ok:true, message:
      'Disc type: ' + (isWii ? 'Wii' : 'GameCube') +
      '\nHeader bytes read: ' + header.length.toLocaleString() +
      '\nFST bytes read: ' + fst.length.toLocaleString() +
      '\nTotal bytes read by test: ' + (header.length + fst.length).toLocaleString() +
      '\nWhole file copied: NO' +
      '\nFST entries reported: ' + entries.toLocaleString() +
      '\nString table bytes: ' + stringTableBytes.toLocaleString() +
      '\nSample FST names: ' + (sampleNames.length ? sampleNames.join(', ') : '(none decoded)') +
      '\n\nThis is an ISO range-read/metadata pass, not a game boot test.'
    });
  } catch (error) {
    self.postMessage({type:'result', ok:false, message:error && error.stack ? error.stack : String(error)});
  }
};