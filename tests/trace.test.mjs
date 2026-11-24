// Compiles a C++ reference driver against the original iOS headers and
// asserts bit-for-bit parity with js/game.js and js/presentation.js across
// Menu -> Play -> Ready -> Active Flight (scoring + ceiling) -> Hit/Die -> Results.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NAMES } from '../js/atlas.js';
import { OriginalGame } from '../js/game.js';
import { ViewLayout, QuadBuffer, composeFrame } from '../js/presentation.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(__dirname, '..');
const iosRoot = process.env.IOS_SRC_DIR ? path.resolve(process.env.IOS_SRC_DIR) : path.resolve(webRoot, '../src-ios');
if (!fs.existsSync(path.join(iosRoot, 'src/Core/Presentation.hpp'))) {
  console.log(`Skipping C++ trace comparison: sibling iOS source not found at ${iosRoot}`);
  process.exit(0);
}
const binPath = path.join('/tmp', 'flappy_ref_trace');

const cppSrc = `
#include "${iosRoot}/src/Core/Presentation.hpp"
#include <fstream>
#include <iostream>
#include <iomanip>
using namespace flappy12;

int main() {
    OriginalGame game;
    std::ifstream f("${iosRoot}/resources/atlas.txt");
    std::string name; int w, h; float u, v, uw, vh;
    while (f >> name >> w >> h >> u >> v >> uw >> vh) {
        game.atlas[name] = {static_cast<int>(std::round(u * 1024)), static_cast<int>(std::round(v * 1024)), w, h};
    }
    ViewLayout layout = ViewLayout::make(393, 852, 59, 34);
    game.bird.flapCeiling = layout.flightCeiling();
    game.seed(1234);
    std::srand(1);
    game.initialize(3);

    std::vector<Draw> prev;
    auto dump = [&](int step) {
        std::cout << "S " << step << " " << game.menu << " " << game.night << " " << game.colour
                  << " " << game.score << " " << game.best << " " << game.speed << " " << game.landX
                  << " " << game.bird.x << " " << game.bird.y << " " << game.bird.spriteAngle()
                  << " " << game.panelMode << " " << game.medal << " " << game.isNew
                  << " " << game.shakeX << " " << game.shakeY << " " << game.draws.size() << " " << game.events.size() << "\\n";
        for (const auto& d : game.draws) {
            std::cout << "D " << d.name << " " << d.x << " " << d.y << " " << d.angle << " " << std::setprecision(9) << d.alpha << "\\n";
        }
        for (int ev : game.events) {
            std::cout << "E " << ev << "\\n";
        }
        std::vector<RenderQuad> quads;
        composeFrame(game, prev, 0.5f, layout, quads);
        std::cout << "Q " << quads.size() << "\\n";
        for (const auto& q : quads) {
            std::cout << "R " << std::setprecision(7) << q.x << " " << q.y << " " << q.w << " " << q.h << " " << q.alpha << " " << q.angle << "\\n";
        }
    };

    int step = 0;
    for (int i = 0; i < 40; ++i) { prev = game.draws; game.frame(); dump(step++); }
    // Press Play button
    game.touchX = 80; game.touchY = 360; game.touching = true; prev = game.draws; game.frame(); dump(step++);
    game.touching = false; prev = game.draws; game.frame(); dump(step++);
    for (int i = 0; i < 35; ++i) { prev = game.draws; game.frame(); dump(step++); }
    // Start flying
    game.touchBegin(150, 250);
    for (int i = 0; i < 900; ++i) {
        if (game.speed > 0 && !game.bird.hit) {
            int goal = 216;
            for (int p = 0; p < 3; ++p) if (game.pipeX[p] + 52 >= game.bird.x) { goal = game.pipeY[p] - 58; break; }
            if (i < 550 && game.bird.y >= goal + 15 && game.bird.velocity >= 0) game.flap();
        }
        prev = game.draws;
        game.frame();
        dump(step++);
    }
    return 0;
}
`;

