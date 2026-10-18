#!/usr/bin/env python3
"""Add stage markers around the Wii boot path so WASM traps are attributable."""
from pathlib import Path

path = Path("gecko-src/crates/web/src/lib.rs")
source = path.read_text()

def replace_once(old: str, new: str) -> None:
    global source
    count = source.count(old)
    if count != 1:
        raise SystemExit(f"Expected one boot-stage patch target; found {count}: {old[:100]!r}")
    source = source.replace(old, new, 1)

replace_once(
    '    let name = filename.to_lowercase();',
    '''    let set_boot_stage = |stage: &str| {
        if let Some(status) = web_sys::window()
            .and_then(|window| window.document())
            .and_then(|document| document.get_element_by_id("boot-status"))
        {
            status.set_text_content(Some(stage));
        }
        web_sys::console::log_1(&wasm_bindgen::JsValue::from_str(stage));
    };

    set_boot_stage("BOOT-STAGE-1: Preparing selected image…");
    let name = filename.to_lowercase();'''
)
replace_once(
    '        let dvd = image::load_dvd(rom_data);',
    '''        set_boot_stage("BOOT-STAGE-2: Decoding RVZ/ISO disc image…");
        let dvd = image::load_dvd(rom_data);
        set_boot_stage("BOOT-STAGE-3: Disc image decoded; checking Wii header…");'''
)
replace_once(
    '        if !dvd.header().is_wii() {',
    '''        if !dvd.header().is_wii() {'''
)
replace_once(
    '        let mut wii = Wii::apploader_hle(dvd).build();',
    '''        set_boot_stage("BOOT-STAGE-4: Starting Wii apploader…");
        let mut wii = Wii::apploader_hle(dvd).build();
        set_boot_stage("BOOT-STAGE-5: Wii apploader returned; configuring runtime…");'''
)
replace_once(
    '    if let Some(irom) = dsp_irom {',
    '''    set_boot_stage("BOOT-STAGE-6: Configuring DSP and input…");
    if let Some(irom) = dsp_irom {'''
)
replace_once(
    '    let event_loop = EventLoop::new().unwrap();',
    '''    set_boot_stage("BOOT-STAGE-7: Creating browser event loop…");
    let event_loop = EventLoop::new().unwrap();'''
)
replace_once(
    '    event_loop.spawn_app(app);',
    '''    set_boot_stage("BOOT-STAGE-8: Starting renderer/event loop…");
    event_loop.spawn_app(app);
    set_boot_stage("BOOT-STAGE-9: Emulator startup handed to browser event loop.");'''
)

path.write_text(source)
print("Installed Wii boot-stage diagnostics.")
