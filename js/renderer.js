// Multi-tier zero-stutter renderer:
//   1. WebGPU (native Metal on iOS 26/27 Safari & modern desktop — zero ANGLE translation)
//   2. Non-instanced WebGL (classic drawElements triangle batch — avoids WebKit Bug 222731)
//   3. Canvas 2D fallback

const MAX_QUADS = 96;
const GPU_FLOATS_PER_QUAD = 12; // 3 vec4s: rect, uv, extra(deg, alpha, 0, 0)
const GL_FLOATS_PER_VERT = 5;   // x, y, u, v, alpha
const GL_VERTS_PER_QUAD = 4;

const WGSL_SRC = `
struct Quad {
  rect: vec4<f32>,
  uv: vec4<f32>,
  extra: vec4<f32>,
};
struct Uniforms {
  viewport: vec2<f32>,
  _pad: vec2<f32>,
  quads: array<Quad, ${MAX_QUADS}>,
};
@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(1) var uSampler: sampler;
@group(0) @binding(2) var uAtlas: texture_2d<f32>;

struct VsOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) uv: vec2<f32>,
  @location(1) alpha: f32,
};

@vertex
fn vs_main(@builtin(vertex_index) vid: u32, @builtin(instance_index) iid: u32) -> VsOut {
  let c = vec2<f32>(f32(vid & 1u), f32((vid >> 1u) & 1u));
  let q = u.quads[iid];
  var pos = q.rect.xy + c * q.rect.zw;
  if (q.extra.x != 0.0) {
    let center = q.rect.xy + q.rect.zw * 0.5;
    let rad = q.extra.x * 0.017453292519943295;
    let s = sin(rad);
    let cs = cos(rad);
    let d = pos - center;
    pos = vec2<f32>(d.x * cs - d.y * s, d.x * s + d.y * cs) + center;
  }
  let ndc = vec2<f32>(pos.x / u.viewport.x * 2.0 - 1.0, 1.0 - pos.y / u.viewport.y * 2.0);
  var out: VsOut;
  out.pos = vec4<f32>(ndc, 0.0, 1.0);
  out.uv = q.uv.xy + c * q.uv.zw;
  out.alpha = q.extra.y;
  return out;
}

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4<f32> {
  return textureSample(uAtlas, uSampler, in.uv) * in.alpha;
}
`;

