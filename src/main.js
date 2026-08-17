// ---------------------------------------------------------------------------
// MAIN  --  application shell.
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
//   ProjectController sits above THAT: it snapshots the session log plus the
//   things a performance has no opinion about (title, sections) and keeps them
//   in IndexedDB, so closing the tab is not the end of the piece.
//
// This file is wiring and screens. Nothing musical is decided here, and as of
// v0.3 the parts that used to be decided here anyway -- track rendering, the
// timeline, the suggestion engine, the arrangement model, project storage --
// have their own modules. What is left is the shell that connects them.
// ---------------------------------------------------------------------------

const mark = (c, l, s) => (window.__bootMark ? window.__bootMark(c, l, s) : null);
mark('M01', 'MODULE_START');

import { InputEngine, codeOf } from './input/inputEngine.js';
import { PerformanceEngine, DEFAULT_SETTINGS } from './perf/performanceEngine.js';
import { performKey as performKeyThrough } from './perf/performKey.js';
import { pressEnter, canCommit as canCommitShared, commitBlockedReason as blockedReason } from './ui/commitLoop.js';
import { DEFAULT_MAPPING, describeMapping, ZONES } from './perf/mapping.js';
import { SCALES, midiToFreq } from './perf/scale.js';
import { SoundEngine } from './sound/soundEngine.js';
import { SOUND_SETS, SOUND_WORLD_ORDER } from './sound/soundSets.js';
import { LoopEngine } from './loop/loopEngine.js';
import { Recorder, download } from './record/recorder.js';
import { SessionEngine } from './session/sessionEngine.js';
import { simulateSession } from './session/simulate.js';
import { EV, FORMAT_VERSION, ENGINE_VERSION } from './session/sessionEvents.js';
import { runSelfTests } from './tests/selfTest.js';
import { clamp, deepClone } from './core/hash.js';

import { ProjectController, SAVE_STATE } from './project/projectController.js';
import { PROJECT_FORMAT_VERSION, defaultTitle } from './project/projectFormat.js';
import { STARTER_KITS, planKitEvents, previewPhrase, findKit } from './ui/starterKits.js';
import { stepFor, guidedDone, setGuidedDone, GUIDED_STEPS } from './ui/guidedJam.js';
import { NextMoveMemory } from './ui/nextMove.js';
import {
  proposeSections, planSectionEvents, mixFromSnapshot, makeSection, sectionMatches,
  sectionWeight, renameSection, duplicateSection, moveSection, removeSection, saveMixInto,
} from './story/storyStrip.js';
import { renderTracks, buildTimeline, VolumeDrag } from './ui/tracksView.js';
import { el, setChildren, $ } from './ui/dom.js';

mark('M02', 'IMPORTS_READY');

// ---------------------------------------------------------------------------
// engines
// ---------------------------------------------------------------------------
const settings = Object.assign({}, DEFAULT_SETTINGS);
const mapping = DEFAULT_MAPPING;

const sound = new SoundEngine();
const perf = new PerformanceEngine(mapping, settings);
const loop = new LoopEngine(sound, { bpm: settings.bpm, quantize: settings.quantize, onChange: renderAll });
const recorder = new Recorder();
const session = new SessionEngine({
  now: () => sound.now(),
  onTakeOverflow: (info) => {
    if (recorder.recording) {
      takeOverflowed = true;
      stopTake();
    }
    toast(`Capture stopped: the take reached ${info.limit} events. Nothing was lost — export it now.`);
  },
  onScratchCheckpoint: () => (started ? sessionCheckpoint() : null),
  // Autosave is driven from here rather than from every call site, so an event
  // dispatched by a corner of the app nobody remembered still marks the piece
  // as changed. Replay uses apply(), not dispatch(), so a replay cannot mark
  // the piece dirty -- which is right: replaying changes nothing.
  onDispatch: (ev) => onSessionDispatched(ev),
});

const textEl = $('text');

let input = null;
let started = false;
let replaying = false;
let takeOverflowed = false;
let composing = false; // the compose panel is open
let lastCommit = null; // {seq, error, layer} of the most recent Enter
let transportRunning = true;
let devMode = false;
let sessionStartedAt = 0;
let capturedOnce = false;
let dirtySinceCapture = false;
const eventsBySeq = new Map();

// Replay does not go through the InputEngine, so it cannot read keys/sec or
// silence from it -- doing so made the reverb and layer levels depend on
// whatever the player happened to type before pressing REPLAY. These mirror
// the InputEngine's own maths, fed from the log instead.
const replayRecent = [];
let replayLastKey = 0;

// ---------------------------------------------------------------------------
// story + guidance state (project metadata, not performance)
// ---------------------------------------------------------------------------
let sections = [];
let currentSectionId = null;
let sectionsUndo = null;
let kitId = null;
let guidedOpen = false;
const moves = new NextMoveMemory();

const PRESETS = [
  ['beat', 'Beat'],
  ['minimal', 'Minimal'],
  ['bass', 'Bass'],
  ['ambient', 'Ambient'],
  ['pulse', 'Pulse'],
];

const MAX_PROJECT_FILE_BYTES = 32 * 1024 * 1024;

const drag = new VolumeDrag(() => renderAll());

// ---------------------------------------------------------------------------
// project
// ---------------------------------------------------------------------------
const project = new ProjectController({
  capture: () => captureProject(),
  onStatus: (state, info) => paintSaveState(state, info),
});

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
    paintSoundHint();
  })
  .on(EV.SET_BPM, (d) => {
    settings.bpm = d.value;
    perf.setSettings({ bpm: d.value });
    loop.setBpm(d.value);
    sound.setBpm(d.value);
    $('bpm').value = d.value;
    $('bpmVal').textContent = d.value;
    // note widths are drawn against the tempo, so they have to be redrawn
    if (started) renderAll();
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
    const r = loop.addBuiltin(d.loop, SCALES[settings.soundSet] || SCALES.electronic);
    if (r.error) toast('All 4 tracks are full — delete one first');
  })
  .on(EV.CLEAR_LAYER, (d) => loop.clearLayer(d.layer))
  // A COMMAND ("track N now holds exactly this"), which is what makes UNDO an
  // ordinary part of the log rather than something replay must know about.
  .on(EV.RESTORE_LAYER, (d) => loop.restoreLayer(d))
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
    }
  })
  .on(EV.LAYER_ON, (d) => loop.setLayer(d.layer, { on: d.value, muted: false }))
  .on(EV.LAYER_MUTE, (d) => loop.setLayer(d.layer, { muted: d.value }))
  .on(EV.LAYER_VOLUME, (d) => loop.setLayer(d.layer, { volume: d.value }));

/** every dispatched event means the piece changed; replay dispatches nothing */
function onSessionDispatched(ev) {
  if (!started) return;
  if (ev.type !== EV.SET_MASTER_VOLUME) dirtySinceCapture = capturedOnce;
  project.markDirty(ev.type);
}

