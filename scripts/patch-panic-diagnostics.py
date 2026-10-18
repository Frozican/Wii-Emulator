#!/usr/bin/env python3
"""Expose Rust panic details in the browser UI while diagnosing Wii boot."""
from pathlib import Path

path = Path("gecko-src/crates/web/src/lib.rs")
source = path.read_text()
old = "    console_error_panic_hook::set_once();"
new = """    // Surface Rust panics in the page as well as DevTools. The default WASM
    // abort often reaches JavaScript only as the opaque message "unreachable".
    std::panic::set_hook(Box::new(|info| {
        let message = info.to_string();
        web_sys::console::error_1(&wasm_bindgen::JsValue::from_str(&message));
        if let Some(document) = web_sys::window().and_then(|window| window.document()) {
            if let Some(status) = document.get_element_by_id("boot-status") {
                status.set_text_content(Some(&format!("RUST PANIC: {}", message)));
            }
        }
    }));"""
count = source.count(old)
if count != 1:
    raise SystemExit(f"Expected exactly one panic-hook setup in {path}, found {count}")
path.write_text(source.replace(old, new, 1))
print("Installed in-page Rust panic diagnostics.")
