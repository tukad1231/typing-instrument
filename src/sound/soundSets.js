// ---------------------------------------------------------------------------
// SOUND WORLDS  --  the same typing, five different pieces of music.
//
//     Sound World = synthesis model + timbre + tonal material + character
//
// Naming this honestly matters. These are not just EQ presets: picking a Sound
// also picks the scale and root it is paired with (see scale.js), because a
// beginner should be able to change "how it sounds" with one control and get a
// genuinely different piece rather than a filtered version of the same one.
//
// What a Sound World may NOT do is change which KEY plays which ROLE. The
// mapping is fixed, so muscle memory carries across every world.
//
// -- `model` (new in v0.3) --------------------------------------------------
// A world names the SYNTHESIS MODEL its sustaining roles (bass, melody, chord,
// voice) use:
//
//   'gated'  attack, hold at a constant level for as long as the key is down,
//            release. Electronic / Minimal / Noise.
//   'piano'  struck. Loudest the instant it is hit and always decaying after
//            that, even while the key is still held. Releasing damps it faster;
//            it does not chop the tail off.
//   'pluck'  a short excitation into a resonant body. Same decaying contract,
//            shorter and brighter.
//
// This is the one place a world may change HOW a role sounds. Drums, FX and
// bells are one-shots in every world and never wait for a key to come up.
//
// (Future: a user-recorded WAV set plugs in here as `model: 'sampler'`. See
// docs/SAMPLER_DESIGN.md -- deliberately NOT implemented in v0.3.)
// ---------------------------------------------------------------------------