// ---------------------------------------------------------------------------
// BOOT
//
// Audio needs a user gesture, so there is no separate START button: opening a
// piece IS the gesture. Every entry point on the home screen funnels through
// here, and `started` makes it idempotent.
// ---------------------------------------------------------------------------
async function ensureAudio() {
  // Recorded on every entry attempt, including the ones that find `started`
  // already true, so the boot self-test can prove the FIRST click arrived after
  // the module was ready rather than into the gap before it.
  mark('C01', 'CLICK_RECEIVED');
  if (started) return;
  mark('B01', 'BOOT_ENTER');
  setStage('Starting audio…');

  await sound.start();
  mark('A01', 'AUDIO_CONTEXT_CREATED');
  mark('A02', 'AUDIO_RUNNING', sound.ctx.state === 'running' ? 'OK' : 'NG:' + sound.ctx.state);
  setStage('Preparing the mixer…');

  sound.setSoundSet(settings.soundSet);
  sound.setBpm(settings.bpm);
  sound.setMasterVolume(settings.masterVolume);

  setStage('Preparing loops…');
  loop.init();
  mark('L01', 'LOOP_INIT');
  recorder.reset();

  input = new InputEngine({
    now: () => sound.now(),
    onDown: (ev) => {
      recorder.addRaw(ev); // the live object; it gains holdMs on keyup
      // The log gets a SNAPSHOT, taken before the key comes up, so it is honest
      // about what was known at that instant instead of quietly acquiring a
      // holdMs later through a shared reference.
      session.dispatch(EV.KEY_DOWN, Object.assign({}, ev), ev.timestamp);
    },
    onUp: (ev) => session.dispatch(EV.KEY_UP, { seq: ev.seq, holdMs: ev.holdMs }, ev.keyupAt),
  });

  setStage('');
  started = true;
  sessionStartedAt = Date.now();
  // A timer, not requestAnimationFrame: the pause macro must keep working even
  // when the window is not being painted.
  setInterval(paint, 40);
  mark('APP', 'APP_READY');
}

function setStage(s) {
  const node = $('bootStage');
  node.textContent = s;
  node.hidden = !s;
}

function bootFailed(err) {
  console.error(err);
  mark('B02', 'BOOT_FAILED', 'NG');
  window.__bootError(
    '音を出せませんでした',
    'Web Audio を開始できませんでした（' + (err && err.message ? err.message : err) + '）。' +
      ' サウンド出力先が有効か確認してください。下は起動ログです。'
  );
}

// ---------------------------------------------------------------------------
// HOME  --  the library, and the audio gesture
// ---------------------------------------------------------------------------
async function showHome({ save = true } = {}) {
  if (save && started && project.projectId) await project.flush('leaving');
  stopReplayIfRunning();
  stopTransport();
  sound.allNotesOff();
  document.body.classList.remove('playing', 'perform');
  $('app').hidden = true;
  $('home').hidden = false;
  await refreshLibrary();
}

async function refreshLibrary() {
  let list = [];
  let lastOpened = null;
  try {
    [list, lastOpened] = await Promise.all([
      project.listProjects(6),
      project.lastOpenedProject(),
    ]);
  } catch (e) {
    /* reported below via the save state */
  }
  const last = lastOpened || list[0] || null;

  const cont = $('continueBtn');
  if (last) {
    cont.hidden = false;
    $('continueTitle').textContent = last.title;
    $('continueMeta').textContent = summaryLine(last);
    cont.onclick = () => openFromLibrary(last.projectId);
  } else {
    cont.hidden = true;
  }

  const rest = list.slice(1);
  $('recent').hidden = rest.length === 0;
  setChildren($('recentList'), rest.map((s) => recentRow(s, list.map((x) => x.title))));

  if (project.state === SAVE_STATE.UNAVAILABLE) {
    const w = $('storeWarn');
    w.hidden = false;
    w.textContent =
      'This browser cannot save pieces here (private browsing, or storage is blocked). ' +
      'You can still play and use Download project to keep your work.';
  }
}

function summaryLine(s) {
  const st = s.stats || {};
  const bits = [
    when(s.updatedAt),
    `${st.tracks || 0} track${st.tracks === 1 ? '' : 's'}`,
    st.loopSeconds ? `${Math.round(st.loopSeconds)}s loop` : null,
    (SOUND_SETS[s.soundSet] && SOUND_SETS[s.soundSet].label) || s.soundSet,
  ];
  return bits.filter(Boolean).join(' · ');
}

