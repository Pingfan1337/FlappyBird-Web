// High-efficiency instanced WebGL2 renderer (with automatic Canvas 2D fallback).
//
// In WebGL2 mode, the entire frame renders in ONE drawArraysInstanced call
// using a 10-float-per-quad preallocated Float32Array (zero per-frame GC).
// Premultiplied alpha + linear non-mipmapped sampling matches the iOS Metal
// pipeline in src/App/Shaders.hpp and src/App/main.mm.

const VERT_SRC = `#version 300 es
precision highp float;
layout(location = 0) in vec4 aRect;     // x, y, w, h (logical layout units)
layout(location = 1) in vec4 aUV;       // u, v, uw, vh
layout(location = 2) in vec2 aRotAlpha; // angleDeg, alpha
uniform vec2 uViewport;                 // layout.width, layout.height
out vec2 vUv;
out float vAlpha;
void main() {
  // Triangle strip corners: (0,0), (1,0), (0,1), (1,1)
  vec2 c = vec2(float(gl_VertexID & 1), float((gl_VertexID >> 1) & 1));
  vec2 pos = aRect.xy + c * aRect.zw;
  if (aRotAlpha.x != 0.0) {
    vec2 center = aRect.xy + aRect.zw * 0.5;
    float rad = aRotAlpha.x * 0.017453292519943295; // pi / 180
    float s = sin(rad), cs = cos(rad);
    vec2 d = pos - center;
    pos = vec2(d.x * cs - d.y * s, d.x * s + d.y * cs) + center;
  }
  vec2 ndc = vec2(pos.x / uViewport.x * 2.0 - 1.0, 1.0 - pos.y / uViewport.y * 2.0);
  gl_Position = vec4(ndc, 0.0, 1.0);
  vUv = aUV.xy + c * aUV.zw;
  vAlpha = aRotAlpha.y;
}`;

const FRAG_SRC = `#version 300 es
precision mediump float;
in vec2 vUv;
in float vAlpha;
uniform sampler2D uAtlas;
out vec4 fragColor;
void main() {
  fragColor = texture(uAtlas, vUv) * vAlpha;
}`;

const FLOATS_PER_QUAD = 10;

export class GameRenderer {
  constructor(canvas, atlasImage) {
    this.canvas = canvas;
    this.atlasImage = atlasImage;
    this.mode = 'none';
    this.maxQuads = 256;
    this.instanceData = new Float32Array(this.maxQuads * FLOATS_PER_QUAD);
    this.widthPx = 0;
    this.heightPx = 0;
    this.frameIndex = 0;

    if (!this._initWebGL2()) {
      this._initCanvas2D();
    }
  }

  _initWebGL2() {
    let gl = null;
    try {
      gl = this.canvas.getContext('webgl2', {
        alpha: false,
        antialias: false,
        depth: false,
        stencil: false,
        premultipliedAlpha: true,
        preserveDrawingBuffer: false,
        powerPreference: 'high-performance',
      });
    } catch {
      return false;
    }
    if (!gl) return false;

    const vs = this._compile(gl, gl.VERTEX_SHADER, VERT_SRC);
    const fs = this._compile(gl, gl.FRAGMENT_SHADER, FRAG_SRC);
    if (!vs || !fs) return false;

    const prog = gl.createProgram();
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return false;

    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, this.atlasImage);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    const stride = FLOATS_PER_QUAD * 4;
    // Triple-buffered VAOs/VBOs mirror Metal's frameBuffers[3] to avoid GPU upload stalls.
    this.vaos = [];
    this.vbos = [];
    for (let i = 0; i < 3; i++) {
      const vao = gl.createVertexArray();
      gl.bindVertexArray(vao);
      const vbo = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
      gl.bufferData(gl.ARRAY_BUFFER, this.instanceData.byteLength, gl.STREAM_DRAW);

      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 4, gl.FLOAT, false, stride, 0);
      gl.vertexAttribDivisor(0, 1);

      gl.enableVertexAttribArray(1);
      gl.vertexAttribPointer(1, 4, gl.FLOAT, false, stride, 16);
      gl.vertexAttribDivisor(1, 1);

      gl.enableVertexAttribArray(2);
      gl.vertexAttribPointer(2, 2, gl.FLOAT, false, stride, 32);
      gl.vertexAttribDivisor(2, 1);

