// ---------------------------------------------------------------------------
// MAIN  --  application shell: wiring, UI, replay control, export.
//
//   InputEngine  ->  PerformanceEngine  ->  SoundEngine
//                            |
//                            +-> LoopEngine (phrases / layers)
//                            +-> Recorder   (audio + export)
//
//   SessionEngine sits across all of it: every user action, typing and knobs
//   alike, is dispatched through it so that it is logged and applied by the
//   SAME handlers. Replay re-applies the log through those same handlers.
//
// Nothing here decides anything musical. It does, however, do more than pure
// wiring: layer rendering, replay control, export and the debug view live here
// too. Splitting those out is v0.3 work, not a stability release.
// ---------------------------------------------------------------------------

const mark = (c, l, s) => (window.__bootMark ? window.__bootMark(c, l, s) : null);
mark('M01', 'MODULE_START');

import { InputEngine, codeOf } from './input/inputEngine.js';
import { PerformanceEngine, DEFAULT_SETTINGS, applyHold } from './perf/performanceEngine.js';
import { DEFAULT_MAPPING, describeMapping, ZONES } from './perf/mapping.js';
import { SCALES } from './perf/scale.js';
import { SoundEngine } from './sound/soundEngine.js';
import { LoopEngine } from './loop/loopEngine.js';
import { Recorder, download } from './record/recorder.js';
import { SessionEngine } from './session/sessionEngine.js';
import { EV, FORMAT_VERSION, ENGINE_VERSION } from './session/sessionEvents.js';
import { runSelfTests } from './tests/selfTest.js';
import { clamp } from './core/hash.js';

mark('M02', 'IMPORTS_READY');

const $ = (id) => document.getElementById(id);

const settings = Object.assign({}, DEFAULT_SETTINGS);
const mapping = DEFAULT_MAPPING;

const sound = new SoundEngine();
const perf = new PerformanceEngine(mapping, settings);
const loop = new LoopEngine(sound, { bpm: settings.bpm, quantize: settings.quantize, onChange: renderLayers });
const recorder = new Recorder();
const session = new SessionEngine({
  now: () => sound.now(),
  onTakeOverflow: (info) => {
    // Nothing is dropped; the take is simply too big to keep growing.
    if (recorder.recording) {
      takeOverflowed = true;
      $('stopBtn').onclick();
    }
    status(`RECORD stopped: the take reached ${info.limit} events. Nothing was lost — export it now.`);
  },
  // Called just before the scratch ring is trimmed, so the surviving history
  // still begins with something replayable. Must not dispatch.
  onScratchCheckpoint: () => (started ? sessionCheckpoint() : null),
});

let input = null;
let started = false;
let replaying = false;
let settingsTouchedDuringTake = false;
let takeOverflowed = false;
const eventsBySeq = new Map(); // raw seq -> performance events (live sound only)

// Replay does not go through the InputEngine, so it cannot read keys/sec or
// silence from it -- doing so made the reverb and layer levels depend on
// whatever the player happened to type before pressing REPLAY. These mirror
// the InputEngine's own maths, fed from the log instead.
const replayRecent = [];
let replayLastKey = 0;