function when(iso) {
  if (!iso) return 'never';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'unknown';
  const mins = Math.floor((Date.now() - d.getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return mins + ' min ago';
  if (mins < 60 * 24) return Math.floor(mins / 60) + ' h ago';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function recentRow(s, titles) {
  return el('div', { className: 'recent-row' }, [
    el('button', { className: 'recent-open', type: 'button', onclick: () => openFromLibrary(s.projectId) }, [
      // textContent, never markup: a title is arbitrary text somebody typed.
      el('span', { className: 'recent-title', text: s.title, title: s.title }),
      el('span', { className: 'recent-meta', text: summaryLine(s) }),
    ]),
    el('div', { className: 'recent-btns' }, [
      el('button', { className: 'chip ghost', type: 'button', text: 'Rename', onclick: () => renameFromLibrary(s) }),
      el('button', { className: 'chip ghost', type: 'button', text: 'Duplicate', onclick: () => duplicateFromLibrary(s, titles) }),
      el('button', { className: 'chip ghost', type: 'button', text: 'Delete', onclick: () => deleteFromLibrary(s) }),
    ]),
  ]);
}

async function renameFromLibrary(s) {
  const next = window.prompt('Name for this piece', s.title);
  if (next === null) return;
  await project.rename(s.projectId, next);
  await refreshLibrary();
}

async function duplicateFromLibrary(s, titles) {
  const copy = await project.duplicate(s.projectId, titles);
  await refreshLibrary();
  if (copy) homeToast(`Copied as “${copy.title}”`);
}

async function deleteFromLibrary(s) {
  const ok = await project.remove(s.projectId);
  await refreshLibrary();
  if (!ok) return;
  // Deleting is recoverable, so it does not need a confirmation dialog in
  // front of it -- an UNDO the user can actually reach is strictly better than
  // an "are you sure?" nobody reads.
  homeToast(`Deleted “${s.title}”`, {
    label: 'UNDO',
    action: async () => {
      await project.undoRemove();
      await refreshLibrary();
    },
  });
}

async function openFromLibrary(projectId) {
  try {
    await ensureAudio();
  } catch (e) {
    bootFailed(e);
    return;
  }
  const p = await project.openProject(projectId);
  if (!p) {
    homeToast('That piece could not be opened.', null, true);
    return;
  }
  loadProjectIntoEngines(p);
  enterStudio();
  if (await project.store.recoveredFromBackup(projectId).catch(() => false)) {
    toast('The newest save was damaged, so the previous good one was opened.');
  }
}

async function startNewPiece() {
  try {
    await ensureAudio();
  } catch (e) {
    bootFailed(e);
    return;
  }
  const titles = (await project.listProjects(24)).map((s) => s.title);
  let title = defaultTitle();
  let n = 2;
  while (titles.includes(title)) title = defaultTitle() + ' (' + n++ + ')';

  resetEnginesForNewPiece();
  project.newProject({ title, settings: settingsSnapshot() });
  session.dispatch(EV.SESSION_START, sessionCheckpoint());
  sections = [];
  currentSectionId = null;
  kitId = null;
  capturedOnce = false;
  dirtySinceCapture = false;
  enterStudio();
  if (!guidedDone()) openGuided();
  openKitPicker();
}

function enterStudio() {
  document.body.classList.add('playing');
  $('home').hidden = true;
  $('app').hidden = false;
  $('titleInput').value = project.title;
  startTransport();
  renderAll();
  textEl.focus();
}

// ---------------------------------------------------------------------------
// PROJECT snapshot / restore
// ---------------------------------------------------------------------------
function captureProject() {
  const view = loop.composerSnapshot();
  return {
    settings: settingsSnapshot(),
    initialSettings: settingsSnapshot(),
    text: textEl.value,
    // CANONICAL. Everything below this line can be recomputed from it.
    sessionEvents: session.events.map((e) => ({ i: e.i, time: e.time, type: e.type, data: e.data })),
    state: {
      performanceState: perf.exportState(),
      loopState: loop.exportState(),
      beatAtSave: +loop.beatAt(sound.now()).toFixed(6),
      // A history that was trimmed without a usable checkpoint cannot be
      // replayed, and that fact has to survive a save -- otherwise reopening
      // the piece silently re-enables a REPLAY that would produce nonsense.
      scratchIncomplete: !session.canReplayScratch(),
    },
    story: { sections: deepClone(sections), currentId: currentSectionId },
    ui: { kitId, guided: guidedDone() },
    stats: {
      tracks: view.totals.filled,
      notes: view.totals.notes,
      sections: sections.length,
      events: session.events.length,
      loopSeconds: +loop.loopSeconds().toFixed(2),
      captured: capturedOnce,
      bpm: settings.bpm,
    },
  };
}

function resetEnginesForNewPiece() {
  sound.allNotesOff();
  session.reset();
  loop.clearAll();
  perf.reset();
  eventsBySeq.clear();
  if (input) input.reset();
  recorder.reset();
  textEl.value = '';
  Object.assign(settings, DEFAULT_SETTINGS);
  applySettingsToEngines(settings);
  loop.setOrigin(sound.now(), 0, settings.bpm);
}

/**
 * Open a saved piece.
 *
 * SILENTLY. A headless instrument reduces the canonical log into an engine
 * snapshot without creating AudioNodes. The persisted `state` object is only a
 * speed cache and is never allowed to overrule a complete session log.
 *
 * The scheduler is then started from NOW -- never from the beat the piece was
 * saved at, which belongs to an AudioContext that no longer exists.
 */
function loadProjectIntoEngines(p) {
  sound.allNotesOff();
  session.reset();
  loop.clearAll();
  perf.reset();
  eventsBySeq.clear();
  if (input) input.reset();
  recorder.reset();

  const at = sound.now();
  applySettingsToEngines(p.settings || p.initialSettings || DEFAULT_SETTINGS);

  const st = p.state || {};
  const log = deepClone(p.sessionEvents || []);
  if (log.length && !st.scratchIncomplete) {
    const rebuilt = simulateSession(log, mapping, p.initialSettings || DEFAULT_SETTINGS);
    applySettingsToEngines(rebuilt.settings);
    perf.importState(rebuilt.performanceState);
    loop.importState(rebuilt.loopState, at);
  } else {
    // A scratch history explicitly marked incomplete has no replayable head;
    // its cache is the only surviving representation. The UI already disables
    // Replay for this case, so it cannot masquerade as a canonical log.
    perf.importState(st.performanceState || null);
    if (st.loopState) loop.importState(st.loopState, at);
    else loop.setOrigin(at, 0, settings.bpm);
  }

  textEl.value = typeof p.text === 'string' ? p.text : '';
  recorder.setText(textEl.value);

  // Put the canonical log back. `nextId` continues past the highest id in it so
  // a new event can never collide with one already in the history.
  session.events = log;
  session.nextId = session.events.reduce((m, e) => Math.max(m, (e.i || 0) + 1), 0);
  session.checkpoints = [];
  session._sinceCheckpoint = Infinity;
  session.scratchIncomplete = !!st.scratchIncomplete;
  if (!session.events.length) session.dispatch(EV.SESSION_START, sessionCheckpoint());

  sections = (p.story && Array.isArray(p.story.sections) ? deepClone(p.story.sections) : []);
  currentSectionId = (p.story && p.story.currentId) || null;
  sectionsUndo = null;
  kitId = (p.ui && p.ui.kitId) || null;
  capturedOnce = !!(p.stats && p.stats.captured);
  dirtySinceCapture = false;
  guidedOpen = false;
  $('guided').hidden = true;
}

function applySettingsToEngines(s) {
  // Applied, not dispatched: restoring a saved state is not a performance
  // action and must not appear in the log as one.
  if (!s) return;
  if (s.soundSet !== undefined) session.apply({ type: EV.SET_SOUND, data: { value: s.soundSet } });
  if (s.bpm !== undefined) session.apply({ type: EV.SET_BPM, data: { value: s.bpm } });
  if (s.complexity !== undefined) session.apply({ type: EV.SET_COMPLEXITY, data: { value: s.complexity } });
  if (s.quantize !== undefined) session.apply({ type: EV.SET_QUANTIZE, data: { value: s.quantize } });
  if (s.masterVolume !== undefined) session.apply({ type: EV.SET_MASTER_VOLUME, data: { value: s.masterVolume } });
}

function settingsSnapshot() {
  return {
    soundSet: settings.soundSet,
    bpm: settings.bpm,
    complexity: settings.complexity,
    quantize: settings.quantize,
    masterVolume: settings.masterVolume,
  };
}

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

function restoreCheckpoint(data, atTime) {
  if (!data) return;
  const at = atTime === undefined ? sound.now() : atTime;
  applySettingsToEngines(data.settings);
  perf.importState(data.performanceState || null);
  if (data.loopState) {
    // importState rebases the whole tempo map (including a queued-but-not-yet-
    // effective segment) onto `at`; it must not be followed by setOrigin, which
    // would collapse the map back to a single segment.
    loop.importState(data.loopState, at);
  } else if (data.beatAtStart !== undefined) {
    loop.setOrigin(at, data.beatAtStart);
  }
  renderAll();
}

// ---------------------------------------------------------------------------
// the one path every key takes
// ---------------------------------------------------------------------------
function performKey(raw) {
  return performKeyThrough(raw, {
    perf, loop, sound, recorder, eventsBySeq,
    replaying: session.replaying,
    onLayer: (c) => {
      // remembered so COMMIT LOOP can close the panel only on a real commit
      lastCommit = c;
      if (c.error) { toast('All 4 tracks are full — delete one first'); return; }
      toast(`TRACK ${c.layer + 1} now loops (${c.bars} bar${c.bars > 1 ? 's' : ''})`);
      if (composing && !session.replaying) stopComposing();
      // A derived marker, not a command: logged so the timeline reads
      // correctly, never re-applied on replay (the Enter keystroke does that).
      if (!session.replaying) {
        session.dispatch(EV.COMMIT_LAYER, { derived: true, layer: c.layer, bars: c.bars });
      }
    },
  });
}

// ---------------------------------------------------------------------------
// keyboard
// ---------------------------------------------------------------------------
/**
 * THE one place a key press enters the instrument.
 *
 * The physical keyboard and the COMMIT LOOP button both call this. Nothing
 * synthesises a DOM KeyboardEvent to fake a keystroke: a synthetic event is
 * untrusted, skips the browser's own text editing, and would have quietly
 * drifted away from what a real key does. A plain descriptor is enough, because
 * InputEngine only ever reads code / key / isComposing / shiftKey.
 */
function keyDown(desc) {
  if (replaying || session.replaying || !input) return null;
  return input.handleKeyDown(desc);
}
function keyUp(desc) {
  if (replaying || session.replaying || !input) return null;
  return input.handleKeyUp(desc);
}

textEl.addEventListener('compositionstart', () => {
  if (input) input.setComposing(true);
  renderCompose();
});
textEl.addEventListener('compositionend', () => {
  if (input) input.setComposing(false);
  renderCompose();
});
textEl.addEventListener('keydown', (e) => {
  if (replaying) { e.preventDefault(); return; }
  if (codeOf(e) === 'Tab') e.preventDefault();
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  keyDown(e);
});
textEl.addEventListener('keyup', (e) => keyUp(e));
textEl.addEventListener('input', () => recorder.setText(textEl.value));

// Clicking anywhere on the play surface puts the caret back where it belongs.
$('play').addEventListener('mousedown', (e) => {
  if (e.target.tagName === 'BUTTON') return;
  setTimeout(() => textEl.focus(), 0);
});
$('focusBack').onclick = () => textEl.focus();
document.addEventListener('mousedown', (e) => {
  if (document.body.classList.contains('perform') && e.target.tagName !== 'BUTTON') {
    setTimeout(() => textEl.focus(), 0);
  }
});

/**
 * A key that is still down when the window goes away will never send its
 * keyup, and the note it is playing would hang until the safety timer fires
 * four seconds later. Releasing it HERE, through the ordinary path, keeps the
 * log honest: the session records a real KEY_UP at the moment the window lost
 * focus, which is exactly what happened.
 */
function releaseHeldKeys(reason) {
  if (!input || !input.hasHeldKeys) return 0;
  const codes = [...input.held.keys()];
  // Safety release bypasses the UI's "ignore input while replaying" gate. A
  // replay or window transition must never strand InputEngine.held merely
  // because the shell changed mode one line too early.
  for (const code of codes) input.handleKeyUp({ code, key: code });
  if (reason && devMode) console.info('released held keys:', codes.join(','), 'because', reason);
  return codes.length;
}

window.addEventListener('blur', () => releaseHeldKeys('window blur'));
document.addEventListener('visibilitychange', () => {
  $('hiddenWarn').hidden = !document.hidden;
  if (document.hidden) {
    mark('W01', 'TAB_HIDDEN', 'WARN');
    releaseHeldKeys('tab hidden');
    // The last reliable moment to write: `pagehide` may not get a transaction
    // through, and mobile browsers can freeze a hidden tab outright.
    if (started && project.projectId) project.saveNow('tab hidden');
  }
});
window.addEventListener('pagehide', () => {
  releaseHeldKeys('page hide');
  sound.allNotesOff();
});

// ---------------------------------------------------------------------------
// transport
// ---------------------------------------------------------------------------
function startTransport() {
  transportRunning = true;
  loop.start();
  $('stopBtn').textContent = '■ Stop';
}

/**
 * STOP is the panic button, and it is deliberately NOT a session event.
 *
 * It stops the scheduler and silences everything that is sounding. That is a
 * property of the room you are in (like turning the amp off), not of the piece
 * -- a replay of the performance should not stop halfway because somebody hit
 * Stop during the original take. Nothing about the arrangement changes: press
 * Play and the same loops are still on, still at the same volumes.
 */
function stopTransport() {
  transportRunning = false;
  loop.stop();
  releaseHeldKeys('stop');
  sound.allNotesOff();
  $('stopBtn').textContent = '▶ Play';
}

$('stopBtn').onclick = () => {
  if (replaying) { stopReplay(); return; }
  if (recorder.recording) { stopTake(); return; }
  if (transportRunning) stopTransport();
  else startTransport();
  textEl.focus();
};

// ---------------------------------------------------------------------------
// TRACKS + STORY + everything else on screen
// ---------------------------------------------------------------------------
function renderAll() {
  if (!started) return;
  const view = loop.composerSnapshot();
  renderTracks($('tracks'), view, trackHandlers, { composing, drag, presets: PRESETS });
  if (drag.active) { renderCompose(view); return; }
  renderStory(view);
  renderCompose(view);
  renderProgress(view);
  renderAdvice();
}

/**
 * The guide and the suggestion strip, refreshed whenever what they describe has
 * actually changed.
 *
 * They must not wait for a track to appear: typing eight keys satisfies a guide
 * step, and a guide that only catches up when a loop is committed is telling
 * you to do something you have already done. But rebuilding them on every
 * keystroke would mean a full composerSnapshot -- every note in every layer,
 * deep-copied -- ten times a second. `loop.counts()` returns primitives, so the
 * cheap check runs on the 40 ms paint tick and the DOM is touched only when the
 * signature moves.
 */
let adviceKey = '';
function renderAdvice(force) {
  const c = loop.counts();
  // `kitId` belongs in the signature even though it is not a count: choosing a
  // starting sound completes a guide step, and nothing else about the piece
  // need change when it does.
  const key = [c.filled, c.typed, c.audible, c.pending, sections.length, capturedOnce, dirtySinceCapture, settings.soundSet, kitId].join('|');
  if (!force && key === adviceKey) return;
  adviceKey = key;
  renderNextMove(c);
  renderGuided(c);
}

const trackHandlers = {
  onToggle: (id, value) => session.dispatch(EV.LAYER_ON, { layer: id, value }),
  onMute: (id, value) => session.dispatch(EV.LAYER_MUTE, { layer: id, value }),
  onVolume: (id, value) => session.dispatch(EV.LAYER_VOLUME, { layer: id, value }),
  onDelete: (id) => deleteTrack(id),
  onCreate: () => startComposing(),
  onPreset: (key) => {
    session.dispatch(EV.ADD_BUILTIN_LOOP, { loop: key });
    textEl.focus();
  },
};

/**
 * Deleting a track is recoverable, so it happens immediately and offers UNDO,
 * rather than stopping to ask. The restore goes out as a RESTORE_LAYER command,
 * so the log still explains the state and a replay reproduces both the delete
 * and the change of mind.
 */
function deleteTrack(id) {
  if (recorder.recording) {
    toast('Deleting a track is locked while capturing — press Stop first');
    return;
  }
  const content = loop.layerContent(id);
  session.dispatch(EV.CLEAR_LAYER, { layer: id });
  if (!content) return;
  toast(`Deleted TRACK ${id + 1}`, {
    label: 'UNDO',
    action: () => session.dispatch(EV.RESTORE_LAYER, content),
  });
}

// --- story ------------------------------------------------------------------
function renderStory(view) {
  const host = $('storyStrip');
  if (!sections.length) {
    setChildren(host, [
      el('p', {
        className: 'story-empty',
        text:
          view.totals.filled < 2
            ? 'Make a second loop, then this is where you shape them into a song.'
            : 'Save the mix you have now as a section, or let it suggest a shape.',
      }),
    ]);
  } else {
    setChildren(
      host,
      sections.map((s) => {
        const playing = sectionMatches(s, view);
        if (playing) currentSectionId = s.id;
        return el('div', { className: 'section-wrap' }, [
          el('button', {
            className: 'section-chip' + (playing ? ' playing' : ''),
            type: 'button',
            title: 'Play this section',
            onclick: () => applySection(s.id),
          }, [
            el('span', { className: 'sc-name', text: s.name }),
            el('span', {
              className: 'sc-meta',
              // Words, not just a border colour: "PLAYING" is readable when the
              // colour is not.
              text: (playing ? 'PLAYING · ' : '') + sectionWeight(s) + '/' + view.totals.filled,
            }),
          ]),
          el('div', { className: 'section-tools' }, [
            el('button', { type: 'button', text: 'save', title: 'Overwrite with the current mix', onclick: () => saveMix(s.id) }),
            el('button', { type: 'button', text: 'name', title: 'Rename', onclick: () => renameSectionPrompt(s.id) }),
            el('button', { type: 'button', text: 'copy', title: 'Duplicate', onclick: () => editSections(duplicateSection(sections, s.id), 'Duplicated') }),
            el('button', { type: 'button', text: '‹', title: 'Move earlier', onclick: () => editSections(moveSection(sections, s.id, -1), null) }),
            el('button', { type: 'button', text: '›', title: 'Move later', onclick: () => editSections(moveSection(sections, s.id, 1), null) }),
            el('button', { type: 'button', text: '×', title: 'Delete section', onclick: () => deleteSection(s.id) }),
          ]),
        ]);
      })
    );
  }
  $('storyAddBtn').disabled = view.totals.filled === 0;
  $('storyProposeBtn').hidden = sections.length > 0 || view.totals.filled < 2;
  $('storyHint').textContent = sections.length
    ? 'In Perform view these become big buttons.'
    : '';
}

/** every section edit is one step undoable, because they are cheap to keep */
function editSections(next, message) {
  sectionsUndo = deepClone(sections);
  sections = next;
  project.markDirty('story');
  renderAll();
  if (message) {
    toast(message, { label: 'UNDO', action: () => { sections = sectionsUndo || []; sectionsUndo = null; project.markDirty('story'); renderAll(); } });
  }
}

function applySection(id) {
  const s = sections.find((x) => x.id === id);
  if (!s) return;
  const view = loop.composerSnapshot();
  // Through the log, in a fixed order, every time -- see storyStrip.js.
  for (const ev of planSectionEvents(s, view.layerCount)) session.dispatch(ev.type, ev.data);
  currentSectionId = id;
  project.markDirty('section');
  renderAll();
  textEl.focus();
}

function saveMix(id) {
  editSections(saveMixInto(sections, id, loop.composerSnapshot()), 'Mix saved into this section');
}

function renameSectionPrompt(id) {
  const s = sections.find((x) => x.id === id);
  if (!s) return;
  const next = window.prompt('Section name', s.name);
  if (next === null) return;
  editSections(renameSection(sections, id, next), null);
}

function deleteSection(id) {
  const s = sections.find((x) => x.id === id);
  editSections(removeSection(sections, id), s ? `Deleted “${s.name}”` : 'Deleted section');
}

$('storyAddBtn').onclick = () => {
  const view = loop.composerSnapshot();
  const name = 'SECTION ' + (sections.length + 1);
  editSections([...sections, makeSection(name, mixFromSnapshot(view))], null);
  toast('Saved the current mix. Rename it to something you will recognise on stage.');
};
$('storyProposeBtn').onclick = () => {
  const proposed = proposeSections(loop.composerSnapshot());
  if (!proposed.length) {
    toast('Make a second loop first — a shape needs at least two things to move between.');
    return;
  }
  editSections(proposed, 'Suggested five sections — change any of them');
};

// --- progress ---------------------------------------------------------------
function renderProgress(view) {
  const secs = loop.loopSeconds();
  setChildren($('progressBody'), [
    stat(String(view.totals.filled) + ' / ' + view.layerCount, 'tracks'),
    stat(String(sections.length), 'sections'),
    stat(secs ? secs.toFixed(1) + 's' : '—', 'loop length'),
    stat(String(view.totals.notes), 'notes in loops'),
    stat(String(session.events.length), 'performance events'),
    stat(capturedOnce ? (dirtySinceCapture ? 'stale' : 'yes') : 'not yet', 'captured'),
  ]);
}

function stat(value, label) {
  return el('div', { className: 'stat' }, [el('b', { text: value }), el('span', { text: label })]);
}

// --- next move --------------------------------------------------------------
function renderNextMove(c) {
  const move = moves.pick(
    {
      tracks: c.filled,
      typedTracks: c.typed,
      audible: c.audible,
      pending: c.pending,
      sections: sections.length,
      captured: capturedOnce,
      dirtySinceCapture,
      soundSet: settings.soundSet,
      sessionSeconds: sessionStartedAt ? (Date.now() - sessionStartedAt) / 1000 : 0,
    },
    Date.now() / 1000
  );
  const box = $('nextStep');
  if (!move) { box.hidden = true; return; }
  box.hidden = false;
  $('nextStepText').textContent = move.text;
  $('nextStepHint').textContent = move.hint;
}

$('nextStepClose').onclick = () => {
  moves.dismiss(Date.now() / 1000);
  $('nextStep').hidden = true;
};

// --- guided jam -------------------------------------------------------------
function openGuided() {
  guidedOpen = true;
  $('guided').hidden = false;
  renderAdvice(true);
}

function closeGuided(markDone) {
  guidedOpen = false;
  $('guided').hidden = true;
  if (markDone) setGuidedDone(true);
}

function renderGuided(c) {
  if (!guidedOpen) return;
  const cur = stepFor({
    tracks: c.filled,
    typedTracks: c.typed,
    pending: c.pending,
    sections: sections.length,
    captured: capturedOnce,
    kitChosen: !!kitId,
  });
  if (cur.complete) {
    $('guidedStep').textContent = GUIDED_STEPS.length + ' / ' + GUIDED_STEPS.length;
    $('guidedTitle').textContent = 'That is a piece of music.';
    $('guidedBody').textContent = 'Everything from here is yours. Open Help any time to see this again.';
    setChildren($('guidedExtra'), [
      el('button', { className: 'chip primary', type: 'button', text: 'Done', onclick: () => closeGuided(true) }),
    ]);
    setGuidedDone(true);
    return;
  }
  $('guidedStep').textContent = cur.index + 1 + ' / ' + cur.total;
  $('guidedTitle').textContent = cur.step.title;
  $('guidedBody').textContent = cur.step.body;
  // The only affordance a step ever offers is the thing the step is about.
  const extra = [];
  if (cur.step.id === 'sound') extra.push(el('button', { className: 'chip', type: 'button', text: 'Choose a sound', onclick: () => openKitPicker() }));
  if (cur.step.id === 'shape') extra.push(el('button', { className: 'chip', type: 'button', text: 'Suggest a shape', onclick: () => $('storyProposeBtn').click() }));
  if (cur.step.id === 'capture') extra.push(el('button', { className: 'chip', type: 'button', text: 'Capture', onclick: () => $('recBtn').click() }));
  setChildren($('guidedExtra'), extra);
}

$('guidedClose').onclick = () => closeGuided(true);
$('replayGuideBtn').onclick = () => {
  setGuidedDone(false);
  closeSheet();
  openGuided();
};

// ---------------------------------------------------------------------------
// STARTER KITS
// ---------------------------------------------------------------------------
function openKitPicker() {
  const host = $('kitList');
  setChildren(
    host,
    STARTER_KITS.map((k) =>
      el('button', { className: 'kit ' + k.accent, type: 'button', onclick: () => applyKit(k.id) }, [
        el('span', { className: 'kit-name', text: k.name }),
        el('span', { className: 'kit-tag', text: k.tagline }),
        el('span', { className: 'kit-detail', text: k.detail + ' · ' + k.settings.bpm + ' bpm' }),
      ])
    )
  );
  $('kitPicker').hidden = false;
}

function applyKit(id) {
  const kit = findKit(id);
  if (!kit) return;
  const view = loop.composerSnapshot();
  for (const ev of planKitEvents(kit, { hasFreeTrack: view.nextFreeLayer !== null })) {
    session.dispatch(ev.type, ev.data);
  }
  kitId = id;
  $('kitPicker').hidden = true;
  project.markDirty('kit');
  renderAll();
  toast(kit.name + ' — ' + kit.firstMove);
  textEl.focus();
}

$('kitClose').onclick = () => { $('kitPicker').hidden = true; textEl.focus(); };

// ---------------------------------------------------------------------------
// COMPOSE MODE
// ---------------------------------------------------------------------------
function startComposing() {
  if (loop.composerSnapshot().nextFreeLayer === null) {
    toast('All 4 tracks are full — delete one first');
    return;
  }
  composing = true;
  renderAll();
  textEl.focus();
}

function stopComposing() {
  composing = false;
  renderAll();
  textEl.focus();
}

function renderCompose(view) {
  const panel = $('compose');
  if (!panel) return;
  panel.hidden = !composing;
  const v = view || loop.composerSnapshot();
  // Kept correct even while the panel is closed. The rule that decides it --
  // IME composition, a running replay, a full board, an empty phrase -- can
  // change while the panel is hidden, and a control whose disabled state is
  // only refreshed when it happens to be visible is a control that lies the
  // instant it is shown.
  $('commitBtn').disabled = !canCommit(v);
  if (!composing) return;
  const target = v.nextFreeLayer;
  $('composeTarget').textContent = target === null ? 'no free track' : 'TRACK ' + (target + 1);
  $('pendingCount').textContent = v.pending.count;
  $('pendingBars').textContent = v.pending.bars ? v.pending.bars + ' bar' + (v.pending.bars > 1 ? 's' : '') : '—';
  const can = canCommit(v);
  // Saying WHY it is unavailable is the whole point of disabling it.
  $('composeWhy').textContent = can
    ? 'Closing does not throw anything away. What you already played stays waiting, and the next Enter will still turn it into a loop.'
    : commitBlockedReason(v);
}

function commitContext(view) {
  return {
    view: view || loop.composerSnapshot(),
    // Both flags matter: `replaying` is this shell's, `session.replaying` is
    // the engine's, and a replay driven straight through SessionEngine only
    // sets the latter.
    replaying: replaying || session.replaying,
    imeComposing: !!(input && input.composing),
  };
}

function commitBlockedReason(v) {
  return blockedReason(commitContext(v));
}

function canCommit(view) {
  return canCommitShared(commitContext(view));
}

/**
 * COMMIT LOOP presses Enter through the SAME function the physical keyboard
 * uses -- no synthetic DOM event, nothing that depends on isTrusted. The
 * session therefore records the ordinary KEY_DOWN -> COMMIT_LAYER -> KEY_UP,
 * indistinguishable from a typed Enter.
 */
function commitLoop() {
  if (!canCommit()) return false;
  const raw = pressEnter({ keyDown, keyUp, textEl, onText: (t) => recorder.setText(t) });
  if (!raw) return false;
  // close only if a loop really was made
  if (lastCommit && lastCommit.seq === raw.seq && !lastCommit.error) {
    stopComposing();
    return true;
  }
  renderAll();
  return false;
}

$('commitBtn').onclick = commitLoop;
$('cancelComposeBtn').onclick = stopComposing;

// ---------------------------------------------------------------------------
// settings -- every control goes through the session log
// ---------------------------------------------------------------------------
function buildSoundPicker() {
  const sel = $('soundSet');
  setChildren(
    sel,
    SOUND_WORLD_ORDER.filter((k) => SOUND_SETS[k]).map((k) =>
      el('option', { value: k, text: SOUND_SETS[k].label })
    )
  );
  sel.value = settings.soundSet;
  paintSoundHint();
}

function paintSoundHint() {
  const s = SOUND_SETS[settings.soundSet];
  $('soundHint').textContent = s ? s.hint : '';
}

$('soundSet').onchange = (e) => { session.dispatch(EV.SET_SOUND, { value: e.target.value }); textEl.focus(); };
$('bpm').oninput = (e) => session.dispatch(EV.SET_BPM, { value: +e.target.value });
$('complexity').oninput = (e) => session.dispatch(EV.SET_COMPLEXITY, { value: +e.target.value });
$('quantize').onchange = (e) => { session.dispatch(EV.SET_QUANTIZE, { value: e.target.value }); textEl.focus(); };
$('volume').oninput = (e) => session.dispatch(EV.SET_MASTER_VOLUME, { value: +(e.target.value / 100).toFixed(3) });

/**
 * Auditioning a sound is not playing it. Preview notes go to their own bus and
 * are never dispatched, so nothing about hearing what Piano sounds like ends up
 * in the piece you are working on.
 */
$('previewSound').onclick = () => {
  sound.stopPreview();
  const scale = SCALES[settings.soundSet] || SCALES.electronic;
  for (const { at, ev } of previewPhrase(scale, midiToFreq)) sound.playPreview(ev, at);
  setTimeout(() => sound.stopPreview(), 2600);
};

// ---------------------------------------------------------------------------
// panels
// ---------------------------------------------------------------------------
function toggleInspector(force) {
  const open = force === undefined ? $('inspector').hidden : force;
  $('inspector').hidden = !open;
  $('inspectorBtn').setAttribute('aria-expanded', open ? 'true' : 'false');
  if (!open) textEl.focus();
}
$('inspectorBtn').onclick = () => toggleInspector();
$('inspectorClose').onclick = () => toggleInspector(false);

function openSheet() {
  $('sheet').hidden = false;
  $('helpBtn').setAttribute('aria-expanded', 'true');
}
function closeSheet() {
  $('sheet').hidden = true;
  $('helpBtn').setAttribute('aria-expanded', 'false');
  textEl.focus();
}
$('helpBtn').onclick = () => ($('sheet').hidden ? openSheet() : closeSheet());
$('sheetClose').onclick = closeSheet;
$('sheet').addEventListener('mousedown', (e) => { if (e.target === $('sheet')) closeSheet(); });
$('kitPicker').addEventListener('mousedown', (e) => { if (e.target === $('kitPicker')) $('kitPicker').hidden = true; });

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!$('sheet').hidden) { closeSheet(); return; }
  if (!$('kitPicker').hidden) { $('kitPicker').hidden = true; textEl.focus(); return; }
  if (!$('inspector').hidden) { toggleInspector(false); return; }
});

