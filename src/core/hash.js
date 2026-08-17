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

/**
 * A deep copy that keeps VALUE TYPES intact.
 *
 * `JSON.parse(JSON.stringify(x))` was the old habit and it lies in ways that
 * matter here: `undefined` disappears, `NaN` and `Infinity` become `null`, and
 * a Date turns into a string. A pending note carries numbers that must survive
 * verbatim, so the clone has to be structural, not textual.
 *
 * `structuredClone` is the browser's own implementation of exactly this and is
 * available everywhere this app runs. The manual walk below is the fallback for
 * older engines, and it deliberately handles only what this project stores:
 * primitives, plain objects and arrays. Anything else (a function, an
 * AudioNode, a DOM element) is not project data and must never be cloned into
 * a saved document -- it is dropped, which is the honest outcome.
 */
export function deepClone(v) {
  if (v === null || typeof v !== 'object') return v;
  if (typeof structuredClone === 'function') return structuredClone(v);
  return manualClone(v);
}

function manualClone(v) {
  if (v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map(manualClone);
  if (v instanceof Date) return new Date(v.getTime());
  const out = {};
  for (const k of Object.keys(v)) {
    const c = v[k];
    if (typeof c === 'function') continue;
    out[k] = manualClone(c);
  }
  return out;
}

/**
 * True when a value can survive `structuredClone` -- i.e. when it is safe to
 * hand to IndexedDB. Saving something that cannot be cloned throws INSIDE the
 * transaction, which is the worst place to find out.
 */
export function isStorable(v, depth = 0) {
  if (depth > 64) return false;
  if (v === null) return true;
  const t = typeof v;
  if (t === 'string' || t === 'boolean') return true;
  if (t === 'number') return Number.isFinite(v);
  if (t === 'undefined') return true;
  if (t === 'function' || t === 'symbol' || t === 'bigint') return false;
  if (Array.isArray(v)) return v.every((x) => isStorable(x, depth + 1));
  if (Object.getPrototypeOf(v) !== Object.prototype && Object.getPrototypeOf(v) !== null) return false;
  return Object.keys(v).every((k) => isStorable(v[k], depth + 1));
}

/**
 * JSON with object keys in a fixed order, so that two structurally equal
 * documents always produce the same string -- and therefore the same hash --
 * regardless of the order their fields happened to be assigned in.
 */
export function stableStringify(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v === undefined ? null : v);
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
  const keys = Object.keys(v).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(v[k])).join(',') + '}';
}

/**
 * 64-bit FNV-1a, as 16 hex characters.
 *
 * This is an INTEGRITY check, not a cryptographic one: it answers "did this
 * document come back exactly as it went in", and it is what the project store
 * and the duplicate test compare. It is deliberately synchronous -- SubtleCrypto
 * would force every comparison in the self-tests to become async for no gain
 * against an adversary that does not exist here. (An asset sampler WOULD need
 * SHA-256; see docs/SAMPLER_DESIGN.md.)
 */
export function hash64(str) {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ (c + i), 0x85ebca6b) >>> 0;
  }
  return (h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0');
}

/** hash of any structure, independent of key order */
export function hashValue(v) {
  return hash64(stableStringify(v));
}
