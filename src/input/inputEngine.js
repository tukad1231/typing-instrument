// ---------------------------------------------------------------------------
// INPUT ENGINE  --  turns a keyboard into a stream of RawTypingEvents.
//
// This layer knows NOTHING about music. Its only job is to describe, as
// precisely as possible, what the hands actually did:
//   what key, which hand, which row, how long held, how long since the last
//   one, how fast we are going right now, which word we are inside.
//
// IME note: the musical performance is driven by PHYSICAL keys (e.code), so
// typing "フジロック" performs f-u-j-i-r-o-k-k-u. The visible text is handled
// separately by the textarea itself.
// ---------------------------------------------------------------------------

import { DEFAULT_MAPPING, handOf, rowOf } from '../perf/mapping.js';

const PHYSICAL_CHAR = {}; // code -> unshifted character
'QWERTYUIOPASDFGHJKLZXCVBNM'.split('').forEach((c) => {
  PHYSICAL_CHAR['Key' + c] = c.toLowerCase();
});
'1234567890'.split('').forEach((c) => {
  PHYSICAL_CHAR['Digit' + c] = c;
});
Object.assign(PHYSICAL_CHAR, {
  Space: ' ',
  Minus: '-',
  Equal: '=',
  BracketLeft: '[',
  BracketRight: ']',
  Semicolon: ';',
  Quote: "'",
  Comma: ',',
  Period: '.',
  Slash: '/',
  Backslash: '\\',
  Backquote: '`',
  Enter: '\n',
  Tab: '\t',
  Backspace: '\b',
});

const WORD_BREAK = new Set(['Space', 'Enter', 'NumpadEnter', 'Tab', 'Escape']);

// While a Japanese IME is composing, Space means "next candidate" and Enter
// means "confirm". Those are text operations, not musical ones -- committing a
// loop layer because someone finished writing a word would make the instrument
// unusable in Japanese. So these two keys are ignored entirely during
// composition (no sound, no transport), and every other key still plays.
const TRANSPORT_KEYS = new Set(['Space', 'Enter', 'NumpadEnter']);

// Some environments (remote desktop, on-screen keyboards, a few IME paths and
// automation) deliver KeyboardEvents with an empty `code`. Physical layout is
// the whole point of this instrument, so fall back to deriving it from `key`.
const KEY_TO_CODE = (() => {
  const m = {};
  for (const c of 'abcdefghijklmnopqrstuvwxyz') {
    m[c] = 'Key' + c.toUpperCase();
    m[c.toUpperCase()] = 'Key' + c.toUpperCase();
  }
  for (const d of '0123456789') m[d] = 'Digit' + d;
  Object.assign(m, {
    ' ': 'Space', Enter: 'Enter', Backspace: 'Backspace', Tab: 'Tab',
    '-': 'Minus', '=': 'Equal', '[': 'BracketLeft', ']': 'BracketRight',
    ';': 'Semicolon', "'": 'Quote', ',': 'Comma', '.': 'Period', '/': 'Slash',
    '\\': 'Backslash', '`': 'Backquote',
    '!': 'Digit1', '@': 'Digit2', '#': 'Digit3', '$': 'Digit4', '%': 'Digit5',
    '^': 'Digit6', '&': 'Digit7', '*': 'Digit8', '(': 'Digit9', ')': 'Digit0',
    ':': 'Semicolon', '"': 'Quote', '<': 'Comma', '>': 'Period', '?': 'Slash',
    '_': 'Minus', '+': 'Equal', '{': 'BracketLeft', '}': 'BracketRight',
  });
  return m;
})();

export function codeOf(domEvent) {
  return domEvent.code || KEY_TO_CODE[domEvent.key] || '';
}

/**
 * Keys that MOVE THE CARET or the machine, rather than play anything.
 *
 * These have to drop out before the input engine touches any state at all.
 * Pressing Home to get back to the start of a line is navigation, not a
 * musical gesture: it must not sound, must not become a RawTypingEvent, and
 * must not disturb keys/sec, the repeat counter, the hand-alternation streak
 * or the interval that colours the NEXT note. Anything less and moving the
 * cursor silently changes the music.
 *
 * Backspace, Space, Enter and Tab are deliberately NOT here -- they are part
 * of the instrument (reverse tail, phrase mark, layer commit, fill).
 */
const NON_MUSICAL = new Set([
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'Home', 'End', 'PageUp', 'PageDown',
  'Insert', 'Delete',
  'PrintScreen', 'ScrollLock', 'Pause',
  'NumLock', 'ContextMenu',
  'Escape', 'CapsLock',
  'Help', 'Clear', 'Again', 'Undo', 'Cut', 'Copy', 'Paste', 'Find', 'Props', 'Select',
  'BrowserBack', 'BrowserForward', 'BrowserRefresh', 'BrowserHome',
  'BrowserSearch', 'BrowserFavorites', 'BrowserStop',
  'AudioVolumeUp', 'AudioVolumeDown', 'AudioVolumeMute',
  'MediaPlayPause', 'MediaStop', 'MediaTrackNext', 'MediaTrackPrevious', 'MediaSelect',
  'LaunchMail', 'LaunchApp1', 'LaunchApp2', 'Power', 'Sleep', 'WakeUp',
  'Eject', 'Fn', 'FnLock', 'Hyper', 'Super', 'Lang1', 'Lang2', 'Lang3', 'Lang4', 'Lang5',
  'NumpadEqual', 'NumpadComma',
]);