$('viewBtn').onclick = () => {
  const on = document.body.classList.toggle('perform');
  $('viewBtn').textContent = on ? 'Exit perform' : 'Perform';
  if (on) { toggleInspector(false); closeSheet(); }
  textEl.focus();
};

$('homeBtn').onclick = () => showHome();

$('titleInput').oninput = (e) => project.setTitle(e.target.value);
$('titleInput').onblur = (e) => { e.target.value = project.title; };

// ---------------------------------------------------------------------------
// capture (RECORD) / export
// ---------------------------------------------------------------------------
$('recBtn').onclick = () => {
  if (recorder.recording) { stopTake(); return; }
  // A key that is already down began its note before the take. Its keyup would
  // land inside the recording, so the take would open with a note it never
  // triggered -- and the replay would not reproduce it.
  if (input && input.hasHeldKeys) {
    toast('Let go of every key before capturing');
    return;
  }
  if (!transportRunning) startTransport();
  takeOverflowed = false;
  recorder.setText(textEl.value);
  recorder.startAudio(sound.recordDest.stream, sound.now(), textEl.value);
  session.beginTake(sessionCheckpoint());
  $('recBtn').classList.add('on');
  $('recBtn').textContent = '● Capturing';
  $('clearBtn').disabled = true;
  toast('Capturing — your typing AND every control you touch is the take');
  textEl.focus();
};

