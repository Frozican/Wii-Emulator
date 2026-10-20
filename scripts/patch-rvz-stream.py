#!/usr/bin/env python3
"""Stream RVZ discs block by block instead of loading the whole file into memory.

Run AFTER patch-gecko-web.py, patch-panic-diagnostics.py, patch-boot-stages.py
and patch-rom-upload.py, and BEFORE the wasm-pack build.

What it does
------------
* image crate (rvz.rs): adds RvzStream, which reads the RVZ header, the
  raw-data/group tables, the partition table and the disc header/apploader
  through async range reads (RangeSource). Every later disc read fetches only
  the compressed group(s) it needs, decodes them (incl. Wii partition hash
  exceptions + junk unpacking) and throws them away again.
* Boot: Gecko's apploader HLE reads the disc synchronously. StreamDvd serves
  those reads from a small prefetched SparseDisc (boot header, apploader, main
  DOL, FST, partition header) that is filled asynchronously beforehand.
* Runtime: the existing asynchronous DI read path is switched on and routed to
  RvzStream::read_disc instead of FileRangeReader.
* Browser: .rvz files are no longer copied into WASM memory at all; the page
  calls prepare_rvz_stream(file) before start_emulator().
"""
from pathlib import Path

root = Path("gecko-src")
rvz_rs = root / "crates/image/src/rvz.rs"
web_rs = root / "crates/web/src/lib.rs"
web_html = root / "crates/web/index.html"


def replace_once(path: Path, old: str, new: str) -> None:
    text = path.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"Expected one patch target in {path}: {old[:90]!r}; found {count}")
    path.write_text(text.replace(old, new, 1))


