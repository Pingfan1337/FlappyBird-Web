// Faithful JavaScript port of src/Core/OriginalBird.hpp and OriginalGame.hpp.
//
// The original rules run on integer frames with binary32 (float) arithmetic and
// C-style integer truncation. Every float operation is rounded with Math.fround
// and every int cast uses Math.trunc so the simulation matches the C++ reference
// bit-for-bit (verified by tests/trace.test.mjs against the compiled headers).
//
// Hot paths allocate nothing: draw lists and event queues are preallocated
// typed arrays and sprite names are resolved to integer ids up front.
import { RECT, SPR } from './atlas.js';

const f = Math.fround;
const trunc = Math.trunc;
const F03 = f(0.3), F04 = f(0.4);

// Stable render identities (C++ uses UINT64_MAX and UINT64_MAX-1).
export const BIRD_ENTITY = -1, LAND_ENTITY = -2;

const BIRD = [0, 1, 2].map(c => [0, 1, 2].map(w => SPR[`bird${c}_${w}`]));
const FONT = Array.from({ length: 10 }, (_, d) => SPR[`font_0${48 + d}`]);
const NUM = Array.from({ length: 10 }, (_, d) => SPR[`number_score_0${d}`]);
const MEDAL = [0, 1, 2, 3].map(m => SPR[`medals_${m}`]);
const BUTTON_NAMES = ['button_play', 'button_score', 'button_ok', 'button_menu',
  'button_pause', 'button_resume', 'button_share', 'button_rate'];
const WING_SEQUENCE = [0, 1, 2, 1, 0, 1, 2, 1, 0, 1, 2, 1];
const W = id => RECT[id * 4 + 2], H = id => RECT[id * 4 + 3];

export class Tween {
  constructor() { this.frame = 0; this.frames = 1; this.mode = 0; this.from = 0; this.to = 0; this.value = 0; this.done = true; }
  start(a, b, n, m = 0) { this.from = f(a); this.to = f(b); this.frames = n; this.mode = m; this.frame = 0; this.value = this.from; this.done = false; }
  tick() {
    if (this.done) return;
    ++this.frame;
    if (this.frame === this.frames) { this.done = true; this.value = this.to; return; }
    const progress = f(f(1 / this.frames) * this.frame);
    const t = trunc(f(progress * 100)) / 100;
    let eased = progress;
    if (this.mode === 5) { const u = t - 1; eased = f(u * (u * u) + 1); }
    if (this.mode === 11) { const u = t - 1; eased = f(u * (u * (u * (u * u))) + 1); }
    this.value = f(this.from + f(eased * f(this.to - this.from)));
  }
}

export class Button {
  constructor(sprite) { this.sprite = sprite; this.x = 0; this.y = 0; this.w = 0; this.h = 0; this.shown = false; this.held = false; this.released = false; }
  contains(px, py) { return px > this.x && px < this.x + this.w && py > this.y && py < this.y + this.h; }
  show(a, b) { this.x = a; this.y = b; this.shown = true; this.held = false; this.released = false; }
  update(down) { this.released = this.held && !down; this.held = down; }
}