async function stopTake() {
  if (!recorder.recording) return;
  session.endTake();
  await recorder.stopAudio(sound.now(), textEl.value);
  $('recBtn').classList.remove('on');
  $('recBtn').textContent = '● Capture';
  $('clearBtn').disabled = false;
  capturedOnce = true;
  dirtySinceCapture = false;
  const { raw, perf: p } = recorder.takeSlices();
  if (!takeOverflowed) {
    toast(`Captured — ${raw.filter((e) => e.keydown).length} keys, ${p.length} notes, ${session.takeEvents().length} events`);
  }
  takeOverflowed = false;
  renderAll();
  await project.saveNow('capture stopped');
}

$('exportBtn').onclick = async () => {
  if (recorder.recording) await stopTake();
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
  toast('Exported ' + name + (tookTake ? ' (captured take)' : ' (scratch history — press Capture for a clean take)'));
};

$('downloadProjectBtn').onclick = () => downloadProject();
$('backupBtn').onclick = () => downloadProject();

function downloadProject() {
  const f = project.exportFile();
  if (!f) return;
  download(new Blob([f.json], { type: 'application/json' }), f.name);
  toast('Downloaded ' + f.name + ' — keep it somewhere safe');
}

$('openFileBtn').onclick = () => $('importFile').click();
$('importFile').onchange = async (e) => {
  const file = e.target.files && e.target.files[0];
  e.target.value = '';
  if (!file) return;
  if (file.size > MAX_PROJECT_FILE_BYTES) {
    homeToast('That project file is too large (32 MB maximum). Nothing was changed.', null, true);
    return;
  }
  let text;
  try {
    text = await file.text();
  } catch (err) {
    homeToast('That project file could not be read. Nothing was changed.', null, true);
    return;
  }
  const titles = (await project.listProjects(24)).map((s) => s.title);
  const res = await project.importFile(text, titles);
  if (!res.ok) {
    // Nothing was touched. That is the contract, and it is worth saying so.
    homeToast(res.error + ' Nothing was changed.', null, true);
    return;
  }
  await refreshLibrary();
  homeToast(`Imported “${res.project.title}”` + (res.warnings.length ? ' (' + res.warnings.join('; ') + ')' : ''), {
    label: 'OPEN',
    action: () => openFromLibrary(res.project.projectId),
  });
};

