#!/usr/bin/env python3
"""Fix the GX vertex-scratch panic (backend-wgpu/src/render.rs:141).

Symptom: ERROR WEB-001-001 ... RUST PANIC at render.rs:141:48, which is the
slice `&self.scratch_vertices[src_base..src_end]` in upload_buffers().

Cause: GxRenderer batches draws lazily. Each draw only stores an index range
(base_vertex, vertex_count) into `scratch_vertices`; the batch is rendered when
a later non-draw action (CopyXfb, PresentXfb, ...) flushes it. The web frontend
replaces the renderer's `scratch_vertices` with an empty Vec at the start of
every frame (and the sink restarts its vertex numbering at 0), so a batch that
was still pending when the frame's emulation slice ended points at vertices
that no longer exist. Games that render at 30 fps (vsync lands mid-frame) hit
this constantly.

Fix 1 (root cause): flush the pending draw batch at the end of every drain, so
nothing indexes the old scratch.
Fix 2 (safety net): never index past the end of scratch_vertices; missing
vertices stay zero (degenerate, invisible) and a warning is logged.

Run after the other patch scripts and before the wasm-pack build.
"""
from pathlib import Path

root = Path("gecko-src")
web_rs = root / "crates/web/src/lib.rs"
render_rs = root / "crates/backend-wgpu/src/render.rs"


def replace_once(path: Path, old: str, new: str) -> None:
    text = path.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"Expected one patch target in {path}: {old[:90]!r}; found {count}")
    path.write_text(text.replace(old, new, 1))


# ---- Fix 1: flush pending draws at the end of each drained frame -----------
replace_once(
    web_rs,
    "                &mut external_scratch,\n            );\n        }\n",
    """                &mut external_scratch,
            );
        }
        // Draws are batched lazily and index into the renderer's vertex scratch,
        // which is replaced at the start of every frame. Render whatever is still
        // pending now, otherwise the next flush indexes vertices that are gone.
        self.gx_renderer.flush_pending_draws(&self.device, &self.queue);
""",
)

# ---- Fix 2: bounds-safe vertex packing -------------------------------------
replace_once(
    render_rs,
    "            for src_v in &self.scratch_vertices[src_base..src_end] {",
    """            let available = self.scratch_vertices.len();
            if src_end > available {
                tracing::warn!(
                    src_base,
                    src_end,
                    available,
                    "draw references vertices outside the scratch buffer; padding with zeros"
                );
            }
            let src_end = src_end.min(available);
            let src_base = src_base.min(src_end);
            for src_v in &self.scratch_vertices[src_base..src_end] {""",
)

for path, needles in (
    (web_rs, ("flush_pending_draws(&self.device, &self.queue)",)),
    (render_rs, ("padding with zeros", "let src_end = src_end.min(available);")),
):
    text = path.read_text()
    for needle in needles:
        if needle not in text:
            raise SystemExit(f"GX vertex patch validation failed in {path}: {needle}")

print("Patched Gecko: pending draw batches are flushed per frame; vertex packing is bounds-safe.")
