// ---------------------------------------------------------------------------
// LOOP ENGINE  --  phrases, layers, and the beat grid.
//
//     Space  -> close the current PHRASE   (a word is a musical unit)
//     Enter  -> commit the pending phrases into a LAYER, which loops forever
//
// The loop's canonical position is MUSICAL, not wall-clock: layer length,
// anchor and every note inside a layer are stored in BEATS, and seconds are
// derived at playback time.
//
// -- THE TEMPO MAP (rewritten in v0.2.2) -----------------------------------
// Tempo lives in an ordered list of SEGMENTS:
//
//     [{ startBeat, startSec, bpm }, ...]
//
// A tempo change does NOT take effect "now". It takes effect at the end of
// whatever has already been handed to Web Audio, i.e. at
// max(nowBeat, scheduledUpToBeat). That single rule is what keeps the schedule
// monotonic: v0.2.1 re-derived future seconds from a tempo anchored at the
// current instant, so a beat scheduled at 0.145 s under 120 bpm could be
// followed by a later beat landing at 0.1025 s under 240 bpm -- the later note
// played first. Anchoring the new segment to the boundary the scheduler has
// already reached makes that impossible, and it also removes the ~80 ms hole
// that appeared when slowing down (120 -> 70).
//
// `this.bpm` is the tempo the USER has selected, shown in the UI immediately.
// The tempo actually playing is whatever segment covers the beat being
// scheduled, which may still be the previous one for up to one lookahead.
// ---------------------------------------------------------------------------

import { clamp, round3 } from '../core/hash.js';
import { buildLoop } from './builtinLoops.js';

const LAYER_COUNT = 4;
const LOOKAHEAD = 0.15; // seconds scheduled in advance
const TICK_MS = 25;
const BEATS_PER_BAR = 4;
const MAX_BARS = 8;
const EPS = 1e-9;

const clone = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));

export class LoopEngine {
  /**
   * @param {import('../sound/soundEngine.js').SoundEngine} sound
   */
  constructor(sound, opts = {}) {
    this.sound = sound;
    this.bpm = opts.bpm || 120; // the tempo the user selected
    this.quantize = opts.quantize || 'LIGHT';
    this.layers = [];
    this.pending = []; // {b, ev} waiting for Enter
    this.phrases = [];
    this.openPhrase = { events: [], text: '', start: null };
    this.onChange = opts.onChange || (() => {});
    this.timer = null;
    this._space = 0;

    this.tempoSegments = [{ startBeat: 0, startSec: 0, bpm: this.bpm }];

    // The scheduler cursor is a BEAT, not a wall-clock time, so it can never
    // revisit a region already handed to Web Audio.
    this.scheduledUpToBeat = 0;
  }

  // --- tempo map ------------------------------------------------------------
  _segAtSec(sec) {
    const s = this.tempoSegments;
    let i = s.length - 1;
    while (i > 0 && s[i].startSec > sec) i--;
    return s[i];
  }
  _segAtBeat(beat) {
    const s = this.tempoSegments;
    let i = s.length - 1;
    while (i > 0 && s[i].startBeat > beat) i--;
    return s[i];
  }
  beatAt(sec) {
    const g = this._segAtSec(sec);
    return g.startBeat + (sec - g.startSec) * (g.bpm / 60);
  }
  secAt(beat) {
    const g = this._segAtBeat(beat);
    return g.startSec + (beat - g.startBeat) * (60 / g.bpm);
  }
  /** the tempo actually in force right now (not necessarily the selected one) */
  get playingBpm() {
    return this._segAtSec(this.sound.now()).bpm;
  }
  get barSec() {
    return (60 / this.playingBpm) * BEATS_PER_BAR;
  }
  get transportStart() {
    return this.secAt(0);
  }

