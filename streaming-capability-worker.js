self.onmessage = () => {
  const result = {
    workerStarted: true,
    offscreenCanvas: typeof OffscreenCanvas !== "undefined",
    workerNavigatorGpu: Boolean(self.navigator && self.navigator.gpu),
    workerWebAssembly: typeof WebAssembly !== "undefined",
    sharedArrayBuffer: typeof SharedArrayBuffer !== "undefined",
    crossOriginIsolated: self.crossOriginIsolated === true,
    opfsStorage: Boolean(self.navigator && self.navigator.storage && self.navigator.storage.getDirectory)
  };

  if (result.offscreenCanvas) {
    try {
      const canvas = new OffscreenCanvas(16, 16);
      result.offscreenWebGL2 = Boolean(canvas.getContext("webgl2"));
    } catch (error) {
      result.offscreenWebGL2 = false;
      result.webglError = String(error);
    }
  } else {
    result.offscreenWebGL2 = false;
  }

  if (self.navigator && self.navigator.gpu) {
    self.navigator.gpu.requestAdapter()
      .then(adapter => {
        result.workerWebGPU = Boolean(adapter);
        self.postMessage({ type: "result", result });
      })
      .catch(error => {
        result.workerWebGPU = false;
        result.webgpuError = String(error);
        self.postMessage({ type: "result", result });
      });
  } else {
    result.workerWebGPU = false;
    self.postMessage({ type: "result", result });
  }
};
