// ---------------------------------------------------------------------------
// Test instruments: a fake audio context that records instead of sounding.
//
// Reading a synth's source and reasoning about it is not a test. Rendering an
// event through the REAL voice code and writing down every parameter change it
// schedules is -- it catches a decay that does not depend on pitch, a release
// that cuts instead of damps, and a NaN reaching an AudioParam, none of which
// are visible in the configuration.
// ---------------------------------------------------------------------------

/** an AudioParam that remembers its automation and can be evaluated at time t */
class FakeParam {
  constructor(ctx, owner, name, value = 0) {
    this.ctx = ctx;
    this.owner = owner;
    this.name = name;
    this._value = value;
    this.points = []; // {t, v, kind}
  }
  get value() {
    return this._value;
  }
  set value(v) {
    this._value = v;
    this.ctx.record(this.owner, this.name + '.value', [v]);
    this.points.push({ t: 0, v, kind: 'set' });
  }
  setValueAtTime(v, t) {
    this.ctx.record(this.owner, this.name + '.setValueAtTime', [r6(v), r6(t)]);
    this.points.push({ t, v, kind: 'set' });
    return this;
  }
  linearRampToValueAtTime(v, t) {
    this.ctx.record(this.owner, this.name + '.linearRamp', [r6(v), r6(t)]);
    this.points.push({ t, v, kind: 'linear' });
    return this;
  }
  exponentialRampToValueAtTime(v, t) {
    this.ctx.record(this.owner, this.name + '.expoRamp', [r6(v), r6(t)]);
    this.points.push({ t, v, kind: 'expo' });
    return this;
  }
  setTargetAtTime(v, t, c) {
    this.ctx.record(this.owner, this.name + '.setTarget', [r6(v), r6(t), r6(c)]);
    this.points.push({ t, v, kind: 'target' });
    return this;
  }
  cancelScheduledValues(t) {
    this.ctx.record(this.owner, this.name + '.cancel', [r6(t)]);
    this.points = this.points.filter((p) => p.t < t);
    return this;
  }
  /** the value this automation curve holds at `t` */
  valueAt(t) {
    const pts = this.points.slice().sort((a, b) => a.t - b.t);
    if (!pts.length) return this._value;
    if (t <= pts[0].t) return pts[0].v;
    for (let i = 1; i < pts.length; i++) {
      if (t > pts[i].t) continue;
      const a = pts[i - 1];
      const b = pts[i];
      const span = b.t - a.t;
      if (span <= 0) return b.v;
      const k = (t - a.t) / span;
      if (b.kind === 'expo' && a.v > 0 && b.v > 0) return a.v * Math.pow(b.v / a.v, k);
      return a.v + (b.v - a.v) * k;
    }
    return pts[pts.length - 1].v;
  }
}

const r6 = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 1e6) / 1e6 : v);