  init() {
    this.layers = [];
    for (let i = 0; i < LAYER_COUNT; i++) {
      this.layers.push(this._blankLayer(i, this.sound.createBus(1)));
    }
    this.setOrigin(this.sound.now(), 0);
    this.start();
  }

  _blankLayer(id, bus) {
    return {
      id,
      kind: null,
      name: '',
      builtinKey: null,
      events: [], // {b: beats from the layer anchor, ev}
      lengthBeats: 0,
      anchorBeat: 0,
      on: true,
      muted: false,
      volume: 1,
      phraseCount: 0,
      // Bumped every time a layer's content is replaced. It rides in the voice
      // scope so a release timer left over from the previous content can never
      // cut short a note belonging to the new content.
      generation: 0,
      bus,
    };
  }

  /**
   * Relocate the transport: collapse the tempo map to one segment starting
   * here, and resynchronise the scheduler cursor with it. Anything that moves
   * the transport (boot, replay, checkpoint restore) must go through this,
   * otherwise the beat cursor points into a different timeline and the loops
   * go silent (cursor far ahead) or stutter (cursor far behind).
   */
  setOrigin(sec, beat, bpm) {
    if (bpm) this.bpm = bpm;
    this.tempoSegments = [{ startBeat: beat, startSec: sec, bpm: this.bpm }];
    this.scheduledUpToBeat = this.beatAt(this.sound.now());
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this._tick(), TICK_MS);
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * Open a new tempo segment at the end of what is already scheduled.
   * Dragging the slider replaces the pending segment instead of stacking one
   * per pixel.
   */
  setBpm(bpm) {
    if (!bpm) return;
    this.bpm = bpm; // the UI may show this immediately
    const now = this.sound.now();
    const effectiveBeat = Math.max(this.beatAt(now), this.scheduledUpToBeat);
    const effectiveSec = this.secAt(effectiveBeat);

    // discard future segments that have not taken effect yet
    while (
      this.tempoSegments.length > 1 &&
      this.tempoSegments[this.tempoSegments.length - 1].startBeat >= effectiveBeat - EPS
    ) {
      this.tempoSegments.pop();
    }

    const last = this.tempoSegments[this.tempoSegments.length - 1];
    if (last && Math.abs(last.startBeat - effectiveBeat) < EPS) {
      last.bpm = bpm; // same boundary: retune in place
    } else if (!last || last.bpm !== bpm) {
      this.tempoSegments.push({ startBeat: effectiveBeat, startSec: effectiveSec, bpm });
    }
    this._pruneSegments(now);
  }

  /** keep the segment covering `now` plus everything after it */
  _pruneSegments(now) {
    const s = this.tempoSegments;
    let i = s.length - 1;
    while (i > 0 && s[i].startSec > now) i--;
    if (i > 0) this.tempoSegments = s.slice(i);
  }

  setQuantize(q) {
    this.quantize = q;
  }

  /** where we are inside the current bar, 0..1 -- used for the UI pulse */
  barPhase() {
    const b = this.beatAt(this.sound.now());
    return ((((b % BEATS_PER_BAR) + BEATS_PER_BAR) % BEATS_PER_BAR) / BEATS_PER_BAR);
  }

  // -------------------------------------------------------------------------
  // collecting what the player is doing
  // -------------------------------------------------------------------------
  collect(events, char) {
    for (const e of events) this.pending.push({ b: this.beatAt(e.time), ev: e });
    if (this.openPhrase.start === null && events.length) this.openPhrase.start = events[0].time;
    for (const e of events) this.openPhrase.events.push(e);
    if (char && char !== '\n' && char !== '\b') this.openPhrase.text += char;
  }