# ======================================================================
# 1. image crate: streaming RVZ reader
# ======================================================================
RVZ_STREAM = r'''

// ===========================================================================
// Streaming RVZ. Header, tables and data blocks are fetched on demand through
// a RangeSource, so the compressed file never has to fit into memory.
// ===========================================================================

/// Asynchronous random access to the (compressed) RVZ file.
#[allow(async_fn_in_trait)]
pub trait RangeSource {
    async fn read_range(&self, offset: u64, length: usize) -> Result<Vec<u8>, String>;
}

fn compression_code(compression: Compression) -> u32 {
    match compression {
        Compression::None => 0,
        Compression::Zstd => 5,
    }
}

async fn fetch_group_payload<S: RangeSource>(src: &S, group: &GroupEntry) -> Result<Vec<u8>, String> {
    if group.stored_size == 0 {
        return Ok(Vec::new());
    }
    src.read_range(group.file_offset, group.stored_size as usize).await
}

#[allow(clippy::too_many_arguments)]
async fn read_into_async<S: RangeSource>(
    src: &S,
    disc_header: &[u8; 0x80],
    chunk_size: u32,
    compression: Compression,
    raw_data: &[RawData],
    groups: &[GroupEntry],
    mut offset: u64,
    len: usize,
) -> Result<Vec<u8>, String> {
    let mut buf = vec![0u8; len];
    let mut buf_off = 0usize;
    let mut remaining = len;

    if offset < 0x80 {
        let take = core::cmp::min(0x80 - offset as usize, remaining);
        buf[buf_off..buf_off + take].copy_from_slice(&disc_header[offset as usize..offset as usize + take]);
        buf_off += take;
        offset += take as u64;
        remaining -= take;
    }

    while remaining > 0 {
        let rd = raw_data
            .iter()
            .find(|r| offset >= r.data_offset && offset < r.data_offset + r.data_size)
            .ok_or_else(|| format!("disc offset {offset:#x} is not covered by any RVZ raw-data entry"))?;

        let within = offset - rd.data_offset;
        let group_idx = (within / chunk_size as u64) as u32;
        if group_idx >= rd.num_groups {
            return Err(format!("RVZ group index {group_idx} out of range"));
        }

        let group_offset_in_data = (group_idx as u64) * (chunk_size as u64);
        let this_chunk_size = core::cmp::min(chunk_size as u64, rd.data_size - group_offset_in_data) as usize;

        let group = groups
            .get((rd.group_index + group_idx) as usize)
            .ok_or_else(|| "RVZ group table index out of range".to_string())?;
        let payload = fetch_group_payload(src, group).await?;
        let chunk = decode_block_payload(
            &payload,
            RvzBlockDescriptor {
                file_offset: group.file_offset,
                stored_size: group.stored_size,
                is_compressed: group.is_compressed,
                rvz_packed_size: group.rvz_packed_size,
            },
            compression_code(compression),
            this_chunk_size,
            group_offset_in_data,
        )?;

        let byte_off_in_chunk = (within - group_offset_in_data) as usize;
        let avail = this_chunk_size - byte_off_in_chunk;
        let take = core::cmp::min(avail, remaining);
        buf[buf_off..buf_off + take].copy_from_slice(&chunk[byte_off_in_chunk..byte_off_in_chunk + take]);

        buf_off += take;
        offset += take as u64;
        remaining -= take;
    }

    Ok(buf)
}

async fn read_partition_decrypted_async<S: RangeSource>(
    src: &S,
    chunk_size: u32,
    compression: Compression,
    groups: &[GroupEntry],
    partition: &WiiPartition,
    mut offset: u64,
    len: usize,
) -> Result<Vec<u8>, String> {
    let sectors_per_chunk = (chunk_size as u64) / WII_BLOCK_TOTAL_SIZE;
    if sectors_per_chunk < 1 {
        return Err("RVZ chunk_size is smaller than one Wii sector".to_string());
    }
    let chunk_user_size = sectors_per_chunk * WII_BLOCK_DATA_SIZE;

    let mut buf = vec![0u8; len];
    let mut buf_off = 0usize;
    let mut remaining = len;

    while remaining > 0 {
        let mut slot_user_start: u64 = 0;
        let mut slot_opt: Option<&WiiPartitionData> = None;
        for s in &partition.data {
            let slot_user_size = (s.num_sectors as u64) * WII_BLOCK_DATA_SIZE;
            if s.num_sectors > 0 && offset >= slot_user_start && offset < slot_user_start + slot_user_size {
                slot_opt = Some(s);
                break;
            }
            slot_user_start += slot_user_size;
        }
        let slot = slot_opt.ok_or_else(|| format!("partition offset {offset:#x} is out of range"))?;

        let within_slot = offset - slot_user_start;
        let chunk_idx = within_slot / chunk_user_size;
        if (chunk_idx as u32) >= slot.num_groups {
            return Err(format!(
                "partition chunk index {chunk_idx} >= num_groups {}",
                slot.num_groups
            ));
        }

        let chunk_first_sector_in_slot = chunk_idx * sectors_per_chunk;
        let sectors_in_this_chunk = core::cmp::min(
            sectors_per_chunk,
            (slot.num_sectors as u64) - chunk_first_sector_in_slot,
        );
        let this_chunk_user_size = (sectors_in_this_chunk * WII_BLOCK_DATA_SIZE) as usize;

        let group = groups
            .get((slot.group_index as u64 + chunk_idx) as usize)
            .ok_or_else(|| "RVZ partition group index out of range".to_string())?;
        let chunk_disc_offset_enc = (slot.first_sector as u64 + chunk_first_sector_in_slot) * WII_BLOCK_TOTAL_SIZE;

        // decompress_partition_chunk() expects the whole file; hand it just this
        // block's payload and a group whose file offset points at its start.
        let payload = fetch_group_payload(src, group).await?;
        let local_group = GroupEntry { file_offset: 0, ..*group };
        let chunk = decompress_partition_chunk(
            &payload,
            &local_group,
            this_chunk_user_size,
            compression,
            chunk_disc_offset_enc,
        );

        let byte_off_in_chunk = (within_slot - chunk_idx * chunk_user_size) as usize;
        let avail = this_chunk_user_size - byte_off_in_chunk;
        let take = core::cmp::min(avail, remaining);
        buf[buf_off..buf_off + take].copy_from_slice(&chunk[byte_off_in_chunk..byte_off_in_chunk + take]);

        buf_off += take;
        offset += take as u64;
        remaining -= take;
    }

    Ok(buf)
}

async fn pick_data_partition_async<S: RangeSource>(
    src: &S,
    disc_header: &[u8; 0x80],
    chunk_size: u32,
    compression: Compression,
    raw_data: &[RawData],
    groups: &[GroupEntry],
    partitions: &[WiiPartition],
) -> Result<usize, String> {
    let group_table = read_into_async(
        src,
        disc_header,
        chunk_size,
        compression,
        raw_data,
        groups,
        WII_PARTITION_TABLE_OFFSET,
        32,
    )
    .await?;

    for g in 0..4 {
        let num = u32::from_be_bytes(group_table[g * 8..g * 8 + 4].try_into().unwrap());
        let off_shifted = u32::from_be_bytes(group_table[g * 8 + 4..g * 8 + 8].try_into().unwrap());
        if num == 0 {
            continue;
        }
        if num > 0x1000 {
            return Err(format!("implausible Wii partition count {num}"));
        }
        let table_off = (off_shifted as u64) << 2;

        let entries = read_into_async(
            src,
            disc_header,
            chunk_size,
            compression,
            raw_data,
            groups,
            table_off,
            (num as usize) * 8,
        )
        .await?;

        for e in 0..num as usize {
            let part_off = (u32::from_be_bytes(entries[e * 8..e * 8 + 4].try_into().unwrap()) as u64) << 2;
            let part_type = u32::from_be_bytes(entries[e * 8 + 4..e * 8 + 8].try_into().unwrap());
            if part_type != 0 {
                continue;
            }
            let expected_first_sector = (part_off + WII_PARTITION_DATA_OFFSET) / WII_BLOCK_TOTAL_SIZE;
            if let Some(idx) = partitions
                .iter()
                .position(|p| (p.data[0].first_sector as u64) == expected_first_sector)
            {
                return Ok(idx);
            }
        }
    }

    Err("Wii RVZ has no data partition (type=0) matching any RVZ partition entry".to_string())
}

/// RVZ metadata (tables only). Data blocks are fetched per read.
pub struct RvzStream {
    disc_header: [u8; 0x80],
    iso_size: u64,
    chunk_size: u32,
    compression: Compression,
    raw_data: Vec<RawData>,
    groups: Vec<GroupEntry>,
    partitions: Vec<WiiPartition>,
    data_partition: Option<usize>,
}

impl RvzStream {
    /// Parse header, tables and partition info using range reads only.
    pub async fn open<S: RangeSource>(src: &S) -> Result<(RvzStream, Header, Apploader), String> {
        const HEADER_REQUIRED: usize = H1_SIZE + H2_GROUPS_SIZE + 4;
        const MAX_TABLE_BYTES: usize = 16 * 1024 * 1024;

        let head = src.read_range(0, HEADER_REQUIRED).await?;
        if head.len() < HEADER_REQUIRED {
            return Err("RVZ header is truncated".to_string());
        }
        if head[0..4] != RVZ_MAGIC[..] {
            return Err("not an RVZ file (bad magic)".to_string());
        }

        let file_iso_size = be64(&head, H1_ISO_FILE_SIZE);
        let h2 = H1_SIZE;

        let disc_type = be32(&head, h2 + H2_DISC_TYPE);
        if disc_type != 1 && disc_type != 2 {
            return Err(format!("unsupported RVZ disc_type={disc_type} (1=GameCube, 2=Wii)"));
        }
        let compression = match be32(&head, h2 + H2_COMPRESSION_TYPE) {
            0 => Compression::None,
            5 => Compression::Zstd,
            other => return Err(format!("unsupported RVZ compression type {other}")),
        };
        let chunk_size = be32(&head, h2 + H2_CHUNK_SIZE);
        if chunk_size == 0 {
            return Err("RVZ chunk size is zero".to_string());
        }

        let mut disc_header = [0u8; DISC_HEADER_SIZE];
        disc_header.copy_from_slice(&head[h2 + H2_DISC_HEADER..h2 + H2_DISC_HEADER + DISC_HEADER_SIZE]);

        let num_raw_data = be32(&head, h2 + H2_NUM_RAW_DATA);
        let raw_data_off = be64(&head, h2 + H2_RAW_DATA_OFFSET);
        let raw_data_compressed_size = be32(&head, h2 + H2_RAW_DATA_SIZE) as usize;
        let num_groups = be32(&head, h2 + H2_NUM_GROUPS);
        let groups_off = be64(&head, h2 + H2_GROUPS_OFFSET);
        let groups_compressed_size = be32(&head, h2 + H2_GROUPS_SIZE) as usize;
        if raw_data_compressed_size > MAX_TABLE_BYTES || groups_compressed_size > MAX_TABLE_BYTES {
            return Err("RVZ metadata table exceeds the 16 MiB safety limit".to_string());
        }

        let raw_payload = src.read_range(raw_data_off, raw_data_compressed_size).await?;
        let raw_blob = decompress_metadata_checked(
            &raw_payload,
            compression,
            (num_raw_data as usize) * RAW_DATA_ENTRY_SIZE,
        )?;
        let raw_data = parse_raw_data(&raw_blob, num_raw_data);

        let groups_payload = src.read_range(groups_off, groups_compressed_size).await?;
        let groups_blob = decompress_metadata_checked(
            &groups_payload,
            compression,
            (num_groups as usize) * RVZ_GROUP_ENTRY_SIZE,
        )?;
        let groups = parse_groups(&groups_blob, num_groups);

        let (partitions, data_partition) = if disc_type == 2 {
            let num_partitions = be32(&head, h2 + H2_NUM_PARTITIONS);
            let entry_size = be32(&head, h2 + H2_PARTITION_ENTRY_SIZE) as usize;
            let entries_off = be64(&head, h2 + H2_PARTITION_ENTRIES_OFFSET);
            if entry_size < RVZ_PARTITION_ENTRY_SIZE {
                return Err(format!("RVZ partition_entry_size {entry_size} is too small"));
            }
            if num_partitions == 0 || (num_partitions as usize) * entry_size > MAX_TABLE_BYTES {
                return Err("RVZ partition table is empty or implausibly large".to_string());
            }
            let blob = src.read_range(entries_off, (num_partitions as usize) * entry_size).await?;
            let partitions = parse_partitions(&blob, num_partitions, entry_size);
            let idx = pick_data_partition_async(
                src,
                &disc_header,
                chunk_size,
                compression,
                &raw_data,
                &groups,
                &partitions,
            )
            .await?;
            (partitions, Some(idx))
        } else {
            (Vec::new(), None)
        };

        let (header, apploader, iso_size) = match data_partition {
            None => {
                let header_vec = read_into_async(
                    src,
                    &disc_header,
                    chunk_size,
                    compression,
                    &raw_data,
                    &groups,
                    DVD_HEADER_OFFSET as u64,
                    DVD_HEADER_SIZE,
                )
                .await?;
                let mut header_bytes = [0u8; DVD_HEADER_SIZE];
                header_bytes.copy_from_slice(&header_vec);
                let header = Header::read_from_bytes(&header_bytes).map_err(|_| "invalid DVD header".to_string())?;

                let apploader_vec = read_into_async(
                    src,
                    &disc_header,
                    chunk_size,
                    compression,
                    &raw_data,
                    &groups,
                    DVD_APPLOADER_OFFSET as u64,
                    DVD_APPLOADER_SIZE,
                )
                .await?;
                let mut apploader_bytes = [0u8; DVD_APPLOADER_SIZE];
                apploader_bytes.copy_from_slice(&apploader_vec);
                let apploader =
                    Apploader::read_from_bytes(&apploader_bytes).map_err(|_| "invalid apploader".to_string())?;
                (header, apploader, file_iso_size)
            }
            Some(idx) => {
                let partition = &partitions[idx];
                let partition_iso_size = partition_user_size(partition);

                let header_vec = read_partition_decrypted_async(
                    src,
                    chunk_size,
                    compression,
                    &groups,
                    partition,
                    DVD_HEADER_OFFSET as u64,
                    DVD_HEADER_SIZE,
                )
                .await?;
                let mut header_bytes = [0u8; DVD_HEADER_SIZE];
                header_bytes.copy_from_slice(&header_vec);
                crate::dvd::unshift_wii_header_offsets(&mut header_bytes);
                let header = Header::read_from_bytes(&header_bytes).map_err(|_| "invalid DVD header".to_string())?;

                let apploader_vec = read_partition_decrypted_async(
                    src,
                    chunk_size,
                    compression,
                    &groups,
                    partition,
                    DVD_APPLOADER_OFFSET as u64,
                    DVD_APPLOADER_SIZE,
                )
                .await?;
                let mut apploader_bytes = [0u8; DVD_APPLOADER_SIZE];
                apploader_bytes.copy_from_slice(&apploader_vec);
                let apploader =
                    Apploader::read_from_bytes(&apploader_bytes).map_err(|_| "invalid apploader".to_string())?;
                (header, apploader, partition_iso_size)
            }
        };

        Ok((
            RvzStream {
                disc_header,
                iso_size,
                chunk_size,
                compression,
                raw_data,
                groups,
                partitions,
                data_partition,
            },
            header,
            apploader,
        ))
    }

    pub fn iso_size(&self) -> u64 {
        self.iso_size
    }

    pub fn data_partition_offset(&self) -> u64 {
        match self.data_partition {
            Some(idx) => {
                (self.partitions[idx].data[0].first_sector as u64) * WII_BLOCK_TOTAL_SIZE - WII_PARTITION_DATA_OFFSET
            }
            None => 0,
        }
    }

    /// Same address space as Dvd::read_disc_into (partition-decrypted for Wii).
    pub async fn read_disc<S: RangeSource>(&self, src: &S, offset: u64, len: usize) -> Result<Vec<u8>, String> {
        let end = offset
            .checked_add(len as u64)
            .ok_or_else(|| "disc read range overflow".to_string())?;
        if end > self.iso_size {
            return Err(format!(
                "read past end of disc image ({offset:#x} + {len:#x} > {:#x})",
                self.iso_size
            ));
        }
        match self.data_partition {
            None => {
                read_into_async(
                    src,
                    &self.disc_header,
                    self.chunk_size,
                    self.compression,
                    &self.raw_data,
                    &self.groups,
                    offset,
                    len,
                )
                .await
            }
            Some(idx) => {
                read_partition_decrypted_async(
                    src,
                    self.chunk_size,
                    self.compression,
                    &self.groups,
                    &self.partitions[idx],
                    offset,
                    len,
                )
                .await
            }
        }
    }

    /// Same address space as Dvd::read_raw_disc (encrypted physical disc layout).
    pub async fn read_raw<S: RangeSource>(&self, src: &S, offset: u64, len: usize) -> Result<Vec<u8>, String> {
        read_into_async(
            src,
            &self.disc_header,
            self.chunk_size,
            self.compression,
            &self.raw_data,
            &self.groups,
            offset,
            len,
        )
        .await
    }
}

/// Prefetched disc regions that answer the synchronous reads done while the
/// Wii apploader HLE builds the system. Anything not covered reads as zeros and
/// is recorded in `missing`.
#[derive(Default)]
pub struct SparseDisc {
    decoded: Vec<(u64, Vec<u8>)>,
    raw: Vec<(u64, Vec<u8>)>,
    missing: Vec<String>,
}

pub type SharedSparse = std::sync::Arc<std::sync::Mutex<SparseDisc>>;

impl SparseDisc {
    pub fn add_decoded(&mut self, offset: u64, data: Vec<u8>) {
        self.decoded.push((offset, data));
    }

    pub fn add_raw(&mut self, offset: u64, data: Vec<u8>) {
        self.raw.push((offset, data));
    }

    pub fn missing(&self) -> &[String] {
        &self.missing
    }

    fn fill(regions: &[(u64, Vec<u8>)], offset: u64, buf: &mut [u8]) -> bool {
        buf.fill(0);
        let end = offset + buf.len() as u64;
        let mut covered = 0u64;
        for (start, data) in regions {
            let region_end = *start + data.len() as u64;
            let lo = core::cmp::max(offset, *start);
            let hi = core::cmp::min(end, region_end);
            if lo < hi {
                buf[(lo - offset) as usize..(hi - offset) as usize]
                    .copy_from_slice(&data[(lo - *start) as usize..(hi - *start) as usize]);
                covered += hi - lo;
            }
        }
        covered >= buf.len() as u64
    }
}

/// Dvd implementation backed by SparseDisc. Used only for the synchronous boot
/// reads; runtime reads go through the asynchronous DI path.
pub struct StreamDvd {
    header: Header,
    apploader: Apploader,
    data_partition_offset: u64,
    sparse: SharedSparse,
}

impl StreamDvd {
    pub fn new(header: Header, apploader: Apploader, data_partition_offset: u64, sparse: SharedSparse) -> Self {
        Self {
            header,
            apploader,
            data_partition_offset,
            sparse,
        }
    }
}

impl crate::Dvd for StreamDvd {
    fn header(&self) -> &Header {
        &self.header
    }

    fn apploader(&self) -> &Apploader {
        &self.apploader
    }

    fn read_disc_into(&self, offset: usize, buf: &mut [u8]) {
        let mut sparse = self.sparse.lock().unwrap();
        let ok = SparseDisc::fill(&sparse.decoded, offset as u64, buf);
        if !ok {
            sparse
                .missing
                .push(format!("disc read {offset:#x}+{:#x} was not prefetched", buf.len()));
        }
    }

    fn data_partition_offset(&self) -> u64 {
        self.data_partition_offset
    }

    fn read_raw_disc(&self, offset: usize, buf: &mut [u8]) {
        let mut sparse = self.sparse.lock().unwrap();
        let ok = SparseDisc::fill(&sparse.raw, offset as u64, buf);
        if !ok {
            sparse
                .missing
                .push(format!("raw read {offset:#x}+{:#x} was not prefetched", buf.len()));
        }
    }
}

fn dol_extent(header: &[u8]) -> u64 {
    let mut end = 0x100u64;
    for section in 0..18usize {
        let offset_field = if section < 7 { section * 4 } else { 0x1c + (section - 7) * 4 };
        let size_field = if section < 7 { 0x90 + section * 4 } else { 0xac + (section - 7) * 4 };
        let file_offset = be32(header, offset_field) as u64;
        let file_size = be32(header, size_field) as u64;
        if file_size == 0 {
            continue;
        }
        end = core::cmp::max(end, file_offset + file_size);
    }
    end
}

/// Fetch everything the apploader HLE reads synchronously during boot:
/// disc header + BI2 + apploader, the main DOL, the FST and the raw partition
/// header (ticket/TMD). Returns human-readable notes about optional parts that
/// could not be prefetched.
pub async fn prefetch_boot_data<S: RangeSource>(
    stream: &RvzStream,
    src: &S,
    apploader: &Apploader,
    sparse: &mut SparseDisc,
) -> Result<Vec<String>, String> {
    const MAX_PREFETCH: u64 = 128 * 1024 * 1024;
    let mut notes = Vec::new();

    let app_end = (DVD_APPLOADER_OFFSET as u64)
        + 0x20
        + apploader.size.get() as u64
        + apploader.trailer_size.get() as u64;
    if app_end > 32 * 1024 * 1024 || app_end < 0x460 {
        return Err(format!("implausible apploader size (boot area ends at {app_end:#x})"));
    }
    let boot = stream.read_disc(src, 0, app_end as usize).await?;
    let dol_off = (be32(&boot, 0x420) as u64) << 2;
    let fst_off = (be32(&boot, 0x424) as u64) << 2;
    let fst_size = (be32(&boot, 0x428) as u64) << 2;
    sparse.add_decoded(0, boot);

    if stream.data_partition.is_some() {
        let pdo = stream.data_partition_offset();
        match stream.read_raw(src, pdo, 0x20000).await {
            Ok(bytes) => sparse.add_raw(pdo, bytes),
            Err(error) => notes.push(format!("partition header prefetch failed: {error}")),
        }
    }
    match stream.read_raw(src, 0, 0x440).await {
        Ok(bytes) => sparse.add_raw(0, bytes),
        Err(error) => notes.push(format!("raw disc header prefetch failed: {error}")),
    }

    if dol_off > 0 && dol_off + 0x100 <= stream.iso_size {
        match stream.read_disc(src, dol_off, 0x100).await {
            Ok(dol_header) => {
                let extent = dol_extent(&dol_header);
                if extent > MAX_PREFETCH || dol_off + extent > stream.iso_size {
                    notes.push(format!("main DOL extent {extent:#x} looks invalid; not prefetched"));
                } else {
                    match stream.read_disc(src, dol_off, extent as usize).await {
                        Ok(bytes) => sparse.add_decoded(dol_off, bytes),
                        Err(error) => notes.push(format!("DOL prefetch failed: {error}")),
                    }
                }
            }
            Err(error) => notes.push(format!("DOL header prefetch failed: {error}")),
        }
    } else {
        notes.push("main DOL offset looks invalid; not prefetched".to_string());
    }

    if fst_size > 0 && fst_size <= MAX_PREFETCH && fst_off + fst_size <= stream.iso_size {
        match stream.read_disc(src, fst_off, fst_size as usize).await {
            Ok(bytes) => sparse.add_decoded(fst_off, bytes),
            Err(error) => notes.push(format!("FST prefetch failed: {error}")),
        }
    } else {
        notes.push("FST range looks invalid; not prefetched".to_string());
    }

    Ok(notes)
}
'''

