// ---------------------------------------------------------------------------
// SESSION EVENTS  --  the vocabulary of a performance.
//
// v0.1 treated raw key events as the master take. That was not enough: a live
// set is not only typing. Changing the Sound, nudging the tempo, dropping in a
// Beat, muting a layer -- those ARE the performance too, and without them a
// replay is a different piece of music.
//
// So everything the player does, typing and knobs alike, lands on ONE timeline
// as a session event. That log is the canonical document (session-events.json).
// ---------------------------------------------------------------------------

export const EV = {
  SESSION_START: 'session_start',

  // --- playing ---
  KEY_DOWN: 'key_down',
  KEY_UP: 'key_up',

  // --- settings ---
  SET_SOUND: 'set_sound',
  SET_BPM: 'set_bpm',
  SET_COMPLEXITY: 'set_complexity',
  SET_QUANTIZE: 'set_quantize',
  SET_MASTER_VOLUME: 'set_master_volume',

  // --- loops ---
  ADD_BUILTIN_LOOP: 'add_builtin_loop',
  // DERIVED MARKER, not a command. See DERIVED_MARKERS below.
  COMMIT_LAYER: 'commit_layer',
  CLEAR_LAYER: 'clear_layer',
  CLEAR_ALL: 'clear_all',
  // v4. See RESTORE_LAYER_NOTE below.
  RESTORE_LAYER: 'restore_layer',
  LAYER_ON: 'layer_on',
  LAYER_MUTE: 'layer_mute',
  LAYER_VOLUME: 'layer_volume',

  // --- take markers (not applied on replay, they only delimit a take) ---
  RECORD_START: 'record_start',
  RECORD_STOP: 'record_stop',
};

/**
 * DERIVED MARKERS -- log entries that describe something the engine DID, not
 * something the player COMMANDED.
 *
 * COMMIT_LAYER is the only one. Pressing Enter is the command; committing the
 * layer is its consequence. The marker exists so the exported timeline reads
 * correctly ("a layer was committed here, and it was 2 bars long"), but
 * applying it on replay would commit a second time on top of the Enter
 * keystroke that is already in the log.
 *
 * Every derived marker carries `derived: true` in its data so that a consumer
 * of session-events.json can tell commands from consequences without having to
 * know this list.
 */
export const DERIVED_MARKERS = new Set([EV.COMMIT_LAYER]);

/** Take boundaries. Replaying these would re-arm RECORD. */
export const TAKE_MARKERS = new Set([EV.SESSION_START, EV.RECORD_START, EV.RECORD_STOP]);

/** Everything that is logged but never re-applied during replay. */
export const NON_REPLAYED = new Set([...TAKE_MARKERS, ...DERIVED_MARKERS]);

/**
 * RESTORE_LAYER_NOTE -- why v0.3 adds an event type, and why it had to.
 *
 * Deleting a track had to become undoable. Everything else in the vocabulary
 * describes something a player DID, and undoing a delete is also something a
 * player does -- but no existing event can express "put this exact content back
 * into track 2". ADD_BUILTIN_LOOP only knows the five presets; a typed loop is
 * a list of notes that exists nowhere else once the layer is cleared.
 *
 * Three options were on the table:
 *
 *   1. a generic "undo" event -- rejected. It makes the log a diff stream
 *      instead of a performance, and replaying it means replaying a mistake and
 *      then un-replaying it.
 *   2. undo outside the log, by rewinding project state -- rejected. The log
 *      would then no longer explain the state, so REPLAY and EXPORT would be
 *      describing a performance that never happened.
 *   3. a COMMAND that carries the content. Chosen. "Track 2 now holds these
 *      notes" is a real instruction, it is idempotent, it replays exactly, and
 *      an exported timeline reads truthfully.
 *
 * COMPATIBILITY: v2 and v3 logs simply never contain this type, and every
 * reader ignores unknown types, so old logs load and replay unchanged. That is
 * checked by self-test 31.
 */
export const RESTORE_LAYER_NOTE = 'see sessionEvents.js';

// v2 -> v3  added `performanceState` / `loopState` to the opening checkpoint.
// v3 -> v4  added RESTORE_LAYER (see above). Older logs still replay: the
//           engines fall back to their defaults and the new type never appears.
export const FORMAT_VERSION = 4;
export const MIN_READABLE_FORMAT_VERSION = 2;
export const ENGINE_VERSION = 'poc-6';