// ---------------------------------------------------------------------------
// SESSION HANDLERS -- the single code path shared by live play and replay
// ---------------------------------------------------------------------------
session
  .on(EV.KEY_DOWN, (raw, ev) => {
    const r = session.replaying ? Object.assign({}, raw, { timestamp: ev.time }) : raw;
    if (session.replaying) {
      replayRecent.push(ev.time);
      replayLastKey = ev.time;
    }
    performKey(r);
    paintCurrent(r);
  })
  .on(EV.KEY_UP, (d, ev) => {
    // The note's length is only known now. It has to reach every copy of the
    // note by sourceSeq -- the live sound, the scratch performance log, the
    // pending phrase, AND any layer that was committed while the key was still
    // held down. Relying on the original object being mutated is exactly how
    // v0.2 ended up with a 0.518 s note live and a 1.5 s note on replay.
    eventsBySeq.delete(d.seq);
    loop.applyHoldBySeq(d.seq, d.holdMs);
    if (!session.replaying) recorder.applyHoldBySeq(d.seq, d.holdMs);
    sound.release(d.seq, ev.time, 'live');
    $('cHold').textContent = d.holdMs + ' ms';
  })

  .on(EV.SET_SOUND, (d) => {
    settings.soundSet = d.value;
    perf.setSettings({ soundSet: d.value });
    sound.setSoundSet(d.value);
    $('soundSet').value = d.value;
  })
  .on(EV.SET_BPM, (d) => {
    settings.bpm = d.value;
    perf.setSettings({ bpm: d.value });
    loop.setBpm(d.value);
    sound.setBpm(d.value);
    $('bpm').value = d.value;
    $('bpmVal').textContent = d.value;
  })
  .on(EV.SET_COMPLEXITY, (d) => {
    settings.complexity = d.value;
    perf.setSettings({ complexity: d.value });
    $('complexity').value = d.value;
    $('cxVal').textContent = d.value;
  })
  .on(EV.SET_QUANTIZE, (d) => {
    settings.quantize = d.value;
    loop.setQuantize(d.value);
    $('quantize').value = d.value;
  })
  .on(EV.SET_MASTER_VOLUME, (d) => {
    settings.masterVolume = d.value;
    sound.setMasterVolume(d.value);
    $('volume').value = Math.round(d.value * 100);
  })

  .on(EV.ADD_BUILTIN_LOOP, (d) => {
    const r = loop.addBuiltin(d.loop, SCALES[settings.soundSet]);
    if (r.error) status('all 4 layers are full — clear one first');
  })
  .on(EV.CLEAR_LAYER, (d) => loop.clearLayer(d.layer))
  .on(EV.CLEAR_ALL, () => {
    // Second line of defence: clearing mid-take would leave MediaRecorder
    // running over a session whose JSON had been thrown away.
    if (!session.replaying && recorder.recording) return;
    loop.clearAll();
    sound.releaseAll();
    perf.reset();
    eventsBySeq.clear();
    if (!session.replaying) {
      if (input) input.reset();
      textEl.value = '';
      recorder.reset();
      status('cleared');
    }
  })
  .on(EV.LAYER_ON, (d) => loop.setLayer(d.layer, { on: d.value, muted: false }))
  .on(EV.LAYER_MUTE, (d) => loop.setLayer(d.layer, { muted: d.value }))
  .on(EV.LAYER_VOLUME, (d) => loop.setLayer(d.layer, { volume: d.value }));

// ---------------------------------------------------------------------------
// boot -- START is owned here and ONLY here
// ---------------------------------------------------------------------------
function tryBoot() {
  mark('C01', 'CLICK_RECEIVED');
  if (started) return;
  boot().catch((err) => {
    console.error(err);
    mark('B02', 'BOOT_FAILED', 'NG');
    window.__bootError(
      '音を出せませんでした',
      'Web Audio を開始できませんでした（' + (err && err.message ? err.message : err) + '）。' +
        ' サウンド出力先が有効か確認してください。下は起動ログです。'
    );
  });
}

$('startBtn').addEventListener('click', tryBoot);
mark('M03', 'HANDLER_ATTACHED');

function setStage(s) {
  const el = $('bootStage');
  el.textContent = s;
  el.hidden = !s;
}

