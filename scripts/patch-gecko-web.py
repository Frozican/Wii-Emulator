#!/usr/bin/env python3
"""Patch Gecko's experimental web frontend to boot Wii ISO/RVZ disc images."""
from pathlib import Path

root = Path("gecko-src")
web_rs = root / "crates/web/src/lib.rs"
web_html = root / "crates/web/index.html"
cargo = root / "crates/web/Cargo.toml"

def replace_once(path: Path, old: str, new: str) -> None:
    text = path.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"Expected one patch target in {path}: {old[:80]!r}; found {count}")
    path.write_text(text.replace(old, new, 1))

replace_once(
    cargo,
    'image = { path = "../image", default-features = false }',
    'image = { path = "../image", default-features = false, features = ["rvz"] }',
)

replace_once(
    web_rs,
    'use gecko::gamecube::GameCube;\n',
    'use gecko::gamecube::GameCube;\nuse gecko::wii::Wii;\nuse gecko::system::{System, SystemId};\n',
)

replace_once(
    web_rs,
    '        emulator: &mut GameCube,\n',
    '        emulator: &mut System<SYSTEM>,\n',
)
# Make the renderer work with either console system. SystemId is a const-generic u8.
replace_once(
    web_rs,
    '    fn render(\n        &mut self,\n        emulator: &mut System<SYSTEM>,',
    '    fn render<const SYSTEM: SystemId>(\n        &mut self,\n        emulator: &mut System<SYSTEM>,',
)

replace_once(
    web_rs,
    'struct App {\n    emulator: GameCube,',
    'enum Emulator {\n    GameCube(GameCube),\n    Wii(Wii),\n}\n\nimpl Emulator {\n    fn apply_host_input(&mut self, input: &HostInput) {\n        match self {\n            Self::GameCube(emulator) => emulator.apply_host_input(input),\n            Self::Wii(emulator) => emulator.apply_host_input(input),\n        }\n    }\n\n    fn is_wii(&self) -> bool {\n        matches!(self, Self::Wii(_))\n    }\n}\n\nstruct App {\n    emulator: Emulator,'
)

# Render through the appropriate concrete system type.
replace_once(
    web_rs,
    '''                        state.render(
                            &mut self.emulator,
                            &self.action_queue,
                            #[cfg(feature = "debug")]
                            &mut self.debug_state,
                            &window,
                        );''',
    '''                        match &mut self.emulator {
                            Emulator::GameCube(emulator) => state.render(
                                emulator,
                                &self.action_queue,
                                #[cfg(feature = "debug")]
                                &mut self.debug_state,
                                &window,
                            ),
                            Emulator::Wii(emulator) => state.render(
                                emulator,
                                &self.action_queue,
                                #[cfg(feature = "debug")]
                                &mut self.debug_state,
                                &window,
                            ),
                        }'''
)

# Start with a disc-aware Wii boot path. DOL and IPL behavior remains unchanged.
replace_once(
    web_rs,
    '''    let mut emulator = if name.ends_with(".bin") || name.ends_with(".ipl") {
        GameCube::with_ipl(rom_data, false)
    } else {
        let dol = Dol::parse(rom_data.to_vec());
        GameCube::with_image(&dol)
    };''',
    '''    let mut emulator = if name.ends_with(".bin") || name.ends_with(".ipl") {
        Emulator::GameCube(GameCube::with_ipl(rom_data, false))
    } else if name.ends_with(".iso") || name.ends_with(".rvz") {
        let dvd = image::load_dvd(rom_data.to_vec());
        if !dvd.header().is_wii() {
            panic!("The selected disc image is not a Wii disc");
        }
        Emulator::Wii(Wii::apploader_hle(dvd).build())
    } else {
        let dol = Dol::parse(rom_data.to_vec());
        Emulator::GameCube(GameCube::with_image(&dol))
    };'''
)

replace_once(
    web_rs,
    '''    if let Some(irom) = dsp_irom {
        emulator.dsp.load_irom(&irom);
    }''',
    '''    if let Some(irom) = dsp_irom {
        match &mut emulator {
            Emulator::GameCube(emulator) => emulator.dsp.load_irom(&irom),
            Emulator::Wii(emulator) => emulator.dsp.load_irom(&irom),
        }
    }'''
)

replace_once(
    web_rs,
    '''    let input = HostInput::gc_connected();
    emulator.apply_host_input(&input);''',
    '''    let input = if emulator.is_wii() {
        HostInput::wii_neutral()
    } else {
        HostInput::gc_connected()
    };
    emulator.apply_host_input(&input);'''
)

# Install the render sink on the selected concrete emulator.
replace_once(
    web_rs,
    '''    emulator.render_sink = Box::new(WebSink {
        shared: action_queue.clone(),
        scratch: Vec::new(),
        scratch_sent_len: 0,
        last_epoch: 0,
    });''',
    '''    match &mut emulator {
        Emulator::GameCube(emulator) => {
            emulator.render_sink = Box::new(WebSink {
                shared: action_queue.clone(),
                scratch: Vec::new(),
                scratch_sent_len: 0,
                last_epoch: 0,
            });
        }
        Emulator::Wii(emulator) => {
            emulator.render_sink = Box::new(WebSink {
                shared: action_queue.clone(),
                scratch: Vec::new(),
                scratch_sent_len: 0,
                last_epoch: 0,
            });
        }
    }'''
)

