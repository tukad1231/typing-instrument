// ---------------------------------------------------------------------------
// TEST FIXTURE  --  a whole instrument that nobody is listening to.
//
// -- WHY THIS EXISTS --------------------------------------------------------
// Self-test 15 used to drive the REAL application: the live session log, the
// live recorder, the live InputEngine, the live DOM. It saved a handful of
// array lengths first and put them back afterwards, and called that isolation.
//
// It was not. `session.nextId`, `session.checkpoints`, `_sinceCheckpoint`,
// `recorder.text`, `recorder.takeRaw`, `recorder.takePerf`, `InputEngine.held`,
// `InputEngine.word`, the compose panel, `lastCommit`, the drag state, the
// caret position and the status line were all left wherever the test put them.
// One of those -- `word`, which rides inside every logged key event -- made the
// suite non-idempotent: run it twice and test 15 failed the second time, for a
// reason that had nothing to do with the thing being tested.
//
// The fix is not more save-and-restore. It is to stop running tests on the
// user's work. This builds a complete, independent instrument:
//
//     StubSound   -- makes no sound, consumes no time, has a settable clock
//     LoopEngine  -- the real one
//     PerformanceEngine -- the real one
//     SessionEngine -- the real one, its own log
//     Recorder    -- the real one
//     InputEngine -- the real one
//     a DETACHED <textarea> that was never in the document
//
// wired together with the SAME shared functions production uses (performKey,
// pressEnter, canCommit). Nothing here can reach the live app, so there is
// nothing to restore afterwards and no ordering between tests to get wrong.
// ---------------------------------------------------------------------------

import { StubSound } from '../session/simulate.js';
import { LoopEngine } from '../loop/loopEngine.js';
import { PerformanceEngine, DEFAULT_SETTINGS } from '../perf/performanceEngine.js';
import { SessionEngine } from '../session/sessionEngine.js';
import { Recorder } from '../record/recorder.js';
import { InputEngine } from '../input/inputEngine.js';
import { EV } from '../session/sessionEvents.js';
import { SCALES } from '../perf/scale.js';
import { performKey } from '../perf/performKey.js';
import { pressEnter, canCommit } from '../ui/commitLoop.js';

/**
 * A clock the test drives by hand.
 *
 * StubSound's `t` never moves on its own, which is what makes a fixture run
 * reproducible to the microsecond: two runs of the same script produce the same
 * timestamps, so two session logs can be compared field for field without
 * having to strip anything but the fields a test explicitly chooses to ignore.
 */
export function createFixture({ mapping, settings: s0 = {}, bpm = 120, quantize = 'LIGHT' } = {}) {
  const settings = Object.assign({}, DEFAULT_SETTINGS, { bpm, quantize }, s0);
  const sound = new StubSound();
  const perf = new PerformanceEngine(mapping, settings);
  const loop = new LoopEngine(sound, { bpm: settings.bpm, quantize: settings.quantize });
  loop.init();
  loop.stop(); // no wall-clock scheduling: the fixture owns time
  const recorder = new Recorder();
  const eventsBySeq = new Map();

  // Detached: created with createElement and never appended, so it cannot take
  // focus from the real play surface, cannot be found by a querySelector on the
  // document, and disappears when the fixture is dropped.
  const textEl = document.createElement('textarea');

  let replaying = false;
  let lastCommit = null;
  let composing = false;

  const session = new SessionEngine({ now: () => sound.now() });

  const world = () => ({
    perf, loop, sound, recorder, eventsBySeq,
    replaying: session.replaying,
    onLayer: (c) => {
      lastCommit = c;
      if (c.raw && !c.error && !session.replaying) {
        session.dispatch(EV.COMMIT_LAYER, { derived: true, layer: c.layer, bars: c.bars });
        composing = false;
      }
    },
  });

  session
    .on(EV.KEY_DOWN, (raw, ev) => {
      const r = session.replaying ? Object.assign({}, raw, { timestamp: ev.time }) : raw;
      performKey(r, world());
    })
    .on(EV.KEY_UP, (d, ev) => {
      eventsBySeq.delete(d.seq);
      loop.applyHoldBySeq(d.seq, d.holdMs);
      if (!session.replaying) recorder.applyHoldBySeq(d.seq, d.holdMs);
      sound.release(d.seq, ev.time, 'live');
    })
    .on(EV.SET_SOUND, (d) => { settings.soundSet = d.value; perf.setSettings({ soundSet: d.value }); })
    .on(EV.SET_BPM, (d) => { settings.bpm = d.value; perf.setSettings({ bpm: d.value }); loop.setBpm(d.value); })
    .on(EV.SET_COMPLEXITY, (d) => { settings.complexity = d.value; perf.setSettings({ complexity: d.value }); })
    .on(EV.SET_QUANTIZE, (d) => { settings.quantize = d.value; loop.setQuantize(d.value); })
    .on(EV.SET_MASTER_VOLUME, (d) => { settings.masterVolume = d.value; })
    .on(EV.ADD_BUILTIN_LOOP, (d) => loop.addBuiltin(d.loop, SCALES[settings.soundSet] || SCALES.electronic))
    .on(EV.CLEAR_LAYER, (d) => loop.clearLayer(d.layer))
    .on(EV.RESTORE_LAYER, (d) => loop.restoreLayer(d))
    .on(EV.CLEAR_ALL, () => {
      loop.clearAll();
      perf.reset();
      eventsBySeq.clear();
      if (!session.replaying) { input.reset(); textEl.value = ''; recorder.reset(); }
    })
    .on(EV.LAYER_ON, (d) => loop.setLayer(d.layer, { on: d.value, muted: false }))
    .on(EV.LAYER_MUTE, (d) => loop.setLayer(d.layer, { muted: d.value }))
    .on(EV.LAYER_VOLUME, (d) => loop.setLayer(d.layer, { volume: d.value }));

  const input = new InputEngine({
    now: () => sound.now(),
    onDown: (ev) => {
      recorder.addRaw(ev);
      session.dispatch(EV.KEY_DOWN, Object.assign({}, ev), ev.timestamp);
    },
    onUp: (ev) => session.dispatch(EV.KEY_UP, { seq: ev.seq, holdMs: ev.holdMs }, ev.keyupAt),
  });

  const keyDown = (desc) => (replaying || session.replaying ? null : input.handleKeyDown(desc));
  const keyUp = (desc) => (replaying || session.replaying ? null : input.handleKeyUp(desc));

  const api = {
    sound, perf, loop, session, recorder, input, textEl, settings, eventsBySeq,

    /** move the fixture's clock; nothing advances on its own */
    at(t) { sound.t = t; return api; },
    advance(dt) { sound.t += dt; return api; },

    get replaying() { return replaying; },
    set replaying(v) { replaying = v; },
    get composing() { return composing; },
    set composing(v) { composing = v; },
    get lastCommit() { return lastCommit; },

    keyDown,
    keyUp,

    /** type a key the way the browser does: down, a beat later, up */
    tap(code, char, { hold = 0.06, gap = 0.13, shift = false } = {}) {
      const desc = { code, key: char ?? code, isComposing: false, shiftKey: shift };
      const raw = keyDown(desc);
      if (raw && char !== undefined && char !== null && char !== '\n') textEl.value += char;
      api.advance(hold);
      keyUp(desc);
      api.advance(gap);
      return raw;
    },

    typeWord(word, opts) {
      for (const ch of word) api.tap('Key' + ch.toUpperCase(), ch, opts);
      return api;
    },

    view() { return loop.composerSnapshot(); },

    canCommit() {
      return canCommit({ view: loop.composerSnapshot(), replaying: replaying || session.replaying, imeComposing: input.composing });
    },

    /** exactly what the COMMIT LOOP button does */
    commitViaButton() {
      if (!api.canCommit()) return false;
      const raw = pressEnter({ keyDown, keyUp, textEl, onText: (t) => recorder.setText(t) });
      if (!raw) return false;
      if (lastCommit && lastCommit.seq === raw.seq && !lastCommit.error) { composing = false; return true; }
      return false;
    },

    /** exactly what the physical Enter key does */
    commitViaKeyboard() {
      const desc = { code: 'Enter', key: 'Enter', isComposing: false, shiftKey: false };
      const raw = keyDown(desc);
      if (!raw) return false;
      textEl.value += '\n';
      recorder.setText(textEl.value);
      keyUp(desc);
      return !!(lastCommit && lastCommit.seq === raw.seq && !lastCommit.error);
    },

    /** the session slice since `n`, ready to compare */
    slice(n) { return session.events.slice(n); },

    dispose() {
      loop.stop();
      // The textarea was never in the document, so dropping the reference is
      // the whole of the cleanup.
    },
  };

  return api;
}