  /**
   * R1, applied by key identity rather than by object reference: a keyup must
   * reach every copy of the note, including one already committed into a layer
   * while the key was still down.
   * @returns {number} how many notes were updated
   */
  applyHoldBySeq(seq, holdMs) {
    if (holdMs === null || holdMs === undefined) return 0;
    const dur = round3(Math.max(holdMs / 1000, 0.08));
    const seen = new Set();
    let n = 0;
    const fix = (ev) => {
      if (seen.has(ev)) return;
      seen.add(ev);
      if (ev.gated && ev.sourceSeq === seq && ev.duration !== dur) {
        ev.duration = dur;
        n++;
      }
    };
    for (const p of this.pending) fix(p.ev);
    for (const e of this.openPhrase.events) fix(e);
    for (const l of this.layers) for (const item of l.events) fix(item.ev);
    return n;
  }

  /** Space pressed: freeze the word we just typed as a phrase. */
  closePhrase(time) {
    const p = this.openPhrase;
    if (!p.events.length) {
      this.openPhrase = { events: [], text: '', start: null };
      return null;
    }
    const phrase = {
      index: this.phrases.length,
      text: p.text.trim(),
      start: p.start,
      end: time,
      duration: round3(time - p.start),
      events: p.events,
    };
    this.phrases.push(phrase);
    this.openPhrase = { events: [], text: '', start: null };
    this.onChange();
    return phrase;
  }

  // -------------------------------------------------------------------------
  // Enter -> commit a layer
  // -------------------------------------------------------------------------
  commitLayer() {
    const items = this.pending.filter((p) => p.ev.tag !== 'layer-commit');
    if (!items.length) return null;
    const target = this._freeLayer();
    if (target === null) return { error: 'no free layer' };

    const anchorBeat = Math.floor(items[0].b / BEATS_PER_BAR) * BEATS_PER_BAR;

    let maxRel = 0;
    const rel = items.map((p) => {
      const b = this._quantizeBeats(p.b - anchorBeat);
      maxRel = Math.max(maxRel, b);
      return { b: round3(b), ev: Object.assign({}, p.ev) };
    });

    const bars = clamp(Math.ceil((maxRel + 0.05) / BEATS_PER_BAR), 1, MAX_BARS);
    const layer = this.layers[target];
    this.sound.releaseAll(this._scopePrefix(layer));
    layer.generation++;
    layer.kind = 'typing';
    layer.name = this._layerName();
    layer.builtinKey = null;
    layer.events = rel.sort((a, b) => a.b - b.b);
    layer.lengthBeats = bars * BEATS_PER_BAR;
    layer.anchorBeat = anchorBeat;
    layer.on = true;
    layer.muted = false;
    layer.volume = 1;
    layer.phraseCount = this.phrases.length + (this.openPhrase.events.length ? 1 : 0);
    this._applyGain(layer);

    this.pending = [];
    this.phrases = [];
    this.openPhrase = { events: [], text: '', start: null };
    this.onChange();
    return { layer: target, bars };
  }

  addBuiltin(key, scale) {
    const target = this._freeLayer();
    if (target === null) return { error: 'no free layer' };
    const built = buildLoop(key, scale);
    const nowBeat = this.beatAt(this.sound.now());
    const layer = this.layers[target];
    this.sound.releaseAll(this._scopePrefix(layer));
    layer.generation++;
    layer.kind = 'builtin';
    layer.name = built.name;
    layer.builtinKey = key;
    layer.events = built.events;
    layer.lengthBeats = built.lengthBeats;
    layer.anchorBeat = Math.ceil(nowBeat / BEATS_PER_BAR) * BEATS_PER_BAR; // next bar line
    layer.on = true;
    layer.muted = false;
    layer.volume = 1;
    layer.phraseCount = 0;
    this._applyGain(layer);
    this.onChange();
    return { layer: target };
  }

  clearLayer(i) {
    const l = this.layers[i];
    if (!l) return;
    this.sound.releaseAll(this._scopePrefix(l));
    l.generation++;
    l.kind = null;
    l.name = '';
    l.builtinKey = null;
    l.events = [];
    l.lengthBeats = 0;
    l.phraseCount = 0;
    this.onChange();
  }

