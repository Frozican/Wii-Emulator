#!/usr/bin/env python3
"""Add diagnostic counters to the performance HUD of the Gecko web build.

The HUD gets a second and third line:
    frames N actions N draws N presents N
    tex N xfbcopy N efbcopy N verts N | present WxH parts N

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

How to read it on a black screen:
  actions ~ 0                      -> the emulated CPU has not reached any GPU work
  draws ~ frames, tex ~ 0, verts small -> the game draws one flat quad per frame
                                      (black / fade); it is still booting
  tex and verts growing fast       -> real content is being drawn; if the screen
                                      is still black, the output path is at fault
  efbcopy growing                  -> the game depends on render-to-texture,
                                      which this web build does not support yet

Run after the other patch scripts and before the wasm-pack build.
"""
from pathlib import Path

web_rs = Path("gecko-src/crates/web/src/lib.rs")


def replace_once(path: Path, old: str, new: str) -> None:
    text = path.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"Expected one patch target in {path}: {old[:90]!r}; found {count}")
    path.write_text(text.replace(old, new, 1))


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

replace_once(
    web_rs,
    'ui.label(egui::RichText::new(format!("{fps:.1} FPS  {native_pct:.1}%")).monospace());',
    """ui.label(
                        egui::RichText::new(format!(
                            "{fps:.1} FPS  {native_pct:.1}%\\nframes {} actions {} draws {} presents {}\\ntex {} xfbcopy {} efbcopy {} verts {}\\npresent {}x{} parts {}",
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
                        ))
                        .monospace(),
                    );""",
)

text = web_rs.read_text()
for needle in ("STAT_PRESENT_PARTS.load", "STAT_EFBCOPY.fetch_add", "STAT_TEXLOADS.fetch_add", "STAT_FRAMES.fetch_add"):
    if needle not in text:
        raise SystemExit(f"HUD stats patch validation failed: {needle}")

print("Patched Gecko web HUD: frame / action / draw / texture / copy / present counters.")
