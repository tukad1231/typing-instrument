// Deterministic helpers. NO Math.random() anywhere in this project.
//
// Everything that looks "random" (noise buffers, reverb impulse responses,
// deterministic detune) is derived from a fixed seed or from the typed text
// itself.
//
// What that buys is narrower than it sounds: the noise and reverb MATERIAL is
// regenerated identically every run, so no two sessions differ because of a
// different random draw. It does NOT make a replay sound identical -- the
// synth's shared delay feedback, pause macro and tempo-locked delay time are
// live state that depends on surrounding events. See README, "Levels of
// determinism": notes are guaranteed, ambience is best effort.

/** FNV-1a 32bit. Same string -> same number, forever. */
export function hashString(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** Seeded LCG. Used only for offline buffer generation (noise / impulse). */
export function lcg(seed) {
  let s = (seed >>> 0) || 1;
  return function next() {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

export function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

export function round3(v) {
  return Math.round(v * 1000) / 1000;
}