  clearAll() {
    for (let i = 0; i < this.layers.length; i++) this.clearLayer(i);
    this.pending = [];
    this.phrases = [];
    this.openPhrase = { events: [], text: '', start: null };
  }

  setLayer(i, patch) {
    const l = this.layers[i];
    if (!l) return;
    Object.assign(l, patch);
    this._applyGain(l);
    this.onChange();
  }

  _scopePrefix(l) {
    return 'L' + l.id + 'g' + l.generation;
  }

  _applyGain(l) {
    const g = l.on && !l.muted ? l.volume * (1 + this._space * 0.28) : 0;
    l.bus.gain.setTargetAtTime(g, this.sound.now(), 0.02);
  }

  /** pause macro: when the typist stops, the existing loops step forward */
  setSpaceMacro(v) {
    this._space = v;
    for (const l of this.layers) {
      if (!l.events.length) continue;
      const g = l.on && !l.muted ? l.volume * (1 + v * 0.28) : 0;
      l.bus.gain.setTargetAtTime(g, this.sound.now(), 0.35);
    }
  }

  // -------------------------------------------------------------------------
  // CHECKPOINT  --  everything a replay needs to start from here
  // -------------------------------------------------------------------------
  /**
   * A JSON-safe snapshot. Deliberately excludes AudioNodes, buses and timers:
   * those belong to whichever SoundEngine is alive when the state is restored.
   * The transport is captured as a BEAT plus the tempo in force, never as an
   * audio-clock second, because seconds are meaningless in another session.
   */
  exportState() {
    const now = this.sound.now();
    const beatNow = this.beatAt(now);
    return {
      bpm: this.bpm,
      playingBpm: this.playingBpm,
      quantize: this.quantize,
      // NOT rounded: this is the anchor the whole tempo map hangs off.
      beatAtCheckpoint: beatNow,

      // The tempo map, INCLUDING segments that have not taken effect yet.
      // A tempo change is queued at the end of the lookahead, so at any moment
      // there can be a future segment that is already part of the performance.
      //
      // ONE canonical axis only: beats relative to the checkpoint, plus the bpm.
      // Seconds are RECONSTRUCTED on import by chaining through the bpms, which
      // makes the continuity condition
      //     startBeat[i+1] = startBeat[i] + (startSec[i+1]-startSec[i]) * bpm[i]/60
      // true by construction. Storing both axes and rounding them independently
      // (v0.2.2 RC2) let the two disagree: with 120->70->170 the third boundary
      // came out 0.000333 beats BEHIND the instant before it, so beatAt() went
      // backwards across it.
      //
      // Nothing here is rounded, and no absolute audio-clock second is stored:
      // those are meaningless in another AudioContext.
      tempoSegments: this.tempoSegments.map((s) => ({
        dBeat: s.startBeat - beatNow,
        bpm: s.bpm,
      })),

      // Diagnostic ONLY. This is where the OLD SoundEngine had already queued
      // AudioNodes. Those nodes do not travel with the checkpoint, so restoring
      // this as the new engine's cursor would mark notes as "already scheduled"
      // that nothing has actually scheduled -- see importState.
      diagnostics: { scheduledUpToBeatRelAtExport: this.scheduledUpToBeat - beatNow },
      layers: this.layers.map((l) => ({
        id: l.id,
        kind: l.kind,
        name: l.name,
        builtinKey: l.builtinKey || null,
        events: clone(l.events),
        lengthBeats: l.lengthBeats,
        anchorBeat: l.anchorBeat,
        on: l.on,
        muted: l.muted,
        volume: l.volume,
        phraseCount: l.phraseCount,
      })),
      pending: clone(this.pending),
      phrases: clone(this.phrases),
      openPhrase: clone(this.openPhrase),
    };
  }

