self.onmessage = (event) => {
  const data = event.data || {};
  if (data.type !== 'start') return;
  const canvas = data.canvas;
  const width = Math.max(1, data.width || 640);
  const height = Math.max(1, data.height || 360);
  try {
    canvas.width = width;
    canvas.height = height;
    const gl = canvas.getContext('webgl2', { alpha: false, antialias: true, powerPreference: 'low-power' });
    if (!gl) {
      self.postMessage({type:'result', ok:false, message:'OffscreenCanvas exists, but getContext("webgl2") returned null.'});
      return;
    }
    const vertexSource = `#version 300 es
      in vec2 aPosition;
      in vec3 aColor;
      uniform float uTime;
      out vec3 vColor;
      void main() {
        float a = uTime * 0.7;
        mat2 rot = mat2(cos(a), -sin(a), sin(a), cos(a));
        vec2 p = rot * aPosition;
        gl_Position = vec4(p, 0.0, 1.0);
        vColor = aColor;
      }`;
    const fragmentSource = `#version 300 es
      precision highp float;
      in vec3 vColor;
      uniform float uTime;
      out vec4 outColor;
      void main() {
        float pulse = 0.65 + 0.35 * sin(uTime * 2.0);
        outColor = vec4(vColor * pulse, 1.0);
      }`;
    function compile(type, source) {
      const shader = gl.createShader(type);
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        const log = gl.getShaderInfoLog(shader) || 'Unknown shader compile error';
        gl.deleteShader(shader);
        throw new Error(log);
      }
      return shader;
    }
    const vs = compile(gl.VERTEX_SHADER, vertexSource);
    const fs = compile(gl.FRAGMENT_SHADER, fragmentSource);
    const program = gl.createProgram();
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(gl.getProgramInfoLog(program) || 'Unknown program link error');
    }
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    const vertices = new Float32Array([
       0.00,  0.72, 1.00, 0.20, 0.28,
      -0.68, -0.48, 0.20, 0.85, 1.00,
       0.68, -0.48, 0.55, 1.00, 0.30
    ]);
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW);
    const stride = 5 * Float32Array.BYTES_PER_ELEMENT;
    const position = gl.getAttribLocation(program, 'aPosition');
    const color = gl.getAttribLocation(program, 'aColor');
    gl.enableVertexAttribArray(position);
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, stride, 0);
    gl.enableVertexAttribArray(color);
    gl.vertexAttribPointer(color, 3, gl.FLOAT, false, stride, 2 * Float32Array.BYTES_PER_ELEMENT);
    const timeLocation = gl.getUniformLocation(program, 'uTime');
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clearColor(0.025, 0.035, 0.07, 1);
    gl.useProgram(program);
    const started = performance.now();
    let frames = 0;
    let reported = false;
    self.postMessage({type:'status', message:'Worker created WebGL2 context. Rendering animated triangle…'});
    function frame(now) {
      if (reported) return;
      frames++;
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.uniform1f(timeLocation, (now - started) / 1000);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      if (frames >= 180 || now - started >= 5000) {
        reported = true;
        const seconds = Math.max(0.001, (now - started) / 1000);
        const fps = (frames / seconds).toFixed(1);
        self.postMessage({
          type:'result',
          ok: frames > 0 && !gl.isContextLost(),
          message:'Worker WebGL2 context: YES\nAnimated frames rendered: ' + frames +
            '\nElapsed: ' + seconds.toFixed(2) + ' s\nApprox. FPS during test: ' + fps +
            '\nContext lost: ' + (gl.isContextLost() ? 'YES' : 'NO') +
            '\nCanvas size: ' + canvas.width + ' × ' + canvas.height
        });
        return;
      }
      self.requestAnimationFrame(frame);
    }
    self.requestAnimationFrame(frame);
  } catch (error) {
    self.postMessage({type:'error', message: error && error.stack ? error.stack : String(error)});
  }
};