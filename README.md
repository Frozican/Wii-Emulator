# Wii Web

A mobile-first static website exploring browser-based GameCube/Wii emulation, hosted on GitHub Pages without a custom server.

## Current status

- The main page is a mobile-first project frontend.
- GitHub Actions checks out the open-source [Gecko emulator](https://github.com/ioncodes/gecko), builds its WebAssembly frontend, and publishes it under `/gecko/`.
- Open the experimental engine at [https://frozican.github.io/Wii-Emulator/gecko/](https://frozican.github.io/Wii-Emulator/gecko/).
- **Important limitation:** Wii ISO/RVZ boot is still experimental and not verified. The current Gecko boot path loads the full disc image into memory; the streaming reader test is a separate diagnostic and is not yet connected to the emulation core. Keyboard controls are available; mobile touch controls and a successful Android game boot remain unverified.
- Test the bounded reader and NKit metadata probe at [Reader Test](https://frozican.github.io/Wii-Emulator/reader-test/). The harness also checks that negative, fractional, and past-EOF ranges are rejected. The probe checks metadata only; it does not decode the entire NKit image or boot a game.

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
2. Implement a resumable/asynchronous disc-read path; the current core expects synchronous reads.
3. Decode NKit gap/partition data correctly without retaining the whole ISO in RAM.
4. Connect the reader to the Wii apploader and DVD interface, then test boot.
5. Add mobile touch controls and measure memory/performance on Android before calling it playable.