rvz_text = rvz_rs.read_text()
if "pub struct RvzStream" in rvz_text:
    raise SystemExit("rvz.rs already contains RvzStream; refusing to patch twice")
rvz_rs.write_text(rvz_text.rstrip("\n") + "\n" + RVZ_STREAM)

# ======================================================================
# 2. web crate: prepare_rvz_stream() and routing of runtime reads
# ======================================================================
WEB_BLOCK = r'''
/// Range adapter so the image crate's streaming RVZ reader can use the browser File.
struct RvzSrc(std::rc::Rc<FileRangeReader>);

impl image::rvz::RangeSource for RvzSrc {
    async fn read_range(&self, offset: u64, length: usize) -> Result<Vec<u8>, String> {
        self.0
            .read_range(offset, length)
            .await
            .map_err(|error| error.as_string().unwrap_or_else(|| format!("{error:?}")))
    }
}

struct RvzStreamHandle {
    reader: std::rc::Rc<FileRangeReader>,
    stream: image::rvz::RvzStream,
}

thread_local! {
    static RVZ_STREAM: std::cell::RefCell<Option<std::rc::Rc<RvzStreamHandle>>> = std::cell::RefCell::new(None);
    static PREPARED_DVD: std::cell::RefCell<Option<Box<dyn image::Dvd>>> = std::cell::RefCell::new(None);
}

fn take_prepared_dvd() -> Option<Box<dyn image::Dvd>> {
    PREPARED_DVD.with(|slot| slot.borrow_mut().take())
}

fn rvz_stream_active() -> bool {
    RVZ_STREAM.with(|slot| slot.borrow().is_some())
}

/// Runtime DVD reads: block-wise RVZ when a stream is active, plain file ranges otherwise.
async fn read_disc_for_dvd(
    fallback: &std::rc::Rc<FileRangeReader>,
    offset: u64,
    length: usize,
) -> Result<Vec<u8>, wasm_bindgen::JsValue> {
    let handle = RVZ_STREAM.with(|slot| slot.borrow().clone());
    match handle {
        Some(handle) => {
            let src = RvzSrc(handle.reader.clone());
            handle
                .stream
                .read_disc(&src, offset, length)
                .await
                .map_err(|error| wasm_bindgen::JsValue::from_str(&error))
        }
        None => fallback.read_range(offset, length).await,
    }
}

/// Open an RVZ file without loading it: parses the tables and prefetches the few
/// regions the Wii apploader reads synchronously. Call before start_emulator().
#[wasm_bindgen::prelude::wasm_bindgen]
pub async fn prepare_rvz_stream(file: web_sys::File) -> Result<String, wasm_bindgen::JsValue> {
    let reader = std::rc::Rc::new(FileRangeReader::new(file));
    let src = RvzSrc(reader.clone());

    let (stream, header, apploader) = image::rvz::RvzStream::open(&src)
        .await
        .map_err(|error| wasm_bindgen::JsValue::from_str(&format!("RVZ open failed: {error}")))?;
    let data_partition_offset = stream.data_partition_offset();

    let mut sparse = image::rvz::SparseDisc::default();
    let notes = image::rvz::prefetch_boot_data(&stream, &src, &apploader, &mut sparse)
        .await
        .map_err(|error| wasm_bindgen::JsValue::from_str(&format!("RVZ boot prefetch failed: {error}")))?;

    let shared: image::rvz::SharedSparse = std::sync::Arc::new(std::sync::Mutex::new(sparse));
    let dvd = image::rvz::StreamDvd::new(header, apploader, data_partition_offset, shared);
    PREPARED_DVD.with(|slot| *slot.borrow_mut() = Some(Box::new(dvd)));

    let summary = format!(
        "RVZ stream ready: logical size {} bytes, file {} bytes.{}",
        stream.iso_size(),
        reader.len(),
        if notes.is_empty() { String::new() } else { format!(" Notes: {}", notes.join("; ")) }
    );
    RVZ_STREAM.with(|slot| *slot.borrow_mut() = Some(std::rc::Rc::new(RvzStreamHandle { reader, stream })));
    Ok(summary)
}
'''

