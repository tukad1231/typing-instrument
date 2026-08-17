// ---------------------------------------------------------------------------
// PERFORM KEY  --  the one path a keystroke takes, extracted.
//
// This used to live inside main.js, which meant the only way to exercise it was
// to drive the real application: real session log, real recorder, real DOM. A
// self-test written that way is not a test of the code, it is a test performed
// ON the user's work, and no amount of careful save-and-restore makes that
// safe (see selfTest 15's history).
//
// So the musical path takes its world as an argument. Production passes the
// live engines; the test fixture passes its own. Both run THIS function, so
// what the test proves is what actually ships.
// ---------------------------------------------------------------------------

import { applyHold } from './performanceEngine.js';

/**
 * @param {object} raw RawTypingEvent
 * @param {object} w   the world this key is played into
 * @param {import('./performanceEngine.js').PerformanceEngine} w.perf
 * @param {import('../loop/loopEngine.js').LoopEngine} w.loop
 * @param {object} w.sound        anything with play()
 * @param {object} [w.recorder]
 * @param {Map} [w.eventsBySeq]
 * @param {boolean} w.replaying   true while a log is being re-applied
 * @param {(result) => void} [w.onLayer]  a layer commit finished (or failed)
 * @returns {{events: object[], signal: string|null, commit: object|null}}
 */
export function performKey(raw, w) {
  const res = w.perf.processDown(raw);
  applyHold(res.events, raw.holdMs);

  for (const ev of res.events) w.sound.play(ev, ev.time, null, 'live');
  if (res.events.length && w.eventsBySeq) w.eventsBySeq.set(raw.seq, res.events);

  w.loop.collect(res.events, raw.char);
  if (!w.replaying && w.recorder) w.recorder.addPerf(res.events);

  let commit = null;
  if (res.signal === 'phrase') {
    w.loop.closePhrase(raw.timestamp);
  } else if (res.signal === 'layer') {
    const r = w.loop.commitLayer();
    commit = { seq: raw.seq, error: !r || !!r.error, layer: r && r.layer, bars: r && r.bars, raw: r };
    if (w.onLayer) w.onLayer(commit);
  }
  return { events: res.events, signal: res.signal, commit };
}
