// Procedural audio: engine, gunshots, siren, pickups, explosions. No audio files.

export class AudioSys {
  constructor() { this.ctx = null; this.master = null; this.engine = null; this.siren = null; }

  init() {
    if (this.ctx) return;
    const ctx = (this.ctx = new (window.AudioContext || window.webkitAudioContext)());
    this.master = ctx.createGain();
    this.master.gain.value = 0.5;
    this.master.connect(ctx.destination);

    // --- engine: two detuned saws through a lowpass, pitch follows speed ---
    const eg = ctx.createGain(); eg.gain.value = 0;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 400; lp.Q.value = 2;
    const o1 = ctx.createOscillator(); o1.type = 'sawtooth'; o1.frequency.value = 50;
    const o2 = ctx.createOscillator(); o2.type = 'square'; o2.frequency.value = 25;
    const og2 = ctx.createGain(); og2.gain.value = 0.4;
    o1.connect(lp); o2.connect(og2); og2.connect(lp);
    lp.connect(eg); eg.connect(this.master);
    o1.start(); o2.start();
    this.engine = { o1, o2, lp, gain: eg };

    // --- siren: alternating two-tone ---
    const sg = ctx.createGain(); sg.gain.value = 0;
    const so = ctx.createOscillator(); so.type = 'triangle'; so.frequency.value = 660;
    so.connect(sg); sg.connect(this.master); so.start();
    this.siren = { osc: so, gain: sg, on: false, t: 0 };
  }

  resume() { this.ctx?.resume(); }

  engineUpdate(speed, active, dt) {
    if (!this.engine) return;
    const e = this.engine;
    const target = active ? 0.16 : 0;
    e.gain.gain.value += (target - e.gain.gain.value) * Math.min(1, dt * 6);
    const f = 42 + Math.abs(speed) * 4.4;
    e.o1.frequency.value += (f - e.o1.frequency.value) * Math.min(1, dt * 4);
    e.o2.frequency.value = e.o1.frequency.value / 2;
    e.lp.frequency.value = 300 + Math.abs(speed) * 40;
  }

  sirenUpdate(on, dt) {
    if (!this.siren) return;
    const s = this.siren;
    s.on = on;
    s.gain.gain.value += ((on ? 0.055 : 0) - s.gain.gain.value) * Math.min(1, dt * 4);
    if (on) {
      s.t += dt;
      const hi = Math.floor(s.t / 0.42) % 2 === 0;
      s.osc.frequency.value = hi ? 880 : 660;
    }
  }

  _noiseBurst(dur, freq, q, gain, dist = 0) {
    if (!this.ctx) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const atten = 1 / (1 + dist * 0.08);
    const len = Math.max(1, Math.floor(ctx.sampleRate * dur));
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len) ** 2;
    const src = ctx.createBufferSource(); src.buffer = buf;
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = freq; bp.Q.value = q;
    const g = ctx.createGain(); g.gain.value = gain * atten;
    src.connect(bp); bp.connect(g); g.connect(this.master);
    src.start(t);
  }

  shot(dist = 0) { this._noiseBurst(0.14, 1400, 0.8, 0.5, dist); this._noiseBurst(0.3, 220, 1.2, 0.4, dist); }
  explosion(dist = 0) {
    this._noiseBurst(1.4, 90, 0.5, 1.2, dist);
    this._noiseBurst(0.6, 400, 0.6, 0.8, dist);
  }
  pickup() {
    if (!this.ctx) return;
    const ctx = this.ctx, t = ctx.currentTime;
    [523, 659, 784].forEach((f, i) => {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = 'sine'; o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t + i * 0.07);
      g.gain.exponentialRampToValueAtTime(0.18, t + i * 0.07 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + i * 0.07 + 0.2);
      o.connect(g); g.connect(this.master);
      o.start(t + i * 0.07); o.stop(t + i * 0.07 + 0.25);
    });
  }
  hurt() { this._noiseBurst(0.2, 300, 1, 0.5); }
  crash(intensity, dist = 0) { this._noiseBurst(0.35, 500, 0.7, Math.min(0.7, intensity * 0.1), dist); }
}
