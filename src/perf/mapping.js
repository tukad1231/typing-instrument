// ---------------------------------------------------------------------------
// MAPPING  --  which physical key belongs to which "playing zone".
//
// This file is DATA, not logic. The performance engine reads it; nothing here
// knows about Web Audio. Swap this object and the whole instrument re-tunes
// without touching the typing analysis.
//
// Zone layout (QWERTY, the layout the user's fingers already memorised):
//
//   1 2 3 4 5 6 7 8 9 0     -> chord   (harmonic bed)
//   Q W E R T | Y U I O P   -> bass    | bell
//   A S D F G | H J K L ;   -> drum    | melody     <- home row = the anchor
//   Z X C V B | N M , . /   -> lowfx   | voice
//
// `degree` is an index into the current scale (see scale.js), NOT a semitone.
// `part` is the drum/fx piece name for non-pitched zones.
// ---------------------------------------------------------------------------

export const ZONES = {
  bass: { label: 'Bass', octave: -2, hand: 'left' },
  drum: { label: 'Drums', octave: 0, hand: 'left' },
  lowfx: { label: 'Low FX', octave: -1, hand: 'left' },
  bell: { label: 'Bell', octave: 1, hand: 'right' },
  melody: { label: 'Melody', octave: 0, hand: 'right' },
  voice: { label: 'Voice', octave: 0, hand: 'right' },
  chord: { label: 'Chord', octave: -1, hand: 'both' },
  transport: { label: 'Transport', octave: 0, hand: 'both' },
};

function k(zone, opts) {
  return Object.assign({ zone }, opts);
}

export const DEFAULT_MAPPING = {
  name: 'qwerty-v1',

  // ---- left top : BASS -----------------------------------------------------
  KeyQ: k('bass', { degree: 0 }),
  KeyW: k('bass', { degree: 1 }),
  KeyE: k('bass', { degree: 2 }),
  KeyR: k('bass', { degree: 3 }),
  KeyT: k('bass', { degree: 4 }),

  // ---- left home : DRUMS ---------------------------------------------------
  KeyA: k('drum', { part: 'kick' }),
  KeyS: k('drum', { part: 'snare' }),
  KeyD: k('drum', { part: 'hat' }),
  KeyF: k('drum', { part: 'snare' }),
  KeyG: k('drum', { part: 'clap' }),

  // ---- left bottom : LOW PERC / FX ----------------------------------------
  KeyZ: k('lowfx', { part: 'sub' }),
  KeyX: k('lowfx', { part: 'noise' }),
  KeyC: k('lowfx', { part: 'ride' }),
  KeyV: k('lowfx', { part: 'tom' }),
  KeyB: k('lowfx', { part: 'boom' }),

  // ---- right top : BELL / TEXTURE -----------------------------------------
  KeyY: k('bell', { degree: 0 }),
  KeyU: k('bell', { degree: 1 }),
  KeyI: k('bell', { degree: 2 }),
  KeyO: k('bell', { degree: 3 }),
  KeyP: k('bell', { degree: 4 }),
  BracketLeft: k('bell', { degree: 5 }),
  BracketRight: k('bell', { degree: 6 }),

  // ---- right home : MELODY  (the lead voice) ------------------------------
  KeyH: k('melody', { degree: 0 }),
  KeyJ: k('melody', { degree: 1 }),
  KeyK: k('melody', { degree: 2 }),
  KeyL: k('melody', { degree: 3 }),
  Semicolon: k('melody', { degree: 4 }),
  Quote: k('melody', { degree: 5 }),

  // ---- right bottom : VOICE / NOISE ---------------------------------------
  KeyN: k('voice', { degree: 0, part: 'aa' }),
  KeyM: k('voice', { degree: 2, part: 'oo' }),
  Comma: k('voice', { degree: 3, part: 'ee' }),
  Period: k('voice', { degree: 4, part: 'uu' }),
  Slash: k('voice', { degree: 5, part: 'ss' }),

  // ---- number row : CHORD STABS -------------------------------------------
  Digit1: k('chord', { degree: 0 }),
  Digit2: k('chord', { degree: 1 }),
  Digit3: k('chord', { degree: 2 }),
  Digit4: k('chord', { degree: 3 }),
  Digit5: k('chord', { degree: 4 }),
  Digit6: k('chord', { degree: 0, octave: 1 }),
  Digit7: k('chord', { degree: 1, octave: 1 }),
  Digit8: k('chord', { degree: 2, octave: 1 }),
  Digit9: k('chord', { degree: 3, octave: 1 }),
  Digit0: k('chord', { degree: 4, octave: 1 }),
  Minus: k('bell', { degree: 7 }),
  Equal: k('bell', { degree: 8 }),

  // ---- transport keys ------------------------------------------------------
  Space: k('transport', { part: 'ghost' }), // + phrase commit
  Enter: k('transport', { part: 'impact' }), // + layer commit
  NumpadEnter: k('transport', { part: 'impact' }),
  Backspace: k('transport', { part: 'reverse' }),
  Tab: k('transport', { part: 'fill' }),
};

const LEFT = new Set([
  'Backquote','Digit1','Digit2','Digit3','Digit4','Digit5',
  'KeyQ','KeyW','KeyE','KeyR','KeyT',
  'KeyA','KeyS','KeyD','KeyF','KeyG',
  'KeyZ','KeyX','KeyC','KeyV','KeyB',
  'Tab','CapsLock','ShiftLeft','ControlLeft','AltLeft',
]);

const ROWS = {
  number: /^(Digit|Backquote|Minus|Equal)/,
  top: /^(KeyQ|KeyW|KeyE|KeyR|KeyT|KeyY|KeyU|KeyI|KeyO|KeyP|Bracket|Backslash|Tab)/,
  home: /^(KeyA|KeyS|KeyD|KeyF|KeyG|KeyH|KeyJ|KeyK|KeyL|Semicolon|Quote|Enter|CapsLock)/,
  bottom: /^(KeyZ|KeyX|KeyC|KeyV|KeyB|KeyN|KeyM|Comma|Period|Slash)/,
};

export function handOf(code) {
  if (code === 'Space') return 'both';
  return LEFT.has(code) ? 'left' : 'right';
}

export function rowOf(code) {
  for (const r of Object.keys(ROWS)) if (ROWS[r].test(code)) return r;
  if (code === 'Space') return 'space';
  return 'other';
}

/** Human-readable mapping snapshot, saved into the session export. */
export function describeMapping(mapping, scaleName) {
  const out = {};
  for (const code of Object.keys(mapping)) {
    if (code === 'name') continue;
    const m = mapping[code];
    const label = code.replace(/^(Key|Digit)/, '');
    out[label] =
      m.part && m.degree === undefined
        ? `${ZONES[m.zone].label} / ${m.part}`
        : `${ZONES[m.zone].label} / ${scaleName} degree ${m.degree}`;
  }
  return out;
}
