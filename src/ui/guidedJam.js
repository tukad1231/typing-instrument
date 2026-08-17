// ---------------------------------------------------------------------------
// GUIDED JAM  --  the first five minutes, without a manual.
//
// Two rules decide everything in this file.
//
//  1. A STEP IS COMPLETE WHEN THE INSTRUMENT SAYS SO, NEVER WHEN A BUTTON WAS
//     PRESSED. There is no "Next". `stepFor()` is a pure function of the real
//     state -- how many tracks have notes in them, how many notes are waiting,
//     whether a section has been saved, whether anything has been captured. You
//     cannot skip ahead by clicking, and you cannot get stuck on a step you
//     have already satisfied. It also means the guide is correct for someone
//     who ignored it and just started playing: they arrive at step 5 having
//     never seen steps 1 to 4.
//
//  2. THE GUIDE PUTS NOTHING IN THE PERFORMANCE. It reads state and returns a
//     sentence. It dispatches nothing, so no session event exists because a
//     tutorial was on screen, and a piece made with the guide open is
//     byte-identical to the same piece made with it closed.
// ---------------------------------------------------------------------------

export const GUIDED_STEPS = [
  {
    id: 'sound',
    title: 'Choose a starting sound',
    body: 'Each one is a different instrument, and a different set of notes. There is no wrong pick.',
    done: (s) => s.kitChosen,
  },
  {
    id: 'foundation',
    title: 'Add a foundation',
    body: 'Something to play over. Your kit can drop one in, or start from silence.',
    done: (s) => s.tracks >= 1 || s.pending > 0,
  },
  {
    id: 'type',
    title: 'Type 8–24 keys',
    body: 'Just type. Every key is an instrument, and how long you hold one is how long the note lasts.',
    done: (s) => s.pending >= 8 || s.typedTracks >= 1,
  },
  {
    id: 'loop',
    title: 'Make it a loop',
    body: 'Press Enter. What you just played starts repeating, and you can play over it.',
    done: (s) => s.typedTracks >= 1,
  },
  {
    id: 'contrast',
    title: 'Add contrast',
    body: 'A second loop that is NOT like the first — lower, sparser, or the other hand.',
    done: (s) => s.tracks >= 2,
  },
  {
    id: 'shape',
    title: 'Shape the song',
    body: 'Save a mix as a section, then press sections in order to perform the arrangement.',
    done: (s) => s.sections >= 2,
  },
  {
    id: 'capture',
    title: 'Capture it',
    body: 'Record the whole performance — every key and every control — so you can replay and export it.',
    done: (s) => s.captured,
  },
];

/**
 * @param {object} state
 * @param {number} state.tracks       tracks holding anything
 * @param {number} state.typedTracks  tracks made by typing (not presets)
 * @param {number} state.pending      notes waiting for Enter
 * @param {number} state.sections     saved story sections
 * @param {boolean} state.captured    has a take been recorded
 * @param {boolean} state.kitChosen   has a starter kit been applied
 * @returns {{index: number, step: object, complete: boolean, total: number}}
 */
export function stepFor(state) {
  const s = normalise(state);
  for (let i = 0; i < GUIDED_STEPS.length; i++) {
    if (!GUIDED_STEPS[i].done(s)) return { index: i, step: GUIDED_STEPS[i], complete: false, total: GUIDED_STEPS.length };
  }
  return { index: GUIDED_STEPS.length, step: null, complete: true, total: GUIDED_STEPS.length };
}

function normalise(state) {
  const s = state || {};
  return {
    tracks: num(s.tracks),
    typedTracks: num(s.typedTracks),
    pending: num(s.pending),
    sections: num(s.sections),
    captured: !!s.captured,
    kitChosen: !!s.kitChosen,
  };
}

function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

// --- "have I done this before" ---------------------------------------------
// A local preference, not project data: the guide is about the PERSON, and it
// should not come back because they opened an old piece. Failures are silent
// on purpose -- localStorage throws in some private-browsing modes, and the
// worst consequence of not remembering is seeing a helpful strip again.
const KEY = 'typing-instrument.guided.done';

export function guidedDone() {
  try {
    return localStorage.getItem(KEY) === '1';
  } catch (e) {
    return false;
  }
}

export function setGuidedDone(v) {
  try {
    if (v) localStorage.setItem(KEY, '1');
    else localStorage.removeItem(KEY);
  } catch (e) {
    /* nothing to do; the guide simply reappears next time */
  }
}
