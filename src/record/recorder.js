// ---------------------------------------------------------------------------
// RECORDER  --  audio capture and session export.
//
// v0.2 splits what v0.1 conflated:
//
//   Scratch History   always on. A rolling buffer of raw key events and the
//                     performance events they produced. Feeds REPLAY of "what
//                     I just did" and the debug view. Never exported as truth.
//
//   Take              RECORD .. STOP, and nothing else. audio.webm, the raw
//                     events, the performance events and the session log are
//                     all cut to the SAME span of time, so the files in an
//                     export describe one identical stretch of the performance.
//
// In v0.1 the JSON always covered the whole session while the audio covered
// only the RECORD window, so exporting after typing a bit more silently
// produced a mismatched bundle.
// ---------------------------------------------------------------------------

import { makeZip, textFile } from './zip.js';
import { FORMAT_VERSION, ENGINE_VERSION } from '../session/sessionEvents.js';

const SCRATCH_CAP = 40000;

export class Recorder {
  constructor() {
    this.raw = [];
    this.perf = [];
    // Takes get their own buffers. Sharing the scratch arrays meant that
    // typing on after STOP slowly ate the recorded take from the front.
    this.takeRaw = [];
    this.takePerf = [];
    this.text = '';
    this.startedAt = new Date();
    this.audioChunks = [];
    this.media = null;
    this.audioBlob = null;
    this.recording = false;
    this.take = null; // {start, end} in session seconds
  }

  reset() {
    this.raw = [];
    this.perf = [];
    this.takeRaw = [];
    this.takePerf = [];
    this.text = '';
    this.audioChunks = [];
    this.audioBlob = null;
    this.take = null;
    this.startedAt = new Date();
  }

  // --- scratch history + take -----------------------------------------------
  // The scratch arrays are a rolling window. The take arrays are not: they are
  // only replaced by the next RECORD, so playing on after STOP cannot erode
  // what was recorded.
  addRaw(ev) {
    this.raw.push(ev);
    while (this.raw.length > SCRATCH_CAP) this.raw.shift();
    if (this.recording) this.takeRaw.push(ev);
  }
  addPerf(events) {
    for (const e of events) {
      this.perf.push(e);
      if (this.recording) this.takePerf.push(e);
    }
    while (this.perf.length > SCRATCH_CAP) this.perf.shift();
  }
  setText(t) {
    this.text = t;
  }

  /**
   * keyup arriving after a note was already copied elsewhere -- see LoopEngine.
   * Both buffers hold the same objects, so a Set keeps the count honest.
   */
  applyHoldBySeq(seq, holdMs) {
    if (holdMs === null || holdMs === undefined) return 0;
    const dur = Math.round(Math.max(holdMs / 1000, 0.08) * 1000) / 1000;
    const seen = new Set();
    let n = 0;
    for (const list of [this.perf, this.takePerf]) {
      for (const e of list) {
        if (seen.has(e)) continue;
        seen.add(e);
        if (e.gated && e.sourceSeq === seq && e.duration !== dur) {
          e.duration = dur;
          n++;
        }
      }
    }
    return n;
  }

  /** keydown-only view of the scratch history -- what "replay last" consumes */
  rawDowns() {
    return this.raw.filter((e) => e.keydown);
  }

  // --- take -----------------------------------------------------------------
  startAudio(stream, sessionTime, text = '') {
    if (this.recording) return;
    // The text is cut to the take as well, so text.txt describes the same
    // stretch of time as audio.webm and session-events.json.
    this.take = { start: sessionTime, end: null, textStart: text, textEnd: null };
    this.takeRaw = [];
    this.takePerf = [];
    this.startedAt = new Date();
    const mime = ['audio/webm;codecs=opus', 'audio/webm'].find(
      (m) => window.MediaRecorder && MediaRecorder.isTypeSupported(m)
    );
    this.audioChunks = [];
    this.audioBlob = null;
    this.media = new MediaRecorder(stream, mime ? { mimeType: mime, audioBitsPerSecond: 192000 } : undefined);
    this.media.ondataavailable = (e) => {
      if (e.data && e.data.size) this.audioChunks.push(e.data);
    };
    this.media.start(250);
    this.recording = true;
  }

  stopAudio(sessionTime, text = null) {
    if (this.take && this.take.end === null) {
      this.take.end = sessionTime;
      this.take.textEnd = text;
    }
    return new Promise((resolve) => {
      if (!this.media || !this.recording) {
        this.recording = false;
        return resolve(null);
      }
      this.media.onstop = () => {
        this.audioBlob = new Blob(this.audioChunks, { type: this.media.mimeType || 'audio/webm' });
        this.recording = false;
        resolve(this.audioBlob);
      };
      this.media.stop();
    });
  }

