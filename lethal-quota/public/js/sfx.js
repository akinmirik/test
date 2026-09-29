// Procedurally synthesised sound effects (no audio assets needed), optionally positional.

export class Sfx {
  constructor(ctx, output) {
    this.ctx = ctx;
    this.out = ctx.createGain();
    this.out.connect(output);
    const len = ctx.sampleRate * 2;
    this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    this.loops = {};
  }

  // Returns a node to connect sources into; spatial when pos is given.
  dest(pos, vol = 1, ref = 2) {
    const g = this.ctx.createGain();
    g.gain.value = vol;
    if (pos) {
      const p = this.ctx.createPanner();
      p.panningModel = 'HRTF';
      p.distanceModel = 'inverse';
      p.refDistance = ref;
      p.rolloffFactor = 1.3;
      p.maxDistance = 100;
      if (p.positionX) { p.positionX.value = pos.x; p.positionY.value = pos.y; p.positionZ.value = pos.z; }
      else p.setPosition(pos.x, pos.y, pos.z);
      g.connect(p).connect(this.out);
    } else g.connect(this.out);
    return g;
  }

  noiseSrc(dur) {
    const s = this.ctx.createBufferSource();
    s.buffer = this.noise;
    s.loop = true;
    const off = Math.random() * 1.5;
    s.start(this.ctx.currentTime, off);
    s.stop(this.ctx.currentTime + dur + 0.05);
    return s;
  }

