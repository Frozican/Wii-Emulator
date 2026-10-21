#!/usr/bin/env python3
"""Add diagnostic counters to the performance HUD of the Gecko web build.

The HUD gets a second line:
    frames N actions N draws N presents N
  frames   - emulation slices rendered by the page (one per browser frame)
  actions  - GX actions the emulated GPU produced so far
  draws    - GX draw batches among them
  presents - XFB presents, i.e. images the game actually handed to the screen

How to read it on a black screen:
  actions stays 0            -> the emulated CPU has not reached any GPU work yet
                                (still booting; at a few percent speed this takes long)
  draws > 0, presents == 0   -> the game draws but never finishes a frame
  presents > 0 but still black -> an output/blit problem, not a boot problem

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
                GxAction::Draw(_) => {
                    STAT_DRAWS.fetch_add(1, StatOrdering::Relaxed);
                }
                GxAction::PresentXfb { .. } | GxAction::PresentRawXfb { .. } => {
                    STAT_PRESENTS.fetch_add(1, StatOrdering::Relaxed);
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
                            "{fps:.1} FPS  {native_pct:.1}%\\nframes {} actions {} draws {} presents {}",
                            STAT_FRAMES.load(StatOrdering::Relaxed),
                            STAT_ACTIONS.load(StatOrdering::Relaxed),
                            STAT_DRAWS.load(StatOrdering::Relaxed),
                            STAT_PRESENTS.load(StatOrdering::Relaxed),
                        ))
                        .monospace(),
                    );""",
)

text = web_rs.read_text()
for needle in ("STAT_PRESENTS.load", "STAT_FRAMES.fetch_add", "GxAction::PresentRawXfb { .. }"):
    if needle not in text:
        raise SystemExit(f"HUD stats patch validation failed: {needle}")

print("Patched Gecko web HUD: frames / actions / draws / presents counters.")