// Translation of Flappy Bird 1.2 ARMv7 functions 0x108A8, 0x11194, 0x11234, 0x1134C.
export class OriginalBird {
  static width = 20; static height = 20;
  static spriteOffsetX = 14; static spriteOffsetY = 14;
  static maxSpriteBottom = 44; static upperFlightMargin = 64; static floorY = 400;
  constructor() {
    this.x = 80; this.y = 246; this.velocity = 0; this.gravity = 1;
    this.angle = 0; this.angularVelocity = 0; this.angularAcceleration = F04;
    this.hit = false; this.hovering = true; this.hoverPhase = 0; this.hoverOffset = 0;
    this.flapCeiling = 0; // 0 keeps the original policy; the shell sets it from the viewport.
  }
  reset() {
    this.x = 80; this.y = 246; this.velocity = 0; this.gravity = 1;
    this.angle = 0; this.angularAcceleration = F04;
    this.hit = false; this.hovering = true; this.hoverPhase = 0;
  }
  flap() {
    this.hovering = false;
    if (this.y < this.flapCeiling || this.hit) return false;
    this.velocity = -5; this.gravity = F03; this.angularVelocity = -10; this.angularAcceleration = F04;
    return true;
  }
  tick() {
    if (this.hovering) {
      this.hoverPhase += 8;
      if (this.hoverPhase === 360) this.hoverPhase = 0;
      const radians = f(this.hoverPhase * 3.1415926 / 180.0);
      this.hoverOffset = f(f(Math.sin(radians)) * 4);
      return;
    }
    this.hoverOffset = 0;
    this.velocity = Math.min(8, f(this.velocity + this.gravity));
    this.y = trunc(f(this.y + this.velocity));
    if (this.y > OriginalBird.floorY - OriginalBird.height) {
      this.y = OriginalBird.floorY - OriginalBird.height; this.velocity = 0; this.gravity = 0;
    }
    this.angle = f(this.angle + this.angularVelocity);
    this.angularVelocity = f(this.angularVelocity + this.angularAcceleration);
    this.angle = Math.min(90, Math.max(-20, this.angle));
  }
  spriteX() { return this.x - 14; }
  spriteY() { return trunc(f((this.y - 14) + this.hoverOffset)); }
  spriteAngle() { return trunc(this.angle); }
  overlapsPipe(pipeX, pipeTop, pipeHeight = 320) {
    return this.x + 20 >= pipeX && this.x <= pipeX + 52 && this.y + 20 >= pipeTop && this.y <= pipeTop + pipeHeight;
  }
  overlapsPair(pipeX, lowerPipeTop) {
    const upperBottom = lowerPipeTop - 96;
    let upperTop = upperBottom - 320;
    if (this.flapCeiling < 0) upperTop = Math.min(upperTop, this.flapCeiling - OriginalBird.upperFlightMargin);
    return this.overlapsPipe(pipeX, lowerPipeTop) || this.overlapsPipe(pipeX, upperTop, upperBottom - upperTop);
  }
}

// Structure-of-arrays draw snapshot (the C++ std::vector<Draw>).
export class DrawList {
  constructor(cap = 128) {
    this.n = 0; this.cap = cap;
    this.sprite = new Int16Array(cap); this.x = new Int32Array(cap); this.y = new Int32Array(cap);
    this.angle = new Int32Array(cap); this.alpha = new Float32Array(cap); this.entity = new Float64Array(cap);
  }
  push(s, x, y, angle, alpha, entity) {
    if (this.n >= this.cap) return;
    const i = this.n++;
    this.sprite[i] = s; this.x[i] = x; this.y[i] = y; this.angle[i] = angle; this.alpha[i] = alpha; this.entity[i] = entity;
  }
}

