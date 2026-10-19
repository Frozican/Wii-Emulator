#!/usr/bin/env python3
"""Stream the disc image straight into WASM memory (no second copy).

Why: BOOT-STAGE-1 is printed by Rust inside start_emulator(), but the boot log
stops at BOOT-STAGE-JS-1. The trap therefore happens *before* the Rust function
body runs, i.e. in the wasm-bindgen glue that copies the `Vec<u8>` argument
into WASM memory. With a 1.45 GB image the browser then holds the JS Uint8Array
(1.45 GB) and the WASM copy (1.45 GB) at the same time; the allocation fails and
Rust aborts, which shows up as `unreachable`.

Fix: RomUpload reserves the buffer inside WASM memory (try_reserve_exact, so a
failure becomes a readable error instead of a trap) and JavaScript writes the
file into it in 8 MiB slices. start_emulator() takes ownership of that buffer.
Peak memory is ~1x the image size instead of ~2x.

Run this AFTER patch-gecko-web.py, patch-panic-diagnostics.py and
patch-boot-stages.py, and BEFORE the wasm-pack build.
"""
from pathlib import Path

root = Path("gecko-src")
web_rs = root / "crates/web/src/lib.rs"
web_html = root / "crates/web/index.html"


def replace_once(path: Path, old: str, new: str) -> None:
    text = path.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"Expected one patch target in {path}: {old[:80]!r}; found {count}")
    path.write_text(text.replace(old, new, 1))


def replace_all(path: Path, old: str, new: str) -> None:
    text = path.read_text()
    if old not in text:
        raise SystemExit(f"Expected at least one patch target in {path}: {old[:80]!r}")
    path.write_text(text.replace(old, new))


# ---------------------------------------------------------------- Rust side
rust_text = web_rs.read_text()
if "use wasm_bindgen::prelude::*;" not in rust_text:
    # Harmless if another glob import already provides the same items.
    replace_once(web_rs, "use disc_stream::FileRangeReader;\n",
                 "use disc_stream::FileRangeReader;\nuse wasm_bindgen::prelude::*;\n")

ROM_UPLOAD = '''
/// Browser-side staging buffer for the disc image. JavaScript copies file slices
/// directly into Rust-owned WASM memory, so a multi-GB image is never held twice.
#[wasm_bindgen]
pub struct RomUpload {
    data: Vec<u8>,
}

#[wasm_bindgen]
impl RomUpload {
    #[wasm_bindgen(constructor)]
    pub fn new(len: usize) -> Result<RomUpload, wasm_bindgen::JsValue> {
        let mut data: Vec<u8> = Vec::new();
        data.try_reserve_exact(len).map_err(|_| {
            wasm_bindgen::JsValue::from_str(&format!(
                "The browser could not reserve {:.2} GiB of WebAssembly memory for this disc image.",
                len as f64 / 1_073_741_824.0
            ))
        })?;
        data.resize(len, 0);
        Ok(Self { data })
    }

    pub fn write_chunk(&mut self, offset: usize, chunk: &[u8]) -> Result<(), wasm_bindgen::JsValue> {
        let end = offset
            .checked_add(chunk.len())
            .filter(|end| *end <= self.data.len())
            .ok_or_else(|| wasm_bindgen::JsValue::from_str("ROM chunk lies outside the reserved buffer"))?;
        self.data[offset..end].copy_from_slice(chunk);
        Ok(())
    }
}

impl RomUpload {
    fn into_vec(self) -> Vec<u8> {
        self.data
    }
}
'''

replace_once(web_rs, "use disc_stream::FileRangeReader;\n", "use disc_stream::FileRangeReader;\n" + ROM_UPLOAD)

replace_once(
    web_rs,
    "pub fn start_emulator(rom_data: Vec<u8>, filename: String, dsp_irom: Option<Vec<u8>>, disc_file: Option<web_sys::File>) {",
    "pub fn start_emulator(rom_upload: RomUpload, filename: String, dsp_irom: Option<Vec<u8>>, disc_file: Option<web_sys::File>) {\n"
    "    let rom_data = rom_upload.into_vec();",
)

# ---------------------------------------------------------------- JS side
replace_once(
    web_html,
    "import init, { start_emulator } from './pkg/gecko_web.js';",
    "import init, { start_emulator, RomUpload } from './pkg/gecko_web.js';",
)

READ_INTO_ROM = """            // Streams the disc image into WASM memory in 8 MiB slices. `romData` only
            // keeps the first 4 KiB afterwards, which is all the format checks need.
            async function readFileIntoRom(file, onProgress) {
                const chunkSize = 8 * 1024 * 1024;
                let upload;
                try {
                    upload = new RomUpload(file.size);
                } catch (error) {
                    throw new Error(String(error?.message ?? error));
                }
                try {
                    for (let offset = 0; offset < file.size; offset += chunkSize) {
                        const end = Math.min(offset + chunkSize, file.size);
                        const buffer = await file.slice(offset, end).arrayBuffer();
                        if (buffer.byteLength !== end - offset) {
                            throw new Error('Incomplete chunk at ' + (offset / 1024 / 1024).toFixed(0) + ' MB');
                        }
                        upload.write_chunk(offset, new Uint8Array(buffer));
                        onProgress?.(end, file.size);
                    }
                    romData = new Uint8Array(await file.slice(0, 0x1000).arrayBuffer());
                } catch (error) {
                    upload.free();
                    throw error;
                }
                return upload;
            }

"""
marker = "            inputRom.addEventListener('change', async (e) => {"
replace_once(web_html, marker, READ_INTO_ROM + marker)

replace_once(web_html, "let selectedFile = null;", "let selectedFile = null;\n            let romUpload = null;")
replace_once(web_html, "romData = await readFile(file, (loaded, total) => {",
             "romUpload = await readFileIntoRom(file, (loaded, total) => {")
# One copy of the image now lives in memory, not two.
replace_once(web_html, "const estimatedPeakGb = (file.size * 2) / (1024 * 1024 * 1024);",
             "const estimatedPeakGb = file.size / (1024 * 1024 * 1024);")
replace_once(web_html, "const estimatedPeak = romData.byteLength * 2;",
             "const estimatedPeak = selectedFile ? selectedFile.size : 0;")
replace_once(web_html, "const selectedRom = romData;", "const selectedRom = romUpload;")
replace_all(web_html, "selectedRom.byteLength", "selectedFile.size")

patched_rs = web_rs.read_text()
patched_html = web_html.read_text()
for needle in ("pub struct RomUpload", "rom_upload.into_vec()", "try_reserve_exact"):
    if needle not in patched_rs:
        raise SystemExit(f"ROM upload patch validation failed (Rust): {needle}")
for needle in ("readFileIntoRom", "RomUpload }", "const selectedRom = romUpload;"):
    if needle not in patched_html:
        raise SystemExit(f"ROM upload patch validation failed (HTML): {needle}")

print("Patched Gecko web frontend: ROM is streamed into WASM memory (single copy).")