async function boot() {
  if (started) return;
  mark('B01', 'BOOT_ENTER');
  setStage('オーディオを起動中…');

  await sound.start();
  mark('A01', 'AUDIO_CONTEXT_CREATED');
  mark('A02', 'AUDIO_RUNNING', sound.ctx.state === 'running' ? 'OK' : 'NG:' + sound.ctx.state);
  setStage('ミキサーを準備中…');

  sound.setSoundSet(settings.soundSet);
  sound.setBpm(settings.bpm);
  sound.setMasterVolume(settings.masterVolume);

  setStage('ループを準備中…');
  loop.init();
  mark('L01', 'LOOP_INIT');
  recorder.reset();

  input = new InputEngine({
    now: () => sound.now(),
    onDown: (ev) => {
      recorder.addRaw(ev); // the live object; it gains holdMs on keyup
      // The log gets a SNAPSHOT, taken before the key comes up, so the log is
      // honest about what was known at that instant instead of quietly
      // acquiring a holdMs later through a shared reference.
      session.dispatch(EV.KEY_DOWN, Object.assign({}, ev), ev.timestamp);
    },
    onUp: (ev) => session.dispatch(EV.KEY_UP, { seq: ev.seq, holdMs: ev.holdMs }, ev.keyupAt),
  });

  // The scratch history opens with the same checkpoint format a take uses.
  session.dispatch(EV.SESSION_START, sessionCheckpoint());

  setStage('');
  started = true;
  $('gate').hidden = true;
  $('app').hidden = false;
  textEl.focus();
  renderLayers();
  // A timer, not requestAnimationFrame: the pause macro must keep working
  // even when the window loses focus mid-set.
  setInterval(paint, 40);
  mark('APP', 'APP_READY');
}

// ---------------------------------------------------------------------------
// the one path every key takes
// ---------------------------------------------------------------------------
function performKey(raw) {
  const res = perf.processDown(raw);
  applyHold(res.events, raw.holdMs);

  for (const ev of res.events) sound.play(ev, ev.time, null, 'live');
  if (res.events.length) eventsBySeq.set(raw.seq, res.events);

  loop.collect(res.events, raw.char);
  if (!session.replaying) recorder.addPerf(res.events);

  if (res.signal === 'phrase') {
    loop.closePhrase(raw.timestamp);
  } else if (res.signal === 'layer') {
    const r = loop.commitLayer();
    if (r && r.error) status('all 4 layers are full — clear one first');
    else if (r) {
      status(`layer ${r.layer + 1} committed (${r.bars} bar${r.bars > 1 ? 's' : ''})`);
      // A derived marker, not a command: logged so the timeline reads
      // correctly, never re-applied on replay (the Enter keystroke does that).
      if (!session.replaying) {
        session.dispatch(EV.COMMIT_LAYER, { derived: true, layer: r.layer, bars: r.bars });
      }
    }
  }
  return res;
}

// ---------------------------------------------------------------------------
// keyboard
// ---------------------------------------------------------------------------
const textEl = $('text');
textEl.addEventListener('compositionstart', () => input && input.setComposing(true));
textEl.addEventListener('compositionend', () => input && input.setComposing(false));
textEl.addEventListener('keydown', (e) => {
  if (replaying) { e.preventDefault(); return; }
  if (codeOf(e) === 'Tab') e.preventDefault();
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  input && input.handleKeyDown(e);
});
textEl.addEventListener('keyup', (e) => {
  if (replaying) return;
  input && input.handleKeyUp(e);
});
textEl.addEventListener('input', () => recorder.setText(textEl.value));
document.addEventListener('mousedown', (e) => {
  if (document.body.classList.contains('perform') && e.target.tagName !== 'BUTTON') {
    setTimeout(() => textEl.focus(), 0);
  }
});

// ---------------------------------------------------------------------------
// meters
// ---------------------------------------------------------------------------
let lastBar = -1;
function paint() {
  if (!started) return;
  const t = sound.now();
  let kps;
  let silence;
  if (replaying) {
    // derived from the log being replayed, never from stale live input
    while (replayRecent.length && t - replayRecent[0] > 1) replayRecent.shift();
    kps = replayRecent.length < 2 ? 0 : (replayRecent.length - 1) / Math.max(t - replayRecent[0], 0.25);
    silence = t - replayLastKey;
  } else {
    kps = input.currentKps(t);
    silence = input.silenceFor(t);
  }
  const space = clamp((silence - 0.5) / 4.5, 0, 1);

  sound.setSpace(space);
  loop.setSpaceMacro(space);

  const inten = Math.round(clamp(kps / 9, 0, 1) * 100);
  $('mKps').textContent = kps.toFixed(1);
  $('mInt').textContent = inten;
  $('barInt').style.width = inten + '%';
  $('mGroove').textContent = perf.groove;
  $('barGroove').style.width = perf.groove + '%';
  $('mSpace').textContent = Math.round(space * 100);
  $('barSpace').style.width = space * 100 + '%';

  const phase = loop.barPhase();
  const bar = Math.floor(loop.beatAt(t) / 4);
  if (bar !== lastBar) { lastBar = bar; $('barDot').classList.add('hit'); }
  if (phase > 0.12) $('barDot').classList.remove('hit');
}