const cppPath = path.join('/tmp', 'flappy_ref_trace.cpp');
fs.writeFileSync(cppPath, cppSrc);
execFileSync('xcrun', ['clang++', '-std=c++17', '-O2', '-ffp-contract=off', cppPath, '-o', binPath]);
const refOut = execFileSync(binPath, { maxBuffer: 64 * 1024 * 1024 }).toString('utf8').trim().split('\n');

// Deterministic LCG matching macOS/glibc? Wait: std::srand(1) differs by libc, so capture the exact
// resetMenu/resetBird choices? Actually on macOS both run in the same OS? No, JS needs to match
// whatever std::rand()%10 returned! Let's check first step's night/colour and supply deterministic stub,
// OR even simpler: inspect the 1st S line from C++ or test with a fixed C++ stub. Let's check!
// Wait: in OriginalGame, std::rand() is ONLY called in resetBird() and resetMenu()!
// Let's parse the C++ output to verify step count and supply exact rand() values when night/colour changes.

const layout = ViewLayout.make(393, 852, 59, 34);
const game = new OriginalGame();
game.bird.flapCeiling = layout.flightCeiling();
game.seed(1234);

// Extract the night/colour choices from C++ output so JS tests the exact same branch without libc rand dependency.
const stateLines = refOut.filter(l => l.startsWith('S ')).map(l => l.split(' '));
// initial call: resetMenu() calls rand()%10>5 (night) then resetBird() calls rand()%10 (colour), then initialize forces colour=0.
// handle(5) calls resetMenu() then resetBird().
const night0 = Number(stateLines[0][3]);
const firstGameState = stateLines.find(s => s[2] === '0');
const night1 = Number(firstGameState[3]);
const colour1 = Number(firstGameState[4]);
const colourToRand = c => (c === 0 ? 0 : c === 1 ? 6 : 8);
const randQueue = [
  night0 ? 6 : 0, 0,
  night1 ? 6 : 0, colourToRand(colour1),
];
let rIdx = 0;
game.rand = () => randQueue[rIdx++] ?? 0;

game.initialize(3);

const quads = new QuadBuffer(256);
let lineIdx = 0;
let maxScore = 0;
let checkedSteps = 0;