let nodeSeq = 0;
class FakeNode {
  constructor(ctx, kind) {
    this.ctx = ctx;
    this.kind = kind;
    this.id = kind + '#' + nodeSeq++;
    this.outputs = [];
  }
  connect(dest) {
    this.outputs.push(dest);
    this.ctx.record(this.id, 'connect', [dest && dest.id ? dest.id.replace(/#\d+$/, '') : 'param']);
    return dest;
  }
  disconnect() {
    this.ctx.record(this.id, 'disconnect', []);
  }
  start(t, off) {
    this.ctx.record(this.id, 'start', [r6(t), r6(off)]);
  }
  stop(t) {
    this.ctx.record(this.id, 'stop', [r6(t)]);
  }
}

export class RecordingContext {
  constructor() {
    this.currentTime = 0;
    this.sampleRate = 48000;
    this.calls = [];
    this.nodes = [];
  }
  record(node, what, args) {
    // The node id carries a global counter, which would differ between two
    // renderings for no musical reason. Only the KIND is recorded.
    this.calls.push({ node: String(node).replace(/#\d+$/, ''), what, args });
  }
  _make(kind, params) {
    const n = new FakeNode(this, kind);
    for (const [name, init] of params) n[name] = new FakeParam(this, n.id, name, init);
    this.nodes.push(n);
    return n;
  }
  createGain() { return this._make('gain', [['gain', 1]]); }
  createOscillator() {
    const n = this._make('osc', [['frequency', 440], ['detune', 0]]);
    Object.defineProperty(n, 'type', { set: (v) => this.record(n.id, 'type', [v]), get: () => 'sine' });
    return n;
  }
  createBiquadFilter() {
    const n = this._make('biquad', [['frequency', 350], ['Q', 1], ['gain', 0]]);
    Object.defineProperty(n, 'type', { set: (v) => this.record(n.id, 'type', [v]), get: () => 'lowpass' });
    return n;
  }
  createBufferSource() {
    const n = this._make('bufsrc', [['playbackRate', 1], ['detune', 0]]);
    n.buffer = null;
    n.loop = false;
    return n;
  }
  createStereoPanner() { return this._make('panner', [['pan', 0]]); }
  createConvolver() { return this._make('convolver', []); }
  createDelay() { return this._make('delay', [['delayTime', 0]]); }
  createWaveShaper() { return this._make('shaper', []); }
  createDynamicsCompressor() {
    return this._make('comp', [['threshold', -24], ['knee', 30], ['ratio', 12], ['attack', 0.003], ['release', 0.25]]);
  }
  createBuffer() { return { length: 1, getChannelData: () => new Float32Array(1) }; }
}

/**
 * Render a struck note and read its amplitude envelope back off the automation
 * the voice actually scheduled -- not off the configuration it was given.
 *
 * The partial gains are the ones connected into the body filter; summing their
 * curves gives the note's amplitude over time. `at(t)` is that sum, so
 * `at(0.9) < at(0.05)` is a direct measurement of "it is still decaying while
 * the key is held".
 */
export function renderStruckEnvelope(world, midi, SoundEngineCls, SOUND_SETS, held = 0.9) {
  const ctx = new RecordingContext();
  const eng = new SoundEngineCls();
  eng.ctx = ctx;
  eng.setName = world;
  eng.noiseBuf = { length: 1 };
  const amp = ctx.createGain();
  const freq = 440 * Math.pow(2, (midi - 69) / 12);
  const handle = eng._struck(
    { instrument: 'melody', note: midi, freq, duration: held, gated: true, velocity: 96, fx: {}, sourceSeq: 1, tag: 'scale' },
    0,
    amp,
    SOUND_SETS[world].model,
    'melody'
  );
  // the body filter every partial feeds into
  const body = ctx.nodes.find((n) => n.kind === 'biquad');
  const partials = ctx.nodes.filter((n) => n.kind === 'gain' && n.outputs.includes(body));
  const at = (t) => partials.reduce((s, n) => s + Math.max(n.gain.valueAt(t), 0), 0);

  let peakAt = 0;
  let peak = -1;
  for (let t = 0; t <= held; t += 0.005) {
    const v = at(t);
    if (v > peak) { peak = v; peakAt = t; }
  }
  return {
    at,
    peakAt,
    peak,
    partials: partials.length,
    hasRelease: !!(handle && typeof handle.release === 'function'),
    hasDamp: !!(handle && handle.dampTime > 0),
    calls: ctx.calls,
  };
}

/** a RESTORE_LAYER payload for a real built-in loop, built without any audio */
export function restoreDataFor(LoopEngineCls, StubSoundCls, SCALES) {
  const s = new StubSoundCls();
  const le = new LoopEngineCls(s, { bpm: 120, quantize: 'OFF' });
  le.init();
  le.stop();
  le.addBuiltin('beat', SCALES.electronic);
  return le.layerContent(0);
}

/** first differing sub-key, for a readable failure message */
export function diffKeys(a, b) {
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') {
    return String(JSON.stringify(a)).slice(0, 60) + ' vs ' + String(JSON.stringify(b)).slice(0, 60);
  }
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) {
      return k + ' (' + String(JSON.stringify(a[k])).slice(0, 50) + ' vs ' + String(JSON.stringify(b[k])).slice(0, 50) + ')';
    }
  }
  return 'no single key differs';
}

/**
 * Every module this build ships, in the exact case it has on disk.
 *
 * Windows and macOS do not care about the case of a filename; GitHub Pages runs
 * on Linux and does. A machine that cannot tell `./Core/hash.js` from
 * `./core/hash.js` also cannot discover that it got one wrong, so the only
 * check available here is against a list written by hand -- which is why the
 * list is here, next to the test that reads it, rather than generated.
 */
export const EXPECTED_MODULES = [
  '/src/main.js',
  '/src/core/hash.js',
  '/src/input/inputEngine.js',
  '/src/perf/mapping.js',
  '/src/perf/scale.js',
  '/src/perf/performanceEngine.js',
  '/src/perf/performKey.js',
  '/src/sound/soundEngine.js',
  '/src/sound/soundSets.js',
  '/src/loop/loopEngine.js',
  '/src/loop/builtinLoops.js',
  '/src/record/recorder.js',
  '/src/record/zip.js',
  '/src/session/sessionEngine.js',
  '/src/session/sessionEvents.js',
  '/src/session/simulate.js',
  '/src/project/projectFormat.js',
  '/src/project/projectStore.js',
  '/src/project/projectController.js',
  '/src/story/storyStrip.js',
  '/src/ui/dom.js',
  '/src/ui/tracksView.js',
  '/src/ui/commitLoop.js',
  '/src/ui/starterKits.js',
  '/src/ui/guidedJam.js',
  '/src/ui/nextMove.js',
  '/src/tests/selfTest.js',
  '/src/tests/fixture.js',
  '/src/tests/probes.js',
];

export const noopHandlers = {
  onToggle() {}, onMute: () => {}, onVolume: () => {}, onDelete: () => {},
  onCreate: () => {}, onPreset: () => {},
};
