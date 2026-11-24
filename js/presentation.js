// Port of src/Core/Presentation.hpp and src/Core/FramePacingStats.hpp.
//
// Fixed 60 Hz simulation with per-entity linear interpolation, full-screen
// adaptive layout (vertical sky/ground extension on portrait, tiled parallax
// sky/ground + clipped playfield on landscape), and P99 frame-pacing stats.
import { RECT, SPR } from './atlas.js';
import { BIRD_ENTITY, LAND_ENTITY } from './game.js';

const W = id => RECT[id * 4 + 2];
const H = id => RECT[id * 4 + 3];
const U = id => RECT[id * 4] / 1024;
const V = id => RECT[id * 4 + 1] / 1024;
const UW = id => RECT[id * 4 + 2] / 1024;
const VH = id => RECT[id * 4 + 3] / 1024;

const STD_RATES = [60, 72, 75, 80, 90, 100, 120, 144, 165, 180, 240];

export class PresentationClock {
  static step = 1 / 60;
  constructor() {
    this.dts = new Float64Array(16);
    this.sorted = new Float64Array(16);
    this.reset();
  }
  reset() {
    this.last = 0;
    this.remainder = 0;
    this.primed = false;
    this.dtCount = 0;
    this.dtCursor = 0;
    this.period = 0;
    this.phaseError = 0;
    this.fastCount = 0;
  }
  _updatePeriod(dt) {
    if (dt >= 0.003 && dt <= 0.035) {
      this.dts[this.dtCursor] = dt;
      this.dtCursor = (this.dtCursor + 1) & 15;
      if (this.dtCount < 16) this.dtCount++;
      // Immediately exit 60Hz lock if high-refresh frames appear (e.g. ProMotion ramping up).
      if (dt < 0.0135) {
        this.fastCount++;
        if (this.fastCount >= 2 && this.period > 0.0135) {
          this.period = dt;
          this.phaseError = 0;
        }
      } else {
        this.fastCount = 0;
      }
    }
    if (this.dtCount < 4) return 0;
    const n = this.dtCount;
    this.sorted.set(this.dts.subarray(0, n));
    this.sorted.subarray(0, n).sort();
    // Ignore isolated dropped frames (>1.45x base) and take median to cancel +/- rAF jitter.
    const baseMin = this.sorted[Math.min(1, n - 1)];
    let singleEnd = n;
    for (let i = 0; i < n; i++) {
      if (this.sorted[i] > baseMin * 1.45) { singleEnd = i; break; }
    }
    const raw = this.sorted[Math.floor((Math.max(1, singleEnd) - 1) * 0.5)];
    let best = raw, bestDiff = 0.0015;
    for (let i = 0; i < STD_RATES.length; i++) {
      const candidate = 1 / STD_RATES[i];
      const diff = Math.abs(raw - candidate);
      if (diff < bestDiff) { bestDiff = diff; best = candidate; }
    }
    if (this.period === 0 && best > 0) {
      this.remainder = Math.round(this.remainder / best) * best;
      this.remainder %= PresentationClock.step;
    }
    this.period = best;
    return best;
  }
  advance(timestampSec) {
    if (!this.primed) { this.primed = true; this.last = timestampSec; return 1; }
    const dt = Math.min(0.1, Math.max(0, timestampSec - this.last));
    this.last = timestampSec;

    // Display-VSync PLL: absorbs rAF callback & 1ms-quantization jitter on 60Hz and 120Hz+
    // displays so interpolation blend advances at an exact uniform cadence.
    const T = this._updatePeriod(dt);
    let stepDt = dt;
    if (T > 0) {
      const vsyncs = Math.max(1, Math.round((dt + this.phaseError) / T));
      stepDt = vsyncs * T;
      this.phaseError += dt - stepDt;
      if (this.phaseError > T) this.phaseError = T;
      else if (this.phaseError < -T) this.phaseError = -T;
    }

    this.remainder += stepDt;
    const ticks = Math.trunc((this.remainder + 1e-9) / PresentationClock.step);
    this.remainder = Math.max(0, this.remainder - ticks * PresentationClock.step);
    return ticks;
  }
  blend() {
    if (this.period > 0 && Math.abs(this.period - PresentationClock.step) < 1e-4 && this.remainder < 1e-4) {
      return 1;
    }
    const b = this.remainder / PresentationClock.step;
    return b < 0 ? 0 : b > 1 ? 1 : b;
  }
}

