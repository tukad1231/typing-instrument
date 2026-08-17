// ---------------------------------------------------------------------------
// PERFORMANCE ENGINE  --  typing  ->  musical intention.
//
// This is the instrument's soul, and it is deterministic on purpose:
//
//     same raw key events + same mapping + same settings
//                       = same performance events, always.
//
// There is no Math.random() here and no reference to Web Audio. It can be run
// headless (that is how the determinism self-test works) and the whole sound
// engine can be swapped out without touching a line of this file.
//
// -- PLAYING STABILITY (new in v0.2) ---------------------------------------
// Determinism alone does not make something re-performable by a human. Hands
// are never exact, so the second principle is:
//
//     a small difference in input must stay a small difference in music.
//
// v0.1 broke this: crossing 6 keys/sec flipped the melody up a full octave, so
// 5.99 and 6.01 were different songs. Continuous quantities (speed, steadiness)
// now drive continuous things -- brightness, density, blend, FX depth. Big,
// discrete musical changes are reserved for gestures you can aim at on purpose:
// Shift, repeats, holds, hand alternation.
//
// -- THE RULES THE PLAYER CAN LEARN ----------------------------------------
//  R1  hold a key            -> the note sustains for as long as you hold it,
//                               with a 80 ms floor so a fast tap still speaks
//  R2  same key twice+       -> chromatic climb (+1 semitone/repeat, max +4)
//  R3  same key 4 times+     -> ratchet / roll on percussion
//  R4  Shift                 -> deliberately outside the scale (tension note)
//  R5  long word (6+ chars)  -> the melody climbs while you finish the word
//  R6  faster typing         -> brighter and denser, and an octave layer FADES
//                               in across 5.5 -> 9 keys/sec (no pitch jump)
//  R7  alternating hands x6+ -> hard stereo ping-pong + every other note a 5th
//  R8  steady rhythm         -> tighter, more delay feedback ("groove lock")
//  R9  pause > 1.2s          -> the next attack is an accent with a long tail
//  R10 Backspace             -> reversed tail; it is a note like any other and
//                               stays in the layer (it does not undo anything)
//
// COMPLEXITY is not chaos and not randomness: it is how many of these rules are
// switched on.  0-30 basics · 30-50 pitch movement · 50-70 hand expression ·
// 70-100 sub layers.
// ---------------------------------------------------------------------------

import { clamp, round3 } from '../core/hash.js';
import { SCALES, degreeToMidi, tensionMidi, midiToFreq } from './scale.js';
import { ZONES } from './mapping.js';

const PITCHED = new Set(['bass', 'melody', 'bell', 'chord', 'voice']);

export function createState() {
  return {
    lastCode: null,
    lastHand: null,
    repeat: 0, // consecutive presses of the same key
    altStreak: 0, // consecutive left/right alternations
    intervals: [], // last N inter-key intervals (ms)
    kps: 0,
    phraseIndex: 0,
    noteInPhrase: 0,
    lastPitched: null, // last pitched performance event (for Backspace)
    lastTime: 0,
  };
}

export const DEFAULT_SETTINGS = {
  bpm: 120,
  soundSet: 'electronic',
  complexity: 40, // 0..100  (never "chaos" -- it is deterministic)
  quantize: 'LIGHT', // OFF | LIGHT | STRONG
  masterVolume: 0.8,
  version: 'poc-2',
};

/** steadiness of the last few intervals, 0 (erratic) .. 1 (metronomic) */
function groove(intervals) {
  if (intervals.length < 3) return 0;
  const a = intervals.slice(-6);
  const mean = a.reduce((s, v) => s + v, 0) / a.length;
  if (mean <= 0) return 0;
  const varc = a.reduce((s, v) => s + (v - mean) * (v - mean), 0) / a.length;
  const cv = Math.sqrt(varc) / mean; // coefficient of variation
  return clamp(1 - cv * 1.8, 0, 1);
}

export class PerformanceEngine {
  constructor(mapping, settings) {
    this.mapping = mapping;
    this.settings = Object.assign({}, DEFAULT_SETTINGS, settings);
    this.state = createState();
  }

  setSettings(patch) {
    Object.assign(this.settings, patch);
  }

  reset() {
    this.state = createState();
  }

  // -------------------------------------------------------------------------
  // CHECKPOINT
  //
  // Every learnable rule reads this state: `repeat` decides the chromatic
  // climb, `altStreak` the hand-alternation fifth, `noteInPhrase` the sub
  // doubling, `lastPitched` what Backspace reverses. Starting a RECORD does
  // NOT reset it -- the player is mid-performance -- so a take that is to be
  // replayed faithfully has to carry it. Without this, typing J before RECORD
  // and J again as the take's first key gave note 61 (chromatic) live and
  // note 60 (scale) on replay.
  // -------------------------------------------------------------------------
  /** @returns {object} a JSON-safe deep copy; no shared references escape */
  exportState() {
    return JSON.parse(JSON.stringify(this.state));
  }

