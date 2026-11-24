// Low-latency Web Audio backend matching src/App/AudioBackend.hpp:
// - Pre-fetches & pre-decodes all 5 PCM WAV assets once at startup
// - Uses 3 interrupting channels matching AVAudioPlayerNodeBufferInterrupts:
//     ch 0: event 9 (point, gain 0.2) & event 12 (hit, gain 1.0)
//     ch 1: event 10 (swooshing, gain 1.0)
//     ch 2: event 11 (die, gain 1.0) & event 13 (wing, gain 1.0)
// - Persists mute state and safely handles Safari/iOS/Chrome autoplay policies.

const EVENT_FILES = {
  9:  'assets/sfx_point.wav',
  10: 'assets/sfx_swooshing.wav',
  11: 'assets/sfx_die.wav',
  12: 'assets/sfx_hit.wav',
  13: 'assets/sfx_wing.wav',
};

export class GameAudio {
  constructor(muted = false) {
    this.ctx = null;
    this.master = null;
    this.buffers = new Map();
    this.rawBytes = new Map();
    this.activeSources = [null, null, null];
    this.muted = muted;
    this.loading = null;
    this.ready = false;
  }

  preload() {
    if (this.loading) return this.loading;
    this.loading = Promise.all(
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
    ).then(() => this._decodePending());
    return this.loading;
  }

  _ensureContext() {
    if (this.ctx) return this.ctx;
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return null;
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

  async _decodePending() {
    const ctx = this._ensureContext();
    if (!ctx) return;
    const jobs = [];
    for (const [id, raw] of this.rawBytes) {
      if (this.buffers.has(id)) continue;
      // Copy slice because decodeAudioData detaches the passed ArrayBuffer.
      jobs.push(
        ctx.decodeAudioData(raw.slice(0))
          .then(decoded => { this.buffers.set(id, decoded); })
          .catch(() => {})
      );
    }
    await Promise.all(jobs);
    this.ready = this.buffers.size > 0;
  }

  activate() {
    const ctx = this._ensureContext();
    if (!ctx) return;
    if (ctx.state === 'suspended') {
      ctx.resume().catch(() => {});
    }
    if (this.rawBytes.size > this.buffers.size) {
      this._decodePending();
    }
  }

  pause() {
    if (this.ctx && this.ctx.state === 'running') {
      this.ctx.suspend().catch(() => {});
    }
  }

  setMuted(muted) {
    this.muted = !!muted;
    if (this.master && this.ctx) {
      this.master.gain.setValueAtTime(this.muted ? 0 : 1, this.ctx.currentTime);
    }
  }

  playEvent(event) {
    if (event < 9 || event > 13 || this.muted) return;
    if (!this.ctx || this.ctx.state !== 'running') return;
    const buf = this.buffers.get(event);
    if (!buf) return;

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
    src.start(0);
  }
}
