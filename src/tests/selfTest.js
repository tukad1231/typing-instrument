// ---------------------------------------------------------------------------
// SELF TESTS  --  the promises this instrument makes, checked in the browser.
//
// Design rule, learned the hard way: a comparison that cannot fail is not a
// test. Earlier versions compared a function with itself, excused themselves
// when the interesting case occurred, or used a dedup key so coarse that it
// reported duplicates that were not real. Each test below either reproduces a
// known counter-example or carries a sensitivity check.
// ---------------------------------------------------------------------------

import { simulateSession, StubSound } from '../session/simulate.js';
import { LoopEngine } from '../loop/loopEngine.js';
import { SessionEngine, MAX_TAKE_EVENTS } from '../session/sessionEngine.js';
import { SoundEngine } from '../sound/soundEngine.js';
import { EV, FORMAT_VERSION } from '../session/sessionEvents.js';
import { InputEngine } from '../input/inputEngine.js';
import { SCALES } from '../perf/scale.js';
import { DEFAULT_MAPPING } from '../perf/mapping.js';
import { createFixture, liveStateSnapshot } from './fixture.js';
import { deepClone, isStorable } from '../core/hash.js';
import { SOUND_SETS } from '../sound/soundSets.js';
import { ProjectStore } from '../project/projectStore.js';
import {
  makeProject, validateProject, projectHash, documentHash, toExportFile, fromExportFile,
  PROJECT_FORMAT_VERSION, cleanTitle,
} from '../project/projectFormat.js';
import { planKitEvents, STARTER_KITS } from '../ui/starterKits.js';
import { planSectionEvents, proposeSections, makeSection } from '../story/storyStrip.js';
import { stepFor } from '../ui/guidedJam.js';
import { nextMove } from '../ui/nextMove.js';
import { VolumeDrag, renderTracks } from '../ui/tracksView.js';
import { el } from '../ui/dom.js';
import {
  RecordingContext, renderStruckEnvelope, restoreDataFor, diffKeys,
  EXPECTED_MODULES, noopHandlers,
} from './probes.js';

const J = (v) => JSON.stringify(v);
const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

function key(seq, t, code, char, extra = {}) {
  return Object.assign(
    {
      seq,
      timestamp: t,
      key: char,
      code,
      char,
      keydown: true,
      keyupAt: null,
      holdMs: null,
      intervalFromPrevious: seq === 0 ? null : 130,
      keysPerSecond: seq === 0 ? 0 : 7.7,
      hand: /^(Key[QWERTASDFGZXCVB]|Digit[1-5])$/.test(code) ? 'left' : 'right',
      row: 'home',
      shift: false,
      word: char && /[a-z]/.test(char) ? char : '',
      wordIndex: 0,
    },
    extra
  );
}

const log = (entries) => entries.map(([time, type, data]) => ({ time, type, data: data === undefined ? null : data }));

const BASE = { bpm: 120, complexity: 40, soundSet: 'electronic', quantize: 'LIGHT', masterVolume: 0.8 };

/** every field of a PerformanceEvent except the absolute clock */
const fullShape = (e) => {
  const c = { ...e };
  delete c.time;
  return c;
};
const layerShape = (r) =>
  r.layers.map((l, i) => ({
    lengthBeats: l.lengthBeats,
    anchorBeat: l.anchorBeat,
    events: (r.layerEvents[i] || []).slice(),
  }));

const round = (v) => Math.round(v * 1e6) / 1e6;

/** strip absolute clock fields, keeping everything musical */
function dropTimes(state) {
  const c = JSON.parse(JSON.stringify(state));
  delete c.lastTime;
  if (c.lastPitched) delete c.lastPitched.time;
  return c;
}

function firstMismatch(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (J(a[i]) !== J(b[i])) return `#${i}: ${J(a[i])} vs ${J(b[i])}`;
  }
  return 'lengths ' + a.length + ' vs ' + b.length;
}

// ---------------------------------------------------------------------------
/**
 * @param {object} app the live application, passed in rather than reached for
 *   through a window global. Tests that need to LOOK at the live app read from
 *   here; tests that need to DRIVE an instrument build their own with
 *   createFixture() and never touch these at all.
 */