/**
 * Deep, order-independent snapshot of every piece of live state a test might
 * plausibly disturb. Comparing one of these before and after a run is how the
 * suite proves it left the user's work alone -- "the arrays are the same
 * length" was what let the old test 15 corrupt `word` unnoticed.
 */
export function liveStateSnapshot({ session, recorder, loop, perf, getInput, settings }) {
  const inp = getInput ? getInput() : null;
  return {
    session: {
      events: session.events.map((e) => ({ i: e.i, time: e.time, type: e.type, data: e.data })),
      takeLog: session.takeLog.length,
      nextId: session.nextId,
      sinceCheckpoint: session._sinceCheckpoint,
      checkpoints: session.checkpoints.map((c) => [c.id, c.time]),
      replaying: session.replaying,
      recording: session.recordingFlag,
      scratchIncomplete: session.scratchIncomplete,
      take: session.take ? { startTime: session.take.startTime, endTime: session.take.endTime } : null,
    },
    recorder: {
      raw: recorder.raw.length,
      perf: recorder.perf.length,
      takeRaw: recorder.takeRaw.length,
      takePerf: recorder.takePerf.length,
      text: recorder.text,
      recording: recorder.recording,
      take: recorder.take ? { start: recorder.take.start, end: recorder.take.end } : null,
    },
    // The LOOP CONTENT, not the transport.
    //
    // `loop.exportState()` anchors everything to `beatAt(now)`, so two
    // snapshots taken a few milliseconds apart differ in `beatAtCheckpoint` and
    // in every `dBeat` -- because time passed, which is not a change anybody
    // needs to be warned about. What must not move is what is IN the loops.
    loop: {
      layers: loop.snapshot(),
      pending: loop.pending.map((p) => ({ b: p.b, seq: p.ev.sourceSeq, note: p.ev.note, dur: p.ev.duration })),
      phrases: loop.phrases.map((p) => [p.index, p.text, p.duration, p.events.length]),
      openPhrase: { text: loop.openPhrase.text, events: loop.openPhrase.events.length },
      bpm: loop.bpm,
      quantize: loop.quantize,
    },
    perf: perf.exportState(),
    input: inp
      ? {
          seq: inp.seq,
          lastDownTime: inp.lastDownTime,
          recent: inp.recent.slice(),
          word: inp.word,
          composing: inp.composing,
          held: [...inp.held.keys()],
        }
      : null,
    settings: settings ? { ...settings } : null,
    dom: {
      text: (document.getElementById('text') || {}).value,
      composeHidden: (document.getElementById('compose') || {}).hidden,
      trackCards: document.querySelectorAll('#tracks .track').length,
      activeElement: document.activeElement ? document.activeElement.id || document.activeElement.tagName : null,
    },
  };
}
