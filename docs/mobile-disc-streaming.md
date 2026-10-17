# Mobile Wii disc streaming: engineering plan

## Current blocker

The web frontend currently allocates a `Uint8Array(file.size)`, copies the selected file into it, and passes that byte array to WebAssembly. Gecko's disc API then takes ownership of a complete `Vec<u8>`:

- `image::load_dvd(data: Vec<u8>)`
- `Iso { data: Vec<u8> }`
- `Rvz { file_data: Vec<u8> }`

Reading the browser `File` in chunks only changes how bytes are copied; it does not reduce the final resident memory requirement. RVZ can reduce the file size on disk, but this API still retains the entire RVZ container in memory.

## Proposed direction

Do not treat another frontend chunk-size change as a streaming fix. The work needs to change the disc storage contract and the web execution model.

### Phase 1 — introduce a storage-backed disc reader in Gecko

1. Replace the ownership assumption in `load_dvd(Vec<u8>)` with a source abstraction that supports bounded reads and exposes the source length.
2. Make ISO parsing read only the header, header info, apploader, and filesystem table initially. Keep the parsed filesystem metadata resident, not the whole ISO.
3. Make RVZ parsing read its header and metadata tables by range, and decompress only the RVZ groups needed for each requested disc range.
4. Preserve a byte-backed source for native builds and existing tests, so this refactor does not require browser APIs in the core image crate.
5. Add tests for reads across chunk/group boundaries, short reads, out-of-range reads, ISO metadata parsing, and RVZ decompression.

### Phase 2 — browser-backed source

A normal browser `File.slice().arrayBuffer()` call is asynchronous, while Gecko's current `Dvd::read_disc_into` contract is synchronous. Simply putting the existing file reader in a Web Worker will not bridge that mismatch.

Evaluate these options before choosing one:

- An async/continuation-aware disc API propagated through the emulator boot and runtime paths.
- A synchronous file source inside a dedicated worker backed by OPFS, with the emulator and rendering pipeline moved to a worker-compatible architecture.
- A bounded block cache backed by OPFS, after the execution model can synchronously request blocks without blocking the UI thread.

Do not require `SharedArrayBuffer`/cross-origin isolation without confirming how it will be enabled on GitHub Pages and tested on Android. GitHub Pages does not offer arbitrary response-header configuration, so a solution that assumes COOP/COEP headers may not work without an additional isolation strategy.

### Phase 3 — browser integration and device tests

- Remove the full-size `new Uint8Array(file.size)` allocation for ISO/RVZ.
- Display load, cache, and boot progress separately.
- Test on Android Chrome with a small homebrew image first, then a legally obtained test disc image.
- Record peak memory, cold-start time, and whether the emulator reaches the first rendered frame.
- Keep the current path behind a feature flag until both ISO and RVZ pass the same test suite.

## Acceptance criteria

- No allocation proportional to the complete disc-image size in the JavaScript frontend or ISO source.
- ISO and RVZ reads are served by bounded range reads plus a bounded cache.
- Disc parsing and boot are covered by tests; the GitHub Actions build passes.
- A successful build is not described as successful game compatibility until a browser boot test reaches the first frame.

## Important

This is a design/implementation checklist, not a claim that streaming is already implemented. The key architectural decision is how to reconcile synchronous disc reads with browser file I/O; settle and test that before making the frontend promise support for multi-gigabyte images.
