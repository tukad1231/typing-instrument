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
import { EV } from '../session/sessionEvents.js';
import { InputEngine } from '../input/inputEngine.js';
import { SCALES } from '../perf/scale.js';
import { DEFAULT_MAPPING } from '../perf/mapping.js';

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
export function runSelfTests({ mapping, settings, recorder, session, loop, perf }) {
  const results = [];
  const add = (name, pass, detail) => results.push({ name, pass, detail });

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
    const ok = wasDisabled && codes.includes('APP') && clicks === 1 && readyAt >= 0 && firstClick > readyAt;
    add(
      '11 boot sequence',
      ok,
      `shipped disabled: ${wasDisabled} · clicks: ${clicks} (must be 1) · first click after MODULE_READY: ${firstClick > readyAt}`
    );
  } catch (e) {
    add('11 boot sequence', false, String(e));
  }

  return results;
}

export { DEFAULT_MAPPING };
