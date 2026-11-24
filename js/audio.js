// Low-latency Web Audio backend matching src/App/AudioBackend.hpp:
// - Pre-fetches all 5 PCM WAV assets into memory at boot (without creating AudioContext early)
// - Creates/unlocks AudioContext synchronously inside user gesture (touchstart/touchend/mousedown/click/keydown)
// - Unlocks via silent WebAudio buffer + iOS audioSession='playback' + silent HTMLAudio fallback
//   so iOS Safari, Android Chrome, and in-app WebViews play even if the iPhone silent switch is on
// - Uses 3 interrupting channels matching AVAudioPlayerNodeBufferInterrupts:
//     ch 0: event 9 (point, gain 0.2) & event 12 (hit, gain 1.0)
//     ch 1: event 10 (swooshing, gain 1.0)
//     ch 2: event 11 (die, gain 1.0) & event 13 (wing, gain 1.0)

const EVENT_FILES = {
  9:  'assets/sfx_point.wav',
  10: 'assets/sfx_swooshing.wav',
  11: 'assets/sfx_die.wav',
  12: 'assets/sfx_hit.wav',
  13: 'assets/sfx_wing.wav',
};

// Valid 1-sample (0x0000) 44.1kHz 16-bit mono silent WAV for iOS WebView audio-session unlock.
const SILENT_WAV_URI = 'data:audio/wav;base64,UklGRiYAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQIAAAAAAA==';

export class GameAudio {
  constructor(muted = false) {
    this.ctx = null;
    this.master = null;
    this.buffers = new Map();
    this.rawBytes = new Map();
    this.activeSources = [null, null, null];
    this.muted = muted;
    this.fetchPromise = null;
    this.decodePromise = null;
    this.unlocked = false;
    this.htmlUnlocked = false;
  }

  preload() {
    if (this.fetchPromise) return this.fetchPromise;
    this.fetchPromise = Promise.all(
      Object.entries(EVENT_FILES).map(async ([id, url]) => {
        try {
          const res = await fetch(url);
          if (!res.ok) return;
          const buf = await res.arrayBuffer();
          this.rawBytes.set(Number(id), buf);
        } catch {
          // Offline / missing asset shouldn't crash gameplay.
        }
      })
    ).then(() => {
      if (this.ctx) return this._decodePending();
    });
    return this.fetchPromise;
  }

  _setAudioSession(type) {
    try {
      if ('audioSession' in navigator && navigator.audioSession) {
        navigator.audioSession.type = type;
      }
    } catch {}
  }

  _ensureContext() {
    if (this.ctx) return this.ctx;
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return null;
    this._setAudioSession(this.muted ? 'ambient' : 'playback');
    try {
      this.ctx = new AudioCtx({ latencyHint: 'interactive' });
    } catch {
      this.ctx = new AudioCtx();
    }
    this.master = this.ctx.createGain();
    this.master.gain.value = this.muted ? 0 : 1;
    this.master.connect(this.ctx.destination);
    return this.ctx;
  }

  _decodeBuffer(ctx, arrayBuffer) {
    // Support both Promise and legacy callback-style Safari decodeAudioData.
    return new Promise((resolve, reject) => {
      const p = ctx.decodeAudioData(arrayBuffer, resolve, reject);
      if (p && typeof p.then === 'function') p.then(resolve, reject);
    });
  }

  async _decodePending() {
    const ctx = this._ensureContext();
    if (!ctx || this.rawBytes.size === 0) return;
    const jobs = [];
    for (const [id, raw] of this.rawBytes) {
      if (this.buffers.has(id)) continue;
      // Copy slice because decodeAudioData detaches the passed ArrayBuffer.
      jobs.push(
        this._decodeBuffer(ctx, raw.slice(0))
          .then(decoded => { this.buffers.set(id, decoded); })
          .catch(() => {})
      );
    }
    if (jobs.length) {
      this.decodePromise = Promise.all(jobs);
      await this.decodePromise;
    }
  }

  _playSilentUnlock(ctx) {
    if (!this.unlocked) {
      try {
        const buf = ctx.createBuffer(1, 1, 22050);
        const src = ctx.createBufferSource();
        src.buffer = buf;
        src.connect(ctx.destination);
        src.start(0);
        this.unlocked = true;
      } catch {}
    }
    if (!this.htmlUnlocked && !this.muted) {
      this.htmlUnlocked = true;
      try {
        const a = new Audio(SILENT_WAV_URI);
        a.setAttribute('playsinline', '');
        const p = a.play();
        if (p && typeof p.catch === 'function') p.catch(() => {});
      } catch {}
    }
  }

  // Must be called synchronously inside a user gesture (touchstart/touchend/mousedown/click/keydown)
  // to reliably unlock Web Audio on iOS Safari and mobile WebViews.
  activate() {
    const ctx = this._ensureContext();
    if (!ctx) return;
    this._setAudioSession(this.muted ? 'ambient' : 'playback');
    this._playSilentUnlock(ctx);
    if (ctx.state !== 'running') {
      ctx.resume().catch(() => {});
    }
    if (this.rawBytes.size > this.buffers.size) {
      this._decodePending();
    } else if (this.fetchPromise && this.buffers.size === 0) {
      this.fetchPromise.then(() => this._decodePending());
    }
  }

  pause() {
    if (this.ctx && this.ctx.state === 'running') {
      this.ctx.suspend().catch(() => {});
    }
  }

  setMuted(muted) {
    this.muted = !!muted;
    this._setAudioSession(this.muted ? 'ambient' : 'playback');
    if (this.master && this.ctx) {
      this.master.gain.setValueAtTime(this.muted ? 0 : 1, this.ctx.currentTime);
    }
  }

  playEvent(event) {
    if (event < 9 || event > 13 || this.muted) return;
    const ctx = this.ctx;
    if (!ctx) return;

    const startPlayback = () => {
      const buf = this.buffers.get(event);
      if (!buf || !this.ctx) return;
      const channel = (event === 9 || event === 12) ? 0 : event === 10 ? 1 : 2;
      const prev = this.activeSources[channel];
      if (prev) {
        try { prev.stop(); } catch {}
        this.activeSources[channel] = null;
      }
      const src = this.ctx.createBufferSource();
      src.buffer = buf;
      if (event === 9) {
        const g = this.ctx.createGain();
        g.gain.value = 0.2;
        src.connect(g);
        g.connect(this.master);
      } else {
        src.connect(this.master);
      }
      this.activeSources[channel] = src;
      src.onended = () => {
        if (this.activeSources[channel] === src) this.activeSources[channel] = null;
      };
      try { src.start(0); } catch {}
    };

    if (ctx.state !== 'running') {
      ctx.resume().then(() => {
        if (this.buffers.has(event)) startPlayback();
        else this._decodePending().then(startPlayback);
      }).catch(() => {});
      return;
    }

    if (this.buffers.has(event)) {
      startPlayback();
    } else {
      this._decodePending().then(startPlayback);
    }
  }
}
