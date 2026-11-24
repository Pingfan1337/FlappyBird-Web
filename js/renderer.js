// Single, zero-stall GPU renderer mirroring src/App/main.mm:
// - 4 rotating pre-allocated VBOs (each untouched for 4 frames -> zero ANGLE/Metal stalls)
// - Non-instanced classic gl.drawElements with static Uint16Array IBO (avoids WebKit Bug 222731)
// - Native alpha:true + premultipliedAlpha:true matching Metal BGRA8Unorm IOSurface 1:1
// - Minimal Canvas 2D fallback only when WebGL is unavailable

const MAX_QUADS = 128;
const FLOATS_PER_VERT = 5; // x, y, u, v, alpha
const VERTS_PER_QUAD = 4;
const RING_SIZE = 4;

const VERT_SRC = `
attribute vec2 aPos;
attribute vec2 aUv;
attribute float aAlpha;
uniform vec2 uViewport;
varying vec2 vUv;
varying float vAlpha;
void main() {
  vec2 ndc = vec2(aPos.x / uViewport.x * 2.0 - 1.0, 1.0 - aPos.y / uViewport.y * 2.0);
  gl_Position = vec4(ndc, 0.0, 1.0);
  vUv = aUv;
  vAlpha = aAlpha;
}`;

const FRAG_SRC = `
precision highp float;
varying vec2 vUv;
varying float vAlpha;
uniform sampler2D uAtlas;
void main() {
  gl_FragColor = texture2D(uAtlas, vUv) * vAlpha;
}`;

export class GameRenderer {
  constructor(canvas, atlasImage, force2d = false) {
    this.canvas = canvas;
    this.atlasImage = atlasImage;
    this.mode = 'none';
    this.widthPx = 0;
    this.heightPx = 0;

    if (force2d || !this._initWebGL()) {
      this._initCanvas2D();
    }
  }

  _initWebGL() {
    let gl = null;
    let isWebGL2 = false;
    const attrs = {
      alpha: true,
      antialias: false,
      depth: false,
      stencil: false,
      premultipliedAlpha: true,
      preserveDrawingBuffer: false,
      powerPreference: 'high-performance',
    };
    try {
      gl = this.canvas.getContext('webgl2', attrs);
      if (gl) isWebGL2 = true;
      else gl = this.canvas.getContext('webgl', attrs);
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

    const indices = new Uint16Array(MAX_QUADS * 6);
    for (let i = 0; i < MAX_QUADS; i++) {
      const v = i * 4, o = i * 6;
      indices[o] = v; indices[o + 1] = v + 1; indices[o + 2] = v + 2;
      indices[o + 3] = v; indices[o + 4] = v + 2; indices[o + 5] = v + 3;
    }
    const ibo = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);

    const vertexData = new Float32Array(MAX_QUADS * VERTS_PER_QUAD * FLOATS_PER_VERT);
    const stride = FLOATS_PER_VERT * 4;
    const aPos = gl.getAttribLocation(prog, 'aPos');
    const aUv = gl.getAttribLocation(prog, 'aUv');
    const aAlpha = gl.getAttribLocation(prog, 'aAlpha');

    const vbos = [];
    const vaos = [];
    for (let i = 0; i < RING_SIZE; i++) {
      const vao = isWebGL2 ? gl.createVertexArray() : null;
      if (vao) {
        gl.bindVertexArray(vao);
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
      }
      const vbo = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
      gl.bufferData(gl.ARRAY_BUFFER, vertexData.byteLength, gl.STREAM_DRAW);
      gl.enableVertexAttribArray(aPos);
      gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, stride, 0);
      gl.enableVertexAttribArray(aUv);
      gl.vertexAttribPointer(aUv, 2, gl.FLOAT, false, stride, 8);
      gl.enableVertexAttribArray(aAlpha);
      gl.vertexAttribPointer(aAlpha, 1, gl.FLOAT, false, stride, 16);
      vbos.push(vbo);
      vaos.push(vao);
    }

    gl.useProgram(prog);
    gl.uniform1i(gl.getUniformLocation(prog, 'uAtlas'), 0);
    const uViewport = gl.getUniformLocation(prog, 'uViewport');

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.disable(gl.DEPTH_TEST);
    gl.clearColor(0, 0, 0, 1);

    this.glState = {
      gl, isWebGL2, prog, ibo, vbos, vaos, vertexData, uViewport,
      aPos, aUv, aAlpha, stride, slot: 0, contextLost: false,
    };
    this.mode = isWebGL2 ? 'webgl2' : 'webgl';