replace_once(web_rs, "use disc_stream::FileRangeReader;\n", "use disc_stream::FileRangeReader;\n" + WEB_BLOCK)

# Boot: use the prepared streaming DVD when prepare_rvz_stream() ran.
replace_once(
    web_rs,
    "        let dvd = image::load_dvd(rom_data);",
    """        let (dvd, rvz_streaming) = match take_prepared_dvd() {
            Some(prepared) => (prepared, true),
            None => (image::load_dvd(rom_data), false),
        };""",
)

# Runtime: async DI reads for streamed RVZ as well as for plain ISO.
replace_once(
    web_rs,
    '        if name.ends_with(".iso") {\n            wii.enable_async_dvd_reads(true);',
    '        if name.ends_with(".iso") || rvz_streaming {\n            wii.enable_async_dvd_reads(true);',
)
replace_once(
    web_rs,
    '    let disc_reader = if name.ends_with(".iso") {',
    '    let disc_reader = if name.ends_with(".iso") || rvz_stream_active() {',
)
replace_once(
    web_rs,
    "match reader.read_range(request.offset, request.length).await {",
    "match read_disc_for_dvd(&reader, request.offset, request.length).await {",
)

# ======================================================================
# 3. Browser page
# ======================================================================
replace_once(
    web_html,
    "import init, { start_emulator, RomUpload } from './pkg/gecko_web.js';",
    "import init, { start_emulator, RomUpload, prepare_rvz_stream } from './pkg/gecko_web.js';",
)