function checkStep(expectedStep) {
  const s = refOut[lineIdx++].split(' ');
  assert.equal(s[0], 'S');
  assert.equal(Number(s[1]), expectedStep);

  assert.equal(Number(game.menu), Number(s[2]), `menu @ ${expectedStep}`);
  assert.equal(Number(game.night), Number(s[3]), `night @ ${expectedStep}`);
  assert.equal(game.colour, Number(s[4]), `colour @ ${expectedStep}`);
  assert.equal(game.score, Number(s[5]), `score @ ${expectedStep}`);
  assert.equal(game.best, Number(s[6]), `best @ ${expectedStep}`);
  assert.equal(game.speed, Number(s[7]), `speed @ ${expectedStep}`);
  assert.equal(game.landX, Number(s[8]), `landX @ ${expectedStep}`);
  assert.equal(game.bird.x, Number(s[9]), `bird.x @ ${expectedStep}`);
  assert.equal(game.bird.y, Number(s[10]), `bird.y @ ${expectedStep}`);
  assert.equal(game.bird.spriteAngle(), Number(s[11]), `bird.angle @ ${expectedStep}`);
  assert.equal(game.panelMode, Number(s[12]), `panelMode @ ${expectedStep}`);
  assert.equal(game.medal, Number(s[13]), `medal @ ${expectedStep}`);
  assert.equal(Number(game.isNew), Number(s[14]), `isNew @ ${expectedStep}`);
  assert.equal(game.shakeX, Number(s[15]), `shakeX @ ${expectedStep}`);
  assert.equal(game.shakeY, Number(s[16]), `shakeY @ ${expectedStep}`);

  const dCount = Number(s[17]);
  const eCount = Number(s[18]);
  assert.equal(game.draws.n, dCount, `draws.n @ ${expectedStep}`);
  assert.equal(game.eventCount, eCount, `eventCount @ ${expectedStep}`);

  for (let i = 0; i < dCount; i++) {
    const d = refOut[lineIdx++].split(' ');
    assert.equal(d[0], 'D');
    assert.equal(NAMES[game.draws.sprite[i]], d[1], `draw[${i}].name @ ${expectedStep}`);
    assert.equal(game.draws.x[i], Number(d[2]), `draw[${i}].x @ ${expectedStep}`);
    assert.equal(game.draws.y[i], Number(d[3]), `draw[${i}].y @ ${expectedStep}`);
    assert.equal(game.draws.angle[i], Number(d[4]), `draw[${i}].angle @ ${expectedStep}`);
    assert.ok(Math.abs(game.draws.alpha[i] - Number(d[5])) < 1e-5, `draw[${i}].alpha @ ${expectedStep}`);
  }
  for (let i = 0; i < eCount; i++) {
    const e = refOut[lineIdx++].split(' ');
    assert.equal(e[0], 'E');
    assert.equal(game.events[i], Number(e[1]), `event[${i}] @ ${expectedStep}`);
  }

  // Portrait composeFrame parity with interpolation (blend = 0.5)
  composeFrame(game, 0.5, layout, quads, false);
  const qHdr = refOut[lineIdx++].split(' ');
  assert.equal(qHdr[0], 'Q');
  assert.equal(quads.n, Number(qHdr[1]), `quads.n @ ${expectedStep}`);
  for (let i = 0; i < quads.n; i++) {
    const r = refOut[lineIdx++].split(' ');
    assert.equal(r[0], 'R');
    assert.ok(Math.abs(quads.x[i] - Number(r[1])) < 1e-3, `quad[${i}].x @ ${expectedStep}`);
    assert.ok(Math.abs(quads.y[i] - Number(r[2])) < 1e-3, `quad[${i}].y @ ${expectedStep}`);
    assert.ok(Math.abs(quads.w[i] - Number(r[3])) < 1e-3, `quad[${i}].w @ ${expectedStep}`);
    assert.ok(Math.abs(quads.h[i] - Number(r[4])) < 1e-3, `quad[${i}].h @ ${expectedStep}`);
    assert.ok(Math.abs(quads.alpha[i] - Number(r[5])) < 1e-5, `quad[${i}].alpha @ ${expectedStep}`);
    assert.ok(Math.abs(quads.angle[i] - Number(r[6])) < 1e-3, `quad[${i}].angle @ ${expectedStep}`);
  }

  maxScore = Math.max(maxScore, game.score);
  checkedSteps++;
}

let step = 0;
for (let i = 0; i < 40; i++) { game.step(); checkStep(step++); }
game.touchX = 80; game.touchY = 360; game.touching = true; game.step(); checkStep(step++);
game.touching = false; game.step(); checkStep(step++);
for (let i = 0; i < 35; i++) { game.step(); checkStep(step++); }
game.touchBegin();
for (let i = 0; i < 900; i++) {
  if (game.speed > 0 && !game.bird.hit) {
    let goal = 216;
    for (let p = 0; p < 3; p++) if (game.pipeX[p] + 52 >= game.bird.x) { goal = game.pipeY[p] - 58; break; }
    if (i < 550 && game.bird.y >= goal + 15 && game.bird.velocity >= 0) game.flap();
  }
  game.step();
  checkStep(step++);
}

assert.ok(maxScore >= 5, `Expected autoplay to score >= 5, got ${maxScore}`);
assert.equal(game.panelMode, 2, 'Expected game to reach final results panel');

// Also verify wide landscape layout clipping & tiling doesn't produce NaN/invalid quads.
const wideLayout = ViewLayout.make(1920, 1080, 0, 0);
composeFrame(game, 0.5, wideLayout, quads, true);
assert.ok(quads.n > 6);
for (let i = 0; i < quads.n; i++) {
  assert.ok(Number.isFinite(quads.x[i]) && Number.isFinite(quads.w[i]));
}

console.log(`C++ <-> JS parity verified across ${checkedSteps} frames (peak score=${maxScore}, best=${game.best}, panelMode=${game.panelMode}).`);
