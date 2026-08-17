// ---------------------------------------------------------------------------
// BUILT-IN LOOPS  --  the floor you stand on.
//
// Typing alone rarely produces a stable beat on day one, so the user can drop
// a foundation in with one button and start playing on top of it immediately.
// These are plain PerformanceEvent lists, i.e. exactly the same data type the
// typing produces -- the loop engine cannot tell them apart.
// ---------------------------------------------------------------------------

import { degreeToMidi, midiToFreq } from '../perf/scale.js';
import { round3 } from '../core/hash.js';

const FX = { delay: 0.05, reverb: 0.12, drive: 0.2, feedback: 0.2 };

function hit(step16, part, velocity, extra = {}) {
  return Object.assign(
    {
      step: step16,
      instrument: part === 'sub' || part === 'boom' || part === 'ride' ? 'lowfx' : 'drum',
      part,
      note: null,
      duration: 0.2,
      gated: false,
      velocity,
      pan: 0,
      fx: FX,
      tune: 0,
      tag: 'builtin',
    },
    extra
  );
}

function tone(step16, zone, degree, octave, velocity, dur, extra = {}) {
  return Object.assign(
    {
      step: step16,
      instrument: zone,
      part: null,
      degree,
      octave,
      note: null,
      duration: dur,
      gated: false,
      velocity,
      pan: 0,
      fx: FX,
      tune: 0,
      tag: 'builtin',
    },
    extra
  );
}

export const BUILTIN_LOOPS = {
  beat: {
    label: 'Beat',
    bars: 1,
    build: () => [
      hit(0, 'kick', 110), hit(4, 'hat', 55), hit(6, 'hat', 38),
      hit(8, 'snare', 100), hit(10, 'hat', 45), hit(12, 'kick', 92),
      hit(14, 'hat', 50), hit(15, 'hat', 34),
      hit(2, 'hat', 40),
    ],
  },
  minimal: {
    label: 'Minimal',
    bars: 2,
    build: () => [
      hit(0, 'kick', 104), hit(8, 'hat', 44), hit(12, 'snare', 78),
      hit(16, 'kick', 96), hit(22, 'hat', 40), hit(24, 'hat', 48),
      hit(28, 'snare', 82), hit(30, 'ride', 34),
    ],
  },
  bass: {
    label: 'Bass',
    bars: 2,
    build: () => [
      tone(0, 'bass', 0, -2, 100, 0.42), tone(6, 'bass', 0, -2, 74, 0.2),
      tone(8, 'bass', 2, -2, 88, 0.32), tone(14, 'bass', 1, -2, 70, 0.2),
      tone(16, 'bass', 0, -2, 100, 0.42), tone(22, 'bass', 3, -2, 76, 0.24),
      tone(24, 'bass', 4, -2, 84, 0.3), tone(30, 'bass', 2, -2, 68, 0.2),
    ],
  },
  ambient: {
    label: 'Ambient',
    bars: 4,
    build: () => [
      tone(0, 'chord', 0, -1, 66, 1.8, { chordDegrees: [0, 2, 4], fx: { delay: 0.2, reverb: 0.6, drive: 0.1, feedback: 0.3 } }),
      tone(16, 'chord', 2, -1, 58, 1.8, { chordDegrees: [2, 4, 6], fx: { delay: 0.2, reverb: 0.6, drive: 0.1, feedback: 0.3 } }),
      tone(32, 'chord', 3, -1, 62, 1.8, { chordDegrees: [3, 5, 7], fx: { delay: 0.2, reverb: 0.6, drive: 0.1, feedback: 0.3 } }),
      tone(48, 'chord', 1, -1, 54, 1.8, { chordDegrees: [1, 3, 5], fx: { delay: 0.2, reverb: 0.6, drive: 0.1, feedback: 0.3 } }),
      tone(8, 'bell', 4, 1, 40, 0.9), tone(40, 'bell', 2, 1, 36, 0.9),
    ],
  },
  pulse: {
    label: 'Pulse',
    bars: 1,
    build: () => [
      hit(0, 'sub', 96), hit(3, 'noise', 52), hit(6, 'hat', 44),
      hit(8, 'sub', 84), hit(9, 'noise', 48), hit(12, 'boom', 76),
      hit(14, 'noise', 60),
    ],
  },
};

/**
 * Turn a pattern into concrete PerformanceEvents positioned in BEATS.
 * Tempo is applied at playback time, so a built-in loop follows the tempo
 * knob instead of being frozen at whatever the BPM was when it was added.
 *
 * @returns {{name:string, lengthBeats:number, events:{b:number, ev:object}[]}}
 */
export function buildLoop(key, scale) {
  const def = BUILTIN_LOOPS[key];
  const lengthBeats = def.bars * 4;
  const events = def.build().map((p, i) => {
    const ev = Object.assign({}, p);
    delete ev.step;
    delete ev.degree;
    delete ev.octave;
    delete ev.chordDegrees;
    ev.sourceSeq = -1000 - i;
    ev.sourceKey = key;
    ev.sourceCode = 'builtin';
    const b = round3(p.step / 4); // 16th steps -> beats
    ev.time = b;
    if (p.degree !== undefined) {
      const midi = degreeToMidi(scale, p.degree, p.octave || 0);
      ev.note = midi;
      ev.freq = round3(midiToFreq(midi));
      if (p.chordDegrees) {
        ev.chord = p.chordDegrees.map((d) => degreeToMidi(scale, d, p.octave || 0));
      }
    }
    return { b, ev };
  });
  return { name: def.label, lengthBeats, events };
}