      this.vaos.push(vao);
      this.vbos.push(vbo);
    }

    gl.useProgram(prog);
    gl.uniform1i(gl.getUniformLocation(prog, 'uAtlas'), 0);
    this.uViewport = gl.getUniformLocation(prog, 'uViewport');

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.disable(gl.DEPTH_TEST);
    gl.clearColor(0, 0, 0, 1);

    this.gl = gl;
    this.prog = prog;
    this.tex = tex;
    this.mode = 'webgl2';

    this.canvas.addEventListener('webglcontextlost', e => { e.preventDefault(); this.contextLost = true; });
    this.canvas.addEventListener('webglcontextrestored', () => { this.contextLost = false; this._initWebGL2(); });
    return true;
  }

  _compile(gl, type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      console.error(gl.getShaderInfoLog(s));
      return null;
    }
    return s;
  }

  _initCanvas2D() {
    this.ctx2d = this.canvas.getContext('2d', { alpha: false, desynchronized: true });
    this.mode = 'canvas2d';
  }

  resize(pixelWidth, pixelHeight) {
    const w = Math.max(1, Math.round(pixelWidth));
    const h = Math.max(1, Math.round(pixelHeight));
    if (this.widthPx === w && this.heightPx === h) return;
    this.widthPx = w;
    this.heightPx = h;
    this.canvas.width = w;
    this.canvas.height = h;
    if (this.mode === 'webgl2') {
      this.gl.viewport(0, 0, w, h);
    }
  }

  render(quads, layout) {
    if (this.mode === 'webgl2') {
      if (this.contextLost) return;
      const gl = this.gl;
      const n = Math.min(quads.n, this.maxQuads);
      const data = this.instanceData;
      for (let i = 0, o = 0; i < n; i++, o += FLOATS_PER_QUAD) {
        data[o]     = quads.x[i];
        data[o + 1] = quads.y[i];
        data[o + 2] = quads.w[i];
        data[o + 3] = quads.h[i];
        data[o + 4] = quads.u[i];
        data[o + 5] = quads.v[i];
        data[o + 6] = quads.uw[i];
        data[o + 7] = quads.vh[i];
        data[o + 8] = quads.angle[i];
        data[o + 9] = quads.alpha[i];
      }
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.uniform2f(this.uViewport, layout.width, layout.height);
      const slot = this.frameIndex;
      this.frameIndex = (slot + 1) % 3;
      gl.bindVertexArray(this.vaos[slot]);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.vbos[slot]);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, data.subarray(0, n * FLOATS_PER_QUAD));
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, n);
      return;
    }

    // Canvas 2D fallback
    const ctx = this.ctx2d;
    if (!ctx) return;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, this.widthPx, this.heightPx);
    const sx = this.widthPx / layout.width;
    const sy = this.heightPx / layout.height;
    ctx.scale(sx, sy);
    ctx.imageSmoothingEnabled = true;

    const img = this.atlasImage;
    for (let i = 0; i < quads.n; i++) {
      const a = quads.alpha[i];
      if (a <= 0) continue;
      const x = quads.x[i], y = quads.y[i], w = quads.w[i], h = quads.h[i];
      const uw = quads.uw[i], vh = quads.vh[i];
      const u = quads.u[i] * 1024, v = quads.v[i] * 1024;
      const angle = quads.angle[i];

      ctx.globalAlpha = a;
      if (uw === 0 && vh === 0) {
        // Solid 1x1 texel sample
        ctx.drawImage(img, Math.floor(u), Math.floor(v), 1, 1, x, y, w, h);
        continue;
      }

      const flipX = uw < 0;
      const srcX = flipX ? (quads.u[i] + uw) * 1024 : u;
      const srcW = Math.abs(uw) * 1024;
      const srcH = vh * 1024;

      if (angle !== 0 || flipX) {
        ctx.save();
        ctx.translate(x + w / 2, y + h / 2);
        if (angle !== 0) ctx.rotate(angle * Math.PI / 180);
        if (flipX) ctx.scale(-1, 1);
        ctx.drawImage(img, srcX, v, srcW, srcH, -w / 2, -h / 2, w, h);
        ctx.restore();
      } else {
        ctx.drawImage(img, srcX, v, srcW, srcH, x, y, w, h);
      }
    }
    ctx.restore();
  }
}