export class ViewLayout {
  constructor() { this.width = 288; this.height = 512; this.offsetX = 0; this.offsetY = 0; this.scale = 1; }
  static make(pointsWidth, pointsHeight, safeTop = 0, safeBottom = 0) {
    const l = new ViewLayout();
    if (pointsWidth <= 0 || pointsHeight <= 0) return l;
    l.scale = Math.min(pointsWidth / 288, pointsHeight / 512);
    l.width = pointsWidth / l.scale;
    l.height = pointsHeight / l.scale;
    l.offsetX = (l.width - 288) / 2;
    const maxY = Math.max(0, l.height - 512);
    l.offsetY = Math.min(maxY, Math.max(0, (l.height - 512 + (safeTop - safeBottom) / l.scale) / 2));
    return l;
  }
  inputX(x) { return Math.trunc(x / this.scale - this.offsetX); }
  inputY(y) { return Math.trunc(y / this.scale - this.offsetY); }
  flightCeiling() { return -Math.ceil(this.offsetY) - 44; } // OriginalBird::maxSpriteBottom = 44
}

export class FramePacingStats {
  constructor() {
    this.intervals = new Float64Array(256);
    this.sorted = new Float64Array(256);
    this.reset();
  }
  reset() { this.size = 0; this.cursor = 0; this.frames = 0; this.last = 0; }
  presented(timeSec) {
    if (timeSec <= 0 || timeSec <= this.last) return;
    if (this.last > 0 && timeSec - this.last < 0.25) {
      this.intervals[this.cursor] = (timeSec - this.last) * 1000;
      this.cursor = (this.cursor + 1) & 255;
      if (this.size < 256) this.size++;
    }
    this.last = timeSec;
    this.frames++;
  }
  take() {
    const n = this.size, frames = this.frames;
    this.frames = 0;
    if (!n) return { frames, p99Milliseconds: 0 };
    this.sorted.set(this.intervals.subarray(0, n));
    this.sorted.subarray(0, n).sort();
    return { frames, p99Milliseconds: this.sorted[Math.trunc((n - 1) * 99 / 100)] };
  }
}

// Preallocated quad buffer (zero per-frame allocations).
export class QuadBuffer {
  constructor(cap = 256) {
    this.n = 0; this.cap = cap;
    this.x = new Float32Array(cap); this.y = new Float32Array(cap);
    this.w = new Float32Array(cap); this.h = new Float32Array(cap);
    this.u = new Float32Array(cap); this.v = new Float32Array(cap);
    this.uw = new Float32Array(cap); this.vh = new Float32Array(cap);
    this.alpha = new Float32Array(cap); this.angle = new Float32Array(cap);
  }
  push(x, y, w, h, u, v, uw, vh, alpha = 1, angle = 0) {
    if (this.n >= this.cap) return;
    const i = this.n++;
    this.x[i] = x; this.y[i] = y; this.w[i] = w; this.h[i] = h;
    this.u[i] = u; this.v[i] = v; this.uw[i] = uw; this.vh[i] = vh;
    this.alpha[i] = alpha; this.angle[i] = angle;
  }
  pushSprite(id, x, y, w, h, alpha = 1, angle = 0) {
    this.push(x, y, w, h, U(id), V(id), UW(id), VH(id), alpha, angle);
  }
  // Single texel center sample (zero UV span) for solid sky/sand fills.
  pushSolid(tx, ty, x, y, w, h, alpha = 1) {
    this.push(x, y, w, h, (tx + 0.5) / 1024, (ty + 0.5) / 1024, 0, 0, alpha, 0);
  }
}