/** modifiers and function keys, matched by prefix */
const NON_MUSICAL_PREFIX = /^(Shift|Control|Alt|Meta|OS|F\d)/;

/**
 * ALLOWLIST, not a denylist.
 *
 * A key is part of the performance only if the mapping gives it a job. That
 * is the only rule that stays correct as keyboards vary: a denylist would
 * have to keep growing for Convert / NonConvert / KanaMode / IntlRo / IntlYen
 * on a JIS board, the numpad, media keys, and whatever the next layout adds.
 * Anything unmapped is dropped before a single field of state is touched.
 *
 * Space, Enter, NumpadEnter, Backspace and Tab are all in the mapping (as
 * transport), so they keep working.
 *
 * NON_MUSICAL is kept as a second, explicit gate: it documents the intent for
 * keys that could otherwise creep into the mapping by accident.
 */
export function isNonMusicalKey(code) {
  if (!code) return true;
  if (NON_MUSICAL.has(code) || NON_MUSICAL_PREFIX.test(code)) return true;
  return !Object.prototype.hasOwnProperty.call(DEFAULT_MAPPING, code) || code === 'name';
}

export class InputEngine {
  /**
   * @param {object} opts
   * @param {() => number} opts.now      session clock, in seconds
   * @param {(e) => void}  opts.onDown
   * @param {(e) => void}  opts.onUp
   */
  constructor({ now, onDown, onUp }) {
    this.now = now;
    this.onDown = onDown;
    this.onUp = onUp;
    this.reset();
  }

  reset() {
    this.seq = 0;
    this.lastDownTime = null;
    this.recent = []; // recent keydown times, for keys/sec
    this.held = new Map(); // code -> raw event
    this.word = '';
    this.phraseKeys = 0;
    this.composing = false;
  }

  /**
   * Read-only: is any key physically down right now?
   * RECORD refuses to start while one is, because the note that key is playing
   * began before the take and its keyup would land inside it -- the take would
   * open with a note it never triggered.
   */
  get hasHeldKeys() {
    return this.held.size > 0;
  }

  /** driven by compositionstart / compositionend on the text area */
  setComposing(v) {
    this.composing = !!v;
  }

  isComposing(domEvent) {
    return this.composing || domEvent.isComposing === true || domEvent.keyCode === 229;
  }

  /** keys/sec over a 1.0s sliding window (integer-free, so it moves smoothly) */
  _kps(t) {
    this.recent.push(t);
    while (this.recent.length && t - this.recent[0] > 1.0) this.recent.shift();
    if (this.recent.length < 2) return 0;
    const span = t - this.recent[0];
    return span > 0.02 ? (this.recent.length - 1) / span : 0;
  }

  handleKeyDown(domEvent) {
    if (domEvent.repeat) return null; // auto-repeat is not a new attack
    const code = codeOf(domEvent);
    // Bail out BEFORE touching any state: no timestamp, no keys/sec sample, no
    // repeat counter, no interval. A caret move must leave the performance
    // exactly as it found it.
    if (isNonMusicalKey(code)) return null;
    if (this.held.has(code)) return null;
    if (TRANSPORT_KEYS.has(code) && this.isComposing(domEvent)) return null;

    const t = this.now();
    const interval = this.lastDownTime === null ? null : (t - this.lastDownTime) * 1000;
    const char = PHYSICAL_CHAR[code] ?? null;

    if (WORD_BREAK.has(code)) this.word = '';
    else if (code === 'Backspace') this.word = this.word.slice(0, -1);
    else if (char && /[a-z0-9]/.test(char)) this.word += char;

    const ev = {
      seq: this.seq++,
      timestamp: t,
      key: domEvent.key,
      code,
      char,
      keydown: true,
      keyupAt: null,
      holdMs: null,
      intervalFromPrevious: interval === null ? null : Math.round(interval),
      keysPerSecond: this._kps(t),
      hand: handOf(code),
      row: rowOf(code),
      shift: !!domEvent.shiftKey,
      word: this.word,
      wordIndex: this.word.length ? this.word.length - 1 : 0,
    };

    this.held.set(code, ev);
    this.lastDownTime = t;
    this.onDown(ev);
    return ev;
  }

  handleKeyUp(domEvent) {
    const code = codeOf(domEvent);
    const ev = this.held.get(code);
    if (!ev) return null;
    this.held.delete(code);
    const t = this.now();
    ev.keyupAt = t;
    ev.holdMs = Math.round((t - ev.timestamp) * 1000);
    this.onUp(ev);
    return ev;
  }

  /** read-only keys/sec for the meters (does not disturb the event stream) */
  currentKps(t) {
    while (this.recent.length && t - this.recent[0] > 1.0) this.recent.shift();
    if (this.recent.length < 2) return 0;
    const span = Math.max(t - this.recent[0], 0.25);
    return (this.recent.length - 1) / span;
  }

  /** seconds since the last attack -- the "pause" dimension */
  silenceFor(t) {
    return this.lastDownTime === null ? 0 : t - this.lastDownTime;
  }
}
