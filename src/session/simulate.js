// ---------------------------------------------------------------------------
// HEADLESS SESSION SIMULATION
//
// Runs a session event log through the real PerformanceEngine and the real
// LoopEngine with a stub sound card, as fast as the CPU allows. Two purposes:
//
//   1. the Level-1 determinism test -- same log twice, same result;
//   2. proving that settings changes mid-take are part of the document, which
//      is exactly what v0.1 could not reproduce.
//
// HOW FAITHFUL IS IT? It reuses the production PerformanceEngine and the
// production LoopEngine, so note selection, expression, quantisation, the beat
// grid and layer commits are the real implementations. It is NOT the same code
// path as the live app: there is no SoundEngine, no scheduler tick, no UI, and
// the transport is driven by event timestamps instead of an audio clock. So it
// verifies Level 1 (the performance), and says nothing about Level 2 (the
// sound). Treating it as proof of audible equality would be wrong.
// ---------------------------------------------------------------------------

import { PerformanceEngine, applyHold, DEFAULT_SETTINGS } from '../perf/performanceEngine.js';
import { LoopEngine } from '../loop/loopEngine.js';
import { SCALES } from '../perf/scale.js';
import { EV } from './sessionEvents.js';

/** A sound card that makes no sound and consumes no time. */
export class StubSound {
  constructor() {
    this.t = 0;
    this.played = [];
  }
  now() {
    return this.t;
  }
  createBus() {
    return { gain: { value: 1, setTargetAtTime() {} } };
  }
  play(ev, when, bus, scope) {
    this.played.push({ when, scope, sourceSeq: ev.sourceSeq, note: ev.note, instrument: ev.instrument, tag: ev.tag });
  }
  release() {}
  releaseAll() {}
}

/**
 * @param {object[]} log      session events, `time` in seconds
 * @param {object} mapping
 * @param {object} settings0  settings at the start of the log
 * @returns {{settings: object, layers: object[], perf: object[], transport: object}}
 */
export function simulateSession(log, mapping, settings0, opts = {}) {
  const settings = Object.assign({}, DEFAULT_SETTINGS, settings0);
  const sound = new StubSound();
  const perf = new PerformanceEngine(mapping, settings);
  const loop = new LoopEngine(sound, { bpm: settings.bpm, quantize: settings.quantize });
  loop.init();
  loop.stop(); // no wall-clock scheduling in a simulation

  const out = [];
  let restored = false;
  // Lets a test grab the engine state mid-run, exactly as pressing RECORD does.
  const captureAt = opts.captureAt;
  let captured = null;

  for (const e of log) {
    sound.t = e.time;
    if (captureAt !== undefined && captured === null && e.time >= captureAt) {
      captured = {
        settings: { ...settings },
        beatAtStart: +loop.beatAt(e.time).toFixed(6),
        performanceState: perf.exportState(),
        loopState: loop.exportState(),
      };
    }
    const d = e.data || {};

    switch (e.type) {
      // Restore the opening checkpoint: settings, the bar phase, AND the
      // engine state the take inherited from whatever was played before it.
      // Only the FIRST one counts -- a scratch history can contain several
      // RECORD_STARTs, and those are markers, not restore points.
      case EV.RECORD_START:
      case EV.SESSION_START: {
        if (restored) break;
        restored = true;
        if (d && d.settings) {
          Object.assign(settings, d.settings);
          perf.setSettings(d.settings);
          if (d.settings.bpm) loop.bpm = d.settings.bpm;
          if (d.settings.quantize) loop.setQuantize(d.settings.quantize);
        }
        if (d && d.performanceState) perf.importState(d.performanceState);
        if (d && d.loopState) {
          loop.importState(d.loopState, e.time);
        } else {
          // v0.2 log: no engine state, so start from the defaults it assumed
          loop.setOrigin(e.time, d && d.beatAtStart !== undefined ? d.beatAtStart : 0);
        }
        break;
      }

      case EV.KEY_DOWN: {
        const raw = Object.assign({}, d, { timestamp: e.time });
        const res = perf.processDown(raw);
        // holdMs is normally still null here -- the key has not been released
        // yet. It is applied on KEY_UP below, exactly as the live app does.
        applyHold(res.events, raw.holdMs);
        for (const ev of res.events) out.push(ev);
        loop.collect(res.events, raw.char);
        if (res.signal === 'phrase') loop.closePhrase(raw.timestamp);
        else if (res.signal === 'layer') loop.commitLayer();
        break;
      }
      case EV.KEY_UP: {
        // The note's length is decided here, and it must reach every copy of
        // the note -- including one already committed into a layer while the
        // key was still down.
        loop.applyHoldBySeq(d.seq, d.holdMs);
        if (d.holdMs !== null && d.holdMs !== undefined) {
          const dur = Math.round(Math.max(d.holdMs / 1000, 0.08) * 1000) / 1000;
          for (const ev of out) if (ev.gated && ev.sourceSeq === d.seq) ev.duration = dur;
        }
        break;
      }

      case EV.SET_SOUND:
        settings.soundSet = d.value;
        perf.setSettings({ soundSet: d.value });
        break;
      case EV.SET_BPM:
        settings.bpm = d.value;
        perf.setSettings({ bpm: d.value });
        loop.setBpm(d.value);
        break;
      case EV.SET_COMPLEXITY:
        settings.complexity = d.value;
        perf.setSettings({ complexity: d.value });
        break;
      case EV.SET_QUANTIZE:
        settings.quantize = d.value;
        loop.setQuantize(d.value);
        break;
      case EV.SET_MASTER_VOLUME:
        settings.masterVolume = d.value;
        break;

      case EV.ADD_BUILTIN_LOOP:
        loop.addBuiltin(d.loop, SCALES[settings.soundSet] || SCALES.electronic);
        break;
      case EV.CLEAR_LAYER:
        loop.clearLayer(d.layer);
        break;
      // v4. A command carrying its own content, which is what makes undoing a
      // delete replay identically. Absent from v2/v3 logs, and the `default`
      // arm below means an unknown type is skipped rather than fatal -- so a
      // v4 log opened by an older build degrades instead of breaking.
      case EV.RESTORE_LAYER:
        loop.restoreLayer(d);
        break;
      case EV.CLEAR_ALL:
        loop.clearAll();
        perf.reset();
        break;
      case EV.LAYER_ON:
        loop.setLayer(d.layer, { on: d.value, muted: false });
        break;
      case EV.LAYER_MUTE:
        loop.setLayer(d.layer, { muted: d.value });
        break;
      case EV.LAYER_VOLUME:
        loop.setLayer(d.layer, { volume: d.value });
        break;
      default:
        break; // markers and derived events
    }
  }

  return {
    settings: {
      soundSet: settings.soundSet,
      bpm: settings.bpm,
      complexity: settings.complexity,
      quantize: settings.quantize,
      masterVolume: settings.masterVolume,
    },
    layers: loop.snapshot(),
    layerEvents: loop.layers.map((l) => l.events.map((x) => [x.b, x.ev.instrument, x.ev.note, x.ev.velocity, x.ev.tag])),
    perf: out,
    performanceState: perf.exportState(),
    // A silent, importable cache derived from the canonical log. The caller
    // supplies its own current AudioContext time when importing it.
    loopState: loop.exportState(),
    checkpoint: captured,
    transport: {
      bpm: loop.bpm,
      playingBpm: loop.playingBpm,
      segments: loop.tempoSegments.map((s) => [+s.startBeat.toFixed(6), s.bpm]),
    },
  };
}