  /**
   * Restore a checkpoint onto the live engine. Buses are reused (they belong to
   * the current SoundEngine); everything else is deep-cloned so the caller's
   * object can never be mutated by later playing.
   *
   * @param {object} state from exportState()
   * @param {number} [atSec] the absolute time on THIS clock that the
   *   checkpoint's beat should land on. Everything in the tempo map is rebased
   *   onto it, so queued-but-not-yet-effective tempo changes survive the trip.
   */
  importState(state, atSec) {
    if (!state) return;
    const now = atSec === undefined ? this.sound.now() : atSec;

    // silence whatever is currently sounding, and invalidate its release timers
    for (const l of this.layers) {
      this.sound.releaseAll(this._scopePrefix(l));
      l.generation++;
    }

    if (state.quantize) this.quantize = state.quantize;

    const src = Array.isArray(state.layers) ? state.layers : [];
    for (let i = 0; i < this.layers.length; i++) {
      const l = this.layers[i];
      const s = src[i];
      if (!s) {
        Object.assign(l, this._blankLayer(i, l.bus), { generation: l.generation, bus: l.bus });
        continue;
      }
      l.kind = s.kind ?? null;
      l.name = s.name ?? '';
      l.builtinKey = s.builtinKey ?? null;
      l.events = clone(s.events) || [];
      l.lengthBeats = s.lengthBeats || 0;
      l.anchorBeat = s.anchorBeat || 0;
      l.on = s.on !== false;
      l.muted = !!s.muted;
      l.volume = typeof s.volume === 'number' ? s.volume : 1;
      l.phraseCount = s.phraseCount || 0;
    }

    this.pending = clone(state.pending) || [];
    this.phrases = clone(state.phrases) || [];
    this.openPhrase = clone(state.openPhrase) || { events: [], text: '', start: null };

    // --- transport -----------------------------------------------------------
    const beat0 = state.beatAtCheckpoint || 0;
    const fallbackBpm = state.playingBpm || state.bpm || this.bpm;
    this.tempoSegments = this._rebuildTempoMap(state.tempoSegments, beat0, now, fallbackBpm);
    this.bpm = state.bpm || fallbackBpm; // what the user has selected

    // --- scheduler cursor ----------------------------------------------------
    // NOT restored from the checkpoint. `scheduledUpToBeat` describes what the
    // OLD SoundEngine had already handed to Web Audio, and those AudioNodes do
    // not exist here -- the replay path calls releaseAll() and starts a fresh
    // timeline. Restoring it marked the stretch between the checkpoint beat and
    // the old cursor as "already scheduled", so notes sitting there were never
    // queued at all: a pre-existing layer lost the first notes of its replay.
    //
    // What the cursor must mean here is "where this engine should begin
    // scheduling": the checkpoint beat, or the present if we are already past it
    // (never catching up on the past in a burst).
    this.scheduledUpToBeat = Math.max(beat0, this.beatAt(this.sound.now()));

    for (const l of this.layers) this._applyGain(l);
    this.onChange();
  }

  /**
   * Rebuild absolute (startBeat, startSec) pairs from beat-only segments.
   *
   * The segment covering the checkpoint is pinned so that `beat0` lands on
   * `atSec`; every other boundary's second is then derived by walking outward
   * and multiplying the beat gap by the bpm in force over that gap. Continuity
   * is therefore structural, not something rounding can break.
   */
  _rebuildTempoMap(rel, beat0, atSec, fallbackBpm) {
    if (!Array.isArray(rel) || !rel.length) {
      return [{ startBeat: beat0, startSec: atSec, bpm: fallbackBpm }];
    }
    const segs = rel
      .map((s) => ({ startBeat: beat0 + (s.dBeat || 0), startSec: 0, bpm: s.bpm || fallbackBpm }))
      .sort((a, b) => a.startBeat - b.startBeat);

    // index of the segment covering beat0
    let k = segs.length - 1;
    while (k > 0 && segs[k].startBeat > beat0) k--;

    segs[k].startSec = atSec - (beat0 - segs[k].startBeat) * (60 / segs[k].bpm);
    // forward: each boundary is reached at the previous segment's tempo
    for (let i = k + 1; i < segs.length; i++) {
      segs[i].startSec = segs[i - 1].startSec + (segs[i].startBeat - segs[i - 1].startBeat) * (60 / segs[i - 1].bpm);
    }
    // backward: same relation, solved for the earlier boundary
    for (let i = k - 1; i >= 0; i--) {
      segs[i].startSec = segs[i + 1].startSec - (segs[i + 1].startBeat - segs[i].startBeat) * (60 / segs[i].bpm);
    }
    return segs;
  }

