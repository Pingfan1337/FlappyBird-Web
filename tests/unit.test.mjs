import assert from 'node:assert/strict';
import { OriginalBird, OriginalGame } from '../js/game.js';
import { PresentationClock, ViewLayout, FramePacingStats } from '../js/presentation.js';

// 1. Flight ceiling parity (mirrors FlightCeilingChecks.cpp)
for (const layout of [
  ViewLayout.make(440, 956, 62, 34),
  ViewLayout.make(393, 852, 59, 34),
  ViewLayout.make(320, 568),
  ViewLayout.make(320, 480),
  ViewLayout.make(1920, 1080),
]) {
  const bird = new OriginalBird();
  bird.flapCeiling = layout.flightCeiling();
  bird.y = -1; assert.equal(bird.flap(), true);
  bird.y = bird.flapCeiling; assert.equal(bird.flap(), true);
  assert.ok(bird.y + layout.offsetY + OriginalBird.maxSpriteBottom <= 0);
  bird.tick();
  assert.ok(bird.y < bird.flapCeiling);
  let minY = bird.y, steps = 0;
  while (bird.y < bird.flapCeiling && steps < 120) {
    const before = bird.velocity;
    assert.equal(bird.flap(), false);
    assert.equal(bird.velocity, before);
    bird.tick();
    minY = Math.min(minY, bird.y);
    steps++;
  }
  assert.ok(steps < 120 && bird.y >= bird.flapCeiling);
  assert.ok(minY >= bird.flapCeiling - OriginalBird.upperFlightMargin);
  assert.equal(bird.flap(), true);
}

// 2. PresentationClock fixed 60Hz independence from refresh rate (60Hz / 120Hz / 240Hz)
for (const hz of [60, 120, 144, 240]) {
  const clock = new PresentationClock();
  let ticks = 0;
  let t = 10;
  for (let f = 0; f < hz * 2; f++) {
    if (f > 0) t += 1 / hz;
    ticks += clock.advance(t);
    const b = clock.blend();
    assert.ok(b >= 0 && b <= 1);
  }
  // Initial primed frame + 2s * 60 ticks (~121)
  assert.ok(Math.abs(ticks - 121) <= 2, `Expected ~121 ticks at ${hz}Hz, got ${ticks}`);
}

// 2b. Quantized 60Hz (1ms-rounded rAF like iOS Safari) locks cleanly 1:1 with zero 0/2-tick stutter
{
  const qClock = new PresentationClock();
  let t = 10;
  qClock.advance(t);
  const intervals = [0.016, 0.017, 0.017, 0.016, 0.017, 0.017];
  for (let i = 0; i < 60; i++) {
    t += intervals[i % intervals.length];
    const ticks = qClock.advance(t);
    if (i >= 12) {
      assert.equal(ticks, 1, `Expected 1 tick under 60Hz quantized rAF at frame ${i}`);
      assert.equal(qClock.blend(), 0, `Expected continuous blend=0 under 60Hz lock at frame ${i}`);
    }
  }
}

// 2c. Jittery 120Hz rAF (7ms..10ms callbacks) PLL locks cleanly to exact 1/120s steps
{
  const hClock = new PresentationClock();
  let t = 10;
  hClock.advance(t);
  const jitter120 = [0.008, 0.009, 0.007, 0.010, 0.007, 0.009];
  for (let i = 0; i < 60; i++) {
    t += jitter120[i % jitter120.length];
    const ticks = hClock.advance(t);
    if (i >= 12) {
      const b = hClock.blend();
      assert.ok(ticks === 0 || ticks === 1, `120Hz ticks should be 0 or 1, got ${ticks}`);
      assert.ok(Math.abs(b - 0.5) < 1e-3 || b < 1e-3, `120Hz blend should lock to 0.0 or 0.5, got ${b}`);
    }
  }
}

// 3. FramePacingStats P99 calculation
const stats = new FramePacingStats();
for (let i = 1; i <= 100; i++) stats.presented(i * (1 / 120)); // 99 intervals at 8.33ms
stats.presented(100 * (1 / 120) + 0.025); // outlier #1
stats.presented(100 * (1 / 120) + 0.050); // outlier #2 -> 101 intervals, index trunc(100*99/100)=99
const snap = stats.take();
assert.equal(snap.frames, 102);
assert.ok(Math.abs(snap.p99Milliseconds - 25) < 0.01);

// 4. Sub-16ms click/tap latch triggers Play button reliably
const g = new OriginalGame();
g.initialize(0);
for (let i = 0; i < 32; i++) g.step(); // finish intro fade
assert.equal(g.menu, true);
// Simulate sub-frame tap: touchDown + touchUp both before step()
g.touchX = g.buttons[0].x + 10;
g.touchY = g.buttons[0].y + 10;
g.touching = true;
g.touchLatch = true;
g.touching = false;
g.step(); // sees latch -> held=true
assert.equal(g.buttons[0].held, true);
g.step(); // latch cleared -> released=true -> beginFade(5)
assert.equal(g.buttons[0].released, true);
assert.equal(g.fade.done, false);

// 5. Standalone deterministic golden replay (verifies exact binary32/integer math on any OS/CI)
const rg = new OriginalGame();
rg.bird.flapCeiling = ViewLayout.make(393, 852, 59, 34).flightCeiling();
rg.seed(1234);
rg.rand = () => 0;
rg.initialize(3);
for (let i = 0; i < 40; i++) rg.step();
rg.touchX = 80; rg.touchY = 360; rg.touching = true; rg.step();
rg.touching = false; rg.step();
for (let i = 0; i < 35; i++) rg.step();
rg.touchBegin();
let peakScore = 0;
for (let i = 0; i < 900; i++) {
  if (rg.speed > 0 && !rg.bird.hit) {
    let goal = 216;
    for (let p = 0; p < 3; p++) if (rg.pipeX[p] + 52 >= rg.bird.x) { goal = rg.pipeY[p] - 58; break; }
    if (i < 550 && rg.bird.y >= goal + 15 && rg.bird.velocity >= 0) rg.flap();
  }
  rg.step();
  peakScore = Math.max(peakScore, rg.score);
}
assert.equal(peakScore, 5);
assert.equal(rg.best, 5);
assert.equal(rg.panelMode, 2);
assert.equal(rg.isNew, true);
assert.equal(rg.bird.x, 80);
assert.equal(rg.bird.y, 380);

console.log('Unit checks passed: flight ceiling, 60/120/144/240Hz clock, P99 stats, sub-frame tap latch, golden replay.');