  /** the take window, or the whole scratch history when nothing was recorded */
  window() {
    if (!this.take) return null;
    return { start: this.take.start, end: this.take.end === null ? Infinity : this.take.end };
  }

  /**
   * Raw / performance events for the take, rebased so the take starts at 0.
   * Read from the dedicated take buffers, not filtered out of a scratch window
   * that may since have rolled over.
   */
  takeSlices() {
    const w = this.window();
    if (!w) return { raw: this.raw, perf: this.perf, rebased: false };
    const shift = (e, key) => Object.assign({}, e, { [key]: +(e[key] - w.start).toFixed(3) });
    return {
      raw: this.takeRaw.map((e) => {
        const c = shift(e, 'timestamp');
        if (c.keyupAt !== null && c.keyupAt !== undefined) c.keyupAt = +(e.keyupAt - w.start).toFixed(3);
        return c;
      }),
      perf: this.takePerf.map((e) => shift(e, 'time')),
      rebased: true,
    };
  }

  stamp() {
    const d = this.startedAt || new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  }

  // -------------------------------------------------------------------------
  async exportZip({ mapping, settings, layers, sessionEvents, tookTake }) {
    const dir = `session_${this.stamp()}`;
    const { raw, perf } = this.takeSlices();

    const files = [
      textFile(
        `${dir}/session-events.json`,
        JSON.stringify(
          {
            formatVersion: FORMAT_VERSION,
            engineVersion: ENGINE_VERSION,
            mappingVersion: mapping && mapping.name,
            source: tookTake ? 'take' : 'scratch-history',
            events: sessionEvents,
          },
          null,
          1
        )
      ),
      textFile(`${dir}/typing-events.json`, JSON.stringify(raw, null, 1)),
      textFile(`${dir}/performance.json`, JSON.stringify(perf, null, 1)),
      textFile(`${dir}/text.txt`, this.take && this.take.textEnd !== null ? this.take.textEnd : this.text),
      textFile(`${dir}/mapping.json`, JSON.stringify(mapping, null, 1)),
      textFile(
        `${dir}/settings.json`,
        JSON.stringify({ formatVersion: FORMAT_VERSION, engineVersion: ENGINE_VERSION, ...settings, layers }, null, 1)
      ),
      textFile(
        `${dir}/README.txt`,
        [
          'TYPING INSTRUMENT session  (formatVersion ' + FORMAT_VERSION + ', engine ' + ENGINE_VERSION + ')',
          '',
          'session-events.json',
          '  THE CANONICAL DOCUMENT. The full performance timeline: typing plus',
          '  every UI, loop and settings operation, on one clock.',
          '  Its first event (record_start) is a CHECKPOINT holding the settings,',
          '  the beat position, the performance-engine state (repeat counters,',
          '  hand alternation, phrase position, what Backspace reverses) and the',
          '  loop state (layers, pending notes, phrases) as they were when RECORD',
          '  was pressed. RECORD does not reset the instrument, so without that',
          '  checkpoint a take replays as a different piece of music.',
          '',
          'typing-events.json',
          '  Raw physical keyboard performance data only: every key with hold,',
          '  interval, keys/sec, hand, row and word context.',
          '',
          'performance.json',
          '  The musical events those keys generated.',
          '',
          'audio.webm',
          '  Rendered audio for the recorded take (present only if RECORD was used).',
          '',
          'mapping.json / settings.json',
          '  Which key was which instrument, and the state of the controls.',
          '',
          'What this file set does and does not guarantee:',
          '  1. same session-events.json -> same performance.json',
          '       GUARANTEED, including the state inherited from before RECORD.',
          '       Verified by the app\'s own self-tests.',
          '  2. same performance.json -> audibly the same music',
          '       BEST EFFORT, not guaranteed. The synth carries state that',
          '       depends on surrounding events (delay feedback, the pause',
          '       macro, tempo-locked delay time), so two renderings can differ',
          '       slightly in ambience even when every note is identical.',
          '  3. bit-identical audio samples',
          '       NOT CLAIMED, and not a goal.',
        ].join('\n')
      ),
    ];

    if (this.audioBlob) {
      files.push({ name: `${dir}/audio.webm`, data: new Uint8Array(await this.audioBlob.arrayBuffer()) });
    }
    return { blob: makeZip(files), name: `${dir}.zip` };
  }
}

export function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}