  // -------------------------------------------------------------------------
  _freeLayer() {
    for (let i = 0; i < this.layers.length; i++) if (!this.layers[i].events.length) return i;
    return null;
  }

  _layerName() {
    const words = this.phrases.map((p) => p.text).filter(Boolean);
    if (this.openPhrase.text.trim()) words.push(this.openPhrase.text.trim());
    const s = words.join(' ');
    return s.length > 22 ? s.slice(0, 21) + '…' : s || 'phrase';
  }

  /** grid is 1/4 beat = a 16th note. LIGHT leaves most of the human timing. */
  _quantizeBeats(b) {
    if (this.quantize === 'OFF') return b;
    const grid = 0.25;
    const snapped = Math.round(b / grid) * grid;
    const amount = this.quantize === 'STRONG' ? 1 : 0.4;
    return b + (snapped - b) * amount;
  }

  // -------------------------------------------------------------------------
  _tick() {
    const now = this.sound.now();
    const nowBeat = this.beatAt(now);
    const to = this.beatAt(now + LOOKAHEAD);
    // Never go backwards, and never catch up on beats already in the past: if
    // the tab was throttled those notes are gone, and playing them late in a
    // burst is worse than dropping them.
    const from = Math.max(this.scheduledUpToBeat, nowBeat);
    if (to <= from) {
      if (nowBeat > this.scheduledUpToBeat) this.scheduledUpToBeat = nowBeat;
      return;
    }

    for (const l of this.layers) {
      if (!l.on || l.muted || !l.events.length || l.lengthBeats <= 0) continue;
      const len = l.lengthBeats;
      const iStart = Math.floor((from - l.anchorBeat) / len);
      const iEnd = Math.floor((to - l.anchorBeat) / len);
      for (let i = iStart; i <= iEnd; i++) {
        if (i < 0) continue;
        const base = l.anchorBeat + i * len;
        for (const item of l.events) {
          const beat = base + item.b;
          if (beat >= from && beat < to) {
            const t = this.secAt(beat);
            const ev = item.ev;
            // The scope carries the layer GENERATION and the loop iteration, so
            // neither a retrigger nor a cleared-and-rebuilt layer can be cut
            // short by a release timer belonging to something older.
            const scope = this._scopePrefix(l) + '#' + i;
            this.sound.play(ev, t, l.bus, scope);
            if (ev.gated) {
              const rel = t + Math.max(ev.duration || 0.2, 0.08);
              const seq = ev.sourceSeq;
              setTimeout(() => this.sound.release(seq, rel, scope), Math.max(0, (rel - this.sound.now()) * 1000));
            }
          }
        }
      }
    }
    this.scheduledUpToBeat = to;
  }

  snapshot() {
    return this.layers.map((l) => ({
      id: l.id,
      kind: l.kind,
      name: l.name,
      on: l.on,
      muted: l.muted,
      volume: l.volume,
      bars: l.lengthBeats ? Math.round(l.lengthBeats / BEATS_PER_BAR) : 0,
      lengthBeats: l.lengthBeats,
      anchorBeat: round3(l.anchorBeat),
      events: l.events.length,
      phraseCount: l.phraseCount,
    }));
  }
}

export { LAYER_COUNT, BEATS_PER_BAR };
