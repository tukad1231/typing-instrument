// ---------------------------------------------------------------------------
// SESSION ENGINE  --  one timeline, one code path.
//
// Every user action goes through `dispatch()`, which appends the event and then
// applies it. Replay calls the SAME handlers with the SAME data, minus the
// logging.
//
// -- TWO BUFFERS (v0.2.2) --------------------------------------------------
// v0.2.1 kept a single ring buffer and merely deferred trimming while a take
// was open. The moment STOP arrived, the ring caught up and ate the head of the
// take: a 45,000-event take came back as 39,998. Takes now live in their OWN
// buffer, which is never trimmed and is not affected by anything typed after
// STOP. The scratch ring is separate and keeps only recent history.
//
// -- WHAT THIS LAYER GUARANTEES --------------------------------------------
//   Level 1 -- same session log  =>  same performance events.  GUARANTEED.
//   Level 2 -- same performance events  =>  audibly the same music.
//              BEST EFFORT: the sound engine carries state that is not part of
//              any performance event.
//   Level 3 -- bit-identical audio samples. NOT claimed.
// ---------------------------------------------------------------------------

import { round3 } from '../core/hash.js';
import { EV, NON_REPLAYED } from './sessionEvents.js';

const MAX_EVENTS = 40000; // scratch-history cap
const MAX_TAKE_EVENTS = 120000; // a take warns (and the app stops) at this size
const TRIM_KEEP = 0.75; // how much of the scratch ring survives a trim
const HARD_CEILING = 3; // × maxEvents: when no checkpoint can be made at all

export class SessionEngine {
  /**
   * @param {object} opts
   * @param {() => number} opts.now  session clock in seconds
   * @param {(info) => void} [opts.onTakeOverflow] fired once when a take grows
   *        past MAX_TAKE_EVENTS. Nothing is dropped; the app is expected to stop.
   * @param {() => object} [opts.onScratchCheckpoint] returns the full engine
   *        state so a trimmed scratch history still begins with something
   *        replayable. Must NOT dispatch.
   */
  constructor({ now, onTakeOverflow, onScratchCheckpoint, maxEvents, trimKeep }) {
    this.now = now;
    this.onTakeOverflow = onTakeOverflow || (() => {});
    this.onScratchCheckpoint = onScratchCheckpoint || null;

    // Overridable so tests can exercise trimming with tens of events instead of
    // tens of thousands. Production values are the defaults.
    this.maxEvents = maxEvents || MAX_EVENTS;
    this.keep = Math.floor(this.maxEvents * (trimKeep || TRIM_KEEP));
    this.checkpointStep = Math.max(1, this.maxEvents - this.keep);

    this.events = []; // scratch history (trimmed)
    this.takeLog = []; // RECORD..STOP (never trimmed)
    this.take = null;
    this.recordingFlag = false;

    // Rolling checkpoints, each captured BEFORE a known event was applied.
    // See _trim() for why the timing matters.
    this.checkpoints = [];
    this._sinceCheckpoint = Infinity; // force one at the very first dispatch
    this.scratchIncomplete = false;

    this.handlers = {};
    this.replaying = false;
    this.nextId = 0;
    this._trimming = false;
  }

  on(type, fn) {
    this.handlers[type] = fn;
    return this;
  }

  /**
   * @param {string} type
   * @param {object|null} data
   * @param {number} [atTime] exact event time. Key events pass the timestamp
   *   captured at the keystroke rather than "whenever dispatch ran", so a
   *   re-simulation lands on exactly the same times as the live run.
   */
  dispatch(type, data, atTime) {
    const ev = {
      i: this.nextId++,
      time: round3(atTime === undefined ? this.now() : atTime),
      type,
      data: data === undefined ? null : data,
    };
    // Capture BEFORE the event is applied, so the checkpoint means "the state
    // from which this event and everything after it still has to happen".
    this._maybeCheckpoint(ev);
    this.events.push(ev);
    if (this.recordingFlag) this._pushTake(ev);
    this._trim();
    this.apply(ev);
    return ev;
  }

