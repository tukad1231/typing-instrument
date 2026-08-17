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

// v3 adds `performanceState` and `loopState` to the opening checkpoint
// (session_start / record_start). v2 logs without them still replay: the
// engines fall back to their default state.
export const FORMAT_VERSION = 3;
export const ENGINE_VERSION = 'poc-5';
