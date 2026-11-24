// Low-latency audio backend matching src/App/AudioBackend.hpp:
// - Pre-fetches all 5 PCM WAV assets once at boot
// - Primary engine: Web Audio API (3 interrupting channels, <5ms latency)
// - Mobile / WeChat WebView fallback: 3-channel in-memory Blob HTMLAudioElement pool
//   (bypasses iOS WKWebView Ambient-category mute and WeChat WebAudio restrictions)
// - Hooks touchstart/touchend/mousedown/click/keydown + WeixinJSBridgeReady

const EVENT_FILES = {
  9:  'assets/sfx_point.wav',
  10: 'assets/sfx_swooshing.wav',
  11: 'assets/sfx_die.wav',
  12: 'assets/sfx_hit.wav',
  13: 'assets/sfx_wing.wav',
};

const SILENT_WAV_URI = 'data:audio/wav;base64,UklGRiYAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQIAAAAAAA==';
const IS_WECHAT = typeof navigator !== 'undefined' && /MicroMessenger/i.test(navigator.userAgent || '');

export class GameAudio {
  constructor(muted = false) {
    this.ctx = null;
    this.master = null;
    this.buffers = new Map();
    this.rawBytes = new Map();
    this.blobUrls = new Map();
    this.htmlPool = new Map();       // event -> HTMLAudioElement
    this.activeSources = [null, null, null];
    this.activeHtml = [null, null, null];
    this.muted = muted;
    this.fetchPromise = null;
    this.decodePromise = null;
    this.unlocked = false;
    this.htmlUnlocked = false;
    this.preferHtml = IS_WECHAT;
    this._sessionType = '';
    this.pointGain = null;

    if (IS_WECHAT && typeof document !== 'undefined') {
      document.addEventListener('WeixinJSBridgeReady', () => {
        try {
          window.WeixinJSBridge?.invoke('getNetworkType', {}, () => this.activate());
        } catch {
          this.activate();
        }
      }, false);
    }
  }

  preload() {
    if (this.fetchPromise) return this.fetchPromise;
    this.fetchPromise = Promise.all(
      Object.entries(EVENT_FILES).map(async ([idStr, url]) => {
        const id = Number(idStr);
        try {
          const res = await fetch(url);
          if (!res.ok) return;
          const buf = await res.arrayBuffer();
          this.rawBytes.set(id, buf);
          this._prepareHtmlElement(id, buf);
        } catch {
          // Offline / missing asset shouldn't crash gameplay.
        }
      })
    ).then(() => {
      if (this.ctx) return this._decodePending();
    });
    return this.fetchPromise;
  }

  _prepareHtmlElement(id, buf) {
    if (this.htmlPool.has(id) || typeof Audio === 'undefined') return;
    try {
      const blobUrl = URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
      this.blobUrls.set(id, blobUrl);
      const el = new Audio(blobUrl);
      el.preload = 'auto';
      el.setAttribute('playsinline', '');
      el.setAttribute('webkit-playsinline', '');
      el.volume = id === 9 ? 0.2 : 1.0;
      el.load();
      this.htmlPool.set(id, el);
    } catch {}
  }

  _setAudioSession(type) {
    if (this._sessionType === type) return;
    this._sessionType = type;
    try {
      if ('audioSession' in navigator && navigator.audioSession) {
        navigator.audioSession.type = type;
      }
    } catch {}
  }