  /** Deep-clones the input, and fills any missing field from the defaults. */
  importState(state) {
    const fresh = createState();
    if (!state) {
      this.state = fresh;
      return;
    }
    const copy = JSON.parse(JSON.stringify(state));
    for (const k of Object.keys(fresh)) {
      if (copy[k] !== undefined) fresh[k] = copy[k];
    }
    this.state = fresh;
  }

  get scale() {
    return SCALES[this.settings.soundSet] || SCALES.electronic;
  }

  /** live readouts for the UI (also fully derived from the key stream) */
  get intensity() {
    return Math.round(clamp(this.state.kps / 9, 0, 1) * 100);
  }
  get groove() {
    return Math.round(groove(this.state.intervals) * 100);
  }

  // -------------------------------------------------------------------------
  // MAIN TRANSFORM
  // -------------------------------------------------------------------------
  /**
   * @param {object} raw RawTypingEvent from the input engine
   * @returns {{events: object[], signal: string|null}}
   */
  processDown(raw) {
    const s = this.state;
    const cfg = this.settings;
    const cx = cfg.complexity / 100;
    const map = this.mapping[raw.code];

    // --- update the typing model (order matters: replay depends on it) ------
    const gap = raw.intervalFromPrevious;
    if (gap !== null) {
      s.intervals.push(gap);
      if (s.intervals.length > 12) s.intervals.shift();
    }
    s.repeat = raw.code === s.lastCode ? s.repeat + 1 : 0;
    if (s.lastHand && raw.hand !== 'both' && s.lastHand !== 'both') {
      s.altStreak = raw.hand !== s.lastHand ? s.altStreak + 1 : 0;
    }
    s.kps = raw.keysPerSecond;
    s.lastTime = raw.timestamp;

    const gv = groove(s.intervals);
    const inten = clamp(s.kps / 9, 0, 1);
    const restarting = gap !== null && gap > 1200; // R9

    if (!map) {
      s.lastCode = raw.code;
      s.lastHand = raw.hand;
      return { events: [], signal: null };
    }

    // --- transport keys ------------------------------------------------------
    if (map.zone === 'transport') {
      const out = this._transport(raw, map, inten, gv);
      s.lastCode = raw.code;
      s.lastHand = raw.hand;
      return out;
    }

    // --- expression common to every zone -------------------------------------
    // Typing has no velocity sensor. v0.1 leaned almost entirely on SPEED,
    // which meant "type faster" was the only way to play louder -- musically
    // thin, and it fought against playing accurately. Speed now mostly buys
    // brightness and density (below); loudness comes from the gestures a
    // typist can actually aim: accents after a pause, the head of a phrase,
    // and steadiness.
    let vel = 66 + inten * 18 + gv * 14;
    if (restarting) vel += 16; // R9 -- the strongest accent available
    if (s.noteInPhrase === 0) vel += 10; // downbeat of a phrase
    if (s.repeat > 0) vel -= Math.min(s.repeat * 4, 14); // rolls sit back
    if (raw.shift) vel += 6;
    vel = Math.round(clamp(vel, 20, 127));

    // stereo: your hands are the stereo field. R7 widens it.
    const wide = 0.3 + clamp(s.altStreak / 8, 0, 1) * 0.5;
    let pan = raw.hand === 'left' ? -wide : raw.hand === 'right' ? wide : 0;

    const fx = {
      delay: round3(clamp(0.06 + inten * 0.22 + gv * 0.12 * cx, 0, 0.5)),
      reverb: round3(clamp(0.12 + (restarting ? 0.35 : 0) + (1 - inten) * 0.18, 0, 0.8)),
      drive: round3(clamp(inten * 0.5 + cx * 0.2, 0, 1)),
      feedback: round3(clamp(0.15 + gv * 0.35, 0, 0.6)), // R8 groove lock
      // R6 -- speed opens the filter smoothly instead of transposing anything
      brightness: round3(clamp(0.28 + inten * 0.72, 0, 1)),
    };

    const events =
      map.zone === 'drum' || map.zone === 'lowfx'
        ? this._percussive(raw, map, { vel, pan, fx, inten, cx })
        : this._pitched(raw, map, { vel, pan, fx, inten, cx, restarting, kps: s.kps });

    s.noteInPhrase++;
    s.lastCode = raw.code;
    s.lastHand = raw.hand;
    return { events, signal: null };
  }

