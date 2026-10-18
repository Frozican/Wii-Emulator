#!/usr/bin/env python3
"""Preserve the last Rust boot stage in the visible error message."""
from pathlib import Path

path = Path("gecko-src/crates/web/src/lib.rs")
source = path.read_text()
needle = "const errorId = code + '-' + (++errorSequence).toString().padStart(3, '0');"
if source.count(needle) != 1:
    raise SystemExit(f"Expected one error ID line; found {source.count(needle)}")
source = source.replace(
    needle,
    "const lastStage = bootStatus.textContent || 'No boot stage recorded';\n                " + needle,
    1,
)
needle2 = "bootStatus.textContent = 'ERROR ' + errorId + ': ' + detail + "
idx = source.find(needle2)
if idx < 0:
    raise SystemExit("Could not find visible error message assignment")
line_end = source.find("\n", idx)
line = source[idx:line_end]
if "Last boot stage:" not in line:
    replacement = line.replace(" + detail + ", " + detail + '\\\\nLast boot stage: ' + lastStage + ")
    source = source[:idx] + replacement + source[line_end:]
path.write_text(source)
print("Preserved last boot stage in boot errors.")
