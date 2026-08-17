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

/**
 * How many voices may be alive at once.
 *
 * Four loops of eight notes plus a fast typist plus ratchets can ask for far
 * more than a browser will render cleanly, and the failure mode is not a
 * dropped note -- it is the whole output turning to mud and the tab locking up.
 * The cap is enforced by DETERMINISTIC stealing: always the oldest still-alive
 * voice, never "whichever we noticed first". Same events in, same voice
 * surviving, every time.
 */
const MAX_POLYPHONY = 48;

/** how long a gated voice is assumed to last, for the purpose of the cap */
const ASSUMED_GATED_SECONDS = 8;

/** a value that is safe to hand to an AudioParam */
function safe(v, fallback) {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

export class SoundEngine {
  constructor(opts = {}) {
    this.ctx = null;
    this.setName = 'electronic';
    this.gated = new Map();
    this.space = 0;
    this.bpm = 120;
    // Every live voice, oldest first. See MAX_POLYPHONY.
    this.voices = [];
    this.voiceCounter = 0;
    this.maxPolyphony = opts.maxPolyphony || MAX_POLYPHONY;
    this.stolen = 0; // diagnostic; the self-test reads it
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

    // A second, much harder stage that exists only to make it impossible to
    // send a damaging peak to the headphones. `comp` above is a musical
    // compressor and is allowed to be gentle; this one is a brick wall. Two
    // separate jobs, so two separate nodes.
    this.limiter = ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -1.5;
    this.limiter.knee.value = 0;
    this.limiter.ratio.value = 20;
    this.limiter.attack.value = 0.001;
    this.limiter.release.value = 0.08;

    this.out = ctx.createGain();
    this.out.gain.value = 0.85;

    this.master.connect(this.shaper).connect(this.comp).connect(this.limiter).connect(this.out);
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

    // Auditioning a Sound World is NOT part of the performance. It gets its own
    // bus so it can be silenced in one move, and nothing on it is ever
    // dispatched, recorded or counted against the polyphony budget of the
    // piece. See playPreview().
    this.previewBus = ctx.createGain();
    this.previewBus.gain.value = 0.9;
    this.previewBus.connect(this.master);

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
    // An audition of the world being left behind must not carry into the one
    // being chosen.
    this.stopPreview();
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
    if (!this.ctx) return null;
    const ctx = this.ctx;
    const dest = bus || this.liveBus;
    const t = Math.max(safe(when, 0) + this.t0, ctx.currentTime + 0.001);

    const amp = ctx.createGain();
    // Every AudioParam below goes through safe(): one NaN reaching a param
    // poisons that node for the rest of the session (Web Audio has no way to
    // recover a param that was set to NaN), and a burst of very fast typing is
    // exactly where a divide-by-zero in an interval would show up.
    amp.gain.value = Math.pow(clamp(safe(ev.velocity, 90), 0, 127) / 127, 1.5);

    const pan = ctx.createStereoPanner();
    pan.pan.value = clamp(safe(ev.pan, 0), -1, 1);
    amp.connect(pan);
    pan.connect(dest);

    const fx = ev.fx || {};
    const fxDelay = safe(fx.delay, 0);
    if (fxDelay > 0.001) {
      const g = ctx.createGain();
      g.gain.value = clamp(fxDelay, 0, 1);
      pan.connect(g).connect(this.delayIn);
    }
    const rv = clamp(safe(fx.reverb, 0) + this.space * 0.45, 0, 1);
    if (rv > 0.001) {
      const g = ctx.createGain();
      g.gain.value = rv;
      pan.connect(g).connect(this.reverbIn);
    }
    if (fx.feedback !== undefined) {
      this.delayFb.gain.setTargetAtTime(clamp(safe(fx.feedback, 0.2) + this.space * 0.25, 0, 0.7), t, 0.1);
    }

    // Book the slot BEFORE building the voice, so an over-budget burst steals
    // from what is already sounding rather than adding to it first.
    const slot = this._takeVoiceSlot(t, ev);
    const handle = this._voice(ev, t, amp);
    slot.amp = amp;
    slot.handle = handle;
    if (handle && Number.isFinite(handle.naturalEnd)) {
      slot.endsAt = Math.max(t + 0.01, handle.naturalEnd);
    }
    if (ev.gated && handle && handle.release) {
      slot.key = scope + ':' + ev.sourceSeq;
      // so release() can retire the slot instead of leaving it booked for the
      // full assumed lifetime of a held note
      handle.slot = slot;
      this._registerGated(slot.key, handle);
    }
    return handle;
  }

  /**
   * Audition a Sound World without performing it.
   *
   * Routed to previewBus, never registered as a gated voice, never counted
   * against polyphony, and -- crucially -- the caller does not dispatch
   * anything, so nothing about it reaches the session log or the saved project.
   * stopPreview() silences whatever is still ringing.
   */
  playPreview(ev, offsetSeconds = 0) {
    if (!this.ctx) return null;
    const ctx = this.ctx;
    const t = ctx.currentTime + 0.02 + Math.max(0, safe(offsetSeconds, 0));
    const amp = ctx.createGain();
    amp.gain.value = Math.pow(clamp(safe(ev.velocity, 90), 0, 127) / 127, 1.5);
    amp.connect(this.previewBus);
    this._previewAmps = this._previewAmps || [];
    this._previewAmps.push(amp);
    const handle = this._voice(Object.assign({}, ev, { gated: false }), t, amp);
    return handle;
  }

  stopPreview() {
    if (!this.ctx || !this._previewAmps) return 0;
    const now = this.ctx.currentTime;
    const n = this._previewAmps.length;
    for (const amp of this._previewAmps) fadeOutAndDrop(amp, now, 0.04);
    this._previewAmps = [];
    return n;
  }

  // -------------------------------------------------------------------------
  // POLYPHONY
  // -------------------------------------------------------------------------
  /**
   * Reserve a voice slot, stealing the OLDEST live voice when the budget is
   * full. "Oldest" means the smallest sequence number, which is a total order
   * fixed by the events themselves -- so the same performance always steals the
   * same voice, and the cap does not make the output non-deterministic in a way
   * a listener could notice as randomness.
   */
  _takeVoiceSlot(t, ev) {
    const now = this._audioNow();
    // drop everything that has certainly finished
    if (this.voices.length) this.voices = this.voices.filter((v) => v.endsAt > now);
    while (this.voices.length >= this.maxPolyphony) {
      const victim = this.voices.shift();
      this.stolen++;
      this._killVoice(victim, now);
    }
    const dur = safe(ev.duration, 0.3);
    const endsAt = ev.gated ? t + ASSUMED_GATED_SECONDS : t + Math.max(dur, 0.05) + 2.0;
    const slot = { n: this.voiceCounter++, endsAt, amp: null, handle: null, key: null };
    this.voices.push(slot);
    return slot;
  }

  _killVoice(slot, now) {
    if (!slot) return;
    if (slot.key && this.gated.get(slot.key) === slot.handle) {
      this.gated.delete(slot.key);
      if (slot.handle && slot.handle.timer != null) this._clearTimeout(slot.handle.timer);
    }
    try {
      if (slot.handle && slot.handle.stop) slot.handle.stop(now);
      else if (slot.handle && slot.handle.release) slot.handle.release(now);
    } catch (e) {
      /* a voice that cannot be released is still going to be faded out below */
    }
    if (slot.amp) fadeOutAndDrop(slot.amp, now, 0.02);
  }

  /**
   * EVERYTHING off, right now.
   *
   * The safety net behind window blur, the tab going away, STOP, CLEAR ALL and
   * switching to another project. A stuck note is the one failure a musical
   * tool is not allowed to have: you cannot demonstrate it, you cannot record
   * over it, and on a laptop you cannot even leave the room.
   *
   * @returns {number} how many voices were stopped -- the self-test asserts it
   */
  allNotesOff() {
    if (!this.ctx) return 0;
    const now = this._audioNow();
    let n = 0;
    for (const key of [...this.gated.keys()]) {
      const h = this.gated.get(key);
      this.gated.delete(key);
      if (h && h.timer != null) this._clearTimeout(h.timer);
      try {
        if (h && h.release) h.release(now);
      } catch (e) {
        /* fall through to the fade below */
      }
      n++;
    }
    for (const slot of this.voices) {
      if (slot.amp) fadeOutAndDrop(slot.amp, now, 0.03);
      n++;
    }
    this.voices = [];
    n += this.stopPreview();
    return n;
  }

  /** live diagnostics for the inspector and the polyphony self-test */
  voiceStats() {
    const now = this._audioNow();
    const live = this.voices.filter((v) => v.endsAt > now).length;
    return { live, gated: this.gated.size, max: this.maxPolyphony, stolen: this.stolen };
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
    const at = Math.max(safe(when, 0) + this.t0, h.minEnd || 0);
    h.release(at);
    // The slot was booked for ASSUMED_GATED_SECONDS because nobody knew how
    // long the key would be down. Now we do, so give the budget back.
    if (h.slot) h.slot.endsAt = Math.min(h.slot.endsAt, at + (h.dampTime || 1.0) + 0.2);
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
  /**
   * Pick the synthesis model.
   *
   * The ROLE of a key never changes -- J is always melody -- but a Sound World
   * may decide that melody is a struck string rather than a held oscillator.
   * Percussion, FX and bells are one-shots in EVERY world: they finish on their
   * own schedule and never wait for a key to come up, which is why holding a
   * drum key can never leave anything ringing.
   */
  _voice(ev, t, amp) {
    const kind = ev.instrument;
    if (kind === 'drum' || kind === 'lowfx' || kind === 'fx') return this._perc(ev, t, amp);
    if (kind === 'bell') return this._bell(ev, t, amp);

    const model = this.set.model || 'gated';
    if (model === 'piano' || model === 'pluck') {
      // A chord still plays its three tones; each one is a struck string.
      if (kind === 'chord') return this._struckChord(ev, t, amp, model);
      return this._struck(ev, t, amp, model, kind);
    }

    switch (kind) {
      case 'bass': return this._synth(ev, t, amp, this.set.bass, 0);
      case 'melody': return this._synth(ev, t, amp, this.set.melody, 0);
      case 'chord': return this._chord(ev, t, amp);
      case 'voice': return this._voiceSynth(ev, t, amp);
      default: return this._synth(ev, t, amp, this.set.melody, 0);
    }
  }

  // -------------------------------------------------------------------------
  // STRUCK / PLUCKED
  //
  // The contract these two share, and the reason they are one function:
  //
  //   * the loudest instant is the attack, and it decays from there;
  //   * it keeps decaying WHILE THE KEY IS HELD -- holding does not sustain;
  //   * releasing the key does not cut the sound off, it DAMPS it, over `damp`
  //     seconds. High notes damp faster than low ones, exactly as the felt on a
  //     real instrument does;
  //   * the decay time depends on PITCH, not on one global figure.
  //
  // `duration` (how long the key was held) therefore still matters -- it decides
  // when damping starts -- but it can never make a note sustain at a level it
  // has already decayed past. That is the honest behaviour, and it is what makes
  // phrasing rather than speed the way to play these two worlds well.
  // -------------------------------------------------------------------------
  _struckDecay(cfg, midi) {
    // 36 (low C) .. 96 (top). Exponential between the two endpoints, so the
    // middle of the keyboard lands where an ear expects it rather than halfway.
    const m = clamp(safe(midi, 60), 24, 108);
    const k = clamp((m - 36) / 60, 0, 1);
    const lo = Math.max(0.2, cfg.decayLow);
    const hi = Math.max(0.15, cfg.decayHigh);
    return lo * Math.pow(hi / lo, k);
  }

  _struckDamp(cfg, midi) {
    const m = clamp(safe(midi, 60), 24, 108);
    const k = clamp((m - 36) / 60, 0, 1);
    const lo = cfg.damp;
    const hi = cfg.dampHigh === undefined ? cfg.damp * 0.4 : cfg.dampHigh;
    return lo + (hi - lo) * k;
  }

  _struck(ev, t, amp, model, kind) {
    const ctx = this.ctx;
    const cfg = this.set.struck;
    const freq = clamp(safe(ev.freq, 440), 20, 12000);
    const midi = safe(ev.note, 60);
    const isPluck = model === 'pluck';

    const decay = this._struckDecay(cfg, midi) * (kind === 'bass' ? 1.35 : 1);
    const damp = this._struckDamp(cfg, midi);
    const attack = Math.max(cfg.attack || 0.003, 0.001);

    // one gain for the whole note, so damping is a single ramp
    const g = ctx.createGain();
    const body = ctx.createBiquadFilter();
    body.type = 'lowpass';
    body.Q.value = isPluck ? 0.9 : 0.4;
    const open = clamp(freq * (isPluck ? cfg.bodyOpen : 6.0), 200, cfg.cutoff || 6000);
    const close = clamp(freq * (isPluck ? cfg.bodyClose : 2.2), 120, cfg.cutoff || 6000);
    body.frequency.setValueAtTime(open, t);
    body.frequency.exponentialRampToValueAtTime(Math.max(close, 60), t + Math.min(decay, 2.5));
    body.connect(g).connect(amp);

    // --- the partials -------------------------------------------------------
    // Each one has its own decay: upper partials die first, which is what turns
    // a bright attack into a round tail instead of a static timbre.
    const oscs = [];
    const partialGains = [];
    let naturalEnd = t + attack + 0.06;
    for (const [ratio, level, decayScale] of cfg.partials) {
      const f = freq * ratio;
      if (f > 18000) continue; // above hearing; do not waste a node on it
      const o = ctx.createOscillator();
      o.type = isPluck && ratio === 1 ? 'sawtooth' : 'sine';
      o.frequency.value = f;
      const pg = ctx.createGain();
      const pDecay = Math.max(decay * decayScale, 0.06);
      pg.gain.setValueAtTime(0.0001, t);
      pg.gain.linearRampToValueAtTime(level, t + attack);
      pg.gain.exponentialRampToValueAtTime(0.0001, t + attack + pDecay);
      o.connect(pg).connect(body);
      o.start(t);
      o.stop(t + attack + pDecay + 0.05);
      naturalEnd = Math.max(naturalEnd, t + attack + pDecay + 0.05);
      oscs.push(o);
      partialGains.push(pg);
    }

    // --- the excitation -----------------------------------------------------
    // The hammer thud (piano) or the pick (plucked). Short, filtered noise read
    // from the seeded buffer -- deterministic, and the same note always gets the
    // same slice of it because the offset comes from the frequency.
    const exciteLen = isPluck ? cfg.exciteSeconds || 0.009 : 0.02;
    if (cfg.hammer > 0) {
      const s = ctx.createBufferSource();
      s.buffer = this.noiseBuf;
      s.loop = true;
      const off = (freq % 137) / 137 * 1.7; // deterministic, note-derived
      s.start(t, off);
      s.stop(t + exciteLen + 0.06);
      const nf = ctx.createBiquadFilter();
      nf.type = isPluck ? 'bandpass' : 'lowpass';
      nf.frequency.value = clamp(freq * (isPluck ? 2.4 : 3.0), 120, 9000);
      nf.Q.value = isPluck ? 1.1 : 0.7;
      const ng = ctx.createGain();
      ng.gain.setValueAtTime(cfg.hammer, t);
      ng.gain.exponentialRampToValueAtTime(0.0005, t + exciteLen + 0.03);
      s.connect(nf).connect(ng).connect(body);
    }

    g.gain.setValueAtTime(1, t);

    let damped = false;
    const minEnd = t + Math.min(0.06, decay * 0.25);
    const release = (when) => {
      if (damped) return;
      damped = true;
      const r = Math.max(safe(when, 0), minEnd);
      // Damping, not silencing: the string is stopped over `damp` seconds. The
      // value is read from the curve first so the ramp starts wherever the note
      // has already decayed to, instead of jumping back up to full.
      g.gain.cancelScheduledValues(r);
      g.gain.setValueAtTime(Math.max(g.gain.value, 0.0001), r);
      g.gain.exponentialRampToValueAtTime(0.0001, r + damp);
      for (const o of oscs) {
        try {
          o.stop(r + damp + 0.05);
        } catch (e) {
          /* already scheduled to stop earlier, which is fine */
        }
      }
    };

    // Even a one-shot returns its real lifetime and a stop handle. Without
    // that metadata the polyphony ledger forgot a long low piano tail while
    // its AudioNodes were still alive, so a nominal 48-voice cap was not a cap.
    return { release, minEnd, stop: release, naturalDecay: decay, naturalEnd, dampTime: damp };
  }

  _struckChord(ev, t, amp, model) {
    const notes = ev.chord && ev.chord.length ? ev.chord : [safe(ev.note, 60)];
    const handles = notes.map((m, i) =>
      this._struck(
        Object.assign({}, ev, {
          note: m,
          freq: 440 * Math.pow(2, (m - 69) / 12),
          // a real hand does not strike three keys at the same microsecond
          velocity: clamp(safe(ev.velocity, 90) * (i === 0 ? 1 : 0.82), 1, 127),
        }),
        t + i * 0.006,
        amp,
        model,
        'chord'
      )
    );
    const live = handles.filter(Boolean);
    if (!live.length) return null;
    return {
      release: (when) => live.forEach((h) => h.release(when)),
      minEnd: Math.min(...live.map((h) => h.minEnd)),
      stop: (when) => live.forEach((h) => h.release(when)),
      naturalEnd: Math.max(...live.map((h) => h.naturalEnd || 0)),
      dampTime: Math.max(...live.map((h) => h.dampTime || 0)),
    };
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

/**
 * Take a gain node down to silence and let go of it.
 *
 * Used by voice stealing and by allNotesOff. The 20-40 ms ramp is not
 * politeness: cutting a gain to zero in one sample IS a click, and a click is
 * exactly what a listener hears as "the software broke", so the fastest safe
 * stop is still a short ramp. The disconnect is deferred past the ramp so the
 * tail is actually rendered.
 */
function fadeOutAndDrop(amp, now, seconds) {
  try {
    amp.gain.cancelScheduledValues(now);
    amp.gain.setValueAtTime(Math.max(amp.gain.value, 0.0001), now);
    amp.gain.linearRampToValueAtTime(0, now + seconds);
  } catch (e) {
    /* a param that cannot be ramped is disconnected below anyway */
  }
  setTimeout(() => {
    try {
      amp.disconnect();
    } catch (e) {
      /* already gone */
    }
  }, Math.ceil(seconds * 1000) + 60);
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

export { MAX_POLYPHONY, safe };