  _ensureContext() {
    if (this.ctx) return this.ctx;
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) {
      this.preferHtml = true;
      return null;
    }
    this._setAudioSession(this.muted ? 'ambient' : 'playback');
    try {
      this.ctx = new AudioCtx({ latencyHint: 'interactive' });
    } catch {
      this.ctx = new AudioCtx();
    }
    this.master = this.ctx.createGain();
    this.master.gain.value = this.muted ? 0 : 1;
    this.master.connect(this.ctx.destination);
    this.pointGain = this.ctx.createGain();
    this.pointGain.gain.value = 0.2;
    this.pointGain.connect(this.master);
    return this.ctx;
  }

  _decodeBuffer(ctx, arrayBuffer) {
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

  _unlockInGesture(ctx) {
    if (ctx && !this.unlocked) {
      try {
        const buf = ctx.createBuffer(1, 1, 22050);
        const src = ctx.createBufferSource();
        src.buffer = buf;
        src.connect(ctx.destination);
        src.start(0);
        this.unlocked = true;
      } catch {}
    }
    if (!this.htmlUnlocked && typeof Audio !== 'undefined') {
      this.htmlUnlocked = true;
      // Unlock HTMLAudio pipeline in WeChat / iOS WKWebView using silent prime.
      if (this.preferHtml && this.htmlPool.size > 0) {
        for (const [id, el] of this.htmlPool) {
          try {
            const targetVol = id === 9 ? 0.2 : 1.0;
            el.muted = true;
            const p = el.play();
            if (p && typeof p.then === 'function') {
              p.then(() => {
                el.pause();
                el.currentTime = 0;
                el.muted = false;
                el.volume = targetVol;
              }).catch(() => { el.muted = false; el.volume = targetVol; });
            }
          } catch {}
        }
      } else {
        try {
          const a = new Audio(SILENT_WAV_URI);
          a.setAttribute('playsinline', '');
          const p = a.play();
          if (p && typeof p.catch === 'function') p.catch(() => {});
        } catch {}
      }
    }
  }

  activate() {
    if (this.unlocked && this.htmlUnlocked && this.ctx && this.ctx.state === 'running' && this.buffers.size >= 5) {
      return;
    }
    const ctx = this._ensureContext();
    this._setAudioSession(this.muted ? 'ambient' : 'playback');
    this._unlockInGesture(ctx);
    if (ctx && ctx.state !== 'running') {
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
    for (let ch = 0; ch < 3; ch++) {
      const el = this.activeHtml[ch];
      if (el) {
        try { el.pause(); } catch {}
      }
    }
  }

  setMuted(muted) {
    this.muted = !!muted;
    this._setAudioSession(this.muted ? 'ambient' : 'playback');
    if (this.master && this.ctx) {
      this.master.gain.setValueAtTime(this.muted ? 0 : 1, this.ctx.currentTime);
    }
    if (this.muted) {
      for (let ch = 0; ch < 3; ch++) {
        const el = this.activeHtml[ch];
        if (el) { try { el.pause(); } catch {} }
      }
    }
  }

  _playHtmlEvent(event) {
    const el = this.htmlPool.get(event);
    if (!el) return;
    const channel = (event === 9 || event === 12) ? 0 : event === 10 ? 1 : 2;
    const prev = this.activeHtml[channel];
    if (prev && prev !== el) {
      try { prev.pause(); prev.currentTime = 0; } catch {}
    }
    this.activeHtml[channel] = el;
    try {
      el.muted = false;
      el.volume = event === 9 ? 0.2 : 1.0;
      el.currentTime = 0;
      const p = el.play();
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch {}
  }

  playEvent(event) {
    if (event < 9 || event > 13 || this.muted) return;

    if (this.preferHtml) {
      this._playHtmlEvent(event);
      return;
    }

    const ctx = this.ctx;
    if (!ctx) {
      this._playHtmlEvent(event);
      return;
    }

    const startPlayback = () => {
      const buf = this.buffers.get(event);
      if (!buf || !this.ctx) {
        this._playHtmlEvent(event);
        return;
      }
      const channel = (event === 9 || event === 12) ? 0 : event === 10 ? 1 : 2;
      const prev = this.activeSources[channel];
      if (prev) {
        try { prev.stop(); } catch {}
        this.activeSources[channel] = null;
      }
      const src = this.ctx.createBufferSource();
      src.buffer = buf;
      src.connect(event === 9 ? this.pointGain : this.master);
      this.activeSources[channel] = src;
      src.onended = () => {
        if (this.activeSources[channel] === src) this.activeSources[channel] = null;
      };
      try { src.start(0); } catch {}
    };

    if (ctx.state !== 'running') {
      ctx.resume().then(() => {
        if (ctx.state !== 'running') {
          this._playHtmlEvent(event);
          return;
        }
        if (this.buffers.has(event)) startPlayback();
        else this._decodePending().then(startPlayback);
      }).catch(() => this._playHtmlEvent(event));
      return;
    }

    if (this.buffers.has(event)) {
      startPlayback();
    } else {
      this._decodePending().then(startPlayback);
    }
  }
}