$('duplicateBtn').onclick = async () => {
  await project.flush('before duplicate');
  const titles = (await project.listProjects(24)).map((s) => s.title);
  const copy = await project.duplicate(project.projectId, titles);
  if (copy) {
    toast(`Kept this version as “${copy.title}”`, {
      label: 'OPEN IT',
      action: () => openFromLibrary(copy.projectId),
    });
  }
};

$('clearBtn').onclick = () => {
  if (recorder.recording) {
    toast('Clearing is locked while capturing — press Stop first');
    return;
  }
  const contents = [];
  const view = loop.composerSnapshot();
  for (let i = 0; i < view.layerCount; i++) {
    const c = loop.layerContent(i);
    if (c) contents.push(c);
  }
  const oldText = textEl.value;
  session.dispatch(EV.CLEAR_ALL, null);
  toast('Cleared everything', {
    label: 'UNDO',
    action: () => {
      for (const c of contents) session.dispatch(EV.RESTORE_LAYER, c);
      textEl.value = oldText;
      recorder.setText(oldText);
      renderAll();
    },
  });
};

// ---------------------------------------------------------------------------
// REPLAY  --  replays the SESSION, not just the typing
// ---------------------------------------------------------------------------
$('replayBtn').onclick = () => (replaying ? stopReplay() : startReplay());