  /**
   * Take a checkpoint every `checkpointStep` events, keeping enough of them to
   * cover the whole scratch window. Each one records the id and time of the
   * event that was about to be applied, which is what makes it usable as a
   * replay head later.
   */
  _maybeCheckpoint(ev) {
    if (!this.onScratchCheckpoint) return;
    if (this._sinceCheckpoint < this.checkpointStep) {
      this._sinceCheckpoint++;
      return;
    }
    let data = null;
    try {
      data = this.onScratchCheckpoint();
    } catch (e) {
      return; // a broken checkpoint must not take the session down
    }
    if (data === null || data === undefined) return; // not ready yet (pre-boot)
    this._sinceCheckpoint = 1;
    this.checkpoints.push({ id: ev.i, time: ev.time, data });
    // enough to cover maxEvents worth of history, plus one
    const maxKept = Math.ceil(this.maxEvents / this.checkpointStep) + 1;
    while (this.checkpoints.length > maxKept) this.checkpoints.shift();
  }

  /** Replay path: make it happen, without recording it again. */
  apply(ev) {
    const h = this.handlers[ev.type];
    if (h) h(ev.data, ev);
  }

  _pushTake(ev) {
    this.takeLog.push(ev);
    if (this.takeLog.length >= MAX_TAKE_EVENTS && this.take && !this.take.overflowed) {
      this.take.overflowed = true;
      const info = { events: this.takeLog.length, limit: MAX_TAKE_EVENTS };
      // deferred: the callback stops the take, which dispatches RECORD_STOP,
      // and re-entering dispatch from inside dispatch is asking for trouble
      setTimeout(() => this.onTakeOverflow(info), 0);
    }
  }

  // -------------------------------------------------------------------------
  // Scratch ring.
  //
  // THE CAUSALITY RULE
  //   A checkpoint C was captured immediately before event C.id was applied.
  //   Therefore:
  //
  //       state(C.data)  +  apply(every event with id >= C.id)  ==  state(now)
  //
  //   so a trimmed history must be  [C]  followed by exactly those events, and
  //   nothing else.
  //
  // v0.2.2 broke that rule: it asked for the CURRENT state at trim time and
  // filed it under the timestamp of an event ~30,000 back, then kept those
  // 30,000 events after it. Replaying applied them a second time on top of a
  // state that already contained them. Measured on a counter: live 40,001,
  // replay 70,000.
  //
  // The fix is not to move a checkpoint, it is to already HAVE one from the
  // right moment. `_maybeCheckpoint` records them as we go, and the trim picks
  // the newest one that still leaves at least `keep` events after it.
  //
  // Note on `i`: it is informational only. Takes are delimited by their own
  // buffer, so reusing an id on the synthetic head is harmless.
  // -------------------------------------------------------------------------
  _trim() {
    if (this.events.length <= this.maxEvents || this._trimming) return;
    this._trimming = true;
    try {
      // newest checkpoint that still leaves >= keep events after it
      let chosen = null;
      for (const c of this.checkpoints) {
        const survivorCount = this.events.length - this._indexOfId(c.id);
        if (survivorCount >= this.keep) chosen = c;
        else break; // checkpoints are ordered, so later ones only keep fewer
      }

      if (!chosen) {
        // No usable checkpoint (no provider, it returned null, or it threw).
        //
        // Dropping events here would be the worst outcome: the history would
        // start mid-performance with nothing to start it from. As long as the
        // log is still WHOLE it needs no head at all -- replaying it from the
        // engines' default state is exactly right, because that is where the
        // session began. So we keep it and try again on the next dispatch.
        //
        // The safety valve is a hard ceiling: if the provider stays broken the
        // buffer cannot grow forever, and past that point the history is
        // truncated and marked unreplayable rather than replayed wrongly.
        if (this.events.length > this.maxEvents * HARD_CEILING) {
          this.events = this.events.slice(this.events.length - this.keep);
          this.scratchIncomplete = true;
        }
        return;
      }

      const cut = this._indexOfId(chosen.id);
      const survivors = this.events.slice(cut);
      // If a previous trim already put this exact head at the cut, keep it
      // rather than stacking a second identical SESSION_START.
      if (survivors.length && survivors[0].type === EV.SESSION_START && survivors[0].i === chosen.id) {
        this.events = survivors;
      } else {
        this.events = [{ i: chosen.id, time: chosen.time, type: EV.SESSION_START, data: chosen.data }, ...survivors];
      }
      // checkpoints older than the one we used can never be needed again
      this.checkpoints = this.checkpoints.filter((c) => c.id >= chosen.id);
      // the history once again begins with something replayable
      this.scratchIncomplete = false;
    } finally {
      this._trimming = false;
    }
  }