    this.canvas.addEventListener('webglcontextlost', e => {
      e.preventDefault();
      if (this.glState) this.glState.contextLost = true;
    });
    this.canvas.addEventListener('webglcontextrestored', () => {
      this._initWebGL();
    });
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
    this.ctx2d = this.canvas.getContext('2d', { alpha: true });
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
    if (this.glState) {
      this.glState.gl.viewport(0, 0, w, h);
    }
  }

  render(quads, layout) {
    const s = this.glState;
    if (s) {
      if (s.contextLost) return;
      const gl = s.gl;
      const n = quads.n < MAX_QUADS ? quads.n : MAX_QUADS;
      const v = s.vertexData;
      const qx = quads.x, qy = quads.y, qw = quads.w, qh = quads.h;
      const qu = quads.u, qv = quads.v, quw = quads.uw, qvh = quads.vh;
      const qa = quads.alpha, qang = quads.angle;
      let o = 0;

      for (let i = 0; i < n; i++) {
        const x = qx[i], y = qy[i], w = qw[i], h = qh[i];
        const u0 = qu[i], v0 = qv[i], u1 = u0 + quw[i], v1 = v0 + qvh[i];
        const a = qa[i], ang = qang[i];
        let x0 = x, y0 = y, x1 = x + w, y1 = y, x2 = x + w, y2 = y + h, x3 = x, y3 = y + h;
        if (ang !== 0) {
          const cx = x + w * 0.5, cy = y + h * 0.5;
          const rad = ang * 0.017453292519943295;
          const sn = Math.sin(rad), cs = Math.cos(rad);
          const dx0 = x0 - cx, dy0 = y0 - cy;
          const dx1 = x1 - cx, dy1 = y1 - cy;
          const dx2 = x2 - cx, dy2 = y2 - cy;
          const dx3 = x3 - cx, dy3 = y3 - cy;
          x0 = dx0 * cs - dy0 * sn + cx; y0 = dx0 * sn + dy0 * cs + cy;
          x1 = dx1 * cs - dy1 * sn + cx; y1 = dx1 * sn + dy1 * cs + cy;
          x2 = dx2 * cs - dy2 * sn + cx; y2 = dx2 * sn + dy2 * cs + cy;
          x3 = dx3 * cs - dy3 * sn + cx; y3 = dx3 * sn + dy3 * cs + cy;
        }
        v[o] = x0; v[o + 1] = y0; v[o + 2] = u0; v[o + 3] = v0; v[o + 4] = a;
        v[o + 5] = x1; v[o + 6] = y1; v[o + 7] = u1; v[o + 8] = v0; v[o + 9] = a;
        v[o + 10] = x2; v[o + 11] = y2; v[o + 12] = u1; v[o + 13] = v1; v[o + 14] = a;
        v[o + 15] = x3; v[o + 16] = y3; v[o + 17] = u0; v[o + 18] = v1; v[o + 19] = a;
        o += 20;
      }

      const slot = s.slot;
      s.slot = (slot + 1) & (RING_SIZE - 1);

      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.uniform2f(s.uViewport, layout.width, layout.height);

      if (s.isWebGL2) {
        gl.bindVertexArray(s.vaos[slot]);
        gl.bindBuffer(gl.ARRAY_BUFFER, s.vbos[slot]);
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, v, 0, o);
      } else {
        gl.bindBuffer(gl.ARRAY_BUFFER, s.vbos[slot]);
        gl.vertexAttribPointer(s.aPos, 2, gl.FLOAT, false, s.stride, 0);
        gl.vertexAttribPointer(s.aUv, 2, gl.FLOAT, false, s.stride, 8);
        gl.vertexAttribPointer(s.aAlpha, 1, gl.FLOAT, false, s.stride, 16);
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, v.subarray(0, o));
      }
      gl.drawElements(gl.TRIANGLES, n * 6, gl.UNSIGNED_SHORT, 0);
      return;
    }

    // Emergency Canvas 2D fallback (only when WebGL is unavailable).
    const ctx = this.ctx2d;
    if (!ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, this.widthPx, this.heightPx);
    const sx = this.widthPx / layout.width;
    const sy = this.heightPx / layout.height;
    ctx.setTransform(sx, 0, 0, sy, 0, 0);
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
        ctx.drawImage(img, Math.floor(u), Math.floor(v), 1, 1, x, y, w, h);
        continue;
      }

      const flipX = uw < 0;
      const srcX = flipX ? (quads.u[i] + uw) * 1024 : u;
      const srcW = Math.abs(uw) * 1024;
      const srcH = vh * 1024;

      if (angle !== 0 || flipX) {
        ctx.save();
        ctx.translate(x + w * 0.5, y + h * 0.5);
        if (angle !== 0) ctx.rotate(angle * Math.PI / 180);
        if (flipX) ctx.scale(-1, 1);
        ctx.drawImage(img, srcX, v, srcW, srcH, -w * 0.5, -h * 0.5, w, h);
        ctx.restore();
      } else {
        ctx.drawImage(img, srcX, v, srcW, srcH, x, y, w, h);
      }
    }
  }
}
