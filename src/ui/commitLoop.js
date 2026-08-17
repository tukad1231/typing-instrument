// ---------------------------------------------------------------------------
// COMMIT LOOP  --  the button and the key press are the same gesture.
//
// The rule this file exists to enforce: THE BUTTON DOES NOT SIMULATE A KEY, IT
// PRESSES ONE. An earlier version dispatched a synthetic DOM KeyboardEvent,
// which is untrusted, skips the browser's own text editing, and drifted away
// from the real thing in ways nobody noticed until the session logs were
// compared side by side.
//
// So both paths call the SAME input function with a plain descriptor.
// InputEngine only ever reads code / key / isComposing / shiftKey, so a
// descriptor is all a key press has ever been.
// ---------------------------------------------------------------------------

/**
 * Insert a newline where the caret is, the way the browser would.
 *
 * `setRangeText` is what a text editing operation looks like: it respects the
 * selection, replaces it if there is one, and leaves the caret after the
 * inserted text. Appending to `value` -- which is what this used to do -- puts
 * the newline at the end of the document no matter where the user was working.
 */
export function insertNewlineAtCaret(textEl) {
  const start = textEl.selectionStart ?? textEl.value.length;
  const end = textEl.selectionEnd ?? start;
  if (typeof textEl.setRangeText === 'function') textEl.setRangeText('\n', start, end, 'end');
  else textEl.value = textEl.value.slice(0, start) + '\n' + textEl.value.slice(end);
  return textEl.value;
}

export const ENTER_DESC = { code: 'Enter', key: 'Enter', isComposing: false, shiftKey: false };

/**
 * Press Enter through the ordinary input path.
 *
 * @param {object} deps
 * @param {(desc) => object|null} deps.keyDown
 * @param {(desc) => object|null} deps.keyUp
 * @param {HTMLTextAreaElement} deps.textEl
 * @param {(text: string) => void} [deps.onText]
 * @returns {object|null} the raw event, or null if the key was refused
 */
export function pressEnter({ keyDown, keyUp, textEl, onText }) {
  const desc = Object.assign({}, ENTER_DESC);
  const raw = keyDown(desc);
  if (!raw) return null;
  if (textEl) {
    const text = insertNewlineAtCaret(textEl);
    if (onText) onText(text);
  }
  keyUp(desc);
  return raw;
}

/**
 * Can a loop be committed right now?
 *
 * Both replay flags matter: one belongs to the shell, one to SessionEngine, and
 * a replay driven straight through the engine only sets the latter. IME
 * composition blocks it because Enter means "confirm this word" at that moment,
 * and committing a loop because somebody finished typing in Japanese would make
 * the instrument unusable in Japanese.
 */
export function canCommit({ view, replaying, imeComposing }) {
  if (replaying) return false;
  if (imeComposing) return false;
  return !!view && view.pending.count > 0 && view.nextFreeLayer !== null;
}

/** why not -- because a control that is disabled without saying why is a bug */
export function commitBlockedReason({ view, replaying, imeComposing }) {
  if (replaying) return 'Not while a replay is running — press Stop first.';
  if (imeComposing) return 'Finish the IME conversion first — Enter means “confirm” right now.';
  if (!view) return '';
  if (view.nextFreeLayer === null) return 'All 4 tracks are full. Delete one, and these notes will still be waiting.';
  if (view.pending.count === 0) return 'Play something first — there are no notes waiting yet.';
  return '';
}
