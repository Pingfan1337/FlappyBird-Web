// Application shell: asset bootstrap, fixed-step 60 Hz simulation + display-rate
// interpolated rendering, responsive layout, audio, persistence, and HUD/modals.
import { OriginalGame } from './game.js';
import { PresentationClock, ViewLayout, FramePacingStats, QuadBuffer, composeFrame } from './presentation.js';
import { GameRenderer } from './renderer.js';
import { GameAudio } from './audio.js';
import { InputController } from './input.js';

const STORAGE_BEST = 'flappy12_best';
const STORAGE_GAMES = 'flappy12_games';
const STORAGE_MUTED = 'flappy12_muted';
const STORAGE_FPS = 'flappy12_fps';

function storeGet(key, fallback) {
  try { const v = localStorage.getItem(key); return v === null ? fallback : v; } catch { return fallback; }
}
function storeSet(key, val) {
  setTimeout(() => {
    try { localStorage.setItem(key, String(val)); } catch {}
  }, 0);
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Failed to load ${src}`));
    img.src = src;
  });
}

async function boot() {
  const canvas = document.getElementById('game');
  const fpsEl = document.getElementById('fps-badge');
  const btnPause = document.getElementById('btn-pause');
  const btnMute = document.getElementById('btn-mute');
  const btnFps = document.getElementById('btn-fps');
  const pauseOverlay = document.getElementById('pause-overlay');
  const btnResume = document.getElementById('btn-resume');
  const btnRestart = document.getElementById('btn-restart');
  const btnMenu = document.getElementById('btn-menu');
  const hintBar = document.getElementById('hint-bar');
  const modal = document.getElementById('modal');
  const modalTitle = document.getElementById('modal-title');
  const modalBody = document.getElementById('modal-body');
  const modalClose = document.getElementById('modal-close');
  const safeProbe = document.getElementById('safe-probe');

  let muted = storeGet(STORAGE_MUTED, '0') === '1';
  let showFps = storeGet(STORAGE_FPS, '1') === '1';
  let gamesPlayed = Number(storeGet(STORAGE_GAMES, '0')) || 0;
  let paused = false;
  let hintDismissed = false;

  const audio = new GameAudio(muted);
  audio.preload();

  const atlasImg = await loadImage('assets/atlas.png');
  const force2d = new URLSearchParams(location.search).get('renderer') === '2d';
  const renderer = new GameRenderer(canvas, atlasImg, force2d);

  const game = new OriginalGame();
  game.seed((Date.now() % 32000) || 1);
  game.initialize(Number(storeGet(STORAGE_BEST, '0')) || 0);

  const clock = new PresentationClock();
  const pacing = new FramePacingStats();
  const quads = new QuadBuffer(256);
  let layout = new ViewLayout();
  let statsStart = 0;

  let input = null;

  function updateLayout() {
    const rect = canvas.getBoundingClientRect();
    // 2x DPR gives >3x oversampling over the 288x512 pixel-art sprites while cutting
    // iOS GPUProcess IOSurface memory & fragment fill bandwidth by 56% vs 3x DPR.
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const cs = getComputedStyle(safeProbe);
    const safeTop = parseFloat(cs.paddingTop) || 0;
    const safeBottom = parseFloat(cs.paddingBottom) || 0;
    layout = ViewLayout.make(rect.width, rect.height, safeTop, safeBottom);
    game.bird.flapCeiling = layout.flightCeiling();
    renderer.resize(rect.width * dpr, rect.height * dpr);
    input?.setCanvasOrigin(rect.left, rect.top);
  }

  updateLayout();
  if (typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(updateLayout).observe(document.body);
  }
  window.addEventListener('resize', updateLayout, { passive: true });
  window.visualViewport?.addEventListener('resize', updateLayout, { passive: true });

  function syncHud() {
    btnMute.dataset.muted = muted ? '1' : '0';
    btnMute.setAttribute('aria-label', muted ? '取消静音 (M)' : '静音 (M)');
    btnMute.title = muted ? '取消静音 (M)' : '静音 (M)';
    fpsEl.hidden = !showFps;
    btnFps.dataset.active = showFps ? '1' : '0';
    btnPause.hidden = !game.playing && !paused;
    pauseOverlay.hidden = !paused;
  }

  function toggleMute() {
    muted = !muted;
    audio.setMuted(muted);
    storeSet(STORAGE_MUTED, muted ? '1' : '0');
    syncHud();
  }

  function toggleFps() {
    showFps = !showFps;
    storeSet(STORAGE_FPS, showFps ? '1' : '0');
    syncHud();
  }

  function togglePause(force) {
    const next = typeof force === 'boolean' ? force : !paused;
    if (next === paused) return;
    if (next && !game.playing) return;
    paused = next;
    if (paused) {
      game.touching = false;
      game.virtualHeld = false;
      clock.reset();
      pacing.reset();
      statsStart = 0;
      audio.pause();
    } else {
      clock.reset();
      game.dropHistory();
      pacing.reset();
      statsStart = 0;
      audio.activate();
    }
    syncHud();
  }

  function openModal(title, html) {
    modalTitle.textContent = title;
    modalBody.innerHTML = html;
    modal.hidden = false;
  }

  function closeModal() {
    modal.hidden = true;
  }

  function handleGameEvents() {
    for (let i = 0; i < game.eventCount; i++) {
      const ev = game.events[i];
      if (ev >= 9 && ev <= 13) audio.playEvent(ev);
      if (ev === 7) {
        gamesPlayed++;
        storeSet(STORAGE_GAMES, gamesPlayed);
      }
      if (ev === 0) {
        const best = Math.max(game.best, game.score);
        if (best > game.best) game.best = best;
        storeSet(STORAGE_BEST, best);
      }
      if (ev === 1 && modal.hidden) {
        const best = Math.max(game.best, Number(storeGet(STORAGE_BEST, '0')) || 0);
        const medalName = best >= 40 ? '白金奖牌 (40+)' : best >= 30 ? '金牌 (30+)' : best >= 20 ? '银牌 (20+)' : best >= 10 ? '铜牌 (10+)' : '暂无 (10 分起)';
        openModal('本地战绩', `
          <div class="stat-grid">
            <div><span>最高分</span><strong>${best}</strong></div>
            <div><span>总局数</span><strong>${gamesPlayed}</strong></div>
            <div><span>最高奖牌</span><strong>${medalName}</strong></div>
            <div><span>渲染后端</span><strong>${renderer.mode.toUpperCase()} · v10</strong></div>
          </div>
          <p class="modal-note">原版 Game Center 排行榜属于原开发者账号，网页版已在本地浏览器持久保存您的最高分。</p>
        `);
      }
      if (ev === 2 && modal.hidden) {
        openModal('关于 Flappy Bird Web', `
          <p>完整移植自 <a href="https://github.com/Pingfan1337/FlappyBird-arm64-Metal-iOS27" target="_blank" rel="noopener noreferrer">FlappyBird-arm64-Metal-iOS27</a>（1.2 原版重建逻辑 + 60Hz 固定物理步长 + 高刷线性插值）。</p>
          <ul class="controls-list">
            <li><b>键盘</b>：<code>Space</code> / <code>↑</code> / <code>W</code> 振翅与开始，<code>P</code> 暂停，<code>M</code> 静音，<code>F</code> 帧率，<code>R</code> 重开</li>
            <li><b>触屏</b>：任意位置点击振翅；双指双击切换 FPS / P99</li>
            <li><b>鼠标 / 触摸板</b>：左键点击任意位置振翅</li>
          </ul>
          <p class="modal-note">当前版本：v10 · 渲染后端：${renderer.mode.toUpperCase()} · 原版美术、音效与角色版权归 .GEARS / dotGEARS 所有。</p>
        `);
      }
    }
  }

  input = new InputController(canvas, game, () => layout, {
    unlockAudio: () => audio.activate(),
    isPaused: () => paused,
    togglePause,
    toggleMute,
    toggleFps,
    isModalOpen: () => !modal.hidden,
    closeModal,
    onFirstInteract: () => {
      if (!hintDismissed && !game.menu) {
        hintDismissed = true;
        hintBar.classList.add('fade-out');
      }
    },
  });
  { const r = canvas.getBoundingClientRect(); input.setCanvasOrigin(r.left, r.top); }

  btnPause.addEventListener('click', e => { e.stopPropagation(); btnPause.blur(); togglePause(); });
  btnMute.addEventListener('click', e => { e.stopPropagation(); btnMute.blur(); audio.activate(); toggleMute(); });
  btnFps.addEventListener('click', e => { e.stopPropagation(); btnFps.blur(); toggleFps(); });
  fpsEl.addEventListener('click', e => { e.stopPropagation(); toggleFps(); });
  btnResume.addEventListener('click', () => { btnResume.blur(); togglePause(false); });
  btnRestart.addEventListener('click', () => { btnRestart.blur(); paused = false; game.beginFade(5); syncHud(); });
  btnMenu.addEventListener('click', () => { btnMenu.blur(); paused = false; game.beginFade(6); syncHud(); });
  modalClose.addEventListener('click', closeModal);
  modal.addEventListener('click', e => { if (e.target === modal) closeModal(); });

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      if (game.playing && !paused) togglePause(true);
      else { clock.reset(); pacing.reset(); statsStart = 0; audio.pause(); }
    } else if (!paused) {
      clock.reset(); game.dropHistory(); pacing.reset(); statsStart = 0;
      audio.activate();
    }
  });

  syncHud();

  let lastFpsText = '';

  function frame(nowMs) {
    requestAnimationFrame(frame);
    const nowSec = nowMs * 0.001;
    input.pollGamepad();

    if (!paused) {
      const wasPlaying = game.playing;
      const ticks = clock.advance(nowSec);
      for (let i = 0; i < ticks; i++) {
        game.step();
        handleGameEvents();
      }
      if (game.playing !== wasPlaying) {
        syncHud();
        if (!hintDismissed && game.playing) {
          hintDismissed = true;
          hintBar.classList.add('fade-out');
        }
      }
    }

    composeFrame(game, paused ? 0 : clock.blend(), layout, quads, true);
    renderer.render(quads, layout);

    if (showFps) {
      pacing.presented(nowSec);
      if (statsStart === 0) statsStart = nowSec;
      const interval = nowSec - statsStart;
      if (interval >= 1.0) {
        const stats = pacing.take();
        const text = `${Math.round(stats.frames / interval)} FPS | P99 ${stats.p99Milliseconds.toFixed(1)} ms`;
        if (text !== lastFpsText) {
          lastFpsText = text;
          fpsEl.textContent = text;
        }
        statsStart = nowSec;
      }
    }
  }

  requestAnimationFrame(frame);
}

if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' }).then(reg => {
    reg.update().catch(() => {});
  }).catch(() => {});
}

boot().catch(err => {
  console.error(err);
  const el = document.getElementById('fps-badge');
  if (el) { el.hidden = false; el.textContent = 'Load Error'; }
});