function paintCurrent(ev) {
  const m = mapping[ev.code];
  $('cKey').textContent = (ev.char || ev.code).replace(' ', 'SPACE');
  $('cHand').textContent = ev.hand;
  $('cGroup').textContent = m ? ZONES[m.zone].label + (m.part ? ' / ' + m.part : '') : '—';
  $('cPhrase').textContent = ev.word || '—';
  if (!$('debug').hidden) paintDebug();
}

// ---------------------------------------------------------------------------
// layers UI
// ---------------------------------------------------------------------------
function renderLayers() {
  const host = $('layers');
  if (!host) return;
  const snap = loop.snapshot();
  host.innerHTML = '';
  for (const l of snap) {
    const row = document.createElement('div');
    row.className = 'layer' + (l.events ? '' : ' empty');
    row.innerHTML = `
      <span class="num">L${l.id + 1}</span>
      <span class="name">${l.events ? escapeHtml(l.name) : '—'}</span>
      <span class="info">${l.events ? `${l.bars} bar · ${l.events} ev` : ''}</span>
      <input type="range" min="0" max="100" value="${Math.round(l.volume * 100)}" ${l.events ? '' : 'disabled'} />
      <span class="btns"></span>`;
    const btns = row.querySelector('.btns');
    if (l.events) {
      const on = document.createElement('button');
      on.textContent = l.on && !l.muted ? 'ON' : 'OFF';
      on.className = l.on && !l.muted ? 'on' : 'off';
      on.onclick = () => session.dispatch(EV.LAYER_ON, { layer: l.id, value: !(l.on && !l.muted) });
      const cl = document.createElement('button');
      cl.textContent = 'X';
      cl.onclick = () => session.dispatch(EV.CLEAR_LAYER, { layer: l.id });
      btns.append(on, cl);
    }
    row.querySelector('input').oninput = (e) =>
      session.dispatch(EV.LAYER_VOLUME, { layer: l.id, value: +(e.target.value / 100).toFixed(3) });
    host.appendChild(row);
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

document.querySelectorAll('button.add').forEach((b) => {
  b.onclick = () => {
    session.dispatch(EV.ADD_BUILTIN_LOOP, { loop: b.dataset.loop });
    textEl.focus();
  };
});

// ---------------------------------------------------------------------------
// settings -- every control goes through the session log
// ---------------------------------------------------------------------------
const touched = () => { settingsTouchedDuringTake = true; };

function settingsSnapshot() {
  return {
    soundSet: settings.soundSet,
    bpm: settings.bpm,
    complexity: settings.complexity,
    quantize: settings.quantize,
    masterVolume: settings.masterVolume,
  };
}

/**
 * A complete restore point. RECORD does not reset the instrument -- you can
 * start a take over loops that are already running, mid-phrase, with the
 * expression state (repeat counters, hand-alternation streak, phrase position)
 * carried over from before you pressed it. All of that has to travel with the
 * take, or the replay plays a different piece: typing J before RECORD and J
 * again as the take's first key gave note 61 live and note 60 on replay.
 */
function sessionCheckpoint() {
  return {
    formatVersion: FORMAT_VERSION,
    engineVersion: ENGINE_VERSION,
    settings: settingsSnapshot(),
    beatAtStart: +loop.beatAt(sound.now()).toFixed(6),
    performanceState: perf.exportState(),
    loopState: loop.exportState(),
  };
}

/**
 * Put the engines back to a checkpoint.
 * @param {object} data the checkpoint
 * @param {number} atTime absolute session time the checkpoint's beat lands on.
 *   Passed in rather than read from the clock here, so this and the replay
 *   scheduler agree on one instant to the sample.
 *
 * v0.2 logs carry no engine state; they restore settings only and start from a
 * default performance state, which is what they always did.
 */
function restoreCheckpoint(data, atTime) {
  if (!data) return;
  const at = atTime === undefined ? sound.now() : atTime;
  restoreSettings(data.settings);
  perf.importState(data.performanceState || null);
  if (data.loopState) {
    // importState rebases the whole tempo map (including a queued-but-not-yet-
    // effective segment) onto `at`; it must not be followed by setOrigin, which
    // would collapse the map back to a single segment.
    loop.importState(data.loopState, at);
  } else if (data.beatAtStart !== undefined) {
    loop.setOrigin(at, data.beatAtStart);
  }
  renderLayers();
}

/** put the controls back where a take started, without logging it as new input */
function restoreSettings(s) {
  if (!s) return;
  if (s.soundSet !== undefined) session.apply({ type: EV.SET_SOUND, data: { value: s.soundSet } });
  if (s.bpm !== undefined) session.apply({ type: EV.SET_BPM, data: { value: s.bpm } });
  if (s.complexity !== undefined) session.apply({ type: EV.SET_COMPLEXITY, data: { value: s.complexity } });
  if (s.quantize !== undefined) session.apply({ type: EV.SET_QUANTIZE, data: { value: s.quantize } });
  if (s.masterVolume !== undefined) session.apply({ type: EV.SET_MASTER_VOLUME, data: { value: s.masterVolume } });
}

$('soundSet').onchange = (e) => { touched(); session.dispatch(EV.SET_SOUND, { value: e.target.value }); textEl.focus(); };
$('bpm').oninput = (e) => { touched(); session.dispatch(EV.SET_BPM, { value: +e.target.value }); };
$('complexity').oninput = (e) => { touched(); session.dispatch(EV.SET_COMPLEXITY, { value: +e.target.value }); };
$('quantize').onchange = (e) => { touched(); session.dispatch(EV.SET_QUANTIZE, { value: e.target.value }); textEl.focus(); };
$('volume').oninput = (e) => session.dispatch(EV.SET_MASTER_VOLUME, { value: +(e.target.value / 100).toFixed(3) });

$('advBtn').onclick = () => {
  document.body.classList.toggle('simple');
  $('advBtn').textContent = document.body.classList.contains('simple') ? 'ADVANCED' : 'SIMPLE';
  textEl.focus();
};
$('viewBtn').onclick = () => {
  document.body.classList.toggle('perform');
  $('viewBtn').textContent = document.body.classList.contains('perform') ? 'CREATE VIEW' : 'PERFORM VIEW';
  textEl.focus();
};

// ---------------------------------------------------------------------------
// transport buttons
// ---------------------------------------------------------------------------
$('recBtn').onclick = () => {
  if (recorder.recording) return;
  // A key that is already down began its note before the take. Its keyup would
  // land inside the recording, so the take would open with a note it never
  // triggered -- and the replay would not reproduce it.
  if (input && input.hasHeldKeys) {
    status('すべてのキーを離してからRECORDしてください');
    return;
  }
  settingsTouchedDuringTake = false;
  takeOverflowed = false;
  recorder.setText(textEl.value);
  recorder.startAudio(sound.recordDest.stream, sound.now(), textEl.value);
  session.beginTake(sessionCheckpoint());
  $('recBtn').classList.add('on');
  // CLEAR ALL is locked while recording. Wiping the session out from under a
  // running MediaRecorder leaves audio and JSON describing different things.
  $('clearBtn').disabled = true;
  status('recording — typing AND every knob you touch is the take');
  textEl.focus();
};

$('stopBtn').onclick = async () => {
  if (replaying) { stopReplay(); return; }
  if (!recorder.recording) return;
  session.endTake();
  await recorder.stopAudio(sound.now(), textEl.value);
  $('recBtn').classList.remove('on');
  $('clearBtn').disabled = false;
  const { raw, perf: p } = recorder.takeSlices();
  // Do not paper over an overflow warning with a routine "take stopped".
  if (!takeOverflowed) {
    status(`take stopped — ${raw.filter((e) => e.keydown).length} keys, ${p.length} notes, ${session.takeEvents().length} session events`);
  }
  takeOverflowed = false;
};

$('exportBtn').onclick = async () => {
  if (recorder.recording) await $('stopBtn').onclick();
  recorder.setText(textEl.value);
  const tookTake = !!recorder.take;
  const { blob, name } = await recorder.exportZip({
    mapping: { name: mapping.name, keys: describeMapping(mapping, SCALES[settings.soundSet].name) },
    settings,
    layers: loop.snapshot(),
    sessionEvents: tookTake ? session.takeEvents() : session.allEvents(),
    tookTake,
  });
  download(blob, name);
  status('exported ' + name + (tookTake ? ' (RECORD take)' : ' (scratch history — press RECORD for a clean take)'));
};

$('clearBtn').onclick = () => {
  if (recorder.recording) {
    status('CLEAR ALL is locked while recording — press STOP first');
    return;
  }
  session.dispatch(EV.CLEAR_ALL, null);
};

$('debugBtn').onclick = () => {
  $('debug').hidden = !$('debug').hidden;
  paintDebug();
};
$('bootLogBtn').onclick = () => { debugView = 'boot'; paintDebug(); };
$('sessionLogBtn').onclick = () => { debugView = 'session'; paintDebug(); };

// ---------------------------------------------------------------------------
// REPLAY  --  now replays the SESSION, not just the typing
// ---------------------------------------------------------------------------
$('replayBtn').onclick = () => (replaying ? stopReplay() : startReplay());

function startReplay() {
  const usingTake = !!recorder.take;
  const log = usingTake ? session.takeEvents() : session.allEvents();
  if (log.length < 2) { status('nothing to replay yet'); return; }
  // A scratch history that was trimmed without a usable checkpoint starts
  // mid-performance. Replaying it would apply its events on top of whatever
  // state is current, which is worse than not replaying at all.
  if (!usingTake && !session.canReplayScratch()) {
    status('history was trimmed without a restore point — press RECORD, then REPLAY the take');
    return;
  }

  replaying = true;
  $('replayBtn').textContent = '■ STOP REPLAY';
  sound.releaseAll();
  eventsBySeq.clear();
  textEl.readOnly = true;
  textEl.value = '';
  // No clearAll() here: the checkpoint below decides what the world looked
  // like when the take opened, including any layers that were already running.

  // Restore the bar phase the take was played against. Where a phrase sits
  // inside the bar is part of the performance: without this, a pickup that
  // started just before the downbeat would be re-anchored onto it and the
  // rebuilt loop would sit differently against the beat.
  replayRecent.length = 0;
  replayLastKey = sound.now();

  // ONE reference instant for both the checkpoint restore and the scheduler.
  const startAt = sound.now() + 0.4;

  // Both a RECORD take and the scratch history open with the same checkpoint,
  // so one restore path serves both.
  restoreCheckpoint(log[0] && log[0].data, startAt);

  session.replay(log, {
    startAt,
    onEvent: (ev) => {
      if (ev.type === EV.KEY_DOWN) textEl.value = applyChar(textEl.value, ev.data);
    },
    onDone: () => stopReplay(true),
  });
  status(`replaying ${log.length} session events (typing + every control change)`);
}

function stopReplay(finished) {
  session.stopReplay();
  replaying = false;
  textEl.readOnly = false;
  $('replayBtn').textContent = '▶ REPLAY';
  status(finished ? 'replay finished — the whole set was rebuilt from the log' : 'replay stopped');
  textEl.focus();
}

/** rebuild the visible text from PHYSICAL keys (IME text is not reproducible) */
function applyChar(cur, ev) {
  if (!ev) return cur;
  if (ev.code === 'Backspace') return cur.slice(0, -1);
  if (ev.code === 'Enter' || ev.code === 'NumpadEnter') return cur + '\n';
  if (ev.code === 'Tab') return cur;
  return ev.char ? cur + ev.char : cur;
}

// ---------------------------------------------------------------------------
// self tests
// ---------------------------------------------------------------------------
$('testBtn').onclick = () => {
  const results = runSelfTests({ mapping, settings, recorder, session, loop, perf });
  const pass = results.filter((r) => r.pass === true).length;
  const fail = results.filter((r) => r.pass === false).length;
  const skip = results.filter((r) => r.pass === null).length;
  status(`self-test: ${pass} pass, ${fail} fail${skip ? `, ${skip} skipped` : ''} — see debug panel`);
  debugView = 'tests';
  lastTests = results;
  $('debug').hidden = false;
  paintDebug();
  console.table(results);
};

// ---------------------------------------------------------------------------
// foreground warning: the loop scheduler is a timer, and browsers throttle
// timers in background tabs. On stage that means the groove falls apart.
// ---------------------------------------------------------------------------
document.addEventListener('visibilitychange', () => {
  $('hiddenWarn').hidden = !document.hidden;
  if (document.hidden) mark('W01', 'TAB_HIDDEN', 'WARN');
});

// ---------------------------------------------------------------------------
function status(msg) {
  $('status').textContent = msg;
}

let debugView = 'events';
let lastTests = [];

function paintDebug() {
  const el = $('debugBody');
  if (!el || $('debug').hidden) return;

  if (debugView === 'boot') {
    el.textContent = 'BOOT LOG\n\n' + (window.__bootLogText ? window.__bootLogText() : '(none)');
    return;
  }
  if (debugView === 'session') {
    const log = recorder.take ? session.takeEvents() : session.allEvents();
    el.textContent =
      `SESSION LOG (${log.length} events, ${recorder.take ? 'RECORD take' : 'scratch history'})\n\n` +
      log
        .slice(-60)
        .map((e) => `${e.time.toFixed(3)}  ${e.type.padEnd(20)} ${e.data ? JSON.stringify(e.data).slice(0, 90) : ''}`)
        .join('\n');
    return;
  }
  if (debugView === 'tests') {
    el.textContent =
      'SELF TESTS\n\n' +
      lastTests
        .map((r) => `${r.pass === true ? 'PASS' : r.pass === false ? 'FAIL' : 'SKIP'}  ${r.name}\n      ${r.detail}`)
        .join('\n\n');
    return;
  }

  const last = recorder.perf.slice(-10);
  const scale = SCALES[settings.soundSet];
  el.textContent =
    `sound world ${settings.soundSet} (${scale.name}, root midi ${scale.root})  bpm ${settings.bpm}  ` +
    `beat ${loop.beatAt(sound.now()).toFixed(2)}  quantize ${settings.quantize}  complexity ${settings.complexity}\n` +
    `raw ${recorder.raw.length}  performance ${recorder.perf.length}  session ${session.events.length}\n\n` +
    last
      .map(
        (e) =>
          `${e.time.toFixed(3)}  ${String(e.sourceKey).padEnd(6)} ${String(e.instrument).padEnd(8)}` +
          ` ${String(e.part || e.note).padEnd(7)} vel ${String(e.velocity).padEnd(4)} dur ${String(e.duration).padEnd(6)}` +
          ` ${e.tag}`
      )
      .join('\n');
}
setInterval(() => { if (!$('debug').hidden && debugView === 'events') paintDebug(); }, 400);

// ---------------------------------------------------------------------------
// Everything is wired. Only now does START become clickable -- this is what
// makes it impossible to lose the first click.
// ---------------------------------------------------------------------------
window.__typing = { sound, perf, loop, recorder, session, settings, mapping };
window.__typingReady = true;

const btn = $('startBtn');
btn.disabled = false;
btn.textContent = 'START';
try { btn.focus({ preventScroll: true }); } catch (e) { btn.focus(); }
mark('M04', 'MODULE_READY');
