#!/usr/bin/env python3
"""Diagnostic counters for the Gecko web build, shown in their own HTML overlay.

The counters used to be drawn inside the emulator's egui HUD (top right), where
they collided with the page's boot status/progress panels. They now live in a
small fixed <pre> at the bottom left of the page that is refreshed twice a
second from JavaScript. The original one-line FPS HUD stays untouched.

Overlay lines:
    frames N actions N draws N presents N
    tex N xfbcopy N efbcopy N verts N
    present WxH parts N

  frames   - emulation slices rendered by the page (one per browser frame)
  actions  - GX actions the emulated GPU produced so far
  draws    - GX draw calls among them
  presents - XFB presents (images the game handed to the screen)
  tex      - textures the game uploaded (LoadTexture)
  xfbcopy  - EFB -> XFB copies (the actual picture)
  efbcopy  - EFB -> texture copies (render-to-texture; the web sink cannot
             write these back into guest RAM)
  verts    - vertices drawn so far
  present  - size and tile count of the last presented frame

Run after patch-rvz-stream.py (it extends that script's import line) and
before the wasm-pack build.
"""
from pathlib import Path

web_rs = Path("gecko-src/crates/web/src/lib.rs")
web_html = Path("gecko-src/crates/web/index.html")


def replace_once(path: Path, old: str, new: str) -> None:
    text = path.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"Expected one patch target in {path}: {old[:90]!r}; found {count}")
    path.write_text(text.replace(old, new, 1))


# ---------------------------------------------------------------- Rust side
replace_once(
    web_rs,
    "use gecko::host::{DrawVertex, GxAction, RenderSink};\n",
    """use gecko::host::{DrawVertex, GxAction, RenderSink};
use std::sync::atomic::{AtomicU64, Ordering as StatOrdering};

static STAT_FRAMES: AtomicU64 = AtomicU64::new(0);
static STAT_ACTIONS: AtomicU64 = AtomicU64::new(0);
static STAT_DRAWS: AtomicU64 = AtomicU64::new(0);
static STAT_PRESENTS: AtomicU64 = AtomicU64::new(0);
static STAT_TEXLOADS: AtomicU64 = AtomicU64::new(0);
static STAT_XFBCOPY: AtomicU64 = AtomicU64::new(0);
static STAT_EFBCOPY: AtomicU64 = AtomicU64::new(0);
static STAT_VERTS: AtomicU64 = AtomicU64::new(0);
static STAT_PRESENT_W: AtomicU64 = AtomicU64::new(0);
static STAT_PRESENT_H: AtomicU64 = AtomicU64::new(0);
static STAT_PRESENT_PARTS: AtomicU64 = AtomicU64::new(0);

/// Counters for the page's diagnostic overlay (polled from JavaScript).
#[wasm_bindgen::prelude::wasm_bindgen]
pub fn emulator_stats() -> String {
    format!(
        "frames {} actions {} draws {} presents {}\\ntex {} xfbcopy {} efbcopy {} verts {}\\npresent {}x{} parts {}",
        STAT_FRAMES.load(StatOrdering::Relaxed),
        STAT_ACTIONS.load(StatOrdering::Relaxed),
        STAT_DRAWS.load(StatOrdering::Relaxed),
        STAT_PRESENTS.load(StatOrdering::Relaxed),
        STAT_TEXLOADS.load(StatOrdering::Relaxed),
        STAT_XFBCOPY.load(StatOrdering::Relaxed),
        STAT_EFBCOPY.load(StatOrdering::Relaxed),
        STAT_VERTS.load(StatOrdering::Relaxed),
        STAT_PRESENT_W.load(StatOrdering::Relaxed),
        STAT_PRESENT_H.load(StatOrdering::Relaxed),
        STAT_PRESENT_PARTS.load(StatOrdering::Relaxed),
    )
}
""",
)

replace_once(
    web_rs,
    "        let mut external_scratch = self.gx_renderer.replace_vertex_scratch(Vec::new());",
    "        STAT_FRAMES.fetch_add(1, StatOrdering::Relaxed);\n"
    "        let mut external_scratch = self.gx_renderer.replace_vertex_scratch(Vec::new());",
)

replace_once(
    web_rs,
    "            external_scratch.extend_from_slice(&msg.vertices);\n",
    """            STAT_ACTIONS.fetch_add(1, StatOrdering::Relaxed);
            match &msg.action {
                GxAction::Draw(draw) => {
                    STAT_DRAWS.fetch_add(1, StatOrdering::Relaxed);
                    let verts: u64 = draw.segments.iter().map(|s| s.vertex_count as u64).sum();
                    STAT_VERTS.fetch_add(verts, StatOrdering::Relaxed);
                }
                GxAction::PresentXfb { width, height, parts } => {
                    STAT_PRESENTS.fetch_add(1, StatOrdering::Relaxed);
                    STAT_PRESENT_W.store(*width as u64, StatOrdering::Relaxed);
                    STAT_PRESENT_H.store(*height as u64, StatOrdering::Relaxed);
                    STAT_PRESENT_PARTS.store(parts.len() as u64, StatOrdering::Relaxed);
                }
                GxAction::PresentRawXfb { width, height, .. } => {
                    STAT_PRESENTS.fetch_add(1, StatOrdering::Relaxed);
                    STAT_PRESENT_W.store(*width as u64, StatOrdering::Relaxed);
                    STAT_PRESENT_H.store(*height as u64, StatOrdering::Relaxed);
                    STAT_PRESENT_PARTS.store(0, StatOrdering::Relaxed);
                }
                GxAction::LoadTexture { .. } => {
                    STAT_TEXLOADS.fetch_add(1, StatOrdering::Relaxed);
                }
                GxAction::CopyXfb { .. } => {
                    STAT_XFBCOPY.fetch_add(1, StatOrdering::Relaxed);
                }
                GxAction::CopyEfbToTexture { .. } => {
                    STAT_EFBCOPY.fetch_add(1, StatOrdering::Relaxed);
                }
                _ => {}
            }
            external_scratch.extend_from_slice(&msg.vertices);
""",
)

# ---------------------------------------------------------------- HTML side
replace_once(
    web_html,
    "prepare_rvz_stream } from './pkg/gecko_web.js';",
    """prepare_rvz_stream, emulator_stats } from './pkg/gecko_web.js';

            // Diagnostic overlay (patch-hud-stats): separate from the emulator HUD.
            const statsEl = document.createElement('pre');
            statsEl.style.cssText = 'position:fixed;left:6px;bottom:6px;margin:0;padding:4px 6px;'
                + 'font:11px/1.3 monospace;color:#9f9;background:rgba(0,0,0,.65);border-radius:4px;'
                + 'z-index:9999;pointer-events:none;white-space:pre';
            document.body.appendChild(statsEl);
            setInterval(() => {
                try { statsEl.textContent = emulator_stats(); } catch (error) { /* wasm not ready yet */ }
            }, 500);""",
)

rs = web_rs.read_text()
html = web_html.read_text()
for needle in ("pub fn emulator_stats()", "STAT_EFBCOPY.fetch_add", "STAT_TEXLOADS.fetch_add", "STAT_FRAMES.fetch_add"):
    if needle not in rs:
        raise SystemExit(f"HUD stats patch validation failed (lib.rs): {needle}")
if "emulator_stats()" not in html:
    raise SystemExit("HUD stats patch validation failed (index.html)")

print("Added diagnostic counters and a separate overlay (bottom left).")