  /** index of the first event with id >= wanted (events are id-ordered) */
  _indexOfId(wanted) {
    let lo = 0;
    let hi = this.events.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.events[mid].i < wanted) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  // -------------------------------------------------------------------------
  // Take Recorder: RECORD .. STOP, in its own buffer.
  // -------------------------------------------------------------------------
  beginTake(data = null) {
    this.takeLog = []; // a new take replaces the previous one
    this.take = { startTime: this.now(), endTime: null, overflowed: false };
    this.recordingFlag = true;
    this.dispatch(EV.RECORD_START, data);
    return this.take;
  }

  endTake() {
    if (!this.take || !this.recordingFlag) return null;
    this.dispatch(EV.RECORD_STOP, null);
    this.recordingFlag = false;
    this.take.endTime = this.now();
    return this.take;
  }

  get recording() {
    return this.recordingFlag;
  }

  /** the take's events, rebased so the take starts at t=0 */
  takeEvents() {
    if (!this.take) return [];
    const t0 = this.take.startTime;
    return this.takeLog.map((e) => ({ time: round3(e.time - t0), type: e.type, data: e.data }));
  }

  takeWindow() {
    if (!this.take) return null;
    return { start: this.take.startTime, end: this.take.endTime === null ? this.now() : this.take.endTime };
  }

  /** whole scratch history, rebased to its own first event */
  allEvents() {
    if (!this.events.length) return [];
    const t0 = this.events[0].time;
    return this.events.map((e) => ({ time: round3(e.time - t0), type: e.type, data: e.data }));
  }

  /**
   * Wipe the session. EVERY piece of rolling state has to go, not just the
   * event arrays: a checkpoint captured before the reset describes a world that
   * no longer exists, and re-using it as a replay head splices the old state
   * onto the new history. Measured before this fix: live 41, replay 91, with
   * the head still carrying the pre-reset counter of 50.
   *
   * `nextId` is deliberately NOT reset, so an id can never belong to both the
   * old and the new history.
   */
  reset() {
    this.events = [];
    this.takeLog = [];
    this.take = null;
    this.recordingFlag = false;
    this.checkpoints = [];
    this._sinceCheckpoint = Infinity; // capture again on the very next dispatch
    this._trimming = false;
    this.scratchIncomplete = false;
  }

  /**
   * False once the scratch history has been trimmed without a usable
   * checkpoint. Such a history starts mid-performance, so replaying it would
   * apply its events on top of whatever state happens to be current -- a
   * corrupt result. The UI refuses to replay it rather than play it wrongly.
   */
  canReplayScratch() {
    return !this.scratchIncomplete;
  }

  // -------------------------------------------------------------------------
  // REPLAY
  // -------------------------------------------------------------------------
  /**
   * @param {object} opts
   * @param {number} [opts.startAt] absolute session time the log's t=0 lands on.
   *   The caller passes this so that restoring the checkpoint and starting the
   *   replay share ONE reference instant. Reading the clock twice put the two
   *   a few milliseconds apart, which was enough for a keystroke sitting on a
   *   1/16 boundary to be quantised to the other side.
   */
  replay(log, { leadIn = 0.4, startAt, onEvent = () => {}, onDone = () => {}, tail = 1.5 } = {}) {
    if (!log.length) {
      onDone();
      return () => {};
    }
    this.replaying = true;
    const base = startAt === undefined ? this.now() + leadIn : startAt;
    const offset = base - log[0].time;
    let i = 0;
    let stopped = false;

    const stop = () => {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      this.replaying = false;
      this._stopReplay = null;
      onDone();
    };

    const timer = setInterval(() => {
      if (stopped) return;
      const now = this.now();
      while (i < log.length && log[i].time + offset <= now + 0.12) {
        const src = log[i++];
        if (!NON_REPLAYED.has(src.type)) {
          this.apply({ time: src.time + offset, type: src.type, data: src.data });
        }
        onEvent(src, src.time + offset);
      }
      if (i >= log.length && now > log[log.length - 1].time + offset + tail) stop();
    }, 20);

    this._stopReplay = stop;
    return stop;
  }

  stopReplay() {
    if (this._stopReplay) this._stopReplay();
  }
}

export { EV, MAX_EVENTS, MAX_TAKE_EVENTS };
