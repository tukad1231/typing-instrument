// ---------------------------------------------------------------------------
// NEXT MOVE  --  one suggestion, never a checklist.
//
// The screen shows exactly one of these at a time. Not three, not a panel of
// tips: a person in the middle of playing can act on one idea, and a list of
// five reads as homework.
//
// -- THE RULES THIS FILE OBEYS ---------------------------------------------
//   PURE          state in, suggestion out. It changes nothing, dispatches
//                 nothing, and reads no clock and no global.
//   DETERMINISTIC same state, same suggestion. No Math.random() -- a hint that
//                 differs between two identical situations is a hint the user
//                 cannot learn to predict, and predictability is what makes it
//                 feel like an instrument rather than a slot machine.
//   HONEST        every suggestion describes something the app can actually
//                 do right now. Nothing here proposes a feature that is not
//                 wired up.
//
// The rules are ordered, and the first one that fires wins. That ordering IS
// the teaching: fix silence before texture, texture before arrangement,
// arrangement before capture.
// ---------------------------------------------------------------------------

/**
 * @param {object} s
 * @param {number} s.tracks        tracks holding anything
 * @param {number} s.typedTracks   tracks made by typing
 * @param {number} s.audible       tracks currently making sound
 * @param {number} s.pending       notes waiting for Enter
 * @param {number} s.sections      saved story sections
 * @param {boolean} s.captured     has a take been recorded
 * @param {boolean} s.dirtySinceCapture  played since the last capture
 * @param {string} s.soundSet
 * @param {number} s.sessionSeconds  how long this sitting has lasted
 * @param {string[]} [suppress]    ids already shown recently; the caller owns
 *   the "do not repeat myself" memory, so this function stays pure
 * @returns {{id: string, text: string, hint: string}|null}
 */
export function nextMove(s, suppress = []) {
  const st = normalise(s);
  const skip = new Set(suppress);
  for (const rule of RULES) {
    if (skip.has(rule.id)) continue;
    if (rule.when(st)) return { id: rule.id, text: rule.text(st), hint: rule.hint || '' };
  }
  // Everything is suppressed, or nothing applies. Saying nothing is a valid
  // answer: an empty strip is better than a filler sentence.
  return null;
}

const RULES = [
  {
    id: 'type-first',
    when: (s) => s.tracks === 0 && s.pending === 0,
    text: () => 'Type a short phrase',
    hint: 'Anything. 8 to 24 keys is a good first loop.',
  },
  {
    id: 'loop-it',
    when: (s) => s.pending >= 6,
    text: (s) => `Press Enter to loop those ${s.pending} notes`,
    hint: 'They become a track and start repeating.',
  },
  {
    // Mid-phrase, whether or not anything is already looping. Without the
    // second half of this condition there was a dead spot -- a foundation
    // running and three notes played -- where nothing at all had anything to
    // say, which reads as the app having lost interest.
    id: 'keep-typing',
    when: (s) => s.pending > 0 && s.pending < 6,
    text: () => 'Keep going — a few more keys',
    hint: 'A loop needs enough in it to be recognisable.',
  },
  {
    id: 'contrast',
    when: (s) => s.tracks === 1 && s.pending === 0,
    text: () => 'Add one contrasting layer',
    hint: 'Lower, sparser, or the other hand — different from what is already there.',
  },
  {
    id: 'try-a-sound',
    when: (s) => s.tracks >= 2 && s.sessionSeconds > 240 && s.soundSet === 'electronic',
    text: () => 'Try a contrasting sound',
    hint: 'Piano and Plucked decay by themselves, so the same typing plays very differently.',
  },
  {
    id: 'make-sections',
    when: (s) => s.tracks >= 2 && s.sections === 0,
    text: () => 'Shape it into sections',
    hint: 'Save the mix you have now, then save a quieter one.',
  },
  {
    id: 'quiet-section',
    when: (s) => s.sections >= 1 && s.sections < 3 && s.tracks >= 2,
    text: () => 'Make a quieter section',
    hint: 'Take almost everything away, so the full mix means something when it returns.',
  },
  {
    id: 'save-version',
    when: (s) => s.tracks >= 3 && s.sections >= 2 && !s.captured && s.sessionSeconds > 420,
    text: () => 'Save a version before changing it',
    hint: 'Duplicate the piece, then experiment on the copy.',
  },
  {
    id: 'capture',
    when: (s) => s.tracks >= 2 && s.sections >= 2 && !s.captured,
    text: () => 'Switch to FULL and capture it',
    hint: 'Capture records the whole performance, sections and all.',
  },
  {
    id: 'recapture',
    when: (s) => s.captured && s.dirtySinceCapture,
    text: () => 'Capture it again — it has changed',
    hint: 'The last capture is from before these edits.',
  },
  {
    id: 'all-muted',
    when: (s) => s.tracks > 0 && s.audible === 0,
    text: () => 'Nothing is audible — turn a track back on',
    hint: 'Every track is off or muted right now.',
  },
  {
    id: 'export',
    when: (s) => s.captured && !s.dirtySinceCapture,
    text: () => 'Export it, or keep building',
    hint: 'Export writes the audio and the whole performance log to a zip.',
  },
];

function normalise(s) {
  const v = s || {};
  const n = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : 0);
  return {
    tracks: n(v.tracks),
    typedTracks: n(v.typedTracks),
    audible: n(v.audible),
    pending: n(v.pending),
    sections: n(v.sections),
    captured: !!v.captured,
    dirtySinceCapture: !!v.dirtySinceCapture,
    soundSet: typeof v.soundSet === 'string' ? v.soundSet : 'electronic',
    sessionSeconds: n(v.sessionSeconds),
  };
}

/**
 * The "do not say the same thing twice in a row" memory, kept here so the
 * pure function above never has to hold state. A suggestion the user has just
 * seen is suppressed for `windowSeconds`; dismissing one suppresses it for
 * much longer, because dismissing means "not now, I heard you".
 */
export class NextMoveMemory {
  constructor({ windowSeconds = 45, dismissSeconds = 900 } = {}) {
    this.shown = new Map(); // id -> time last shown
    this.dismissed = new Map();
    this.windowSeconds = windowSeconds;
    this.dismissSeconds = dismissSeconds;
    this.current = null;
  }

  /** ids that must not be offered at `now` */
  suppressed(now) {
    const out = [];
    for (const [id, t] of this.dismissed) if (now - t < this.dismissSeconds) out.push(id);
    for (const [id, t] of this.shown) {
      // The one on screen is exempt: suppressing it would make the strip
      // flicker between two suggestions every time the state was recomputed.
      if (this.current && this.current.id === id) continue;
      if (now - t < this.windowSeconds) out.push(id);
    }
    return out;
  }

  pick(state, now) {
    const move = nextMove(state, this.suppressed(now));
    if (move) this.shown.set(move.id, now);
    this.current = move;
    return move;
  }

  dismiss(now) {
    if (this.current) this.dismissed.set(this.current.id, now);
    this.current = null;
  }
}
