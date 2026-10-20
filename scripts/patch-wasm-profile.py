#!/usr/bin/env python3
"""Give the Gecko web crate an optimized release profile.

crates/web is excluded from Gecko's cargo workspace, so the root
[profile.release] (LTO, codegen-units = 1) does NOT apply to it: the web build
has been using cargo's plain release defaults (opt-level 3, 16 codegen units,
no LTO). This adds the same settings the native Gecko build uses.

Run after the other patch scripts and before the wasm-pack build.
"""
from pathlib import Path

cargo_toml = Path("gecko-src/crates/web/Cargo.toml")
text = cargo_toml.read_text()

if "[profile.release]" in text:
    raise SystemExit("crates/web/Cargo.toml already defines [profile.release]; refusing to patch twice")

PROFILE = '''
# Added by patch-wasm-profile.py: crates/web is outside the workspace, so the
# workspace-level release profile does not reach it.
[profile.release]
opt-level = 3
lto = "fat"
codegen-units = 1
debug = false
'''

cargo_toml.write_text(text.rstrip("\n") + "\n" + PROFILE)

if cargo_toml.read_text().count("[profile.release]") != 1:
    raise SystemExit("Release profile patch validation failed")

print("Patched crates/web/Cargo.toml: fat LTO, codegen-units = 1, opt-level 3.")
