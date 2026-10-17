# Wii Web

A mobile-first static website prototype for a future browser-based Wii emulator.

## Current status

This repository currently contains the responsive frontend, local game-file picker, and placeholder touch controls. **It does not emulate or run Wii games yet.** A compatible WebAssembly emulation runtime must be built and integrated before game files can boot.

## GitHub Pages

1. Open **Settings → Pages** in this repository.
2. Under **Build and deployment**, select **Deploy from a branch**.
3. Select the `main` branch and `/(root)`, then save.
4. Wait for the Pages deployment to finish and open the published URL.

No server or backend is required for this frontend.

## Mobile notes

- Designed for Android browsers in portrait and landscape.
- Game files are selected locally in the browser; this page does not upload them.
- Large disc images can exceed available phone memory.
- File picker acceptance does not mean the selected format is supported by an emulator engine.

## Emulator engine investigation

[Gecko](https://github.com/ioncodes/gecko) is an open-source GameCube/Wii emulator with a WebAssembly frontend under `crates/web`. Its current browser build and mobile compatibility need to be tested before it can be treated as a working Wii emulator. Do not copy copyrighted Wii system files or game images into this repository.

## Legal note

Use game images and system files that you are legally entitled to use. This project does not include commercial games or Nintendo system firmware.