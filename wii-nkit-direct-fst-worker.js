self.onmessage = async (event) => {
  const file = event.data?.file;
  if (!file) return self.postMessage("FAIL: no file received");
  const hex = (bytes) => Array.from(bytes, b => b.toString(16).padStart(2, "0")).join(" ");
  const u32 = (bytes, offset) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, false);
  const read = async (offset, length) => new Uint8Array(await file.slice(offset, offset + length).arrayBuffer());
  try {
    if (file.size < 0x80000) throw new Error("File is too small to be a Wii NKit image.");
    const disc = await read(0, 0x500);
    const discId = new TextDecoder().decode(disc.slice(0, 6));
    const magic = u32(disc, 0x18);
    const nkitMagic = new TextDecoder().decode(disc.slice(0x200, 0x204));
    const nkitVersion = new TextDecoder().decode(disc.slice(0x204, 0x208));
    const marker60 = disc[0x60];
    const marker61 = disc[0x61];

    const partitionTable = await read(0x40000, 0x40);
    let tableCount = 0, tableOffset = 0, partitionOffset = 0, partitionType = -1;
    for (let i = 0; i < 4; i++) {
      const count = u32(partitionTable, i * 8);
      const offWords = u32(partitionTable, i * 8 + 4);
      if (count > 0 && count < 10000 && offWords > 0) {
        const table = await read(offWords * 4, Math.min(count * 8, 0x10000));
        for (let j = 0; j < count; j++) {
          const off = u32(table, j * 8) * 4;
          const type = u32(table, j * 8 + 4);
          if (type === 0) {
            tableCount = count; tableOffset = offWords * 4; partitionOffset = off; partitionType = type; break;
          }
        }
      }
      if (partitionOffset) break;
    }
    if (!partitionOffset) throw new Error("No type-0 data partition found in the standard partition table.");

    const phead = await read(partitionOffset, 0x500);
    const dataOffsetWords = u32(phead, 0x2b8);
    const dataSizeWords = u32(phead, 0x2bc);
    const dataOffset = dataOffsetWords * 4;
    const dataStart = partitionOffset + dataOffset;
    const boot = await read(dataStart, 0x440);
    const fstOffsetRaw = u32(boot, 0x424);
    const fstSizeRaw = u32(boot, 0x428);
    const fstMaxRaw = u32(boot, 0x42c);
    const fstOffset = fstOffsetRaw * 4;
    const fstSize = fstSizeRaw * 4;
    const fstAbs = dataStart + fstOffset;

    let fst = new Uint8Array(0);
    if (fstOffset > 0 && fstSize >= 12 && fstAbs + Math.min(fstSize, 64) <= file.size) {
      fst = await read(fstAbs, Math.min(fstSize, 64));
    }
    const firstWord = fst.length >= 4 ? u32(fst, 0) : 0;
    const nameOffset = fst.length >= 8 ? u32(fst, 4) : 0;
    const nextIndex = fst.length >= 12 ? u32(fst, 8) : 0;
    const rootLooksValid = firstWord === 0x01000000 && nameOffset === 0 && nextIndex > 0 && nextIndex < 0x1000000;

    const lines = [
      "PASS — range reads completed",
      `Disc ID: ${discId}`,
      `File size: ${file.size.toLocaleString("en-US")} bytes`,
      `Wii magic: 0x${magic.toString(16)}`,
      `NKit marker @0x200: "${nkitMagic}"`,
      `NKit version field: "${nkitVersion}"`,
      `Header bytes 0x60/0x61: 0x${marker60.toString(16)} / 0x${marker61.toString(16)} (NKit convention; not an encryption flag by itself)`,
      `Type-0 partition: ${partitionOffset ? "0x" + partitionOffset.toString(16) : "not found"} (table 0x${tableOffset.toString(16)}, entries ${tableCount})`,
      `Partition data offset raw: 0x${dataOffsetWords.toString(16)} words -> 0x${dataOffset.toString(16)} bytes`,
      `Partition data length raw: 0x${dataSizeWords.toString(16)} words -> 0x${(dataSizeWords * 4).toLocaleString("en-US")} bytes (NKit header length may be compacted)`,
      `Partition data start: 0x${dataStart.toString(16)}`,
      `Direct boot header ID: ${new TextDecoder().decode(boot.slice(0, 6))}; Wii magic @+0x18: 0x${u32(boot, 0x18).toString(16)}`,
      `FST raw fields: offset=0x${fstOffsetRaw.toString(16)}, size=0x${fstSizeRaw.toString(16)}, max=0x${fstMaxRaw.toString(16)}`,
      `FST shifted fields: offset=0x${fstOffset.toString(16)}, size=0x${fstSize.toString(16)}, max=0x${(fstMaxRaw * 4).toString(16)}`,
      `Direct FST file offset: 0x${fstAbs.toString(16)}`,
      `FST first 32 bytes: ${fst.length ? hex(fst.slice(0, 32)) : "(not read — range invalid or FST fields zero)"}`,
      `FST root: firstWord=0x${firstWord.toString(16)}, nameOffset=0x${nameOffset.toString(16)}, nextIndex=0x${nextIndex.toString(16)}`,
      `FST root shape: ${rootLooksValid ? "VALID" : "NOT VALIDATED"}`,
      "Whole ISO copied: NO — only small File.slice ranges were read.",
      "Note: this checks NKit metadata and direct FST placement only. It does not implement NKit gap decoding, reconstruct omitted data, or boot the game."
    ];
    self.postMessage(lines.join("\n"));
  } catch (e) {
    self.postMessage("FAIL\n" + (e?.stack || e?.message || String(e)));
  }
};