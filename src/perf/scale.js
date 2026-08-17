// ---------------------------------------------------------------------------
// SCALE  --  pitch material.
//
// The user never sees the word "scale". They see "Sound: Electronic".
// Internally each sound world carries its own tonal colour so that switching
// Sound really does make a different piece of music, not just a different EQ.
//
// Out-of-scale notes are ALLOWED, but only through the deterministic tension
// rules in performanceEngine.js -- never at random.
// ---------------------------------------------------------------------------

export const SCALES = {
  // minor pentatonic: nothing can clash, good first-five-minutes experience
  electronic: {
    name: 'minor-pentatonic',
    root: 57, // A3
    steps: [0, 3, 5, 7, 10],
    tension: [1, 6, 11, 2, 8], // reachable only via Shift / repeats / complexity
  },
  // dorian flavour: warmer, slightly jazzier, still forgiving
  minimal: {
    name: 'dorian-pentatonic',
    root: 55, // G3
    steps: [0, 2, 3, 7, 9],
    tension: [5, 10, 6, 1, 4],
  },
  // phrygian: darker, tension notes are much harsher on purpose
  noise: {
    name: 'phrygian',
    root: 52, // E3
    steps: [0, 1, 5, 7, 8],
    tension: [3, 6, 10, 2, 11],
  },
};

/** degree -> midi note. Degrees below 0 / above length wrap with octaves. */
export function degreeToMidi(scale, degree, octave = 0) {
  const n = scale.steps.length;
  const oct = Math.floor(degree / n) + octave;
  const idx = ((degree % n) + n) % n;
  return scale.root + scale.steps[idx] + oct * 12;
}

/** Deterministic "wrong" note, picked by index -- same index, same note. */
export function tensionMidi(scale, index, octave = 0) {
  const t = scale.tension[((index % scale.tension.length) + scale.tension.length) % scale.tension.length];
  return scale.root + t + octave * 12;
}

export function midiToFreq(midi) {
  return 440 * Math.pow(2, (midi - 69) / 12);
}