  // -------------------------------------------------------------------------
  _pitched(raw, map, ctx) {
    const s = this.state;
    const scale = this.scale;
    const cx = ctx.cx;
    const zone = ZONES[map.zone];
    let degree = map.degree ?? 0;
    let octave = (map.octave ?? 0) + zone.octave;
    let tag = 'scale';

    // R5 -- a long word walks the melody upward while you type it out
    // (Complexity tier 30-50: deliberate pitch movement becomes available.)
    if (cx >= 0.3 && map.zone === 'melody' && raw.word.length >= 6) {
      degree += clamp(raw.wordIndex - 2, 0, 4);
      tag = 'word-climb';
    }

    let midi;
    if (raw.shift && cx >= 0.15) {
      // R4 -- Shift is the deliberate "wrong note" pedal
      midi = tensionMidi(scale, degree, octave);
      tag = 'tension';
    } else {
      midi = degreeToMidi(scale, degree, octave);
    }

    // R2 -- repeating a key walks chromatically. This is how you get notes
    // that are not in the scale on purpose, and get them back on purpose.
    // (Complexity tier 30-50. Below that, repeats still change articulation.)
    if (s.repeat > 0 && cx >= 0.3) {
      midi += Math.min(s.repeat, 4);
      tag = tag === 'scale' ? 'chromatic' : tag + '+chromatic';
    }

    // R7 -- once the hands are really ping-ponging, every other note is a 5th
    if (cx >= 0.5 && s.altStreak >= 6 && s.altStreak % 2 === 1) {
      midi += 7;
      tag = tag === 'scale' ? 'alt-fifth' : tag + '+alt-fifth';
    }

    const dur = this._defaultDuration(map.zone, ctx.inten);
    const base = {
      time: round3(raw.timestamp),
      sourceSeq: raw.seq,
      sourceKey: raw.char ?? raw.code,
      sourceCode: raw.code,
      instrument: map.zone,
      part: map.part || null,
      note: midi,
      freq: round3(midiToFreq(midi)),
      duration: dur,
      gated: true, // R1: real length comes from how long you hold the key
      velocity: ctx.vel,
      pan: round3(ctx.pan),
      fx: ctx.fx,
      tag,
    };

    const out = [base];

    // chords are three deterministic scale tones, never a random voicing
    if (map.zone === 'chord') {
      base.chord = [0, 2, 4].map((d) => degreeToMidi(scale, (map.degree ?? 0) + d, (map.octave ?? 0) + zone.octave));
    }

    // R6 -- speed adds an octave LAYER that fades in, rather than transposing
    // the note you actually played. Crossing 6 keys/sec is no longer a cliff:
    // between 5.5 and 9 kps this layer rises from silence to full, so drifting
    // a little faster or slower only shifts the colour a little.
    if (map.zone === 'melody' || map.zone === 'bell') {
      const blend = clamp((ctx.kps - 5.5) / 3.5, 0, 1);
      if (blend > 0.02) {
        out.push(Object.assign({}, base, {
          note: midi + 12,
          freq: round3(midiToFreq(midi + 12)),
          velocity: Math.round(ctx.vel * 0.55 * blend),
          pan: round3(-ctx.pan),
          gated: false,
          duration: round3(dur * 0.7),
          tag: 'octave-layer',
        }));
      }
    }

    // Complexity tier 70-100 -- every 4th note of a phrase gets a sub body
    if (cx >= 0.7 && s.noteInPhrase % 4 === 3 && map.zone !== 'bass') {
      out.push(Object.assign({}, base, {
        note: midi - 12,
        freq: round3(midiToFreq(midi - 12)),
        velocity: Math.round(ctx.vel * 0.55),
        gated: false,
        instrument: 'bass',
        duration: round3(dur * 1.2),
        tag: 'sub-double',
      }));
    }

    s.lastPitched = base;
    return out;
  }

  // -------------------------------------------------------------------------
  _percussive(raw, map, ctx) {
    const s = this.state;
    const out = [];
    const ev = {
      time: round3(raw.timestamp),
      sourceSeq: raw.seq,
      sourceKey: raw.char ?? raw.code,
      sourceCode: raw.code,
      instrument: map.zone,
      part: map.part,
      note: null,
      duration: 0.18,
      gated: false,
      velocity: ctx.vel,
      pan: round3(ctx.pan * 0.6),
      fx: ctx.fx,
      // R2 on percussion: repeats tighten and raise the pitch of the hit
      tune: s.repeat > 0 ? Math.min(s.repeat, 5) * 0.06 : 0,
      tag: s.repeat > 0 ? 'repeat' : 'hit',
    };
    out.push(ev);

    // R3 -- four or more of the same key becomes a real roll
    if (s.repeat >= 3) {
      const n = Math.min(s.repeat - 2, 3);
      const step = clamp((raw.intervalFromPrevious || 120) / 1000 / (n + 1), 0.018, 0.09);
      for (let i = 1; i <= n; i++) {
        out.push(Object.assign({}, ev, {
          time: round3(raw.timestamp + step * i),
          velocity: Math.round(ctx.vel * (0.72 - i * 0.1)),
          tune: ev.tune + i * 0.05,
          tag: 'ratchet',
        }));
      }
    }
    return out;
  }

