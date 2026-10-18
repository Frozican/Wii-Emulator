#!/usr/bin/env python3
"""Preserve the last Rust boot stage in the visible error message."""
from pathlib import Path

path = Path("gecko-src/crates/web/src/lib.rs")
source = path.read_text()
old = """                const detail = error?.message || String(error || 'Unknown error');
                const errorId = code + '-' + (++errorSequence).toString().padStart(3, '0');
                bootStatus.textContent = 'ERROR ' + errorId + ': ' + detail + '\\nCopy this code and full message when reporting.';"""
new = """                const detail = error?.message || String(error || 'Unknown error');
                const lastStage = bootStatus.textContent || 'No boot stage recorded';
                const errorId = code + '-' + (++errorSequence).toString().padStart(3, '0');
                bootStatus.textContent = 'ERROR ' + errorId + ': ' + detail + '\\nLast boot stage: ' + lastStage + '\\nCopy this code and full message when reporting.';"""
if source.count(old) != 1:
    raise SystemExit(f"Expected one showError target; found {source.count(old)}")
path.write_text(source.replace(old, new, 1))
print("Preserved last boot stage in boot errors.")
