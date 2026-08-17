// ---------------------------------------------------------------------------
// SOUND ENGINE  --  performance events  ->  air.
//
// It receives finished PerformanceEvents and never looks at a key code, a
// keys/sec value or a word. Everything musical was already decided upstream.
// Replace this whole file with a sampler and the instrument still plays the
// same notes.
//
// -- WHAT IS AND IS NOT GUARANTEED -----------------------------------------
// All "noise" here (noise buffers, reverb impulse) comes from a seeded LCG, so
// nothing is random. That is still not the same as reproducible sound:
//
//   Level 1  same input + settings -> same performance events   GUARANTEED
//   Level 2  same performance events -> audibly the same music  BEST EFFORT
//   Level 3  bit-identical output samples                       NOT CLAIMED
//
// Level 2 is deliberately only best effort, because THIS FILE holds mutable
// state that is not part of a performance event:
//
//   * this.delayFb   -- one shared delay feedback, written by every event's
//                       fx.feedback, so a note's ambience depends on its
//                       neighbours;
//   * this.space     -- the pause macro, driven by the UI clock;
//   * this.delay.delayTime -- re-locked whenever the tempo moves;
//   * this.setName   -- the Sound World, which also selects pitch material.
//
// Two renderings of the same performance.json therefore agree on every note,
// and can still differ slightly in ambience. Fixing that means making the send
// bus per-voice instead of shared, which is a v0.3 change.
// ---------------------------------------------------------------------------

import { lcg, clamp } from '../core/hash.js';
import { SOUND_SETS } from './soundSets.js';

const NOISE_SEED = 0x5eed1234;
const IR_SEED = 0x0badc0de;

export class SoundEngine {
  constructor(opts = {}) {
    this.ctx = null;
    this.setName = 'electronic';
    this.gated = new Map();
    this.space = 0;
    this.bpm = 120;
    // Injectable so the release-identity logic can be tested with a fake clock
    // instead of by waiting 4.2 real seconds and making noise.
    this._setTimeout = opts.setTimeout || ((fn, ms) => setTimeout(fn, ms));
    this._clearTimeout = opts.clearTimeout || ((id) => clearTimeout(id));
    // Session clock: everything outside this file speaks in "seconds since the
    // session started". Only this file knows about AudioContext time.
    this.t0 = 0;
  }

  get set() {
    return SOUND_SETS[this.setName];
  }