export class OriginalGame {
  constructor() {
    this.bird = new OriginalBird();
    this.draws = new DrawList();
    this.previous = new DrawList();          // snapshot before the latest tick
    this.events = new Int32Array(32); this.eventCount = 0;
    this.buttons = BUTTON_NAMES.map(n => new Button(SPR[n]));
    this.menu = true; this.night = false; this.touching = false;
    this.touchX = -999; this.touchY = -999; this.score = 0; this.best = 0; this.colour = 0;
    this.pipeX = [79, 236, 393]; this.pipeY = [274, 274, 274];
    this.pipeEntity = [1, 2, 3]; this.nextPipeEntity = 4;
    this.warmup = 1; this.speed = 2; this.landX = 0;
    this.randomW = 1; this.randomZ = 1;
    this.animationFrame = 0; this.animationClock = 0; this.autoAnimation = true; this.animationDone = false;
    this.readyMode = -1; this.readyAlpha = new Tween();
    this.overMode = -1; this.overY = -1; this.overVelocity = -2; this.overAlpha = new Tween();
    this.panelMode = -1; this.panelY = 504; this.panelScore = 0; this.panelBest = 0; this.medal = -1; this.isNew = false; this.panelTween = new Tween();
    this.fade = new Tween(); this.flash = new Tween(); this.fadeEvent = 0;
    this.shakeFrames = 0; this.shakeX = 0; this.shakeY = 0;
    this.externalBest = 0;
    this.timerTicks = new Int32Array(50); this.timerEvent = new Int32Array(50); this.timerCursor = 0;
    // Shell hook: a keyboard/gamepad "virtual finger" pressing one button, plus
    // 1-tick press latches so sub-16ms trackpad/touch/keyboard taps never drop.
    this.virtualButton = -1; this.virtualHeld = false;
    this.touchLatch = false; this.virtualLatch = false;
    this._digits = new Int8Array(12);
    // std::rand() replacement (injectable for deterministic tests).
    this.rand = () => (Math.random() * 2147483648) | 0;
  }
  seed(time) { this.randomW = (time % 32000) >>> 0; this.randomZ = (time % 65535) >>> 0; }
  random() {
    this.randomZ = (36969 * (this.randomZ & 65535) + (this.randomZ >>> 16)) >>> 0;
    this.randomW = (18000 * (this.randomW & 65535) + (this.randomW >>> 16)) >>> 0;
    let s = (this.randomW + ((this.randomZ << 16) >>> 0)) | 0;
    if (s < 0) s = (0 - s) | 0;
    return s;
  }
  push(e) { if (this.eventCount < 32) this.events[this.eventCount++] = e; }
  draw(id, x, y, alpha = 1, angle = 0, entity = 0) { if (W(id) > 0 && alpha > 0) this.draws.push(id, x, y, angle, alpha, entity); }
  centre(id, y, a = 1) { this.draw(id, trunc((288 - W(id)) / 2), y, a); }
  timer(id, delay) { this.timerEvent[this.timerCursor] = id; this.timerTicks[this.timerCursor] = delay; this.timerCursor = (this.timerCursor + 1) % 50; }
  resetAnimation(automatic) { this.autoAnimation = automatic; this.animationFrame = 0; this.animationClock = 0; this.animationDone = false; }
  resetBird() {
    this.bird.reset();
    const c = this.rand() % 10;
    this.colour = c <= 5 ? 0 : (c <= 7 ? 1 : 2);
    this.resetAnimation(true);
  }
  resetMenu() {
    const b = this.buttons;
    this.night = this.rand() % 10 > 5;
    for (const x of b) x.shown = false;
    b[0].show(trunc((272 - b[0].w - b[1].w) / 2), 340);
    b[1].show(b[0].x + b[0].w + 16, 340);
    b[7].show(trunc((288 - b[7].w) / 2), 270);
    this.readyMode = -1; this.overMode = -1; this.panelMode = -1;
    this.menu = true; this.landX = 0; this.resetBird(); this.speed = 2; this.warmup = 1; this.score = 0;
  }
  initialize(high) {
    this.best = high;
    for (const b of this.buttons) { b.w = W(b.sprite); b.h = H(b.sprite); }
    this.resetMenu(); this.colour = 0; this.fade.start(1, 0, 30, 5); this.fade.tick();
  }
  beginFade(event) { if (this.fade.done) { this.fadeEvent = event; this.fade.start(0, 1, 30, 5); this.fade.tick(); } }
  handle(id) {
    if (id === 6) { this.resetMenu(); this.colour = 0; this.fade.start(1, 0, 30, 5); this.fade.tick(); }
    if (id === 5) {
      this.resetMenu(); this.buttons[0].shown = this.buttons[1].shown = this.buttons[7].shown = false;
      this.menu = false; this.score = 0; this.resetBird(); this.speed = 2; this.warmup = 1;
      this.readyMode = 0; this.readyAlpha.start(0, 1, 30); this.push(7);
      this.fade.start(1, 0, 30, 5); this.fade.tick();
    }
    if (id === 2) { this.externalBest = this.score; this.push(0); this.overMode = 0; this.overAlpha.start(0, 1, 60, 11); this.overY = -1; this.overVelocity = -2; this.push(10); }
    if (id === 3) this.push(11);
    if (id === 4) this.push(13);
  }
  flap() { if (this.bird.flap()) { this.resetAnimation(false); this.timer(4, 5); } }
  touchBegin() {
    if (this.menu || !this.fade.done) return;
    if (this.bird.hovering) {
      if (this.readyMode === 1) { this.readyMode = 2; this.readyAlpha.start(1, 0, 30); this.flap(); }
    } else if (this.speed > 0) this.flap();
  }
  die(pipe) {
    if (this.flash.done) { this.flash.start(1, 0, 60, 11); this.flash.tick(); }
    this.shakeFrames = 30; this.speed = 0; this.push(12);
    if (pipe) { this.bird.hit = true; this.timer(3, 500); }
    this.timer(2, 1000);
  }
  drawScore(number) {
    const digits = this._digits;
    let count = 0, n = number;
    do { digits[count++] = n % 10; n = trunc(n / 10); } while (n > 0);
    let width = 2;
    for (let i = count - 1; i >= 0; i--) width += W(FONT[digits[i]]) - 4;
    let x = 144 - trunc(width / 2);
    for (let i = count - 1; i >= 0; i--) { const id = FONT[digits[i]]; this.draw(id, x, 78); x += W(id) - 4; }
  }
  smallNumber(number, right, y) {
    do { const d = number % 10; number = trunc(number / 10); this.draw(NUM[d], right - 16, y); right -= 16; } while (number > 0);
  }
  // Shell helper: snapshot for interpolation, then run one original 60 Hz frame.
  step() {
    const t = this.previous; this.previous = this.draws; this.draws = t;
    this.frame();
    this.touchLatch = false; this.virtualLatch = false;
  }
  // A game-state discontinuity (resume, restore): disable interpolation for one frame.
  dropHistory() { this.previous.n = 0; }
  // Active, alive gameplay (the only state where pausing is meaningful).
  get playing() { return !this.menu && !this.bird.hovering && this.speed > 0; }
  frame() {
    const bird = this.bird, pipeX = this.pipeX, pipeY = this.pipeY, buttons = this.buttons;
    this.draws.n = 0; this.eventCount = 0;
    for (let i = 0; i < 50; ++i) if (this.timerTicks[i] > 0) { this.timerTicks[i] -= 30; if (this.timerTicks[i] <= 0) this.handle(this.timerEvent[i]); }
    this.draw(this.night ? SPR.bg_night : SPR.bg_day, 0, 0);
    this.landX -= this.speed; if (this.landX < -23) this.landX = 0;
    if (!bird.hovering) {
      for (let i = 0; i < 3; i++) pipeX[i] -= this.speed;
      if (this.speed > 0 && this.warmup <= 0 && (pipeX[0] === bird.x || pipeX[0] === bird.x - 1)) { ++this.score; this.push(9); }
      if (pipeX[0] < -52) {
        const e = this.pipeEntity;
        e[0] = e[1]; e[1] = e[2]; e[2] = this.nextPipeEntity++;
        pipeX[0] = pipeX[1]; pipeY[0] = pipeY[1]; pipeX[1] = pipeX[2]; pipeY[1] = pipeY[2]; pipeX[2] += 157; pipeY[2] = this.random() % 180 + 180;
        if (this.warmup > 0 && --this.warmup === 0) pipeX[0] = pipeX[1] = -52;
      }
    }
    if (!this.animationDone) {
      this.animationClock += 15; const period = this.autoAnimation ? 100 : 33;
      if (this.animationClock >= period) {
        this.animationClock = 0; ++this.animationFrame;
        if (this.animationFrame >= 12) { if (this.autoAnimation) this.animationFrame = 0; else this.animationDone = true; }
      }
    }
    bird.tick();
    if (this.menu) {
      this.centre(SPR.title, 150);
      bird.x = trunc((288 - 20) / 2); bird.y = H(SPR.title) + 170;
    } else {
      if (bird.y >= 380 && this.speed > 0) this.die(false);
      if (!bird.hit && this.warmup <= 0 && this.speed > 0) {
        for (let i = 0; i < 2; ++i) if (bird.overlapsPair(pipeX[i], pipeY[i])) { this.die(true); break; }
      }
      if (this.warmup <= 0) for (let i = 0; i < 3; ++i) {
        this.draw(SPR.pipe_up, pipeX[i], pipeY[i], 1, 0, this.pipeEntity[i] * 2);
        this.draw(SPR.pipe_down, pipeX[i], pipeY[i] - 416, 1, 0, this.pipeEntity[i] * 2 + 1);
      }
      if (this.panelMode === 2 && !buttons[0].shown) {
        buttons[0].show(trunc((272 - buttons[0].w - buttons[1].w) / 2), 340);
        buttons[1].show(buttons[0].x + buttons[0].w + 16, 340);
      }
      if (this.overMode >= 0) {
        this.overAlpha.tick();
        if (this.overY <= -1) { this.overY = trunc(f(this.overY + this.overVelocity)); this.overVelocity = f(this.overVelocity + 0.25); } else this.overY = 0;
        if (this.overMode === 0 && this.overAlpha.done) { this.overMode = 1; this.showPanel(); this.push(10); }
        else if (this.overMode === 1 && this.panelMode === 2) this.overMode = 2;
        this.centre(SPR.text_game_over, this.overY + 130, this.overAlpha.value);
      } else this.drawScore(this.score);
    }
    const wing = this.animationDone ? 1 : WING_SEQUENCE[this.animationFrame];
    this.draw(BIRD[this.colour][wing], bird.spriteX(), bird.spriteY(), 1, bird.spriteAngle(), BIRD_ENTITY);
    this.draw(SPR.land, this.landX, 400, 1, 0, LAND_ENTITY);
    if (this.readyMode >= 0) {
      this.readyAlpha.tick();
      if (this.readyAlpha.done) { if (this.readyMode === 0) this.readyMode = 1; else if (this.readyMode === 2) this.readyMode = -1; }
      if (this.readyMode >= 0) { this.centre(SPR.text_ready, 146, this.readyAlpha.value); this.centre(SPR.tutorial, 220, this.readyAlpha.value); }
    }
    if (this.menu) this.centre(SPR.brand_copyright, 432 - H(SPR.brand_copyright));
    for (let i = 0; i < 8; i++) {
      const b = buttons[i];
      if (!b.shown) continue;
      const pointerDown = (this.touching || this.touchLatch) && b.contains(this.touchX, this.touchY);
      const virtualDown = (this.virtualHeld || this.virtualLatch) && this.virtualButton === i;
      b.update(pointerDown || virtualDown);
      this.draw(b.sprite, b.x, b.y + (b.held ? 2 : 0));
    }
    if (buttons[0].shown && buttons[0].released) { this.beginFade(5); this.push(10); }
    if (buttons[1].shown && buttons[1].released) { this.push(1); this.push(10); }
    if (buttons[7].shown && buttons[7].released) this.push(2);
    this.updatePanel();
    const fade = this.fade;
    if (!fade.done || fade.value !== 0) { fade.tick(); if (fade.done && fade.value === 1) this.handle(this.fadeEvent); }
    if (this.shakeFrames > 0) { --this.shakeFrames; this.shakeX = this.random() % 8 - 4; this.shakeY = this.random() % 8 - 4; } else this.shakeX = this.shakeY = 0;
    if (!this.flash.done) this.flash.tick();
    if (fade.value > 0) this.draw(SPR.black, 0, 0, fade.value);
    if (this.flash.value > 0) this.draw(SPR.white, 0, 0, this.flash.value);
  }
  showPanel() { this.panelMode = 0; this.panelY = 504; this.panelScore = 0; this.panelBest = this.best; this.medal = -1; this.isNew = false; this.panelTween.start(504, 193, 30, 11); }
  updatePanel() {
    if (this.panelMode < 0) return;
    const t = this.panelTween;
    t.tick();
    if (this.panelMode === 0) {
      this.panelY = trunc(t.value);
      if (t.done) { if (this.score < 1) this.panelMode = 2; else { this.panelMode = 1; t.start(0, this.score, 30); } }
    } else if (this.panelMode === 1) {
      this.panelScore = trunc(t.value);
      if (t.done) {
        this.panelMode = 2;
        if (this.panelScore > this.panelBest) { this.panelBest = this.panelScore; this.best = this.panelScore; this.isNew = true; }
        const s = this.score;
        this.medal = s >= 40 ? 0 : s >= 30 ? 1 : s >= 20 ? 2 : s >= 10 ? 3 : -1;
      }
    }
    const x = 25;
    this.draw(SPR.score_panel, x, this.panelY);
    this.smallNumber(this.panelScore, x + 210, this.panelY + 36);
    this.smallNumber(this.panelBest, x + 210, this.panelY + 78);
    if (this.isNew) this.draw(SPR.new, x + 142, this.panelY + 60);
    if (this.medal >= 0) this.draw(MEDAL[this.medal], x + 32, this.panelY + 44);
  }
}