function findPreviousIndex(old, now, index) {
  const ent = now.entity[index];
  if (ent !== 0) {
    for (let i = 0; i < old.n; i++) if (old.entity[i] === ent) return i;
    return -1;
  }
  const spr = now.sprite[index];
  const isBird = spr >= SPR.bird0_0 && spr <= SPR.bird2_2;
  let occurrence = 0, oldCount = 0, nowCount = 0;
  for (let i = 0; i < now.n; i++) {
    const c = now.sprite[i];
    if (isBird ? (c >= SPR.bird0_0 && c <= SPR.bird2_2) : c === spr) {
      nowCount++;
      if (i < index) occurrence++;
    }
  }
  for (let i = 0; i < old.n; i++) {
    const c = old.sprite[i];
    if (isBird ? (c >= SPR.bird0_0 && c <= SPR.bird2_2) : c === spr) oldCount++;
  }
  if (oldCount !== nowCount) return -1;
  for (let i = 0; i < old.n; i++) {
    const c = old.sprite[i];
    if ((isBird ? (c >= SPR.bird0_0 && c <= SPR.bird2_2) : c === spr) && occurrence-- === 0) return i;
  }
  return -1;
}

// Compose the frame into `out`. Mirrors Presentation.hpp::composeFrame, with
// seamless horizontal tiling of sky/city/ground on wide (landscape) viewports
// and clipping of pipes to the canonical playfield [offsetX, offsetX + 288]
// when the viewport is wider than 288 logical units.
export function composeFrame(game, blend, layout, out, wideMode = true) {
  out.n = 0;
  const old = game.previous, now = game.draws;
  const bgId = game.night ? SPR.bg_night : SPR.bg_day;
  const landId = SPR.land;
  const bgPx = RECT[bgId * 4], bgPy = RECT[bgId * 4 + 1];
  const landPx = RECT[landId * 4], landPy = RECT[landId * 4 + 1];

  // Solid sky & sand overscan (-8..+8 avoids black edges during screen shake).
  out.pushSolid(bgPx + 1, bgPy + 1, -8, -8, layout.width + 16, layout.height + 16, 1);
  const floorY = layout.offsetY + 400;
  out.pushSolid(landPx + 40, landPy + 40, -8, floorY, layout.width + 16, layout.height - floorY + 8, 1);

  const wide = wideMode && layout.width > 288.5;
  const clipL = layout.offsetX;
  const clipR = layout.offsetX + 288;

  for (let i = 0; i < now.n; i++) {
    const spr = now.sprite[i];
    let x = now.x[i], y = now.y[i], angle = now.angle[i], alpha = now.alpha[i];
    const pi = findPreviousIndex(old, now, i);
    if (pi >= 0) {
      let targetX = x;
      if (spr === landId && targetX > old.x[pi]) targetX -= 24;
      if (Math.abs(targetX - old.x[pi]) <= 32 && Math.abs(y - old.y[pi]) <= 32) {
        x = old.x[pi] + (targetX - old.x[pi]) * blend;
        y = old.y[pi] + (y - old.y[pi]) * blend;
        angle = old.angle[pi] + (angle - old.angle[pi]) * blend;
        alpha = old.alpha[pi] + (alpha - old.alpha[pi]) * blend;
      }
    }

    if (spr === SPR.black || spr === SPR.white) {
      out.pushSprite(spr, -8, -8, layout.width + 16, layout.height + 16, alpha, 0);
      continue;
    }

    let sw = W(spr), sh = H(spr);
    let u = U(spr), v = V(spr), uw = UW(spr), vh = VH(spr);

    // Extend upper pipe shaft cleanly when tall portrait viewports reveal above y = -8.
    if (spr === SPR.pipe_down && y + layout.offsetY > -8) {
      const sx = x + layout.offsetX, sy = -8, sH = y + layout.offsetY + 8;
      const shaftVH = 32 / 1024;
      if (wide) pushClipped(out, sx, sy, sw, sH, u, v, uw, shaftVH, alpha, clipL, clipR);
      else out.push(sx, sy, sw, sH, u, v, uw, shaftVH, alpha, 0);
    }

    if (spr === SPR.bg_day || spr === SPR.bg_night) {
      sh = 400; vh = 400 / 1024;
      if (wide) {
        // Tile horizontally across the full viewport; odd tiles mirror UV to avoid seams.
        const pad = 0.5 / 1024;
        const u0 = u + pad, uw0 = uw - 2 * pad;
        const minK = Math.floor((-8 - layout.offsetX) / 288);
        const maxK = Math.ceil((layout.width + 8 - layout.offsetX) / 288) - 1;
        for (let k = minK; k <= maxK; k++) {
          const tx = layout.offsetX + k * 288;
          if ((k & 1) !== 0) out.push(tx, y + layout.offsetY, 288, sh, u0 + uw0, v, -uw0, vh, alpha, 0);
          else out.push(tx, y + layout.offsetY, 288, sh, u0, v, uw0, vh, alpha, 0);
        }
        continue;
      }
    }

    if (spr === landId) {
      const groundY = y + layout.offsetY;
      out.pushSolid(landPx + 40, landPy + 40, -8, groundY, layout.width + 16, layout.height - groundY + 8, alpha);
      sh = 32; vh = 32 / 1024;
      if (wide) {
        // Land pattern has an exact 24px period and 336px total width (14 * 24px).
        // Sampling an interior 288px (12 * 24px) slice avoids atlas-edge transparent bleed under LINEAR filtering.
        const tileW = 288;
        const tileU = u + 24 / 1024;
        const tileUW = tileW / 1024;
        const base = layout.offsetX + x;
        const minK = Math.floor((-8 - base) / tileW);
        const maxK = Math.ceil((layout.width + 8 - base) / tileW) - 1;
        for (let k = minK; k <= maxK; k++) {
          out.push(base + k * tileW, groundY, tileW, sh, tileU, v, tileUW, vh, alpha, 0);
        }
        continue;
      }
    }

    const dx = x + layout.offsetX, dy = y + layout.offsetY;
    if (wide && (spr === SPR.pipe_up || spr === SPR.pipe_down)) {
      pushClipped(out, dx, dy, sw, sh, u, v, uw, vh, alpha, clipL, clipR);
    } else {
      out.push(dx, dy, sw, sh, u, v, uw, vh, alpha, angle);
    }
  }

  // Subtle side framing on wide viewports so the 288-wide pipe playfield reads cleanly
  // while the sky, city skyline, and scrolling ground span edge-to-edge.
  if (wide) {
    const blackPx = RECT[SPR.black * 4], blackPy = RECT[SPR.black * 4 + 1];
    if (clipL > -8) out.pushSolid(blackPx + 1, blackPy + 1, -8, -8, clipL + 8, layout.height + 16, 0.14);
    if (clipR < layout.width + 8) out.pushSolid(blackPx + 1, blackPy + 1, clipR, -8, layout.width + 8 - clipR, layout.height + 16, 0.14);
  }

  const sx = game.shakeX, sy = game.shakeY;
  if (sx !== 0 || sy !== 0) {
    for (let i = 0; i < out.n; i++) { out.x[i] += sx; out.y[i] += sy; }
  }
}

function pushClipped(out, x, y, w, h, u, v, uw, vh, alpha, minX, maxX) {
  const x0 = x < minX ? minX : x;
  const x1 = x + w > maxX ? maxX : x + w;
  if (x1 <= x0) return;
  const u0 = u + ((x0 - x) / w) * uw;
  const u1 = u + ((x1 - x) / w) * uw;
  out.push(x0, y, x1 - x0, h, u0, v, u1 - u0, vh, alpha, 0);
}