function startReplay() {
  const usingTake = !!recorder.take;
  const log = usingTake ? session.takeEvents() : session.allEvents();
  if (log.length < 2) { toast('Nothing to replay yet'); return; }
  // A scratch history that was trimmed without a usable checkpoint starts
  // mid-performance. Replaying it would apply its events on top of whatever
  // state is current, which is worse than not replaying at all.
  if (!usingTake && !session.canReplayScratch()) {
    toast('History was trimmed without a restore point — press Capture, then Replay the take');
    return;
  }
  if (!transportRunning) startTransport();

  releaseHeldKeys('replay start');
  replaying = true;
  $('replayBtn').textContent = '■ Stop replay';
  sound.allNotesOff();
  eventsBySeq.clear();
  textEl.readOnly = true;
  textEl.value = '';
  // No clearAll() here: the checkpoint below decides what the world looked like
  // when the take opened, including any layers that were already running.

  replayRecent.length = 0;
  replayLastKey = sound.now();

  // ONE reference instant for both the checkpoint restore and the scheduler.
  const startAt = sound.now() + 0.4;
  restoreCheckpoint(log[0] && log[0].data, startAt);

  session.replay(log, {
    startAt,
    onEvent: (ev) => {
      if (ev.type === EV.KEY_DOWN) textEl.value = applyChar(textEl.value, ev.data);
    },
    onDone: () => stopReplay(true),
  });
  toast(`Replaying ${log.length} events — typing and every control change`);
}

function stopReplay(finished) {
  session.stopReplay();
  replaying = false;
  textEl.readOnly = false;
  // A replay that is stopped halfway has notes in flight. They belong to a
  // performance that is no longer happening.
  sound.allNotesOff();
  $('replayBtn').textContent = '▶ Replay';
  $('stopBtn').textContent = transportRunning ? '■ Stop' : '▶ Play';
  toast(finished ? 'Replay finished — the whole set was rebuilt from the log' : 'Replay stopped');
  renderAll();
  textEl.focus();
}

