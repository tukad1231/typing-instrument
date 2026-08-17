// ---------------------------------------------------------------------------
// SOUND WORLDS  --  the same typing, three different pieces of music.
//
//     Sound World = timbre + tonal material + character
//
// Naming this honestly matters. These are not just EQ presets: picking a Sound
// also picks the scale and root it is paired with (see scale.js), because a
// beginner should be able to change "how it sounds" with one control and get a
// genuinely different piece rather than a filtered version of the same one.
//
// What a Sound World may NOT do is change which KEY plays which ROLE. The
// mapping is fixed, so muscle memory carries across every world.
//
// (Future: a user-recorded WAV set plugs in here as `type: 'sampler'`.)
// ---------------------------------------------------------------------------

export const SOUND_SETS = {
  electronic: {
    label: 'Electronic',
    hint: 'clean synth, club-ready',
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
};