# Enable selection of Wii disc images in the browser.
replace_once(
    web_html,
    '<label class="file-label">IPL / DOL:</label>',
    '<label class="file-label">Wii disc / IPL / DOL:</label>',
)
replace_once(
    web_html,
    'accept=".dol,.bin"',
    'accept=".dol,.bin,.ipl,.iso,.rvz"',
)
replace_once(
    web_html,
    '            await init();\n\n            let romData = null;',
    '            const wasmReady = init();\n\n            let romData = null;'
)
replace_once(
    web_html,
    '''            function readFile(file) {
                return new Promise((resolve) => {
                    const reader = new FileReader();
                    reader.onload = () => resolve(new Uint8Array(reader.result));
                    reader.readAsArrayBuffer(file);
                });
            }''',
    '''            async function readFile(file, onProgress) {
                // Read in small slices: Android document providers can fail on a
                // single multi-gigabyte read even when the selected file is valid.
                // Gecko still needs the complete image in memory after this step.
                const chunkSize = 16 * 1024 * 1024;
                let result;
                try {
                    result = new Uint8Array(file.size);
                } catch (error) {
                    throw new Error('The browser cannot allocate one ' +
                        (file.size / 1024 / 1024 / 1024).toFixed(2) +
                        ' GB image buffer. Chunked reading alone cannot fix this: ' +
                        'the current emulator core keeps the complete disc image in memory. ' +
                        'Try a smaller RVZ image, or use a device/browser with more available memory.');
                }
                for (let offset = 0; offset < file.size; offset += chunkSize) {
                    const end = Math.min(offset + chunkSize, file.size);
                    let buffer;
                    try {
                        buffer = await file.slice(offset, end).arrayBuffer();
                    } catch (error) {
                        throw new Error('Chunk read failed at ' +
                            (offset / 1024 / 1024).toFixed(0) + ' MB: ' +
                            (error?.message ?? 'unknown error'));
                    }
                    if (buffer.byteLength !== end - offset) {
                        throw new Error('Incomplete chunk at ' +
                            (offset / 1024 / 1024).toFixed(0) + ' MB');
                    }
                    result.set(new Uint8Array(buffer), offset);
                    onProgress?.(end, file.size);
                }
                return result;
            }'''
)
replace_once(
    web_html,
    '''            inputRom.addEventListener('change', async (e) => {
                if (e.target.files.length > 0) {
                    const file = e.target.files[0];
                    romData = await readFile(file);
                    romName = file.name;
                    romNameEl.textContent = file.name;
                    startBtn.disabled = false;
                }
            });''',
    '''            inputRom.addEventListener('change', async (e) => {
                const file = e.target.files && e.target.files[0];
                if (!file) {
                    romNameEl.textContent = 'no file selected';
                    return;
                }
                romData = null;
                romName = file.name;
                romNameEl.textContent = file.name + ' (reading...)';
                startBtn.disabled = true;
                try {
                    romData = await readFile(file, (loaded, total) => {
                        romNameEl.textContent = file.name + ' (' +
                            (loaded / 1024 / 1024).toFixed(0) + ' / ' +
                            (total / 1024 / 1024).toFixed(0) + ' MB)';
                    });
                    romNameEl.textContent = file.name + ' (' + (file.size / 1024 / 1024).toFixed(0) + ' MB, ready)';
                    startBtn.disabled = false;
                } catch (error) {
                    romNameEl.textContent = 'Read failed: ' + (error?.message ?? 'unknown error');
                    console.error('Failed to read selected disc image', error);
                }
            });'''
)

replace_once(
    web_html,
    """            startBtn.addEventListener('click', () => {
                if (!romData) return;
                document.getElementById('setup').style.display = 'none';
                start_emulator(romData, romName, dspData ?? undefined);
            });""",
    """            startBtn.addEventListener('click', async () => {
                if (!romData) return;
                // Gecko's current ISO parser expects a restored, standard disc image.
                // NKit's NKIT marker is at 0x200; the browser metadata probe does not
                // restore its removed gap/hash data, so attempting to boot it is unsafe.
                if (romData.length >= 0x204 &&
                    romData[0x200] === 0x4e &&
                    romData[0x201] === 0x4b &&
                    romData[0x202] === 0x49 &&
                    romData[0x203] === 0x54) {
                    romNameEl.textContent = 'NKit ISO detected: restoration is not implemented yet. This image can be inspected, but cannot boot in this build. Use a fully restored Wii ISO or RVZ image.';
                    return;
                }
                try {
                    await wasmReady;
                    document.getElementById('setup').style.display = 'none';
                    start_emulator(romData, romName, dspData ?? undefined);
                } catch (error) {
                    romNameEl.textContent = 'Could not start emulator: ' + (error?.message ?? 'unknown error');
                    console.error('Failed to start emulator', error);
                }
            });"""
)

print("Patched Gecko web frontend for Wii ISO/RVZ boot.")