  // -------------------------------------------------------------------------
  _transport(raw, map, inten, gv) {
    const t = round3(raw.timestamp);
    const fx = { delay: 0.1, reverb: 0.25, drive: 0.2, feedback: 0.2, brightness: round3(clamp(0.28 + inten * 0.72, 0, 1)) };
    const s = this.state;

    if (map.part === 'ghost') {
      // Space: the breath between words. Quiet tick + phrase boundary.
      s.phraseIndex++;
      s.noteInPhrase = 0;
      return {
        events: [{
          time: t, sourceSeq: raw.seq, sourceKey: ' ', sourceCode: 'Space',
          instrument: 'drum', part: 'ghost', note: null, duration: 0.06,
          gated: false, velocity: Math.round(28 + inten * 30), pan: 0, fx,
          tune: 0, tag: 'phrase-mark',
        }],
        signal: 'phrase',
      };
    }

    if (map.part === 'impact') {
      s.phraseIndex++;
      s.noteInPhrase = 0;
      return {
        events: [{
          time: t, sourceSeq: raw.seq, sourceKey: '\n', sourceCode: 'Enter',
          instrument: 'lowfx', part: 'impact', note: null, duration: 0.9,
          gated: false, velocity: Math.round(78 + gv * 30), pan: 0,
          fx: { delay: 0.2, reverb: 0.5, drive: 0.4, feedback: 0.35, brightness: 0.8 },
          tune: 0, tag: 'layer-commit',
        }],
        signal: 'layer',
      };
    }

    if (map.part === 'reverse') {
      // R10 -- Backspace plays the tail of what you just played, backwards.
      //
      // It deletes a CHARACTER, not a NOTE. v0.1 also popped the last pending
      // event, which (because the reverse event had already been queued) really
      // just deleted itself -- the comment and the behaviour disagreed. A
      // Backspace you hear is a Backspace you played, so it stays in the layer
      // like every other note and replays identically.
      const prev = s.lastPitched;
      s.noteInPhrase++;
      return {
        events: [{
          time: t, sourceSeq: raw.seq, sourceKey: '\b', sourceCode: 'Backspace',
          instrument: 'fx', part: 'reverse', note: prev ? prev.note : null,
          freq: prev ? prev.freq : 220, duration: 0.28, gated: false,
          velocity: 70, pan: 0,
          fx: { delay: 0.25, reverb: 0.45, drive: 0.2, feedback: 0.3, brightness: 0.5 },
          tune: 0, tag: 'rewind',
        }],
        signal: null,
      };
    }

    // Tab -- a fill/riser, useful right before an Enter
    return {
      events: [{
        time: t, sourceSeq: raw.seq, sourceKey: '\t', sourceCode: 'Tab',
        instrument: 'fx', part: 'riser', note: null, duration: 0.6,
        gated: false, velocity: 80, pan: 0,
        fx: { delay: 0.2, reverb: 0.4, drive: 0.3, feedback: 0.3, brightness: 0.9 },
        tune: 0, tag: 'fill',
      }],
      signal: null,
    };
  }

  _defaultDuration(zone, inten) {
    const beat = 60 / this.settings.bpm;
    const base = { bass: 0.55, melody: 0.45, bell: 0.9, chord: 1.1, voice: 0.5 }[zone] || 0.4;
    return round3(base * beat * 2 * (1.15 - inten * 0.45));
  }

  /** keyup: R1 -- the note stops when your finger stops. */
  processUp(raw) {
    return { seq: raw.seq, holdMs: raw.holdMs };
  }
}

/**
 * R1, written into the performance data: a gated note's length is how long the
 * key was held, floored at 80 ms.
 *
 * This is the OFFLINE form, used when the hold is already known (re-rendering a
 * finished take). The live path cannot use it at keydown, because the hold has
 * not happened yet -- see LoopEngine.applyHoldBySeq, which addresses notes by
 * sourceSeq once the key finally comes up.
 */
export function applyHold(events, holdMs) {
  if (holdMs === null || holdMs === undefined) return events;
  for (const e of events) {
    if (e.gated) e.duration = round3(Math.max(holdMs / 1000, 0.08));
  }
  return events;
}

/**
 * Headless re-run of a whole raw event list. Used by the determinism
 * self-test and by session verification -- no audio involved.
 */
export function renderOffline(rawEvents, mapping, settings) {
  const eng = new PerformanceEngine(mapping, settings);
  const out = [];
  for (const raw of rawEvents) {
    if (!raw.keydown) continue;
    const r = eng.processDown(raw);
    applyHold(r.events, raw.holdMs);
    for (const e of r.events) out.push(e);
  }
  return out;
}

export { PITCHED };