function stopReplayIfRunning() {
  if (replaying) stopReplay();
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
// meters
// ---------------------------------------------------------------------------
let lastBar = -1;
function paint() {
  if (!started) return;
  const t = sound.now();
  let kps;
  let silence;
  if (replaying) {
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
  const vs = sound.voiceStats();
  $('mVoices').textContent = vs.live + '/' + vs.max;

  const phase = loop.barPhase();
  const bar = Math.floor(loop.beatAt(t) / 4);
  if (bar !== lastBar) { lastBar = bar; $('barDot').classList.add('hit'); }
  if (phase > 0.12) $('barDot').classList.remove('hit');

  // "one click back to playing" -- only when focus was lost entirely, so it is
  // not in the way every time somebody touches a slider.
  const lost = document.activeElement === document.body || document.activeElement === null;
  $('focusBack').hidden = !lost || !document.body.classList.contains('playing');

  // cheap; touches the DOM only when the advice would actually change
  renderAdvice();
}

function paintCurrent(ev) {
  const m = mapping[ev.code];
  $('cKey').textContent = (ev.char || ev.code).replace(' ', 'SPACE');
  $('cHand').textContent = ev.hand;
  $('cGroup').textContent = m ? ZONES[m.zone].label + (m.part ? ' / ' + m.part : '') : '—';
  // The phrase is arbitrary user text and is clipped to one line, so the full
  // value lives on the title attribute.
  const phrase = ev.word || '—';
  const cPhrase = $('cPhrase');
  cPhrase.textContent = phrase;
  cPhrase.title = phrase;
  if (composing) renderCompose();
  if (devMode && !$('debug').hidden) paintDebug();
}

// ---------------------------------------------------------------------------
// save state + toasts
// ---------------------------------------------------------------------------
function paintSaveState(state, info) {
  const node = $('saveState');
  if (!node) return;
  node.className = 'savestate ' + state;
  const text = {
    [SAVE_STATE.IDLE]: '',
    [SAVE_STATE.DIRTY]: 'Unsaved',
    [SAVE_STATE.SAVING]: 'Saving…',
    [SAVE_STATE.SAVED]: 'Saved',
    [SAVE_STATE.FAILED]: 'Save failed',
    [SAVE_STATE.UNAVAILABLE]: 'Not saved here',
  }[state] || '';
  node.textContent = text;
  node.title = info && info.message ? info.message : '';
  const bad = state === SAVE_STATE.FAILED || state === SAVE_STATE.UNAVAILABLE;
  $('backupBtn').hidden = !bad;
  if (bad && info && info.message && state === SAVE_STATE.FAILED) {
    toast('Save failed — ' + info.message, { label: 'DOWNLOAD A BACKUP', action: () => downloadProject() }, true);
  }
}

let toastTimer = null;
function toast(msg, action, bad) {
  showToastIn($('toast'), msg, action, bad, (t) => { toastTimer = t; }, toastTimer);
  $('status').textContent = msg;
}

let homeToastTimer = null;
function homeToast(msg, action, bad) {
  showToastIn($('homeToast'), msg, action, bad, (t) => { homeToastTimer = t; }, homeToastTimer);
}

function showToastIn(node, msg, action, bad, setTimer, prevTimer) {
  if (prevTimer) clearTimeout(prevTimer);
  const kids = [el('span', { className: 'toast-msg', text: msg })];
  if (action) {
    kids.push(el('button', {
      className: 'chip', type: 'button', text: action.label,
      onclick: () => { node.hidden = true; action.action(); },
    }));
  }
  setChildren(node, kids);
  node.className = 'toast' + (bad ? ' bad' : '');
  node.hidden = false;
  // An UNDO nobody can reach is not an UNDO, so an actionable toast stays put
  // for long enough to notice, read and click.
  setTimer(setTimeout(() => { node.hidden = true; }, action ? 9000 : 4200));
}

// ---------------------------------------------------------------------------
// developer mode
// ---------------------------------------------------------------------------
function detectDevMode() {
  let flag = false;
  try {
    flag = new URLSearchParams(location.search).get('debug') === '1';
    if (!flag) flag = localStorage.getItem('typing-instrument.dev') === '1';
    if (new URLSearchParams(location.search).get('debug') === '1') localStorage.setItem('typing-instrument.dev', '1');
  } catch (e) {
    /* a blocked localStorage just means the flag does not persist */
  }
  devMode = flag;
  document.body.classList.toggle('devmode', devMode);
  if (devMode) {
    // Internals are exposed ONLY here. In an ordinary session there is no
    // window.__typing at all, so nothing on the page can be poked from a
    // console one-liner or from a bookmarklet somebody was talked into running.
    window.__typing = {
      sound, perf, loop, recorder, session, settings, mapping, project,
      ui: { buildTimeline, renderAll, commitLoop, canCommit, startComposing, stopComposing, applySection },
      get input() { return input; },
      get sections() { return sections; },
    };
  }
}

$('debugBtn').onclick = () => { $('debug').hidden = !$('debug').hidden; paintDebug(); };
$('bootLogBtn').onclick = () => { debugView = 'boot'; $('debug').hidden = false; paintDebug(); };
$('sessionLogBtn').onclick = () => { debugView = 'session'; $('debug').hidden = false; paintDebug(); };

$('testBtn').onclick = () => {
  const report = (results, tag) => {
    const pass = results.filter((r) => r.pass === true).length;
    const fail = results.filter((r) => r.pass === false).length;
    const skip = results.filter((r) => r.pass === null).length;
    toast(`self-test${tag}: ${pass} pass, ${fail} fail${skip ? `, ${skip} pending/skipped` : ''} — see the debug panel`);
    debugView = 'tests';
    lastTests = results;
    $('debug').hidden = false;
    paintDebug();
    console.table(results);
  };
  const results = runSelfTests({
    mapping, settings, recorder, session, loop, perf, sound, project,
    getInput: () => input,
    ui: { buildTimeline, renderAll, commitLoop, canCommit, startComposing, stopComposing },
    // A couple of checks (IndexedDB, reading the shipped modules back off the
    // server) cannot be synchronous. They fill their rows in place and call
    // this when they land, so the report is never quietly incomplete.
    onAsyncDone: (all) => report(all, ' (complete)'),
  });
  report(results, '');
};

let debugView = 'events';
let lastTests = [];

function paintDebug() {
  const node = $('debugBody');
  if (!node || $('debug').hidden) return;

  if (debugView === 'boot') {
    node.textContent = 'BOOT LOG\n\n' + (window.__bootLogText ? window.__bootLogText() : '(none)');
    return;
  }
  if (debugView === 'session') {
    const log = recorder.take ? session.takeEvents() : session.allEvents();
    node.textContent =
      `SESSION LOG (${log.length} events, ${recorder.take ? 'capture take' : 'scratch history'})\n\n` +
      log.slice(-60)
        .map((e) => `${e.time.toFixed(3)}  ${e.type.padEnd(20)} ${e.data ? JSON.stringify(e.data).slice(0, 90) : ''}`)
        .join('\n');
    return;
  }
  if (debugView === 'tests') {
    node.textContent =
      'SELF TESTS\n\n' +
      lastTests
        .map((r) => `${r.pass === true ? 'PASS' : r.pass === false ? 'FAIL' : 'SKIP'}  ${r.name}\n      ${r.detail}`)
        .join('\n\n');
    return;
  }

  const last = recorder.perf.slice(-10);
  const scale = SCALES[settings.soundSet];
  const vs = sound.voiceStats();
  node.textContent =
    `sound ${settings.soundSet} (${scale.name}, root midi ${scale.root}, model ${SOUND_SETS[settings.soundSet].model})  ` +
    `bpm ${settings.bpm}  beat ${loop.beatAt(sound.now()).toFixed(2)}  quantize ${settings.quantize}  cx ${settings.complexity}\n` +
    `raw ${recorder.raw.length}  performance ${recorder.perf.length}  session ${session.events.length}  ` +
    `voices ${vs.live}/${vs.max} (gated ${vs.gated}, stolen ${vs.stolen})  project ${PROJECT_FORMAT_VERSION}/${FORMAT_VERSION}\n\n` +
    last
      .map(
        (e) =>
          `${e.time.toFixed(3)}  ${String(e.sourceKey).padEnd(6)} ${String(e.instrument).padEnd(8)}` +
          ` ${String(e.part || e.note).padEnd(7)} vel ${String(e.velocity).padEnd(4)} dur ${String(e.duration).padEnd(6)}` +
          ` ${e.tag}`
      )
      .join('\n');
}
setInterval(() => { if (devMode && !$('debug').hidden && debugView === 'events') paintDebug(); }, 400);

// ---------------------------------------------------------------------------
// Everything is wired. Only now do the entry points become clickable -- which
// is what makes it impossible to lose the first click.
// ---------------------------------------------------------------------------
detectDevMode();
buildSoundPicker();

$('newBtn').addEventListener('click', startNewPiece);
mark('M03', 'HANDLER_ATTACHED');

window.__typingReady = true;

$('newBtn').disabled = false;
$('newBtn').textContent = 'NEW PIECE';
$('openFileBtn').disabled = false;

refreshLibrary()
  .then(() => {
    try {
      $('continueBtn').hidden ? $('newBtn').focus({ preventScroll: true }) : $('continueBtn').focus({ preventScroll: true });
    } catch (e) {
      /* focus is a courtesy, not a requirement */
    }
  })
  .catch(() => {});

mark('M04', 'MODULE_READY');