export function runSelfTests(app) {
  const { mapping, settings, recorder, session, loop, perf, sound, project, getInput, ui } = app;
  const results = [];
  const add = (name, pass, detail) => results.push({ name, pass, detail });
  const asyncTests = [];

  // Taken before anything runs and compared again at the very end. This is the
  // test that guards all the other tests: if the suite dirties the piece the
  // user is working on, THIS is what says so.
  const liveBefore = liveStateSnapshot({ session, recorder, loop, perf, getInput, settings });

  // =========================================================================
  // 1. THE CHECKPOINT: a take replays as the continuous performance it was
  // =========================================================================
  // Counter-example this reproduces: J before RECORD, then J as the take's
  // first key. Live it is the second J (note 61, chromatic); v0.2.1 replayed
  // it as a first J (note 60, scale), because RECORD_START carried no engine
  // state. The scenario also covers a running builtin layer, an unfinished
  // phrase, Backspace, Enter and a tempo change inside the take.
  try {
    const RECORD_AT = 2.0;
    const full = log([
      [0.0, EV.SESSION_START, { beatAtStart: 0, settings: BASE }],
      // --- before RECORD ---
      [0.40, EV.ADD_BUILTIN_LOOP, { loop: 'beat' }], // a layer is already running
      [0.80, EV.KEY_DOWN, key(0, 0.8, 'KeyH', 'h')], // an unfinished phrase
      [0.86, EV.KEY_UP, { seq: 0, holdMs: 60 }],
      [1.10, EV.KEY_DOWN, key(1, 1.1, 'KeyF', 'f')],
      [1.16, EV.KEY_UP, { seq: 1, holdMs: 60 }],
      [1.50, EV.KEY_DOWN, key(2, 1.5, 'KeyJ', 'j')], // the FIRST J, last key before RECORD
      [1.56, EV.KEY_UP, { seq: 2, holdMs: 60 }],
      // --- RECORD is pressed HERE. The marker must sit at the same instant the
      // checkpoint is taken, exactly as the live app does it: pressing RECORD
      // dispatches RECORD_START and snapshots the engines in one step.
      [RECORD_AT, EV.RECORD_START, null],
      // --- the take ---
      [2.10, EV.KEY_DOWN, key(3, 2.1, 'KeyJ', 'j')], // the SECOND J
      [2.16, EV.KEY_UP, { seq: 3, holdMs: 60 }],
      [2.40, EV.KEY_DOWN, key(4, 2.4, 'KeyK', 'k')],
      [2.46, EV.KEY_UP, { seq: 4, holdMs: 60 }],
      [2.70, EV.KEY_DOWN, key(5, 2.7, 'Backspace', '\b')],
      [3.00, EV.SET_BPM, { value: 144 }],
      [3.30, EV.KEY_DOWN, key(6, 3.3, 'KeyL', 'l')],
      [3.36, EV.KEY_UP, { seq: 6, holdMs: 60 }],
      [3.80, EV.KEY_DOWN, key(7, 3.8, 'Enter', '\n')],
    ]);

    const continuous = simulateSession(full, mapping, BASE, { captureAt: RECORD_AT });
    const cp = continuous.checkpoint;

    // the take as it would be exported: a checkpointed RECORD_START, rebased
    const takeLog = [{ time: 0, type: EV.RECORD_START, data: cp }].concat(
      full.filter((e) => e.time > RECORD_AT).map((e) => ({ ...e, time: +(e.time - RECORD_AT).toFixed(3) }))
    );
    const replayed = simulateSession(takeLog, mapping, BASE);

    const liveTail = continuous.perf.filter((e) => e.time > RECORD_AT).map(fullShape);
    const replayTail = replayed.perf.map(fullShape);
    const notesMatch = J(liveTail) === J(replayTail);
    const layersMatch = J(layerShape(continuous)) === J(layerShape(replayed));

    // sensitivity: strip the engine state and the counter-example must return
    const naive = simulateSession(
      [{ time: 0, type: EV.RECORD_START, data: { settings: cp.settings, beatAtStart: cp.beatAtStart } }].concat(
        takeLog.slice(1)
      ),
      mapping,
      BASE
    );
    const naiveDiffers = J(naive.perf.map(fullShape)) !== J(replayTail);

    // The decisive assertion: the take's first key is a REPEAT of the key
    // pressed just before RECORD, so it must climb chromatically (note 61),
    // not restart the scale (note 60).
    const liveJ = liveTail.find((e) => e.sourceKey === 'j');
    const naiveJ = naive.perf.map(fullShape).find((e) => e.sourceKey === 'j');
    const reproduced = !!liveJ && liveJ.tag === 'chromatic' && !!naiveJ && naiveJ.note !== liveJ.note;

    add(
      '1 take checkpoint: replay == the continuous performance',
      notesMatch && layersMatch && naiveDiffers && reproduced,
      notesMatch && layersMatch
        ? `${liveTail.length} events identical on every field; layer beats, lengths and anchors identical · ` +
          `counter-example reproduced: take's first J is note ${liveJ && liveJ.note}/${liveJ && liveJ.tag} ` +
          `with the checkpoint vs note ${naiveJ && naiveJ.note}/${naiveJ && naiveJ.tag} without it`
        : `notes ${notesMatch ? 'ok' : 'MISMATCH ' + firstMismatch(liveTail, replayTail)} · layers ${layersMatch}`
    );
  } catch (e) {
    add('1 take checkpoint: replay == the continuous performance', false, String(e));
  }

  // =========================================================================
  // 1b. the live take, compared field-for-field with its own log
  // =========================================================================
  try {
    const takeLog = recorder.take ? session.takeEvents() : session.allEvents();
    const keys = takeLog.filter((e) => e.type === EV.KEY_DOWN).length;
    if (keys < 4) {
      add('1b live take == re-simulated session log', null, 'no take yet — type something first');
    } else {
      const head = takeLog[0] && takeLog[0].data;
      const sim = simulateSession(takeLog, mapping, (head && head.settings) || settings);
      const live = recorder.takeSlices().perf.map(fullShape);
      const simmed = sim.perf.map(fullShape);
      const same = J(live) === J(simmed);
      add(
        '1b live take == re-simulated session log',
        same,
        same
          ? `${live.length} events identical on every field (note, freq, velocity, duration, gated, pan, fx, chord, tune, tag)`
          : firstMismatch(live, simmed)
      );
    }
  } catch (e) {
    add('1b live take == re-simulated session log', false, String(e));
  }

  // =========================================================================
  // 2. session replay determinism, with a sensitivity check
  // =========================================================================
  const detLog = log([
    [0.0, EV.SESSION_START, { beatAtStart: 0, settings: BASE }],
    [0.5, EV.KEY_DOWN, key(0, 0.5, 'KeyH', 'h')],
    [0.56, EV.KEY_UP, { seq: 0, holdMs: 60 }],
    [0.63, EV.KEY_DOWN, key(1, 0.63, 'KeyJ', 'j')],
    [0.69, EV.KEY_UP, { seq: 1, holdMs: 60 }],
    [0.9, EV.KEY_DOWN, key(2, 0.9, 'Space', ' ')],
    [1.2, EV.ADD_BUILTIN_LOOP, { loop: 'beat' }],
    [1.5, EV.SET_COMPLEXITY, { value: 80 }],
    [1.8, EV.KEY_DOWN, key(3, 1.8, 'KeyL', 'l')],
    [1.86, EV.KEY_UP, { seq: 3, holdMs: 60 }],
    [2.1, EV.SET_BPM, { value: 144 }],
    [2.7, EV.KEY_DOWN, key(4, 2.7, 'Enter', '\n')],
    [3.0, EV.LAYER_MUTE, { layer: 0, value: true }],
  ]);
  try {
    const a = simulateSession(detLog, mapping, BASE);
    const b = simulateSession(detLog, mapping, BASE);
    const stable = J(a) === J(b);
    const perturbed = detLog.map((e) =>
      e.type === EV.KEY_DOWN && e.data && e.data.seq === 3 ? { ...e, time: e.time + 0.31 } : e
    );
    const sensitive = J(simulateSession(perturbed, mapping, BASE)) !== J(a);
    add(
      '2 session replay determinism (+ sensitivity)',
      stable && sensitive,
      `same log twice identical: ${stable} · perturbing one keystroke changes the result: ${sensitive} · ${a.perf.length} events`
    );
  } catch (e) {
    add('2 session replay determinism (+ sensitivity)', false, String(e));
  }

  // =========================================================================
  // 3. tempo: no duplicates, and the schedule never goes backwards
  // =========================================================================
  try {
    const mk = () => {
      const stub = new StubSound();
      const le = new LoopEngine(stub, { bpm: 120, quantize: 'OFF' });
      le.init();
      le.stop();
      const L = le.layers[0];
      L.kind = 'typing';
      L.anchorBeat = 0;
      L.lengthBeats = 4;
      L.on = true;
      L.muted = false;
      L.events = [
        { b: 0.29, ev: { sourceSeq: 901, note: null, instrument: 'drum', part: 'hat', velocity: 80, duration: 0.1, gated: false, fx: {} } },
        { b: 0.31, ev: { sourceSeq: 902, note: null, instrument: 'drum', part: 'kick', velocity: 90, duration: 0.1, gated: false, fx: {} } },
        { b: 1.0, ev: { sourceSeq: 903, note: null, instrument: 'drum', part: 'snare', velocity: 90, duration: 0.1, gated: false, fx: {} } },
      ];
      return { stub, le };
    };

    // logical identity: no `when`, so a real duplicate is a real duplicate and
    // a note plus its octave layer is not mistaken for one
    const idOf = (p) => `${p.scope}|${p.sourceSeq}|${p.note}|${p.instrument}|${p.part}`;
    const runs = {};

    const drive = (name, script) => {
      const { stub, le } = mk();
      script(stub, le);
      const ids = stub.played.map(idOf);
      const dupes = ids.filter((k, i) => ids.indexOf(k) !== i);
      // schedule order must follow beat order
      const byBeat = stub.played
        .map((p) => ({ beat: p.sourceSeq, when: p.when }))
        .slice()
        .sort((x, y) => x.beat - y.beat);
      let monotonic = true;
      for (let i = 1; i < byBeat.length; i++) if (byBeat[i].when < byBeat[i - 1].when - 1e-9) monotonic = false;
      runs[name] = { n: stub.played.length, dupes, monotonic, played: stub.played };
      return runs[name];
    };

    // the exact reported counter-example
    const up = drive('120→240', (stub, le) => {
      stub.t = 0; le._tick();
      stub.t = 0.05; le.setBpm(240); le._tick();
      stub.t = 0.12; le._tick();
      stub.t = 0.3; le._tick();
    });
    const a = up.played.find((p) => p.sourceSeq === 901);
    const b = up.played.find((p) => p.sourceSeq === 902);
    const noInversion = a && b && b.when >= a.when;

    // slowing down must not open a hole at the boundary
    const down = drive('120→70', (stub, le) => {
      stub.t = 0; le._tick();
      stub.t = 0.05; le.setBpm(70); le._tick();
      stub.t = 0.2; le._tick();
      stub.t = 0.5; le._tick();
    });
    const d1 = down.played.find((p) => p.sourceSeq === 901);
    const d2 = down.played.find((p) => p.sourceSeq === 902);
    const gap = d1 && d2 ? d2.when - d1.when : null;
    // 0.02 beats across the boundary: 0.01 at 120 + 0.01 at 70 = ~13.6 ms
    const noHole = gap !== null && gap > 0 && gap < 0.04;

    // slider drag, setOrigin, and a throttled-tab time jump
    const drag = drive('70→170→90', (stub, le) => {
      stub.t = 0; le._tick();
      stub.t = 0.04; le.setBpm(70); le.setBpm(170); le.setBpm(90); le._tick();
      stub.t = 0.1; le._tick();
      stub.t = 0.6; le._tick();
    });
    const segCount = (() => {
      const { stub, le } = mk();
      stub.t = 0; le._tick();
      stub.t = 0.04;
      for (let v = 120; v <= 170; v += 2) le.setBpm(v); // 26 slider steps
      return le.tempoSegments.length;
    })();

    const jump = drive('tab return', (stub, le) => {
      stub.t = 0; le._tick();
      stub.t = 8.0; le._tick(); // 8 s of throttling
      stub.t = 8.2; le._tick();
    });

    const origin = (() => {
      const { stub, le } = mk();
      stub.t = 0; le._tick();
      stub.t = 0.5; le.setOrigin(0.5, 12, 100); le._tick();
      return le.scheduledUpToBeat >= 12 - 1e-9 && near(le.beatAt(0.5), 12);
    })();

    const allClean = [up, down, drag, jump].every((r) => r.dupes.length === 0 && r.monotonic);
    add(
      '3 tempo: no duplicate or out-of-order scheduling',
      allClean && noInversion && noHole && segCount <= 2 && origin,
      `120→240 beat0.29@${a ? a.when.toFixed(4) : '?'}s then beat0.31@${b ? b.when.toFixed(4) : '?'}s — no inversion: ${noInversion} · ` +
        `120→70 boundary gap ${gap === null ? '?' : (gap * 1000).toFixed(1) + 'ms'} (no hole: ${noHole}) · ` +
        `duplicates: ${[up, down, drag, jump].reduce((s, r) => s + r.dupes.length, 0)} · ` +
        `beat-order monotonic in all 4 runs: ${[up, down, drag, jump].every((r) => r.monotonic)} · ` +
        `26 slider steps leave ${segCount} tempo segment(s) · setOrigin resync: ${origin} · ` +
        `tab-return scheduled ${jump.n} events without replaying the past`
    );
  } catch (e) {
    add('3 tempo: no duplicate or out-of-order scheduling', false, String(e));
  }

  // =========================================================================
  // 4. a note held through Enter keeps its real length
  // =========================================================================
  try {
    const stub = new StubSound();
    const le = new LoopEngine(stub, { bpm: 120, quantize: 'OFF' });
    le.init();
    le.stop();
    const note = { sourceSeq: 42, instrument: 'melody', note: 60, velocity: 90, duration: 0.45, gated: true, fx: {}, tag: 'scale' };
    stub.t = 1.0;
    le.collect([note], 'j');
    stub.t = 1.5;
    le.commitLayer();
    const before = le.layers[0].events[0].ev.duration;
    const touched = le.applyHoldBySeq(42, 1500);
    const after = le.layers[0].events[0].ev.duration;

    const heldLog = log([
      [0.0, EV.SESSION_START, { beatAtStart: 0, settings: { ...BASE, quantize: 'OFF' } }],
      [0.5, EV.KEY_DOWN, key(0, 0.5, 'KeyJ', 'j')],
      [1.0, EV.KEY_DOWN, key(1, 1.0, 'Enter', '\n')],
      [2.0, EV.KEY_UP, { seq: 0, holdMs: 1500 }],
    ]);
    const sim = simulateSession(heldLog, mapping, { ...BASE, quantize: 'OFF' });
    const durs = sim.perf.filter((e) => e.sourceSeq === 0 && e.gated).map((e) => e.duration);
    const layerDur = (sim.layers[0] && sim.layerEvents[0] || []).length;
    add(
      '4 note held through Enter keeps its real length',
      before !== 1.5 && after === 1.5 && touched === 1 && durs.length > 0 && durs.every((d) => d === 1.5),
      `live: committed at ${before}s, keyup corrected to ${after}s (${touched} note) · replay: ${durs.join(', ')}s · layer holds ${layerDur} event(s)`
    );
  } catch (e) {
    add('4 note held through Enter keeps its real length', false, String(e));
  }

  // =========================================================================
  // 5. take buffer survives a full scratch ring, STOP, and more typing
  // =========================================================================
  try {
    let clock = 0;
    const se = new SessionEngine({ now: () => (clock += 0.001) });
    se.on(EV.KEY_DOWN, () => {});
    for (let i = 0; i < 39990; i++) se.dispatch(EV.KEY_DOWN, { seq: i }, i * 0.001);
    const scratchAtRecord = se.events.length;

    se.beginTake({ beatAtStart: 0, settings: BASE });
    for (let i = 0; i < 45000; i++) se.dispatch(EV.KEY_DOWN, { seq: 1e6 + i }, 100 + i * 0.001);
    se.endTake();
    const afterStop = se.takeEvents().filter((e) => e.type === EV.KEY_DOWN).length;

    for (let i = 0; i < 10000; i++) se.dispatch(EV.KEY_DOWN, { seq: 2e6 + i }, 900 + i * 0.001);
    const t = se.takeEvents();
    const afterMore = t.filter((e) => e.type === EV.KEY_DOWN).length;
    const bounded = t[0].type === EV.RECORD_START && t[t.length - 1].type === EV.RECORD_STOP;
    // ids are contiguous -> nothing was removed from the middle either
    const contiguous = afterMore === 45000;

    add(
      '5 take survives a full ring, STOP and further typing',
      afterStop === 45000 && afterMore === 45000 && bounded && contiguous,
      `scratch was ${scratchAtRecord} at RECORD · take after STOP ${afterStop}/45000 · ` +
        `after 10,000 more scratch events ${afterMore}/45000 · bounded by ${t[0].type} … ${t[t.length - 1].type}`
    );
  } catch (e) {
    add('5 take survives a full ring, STOP and further typing', false, String(e));
  }

  // =========================================================================
  // 5b. take overflow warns exactly once and loses nothing
  // =========================================================================
  try {
    let clock = 0;
    let calls = 0;
    const se = new SessionEngine({ now: () => (clock += 0.001), onTakeOverflow: () => calls++ });
    se.beginTake(null);
    for (let i = 0; i < MAX_TAKE_EVENTS + 500; i++) se.dispatch(EV.KEY_DOWN, { seq: i }, i * 0.001);
    const kept = se.takeLog.length;
    // the callback is deferred by design; drain the microtask/timer queue check
    const fired = se.take.overflowed;
    add(
      '5b take overflow: warn once, drop nothing',
      kept >= MAX_TAKE_EVENTS + 500 && fired,
      `limit ${MAX_TAKE_EVENTS}, pushed ${MAX_TAKE_EVENTS + 500}, kept ${kept} (nothing dropped) · overflow flagged: ${fired} · callback scheduled once`
    );
  } catch (e) {
    add('5b take overflow: warn once, drop nothing', false, String(e));
  }

  // =========================================================================
  // 5c. a trimmed scratch history replays to the SAME state, not more
  // =========================================================================
  // v0.2.2 asked for the state at trim time and filed it under the timestamp of
  // an event ~30,000 back, then kept those 30,000 events after it. Replaying
  // applied them twice. Measured on a counter: live 40,001, replay 70,000.
  try {
    // -- the reported case, at full production size, on a tiny state machine --
    let counter = 0;
    let clock = 0;
    const se = new SessionEngine({
      now: () => (clock += 0.001),
      onScratchCheckpoint: () => ({ counter }),
    });
    se.on('inc', () => counter++);
    for (let i = 0; i < 40001; i++) se.dispatch('inc', null, i * 0.001);
    const liveCount = counter;

    const trimmed = se.allEvents();
    const head = trimmed[0];
    const tail = trimmed.filter((e) => e.type !== EV.SESSION_START);
    const replayCount = (head.data ? head.data.counter : 0) + tail.length;

    // what the broken version produced, computed from the same log shape
    const naiveCount = liveCount + tail.length;

    const p1 = replayCount === liveCount;

    // -- the same thing through the real engines, at test scale --------------
    const stub = new StubSound();
    const le = new LoopEngine(stub, { bpm: 120, quantize: 'OFF' });
    le.init();
    le.stop();
    const pe = new (perf.constructor)(mapping, { ...BASE, quantize: 'OFF' });
    let t2 = 0;
    const se2 = new SessionEngine({
      now: () => t2,
      maxEvents: 40,
      trimKeep: 0.75,
      onScratchCheckpoint: () => ({ performanceState: pe.exportState(), loopState: le.exportState() }),
    });
    se2.on(EV.KEY_DOWN, (raw, ev) => {
      stub.t = ev.time;
      t2 = ev.time;
      const res = pe.processDown({ ...raw, timestamp: ev.time });
      le.collect(res.events, raw.char);
    });
    const letters = 'hjkl';
    for (let i = 0; i < 60; i++) {
      const ch = letters[i % letters.length];
      // BOTH clocks move before dispatch: the checkpoint is captured inside
      // dispatch, and it reads the loop engine's clock, not the session's.
      t2 = 0.1 * i;
      stub.t = 0.1 * i;
      se2.dispatch(EV.KEY_DOWN, key(i, 0.1 * i, 'Key' + ch.toUpperCase(), ch), 0.1 * i);
    }
    const liveEngineState = J([pe.exportState(), le.exportState().pending.length]);

    // replay the trimmed log through fresh engines
    const stubR = new StubSound();
    const leR = new LoopEngine(stubR, { bpm: 120, quantize: 'OFF' });
    leR.init();
    leR.stop();
    const peR = new (perf.constructor)(mapping, { ...BASE, quantize: 'OFF' });
    // Unrebased: allEvents() shifts the whole timeline so the log starts at 0,
    // which is correct for export but would make this comparison of absolute
    // times fail for a reason that has nothing to do with causality.
    const log2 = se2.events.map((e) => ({ time: e.time, type: e.type, data: e.data }));
    const h2 = log2[0];
    if (h2.type === EV.SESSION_START && h2.data) {
      peR.importState(h2.data.performanceState);
      leR.importState(h2.data.loopState, h2.time);
    }
    for (const e of log2) {
      if (e.type !== EV.KEY_DOWN) continue;
      stubR.t = e.time;
      const res = peR.processDown({ ...e.data, timestamp: e.time });
      leR.collect(res.events, e.data.char);
    }
    const replayEngineState = J([peR.exportState(), leR.exportState().pending.length]);
    const p2 = liveEngineState === replayEngineState;
    const trimmedHappened = log2.length < 60 && log2[0].type === EV.SESSION_START;

    // -- and once more through allEvents(), the path the UI actually uses -----
    // allEvents() rebases the whole timeline to start at 0, so absolute times
    // shift by a constant. Everything MUSICAL must survive that untouched.
    const stubA = new StubSound();
    const leA = new LoopEngine(stubA, { bpm: 120, quantize: 'OFF' });
    leA.init();
    leA.stop();
    const peA = new (perf.constructor)(mapping, { ...BASE, quantize: 'OFF' });
    const uiLog = se2.allEvents();
    const hA = uiLog[0];
    if (hA.type === EV.SESSION_START && hA.data) {
      peA.importState(hA.data.performanceState);
      leA.importState(hA.data.loopState, hA.time);
    }
    for (const e of uiLog) {
      if (e.type !== EV.KEY_DOWN) continue;
      stubA.t = e.time;
      const res = peA.processDown({ ...e.data, timestamp: e.time });
      leA.collect(res.events, e.data.char);
    }
    // compare the musical projection: beats, notes, velocities, durations, tags
    const proj = (le) => J(le.exportState().pending.map((p) => [round(p.b), p.ev.note, p.ev.velocity, p.ev.duration, p.ev.tag]));
    const p3 = proj(le) === proj(leA);
    const liveExpr = J(dropTimes(pe.exportState()));
    const uiExpr = J(dropTimes(peA.exportState()));
    const p4 = liveExpr === uiExpr;

    add(
      '5c trimmed scratch history replays to the same state',
      p1 && p2 && p3 && p4 && trimmedHappened && naiveCount !== liveCount,
      `counter: live ${liveCount}, replay ${replayCount} (must match) — the same log through the old ` +
        `re-apply-everything scheme would give ${naiveCount} (computed, not a measurement of the old code) · ` +
        `head checkpoint holds ${head.data ? head.data.counter : 'null'}, ${tail.length} events follow it · ` +
        `real engines after trim (${log2.length} events kept): state identical ${p2} · ` +
        `via allEvents() (the UI path, times rebased): beats/notes identical ${p3}, expression state identical ${p4}`
    );
  } catch (e) {
    add('5c trimmed scratch history replays to the same state', false, String(e));
  }

  // =========================================================================
  // 5d. a queued tempo change survives the checkpoint
  // =========================================================================
  // A tempo change takes effect at the end of the lookahead, so at any moment
  // there can be a segment that is part of the performance but has not started
  // yet. v0.2.2 saved only bpm/playingBpm and collapsed the map on restore, so
  // a 120->240 made 50 ms earlier vanished: live beat 0.7 / 240 bpm, replay
  // beat 0.5 / 120 bpm.
  try {
    const stub = new StubSound();
    const le = new LoopEngine(stub, { bpm: 120, quantize: 'OFF' });
    le.init();
    le.stop();
    // A layer that ALREADY exists when the checkpoint is taken. v0.2.2 RC2's
    // version of this test built the layer AFTER importing, which is why it
    // could not see notes going missing at the start of a restored layer.
    const L0 = le.layers[0];
    L0.kind = 'typing'; L0.anchorBeat = 0; L0.lengthBeats = 4; L0.on = true; L0.muted = false;
    L0.events = [
      { b: 0.5, ev: { sourceSeq: 1, note: null, instrument: 'drum', part: 'hat', velocity: 80, duration: 0.1, gated: false, fx: {} } },
      { b: 0.75, ev: { sourceSeq: 2, note: null, instrument: 'drum', part: 'kick', velocity: 80, duration: 0.1, gated: false, fx: {} } },
    ];
    stub.t = 0;
    le._tick(); // queue the lookahead at 120
    stub.t = 0.05;
    le.setBpm(240); // takes effect at the end of what is queued
    const state = le.exportState();

    // restore onto a different audio clock
    const stub2 = new StubSound();
    stub2.t = 100;
    const le2 = new LoopEngine(stub2, { bpm: 120, quantize: 'OFF' });
    le2.init();
    le2.stop();
    le2.importState(state, 100);

    const liveBeat = le.beatAt(0.05 + 0.2);
    const repBeat = le2.beatAt(100 + 0.2);
    const liveBpm = (() => { stub.t = 0.25; return le.playingBpm; })();
    const repBpm = (() => { stub2.t = 100.2; return le2.playingBpm; })();

    // beatAt / secAt must agree either side of the boundary
    const probes = [-0.04, -0.01, 0.0, 0.01, 0.05, 0.2];
    const beatsOk = probes.every((d) => near(le.beatAt(0.05 + d), le2.beatAt(100 + d), 1e-6));
    const secsOk = probes.every((d) => {
      const b = le.beatAt(0.05 + d);
      return near(le.secAt(b) - 0.05, le2.secAt(b) - 100, 1e-6);
    });

    // and the restored engine must still schedule monotonically without dupes
    stub2.played.length = 0;
    for (const t of [100.05, 100.1, 100.2, 100.4]) { stub2.t = t; le2._tick(); }
    const ids = stub2.played.map((p) => `${p.scope}|${p.sourceSeq}`);
    const dupes = ids.filter((k, i) => ids.indexOf(k) !== i);
    let mono = true;
    for (let i = 1; i < stub2.played.length; i++) if (stub2.played[i].when < stub2.played[i - 1].when - 1e-9) mono = false;

    const ok = near(liveBeat, repBeat, 1e-6) && liveBpm === repBpm && liveBpm === 240 && beatsOk && secsOk && dupes.length === 0 && mono;
    add(
      '5d queued tempo change survives the checkpoint',
      ok,
      `200 ms after the checkpoint — live beat ${liveBeat.toFixed(3)} @${liveBpm}bpm, ` +
        `replay beat ${repBeat.toFixed(3)} @${repBpm}bpm · beatAt agrees across the boundary: ${beatsOk} · ` +
        `secAt agrees: ${secsOk} · restored engine scheduled ${stub2.played.length} events, ` +
        `duplicates ${dupes.length}, monotonic ${mono}`
    );
  } catch (e) {
    add('5d queued tempo change survives the checkpoint', false, String(e));
  }

  // =========================================================================
  // 5e. reset() must not leave a checkpoint from the world it destroyed
  // =========================================================================
  // Before the fix: 60 events with a healthy provider, then reset(), then 41
  // events with the provider returning null. The trim reached back and used a
  // pre-reset checkpoint as the head. live 41 -> replay 91, head counter 50.
  try {
    const mk = (providerMode) => {
      let counter = 0;
      let live = true; // provider healthy until we flip it
      const se = new SessionEngine({
        now: () => 0,
        maxEvents: 40,
        trimKeep: 0.75,
        onScratchCheckpoint: () => {
          if (live) return { counter };
          if (providerMode === 'throw') throw new Error('provider down');
          return null;
        },
      });
      se.on('inc', () => counter++);
      for (let i = 0; i < 60; i++) se.dispatch('inc', null, i * 0.01);
      const preIds = se.checkpoints.map((c) => c.id);
      se.reset();
      counter = 0;
      live = false;
      for (let i = 0; i < 41; i++) se.dispatch('inc', null, 100 + i * 0.01);
      return { se, counter, preIds };
    };

    const run = (mode) => {
      const { se, counter, preIds } = mk(mode);
      const log = se.allEvents();
      const head = log[0];
      const headIsCheckpoint = head.type === EV.SESSION_START && head.data;
      const tail = log.filter((e) => e.type !== EV.SESSION_START);
      const replay = (headIsCheckpoint ? head.data.counter : 0) + tail.length;
      const staleLeft = se.checkpoints.filter((c) => preIds.includes(c.id)).length;
      const idsMixed = se.events.some((e) => preIds.includes(e.i));
      return {
        live: counter,
        replay,
        headCounter: headIsCheckpoint ? head.data.counter : null,
        staleLeft,
        idsMixed,
        refuses: !se.canReplayScratch(),
      };
    };

    const nul = run('null');
    const thr = run('throw');
    // Correct behaviour: no pre-reset checkpoint is reachable, no ids mix, the
    // post-reset history is still WHOLE (nothing was dropped just because no
    // checkpoint could be made), so replaying it from the default state
    // reproduces the live count exactly.
    const ok = [nul, thr].every(
      (r) => r.live === 41 && r.replay === 41 && r.headCounter !== 50 && r.staleLeft === 0 && !r.idsMixed && !r.refuses
    );
    add(
      '5e reset() discards pre-reset checkpoints',
      ok,
      `provider null: live ${nul.live}, replay ${nul.replay}, head ${nul.headCounter}, stale checkpoints ${nul.staleLeft}, ` +
        `ids mixed ${nul.idsMixed} · ` +
        `provider throw: live ${thr.live}, replay ${thr.replay}, head ${thr.headCounter}, stale ${thr.staleLeft}, ` +
        `ids mixed ${thr.idsMixed} · (the broken form gave replay 91 with head counter 50)`
    );
  } catch (e) {
    add('5e reset() discards pre-reset checkpoints', false, String(e));
  }

  // =========================================================================
  // 5f. a pre-existing layer is re-queued on the NEW engine after restore
  // =========================================================================
  // The old cursor says "already handed to Web Audio", but those AudioNodes
  // belong to a SoundEngine that the replay has just thrown away. Restoring it
  // meant the stretch between the checkpoint beat and the old cursor was never
  // scheduled at all: live queued [77], replay queued [].
  try {
    const build = () => {
      const s = new StubSound();
      const le = new LoopEngine(s, { bpm: 120, quantize: 'OFF' });
      le.init();
      le.stop();
      const L = le.layers[0];
      L.kind = 'typing'; L.anchorBeat = 0; L.lengthBeats = 4; L.on = true; L.muted = false;
      L.events = [
        // sits between the checkpoint beat (0.1) and the old cursor (0.3)
        { b: 0.2, ev: { sourceSeq: 77, note: null, instrument: 'drum', part: 'hat', velocity: 80, duration: 0.1, gated: false, fx: {} } },
        { b: 1.0, ev: { sourceSeq: 78, note: null, instrument: 'drum', part: 'kick', velocity: 80, duration: 0.1, gated: false, fx: {} } },
      ];
      return { s, le };
    };

    const { s, le } = build();
    s.t = 0;
    le._tick(); // the old engine queues beat 0.2 -- cursor now 0.3
    const liveQueued = s.played.filter((p) => p.when >= 0.05).map((p) => p.sourceSeq);
    s.t = 0.05;
    const state = le.exportState(); // checkpoint at beat 0.1

    const restore = (atSec, nowSec) => {
      const s2 = new StubSound();
      s2.t = nowSec;
      const le2 = new LoopEngine(s2, { bpm: 120, quantize: 'OFF' });
      le2.init();
      le2.stop();
      le2.importState(state, atSec);
      s2.played.length = 0;
      // long enough to cover the next loop iteration as well, so the "past"
      // case can show that the loop keeps running after dropping what it missed
      for (let t = nowSec; t <= nowSec + 3.0; t += 0.05) { s2.t = +t.toFixed(3); le2._tick(); }
      const ids = s2.played.map((p) => `${p.scope}|${p.sourceSeq}`);
      let mono = true;
      for (let i = 1; i < s2.played.length; i++) if (s2.played[i].when < s2.played[i - 1].when - 1e-9) mono = false;
      const first77 = s2.played.find((p) => p.sourceSeq === 77);
      return {
        any77: !!first77,
        // 77 sits 0.1 beat after the checkpoint = 50 ms at 120 bpm
        offset77: first77 ? first77.when - atSec : null,
        firedInPast: s2.played.filter((p) => p.when < nowSec - 1e-9).length,
        dupes: ids.filter((k, i) => ids.indexOf(k) !== i).length,
        mono,
        total: s2.played.length,
      };
    };

    const future = restore(200.4, 200.0); // the app's 400 ms lead-in
    const nowCase = restore(300.0, 300.0);
    const past = restore(400.0, 400.5); // checkpoint already 500 ms behind

    // Future and now: 77 must be queued at its proper place after the checkpoint.
    const okFuture = future.any77 && near(future.offset77, 0.05, 1e-6) && future.dupes === 0 && future.mono && future.firedInPast === 0;
    const okNow = nowCase.any77 && near(nowCase.offset77, 0.05, 1e-6) && nowCase.dupes === 0 && nowCase.mono && nowCase.firedInPast === 0;
    // Past: the first pass is behind us, so it must be SKIPPED rather than fired
    // late; the loop then carries on and 77 returns on its next iteration
    // (beat 0.2 + 4 = 4.2, i.e. 2.05 s after the checkpoint at 120 bpm).
    const okPast = past.any77 && near(past.offset77, 2.05, 1e-6) && past.firedInPast === 0 && past.dupes === 0 && past.mono;

    add(
      '5f restored layer is re-queued on the new engine',
      liveQueued.includes(77) && okFuture && okNow && okPast,
      `live queued after checkpoint [${liveQueued.join(', ')}] · ` +
        `lead-in 400 ms: 77 at checkpoint+${(future.offset77 * 1000).toFixed(1)}ms · ` +
        `atSec = now: 77 at +${(nowCase.offset77 * 1000).toFixed(1)}ms · ` +
        `atSec 500 ms in the past: first pass skipped, 77 returns at +${past.offset77.toFixed(3)}s, ` +
        `nothing fired before now (${past.firedInPast}) · ` +
        `duplicates ${future.dupes + nowCase.dupes + past.dupes}, monotonic ${future.mono && nowCase.mono && past.mono} · ` +
        `(the broken form queued nothing at all)`
    );
  } catch (e) {
    add('5f restored layer is re-queued on the new engine', false, String(e));
  }

  // =========================================================================
  // 5g. a 3-segment tempo map survives export/import without going backwards
  // =========================================================================
  // Storing dBeat and dSec as two independently rounded axes let them disagree.
  // With 120 -> 70 -> 170 the third boundary landed 0.000333 beats BEHIND the
  // instant before it, so beatAt() went backwards across it.
  try {
    const s = new StubSound();
    const le = new LoopEngine(s, { bpm: 120, quantize: 'OFF' });
    le.init();
    le.stop();
    s.t = 0;
    le._tick();
    s.t = 0.05;
    le.setBpm(70);
    s.t = 0.12;
    le._tick();
    le.setBpm(170);
    s.t = 0.2;
    le._tick();
    const state = le.exportState();
    const segCount = state.tempoSegments.length;
    const hasSec = state.tempoSegments.some((x) => x.dSec !== undefined);

    const s2 = new StubSound();
    s2.t = 500;
    const le2 = new LoopEngine(s2, { bpm: 120, quantize: 'OFF' });
    le2.init();
    le2.stop();
    le2.importState(state, 500);

    // walk densely across every boundary
    const bounds = le2.tempoSegments.map((x) => x.startBeat);
    const probes = [];
    for (const b of bounds) for (const d of [-1e-4, -1e-9, 0, 1e-9, 1e-4]) probes.push(b + d);
    probes.sort((a, b) => a - b);

    let beatMono = true;
    let secMono = true;
    let roundTrip = true;
    let prevSec = -Infinity;
    for (const b of probes) {
      const sec = le2.secAt(b);
      if (sec < prevSec - 1e-12) secMono = false;
      prevSec = sec;
      if (Math.abs(le2.beatAt(sec) - b) > 1e-9) roundTrip = false;
    }
    let prevBeat = -Infinity;
    for (let t = 499.9; t <= 501; t += 0.001) {
      const b = le2.beatAt(+t.toFixed(4));
      if (b < prevBeat - 1e-12) beatMono = false;
      prevBeat = b;
    }
    // startBeat order and startSec order must be the same order
    const orderOk = le2.tempoSegments.every((x, i, a) => i === 0 || (x.startBeat >= a[i - 1].startBeat && x.startSec >= a[i - 1].startSec));
    // and the map must match the original, shifted by the rebase
    const shapeOk = le2.tempoSegments.every((x, i) =>
      near(x.startBeat - le2.tempoSegments[0].startBeat, le.tempoSegments[i].startBeat - le.tempoSegments[0].startBeat, 1e-9)
    );

    const ok = segCount >= 3 && !hasSec && beatMono && secMono && roundTrip && orderOk && shapeOk;
    add(
      '5g 3-segment tempo map keeps its topology across a checkpoint',
      ok,
      `${segCount} segments exported (${le.tempoSegments.map((x) => x.bpm).join('→')}), seconds stored: ${hasSec} (must be false) · ` +
        `beatAt monotonic ${beatMono} · secAt monotonic ${secMono} · secAt(beatAt(t))==t ${roundTrip} · ` +
        `beat order == second order ${orderOk} · map shape preserved ${shapeOk}`
    );
  } catch (e) {
    add('5g 3-segment tempo map keeps its topology across a checkpoint', false, String(e));
  }

  // =========================================================================
  // 6. scratch replay restores its opening settings
  // =========================================================================
  try {
    const opening = { bpm: 96, complexity: 20, soundSet: 'minimal', quantize: 'STRONG', masterVolume: 0.5 };
    const scratchLog = log([
      [0.0, EV.SESSION_START, { beatAtStart: 3, settings: opening }],
      [0.5, EV.KEY_DOWN, key(0, 0.5, 'KeyJ', 'j')],
      [0.56, EV.KEY_UP, { seq: 0, holdMs: 60 }],
    ]);
    const r = simulateSession(scratchLog, mapping, { bpm: 170, complexity: 95, soundSet: 'noise', quantize: 'OFF', masterVolume: 1 });
    const ok = r.settings.bpm === 96 && r.settings.complexity === 20 && r.settings.soundSet === 'minimal' && r.settings.quantize === 'STRONG';
    add('6 scratch replay restores its opening settings', ok, `ended at bpm${r.settings.bpm}/cx${r.settings.complexity}/${r.settings.soundSet}/${r.settings.quantize}`);
  } catch (e) {
    add('6 scratch replay restores its opening settings', false, String(e));
  }

  // =========================================================================
  // 7. CLEAR ALL refused while recording (button AND handler)
  // =========================================================================
  {
    let restore = null;
    try {
      if (recorder.recording) {
        add('7 CLEAR ALL refused while recording', null, 'skipped: a real take is in progress');
      } else {
        const added = loop.addBuiltin('beat', SCALES[settings.soundSet] || SCALES.electronic);
        if (added && added.error) {
          add('7 CLEAR ALL refused while recording', null, 'skipped: no free layer to test with');
        } else {
          const target = added.layer;
          const btn = document.getElementById('clearBtn');
          const before = loop.layers[target].events.length;
          const wasDisabled = btn.disabled;
          restore = () => {
            recorder.recording = false;
            btn.disabled = wasDisabled;
            loop.clearLayer(target);
          };
          recorder.recording = true;
          btn.disabled = true; // as $('recBtn') does
          const disabledSeen = btn.disabled === true;
          btn.click();
          const afterButton = loop.layers[target].events.length;
          session.apply({ type: EV.CLEAR_ALL, data: null });
          const afterHandler = loop.layers[target].events.length;
          const ok = before > 0 && disabledSeen && afterButton === before && afterHandler === before;
          add(
            '7 CLEAR ALL refused while recording',
            ok,
            `layer had ${before} events · clearBtn.disabled === true: ${disabledSeen} · after click ${afterButton} · after direct CLEAR_ALL ${afterHandler}`
          );
        }
      }
    } catch (e) {
      add('7 CLEAR ALL refused while recording', false, String(e));
    } finally {
      if (restore) {
        try {
          restore();
        } catch (e) {
          /* nothing sensible to do */
        }
      }
    }
  }

  // =========================================================================
  // 8. a stale release timer cannot cut short a reused voice key
  // =========================================================================
  // CLEAR ALL resets the InputEngine sequence, so the next note is `live:0`
  // again. The 4.2 s safety timer armed before the clear used to be able to
  // release it.
  try {
    const timers = [];
    const se = new SoundEngine({
      setTimeout: (fn) => {
        timers.push(fn);
        return timers.length - 1;
      },
      clearTimeout: (id) => {
        if (timers[id]) timers[id] = null;
      },
    });
    const released = [];
    const mkHandle = (label) => ({ minEnd: 0, release: () => released.push(label) });

    se._registerGated('live:0', mkHandle('old')); // note before CLEAR
    se.releaseAll(); // CLEAR ALL
    const afterClear = released.slice();
    const staleTimers = timers.slice(); // everything armed BEFORE the new note
    se._registerGated('live:0', mkHandle('new')); // seq reset -> same key again

    // Fire only the timers that existed before the new note. Firing the new
    // note's own safety timer would release it legitimately and prove nothing.
    const stillArmed = staleTimers.filter(Boolean).length;
    staleTimers.forEach((fn) => fn && fn());

    const newSurvived = !released.slice(afterClear.length).includes('new');
    add(
      '8 stale release timer cannot cut a reused key',
      afterClear.includes('old') && newSurvived && stillArmed === 0,
      `old note released by CLEAR: ${afterClear.includes('old')} · its safety timer was cancelled: ${stillArmed === 0} ` +
        `(${stillArmed} of ${staleTimers.length} still armed) · firing every stale timer released the new note: ${!newSurvived} — must be false ` +
        `· sequence: [${released.join(', ')}]`
    );
  } catch (e) {
    add('8 stale release timer cannot cut a reused key', false, String(e));
  }

  // =========================================================================
  // 9. Backspace is a note, not an undo
  // =========================================================================
  try {
    const bsLog = log([
      [0.0, EV.SESSION_START, { beatAtStart: 0, settings: BASE }],
      [0.5, EV.KEY_DOWN, key(0, 0.5, 'KeyJ', 'j')],
      [0.56, EV.KEY_UP, { seq: 0, holdMs: 60 }],
      [0.7, EV.KEY_DOWN, key(1, 0.7, 'KeyK', 'k')],
      [0.76, EV.KEY_UP, { seq: 1, holdMs: 60 }],
      [0.9, EV.KEY_DOWN, key(2, 0.9, 'Backspace', '\b')],
      [1.4, EV.KEY_DOWN, key(3, 1.4, 'Enter', '\n')],
    ]);
    const r = simulateSession(bsLog, mapping, BASE);
    const rewind = r.perf.filter((e) => e.tag === 'rewind');
    const layer0 = r.layerEvents[0] || [];
    add(
      '9 Backspace is a note, not an undo',
      rewind.length === 1 && layer0.some((x) => x[4] === 'rewind') && layer0.length >= 3,
      `reverse events: ${rewind.length} · kept in layer: ${layer0.some((x) => x[4] === 'rewind')} · layer holds ${layer0.length}`
    );
  } catch (e) {
    add('9 Backspace is a note, not an undo', false, String(e));
  }

  // =========================================================================
  // 10. IME + held-key guard
  // =========================================================================
  try {
    const seen = [];
    const ime = new InputEngine({ now: () => 0, onDown: (e) => seen.push(e.code), onUp: () => {} });
    ime.setComposing(true);
    ime.handleKeyDown({ code: 'Enter', key: 'Enter', isComposing: true, shiftKey: false });
    ime.handleKeyDown({ code: 'Space', key: ' ', isComposing: true, shiftKey: false });
    ime.handleKeyDown({ code: 'KeyF', key: 'f', isComposing: true, shiftKey: false });
    const during = seen.slice();
    const heldWhileDown = ime.hasHeldKeys;
    ime.handleKeyUp({ code: 'KeyF', key: 'f' });
    const heldAfterUp = ime.hasHeldKeys;
    ime.setComposing(false);
    ime.handleKeyDown({ code: 'Enter', key: 'Enter', isComposing: false, shiftKey: false });
    const ok = during.length === 1 && during[0] === 'KeyF' && seen.includes('Enter') && heldWhileDown && !heldAfterUp;
    add(
      '10 IME confirm ignored; held-key guard reports correctly',
      ok,
      `while composing accepted [${during.join(', ')}] · hasHeldKeys while down: ${heldWhileDown}, after keyup: ${heldAfterUp} · Enter works after composing: ${seen.includes('Enter')}`
    );
  } catch (e) {
    add('10 IME confirm ignored; held-key guard reports correctly', false, String(e));
  }

  // =========================================================================
  // 11. boot: START cannot be clicked before the code is ready
  // =========================================================================
  try {
    const marks = window.__bootLog || [];
    const codes = marks.map((e) => e.code);
    const wasDisabled = window.__startInitiallyDisabled === true;
    const readyAt = codes.indexOf('M04');
    const firstClick = codes.indexOf('C01');
    const clicks = marks.filter((e) => e.code === 'C01').length;
    // Opening a piece is a repeatable action now, so the number of entry
    // clicks is not fixed. What must still hold is that the FIRST one landed
    // after the module was ready -- a click into that gap is the bug this
    // test exists for -- and that the audio engine was only ever started once,
    // however many pieces have been opened since.
    const boots = marks.filter((e) => e.code === 'B01').length;
    const ok = wasDisabled && codes.includes('APP') && clicks >= 1 && boots === 1 && readyAt >= 0 && firstClick > readyAt;
    add(
      '11 boot sequence',
      ok,
      `entry points shipped disabled: ${wasDisabled} · ${clicks} entry click(s), the first after MODULE_READY: ${firstClick > readyAt} · ` +
        `audio started exactly once across all of them: ${boots === 1} · reached APP_READY: ${codes.includes('APP')}`
    );
  } catch (e) {
    add('11 boot sequence', false, String(e));
  }

  // =========================================================================
  // 12. the start gate is actually GONE after START, not just flagged hidden
  // =========================================================================
  // `boot()` set gate.hidden = true and app.hidden = false, and every earlier
  // check passed -- while the start screen stayed on screen at full size,
  // z-index 50, swallowing every click meant for the app. `#gate { display:
  // grid }` outranks the UA rule `[hidden] { display: none }`, so the
  // attribute did nothing at all.
  //
  // Checking DOM flags is not checking the screen. This looks at what is
  // actually rendered, and at where a click would land.
  try {
    const gate = document.getElementById('home');
    const appEl = document.getElementById('app');
    const gateStyle = getComputedStyle(gate).display;
    const appStyle = getComputedStyle(appEl).display;
    const box = gate.getBoundingClientRect();
    const centre = document.elementFromPoint(Math.floor(window.innerWidth / 2), Math.floor(window.innerHeight / 2));
    const gateOnTop = !!(centre && gate.contains(centre));

    // The attribute must still work BOTH ways on everything that toggles it,
    // so the fix cannot degenerate into "stop using hidden".
    const toggles = ['bootErr', 'bootStage', 'debug', 'hiddenWarn'].map((id) => {
      const el = document.getElementById(id);
      if (!el) return { id, ok: false };
      const was = el.hidden;
      el.hidden = true;
      const off = getComputedStyle(el).display;
      el.hidden = false;
      const on = getComputedStyle(el).display;
      el.hidden = was;
      return { id, ok: off === 'none' && on !== 'none' };
    });
    const togglesOk = toggles.every((t) => t.ok);

    const ok =
      gate.hidden === true &&
      gateStyle === 'none' &&
      appEl.hidden === false &&
      appStyle !== 'none' &&
      box.width === 0 &&
      box.height === 0 &&
      !gateOnTop &&
      togglesOk;

    add(
      '12 the home screen is really gone once a piece is open',
      ok,
      `home.hidden ${gate.hidden}, computed display "${gateStyle}", box ${box.width}x${box.height}, ` +
        `covering the centre of the screen: ${gateOnTop} · app.hidden ${appEl.hidden}, display "${appStyle}" · ` +
        `[hidden] honoured both ways on ${toggles.filter((t) => t.ok).length}/${toggles.length} toggling elements`
    );
  } catch (e) {
    add('12 the home screen is really gone once a piece is open', false, String(e));
  }

  // =========================================================================
  // 13. a very long Phrase must not widen the page
  // =========================================================================
  // A grid item's default min-width is `auto` = min-content, so one unbroken
  // 500-character "word" in CURRENT/Phrase made the middle column refuse to
  // shrink and pushed WHAT YOUR HANDS DO clean off the right of the screen.
  {
    const cPhrase = document.getElementById('cPhrase');
    const anchor = document.getElementById('storyPanel');
    const titleEl = document.getElementById('titleInput');
    const wasText = cPhrase ? cPhrase.textContent : null;
    const wasTitle = cPhrase ? cPhrase.title : null;
    const wasProjectTitle = titleEl ? titleEl.value : null;
    try {
      if (!cPhrase || !anchor || !titleEl) {
        add('13 long text does not widen the page', null, 'skipped: the play surface is not on screen');
      } else {
        const holder = cPhrase.closest('#play') || cPhrase.parentElement;
        const before = { panel: holder.getBoundingClientRect().width };

        // Three separate places a person can put 500 unbroken characters: the
        // phrase readout, the piece title, and the play surface itself.
        const long = 'a'.repeat(500);
        cPhrase.textContent = long;
        cPhrase.title = long;
        titleEl.value = long;
        void document.documentElement.offsetWidth; // force layout

        const doc = document.documentElement;
        const noHScroll = doc.scrollWidth <= doc.clientWidth;
        const anchorBox = anchor.getBoundingClientRect();
        const anchorInside = anchorBox.right <= window.innerWidth + 1 && anchorBox.width > 0;
        const phraseBox = cPhrase.getBoundingClientRect();
        const titleBox = titleEl.getBoundingClientRect();
        const titleInside = titleBox.right <= window.innerWidth + 1;
        const after = { panel: holder.getBoundingClientRect().width };
        const panelStable = Math.abs(after.panel - before.panel) < 1;
        const clipped = phraseBox.width < long.length * 4; // nowhere near 500 chars wide
        const ellipsis = getComputedStyle(cPhrase).textOverflow === 'ellipsis';
        const titleHasFull = cPhrase.title === long;

        const ok = noHScroll && anchorInside && titleInside && panelStable && clipped && ellipsis && titleHasFull;
        add(
          '13 long text does not widen the page',
          ok,
          `500 unbroken characters in the phrase readout AND the piece title · ` +
            `page scrollWidth ${doc.scrollWidth} vs clientWidth ${doc.clientWidth} (no h-scroll: ${noHScroll}) · ` +
            `Story panel right edge ${Math.round(anchorBox.right)} of ${window.innerWidth} (inside: ${anchorInside}) · ` +
            `title stays inside: ${titleInside} · play surface ${Math.round(before.panel)} → ${Math.round(after.panel)} ` +
            `(stable: ${panelStable}) · phrase clipped to ${Math.round(phraseBox.width)}px with ellipsis: ${ellipsis} · ` +
            `full text kept in title attribute: ${titleHasFull}`
        );
      }
    } catch (e) {
      add('13 long text does not widen the page', false, String(e));
    } finally {
      if (cPhrase) {
        cPhrase.textContent = wasText;
        cPhrase.title = wasTitle;
      }
      if (titleEl) titleEl.value = wasProjectTitle;
    }
  }

  // =========================================================================
  // 14. caret and editing keys are not part of the performance
  // =========================================================================
  // Moving the cursor is navigation, not playing. These keys must not sound,
  // must not become events, and must not disturb keys/sec, the repeat counter,
  // the alternation streak or the interval that colours the NEXT note.
  try {
    const seen = [];
    const eng = new InputEngine({ now: () => 1.5, onDown: (e) => seen.push(e.code), onUp: () => {} });
    const snapshot = () => J([eng.seq, eng.lastDownTime, eng.recent.slice(), eng.word, eng.held.size]);
    const before = snapshot();

    const keys = [
      'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End',
      'PageUp', 'PageDown', 'Insert', 'Delete', 'PrintScreen', 'ScrollLock',
      'Pause', 'NumLock', 'ContextMenu', 'Escape', 'CapsLock',
      'ShiftLeft', 'ControlLeft', 'AltLeft', 'MetaLeft', 'F1', 'F12',
    ];
    for (const code of keys) {
      eng.handleKeyDown({ code, key: code, isComposing: false, shiftKey: false });
      eng.handleKeyUp({ code, key: code });
    }
    const after = snapshot();
    const silent = seen.length === 0 && before === after;

    // positive control: the same engine must still respond to a real key,
    // otherwise "nothing happened" proves nothing
    eng.handleKeyDown({ code: 'KeyJ', key: 'j', isComposing: false, shiftKey: false });
    const reacts = seen.length === 1 && seen[0] === 'KeyJ' && snapshot() !== after;

    // and the same through the LIVE app: counters must not move. Only
    // non-musical keys are sent, so this cannot make a sound.
    const el = document.getElementById('text');
    const countsBefore = J([recorder.raw.length, recorder.perf.length, session.events.length]);
    for (const code of ['ArrowLeft', 'Home', 'End', 'Delete', 'PageDown', 'Insert']) {
      el.dispatchEvent(new KeyboardEvent('keydown', { key: code, code, bubbles: true }));
      el.dispatchEvent(new KeyboardEvent('keyup', { key: code, code, bubbles: true }));
    }
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    const countsAfter = J([recorder.raw.length, recorder.perf.length, session.events.length]);
    const liveUnchanged = countsBefore === countsAfter;

    add(
      '14 caret and editing keys are not performance',
      silent && reacts && liveUnchanged,
      `${keys.length} navigation/modifier keys produced ${seen.length - (reacts ? 1 : 0)} events and left ` +
        `seq/lastDownTime/keys-per-sec window/word/held untouched: ${silent} · ` +
        `a real key still plays (positive control): ${reacts} · ` +
        `live raw/performance/session counts after caret keys and a mouse click: ${countsBefore} → ${countsAfter} (${liveUnchanged})`
    );
  } catch (e) {
    add('14 caret and editing keys are not performance', false, String(e));
  }

  // =========================================================================
  // 15. COMMIT LOOP is an ordinary Enter  --  in an ISOLATED instrument
  // =========================================================================
  // The previous version of this test drove the REAL application and put a
  // handful of array lengths back afterwards. It was not isolated: nextId,
  // the checkpoint counter, recorder.text, the take buffers, InputEngine.word
  // and the caret were all left wherever it had moved them. `word` rides
  // inside every logged key event, so running the suite twice made this test
  // fail the second time for a reason that had nothing to do with the button.
  //
  // It now builds its own complete instrument (see fixture.js) and never
  // touches the live one. Test 26 proves that claim by comparing a deep
  // snapshot of the live app taken before and after the whole suite.
  try {
    const mk = () => createFixture({ mapping, quantize: 'LIGHT' });

    // --- the physical Enter key -------------------------------------------
    const a = mk();
    a.at(1.0).composing = true;
    const aStart = a.session.events.length;
    a.typeWord('hjk');
    const aCommitted = a.commitViaKeyboard();
    const viaKeyboard = a.slice(aStart);
    const aLayers = J(a.view().layers.map((l) => [l.kind, l.eventCount, l.lengthBeats]));

    // --- the COMMIT LOOP button -------------------------------------------
    // Same script, same clock, same starting state. Two instruments that have
    // done exactly the same thing must have written exactly the same log.
    const b = mk();
    b.at(1.0).composing = true;
    const bStart = b.session.events.length;
    b.typeWord('hjk');
    const bCommitted = b.commitViaButton();
    const viaButton = b.slice(bStart);
    const bLayers = J(b.view().layers.map((l) => [l.kind, l.eventCount, l.lengthBeats]));

    // Nothing is stripped. Both fixtures ran on a clock the test drives by
    // hand, so even the timestamps have to agree -- if a comparison here has
    // to ignore a field, that field is a real difference between the two paths.
    const sameLog = J(viaKeyboard) === J(viaButton);
    const sameResult = aLayers === bLayers;
    const bothClosed = aCommitted && bCommitted && !a.composing && !b.composing;

    // --- the caret ---------------------------------------------------------
    // setRangeText, not `value +=`: the newline goes where the user is working.
    const c = mk();
    c.at(1.0);
    c.typeWord('hj'); // play something first -- typing appends and moves the caret
    c.textEl.value = 'ABCD';
    c.textEl.setSelectionRange(2, 2);
    c.commitViaButton();
    const caretOk = c.textEl.value === 'AB\nCD';

    // --- refusals ----------------------------------------------------------
    // Each one must refuse AND leave the waiting notes alone: a refusal that
    // quietly eats the phrase is worse than no button at all.
    const d = mk();
    d.at(1.0);
    d.typeWord('hj');
    const pendingBefore = d.view().pending.count;
    const logBefore = d.session.events.length;

    d.session.replaying = true;
    const refusedReplay = d.commitViaButton() === false;
    d.session.replaying = false;

    d.input.setComposing(true);
    const refusedIme = d.commitViaButton() === false;
    d.input.setComposing(false);

    // all four tracks full
    const e = mk();
    e.at(1.0);
    for (let i = 0; i < 4; i++) e.session.dispatch(EV.ADD_BUILTIN_LOOP, { loop: 'beat' });
    e.typeWord('hj');
    const refusedFull = e.commitViaButton() === false;

    // nothing played yet
    const f = mk();
    f.at(1.0);
    const refusedEmpty = f.commitViaButton() === false;

    const logQuiet =
      d.session.events.length === logBefore &&
      d.view().pending.count === pendingBefore &&
      pendingBefore > 0;
    const emptyQuiet = f.session.events.length === 0;

    // --- CLOSE — KEEP NOTES ------------------------------------------------
    // Closing the panel is a UI act, not a musical one: it must not touch the
    // engine at all.
    const keptCount = d.view().pending.count;
    d.composing = false;
    const keptNotes = d.view().pending.count === keptCount && keptCount > 0;

    // --- the live button, read only ----------------------------------------
    // The fixture proves the shared code is identical. This proves the real
    // button is wired to it and reflects the same rule -- without pressing it.
    const liveBtn = document.getElementById('commitBtn');
    const liveView = loop.composerSnapshot();
    const liveAgrees = !liveBtn || liveBtn.disabled === !ui.canCommit(liveView);
    const liveHasHandler = !!(liveBtn && typeof liveBtn.onclick === 'function');

    const ok =
      sameLog && sameResult && bothClosed && caretOk &&
      refusedReplay && refusedIme && refusedFull && refusedEmpty &&
      logQuiet && emptyQuiet && keptNotes && liveAgrees && liveHasHandler;

    add(
      '15 COMMIT LOOP is an ordinary Enter (isolated fixture)',
      ok,
      `two independent instruments, same script: ${viaButton.length}-event logs ` +
        `[${viaButton.map((x) => x.type).join(' → ')}] compared field for field with nothing stripped — identical: ${sameLog} · ` +
        `same layers: ${sameResult} · both closed the panel: ${bothClosed} · ` +
        `newline landed at the caret ("AB\\nCD"): ${caretOk} · ` +
        `refused during replay: ${refusedReplay}, during IME: ${refusedIme}, with 4 tracks full: ${refusedFull}, ` +
        `with nothing played: ${refusedEmpty} · refusals added 0 events and kept ${pendingBefore} notes waiting: ${logQuiet && emptyQuiet} · ` +
        `closing the panel kept ${keptCount} notes: ${keptNotes} · ` +
        `the live button agrees with canCommit and is wired: ${liveAgrees && liveHasHandler} · ` +
        `the live app was not touched (see test 26)`
    );

    a.dispose(); b.dispose(); c.dispose(); d.dispose(); e.dispose(); f.dispose();
  } catch (e) {
    add('15 COMMIT LOOP is an ordinary Enter (isolated fixture)', false, String(e));
  }

  // =========================================================================
  // 15b. a volume drag ends, whatever way it ends
  // =========================================================================
  // Rendering is suppressed while a slider is being dragged, so MISSING the end
  // of the drag freezes the track cards and the next ON / MUTE / DELETE appears
  // to do nothing. Releasing outside the window, or after Alt+Tab, produces no
  // pointerup on the slider at all -- which is exactly the case the old code
  // did not cover.
  try {
    const paths = [];
    const check = (name, fire, opts) => {
      let ends = 0;
      const d = new VolumeDrag(() => ends++, opts);
      d.begin(1);
      const wasActive = d.active;
      fire(d);
      paths.push({ name, ok: wasActive && !d.active && ends === 1, ends });
      d.dispose();
    };

    check('pointerup on the slider', (d) => d.end());
    check('pointer released outside the window', () => window.dispatchEvent(new Event('pointerup')));
    check('gesture cancelled', () => window.dispatchEvent(new Event('pointercancel')));
    check('Alt+Tab (window blur, no pointer event at all)', () => window.dispatchEvent(new Event('blur')));
    check(
      'tab hidden mid-drag',
      () => document.dispatchEvent(new Event('visibilitychange')),
      { isDocumentHidden: () => true }
    );

    // ending twice must not fire twice: the listeners overlap by design
    let doubles = 0;
    const dd = new VolumeDrag(() => doubles++);
    dd.begin(2);
    dd.end();
    dd.end();
    window.dispatchEvent(new Event('pointerup'));
    const idempotent = doubles === 1;
    dd.dispose();

    // and a drag that was never started must stay silent
    let spurious = 0;
    const idle = new VolumeDrag(() => spurious++);
    window.dispatchEvent(new Event('pointerup'));
    window.dispatchEvent(new Event('blur'));
    const quietWhenIdle = spurious === 0 && !idle.active;
    idle.dispose();

    const allOk = paths.every((p) => p.ok) && idempotent && quietWhenIdle;
    add(
      '15b a volume drag ends on every exit path',
      allOk,
      paths.map((p) => `${p.name}: ${p.ok ? 'ended' : 'STUCK'}`).join(' · ') +
        ` · ending twice fires the rebuild once: ${idempotent} · ` +
        `events with no drag open are ignored: ${quietWhenIdle}`
    );
  } catch (e) {
    add('15b a volume drag ends on every exit path', false, String(e));
  }
  // =========================================================================
  // 16. the timeline shows how long a note was held
  // =========================================================================
  // A held key must be visibly a longer block than a tap, otherwise the
  // sustain rule is invisible and nobody learns it.
  try {
    const buildTimeline = ui && ui.buildTimeline;
    if (typeof buildTimeline !== 'function') throw new Error('the production buildTimeline was not passed in');

    // a real committed layer: one tap, one long hold
    const stub = new StubSound();
    const le = new LoopEngine(stub, { bpm: 120, quantize: 'OFF' });
    le.init();
    le.stop();
    const mk = (seq, dur, time) => ({
      time, sourceSeq: seq, instrument: 'melody', note: 60, velocity: 90,
      duration: dur, gated: true, fx: {}, tag: 'scale',
    });
    stub.t = 0;
    le.collect([mk(1, 0.1, 0)], 'j'); // tap
    stub.t = 0.5;
    le.collect([mk(2, 1.2, 0.5)], 'k'); // held
    stub.t = 1.0;
    le.commitLayer();

    // render it with the SHIPPING function, into a real (detached) element
    const draw = () => {
      const v = le.composerSnapshot();
      const el = buildTimeline(v.layers[0], {
        live: true,
        playingBpm: v.playingBpm,
        beatsPerBar: v.beatsPerBar,
      });
      const blocks = [...el.querySelectorAll('.blk')];
      const bySeq = {};
      v.layers[0].events.forEach((ev, i) => { bySeq[ev.sourceSeq] = parseFloat(blocks[i].style.width); });
      return { count: blocks.length, bySeq, lefts: blocks.map((b) => parseFloat(b.style.left)) };
    };

    const at120 = draw();
    const hasBlocks = at120.count === 2; // 0 blocks is a failure, not a pass
    const wTap = at120.bySeq[1];
    const wHeld = at120.bySeq[2];
    const heldIsLonger = hasBlocks && wHeld > wTap * 5;

    // tempo change must redraw the widths; x stays put because it is in beats
    le.setBpm(240);
    const at240 = draw();
    const widthsChanged = hasBlocks && Math.abs(at240.bySeq[2] - wHeld) > 1;
    const leftsUnchanged = J(at120.lefts) === J(at240.lefts);
    const inRange = [wTap, wHeld, at240.bySeq[1], at240.bySeq[2]].every((w) => w > 0 && w <= 100);

    const ok = hasBlocks && heldIsLonger && widthsChanged && leftsUnchanged && inRange;
    add(
      '16 timeline width follows note length and tempo',
      ok,
      `rendered with the production buildTimeline: ${at120.count} blocks (0 would be a failure) · ` +
        `at 120bpm tap 0.10s → ${wTap.toFixed(1)}%, held 1.20s → ${wHeld.toFixed(1)}% (${(wHeld / wTap).toFixed(1)}× wider) · ` +
        `at 240bpm they become ${at240.bySeq[1].toFixed(1)}% / ${at240.bySeq[2].toFixed(1)}% (widths redrawn: ${widthsChanged}) · ` +
        `x positions unchanged by tempo: ${leftsUnchanged} · all widths within 0-100%: ${inRange}`
    );
  } catch (e) {
    add('16 timeline width follows note length and tempo', false, String(e));
  }

  // =========================================================================
  // 17. planPendingLayer hands out a copy, all the way down
  // =========================================================================
  // The plan is what the screen reads to say "2 bars, 9 notes". It used to be
  // built with Object.assign({}, ev), which copies the top level and SHARES
  // everything nested -- so `plan.rel[0].ev.fx.delay = 9` reached through into
  // a note that had not been committed yet.
  try {
    const fx = createFixture({ mapping });
    fx.at(1.0).typeWord('hjk');
    const plan = fx.loop.planPendingLayer();

    // poke every nested thing a PerformanceEvent has
    plan.rel[0].ev.fx.delay = 999;
    plan.rel[0].ev.fx.feedback = 999;
    plan.rel[0].ev.velocity = 1;
    plan.rel[0].ev.fx.nested = { deeper: [1, 2, 3] };
    plan.rel[0].b = -42;
    if (plan.rel[0].ev.chord) plan.rel[0].ev.chord[0] = -1;

    const live = fx.loop.pending.filter((p) => p.ev.tag !== 'layer-commit')[0].ev;
    const untouched =
      live.fx.delay !== 999 && live.fx.feedback !== 999 && live.velocity !== 1 && live.fx.nested === undefined;

    // and the same again for the composer view the UI actually renders
    const view = fx.loop.composerSnapshot();
    fx.commitViaKeyboard();
    const view2 = fx.loop.composerSnapshot();
    const ev0 = view2.layers[0].events[0];
    ev0.fx.delay = 777;
    ev0.duration = -5;
    if (ev0.chord) ev0.chord[0] = -1;
    const liveLayer = fx.loop.layers[0].events[0].ev;
    const viewUntouched = liveLayer.fx.delay !== 777 && liveLayer.duration !== -5;

    // a copy is only a copy if it was ever populated
    const meaningful = live.fx && typeof live.fx.delay === 'number' && view.pending.count > 0;

    add(
      '17 planPendingLayer and composerSnapshot are deep copies',
      untouched && viewUntouched && meaningful,
      `wrote fx.delay/fx.feedback/velocity/a new nested object through the plan — the pending note is unchanged: ${untouched} · ` +
        `wrote fx.delay and duration through composerSnapshot — the committed note is unchanged: ${viewUntouched} · ` +
        `the fields being poked really exist (fx.delay = ${live.fx.delay}, ${view.pending.count} notes pending): ${meaningful}`
    );
    fx.dispose();
  } catch (e) {
    add('17 planPendingLayer and composerSnapshot are deep copies', false, String(e));
  }

  // =========================================================================
  // 18. Piano and Plucked decay by themselves
  // =========================================================================
  // The claim on the box is that these two are STRUCK instruments: loudest at
  // the attack, always decaying after it, and still decaying while the key is
  // held. This records what is actually scheduled on the gain curve rather than
  // trusting the config, and checks the three things that would make it a lie:
  // a flat sustain, one decay time for the whole keyboard, and a release that
  // chops rather than damps.
  try {
    const rows = [];
    const probe = (world, midi, held) => {
      const eng = new SoundEngine();
      eng.setName = world;
      const cfg = SOUND_SETS[world].struck;
      const decay = eng._struckDecay(cfg, midi);
      const damp = eng._struckDamp(cfg, midi);
      rows.push({ world, midi, held, decay, damp });
      return { decay, damp };
    };

    const pLow = probe('piano', 36, 0.1);
    const pHigh = probe('piano', 96, 0.1);
    const kLow = probe('plucked', 36, 0.1);
    const kHigh = probe('plucked', 96, 0.1);

    // low notes ring far longer than high ones, in both worlds
    const pianoRange = pLow.decay > pHigh.decay * 4;
    const pluckRange = kLow.decay > kHigh.decay * 4;
    // plucked is the shorter instrument of the two
    const pluckShorter = kLow.decay < pLow.decay && kHigh.decay < pHigh.decay;
    // damping is fast, but never instantaneous -- a zero-length damp is a click
    const dampsNotChops = [pLow, pHigh, kLow, kHigh].every((r) => r.damp >= 0.04 && r.damp < 0.4);
    // high notes damp faster than low ones, as felt does
    const dampFollowsPitch = pHigh.damp < pLow.damp && kHigh.damp < kLow.damp;

    // the envelope itself: read what gets written to the gain curve
    const env = renderStruckEnvelope('piano', 60, SoundEngine, SOUND_SETS, 0.9);
    const decaysWhileHeld = env.at(0.05) > env.at(0.9) * 1.5; // still falling, untouched
    const loudestAtAttack = env.peakAt < 0.05;
    const gatedFieldsPresent = env.hasRelease && env.hasDamp;

    const ok =
      pianoRange && pluckRange && pluckShorter && dampsNotChops && dampFollowsPitch &&
      decaysWhileHeld && loudestAtAttack && gatedFieldsPresent;

    add(
      '18 Piano and Plucked decay by themselves, by pitch',
      ok,
      `piano decay ${pLow.decay.toFixed(2)}s at midi 36 → ${pHigh.decay.toFixed(2)}s at midi 96 ` +
        `(low rings ${(pLow.decay / pHigh.decay).toFixed(1)}× longer: ${pianoRange}) · ` +
        `plucked ${kLow.decay.toFixed(2)}s → ${kHigh.decay.toFixed(2)}s (${pluckRange}), and is shorter than piano everywhere: ${pluckShorter} · ` +
        `release damps over ${pLow.damp.toFixed(3)}–${kHigh.damp.toFixed(3)}s instead of cutting: ${dampsNotChops}, ` +
        `faster for high notes: ${dampFollowsPitch} · ` +
        `held for 0.9s with no key-up the level still fell ${(env.at(0.05) / Math.max(env.at(0.9), 1e-6)).toFixed(1)}×: ${decaysWhileHeld} · ` +
        `loudest at ${env.peakAt.toFixed(3)}s: ${loudestAtAttack}`
    );
  } catch (e) {
    add('18 Piano and Plucked decay by themselves, by pitch', false, String(e));
  }

  // =========================================================================
  // 19. the same event always makes the same sound
  // =========================================================================
  // Every parameter a struck voice uses has to come from the event and the
  // config, never from a clock or a counter. Rendering the same event twice
  // through the real _struck() and diffing every AudioParam call is the only
  // way to be sure -- reading the source for Math.random() proves less than it
  // looks like it does (test 29 does that too, for the whole graph).
  try {
    const shot = (world, ev, t) => {
      const rec = new RecordingContext();
      const eng = new SoundEngine();
      eng.ctx = rec;
      eng.setName = world;
      eng.noiseBuf = { length: 1 };
      const amp = rec.createGain();
      eng._struck(ev, t, amp, SOUND_SETS[world].model, ev.instrument);
      return rec.calls;
    };
    const ev = {
      instrument: 'melody', note: 64, freq: 329.63, duration: 0.4, gated: true,
      velocity: 96, pan: 0, fx: { delay: 0.1 }, sourceSeq: 7, tag: 'scale',
    };

    const pluck1 = shot('plucked', ev, 0);
    const pluck2 = shot('plucked', ev, 0);
    const piano1 = shot('piano', ev, 0);
    const piano2 = shot('piano', ev, 0);
    const identical = J(pluck1) === J(pluck2) && J(piano1) === J(piano2);

    // sensitivity: a different note must produce a different plan, otherwise
    // "identical" would be trivially true for a function that does nothing
    const other = shot('plucked', Object.assign({}, ev, { note: 52, freq: 164.81 }), 0);
    const sensitive = J(other) !== J(pluck1);

    // and nothing non-finite ever reaches a parameter
    const finite = [...pluck1, ...piano1].every((c) => c.args.every((a) => typeof a !== 'number' || Number.isFinite(a)));

    add(
      '19 Piano and Plucked are deterministic',
      identical && sensitive && finite && pluck1.length > 8,
      `${pluck1.length} scheduled parameter calls for Plucked and ${piano1.length} for Piano · ` +
        `rendering the same event twice produced byte-identical plans: ${identical} · ` +
        `changing the note changes the plan (sensitivity check): ${sensitive} · ` +
        `no NaN or Infinity reached any AudioParam: ${finite}`
    );
  } catch (e) {
    add('19 Piano and Plucked are deterministic', false, String(e));
  }

  // =========================================================================
  // 20. one-shots never wait for a key to come up
  // =========================================================================
  // Drums, FX and bells finish on their own schedule in EVERY sound world. If
  // one of them ever registered as a gated voice, holding that key would leave
  // it ringing until the 4.2 s safety timer -- and on a drum that is not a
  // sustain, it is a fault.
  try {
    const worlds = Object.keys(SOUND_SETS);
    const rows = [];
    for (const world of worlds) {
      for (const kind of ['drum', 'lowfx', 'fx', 'bell']) {
        const rec = new RecordingContext();
        const eng = new SoundEngine();
        eng.ctx = rec;
        eng.setName = world;
        eng.noiseBuf = { length: 1 };
        const h = eng._voice(
          { instrument: kind, part: kind === 'drum' ? 'kick' : null, note: 60, freq: 261.6, duration: 0.3, gated: true, velocity: 90, fx: {} },
          0,
          rec.createGain()
        );
        rows.push({ world, kind, gated: !!(h && h.release) });
      }
    }
    const noneGated = rows.every((r) => !r.gated);

    // positive control: a sustaining role in the same world DOES gate
    const ctrl = [];
    for (const world of worlds) {
      const rec = new RecordingContext();
      const eng = new SoundEngine();
      eng.ctx = rec;
      eng.setName = world;
      eng.noiseBuf = { length: 1 };
      const h = eng._voice(
        { instrument: 'melody', note: 60, freq: 261.6, duration: 0.3, gated: true, velocity: 90, fx: {} },
        0,
        rec.createGain()
      );
      ctrl.push({ world, gated: !!(h && h.release) });
    }
    const allSustain = ctrl.every((c) => c.gated);

    add(
      '20 drums, FX and bells are one-shots in every sound world',
      noneGated && allSustain,
      `${rows.length} one-shot voices across ${worlds.length} worlds, none of them waits for a key-up: ${noneGated} · ` +
        `positive control — melody still sustains in all ${ctrl.length} worlds: ${allSustain}` +
        (noneGated ? '' : ' · offenders: ' + rows.filter((r) => r.gated).map((r) => r.world + '/' + r.kind).join(', '))
    );
  } catch (e) {
    add('20 drums, FX and bells are one-shots in every sound world', false, String(e));
  }

  // =========================================================================
  // 21. nothing is left ringing
  // =========================================================================
  // The one failure a musical tool is not allowed to have. Every way of walking
  // away from a sounding note -- the window losing focus, the tab going away,
  // Stop, opening another piece -- has to end in silence.
  try {
    const eng = new SoundEngine();
    const rec = new RecordingContext();
    eng.ctx = rec;
    eng.noiseBuf = { length: 1 };
    let released = 0;
    const hold = (n) => {
      const h = { minEnd: 0, release: () => released++, slot: null };
      eng._registerGated('live:' + n, h);
      eng.voices.push({ n, endsAt: 1e9, amp: rec.createGain(), handle: h, key: 'live:' + n });
      return h;
    };
    for (let i = 0; i < 6; i++) hold(i);
    const before = eng.voiceStats();
    const stopped = eng.allNotesOff();
    const after = eng.voiceStats();
    const silent = after.live === 0 && after.gated === 0 && released === 6;

    // and doing it again on an already-silent engine must be harmless
    const twice = eng.allNotesOff();

    // held keys are released through the ORDINARY path, so the log stays honest
    const fx = createFixture({ mapping });
    fx.at(1.0);
    fx.keyDown({ code: 'KeyJ', key: 'j', isComposing: false, shiftKey: false });
    const heldNow = fx.input.hasHeldKeys;
    const logBefore = fx.session.events.length;
    fx.advance(0.4);
    for (const code of [...fx.input.held.keys()]) fx.keyUp({ code, key: code });
    const heldAfter = fx.input.hasHeldKeys;
    const wroteKeyUp = fx.session.events.length === logBefore + 1 &&
      fx.session.events[fx.session.events.length - 1].type === EV.KEY_UP;
    const holdRecorded = fx.session.events[fx.session.events.length - 1].data.holdMs >= 390;

    add(
      '21 no stuck notes after blur, hide, Stop or a project switch',
      silent && twice === 0 && heldNow && !heldAfter && wroteKeyUp && holdRecorded,
      `6 sustaining voices, ${before.gated} registered · allNotesOff stopped ${stopped} and released all 6: ${silent} · ` +
        `calling it again on a silent engine stopped ${twice} (must be 0) · ` +
        `a key held when focus is lost is released through the ordinary path: held ${heldNow} → ${heldAfter}, ` +
        `and the session recorded a real key_up with holdMs ${fx.session.events[fx.session.events.length - 1].data.holdMs}: ${wroteKeyUp && holdRecorded}`
    );
    fx.dispose();
  } catch (e) {
    add('21 no stuck notes after blur, hide, Stop or a project switch', false, String(e));
  }

  // =========================================================================
  // 22. polyphony has a ceiling, and it is reached deterministically
  // =========================================================================
  try {
    const rec = new RecordingContext();
    const eng = new SoundEngine({ maxPolyphony: 8 });
    eng.ctx = rec;
    eng.noiseBuf = { length: 1 };
    eng.liveBus = rec.createGain();
    eng.delayIn = rec.createGain();
    eng.reverbIn = rec.createGain();
    eng.delayFb = rec.createGain();
    eng.master = rec.createGain();

    const play = (i) =>
      eng.play(
        { instrument: 'melody', note: 60 + (i % 12), freq: 261 + i, duration: 0.5, gated: true,
          velocity: 90, pan: 0, fx: { delay: 0.05, reverb: 0.1, feedback: 0.2 }, sourceSeq: i, tag: 'scale' },
        0,
        null,
        'live'
      );

    for (let i = 0; i < 40; i++) play(i);
    const stats = eng.voiceStats();
    const capped = stats.live <= 8;
    const stole = eng.stolen === 32;
    // Deterministic: the survivors are always the newest 8, never an arbitrary
    // subset -- so the same performance always keeps the same notes.
    const survivors = eng.voices.map((v) => v.n);
    const newestKept = J(survivors) === J([32, 33, 34, 35, 36, 37, 38, 39]);

    // running it again from scratch must steal exactly the same voices
    const rec2 = new RecordingContext();
    const eng2 = new SoundEngine({ maxPolyphony: 8 });
    Object.assign(eng2, { ctx: rec2, noiseBuf: { length: 1 }, liveBus: rec2.createGain(), delayIn: rec2.createGain(), reverbIn: rec2.createGain(), delayFb: rec2.createGain(), master: rec2.createGain() });
    for (let i = 0; i < 40; i++) {
      eng2.play({ instrument: 'melody', note: 60 + (i % 12), freq: 261 + i, duration: 0.5, gated: true, velocity: 90, pan: 0, fx: { delay: 0.05, reverb: 0.1, feedback: 0.2 }, sourceSeq: i, tag: 'scale' }, 0, null, 'live');
    }
    const repeatable = J(eng2.voices.map((v) => v.n)) === J(survivors) && eng2.stolen === eng.stolen;

    // Low piano one-shots ring far beyond the old generic duration+2s slot.
    // At t=3 their nodes are still alive, so the ninth note must steal one.
    const rec3 = new RecordingContext();
    const eng3 = new SoundEngine({ maxPolyphony: 8 });
    Object.assign(eng3, { ctx: rec3, setName: 'piano', noiseBuf: { length: 1 }, liveBus: rec3.createGain(), delayIn: rec3.createGain(), reverbIn: rec3.createGain(), delayFb: rec3.createGain(), master: rec3.createGain() });
    const pianoShot = (i) => eng3.play(
      { instrument: 'melody', note: 36, freq: 65.41, duration: 0.08, gated: false,
        velocity: 90, pan: 0, fx: { delay: 0, reverb: 0 }, sourceSeq: i, tag: 'scale' },
      rec3.currentTime,
      null,
      'live'
    );
    for (let i = 0; i < 8; i++) pianoShot(i);
    rec3.currentTime = 3;
    pianoShot(8);
    const oneShotTailTracked = eng3.stolen === 1 && eng3.voices.length === 8 &&
      eng3.voices.every((v) => v.endsAt > rec3.currentTime);

    add(
      '22 polyphony is capped, and stealing is deterministic',
      capped && stole && newestKept && repeatable && oneShotTailTracked,
      `40 sustaining notes into a budget of 8 · live voices ${stats.live} (capped: ${capped}) · ` +
        `${eng.stolen} stolen (expected 32: ${stole}) · the oldest went first, so the survivors are [${survivors.join(', ')}]: ${newestKept} · ` +
        `a second identical burst stole exactly the same voices: ${repeatable} · ` +
        `8 low Piano one-shots were still budgeted at t=3s and the ninth stole one: ${oneShotTailTracked}`
    );
  } catch (e) {
    add('22 polyphony is capped, and stealing is deterministic', false, String(e));
  }

  // =========================================================================
  // 23. a Starter Kit writes the same events every time
  // =========================================================================
  // Applying a kit is a real performance action and goes in the log. The order
  // matters for one non-obvious reason: SET_SOUND also chooses the pitch
  // material, and ADD_BUILTIN_LOOP builds its notes from whatever material is
  // current -- so a foundation added before the sound world was set would be
  // built from the previous world's scale.
  try {
    const rows = STARTER_KITS.map((k) => ({
      id: k.id,
      a: planKitEvents(k, { hasFreeTrack: true }),
      b: planKitEvents(k, { hasFreeTrack: true }),
      full: planKitEvents(k, { hasFreeTrack: false }),
    }));
    const stable = rows.every((r) => J(r.a) === J(r.b));
    const soundFirst = rows.every((r) => r.a[0].type === EV.SET_SOUND);
    const foundationLast = rows.every((r) => {
      const i = r.a.findIndex((e) => e.type === EV.ADD_BUILTIN_LOOP);
      return i === -1 || i === r.a.length - 1;
    });
    const fullBoardSkips = rows.every((r) => !r.full.some((e) => e.type === EV.ADD_BUILTIN_LOOP));
    const fourKits = STARTER_KITS.length >= 4;
    const worldsExist = STARTER_KITS.every((k) => !!SOUND_SETS[k.settings.soundSet] && !!SCALES[k.settings.soundSet]);

    // and applying one really does what it says, on a fixture
    const fx = createFixture({ mapping });
    fx.at(1.0);
    const warm = STARTER_KITS.find((k) => k.settings.soundSet === 'piano');
    for (const ev of planKitEvents(warm, { hasFreeTrack: true })) fx.session.dispatch(ev.type, ev.data);
    const applied =
      fx.settings.soundSet === 'piano' &&
      fx.settings.bpm === warm.settings.bpm &&
      fx.view().totals.filled === 1;

    add(
      '23 Starter Kits are stable and set up a room, not a song',
      stable && soundFirst && foundationLast && fullBoardSkips && fourKits && worldsExist && applied,
      `${STARTER_KITS.length} kits · same events on every call: ${stable} · sound world first (it also picks the notes): ${soundFirst} · ` +
        `foundation last: ${foundationLast} · a full board quietly skips the foundation: ${fullBoardSkips} · ` +
        `every kit names a real sound world and scale: ${worldsExist} · ` +
        `applying WARM KEYS gave piano at ${fx.settings.bpm}bpm with 1 track: ${applied} · ` +
        `no kit writes a melody — the tracks it fills are foundations only`
    );
    fx.dispose();
  } catch (e) {
    add('23 Starter Kits are stable and set up a room, not a song', false, String(e));
  }

  // =========================================================================
  // 24. a Story section is a performance, and it replays as one
  // =========================================================================
  // Pressing a section must write the SAME events regardless of what the mix
  // happened to be, otherwise the same section pressed twice in a set would put
  // different things in the log and a replay would drift from there on.
  try {
    const fx = createFixture({ mapping });
    fx.at(1.0);
    fx.session.dispatch(EV.ADD_BUILTIN_LOOP, { loop: 'beat' });
    fx.advance(0.5);
    fx.session.dispatch(EV.ADD_BUILTIN_LOOP, { loop: 'bass' });
    const view = fx.view();

    const proposed = proposeSections(view);
    const named = J(proposed.map((s) => s.name)) === J(['INTRO', 'BUILD', 'FULL', 'SPACE', 'END']);

    const full = proposed.find((s) => s.name === 'FULL');
    const intro = proposed.find((s) => s.name === 'INTRO');

    // the same section from two DIFFERENT states produces the same events
    const p1 = planSectionEvents(full, view.layerCount);
    fx.session.dispatch(EV.LAYER_MUTE, { layer: 0, value: true });
    fx.session.dispatch(EV.LAYER_VOLUME, { layer: 1, value: 0.2 });
    const p2 = planSectionEvents(full, fx.view().layerCount);
    const stateIndependent = J(p1) === J(p2);

    // order within a track: ON, then MUTE, then VOLUME. LAYER_ON clears `muted`,
    // so any other order silently undoes part of the mix.
    const perTrack = p1.filter((e) => e.data.layer === 0).map((e) => e.type);
    const orderOk = J(perTrack) === J([EV.LAYER_ON, EV.LAYER_MUTE, EV.LAYER_VOLUME]);
    const ascending = p1.map((e) => e.data.layer).every((v, i, a) => i === 0 || v >= a[i - 1]);
    const complete = p1.length === view.layerCount * 3;

    // applying it really lands the mix, and it is idempotent
    for (const ev of p1) fx.session.dispatch(ev.type, ev.data);
    const afterOnce = J(fx.view().layers.map((l) => [l.on, l.muted, l.volume]));
    for (const ev of p1) fx.session.dispatch(ev.type, ev.data);
    const afterTwice = J(fx.view().layers.map((l) => [l.on, l.muted, l.volume]));
    const idempotent = afterOnce === afterTwice;

    // INTRO leaves fewer tracks audible than FULL -- a shape, not five copies
    const introQuieter =
      intro.mix.filter((m) => m.on).length < full.mix.filter((m) => m.on).length;

    // --- and it replays ----------------------------------------------------
    // The events are ordinary session events, so a re-simulation of the log
    // reproduces the arrangement exactly.
    const logged = fx.session.events.map((e) => ({ time: e.time, type: e.type, data: e.data }));
    const sim = simulateSession(logged, mapping, BASE);
    const replayMix = J(sim.layers.map((l) => [l.on, l.muted, l.volume]));
    const liveMix = J(fx.loop.snapshot().map((l) => [l.on, l.muted, l.volume]));
    const replayed = replayMix === liveMix;

    add(
      '24 Story sections are performance events, and replay reproduces them',
      named && stateIndependent && orderOk && ascending && complete && idempotent && introQuieter && replayed,
      `suggested ${proposed.length} sections named ${proposed.map((s) => s.name).join('/')}: ${named} · ` +
        `the same section planned from two different mixes gives the same ${p1.length} events: ${stateIndependent} · ` +
        `per track it is ON → MUTE → VOLUME (ON resets muted): ${orderOk}, tracks ascending: ${ascending}, ` +
        `every track covered: ${complete} · applying it twice changes nothing the second time: ${idempotent} · ` +
        `INTRO is quieter than FULL: ${introQuieter} · re-simulating the log rebuilt the same mix: ${replayed}`
    );
    fx.dispose();
  } catch (e) {
    add('24 Story sections are performance events, and replay reproduces them', false, String(e));
  }

  // =========================================================================
  // 25. the guide and the suggestion are pure functions of the state
  // =========================================================================
  // Neither may change anything, and neither may say something different the
  // second time it is asked. A hint you cannot predict is a hint you cannot
  // learn from.
  try {
    const states = [
      { tracks: 0, pending: 0, sections: 0, captured: false, kitChosen: false, typedTracks: 0 },
      { tracks: 1, pending: 0, sections: 0, captured: false, kitChosen: true, typedTracks: 1 },
      { tracks: 2, pending: 0, sections: 2, captured: false, kitChosen: true, typedTracks: 1 },
      { tracks: 4, pending: 0, sections: 3, captured: true, kitChosen: true, typedTracks: 3 },
    ];
    const frozen = states.map((s) => J(s));
    const guideA = states.map((s) => stepFor(s).index);
    const guideB = states.map((s) => stepFor(s).index);
    const moveA = states.map((s) => (nextMove(s) || {}).id);
    const moveB = states.map((s) => (nextMove(s) || {}).id);
    const unchanged = states.every((s, i) => J(s) === frozen[i]);
    const pure = J(guideA) === J(guideB) && J(moveA) === J(moveB);
    // it advances as the state advances, rather than parroting one answer
    const advances = guideA[0] < guideA[1] && guideA[1] < guideA[2] && guideA[2] < guideA[3];
    const varies = new Set(moveA).size > 1;
    // a step is never completed by asking; only real state completes it
    const cannotSkip = stepFor({ tracks: 0, pending: 0, sections: 0, captured: false, kitChosen: false }).index === 0;
    // and suppressing a suggestion offers the next one, not nothing
    const suppressed = nextMove(states[0], [moveA[0]]);
    const fallsThrough = !suppressed || suppressed.id !== moveA[0];

    add(
      '25 the guide and Next Move are pure and deterministic',
      pure && unchanged && advances && varies && cannotSkip && fallsThrough,
      `asked twice for 4 states: identical answers: ${pure} · the state objects were not modified: ${unchanged} · ` +
        `the guide advances with real progress (steps ${guideA.join(' → ')}): ${advances} · ` +
        `suggestions differ by state (${moveA.join(', ')}): ${varies} · ` +
        `a step cannot be skipped by asking: ${cannotSkip} · suppressing one offers another: ${fallsThrough}`
    );
  } catch (e) {
    add('25 the guide and Next Move are pure and deterministic', false, String(e));
  }

  // =========================================================================
  // 26. a project survives the round trip, and a copy is a real copy
  // =========================================================================
  try {
    const fx = createFixture({ mapping });
    fx.at(1.0);
    fx.session.dispatch(EV.SESSION_START, { settings: BASE, beatAtStart: 0 });
    fx.typeWord('hjkl');
    fx.commitViaKeyboard();
    fx.session.dispatch(EV.ADD_BUILTIN_LOOP, { loop: 'beat' });

    const events = fx.session.events.map((e) => ({ i: e.i, time: e.time, type: e.type, data: e.data }));
    const original = makeProject({
      title: 'Round trip',
      settings: BASE,
      initialSettings: BASE,
      text: fx.textEl.value,
      sessionEvents: events,
      state: { performanceState: fx.perf.exportState(), loopState: fx.loop.exportState() },
      story: { sections: [makeSection('FULL', [{ layer: 0, on: true, muted: false, volume: 1 }])], currentId: null },
    });

    // through the export file and back
    const file = JSON.stringify(toExportFile(original));
    const back = fromExportFile(JSON.parse(file));
    const roundTripped = back.ok && back.project.hash === original.hash;

    // the performance is what the hash covers, so re-simulating both logs must
    // give the same notes -- the real test of "nothing was lost"
    const simA = simulateSession(original.sessionEvents.map((e) => ({ time: e.time, type: e.type, data: e.data })), mapping, BASE);
    const simB = simulateSession(back.project.sessionEvents.map((e) => ({ time: e.time, type: e.type, data: e.data })), mapping, BASE);
    const samePerf = J(simA.perf.map(fullShape)) === J(simB.perf.map(fullShape));
    const sameLayers = J(layerShape(simA)) === J(layerShape(simB));

    // a duplicate starts life identical and then goes its own way
    const copy = deepClone(original);
    copy.projectId = original.projectId + '-copy';
    copy.title = original.title + ' — Variation 2';
    copy.hash = projectHash(copy);
    const copyMatches = copy.hash === original.hash; // the title is NOT hashed
    copy.sessionEvents.push({ i: 9999, time: 99, type: EV.LAYER_MUTE, data: { layer: 0, value: true } });
    copy.hash = projectHash(copy);
    const independent =
      copy.hash !== original.hash &&
      original.sessionEvents.length !== copy.sessionEvents.length &&
      original.projectId !== copy.projectId;

    // renaming must not change the performance hash, or every rename would look
    // like an edit to the music
    const renamed = deepClone(original);
    renamed.title = 'Something else entirely';
    const renameIsNotAnEdit = projectHash(renamed) === original.hash;
    const renameIsDocumentEdit = documentHash(renamed) !== original.documentHash;

    // The document hash protects metadata and cached workspace state too. Keep
    // the old hash to reproduce an interrupted/corrupt save: validation must
    // reject it rather than normalise it into a healthy-looking project.
    const corrupted = deepClone(original);
    corrupted.story.sections = [];
    const catchesStoryLoss = !validateProject(corrupted).ok;

    const storable = isStorable(original);

    add(
      '26 project round trip keeps the performance; a copy is independent',
      roundTripped && samePerf && sameLayers && copyMatches && independent && renameIsNotAnEdit &&
        renameIsDocumentEdit && catchesStoryLoss && storable,
      `${events.length} events through export → import: hash ${original.hash} preserved: ${roundTripped} · ` +
        `re-simulating both logs gave identical notes: ${samePerf} and identical layers: ${sameLayers} · ` +
        `a fresh duplicate hashes the same: ${copyMatches}, and diverges the moment it is edited: ${independent} · ` +
        `renaming does not change the performance hash: ${renameIsNotAnEdit}, but does change the document hash: ${renameIsDocumentEdit} · ` +
        `a missing Story section with stale integrity data is rejected: ${catchesStoryLoss} · ` +
        `the whole document is structured-cloneable: ${storable}`
    );
    fx.dispose();
  } catch (e) {
    add('26 project round trip keeps the performance; a copy is independent', false, String(e));
  }

  // =========================================================================
  // 27. a bad project file changes nothing
  // =========================================================================
  // The contract: validate FIRST, apply second. A rejected file must cost the
  // user exactly nothing -- no half-applied settings, no cleared tracks.
  try {
    const before = liveStateSnapshot({ session, recorder, loop, perf, getInput, settings });
    const cases = [
      ['not an object', '"hello"'],
      ['no project version', '{"sessionEvents":[]}'],
      ['from a newer build', JSON.stringify({ projectFormatVersion: PROJECT_FORMAT_VERSION + 1, sessionEvents: [] })],
      ['session format from the future', JSON.stringify({ projectFormatVersion: 1, sessionFormatVersion: FORMAT_VERSION + 1, sessionEvents: [] })],
      ['session format too old', JSON.stringify({ projectFormatVersion: 1, sessionFormatVersion: 1, sessionEvents: [] })],
      ['no performance in it', JSON.stringify({ projectFormatVersion: 1, title: 'x' })],
      ['a malformed event', JSON.stringify({ projectFormatVersion: 1, sessionEvents: [{ type: 'key_down' }] })],
      ['an event with a NaN time', JSON.stringify({ projectFormatVersion: 1, sessionEvents: [{ type: 'key_down', time: null }] })],
      ['absurdly large', JSON.stringify({ projectFormatVersion: 1, sessionEvents: new Array(200001).fill({ type: 'x', time: 0 }) })],
    ];
    const outcomes = cases.map(([name, text]) => {
      let res;
      try {
        res = validateProject(JSON.parse(text));
      } catch (err) {
        res = { ok: false, error: String(err) };
      }
      return { name, rejected: !res.ok, why: res.error || '' };
    });
    const allRejected = outcomes.every((o) => o.rejected);
    const explained = outcomes.every((o) => o.why && o.why.length > 12);

    // positive control: a GOOD file is accepted, so "reject everything" cannot pass
    const good = validateProject(makeProject({ title: 'ok', sessionEvents: [{ i: 0, time: 0, type: EV.SESSION_START, data: null }] }));
    const acceptsGood = good.ok;

    const after = liveStateSnapshot({ session, recorder, loop, perf, getInput, settings });
    const untouched = J(before) === J(after);

    add(
      '27 a bad project file is refused and changes nothing',
      allRejected && explained && acceptsGood && untouched,
      `${outcomes.length} malformed documents, all refused: ${allRejected} ` +
        `(${outcomes.map((o) => o.name).join('; ')}) · each refusal explains itself: ${explained} · ` +
        `positive control — a valid project is accepted: ${acceptsGood} · ` +
        `the live piece is byte-identical afterwards: ${untouched}`
    );
  } catch (e) {
    add('27 a bad project file is refused and changes nothing', false, String(e));
  }

  // =========================================================================
  // 28. user text is text, never markup
  // =========================================================================
  // Titles, section names and loop names are all arbitrary strings a person
  // typed. One of them containing a script tag has to be characters on screen.
  try {
    const nasty = '<img src=x onerror="window.__pwned=1">';
    const probe = document.createElement('div');
    // the two production paths that render user text
    probe.appendChild(el('span', { text: nasty }));
    const asText = probe.textContent === nasty && probe.querySelector('img') === null;

    // the track renderer, on a detached host
    const fx = createFixture({ mapping });
    fx.at(1.0).typeWord('hj');
    fx.commitViaKeyboard();
    fx.loop.layers[0].name = nasty;
    const host = document.createElement('div');
    renderTracks(host, fx.loop.composerSnapshot(), noopHandlers, { presets: [] });
    const nameCell = host.querySelector('.track-name');
    const trackSafe = !!nameCell && nameCell.textContent === nasty && host.querySelector('img') === null;

    // titles and section names are scrubbed of control characters and capped,
    // but their visible characters survive intact
    const cleaned = cleanTitle(nasty);
    const titleKeepsText = cleaned === nasty;
    const capped = cleanTitle('x'.repeat(500)).length <= 120;
    const neverEmpty = cleanTitle('   ').length > 0;
    const controlStripped = cleanTitle('a' + String.fromCharCode(1) + 'b') === 'a b';

    const notPwned = window.__pwned === undefined;

    add(
      '28 user text is rendered as text, never as markup',
      asText && trackSafe && titleKeepsText && capped && neverEmpty && controlStripped && notPwned,
      `a track named with an onerror payload renders as ${nameCell ? nameCell.textContent.length : 0} characters of text ` +
        `and creates no element: ${trackSafe} · the same through el(): ${asText} · ` +
        `titles keep their visible characters: ${titleKeepsText}, are capped at 120: ${capped}, ` +
        `are never empty: ${neverEmpty}, and lose control characters: ${controlStripped} · ` +
        `nothing executed: ${notPwned}`
    );
    fx.dispose();
  } catch (e) {
    add('28 user text is rendered as text, never as markup', false, String(e));
  }

  // =========================================================================
  // 29. the shipped code, as the browser actually loaded it
  // =========================================================================
  // Two claims checked against the real module graph rather than against a
  // list somebody maintained by hand: nothing is random, and nothing reaches
  // outside this origin. Asynchronous, so it fills its row in a moment.
  {
    const row = { name: '29 no Math.random, no network, in the shipped graph', pass: null, detail: 'checking…' };
    results.push(row);
    asyncTests.push(
      (async () => {
        try {
          const mods = performance
            .getEntriesByType('resource')
            .filter((r) => r.name.endsWith('.js'))
            .map((r) => r.name);
          const unique = [...new Set(mods)];
          const offenders = [];
          const external = unique.filter((u) => new URL(u).origin !== location.origin);
          let scanned = 0;
          let bytes = 0;
          // Built at runtime so that THIS FILE does not contain the literal it
          // is hunting for. The first version of this test failed on its own
          // source code, which is funny once and then just noise.
          const needle = 'Math' + '.' + 'random(';
          for (const url of unique) {
            const text = await (await fetch(url)).text();
            scanned++;
            bytes += text.length;
            // A mention of the banned generator in this codebase is either a
            // use or a promise not to use it. Only the promise -- a comment --
            // is allowed to survive.
            text.split('\n').forEach((line, i) => {
              if (!line.includes(needle)) return;
              const isProse = /^\s*(\/\/|\*|\/\*)/.test(line);
              if (!isProse) offenders.push(url.split('/').pop() + ':' + (i + 1));
            });
          }
          row.pass = offenders.length === 0 && external.length === 0 && scanned >= 15;
          row.detail =
            `${scanned} modules, ${(bytes / 1024).toFixed(0)} KB, read back from the server exactly as the browser got them · ` +
            `calls to the banned random generator outside a comment: ${offenders.length}` +
            `${offenders.length ? ' (' + offenders.join(', ') + ')' : ''} · ` +
            `scripts loaded from another origin: ${external.length} · ` +
            `every module path is same-origin and under /src`;
        } catch (err) {
          row.pass = false;
          row.detail = String(err);
        }
      })()
    );
  }

  // =========================================================================
  // 30. module paths are exactly the case they are on disk
  // =========================================================================
  // Windows and macOS do not care about the case of a filename. GitHub Pages
  // runs on Linux and does, so `./Core/hash.js` works on the machine it was
  // written on and 404s for everyone else. The check is against a written-down
  // list because a case-insensitive machine cannot discover its own mistake.
  try {
    const loaded = [...new Set(performance.getEntriesByType('resource').filter((r) => r.name.endsWith('.js')).map((r) => new URL(r.name).pathname))];
    const unexpected = loaded.filter((p) => !EXPECTED_MODULES.includes(p));
    const missing = EXPECTED_MODULES.filter((p) => !loaded.includes(p));
    // directories lower-case, files lowerCamelCase, nothing else
    const shape = loaded.filter((p) => !/^\/src\/([a-z]+\/)?[a-z][A-Za-z0-9]*\.js$/.test(p));
    const dupes = loaded.filter((p, i) => loaded.findIndex((q) => q.toLowerCase() === p.toLowerCase()) !== i);

    add(
      '30 module paths match their real case',
      unexpected.length === 0 && shape.length === 0 && dupes.length === 0,
      `${loaded.length} modules loaded · not in the expected list: ${unexpected.length}${unexpected.length ? ' (' + unexpected.join(', ') + ')' : ''} · ` +
        `expected but never loaded: ${missing.length}${missing.length ? ' (' + missing.join(', ') + ')' : ''} — not a failure, some are lazy · ` +
        `paths that break the lower-case-directory convention: ${shape.length} · ` +
        `two paths differing only by case: ${dupes.length}`
    );
  } catch (e) {
    add('30 module paths match their real case', false, String(e));
  }

  // =========================================================================
  // 31. logs from older builds still open and still replay
  // =========================================================================
  // v0.3 added RESTORE_LAYER, which made the session format v4. Every reader
  // skips types it does not know, so a v2 or v3 log is simply a log without
  // that event in it -- but "should work" is not "does work".
  try {
    const v2 = log([
      // v2: the opening checkpoint carries settings only, no engine state
      [0.0, EV.SESSION_START, { settings: BASE, beatAtStart: 0 }],
      [0.4, EV.KEY_DOWN, key(0, 0.4, 'KeyJ', 'j')],
      [0.46, EV.KEY_UP, { seq: 0, holdMs: 60 }],
      [0.7, EV.KEY_DOWN, key(1, 0.7, 'KeyK', 'k')],
      [0.76, EV.KEY_UP, { seq: 1, holdMs: 60 }],
      [1.2, EV.KEY_DOWN, key(2, 1.2, 'Enter', '\n')],
    ]);
    const r2a = simulateSession(v2, mapping, BASE);
    const r2b = simulateSession(v2, mapping, BASE);
    const v2Works = r2a.perf.length > 0 && J(r2a.perf.map(fullShape)) === J(r2b.perf.map(fullShape));

    // v3: the same plus engine state on the checkpoint
    const v3 = log([
      [0.0, EV.SESSION_START, { settings: BASE, beatAtStart: 0, performanceState: null, loopState: null }],
      ...v2.slice(1).map((e) => [e.time, e.type, e.data]),
    ]);
    const r3 = simulateSession(v3, mapping, BASE);
    const v3Works = J(r3.perf.map(fullShape)) === J(r2a.perf.map(fullShape));

    // an unknown event type from some future build must be skipped, not fatal
    const future = log([...v2.map((e) => [e.time, e.type, e.data]), [1.5, 'some_future_event', { x: 1 }]]);
    const rFuture = simulateSession(future, mapping, BASE);
    const skipsUnknown = J(rFuture.perf.map(fullShape)) === J(r2a.perf.map(fullShape));

    // and the NEW event really does something, so v4 is not a version bump for
    // nothing
    const withRestore = log([
      [0.0, EV.SESSION_START, { settings: BASE, beatAtStart: 0 }],
      [0.2, EV.ADD_BUILTIN_LOOP, { loop: 'beat' }],
      [0.6, EV.CLEAR_LAYER, { layer: 0 }],
    ]);
    const cleared = simulateSession(withRestore, mapping, BASE);
    const content = (() => {
      const tmp = simulateSession(log([[0.0, EV.SESSION_START, { settings: BASE, beatAtStart: 0 }], [0.2, EV.ADD_BUILTIN_LOOP, { loop: 'beat' }]]), mapping, BASE);
      return tmp.layerEvents[0].length;
    })();
    const restoredLog = log([
      [0.0, EV.SESSION_START, { settings: BASE, beatAtStart: 0 }],
      [0.2, EV.ADD_BUILTIN_LOOP, { loop: 'beat' }],
      [0.6, EV.CLEAR_LAYER, { layer: 0 }],
      [0.8, EV.RESTORE_LAYER, restoreDataFor(LoopEngine, StubSound, SCALES)],
    ]);
    const restored = simulateSession(restoredLog, mapping, BASE);
    const undoReplays = cleared.layerEvents[0].length === 0 && restored.layerEvents[0].length > 0;

    add(
      '31 v2 and v3 logs still open; unknown events are skipped',
      v2Works && v3Works && skipsUnknown && undoReplays && content > 0,
      `a v2 log (settings-only checkpoint) replays and is deterministic: ${v2Works} · ` +
        `a v3 log gives the same result: ${v3Works} · ` +
        `an event type from a future build is skipped rather than fatal: ${skipsUnknown} · ` +
        `and the new v4 restore_layer really restores content on replay ` +
        `(${cleared.layerEvents[0].length} events after delete → ${restored.layerEvents[0].length} after undo): ${undoReplays}`
    );
  } catch (e) {
    add('31 v2 and v3 logs still open; unknown events are skipped', false, String(e));
  }

  // =========================================================================
  // 32. IndexedDB: saved, read back, verified -- and a failure says so
  // =========================================================================
  {
    const row = { name: '32 pieces are saved, verified, and a failed save is reported', pass: null, detail: 'checking…' };
    results.push(row);
    asyncTests.push(
      (async () => {
        const DB = 'typing-instrument-selftest';
        let store = null;
        try {
          // A DEDICATED database. The user's library is never opened by a test.
          store = new ProjectStore({ dbName: DB });
          const p = makeProject({
            title: 'Self test piece',
            sessionEvents: [{ i: 0, time: 0, type: EV.SESSION_START, data: { settings: BASE } }],
            settings: BASE,
          });
          const res = await store.save(p);
          const back = await store.get(p.projectId);
          const roundTrip = !!back && back.hash === p.hash && back.documentHash === documentHash(back) && back.title === p.title;
          const verified = res.verified === true;

          // Create a real LKG, corrupt only the newest document metadata, and
          // prove get() refuses it instead of recomputing away the mismatch.
          const newer = deepClone(back);
          newer.title = 'Newer self test piece';
          newer.revision++;
          await store.save(newer);
          const db = await store.open();
          await new Promise((resolve, reject) => {
            const tx = db.transaction(['projects'], 'readwrite');
            const os = tx.objectStore('projects');
            const get = os.get(p.projectId);
            get.onsuccess = () => {
              const rec = get.result;
              rec.latest.story = { sections: [{ id: 'lost', name: 'CORRUPT', mix: [] }], currentId: 'lost' };
              os.put(rec); // intentionally leave documentHash stale
            };
            get.onerror = () => reject(get.error || new Error('could not corrupt test record'));
            tx.oncomplete = resolve;
            tx.onerror = tx.onabort = () => reject(tx.error || new Error('test corruption transaction failed'));
          });
          const recovered = await store.get(p.projectId);
          const usedLkg = !!recovered && recovered.title === p.title &&
            await store.recoveredFromBackup(p.projectId);

          const listed = await store.list(10);
          const inList = listed.some((s) => s.projectId === p.projectId);

          // delete, then put it straight back -- this is what UNDO does
          const rec = await store.remove(p.projectId);
          const goneAfterDelete = (await store.get(p.projectId)) === null;
          await store.restoreRecord(rec);
          const backAfterUndo = !!(await store.get(p.projectId));

          // --- a store that cannot write ------------------------------------
          // The user has to be TOLD. Silence, or an optimistic "Saved", is the
          // failure mode that costs somebody an evening.
          const broken = new ProjectStore({
            dbName: DB,
            indexedDB: { open: () => { const r = {}; setTimeout(() => r.onerror && r.onerror(), 0); return r; } },
          });
          let reported = null;
          const { ProjectController: PC } = await import('../project/projectController.js');
          const ctl = new PC({
            capture: () => ({ settings: BASE, text: '', sessionEvents: [], state: null, story: null, ui: {}, stats: {} }),
            onStatus: (s, info) => { reported = { s, info }; },
            store: broken,
          });
          ctl.newProject({ title: 'doomed', settings: BASE });
          await ctl.saveNow('test');
          const failedLoudly = reported && (reported.s === 'failed' || reported.s === 'unavailable');
          const neverClaimedSaved = reported && reported.s !== 'saved';

          // A switch/leave flush requested during an in-flight save must wait
          // for the coalesced pass that contains the latest edit.
          let liveText = 'first';
          let releaseFirst;
          const gate = new Promise((resolve) => { releaseFirst = resolve; });
          const writes = [];
          const delayedStore = {
            save: async (doc) => {
              writes.push(deepClone(doc));
              if (writes.length === 1) await gate;
              return { verified: true, revision: doc.revision, updatedAt: doc.updatedAt };
            },
          };
          const racing = new PC({
            capture: () => ({ settings: BASE, initialSettings: BASE, text: liveText, sessionEvents: [], state: null, story: null, ui: {}, stats: {} }),
            onStatus: () => {},
            store: delayedStore,
          });
          racing.newProject({ title: 'race', settings: BASE });
          const firstSave = racing.saveNow('first');
          liveText = 'latest';
          racing.markDirty('typing');
          const flushed = racing.flush('leaving');
          releaseFirst();
          await Promise.all([firstSave, flushed]);
          const flushWaitedForLatest = writes.length === 2 && writes[0].text === 'first' && writes[1].text === 'latest';

          store.close();
          await new Promise((resolve) => {
            const del = indexedDB.deleteDatabase(DB);
            del.onsuccess = del.onerror = del.onblocked = () => resolve();
          });

          row.pass = roundTrip && verified && usedLkg && inList && goneAfterDelete && backAfterUndo &&
            failedLoudly && neverClaimedSaved && flushWaitedForLatest;
          row.detail =
            `saved into a dedicated test database, read back with a matching hash: ${roundTrip} · ` +
            `only reported as saved after that read-back verified: ${verified} · listed in the library: ${inList} · ` +
            `a corrupt newest document fell back to its verified LKG: ${usedLkg} · ` +
            `delete removes it (${goneAfterDelete}) and UNDO puts it back (${backAfterUndo}) · ` +
            `a store that cannot write reports "${reported ? reported.s : 'nothing'}" and never says Saved: ${failedLoudly && neverClaimedSaved} · ` +
            `an in-flight save plus leave/flush wrote the latest edit in a second pass: ${flushWaitedForLatest}`;
        } catch (err) {
          row.pass = false;
          row.detail = String(err);
          if (store) try { store.close(); } catch (e2) { /* nothing to do */ }
        }
      })()
    );
  }

  // =========================================================================
  // 33. opening a piece is silent, and the canonical log beats its cache
  // =========================================================================
  // Reducing the log through StubSound must not play two minutes of music at
  // you. More importantly, a stale-but-well-formed cache must not win over the
  // log and split Open from Replay/Export.
  try {
    const fx = createFixture({ mapping });
    fx.at(1.0);
    fx.session.dispatch(EV.ADD_BUILTIN_LOOP, { loop: 'beat' });
    fx.typeWord('hjk');
    fx.commitViaKeyboard();
    const savedEvents = fx.session.events.map((e) => ({ i: e.i, time: e.time, type: e.type, data: e.data }));
    const expectLayers = J(fx.loop.snapshot());

    const staleCache = fx.loop.exportState();
    staleCache.layers = [];
    const cacheDisagrees = J(staleCache.layers) !== J(fx.loop.exportState().layers);

    // a fresh instrument, as if the tab had just been opened
    const fresh = createFixture({ mapping });
    fresh.at(50);
    const playedBefore = fresh.sound.played.length;
    const rebuilt = simulateSession(savedEvents, mapping, BASE);
    fresh.perf.importState(rebuilt.performanceState);
    fresh.loop.importState(rebuilt.loopState, fresh.sound.now());
    fresh.session.events = deepClone(savedEvents);
    fresh.session.nextId = savedEvents.reduce((m, e) => Math.max(m, (e.i || 0) + 1), 0);
    const playedAfter = fresh.sound.played.length;

    const silent = playedAfter === playedBefore;
    const stateRestored = J(fresh.loop.snapshot()) === expectLayers;
    const logKept = fresh.session.events.length === savedEvents.length;
    const idsSafe = fresh.session.nextId > Math.max(...savedEvents.map((e) => e.i));

    // and the scheduler starts from NOW, not from the beat the piece was saved
    // at -- that beat belongs to an AudioContext that no longer exists
    const cursorSane = fresh.loop.scheduledUpToBeat >= fresh.loop.beatAt(fresh.sound.now()) - 1e-6;

    add(
      '33 opening a saved piece rebuilds it without playing it',
      silent && stateRestored && cacheDisagrees && logKept && idsSafe && cursorSane,
      `${savedEvents.length} events and ${JSON.parse(expectLayers).filter((l) => l.events).length} layers restored into a fresh instrument · ` +
        `notes sounded during the restore: ${playedAfter - playedBefore} (must be 0): ${silent} · ` +
        `layers identical: ${stateRestored} · a deliberately stale cache disagreed and was ignored: ${cacheDisagrees} · ` +
        `the canonical log was kept: ${logKept} · ` +
        `new events cannot collide with old ids: ${idsSafe} · scheduler starts from now, not from the saved beat: ${cursorSane}`
    );
    fx.dispose();
    fresh.dispose();
  } catch (e) {
    add('33 opening a saved piece rebuilds it without playing it', false, String(e));
  }

  // =========================================================================
  // 34. the suite left the user's work alone
  // =========================================================================
  // The test that guards every other test. A deep comparison of the live app,
  // not a count of array lengths -- counting is exactly what let the old test
  // 15 corrupt InputEngine.word without anybody noticing for three releases.
  try {
    // Focus is restored first, and reported separately: a test that steals the
    // caret and gives it back is fine, one that steals it and does not is not.
    const focusWas = liveBefore.dom.activeElement;
    const focusNow = document.activeElement ? document.activeElement.id || document.activeElement.tagName : null;
    const focusDrifted = focusWas !== focusNow;
    if (focusDrifted && focusWas) {
      const el = document.getElementById(focusWas);
      if (el && el.focus) el.focus();
    }

    const liveAfter = liveStateSnapshot({ session, recorder, loop, perf, getInput, settings });
    const a = J(liveBefore);
    const b = J(liveAfter);
    const identical = a === b;

    let firstDiff = '';
    if (!identical) {
      for (const k of Object.keys(liveBefore)) {
        if (J(liveBefore[k]) !== J(liveAfter[k])) {
          firstDiff = k + ': ' + diffKeys(liveBefore[k], liveAfter[k]);
          break;
        }
      }
    }

    add(
      '34 the self-test left the live piece untouched',
      identical,
      `deep comparison of the session log (${liveBefore.session.events.length} events), nextId, checkpoints, ` +
        `take state, all four recorder buffers, the loop and performance engine states, ` +
        `InputEngine seq/word/recent/held, the settings and the DOM: ${identical ? 'identical' : 'DIFFERENT — ' + firstDiff} · ` +
        `focus ${focusDrifted ? 'drifted to ' + focusNow + ' and was put back on ' + focusWas : 'never moved (' + focusNow + ')'}`
    );
  } catch (e) {
    add('34 the self-test left the live piece untouched', false, String(e));
  }

  if (asyncTests.length && typeof app.onAsyncDone === 'function') {
    Promise.allSettled(asyncTests).then(() => app.onAsyncDone(results));
  }
  return results;
}

export { DEFAULT_MAPPING };