const GL_VERT_SRC = `
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

const GL_FRAG_SRC = `
precision highp float;
varying vec2 vUv;
varying float vAlpha;
uniform sampler2D uAtlas;
void main() {
  gl_FragColor = texture2D(uAtlas, vUv) * vAlpha;
}`;

export class GameRenderer {
  constructor(canvas, atlasImage) {
    this.canvas = canvas;
    this.atlasImage = atlasImage;
    this.mode = 'none';
    this.widthPx = 0;
    this.heightPx = 0;
  }

  static async create(canvas, atlasImage, preferred = 'auto') {
    const r = new GameRenderer(canvas, atlasImage);
    if (preferred === '2d') {
      r._initCanvas2D();
      return r;
    }
    if ((preferred === 'auto' || preferred === 'webgpu') && await r._initWebGPU()) {
      return r;
    }
    if ((preferred === 'auto' || preferred === 'webgl') && r._initWebGL()) {
      return r;
    }
    r._initCanvas2D();
    return r;
  }

  async _initWebGPU() {
    if (typeof navigator === 'undefined' || !navigator.gpu) return false;
    try {
      const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
      if (!adapter) return false;
      const device = await adapter.requestDevice();
      const ctx = this.canvas.getContext('webgpu');
      if (!ctx) return false;

      const format = navigator.gpu.getPreferredCanvasFormat();
      ctx.configure({ device, format, alphaMode: 'premultiplied' });

      const module = device.createShaderModule({ code: WGSL_SRC });
      const pipeline = device.createRenderPipeline({
        layout: 'auto',
        vertex: { module, entryPoint: 'vs_main' },
        fragment: {
          module,
          entryPoint: 'fs_main',
          targets: [{
            format,
            blend: {
              color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
              alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
            },
          }],
        },
        primitive: { topology: 'triangle-strip' },
      });

      const w = this.atlasImage.naturalWidth || this.atlasImage.width || 1024;
      const h = this.atlasImage.naturalHeight || this.atlasImage.height || 1024;
      const texture = device.createTexture({
        size: [w, h, 1],
        format: 'rgba8unorm',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
      });
      device.queue.copyExternalImageToTexture(
        { source: this.atlasImage },
        { texture, premultipliedAlpha: true },
        [w, h]
      );

      const sampler = device.createSampler({
        magFilter: 'linear',
        minFilter: 'linear',
        addressModeU: 'clamp-to-edge',
        addressModeV: 'clamp-to-edge',
      });

      const uniformSize = (4 + MAX_QUADS * GPU_FLOATS_PER_QUAD) * 4;
      const uniformData = new Float32Array(4 + MAX_QUADS * GPU_FLOATS_PER_QUAD);
      const uniformBuf = device.createBuffer({
        size: uniformSize,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });

      const bindGroup = device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: uniformBuf } },
          { binding: 1, resource: sampler },
          { binding: 2, resource: texture.createView() },
        ],
      });

      const colorAttachment = {
        view: null,
        clearValue: { r: 0, g: 0, b: 0, a: 1 },
        loadOp: 'clear',
        storeOp: 'store',
      };

      this.gpu = {
        device, ctx, format, pipeline, uniformData, uniformBuf, bindGroup,
        renderPassDesc: { colorAttachments: [colorAttachment] },
        colorAttachment,
      };
      this.mode = 'webgpu';
      device.lost.then(() => {
        if (this.mode === 'webgpu') {
          this.mode = 'none';
          if (!this._initWebGL()) this._initCanvas2D();
        }
      });
      return true;
    } catch {
      return false;
    }
  }

  _initWebGL() {
    let gl = null;
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
      gl = this.canvas.getContext('webgl2', attrs) || this.canvas.getContext('webgl', attrs);
    } catch {
      return false;
    }
    if (!gl) return false;

    const vs = this._compile(gl, gl.VERTEX_SHADER, GL_VERT_SRC);
    const fs = this._compile(gl, gl.FRAGMENT_SHADER, GL_FRAG_SRC);
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

    const vertexData = new Float32Array(MAX_QUADS * GL_VERTS_PER_QUAD * GL_FLOATS_PER_VERT);
    const vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, vertexData.byteLength, gl.STREAM_DRAW);

    const stride = GL_FLOATS_PER_VERT * 4;
    const aPos = gl.getAttribLocation(prog, 'aPos');
    const aUv = gl.getAttribLocation(prog, 'aUv');
    const aAlpha = gl.getAttribLocation(prog, 'aAlpha');
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, stride, 0);
    gl.enableVertexAttribArray(aUv);
    gl.vertexAttribPointer(aUv, 2, gl.FLOAT, false, stride, 8);
    gl.enableVertexAttribArray(aAlpha);
    gl.vertexAttribPointer(aAlpha, 1, gl.FLOAT, false, stride, 16);

    gl.useProgram(prog);
    gl.uniform1i(gl.getUniformLocation(prog, 'uAtlas'), 0);
    const uViewport = gl.getUniformLocation(prog, 'uViewport');

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.disable(gl.DEPTH_TEST);
    gl.clearColor(0, 0, 0, 1);

    this.glState = { gl, prog, vbo, ibo, vertexData, uViewport, contextLost: false };
    this.mode = 'webgl';

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
    if (this.mode === 'webgl') {
      this.glState.gl.viewport(0, 0, w, h);
    }
  }

  render(quads, layout) {
    if (this.mode === 'webgpu') {
      const g = this.gpu;
      const n = Math.min(quads.n, MAX_QUADS);
      const data = g.uniformData;
      data[0] = layout.width;
      data[1] = layout.height;
      for (let i = 0, o = 4; i < n; i++, o += GPU_FLOATS_PER_QUAD) {
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
      g.device.queue.writeBuffer(g.uniformBuf, 0, data, 0, 4 + n * GPU_FLOATS_PER_QUAD);
      g.colorAttachment.view = g.ctx.getCurrentTexture().createView();
      const enc = g.device.createCommandEncoder();
      const pass = enc.beginRenderPass(g.renderPassDesc);
      pass.setPipeline(g.pipeline);
      pass.setBindGroup(0, g.bindGroup);
      pass.draw(4, n);
      pass.end();
      g.device.queue.submit([enc.finish()]);
      return;
    }

    if (this.mode === 'webgl') {
      const s = this.glState;
      if (s.contextLost) return;
      const gl = s.gl;
      const n = Math.min(quads.n, MAX_QUADS);
      const v = s.vertexData;
      let o = 0;
      for (let i = 0; i < n; i++) {
        const x = quads.x[i], y = quads.y[i], w = quads.w[i], h = quads.h[i];
        const u0 = quads.u[i], v0 = quads.v[i], u1 = u0 + quads.uw[i], v1 = v0 + quads.vh[i];
        const a = quads.alpha[i], ang = quads.angle[i];
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
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.uniform2f(s.uViewport, layout.width, layout.height);
      gl.bufferData(gl.ARRAY_BUFFER, v.subarray(0, o), gl.STREAM_DRAW);
      gl.drawElements(gl.TRIANGLES, n * 6, gl.UNSIGNED_SHORT, 0);
      return;
    }

    // Canvas 2D fallback
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
