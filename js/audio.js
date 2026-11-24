// Pure 100% Web Audio API backend mirroring src/App/AudioBackend.hpp:
// - All 5 SFX are pre-fetched and decoded into memory once
// - 3 interrupting AudioBufferSourceNode channels (zero AVPlayer/HTMLAudio calls in gameplay)
// - On iOS WKWebView (e.g. WeChat) where navigator.audioSession may not override the ringer
//   switch, a single looping silent WAV <audio> opens the hardware Playback session once on
//   first user gesture and is paused whenever muted or backgrounded (zero gameplay stalls).

const EVENT_FILES = {
  9:  'assets/sfx_point.wav',
  10: 'assets/sfx_swooshing.wav',
  11: 'assets/sfx_die.wav',
  12: 'assets/sfx_hit.wav',
  13: 'assets/sfx_wing.wav',
};

const UA = typeof navigator !== 'undefined' ? (navigator.userAgent || '') : '';
const IS_IOS = /iP(hone|ad|od)|Macintosh/i.test(UA) && typeof navigator !== 'undefined' && navigator.maxTouchPoints > 1;
const IS_WECHAT = /MicroMessenger/i.test(UA);

function createSilentLoopUrl() {
  // 0.5s of 8kHz 8-bit unsigned mono silence (0x80 = exact zero amplitude).
  const samples = 4000;
  const buf = new ArrayBuffer(44 + samples);
  const v = new DataView(buf);
  const writeStr = (off, s) => { for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i)); };
  writeStr(0, 'RIFF'); v.setUint32(4, 36 + samples, true); writeStr(8, 'WAVE');
  writeStr(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true);
  v.setUint16(22, 1, true); v.setUint32(24, 8000, true); v.setUint32(28, 8000, true);
  v.setUint16(32, 1, true); v.setUint16(34, 8, true);
  writeStr(36, 'data'); v.setUint32(40, samples, true);
  new Uint8Array(buf, 44).fill(0x80);
  return URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
}

export class GameAudio {
  constructor(muted = false) {
    this.ctx = null;
    this.master = null;
    this.pointGain = null;
    this.buffers = new Map();
    this.rawBytes = new Map();
    this.activeSources = [null, null, null];
    this.muted = muted;
    this.fetchPromise = null;
    this.unlocked = false;
    this.sessionType = '';
    this.silentEl = null;
    this.silentActive = false;

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
          this.rawBytes.set(id, await res.arrayBuffer());
        } catch {}
      })
    ).then(() => {
      if (this.ctx) return this._decodePending();
    });
    return this.fetchPromise;
  }

  _setAudioSession(type) {
    if (this.sessionType === type) return;
    this.sessionType = type;
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
    this.pointGain = this.ctx.createGain();
    this.pointGain.gain.value = 0.2;
    this.pointGain.connect(this.master);
    return this.ctx;
  }

  _startIosSessionKeepalive() {
    if (this.muted || this.silentActive) return;
    // Needed on iOS WKWebView (WeChat) or older iOS without navigator.audioSession so
    // Web Audio bypasses the physical ringer switch without touching <audio> during gameplay.
    if (!IS_WECHAT && (!IS_IOS || ('audioSession' in navigator))) return;
    try {
      if (!this.silentEl) {
        const a = new Audio(createSilentLoopUrl());
        a.loop = true;
        a.setAttribute('playsinline', '');
        a.setAttribute('webkit-playsinline', '');
        this.silentEl = a;
      }
      const p = this.silentEl.play();
      if (p && typeof p.then === 'function') {
        p.then(() => { this.silentActive = true; }).catch(() => {});
      } else {
        this.silentActive = true;
      }
    } catch {}
  }

  _stopIosSessionKeepalive() {
    if (!this.silentEl) return;
    this.silentActive = false;
    try { this.silentEl.pause(); } catch {}
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
    if (jobs.length) await Promise.all(jobs);
  }

  activate() {
    if (this.unlocked && this.ctx && this.ctx.state === 'running' && this.buffers.size >= 5) {
      if (!this.muted && !this.silentActive) this._startIosSessionKeepalive();
      return true;
    }
    const ctx = this._ensureContext();
    if (!ctx) return false;
    this._setAudioSession(this.muted ? 'ambient' : 'playback');
    this._startIosSessionKeepalive();
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
    if (ctx.state !== 'running') {
      ctx.resume().catch(() => {});
    }
    if (this.rawBytes.size > this.buffers.size) {
      this._decodePending();
    } else if (this.fetchPromise && this.buffers.size === 0) {
      this.fetchPromise.then(() => this._decodePending());
    }
    return this.unlocked && ctx.state === 'running' && this.buffers.size >= 5;
  }

  pause() {
    this._stopIosSessionKeepalive();
    if (this.ctx && this.ctx.state === 'running') {
      this.ctx.suspend().catch(() => {});
    }
  }

  setMuted(muted) {
    this.muted = !!muted;
    this._setAudioSession(this.muted ? 'ambient' : 'playback');
    if (this.muted) this._stopIosSessionKeepalive();
    else this._startIosSessionKeepalive();
    if (this.master && this.ctx) {
      this.master.gain.setValueAtTime(this.muted ? 0 : 1, this.ctx.currentTime);
    }
  }

  playEvent(event) {
    if (event < 9 || event > 13 || this.muted) return;
    const ctx = this.ctx;
    if (!ctx) return;

    const buf = this.buffers.get(event);
    if (!buf) {
      this._decodePending();
      return;
    }
    if (ctx.state !== 'running') {
      ctx.resume().catch(() => {});
      return;
    }

    const channel = (event === 9 || event === 12) ? 0 : event === 10 ? 1 : 2;
    const prev = this.activeSources[channel];
    if (prev) {
      try { prev.stop(); } catch {}
    }
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(event === 9 ? this.pointGain : this.master);
    this.activeSources[channel] = src;
    try { src.start(0); } catch {}
  }
}