  async start() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') await this.ctx.resume();
      return this.ctx;
    }
    const ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
    this.ctx = ctx;
    // Chrome can hand back a suspended context even inside a click handler
    // (autoplay policy, no output device yet). Without this the whole app
    // comes up silent.
    if (ctx.state !== 'running') {
      try {
        await ctx.resume();
      } catch (e) {
        /* reported by the caller */
      }
    }
    this.t0 = ctx.currentTime;

    this.noiseBuf = makeNoise(ctx, 2.0, NOISE_SEED);

    // Headroom: four layers plus live typing can easily sum past 1.0, so the
    // bus runs well below unity and the saturator stays a colour, not a clip.
    this.master = ctx.createGain();
    this.master.gain.value = 0.42;

    this.shaper = ctx.createWaveShaper();
    this.shaper.curve = makeCurve(this.set.drive);
    this.shaper.oversample = '2x';

    this.comp = ctx.createDynamicsCompressor();
    this.comp.threshold.value = -11;
    this.comp.knee.value = 14;
    this.comp.ratio.value = 3.5;
    this.comp.attack.value = 0.004;
    this.comp.release.value = 0.16;

    this.out = ctx.createGain();
    this.out.gain.value = 0.85;

    this.master.connect(this.shaper).connect(this.comp).connect(this.out);
    this.out.connect(ctx.destination);

    // recording tap
    this.recordDest = ctx.createMediaStreamDestination();
    this.out.connect(this.recordDest);

    // --- delay send -------------------------------------------------------
    this.delayIn = ctx.createGain();
    this.delay = ctx.createDelay(2.0);
    this.delay.delayTime.value = this.set.delayTime;
    this.delayFb = ctx.createGain();
    this.delayFb.gain.value = 0.28;
    this.delayFilter = ctx.createBiquadFilter();
    this.delayFilter.type = 'lowpass';
    this.delayFilter.frequency.value = 2600;
    this.delayIn.connect(this.delay);
    this.delay.connect(this.delayFilter).connect(this.delayFb).connect(this.delay);
    this.delay.connect(this.master);

    // --- reverb send ------------------------------------------------------
    this.reverbIn = ctx.createGain();
    this.reverb = ctx.createConvolver();
    this.reverb.buffer = makeImpulse(ctx, this.set.reverbSeconds, IR_SEED);
    this.reverbIn.connect(this.reverb).connect(this.master);

    // live typing bus (loops get their own gains from the loop engine)
    this.liveBus = ctx.createGain();
    this.liveBus.gain.value = 1;
    this.liveBus.connect(this.master);

    return ctx;
  }

  /** session seconds (not AudioContext seconds) */
  now() {
    return this.ctx ? this.ctx.currentTime - this.t0 : 0;
  }

  createBus(gain = 1) {
    const g = this.ctx.createGain();
    g.gain.value = gain;
    g.connect(this.master);
    return g;
  }

  setSoundSet(name) {
    if (!SOUND_SETS[name]) return;
    this.setName = name;
    if (!this.ctx) return;
    this.shaper.curve = makeCurve(this.set.drive);
    this.reverb.buffer = makeImpulse(this.ctx, this.set.reverbSeconds, IR_SEED);
    this.setBpm(this.bpm);
  }

  setBpm(bpm) {
    this.bpm = bpm;
    if (!this.ctx) return;
    // lock the delay to the tempo so echoes reinforce the loop grid
    const beat = 60 / bpm;
    this.delay.delayTime.setTargetAtTime(beat * 0.75, this.ctx.currentTime, 0.05);
  }

  setMasterVolume(v) {
    if (!this.ctx) return;
    this.out.gain.setTargetAtTime(clamp(v, 0, 1.2) * this.set.master, this.ctx.currentTime, 0.03);
  }

  /** pause macro: 0 = typing, 1 = long silence -> the room opens up */
  setSpace(amount) {
    this.space = clamp(amount, 0, 1);
    if (!this.ctx) return;
    this.delayFb.gain.setTargetAtTime(0.28 + this.space * 0.3, this.ctx.currentTime, 0.2);
  }

  // -------------------------------------------------------------------------
  /**
   * @param {object} ev  PerformanceEvent
   * @param {number} when absolute AudioContext time
   * @param {AudioNode} bus destination (live bus or a loop layer bus)
   * @param {string} scope key namespace for gated note-off
   */
  play(ev, when, bus = null, scope = 'live') {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const dest = bus || this.liveBus;
    const t = Math.max(when + this.t0, ctx.currentTime + 0.001);

    const amp = ctx.createGain();
    amp.gain.value = Math.pow(clamp(ev.velocity, 0, 127) / 127, 1.5);

    const pan = ctx.createStereoPanner();
    pan.pan.value = clamp(ev.pan || 0, -1, 1);
    amp.connect(pan);
    pan.connect(dest);

    const fx = ev.fx || {};
    if (fx.delay > 0.001) {
      const g = ctx.createGain();
      g.gain.value = fx.delay;
      pan.connect(g).connect(this.delayIn);
    }
    const rv = clamp((fx.reverb || 0) + this.space * 0.45, 0, 1);
    if (rv > 0.001) {
      const g = ctx.createGain();
      g.gain.value = rv;
      pan.connect(g).connect(this.reverbIn);
    }
    if (fx.feedback !== undefined) {
      this.delayFb.gain.setTargetAtTime(clamp(fx.feedback + this.space * 0.25, 0, 0.7), t, 0.1);
    }

    const handle = this._voice(ev, t, amp);
    if (ev.gated && handle && handle.release) {
      this._registerGated(scope + ':' + ev.sourceSeq, handle);
    }
    return handle;
  }

  _audioNow() {
    return this.ctx ? this.ctx.currentTime : 0;
  }

  /**
   * Register a sustaining voice under `key`, with a safety net in case its
   * keyup never arrives.
   *
   * Keys are REUSED: CLEAR ALL resets the InputEngine's sequence to 0, so the
   * very next note is `live:0` again, and a cleared-then-rebuilt layer produces
   * the same scope. v0.2.1's safety timer only knew the key, so a timer armed
   * before the clear could fire afterwards and cut short a brand new note.
   * The timer now checks that THIS handle is still the registered one, and a
   * superseded handle has its timer cancelled outright.
   */
  _registerGated(key, handle) {
    const prev = this.gated.get(key);
    if (prev) {
      if (prev.timer != null) this._clearTimeout(prev.timer); // 0 is a valid id
      this.gated.delete(key);
      prev.release(Math.max(this._audioNow(), prev.minEnd || 0));
    }
    this.gated.set(key, handle);
    handle.timer = this._setTimeout(() => {
      if (this.gated.get(key) !== handle) return; // superseded; not ours to stop
      this.gated.delete(key);
      handle.release(Math.max(this._audioNow(), handle.minEnd || 0));
    }, 4200);
  }

  release(seq, when, scope = 'live') {
    const key = scope + ':' + seq;
    const h = this.gated.get(key);
    if (!h) return;
    this.gated.delete(key);
    if (h.timer != null) this._clearTimeout(h.timer); // 0 is a valid id
    h.release(Math.max(when + this.t0, h.minEnd || 0));
  }

  /** `scope` is a prefix: 'L2' releases every iteration of layer 2. */
  releaseAll(scope) {
    for (const key of [...this.gated.keys()]) {
      if (scope && !key.startsWith(scope)) continue;
      const i = key.indexOf(':');
      this.release(key.slice(i + 1), this.now(), key.slice(0, i));
    }
  }

  // -------------------------------------------------------------------------
  _voice(ev, t, amp) {
    const kind = ev.instrument;
    if (kind === 'drum' || kind === 'lowfx' || kind === 'fx') return this._perc(ev, t, amp);
    switch (kind) {
      case 'bass': return this._synth(ev, t, amp, this.set.bass, 0);
      case 'melody': return this._synth(ev, t, amp, this.set.melody, 0);
      case 'bell': return this._bell(ev, t, amp);
      case 'chord': return this._chord(ev, t, amp);
      case 'voice': return this._voiceSynth(ev, t, amp);
      default: return this._synth(ev, t, amp, this.set.melody, 0);
    }
  }

  _noiseSource(t, dur, playbackRate = 1) {
    const s = this.ctx.createBufferSource();
    s.buffer = this.noiseBuf;
    s.playbackRate.value = playbackRate;
    s.loop = true;
    // deterministic read offset: derived from the scheduled time grid, not rand
    s.start(t, ((t * 7) % 1.8));
    s.stop(t + dur + 0.05);
    return s;
  }

  _perc(ev, t, amp) {
    const ctx = this.ctx;
    const d = this.set.drum;
    const tune = 1 + (ev.tune || 0);
    const part = ev.part || 'hat';

    const tone = (freq0, freq1, decay, type = 'sine') => {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.setValueAtTime(freq0 * tune, t);
      o.frequency.exponentialRampToValueAtTime(Math.max(freq1 * tune, 20), t + decay);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(1, t + 0.002);
      g.gain.exponentialRampToValueAtTime(0.0008, t + decay);
      o.connect(g).connect(amp);
      o.start(t);
      o.stop(t + decay + 0.05);
    };

    const noise = (type, freq, q, decay, level, rate = 1) => {
      const s = this._noiseSource(t, decay, rate);
      const f = ctx.createBiquadFilter();
      f.type = type;
      f.frequency.setValueAtTime(freq, t);
      f.Q.value = q;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(level, t + 0.002);
      g.gain.exponentialRampToValueAtTime(0.0008, t + decay);
      s.connect(f).connect(g).connect(amp);
      return { f, g };
    };

    switch (part) {
      case 'kick':
        tone(150 * d.tone, 44, 0.34 * d.decay);
        noise('lowpass', 3000, 1, 0.02 * d.click, 0.5 * d.click);
        break;
      case 'snare':
        tone(210 * d.tone, 120, 0.12 * d.decay, 'triangle');
        noise('bandpass', 1900, 1.1, 0.19 * d.decay, 0.85 * d.noise);
        break;
      case 'hat':
        noise('highpass', 7200, 0.8, 0.045 * d.decay, 0.55 * d.noise, 1.6);
        break;
      case 'clap': {
        for (let i = 0; i < 3; i++) {
          const s = this._noiseSource(t + i * 0.011, 0.16, 1.2);
          const f = ctx.createBiquadFilter();
          f.type = 'bandpass';
          f.frequency.value = 1350;
          f.Q.value = 2.2;
          const g = ctx.createGain();
          const st = t + i * 0.011;
          g.gain.setValueAtTime(0, st);
          g.gain.linearRampToValueAtTime(0.5 * d.noise, st + 0.002);
          g.gain.exponentialRampToValueAtTime(0.0008, st + (i === 2 ? 0.22 : 0.05));
          s.connect(f).connect(g).connect(amp);
        }
        break;
      }
      case 'ghost':
        noise('highpass', 9500, 0.7, 0.03, 0.4, 2.0);
        break;
      case 'sub':
        tone(90 * d.tone, 34, 0.5 * d.decay);
        break;
      case 'noise': {
        const n = noise('bandpass', 2800, 3, 0.24 * d.decay, 0.8 * d.noise);
        n.f.frequency.exponentialRampToValueAtTime(320, t + 0.24 * d.decay);
        break;
      }
      case 'ride':
        noise('highpass', 5200, 0.6, 0.65 * d.decay, 0.35 * d.noise, 1.1);
        break;
      case 'tom':
        tone(230 * d.tone, 95, 0.3 * d.decay, 'sine');
        break;
      case 'boom':
        tone(70 * d.tone, 30, 0.85 * d.decay);
        noise('lowpass', 500, 1, 0.4, 0.35 * d.noise);
        break;
      case 'impact': {
        tone(120 * d.tone, 38, 0.8 * d.decay);
        const n = noise('bandpass', 1800, 1.2, 0.6, 0.6 * d.noise);
        n.f.frequency.exponentialRampToValueAtTime(200, t + 0.6);
        break;
      }
      case 'riser': {
        const dur = ev.duration || 0.6;
        const s = this._noiseSource(t, dur, 1);
        const f = ctx.createBiquadFilter();
        f.type = 'bandpass';
        f.Q.value = 6;
        f.frequency.setValueAtTime(300, t);
        f.frequency.exponentialRampToValueAtTime(6000, t + dur);
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.001, t);
        g.gain.exponentialRampToValueAtTime(0.5, t + dur * 0.9);
        g.gain.exponentialRampToValueAtTime(0.001, t + dur);
        s.connect(f).connect(g).connect(amp);
        break;
      }
      case 'reverse': {
        // Backspace: a swell that rushes backwards into silence
        const dur = ev.duration || 0.28;
        const o = ctx.createOscillator();
        o.type = 'sawtooth';
        const f0 = ev.freq || 220;
        o.frequency.setValueAtTime(f0 * 1.5, t);
        o.frequency.exponentialRampToValueAtTime(Math.max(f0 * 0.5, 30), t + dur);
        const f = ctx.createBiquadFilter();
        f.type = 'lowpass';
        f.frequency.setValueAtTime(600, t);
        f.frequency.exponentialRampToValueAtTime(4000, t + dur * 0.8);
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.001, t);
        g.gain.exponentialRampToValueAtTime(0.6, t + dur * 0.8);
        g.gain.exponentialRampToValueAtTime(0.001, t + dur);
        o.connect(f).connect(g).connect(amp);
        o.start(t);
        o.stop(t + dur + 0.05);
        break;
      }
      default:
        noise('highpass', 6000, 1, 0.05, 0.3);
    }
    return null;
  }

  // --- gated subtractive synth (bass / melody) -----------------------------
  _synth(ev, t, amp, cfg, detuneExtra) {
    const ctx = this.ctx;
    const g = ctx.createGain();
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.Q.value = cfg.q;

    // Brightness is the continuous "how hard am I playing" control (it tracks
    // typing speed smoothly), kept separate from velocity so that speed opens
    // the filter without simply making everything louder.
    const bright = ev.fx && ev.fx.brightness !== undefined ? ev.fx.brightness : 0.6;
    const openness = clamp((0.35 + bright * 1.15) * (0.6 + (ev.velocity / 127) * 0.6), 0.2, 2.2);
    const cutoff = clamp(cfg.cutoff * openness, 120, 12000);
    f.frequency.setValueAtTime(cutoff * 1.6, t);
    f.frequency.exponentialRampToValueAtTime(cutoff * 0.55, t + 0.25);

    const oscs = [];
    for (const det of [-cfg.detune - detuneExtra, cfg.detune + detuneExtra]) {
      const o = ctx.createOscillator();
      o.type = cfg.wave;
      o.frequency.value = ev.freq;
      o.detune.value = det;
      o.connect(f);
      o.start(t);
      oscs.push(o);
    }
    f.connect(g).connect(amp);

    const sustain = 0.72;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(1, t + cfg.attack);
    g.gain.linearRampToValueAtTime(sustain, t + cfg.attack + 0.09);

    const minLen = 0.07;
    const stop = (when) => {
      const r = Math.max(when, t + minLen);
      g.gain.cancelScheduledValues(r);
      g.gain.setValueAtTime(Math.max(g.gain.value, 0.0001), r);
      g.gain.exponentialRampToValueAtTime(0.0001, r + cfg.release);
      oscs.forEach((o) => o.stop(r + cfg.release + 0.05));
    };

    if (!ev.gated) {
      stop(t + (ev.duration || 0.3));
      return null;
    }
    return { release: stop, minEnd: t + minLen, stop };
  }

  // --- FM bell -------------------------------------------------------------
  _bell(ev, t, amp) {
    const ctx = this.ctx;
    const cfg = this.set.bell;
    const dur = (ev.duration || 0.6) + cfg.decay;
    const car = ctx.createOscillator();
    car.type = 'sine';
    car.frequency.value = ev.freq;
    const mod = ctx.createOscillator();
    mod.type = 'sine';
    mod.frequency.value = ev.freq * cfg.ratio;
    const modGain = ctx.createGain();
    modGain.gain.setValueAtTime(cfg.index * (ev.velocity / 100), t);
    modGain.gain.exponentialRampToValueAtTime(1, t + cfg.decay * 0.7);
    mod.connect(modGain).connect(car.frequency);

    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(1, t + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    car.connect(g).connect(amp);
    car.start(t); mod.start(t);
    car.stop(t + dur + 0.05); mod.stop(t + dur + 0.05);
    return null;
  }

  // --- pad / chord ---------------------------------------------------------
  _chord(ev, t, amp) {
    const ctx = this.ctx;
    const cfg = this.set.chord;
    const notes = ev.chord && ev.chord.length ? ev.chord : [ev.note];
    const g = ctx.createGain();
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = cfg.cutoff;
    f.connect(g).connect(amp);

    const oscs = notes.map((m, i) => {
      const o = ctx.createOscillator();
      o.type = cfg.wave;
      o.frequency.value = 440 * Math.pow(2, (m - 69) / 12);
      o.detune.value = (i - 1) * 6; // fixed spread, not random
      o.connect(f);
      o.start(t);
      return o;
    });

    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.45, t + cfg.attack);

    const minLen = 0.12;
    const stop = (when) => {
      const r = Math.max(when, t + minLen);
      g.gain.cancelScheduledValues(r);
      g.gain.setValueAtTime(Math.max(g.gain.value, 0.0001), r);
      g.gain.exponentialRampToValueAtTime(0.0001, r + cfg.release);
      oscs.forEach((o) => o.stop(r + cfg.release + 0.08));
    };
    if (!ev.gated) { stop(t + (ev.duration || 0.6)); return null; }
    return { release: stop, minEnd: t + minLen, stop };
  }

  // --- formant "voice" -----------------------------------------------------
  _voiceSynth(ev, t, amp) {
    const ctx = this.ctx;
    const cfg = this.set.voice;
    const g = ctx.createGain();
    g.connect(amp);

    const src = ctx.createOscillator();
    src.type = 'sawtooth';
    src.frequency.value = ev.freq;
    src.start(t);

    const noiseSrc = this._noiseSource(t, 3.0, 1);
    const nGain = ctx.createGain();
    nGain.gain.value = cfg.noise * 0.25;
    noiseSrc.connect(nGain);

    const shift = { aa: 1, oo: 0.78, ee: 1.25, uu: 0.68, ss: 1.6 }[ev.part] || 1;
    cfg.formants.forEach((fr, i) => {
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = fr * shift;
      bp.Q.value = cfg.q;
      const fg = ctx.createGain();
      fg.gain.value = [1, 0.6, 0.3][i];
      src.connect(bp).connect(fg).connect(g);
      nGain.connect(bp);
    });

    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.9, t + 0.02);
    g.gain.linearRampToValueAtTime(0.6, t + 0.12);

    const minLen = 0.08;
    const stop = (when) => {
      const r = Math.max(when, t + minLen);
      g.gain.cancelScheduledValues(r);
      g.gain.setValueAtTime(Math.max(g.gain.value, 0.0001), r);
      g.gain.exponentialRampToValueAtTime(0.0001, r + 0.14);
      src.stop(r + 0.2);
      noiseSrc.stop(r + 0.2);
    };
    if (!ev.gated) { stop(t + (ev.duration || 0.35)); return null; }
    return { release: stop, minEnd: t + minLen, stop };
  }
}

// --- deterministic buffers ---------------------------------------------------
function makeNoise(ctx, seconds, seed) {
  const len = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  const rnd = lcg(seed);
  for (let i = 0; i < len; i++) d[i] = rnd() * 2 - 1;
  return buf;
}

function makeImpulse(ctx, seconds, seed) {
  const len = Math.max(1, Math.floor(ctx.sampleRate * seconds));
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  const rnd = lcg(seed);
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < len; i++) {
      const t = i / len;
      d[i] = (rnd() * 2 - 1) * Math.pow(1 - t, 2.6);
    }
  }
  return buf;
}

function makeCurve(amount) {
  const n = 1024;
  const c = new Float32Array(n);
  const k = amount * 22 + 0.01;
  for (let i = 0; i < n; i++) {
    const x = (i * 2) / n - 1;
    c[i] = ((1 + k) * x) / (1 + k * Math.abs(x));
  }
  return c;
}