export const SOUND_SETS = {
  electronic: {
    label: 'Electronic',
    hint: 'clean synth, club-ready',
    model: 'gated',
    bass: { wave: 'sawtooth', cutoff: 900, q: 6, detune: 7, attack: 0.004, release: 0.16 },
    melody: { wave: 'square', cutoff: 2600, q: 3, detune: 9, attack: 0.004, release: 0.14 },
    bell: { ratio: 3.5, index: 620, decay: 1.0 },
    chord: { wave: 'triangle', attack: 0.05, release: 0.5, cutoff: 2200 },
    voice: { formants: [700, 1220, 2600], q: 9, noise: 0.35 },
    drum: { tone: 1.0, decay: 1.0, noise: 1.0, click: 1.0 },
    drive: 0.14,
    delayTime: 0.1875, // dotted-ish, recalculated against bpm at runtime
    reverbSeconds: 1.8,
    master: 0.9,
  },

  minimal: {
    label: 'Minimal',
    hint: 'soft, lo-fi, room-y',
    model: 'gated',
    bass: { wave: 'triangle', cutoff: 520, q: 3, detune: 4, attack: 0.012, release: 0.3 },
    melody: { wave: 'triangle', cutoff: 1500, q: 2, detune: 5, attack: 0.014, release: 0.28 },
    bell: { ratio: 2.0, index: 260, decay: 1.7 },
    chord: { wave: 'sine', attack: 0.18, release: 1.1, cutoff: 1400 },
    voice: { formants: [520, 980, 2100], q: 6, noise: 0.2 },
    drum: { tone: 0.85, decay: 1.5, noise: 0.6, click: 0.5 },
    drive: 0.06,
    delayTime: 0.25,
    reverbSeconds: 2.8,
    master: 0.95,
  },

  noise: {
    label: 'Noise',
    hint: 'harsh, industrial, loud',
    model: 'gated',
    bass: { wave: 'square', cutoff: 1600, q: 10, detune: 18, attack: 0.001, release: 0.08 },
    melody: { wave: 'sawtooth', cutoff: 4200, q: 8, detune: 22, attack: 0.001, release: 0.07 },
    bell: { ratio: 5.9, index: 1400, decay: 0.7 },
    chord: { wave: 'sawtooth', attack: 0.01, release: 0.3, cutoff: 3200 },
    voice: { formants: [900, 1700, 3400], q: 14, noise: 0.75 },
    drum: { tone: 1.2, decay: 0.7, noise: 1.6, click: 1.6 },
    drive: 0.45,
    delayTime: 0.125,
    reverbSeconds: 1.1,
    master: 0.8,
  },

  // -------------------------------------------------------------------------
  // PIANO -- struck strings.
  //
  // The `struck` block is what makes it read as a piano rather than as a pad
  // with a fast attack:
  //
  //   partials    [ratio, level, decayScale]. Real strings are slightly SHARP
  //               in the upper partials, so 2.0/3.0 become 2.003/3.012, and
  //               each partial dies faster than the one below it. Without both
  //               of those the tone is a clean organ.
  //   decayLow /  seconds to near-silence at the bottom and the top of the
  //   decayHigh   range. A low C rings for many seconds; the top octave is gone
  //               in about one. Using ONE figure for the whole keyboard is the
  //               most obvious "this is not a piano" tell there is.
  //   damp        how long the felt takes to stop the string on key release.
  //               Deliberately NOT zero: a hard cut is a click, and it sounds
  //               like an edit rather than like playing.
  // -------------------------------------------------------------------------
  piano: {
    label: 'Piano',
    hint: 'struck strings — it decays on its own',
    model: 'piano',
    struck: {
      partials: [
        [1, 1.0, 1.0],
        [2.003, 0.44, 0.7],
        [3.012, 0.22, 0.5],
        [4.028, 0.12, 0.36],
        [5.05, 0.06, 0.26],
        [6.08, 0.03, 0.19],
      ],
      attack: 0.004,
      decayLow: 7.5, // at midi 36
      decayHigh: 1.0, // at midi 96
      damp: 0.24,
      dampHigh: 0.09,
      hammer: 0.4, // level of the short noise thud of the hammer
      cutoff: 5200,
    },
    bass: { wave: 'triangle', cutoff: 700, q: 2, detune: 3, attack: 0.006, release: 0.35 },
    melody: { wave: 'triangle', cutoff: 2000, q: 2, detune: 4, attack: 0.005, release: 0.3 },
    bell: { ratio: 2.01, index: 240, decay: 2.2 },
    chord: { wave: 'triangle', attack: 0.02, release: 0.9, cutoff: 1800 },
    voice: { formants: [560, 1060, 2300], q: 7, noise: 0.18 },
    drum: { tone: 0.9, decay: 1.1, noise: 0.45, click: 0.6 },
    drive: 0.04,
    delayTime: 0.25,
    reverbSeconds: 2.6,
    master: 1.0,
  },

  // -------------------------------------------------------------------------
  // PLUCKED -- a short excitation into a resonant body.
  //
  // NOT a Karplus-Strong delay loop. A feedback cycle in Web Audio cannot run
  // shorter than one render quantum (128 frames), which puts a floor of about
  // 344 Hz on the pitch and makes the whole top of the range wrong. An
  // excitation burst into a body whose filter closes as it decays produces the
  // same gesture with none of that, and it stays deterministic because the
  // burst is read out of the seeded noise buffer at an offset derived from the
  // note itself -- no Math.random(), and the same event always sounds the same.
  // -------------------------------------------------------------------------
  plucked: {
    label: 'Plucked',
    hint: 'wood and wire — short, warm, repeatable',
    model: 'pluck',
    struck: {
      partials: [
        [1, 1.0, 1.0],
        [2, 0.32, 0.58],
        [3, 0.15, 0.38],
        [4.02, 0.06, 0.25],
      ],
      attack: 0.002,
      decayLow: 3.2, // at midi 36
      decayHigh: 0.55, // at midi 96
      damp: 0.13,
      dampHigh: 0.055,
      hammer: 0.75, // here it is the pick noise, and it should be audible
      exciteSeconds: 0.009,
      bodyOpen: 7.0, // the body filter starts at freq * this ...
      bodyClose: 1.35, // ... and closes to freq * this
      cutoff: 6000,
    },
    bass: { wave: 'triangle', cutoff: 620, q: 3, detune: 4, attack: 0.005, release: 0.28 },
    melody: { wave: 'triangle', cutoff: 1900, q: 3, detune: 6, attack: 0.004, release: 0.24 },
    bell: { ratio: 3.01, index: 320, decay: 1.4 },
    chord: { wave: 'triangle', attack: 0.03, release: 0.7, cutoff: 1700 },
    voice: { formants: [600, 1150, 2400], q: 8, noise: 0.22 },
    drum: { tone: 0.95, decay: 1.0, noise: 0.55, click: 0.8 },
    drive: 0.07,
    delayTime: 0.1875,
    reverbSeconds: 1.9,
    master: 1.0,
  },
};

/**
 * The order the picker shows them in. Electronic first because it flatters a
 * beginner's timing; the two acoustic worlds next, because they reward
 * phrasing and the space between notes rather than speed.
 */
export const SOUND_WORLD_ORDER = ['electronic', 'piano', 'plucked', 'minimal', 'noise'];

/** true when this world's sustaining roles decay by themselves */
export function isStruck(name) {
  const s = SOUND_SETS[name];
  return !!s && (s.model === 'piano' || s.model === 'pluck');
}
