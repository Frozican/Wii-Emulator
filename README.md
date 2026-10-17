# Wii Web

A mobile-first static website exploring browser-based GameCube/Wii emulation, hosted on GitHub Pages without a custom server.

## Current status

- The main page is a mobile-first project frontend.
- GitHub Actions checks out the open-source [Gecko emulator](https://github.com/ioncodes/gecko), builds its WebAssembly frontend, and publishes it under `/gecko/`.
- Open the experimental engine at [https://frozican.github.io/Wii-Emulator/gecko/](https://frozican.github.io/Wii-Emulator/gecko/).
- **Important limitation:** Gecko's current web entry point accepts DOL homebrew executables or IPL files. This integration does not yet boot Wii ISO/RVZ disc images. The upstream browser input path currently uses keyboard controls; this site has not connected its touch buttons to Gecko.

## GitHub Pages

1. Open [Settings → Pages](https://github.com/Frozican/Wii-Emulator/settings/pages).
2. Under **Build and deployment → Source**, select **GitHub Actions**.
3. Check the [Actions tab](https://github.com/Frozican/Wii-Emulator/actions) for the workflow **Build Gecko WASM and deploy Wii Web**. The first build may take several minutes.
4. Visit [Wii Web](https://frozican.github.io/Wii-Emulator/) after a successful deployment.

## Browser and file notes

- Game/homebrew files are selected locally; this project does not upload them to a server.
- WebAssembly and WebGPU support vary by browser and device. A successful build does not guarantee that every Android device can run the emulator smoothly.
- The main page's ISO/RVZ picker is currently informational only. Do not mistake file selection for game boot support.
- Use only game images and system files you are legally entitled to use. This repository does not include commercial games or Nintendo firmware.

## Next engineering milestones

1. Verify the generated Gecko runtime boots on desktop and Android browsers.
2. Extend the browser interface and emulator API to load Wii disc images (ISO/RVZ), including any required disc filesystem and boot path.
3. Connect touch controls to emulator input, including pointer/touch lifecycle and motion input where supported.
4. Measure memory use and performance on mobile devices before calling it playable.