  env(g, t, a, peak, dec, end = 0.0001) {
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + a);
    g.gain.exponentialRampToValueAtTime(end, t + a + dec);
  }

  osc(type, freq, dur, out, { a = 0.005, peak = 0.3, slideTo = null, detune = 0 } = {}) {
    const t = this.ctx.currentTime;
    const o = this.ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    o.detune.value = detune;
    if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
    const g = this.ctx.createGain();
    this.env(g, t, a, peak, dur);
    o.connect(g).connect(out);
    o.start(t);
    o.stop(t + a + dur + 0.05);
    return o;
  }

  filteredNoise(dur, out, { type = 'lowpass', freq = 800, q = 1, a = 0.005, peak = 0.3, sweepTo = null } = {}) {
    const t = this.ctx.currentTime;
    const s = this.noiseSrc(dur + a);
    const f = this.ctx.createBiquadFilter();
    f.type = type;
    f.frequency.setValueAtTime(freq, t);
    if (sweepTo) f.frequency.exponentialRampToValueAtTime(sweepTo, t + dur);
    f.Q.value = q;
    const g = this.ctx.createGain();
    this.env(g, t, a, peak, dur);
    s.connect(f).connect(g).connect(out);
  }

  play(name, pos = null, vol = 1) {
    if (this.ctx.state !== 'running') return;
    const o = (ref) => this.dest(pos, vol, ref);
    const R = Math.random;
    switch (name) {
      case 'step': this.filteredNoise(0.07, o(1.5), { freq: 500 + R() * 300, peak: 0.25 }); break;
      case 'stepMetal':
        this.filteredNoise(0.06, o(1.5), { type: 'bandpass', freq: 1800 + R() * 600, q: 3, peak: 0.35 });
        this.osc('triangle', 180 + R() * 40, 0.08, o(1.5), { peak: 0.06 });
        break;
      case 'jump': this.filteredNoise(0.12, o(), { freq: 700, peak: 0.2 }); break;
      case 'land': this.filteredNoise(0.15, o(), { freq: 350, peak: 0.4 }); break;
      case 'pickup': this.osc('square', 900, 0.05, o(), { peak: 0.08 }); this.filteredNoise(0.08, o(), { freq: 2000, type: 'highpass', peak: 0.1 }); break;
      case 'drop': this.filteredNoise(0.18, o(), { freq: 400, peak: 0.35 }); this.osc('sine', 120, 0.12, o(), { peak: 0.2 }); break;
      case 'click': this.osc('square', 1400, 0.02, o(), { peak: 0.1 }); break;
      case 'lever':
        this.filteredNoise(0.25, o(), { freq: 300, peak: 0.6 });
        this.osc('sine', 90, 0.3, o(), { peak: 0.4, slideTo: 60 });
        break;
      case 'door':
        this.filteredNoise(0.9, o(3), { type: 'bandpass', freq: 300, sweepTo: 900, q: 2, a: 0.05, peak: 0.4 });
        this.osc('sawtooth', 55, 0.8, o(3), { peak: 0.05, a: 0.1 });
        break;
      case 'facilityDoor': this.filteredNoise(0.6, o(), { type: 'bandpass', freq: 200, sweepTo: 600, q: 1.5, a: 0.03, peak: 0.5 }); break;
      case 'sell': this.osc('sine', 880, 0.3, o(), { peak: 0.25 }); setTimeout(() => this.osc('sine', 1320, 0.5, o(), { peak: 0.25 }), 120); break;
      case 'buy': this.osc('square', 660, 0.08, o(), { peak: 0.08 }); setTimeout(() => this.osc('square', 990, 0.12, o(), { peak: 0.08 }), 90); break;
      case 'scan':
        this.osc('sine', 300, 0.5, o(), { peak: 0.2, slideTo: 1400 });
        this.osc('sine', 305, 0.5, o(), { peak: 0.1, slideTo: 1420 });
        break;
      case 'hurt':
        this.filteredNoise(0.25, o(), { freq: 900, peak: 0.6 });
        this.osc('sine', 110, 0.25, o(), { peak: 0.5, slideTo: 60 });
        break;
      case 'death':
        this.filteredNoise(0.6, o(), { freq: 1200, sweepTo: 200, peak: 0.9 });
        this.osc('sawtooth', 70, 0.6, o(), { peak: 0.4, slideTo: 30 });
        break;
      case 'swing': this.filteredNoise(0.25, o(), { type: 'bandpass', freq: 600, sweepTo: 2400, q: 1, a: 0.08, peak: 0.35 }); break;
      case 'hit':
        this.filteredNoise(0.15, o(), { freq: 600, peak: 0.8 });
        this.osc('square', 140, 0.1, o(), { peak: 0.25, slideTo: 80 });
        break;
      case 'boing': {
        const t = this.ctx.currentTime;
        const osc = this.ctx.createOscillator();
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(420, t);
        const lfo = this.ctx.createOscillator();
        lfo.frequency.value = 22;
        const lfoG = this.ctx.createGain();
        lfoG.gain.setValueAtTime(160, t);
        lfoG.gain.exponentialRampToValueAtTime(1, t + 0.9);
        lfo.connect(lfoG).connect(osc.frequency);
        const g = this.ctx.createGain();
        this.env(g, t, 0.005, 0.45, 0.9);
        osc.connect(g).connect(o(4));
        osc.start(t); lfo.start(t); osc.stop(t + 1); lfo.stop(t + 1);
        break;
      }
      case 'springStep': this.filteredNoise(0.08, o(3), { type: 'bandpass', freq: 2500, q: 4, peak: 0.4 }); this.osc('triangle', 600 + R() * 200, 0.15, o(3), { peak: 0.08 }); break;
      case 'chirp': for (let i = 0; i < 3; i++) setTimeout(() => this.osc('square', 1500 + R() * 800, 0.05, o(3), { peak: 0.12, slideTo: 2600 }), i * 90); break;
      case 'yippee': this.osc('square', 900, 0.22, o(3), { peak: 0.15, slideTo: 1800 }); setTimeout(() => this.osc('square', 1400, 0.3, o(3), { peak: 0.15, slideTo: 2200 }), 180); break;
      case 'growl':
        this.filteredNoise(1.1, o(5), { freq: 260, q: 4, a: 0.2, peak: 0.8 });
        this.osc('sawtooth', 55 + R() * 10, 1.0, o(5), { a: 0.2, peak: 0.25, slideTo: 45 });
        break;
      case 'roar':
        this.filteredNoise(1.4, o(6), { freq: 700, sweepTo: 300, q: 2, a: 0.1, peak: 0.9 });
        this.osc('sawtooth', 90, 1.2, o(6), { a: 0.1, peak: 0.4, slideTo: 50 });
        break;
      case 'thud': this.osc('sine', 60, 0.25, o(4), { peak: 0.6, slideTo: 35 }); this.filteredNoise(0.12, o(4), { freq: 300, peak: 0.3 }); break;
      case 'rustle': this.filteredNoise(0.4, o(2), { type: 'bandpass', freq: 3000, q: 0.7, a: 0.1, peak: 0.2 }); break;
      case 'alarm':
        for (let i = 0; i < 4; i++) setTimeout(() => this.osc('square', i % 2 ? 440 : 330, 0.35, o(), { peak: 0.12 }), i * 400);
        break;
      case 'horn': this.osc('sawtooth', 110, 2.0, o(), { a: 0.2, peak: 0.25 }); this.osc('sawtooth', 138, 2.0, o(), { a: 0.2, peak: 0.2 }); break;
      case 'radioOn': this.filteredNoise(0.12, o(), { type: 'highpass', freq: 2500, peak: 0.12 }); this.osc('square', 1200, 0.04, o(), { peak: 0.05 }); break;
      case 'radioOff': this.filteredNoise(0.2, o(), { type: 'bandpass', freq: 1800, q: 0.5, peak: 0.12 }); break;
      case 'flashOn': this.osc('square', 2200, 0.02, o(), { peak: 0.08 }); break;
      case 'bang':
        this.filteredNoise(1.2, o(8), { freq: 3000, sweepTo: 200, peak: 1.0 });
        this.osc('sine', 60, 0.8, o(8), { peak: 0.9, slideTo: 30 });
        break;
      case 'tinnitus': this.osc('sine', 4200, 4, o(), { a: 0.05, peak: 0.08 }); break;
      case 'pin': this.osc('sine', 3000, 0.05, o(), { peak: 0.1 }); break;
      case 'type': this.osc('square', 1800 + R() * 400, 0.015, o(), { peak: 0.03 }); break;
      case 'coin': this.osc('square', 1318, 0.08, o(), { peak: 0.08 }); setTimeout(() => this.osc('square', 1760, 0.2, o(), { peak: 0.08 }), 70); break;
      case 'quotaMet': [523, 659, 784, 1046].forEach((f, i) => setTimeout(() => this.osc('triangle', f, 0.4, o(), { peak: 0.2 }), i * 140)); break;
      case 'fired': [392, 330, 262, 196].forEach((f, i) => setTimeout(() => this.osc('sawtooth', f, 0.6, o(), { peak: 0.12 }), i * 300)); break;
    }
  }

  // Continuous ambience; call every frame with target volumes.
  ambience(inside, outside, night, orbit) {
    const ctx = this.ctx;
    if (!this.loops.built) {
      const mk = (build) => { const g = ctx.createGain(); g.gain.value = 0; build(g); g.connect(this.out); return g; };
      this.loops.drone = mk((g) => {
        [41, 41.7, 61.5].forEach((f) => {
          const o = ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = f;
          const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 160;
          const og = ctx.createGain(); og.gain.value = 0.05;
          o.connect(lp).connect(og).connect(g); o.start();
        });
      });
      this.loops.wind = mk((g) => {
        const s = ctx.createBufferSource(); s.buffer = this.noise; s.loop = true;
        const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = 450; f.Q.value = 0.6;
        const lfo = ctx.createOscillator(); lfo.frequency.value = 0.13;
        const lg = ctx.createGain(); lg.gain.value = 250;
        lfo.connect(lg).connect(f.frequency);
        const og = ctx.createGain(); og.gain.value = 0.12;
        s.connect(f).connect(og).connect(g); s.start(); lfo.start();
      });
      this.loops.hum = mk((g) => {
        const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.value = 58;
        const og = ctx.createGain(); og.gain.value = 0.05;
        o.connect(og).connect(g); o.start();
      });
      this.loops.built = true;
    }
    const t = ctx.currentTime;
    this.loops.drone.gain.setTargetAtTime(inside ? 1 : 0, t, 0.5);
    this.loops.wind.gain.setTargetAtTime(outside ? (night ? 1.3 : 0.8) : 0, t, 0.5);
    this.loops.hum.gain.setTargetAtTime(orbit ? 1 : 0, t, 0.5);
  }
}