replace_once(
    web_html,
    "async function readFileIntoRom(file, onProgress) {",
    """async function readFileIntoRom(file, onProgress) {
                if (file.name.toLowerCase().endsWith('.rvz')) {
                    // RVZ is streamed block by block (prepare_rvz_stream), so nothing is
                    // copied into memory here. Keep only the header for the format checks.
                    romData = new Uint8Array(await file.slice(0, 0x1000).arrayBuffer());
                    onProgress?.(file.size, file.size);
                    return new RomUpload(0);
                }""",
)

replace_once(
    web_html,
    "selectedFile = file;",
    "selectedFile = file;\n                const isRvzStream = file.name.toLowerCase().endsWith('.rvz');",
)
replace_once(
    web_html,
    "const estimatedPeakGb = file.size / (1024 * 1024 * 1024);",
    "const estimatedPeakGb = isRvzStream ? 0 : file.size / (1024 * 1024 * 1024);",
)
replace_once(
    web_html,
    "const mobileMemoryLimitBytes = 1536 * 1024 * 1024;",
    "const mobileMemoryLimitBytes = isRvzStream ? Number.MAX_SAFE_INTEGER : 1536 * 1024 * 1024;",
)
replace_once(
    web_html,
    "const estimatedPeak = selectedFile ? selectedFile.size : 0;",
    "const estimatedPeak = (selectedFile && !selectedFile.name.toLowerCase().endsWith('.rvz')) ? selectedFile.size : 0;",
)
replace_once(
    web_html,
    "start_emulator(selectedRom, romName, dspData ?? undefined, selectedFile ?? undefined);",
    """if (selectedFile && selectedFile.name.toLowerCase().endsWith('.rvz')) {
                        setBootStatus('BOOT-STAGE-JS-1b: Opening RVZ and prefetching boot data…');
                        setBootStatus(await prepare_rvz_stream(selectedFile));
                    }
                    start_emulator(selectedRom, romName, dspData ?? undefined, selectedFile ?? undefined);""",
)

# ======================================================================
# Validation
# ======================================================================
rs = web_rs.read_text()
html = web_html.read_text()
img = rvz_rs.read_text()
for needle in ("take_prepared_dvd()", "rvz_streaming", "read_disc_for_dvd(&reader", "prepare_rvz_stream"):
    if needle not in rs:
        raise SystemExit(f"RVZ stream patch validation failed (web lib.rs): {needle}")
for needle in ("prepare_rvz_stream(selectedFile)", "isRvzStream"):
    if needle not in html:
        raise SystemExit(f"RVZ stream patch validation failed (index.html): {needle}")
for needle in ("pub struct RvzStream", "pub struct StreamDvd", "pub async fn prefetch_boot_data"):
    if needle not in img:
        raise SystemExit(f"RVZ stream patch validation failed (rvz.rs): {needle}")
print("Patched Gecko: RVZ discs are streamed block by block (boot prefetch + async runtime reads).")
