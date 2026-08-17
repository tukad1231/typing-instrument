# TYPING INSTRUMENT  ·  v0.2.2 Public Beta

**Typing is the instrument.**

For people who type fast but have never played anything. You already own the
skill: speed, accuracy, two independent hands, rhythm, and years of muscle
memory for where every key is. This turns that skill into playing, without
asking you to learn a keyboard, a chord chart, or a DAW first.

It is not a "press a key, hear a sound" toy, and it is not an AI that writes
music for you. It is an instrument you get better at.

---

## Run it

**Node.js is only needed to serve a local checkout.** If you are using a
hosted build, open it in Chrome and press **START** — there is nothing to
install.

To run it from this repository:

Use a currently supported Node.js LTS release; this build was tested with
Node.js 24 LTS.

**Double-click `start.bat`.** It starts the local server and opens Chrome. Then
press **START**.

Or from a terminal:

```bash
node server.js --open
```

`server.js` is a local development server only. It binds to `127.0.0.1`, so
nothing else on your network can reach it, it accepts only `GET`/`HEAD` from
that exact origin, and it serves **only the app** — `index.html` and the `.js`
and `.css` files under `src/`. Everything else in the folder (git metadata,
editor settings, `package.json`, `server.js` itself) is not reachable over HTTP.

> Open **`http://127.0.0.1:5173`**, not `localhost` — the server only answers to
> that exact host, which is what stops a hostile page from pointing a domain at
> your loopback address and reading these files.

No `npm install`, no build step, no dependencies, and no backend or external
runtime service: nothing is fetched or sent while you play. Just Node and a
browser.

> **Do not double-click `index.html`.** Opening it directly (`file://`) makes
> Chrome block the ES module imports. The page detects this and says so, but
> the fix is always the same: use `start.bat`.

---

## Play it

1. Press **START**.
2. Press **Beat** to drop a foundation under you.
3. Type. Anything. `fujirock ni detai` works. So does `ffjjkllaaass`.
4. **Space** ends a phrase. **Enter** commits everything typed so far into a
   looping layer. Then type over the top of it.
5. Four layers, then it is a song.

The first screen shows only **Sound · Volume · Beat · typing · Layers ·
Record**. Everything with a vocabulary (Tempo, Complexity, Timing, meters,
debug) lives behind **ADVANCED**.

### What your hands are playing

```
 1 2 3 4 5 6 7 8 9 0    chord bed
 Q W E R T │ Y U I O P    bass   │ bell
 A S D F G │ H J K L ;    drums  │ MELODY
 Z X C V B │ N M , . /    low FX │ voice
```

### The rules you can learn

| you do | it does |
|---|---|
| hold a key down | the note tracks your hold, with an 80 ms minimum and the synth's own release tail |
| press the same drum key 4+ times | a real ratchet/roll |
| hold Shift | a deliberately outside-the-scale tension note |
| type faster | brighter, denser, and an octave layer **fades in** |
| keep a steady rhythm | tighter, more delay feedback — "groove lock" |
| pause, then type | the next attack is an accent with a long tail |
| Backspace | a reversed tail — a note like any other, kept in the loop |
| *Complexity 30+* | repeats climb chromatically; long words climb the scale |
| *Complexity 50+* | alternating hands add a 5th and hard stereo ping-pong |
| *Complexity 70+* | every 4th note of a phrase gets a sub |

Typing has no velocity sensor. So **hold length, repetition, hand alternation,
accents after a pause and steadiness are the velocity** — expressive axes you
already control without thinking about it.

---

## The two promises v0.2 is built around

### 1. Determinism — you can find the same sound again

There is **no `Math.random()` anywhere in this codebase.** Even the noise
buffers and the reverb impulse are generated from fixed seeds.

The guarantee is stated at three levels, because conflating them is dishonest:

| | claim | status |
|---|---|---|
| **Level 1** | same session log + settings → **same performance events** | **guaranteed**, and tested |
| **Level 2** | same performance events → **audibly the same music** | **best effort**, not guaranteed |
| **Level 3** | bit-identical output audio samples | **not claimed** |

**Level 2 is best effort, not a guarantee**, because the code does not support
the stronger claim. `SoundEngine` holds state that is not part of any
performance event: one shared delay-feedback control written by every event's
`fx.feedback`, the pause/space macro, a delay time re-locked whenever the tempo
moves, and the Sound World itself. Two renderings of the same
`performance.json` therefore agree on **every note**, and can still differ
slightly in ambience.

Per-voice send buses would remove the shared-feedback part of that, but **not
all of it**: the pause macro is driven by a UI timer, and the delay time is
re-locked on tempo changes, so a full Level 2 guarantee needs the ambience
parameters to become per-event data as well. That is v0.3 work and it is more
than one refactor.

Level 3 is deliberately out of scope: noise sources read at an offset derived
from the scheduled audio time, and the browser's own scheduling jitters by
fractions of a millisecond. Nothing musical depends on it.

### 2. Playing stability — a small mistake stays a small mistake

Determinism alone does not make something re-performable by a human. Hands are
never exact. So the second principle is:

> a small difference in input must stay a small difference in music.

v0.1 broke this: crossing 6 keys/sec flipped the melody up a full octave, so
5.99 and 6.01 keys/sec were *different songs*. In v0.2 continuous quantities
(speed, steadiness) drive continuous things — brightness, density, blend, FX
depth — and an octave **layer** fades in between 5.5 and 9 keys/sec instead of
transposing the note you played. Big, discrete musical changes are reserved for
gestures you can aim at: Shift, repeats, holds, hand alternation.

---

## The session log is the document

v0.1 treated raw key events as the master take. That was not enough. A live set
is not only typing: changing the Sound, nudging the tempo, dropping in a Beat,
muting a layer — those *are* the performance, and without them a replay is a
different piece of music.

Everything now lands on **one timeline**:

```json
[
  { "time": 0,    "type": "record_start",     "data": { "beatAtStart": 26.8, "settings": { "bpm": 120, ... } } },
  { "time": 0.28, "type": "key_down",         "data": { "code": "KeyF", "holdMs": 64, ... } },
  { "time": 0.34, "type": "key_up",           "data": { "seq": 0, "holdMs": 64 } },
  { "time": 2.10, "type": "add_builtin_loop", "data": { "loop": "beat" } },
  { "time": 3.44, "type": "set_bpm",          "data": { "value": 140 } },
  { "time": 5.02, "type": "layer_mute",       "data": { "layer": 1, "value": true } }
]
```

Every user action goes through `SessionEngine.dispatch()`, which appends the
event and then applies it. **Replay calls the same handlers with the same
data**, minus the logging — there is no separate replay implementation that can
drift out of sync with the live one.

`simulateSession()` is a third path and is *not* the same code path as the live
app: it reuses the real `PerformanceEngine` and the real `LoopEngine`, but has
no `SoundEngine`, no scheduler tick and no UI, and its transport is driven by
event timestamps instead of an audio clock. It therefore verifies Level 1 and
says nothing about Level 2.

`commit_layer` is a **derived marker**, not a command: pressing Enter is the
command, committing the layer is its consequence. It is written to the log so
the timeline reads correctly, carries `derived: true` in its data, and is never
re-applied on replay — the Enter keystroke already does that.

A take opens with a **full checkpoint**, not just the settings: `beatAtStart`,
the settings, the performance engine's expression state (repeat counters, hand
alternation, phrase position, what Backspace will reverse) and the loop state
(layers, pending notes, phrases). RECORD deliberately does **not** reset the
instrument — you record over what is already running, mid-phrase — so all of
that has to travel with the take or the replay plays a different piece.

RECORD is refused while a key is physically held down: that note began before
the take, and its keyup would land inside it.

### RECORD now means something

- **Scratch History** — always on, in its own rolling buffer. When it rolls
  over, the survivors are prefixed with a fresh checkpoint rather than left
  headless.
- **Take** — RECORD .. STOP, in **separate buffers that are never trimmed**.
  `audio.webm`, `typing-events.json`, `performance.json`,
  `session-events.json` and `text.txt` are all cut to the same span, and
  playing on after STOP cannot erode them. A take past 120,000 events stops
  itself with a visible warning instead of dropping anything.

In v0.1 the JSON covered the whole session while the audio covered only the
RECORD window, so exporting after typing a bit more silently produced a
mismatched bundle.

---

## Export

> ### ⚠️ What is inside a session ZIP
>
> An exported session can contain **the exact text you typed**, the timing of
> every keystroke, your settings, and **a recording of the audio**. If you typed
> something private, it is in there.
>
> **Nothing is ever uploaded.** The export is written straight to your machine;
> this app has no backend and makes no network requests.
>
> **Open the ZIP and look before you share it with anyone.**

```
session_YYYYMMDD_HHMMSS/
  session-events.json   THE CANONICAL DOCUMENT — typing + every UI, loop and
                        settings operation on one clock
  typing-events.json    raw physical keyboard data only
  performance.json      the musical events those keys generated
  audio.webm            rendered audio for the take
  text.txt              what was on screen at the end of the take
  mapping.json          which key was which instrument
  settings.json         control state + layer summary
  README.txt
```

Every file carries `formatVersion` (**3**) and `engineVersion` (`poc-5`), and
the mapping carries its own version. Format 3 adds `performanceState` and
`loopState` to the opening checkpoint; **v0.2 logs (format 2) still replay** —
without engine state the engines simply start from their defaults, which is
what those logs always assumed.

---

## Architecture

```
src/
  input/inputEngine.js         physical keys -> RawTypingEvent (knows no music)
  perf/mapping.js              which key is which instrument   (pure data)
  perf/scale.js                pitch material                  (pure data)
  perf/performanceEngine.js    typing -> musical intention      <- the soul
  sound/soundSets.js           three Sound Worlds              (pure data)
  sound/soundEngine.js         performance events -> Web Audio (knows no keys)
  loop/loopEngine.js           phrases, layers, the BEAT grid
  loop/builtinLoops.js         the foundations you can drop in
  session/sessionEvents.js     the vocabulary of a performance
  session/sessionEngine.js     one timeline, one code path, replay
  session/simulate.js          headless re-run of a session log
  record/recorder.js           audio capture + session export
  record/zip.js                dependency-free ZIP writer
  tests/selfTest.js            the ten promises, checked in the browser
  ui/styles.css
  main.js                      wiring, plus layer rendering, replay control,
                               export and the debug view (splitting those out
                               is v0.3 work, not a stability release)
tools/
  analyzeTypingDistribution.js key-frequency analysis of real text
```

The hard boundary is still between **Performance Engine** and **Sound Engine**:
the performance engine never touches Web Audio; the sound engine never sees a
key code, a keys/sec value or a word.

### Sound Worlds, not "sound sets"

A Sound is `timbre + tonal material + character`. Picking a Sound also picks the
scale and root it is paired with, because a beginner should be able to change
"how it sounds" with one control and get a genuinely different piece rather
than a filtered version of the same one. What a Sound may **not** change is
which key plays which role — so muscle memory carries across all three.

### Tempo is musical, not wall-clock

Layer length, anchor and every note inside a layer are stored in **beats**.
Seconds are derived at playback from the current tempo, and the tempo map is
piecewise: each `setBpm` closes the current segment at the beat it had reached.
That is what lets the tempo move mid-set without the loops sliding off the grid
— which in v0.1 silently destroyed anything already committed.

---

## Japanese IME

Performance follows **physical keys**, display follows the IME. Typing
`フジロック` physically plays `f u j i r o k k u`.

While the IME is composing, **Space** means "next candidate" and **Enter** means
"confirm". Those are text operations, not musical ones, so both are ignored
entirely during composition — no sound, no transport. Every other key still
plays. Without this, finishing a Japanese word would commit a loop layer.

---

## Key distribution in real text

`node tools/analyzeTypingDistribution.js`

Measured, not guessed:

| fixture | left | right | Melody | Drums | Bell | Bass |
|---|---|---|---|---|---|---|
| Japanese romaji (lyrics) | 36.5% | 43.6% | **8.3%** | 17.9% | **26.9%** | 16.0% |
| Japanese romaji (prose) | 37.2% | 45.9% | **11.0%** | 23.8% | **25.6%** | 12.2% |
| English prose | 42.0% | 39.4% | **9.5%** | 17.7% | 20.8% | 20.8% |
| Deliberate playing | 26.2% | 60.7% | 60.7% | 26.2% | 0.0% | 0.0% |

**The finding: the lead voice is the least-played zone.** Melody (`HJKL;`) takes
only 8–11% of keystrokes in real writing, while Bell (`YUIOP`) takes 21–27%.
Every Japanese kana ends in a vowel, so `A I U E O` dominate — and in this
mapping `A` is the kick drum while `I U O` are bells. Hand balance is fine
(36–46% each); zone balance is not.

Left unchanged on purpose — remapping is a bigger decision than a
stability release should make, and the "deliberate playing" row shows the
mapping does what it promises when you play it as an instrument rather than
write prose. Two candidate fixes for v0.3:

1. **Swap Bell and Melody roles** (`YUIOP` becomes the lead). Follows the data,
   but breaks the "home row is the anchor" principle.
2. **Make the melody zone vowel-aware**: give the lead voice to whichever zone
   the current word's vowels land in. Deterministic, but a new rule to learn.

---

## Keyboard support

v0.2.2 targets **letter-centric JIS and US keyboards**. The 26 letters, digits and
common punctuation are mapped. JIS-specific keys (`IntlYen`, `IntlRo`,
`IntlBackslash`) and anything else unmapped are silent and cannot crash the
instrument — verified.

---

## The last three defects fixed before this release

The previous round's two fixes held up under re-audit, but the same area
produced three more defects. All three were **measured on this build** by
running the old code path next to the new one.

| # | defect | root cause | fix | before → after (measured) |
|---|---|---|---|---|
| P1-1 | `reset()` left the rolling checkpoints behind, so a checkpoint describing the *destroyed* world became the head of the *new* history. | `reset()` cleared `events` / `takeLog` / `take` / `recordingFlag` but not `checkpoints` / `_sinceCheckpoint` / `_trimming`. | `reset()` clears all of it. `nextId` is deliberately **not** reset, so an id can never belong to both histories. And when no checkpoint can be made at all, the log is **kept whole** rather than truncated — a complete history needs no head, because it starts where the session started. A hard ceiling (3 × `maxEvents`) truncates and marks the history unreplayable rather than letting memory grow forever; the UI then refuses to replay it. | live 41 / replay **91**, head counter **50**, 3 stale checkpoints → live 41 / replay **41**, head `null`, 0 stale |
| P1-2 | A pre-existing layer lost the notes at the **start** of its replay. | `importState()` restored `scheduledUpToBeat` from the checkpoint. That cursor describes what the **old** SoundEngine had already handed to Web Audio — and those AudioNodes do not travel with the checkpoint. Everything between the checkpoint beat and the old cursor was therefore treated as "already scheduled" and never queued. | The cursor is no longer restored. It is set to where **this** engine should start scheduling: the checkpoint beat, or the present if we are already past it. `scheduledUpToBeatRel` survives only under `diagnostics`, documented as unusable for restore. | live queued `[77]` / replay queued **`[]`** → replay queues 77 **once**, at checkpoint + 50.0 ms |
| P1-3 | With three tempo segments the map could run **backwards** across a boundary. | `dBeat` and `dSec` were stored as two independently `round3`-ed axes, so the continuity condition `Δbeat = Δsec × bpm/60` broke. Sorting by `startBeat` on import cannot repair a disagreement with `startSec`. | Only **one** canonical axis is stored — beats relative to the checkpoint, unrounded, plus the bpm. Seconds are reconstructed by pinning the segment that covers the checkpoint to `atSec` and chaining outward through the bpms, so continuity is structural. | at the third boundary Δ = **−0.000333332 beats, monotonic false** → Δ = **+1.2e-9, monotonic true**; export no longer contains `dSec` at all |

All three new tests (5e, 5f, 5g) were confirmed to **fail against the old code
path** before the fix — the numbers in the last column are those runs — and to
pass after.

---

## What RC2 fixed

Two timeline inconsistencies found by an independent RC audit. Neither was
caught by the 13 built-in tests, because both only appear once a *history*
exists — one needs 40,000 events, the other needs a tempo change that has been
queued but has not taken effect yet.

| # | defect | root cause | fix |
|---|---|---|---|
| P1-1 | Trimming the scratch history made a replay **over-apply**. Live counter 40,001 → replay 40,001+30,001 = **70,002**. | `_trim()` asked for the state **now** and filed it under the timestamp of an event ~30,000 back, then kept those 30,000 events after it. The state already contained them, so replaying applied them twice. | Checkpoints are now captured **as we go**, each recorded immediately *before* a known event id is applied. A trim picks the newest stored checkpoint that still leaves ≥ `keep` events, and keeps exactly the events from that id onward. The invariant is written into the code: `state(C) + apply(events with id ≥ C.id) == state(now)`. |
| P1-2 | A tempo change **queued at the lookahead boundary** disappeared from a checkpoint. Live: beat 0.700 @ 240 bpm. Replay: beat **0.500 @ 120 bpm**. | `exportState()` saved only `bpm` / `playingBpm` / `beatAtCheckpoint`, and `importState()` collapsed the map to a single segment — so a 120→240 made 50 ms earlier, still pending at the boundary, was lost. | The whole tempo map is exported **relative** to the checkpoint (`dBeat`, `dSec`, `bpm`) — never as absolute audio-clock seconds — together with the scheduler cursor. `importState(state, atSec)` rebases it onto the new clock, keeps the selected and playing bpm distinct, and re-syncs the cursor. |

Measured on this build, old path vs new, same checkpoint:

| | live | before the fix | after the fix |
|---|---|---|---|
| beat 200 ms after checkpoint | 0.700 | **0.500** | 0.700 |
| playing bpm | 240 | **120** | 240 |

---

## What v0.2.2 fixed

Four release blockers found by a pre-release review of v0.2.1.

| # | defect | fix |
|---|---|---|
| 1 | `record_start` carried only settings and a beat position. Everything built **before** RECORD — the performance engine's repeat/alternation/phrase counters, running layers, pending notes, unfinished phrases — was lost on replay. Typing J, pressing RECORD, then J again gave note **61/chromatic** live and **60/scale** on replay. | `record_start` (and `session_start`) now carry a full **checkpoint**: `settings`, `beatAtStart`, `performanceState`, `loopState`. `PerformanceEngine` and `LoopEngine` gained `exportState()` / `importState()`, both deep-cloning so no shared reference escapes. RECORD still does **not** reset the instrument — you can record over loops that are already running. RECORD is refused while a key is physically held, because that note began before the take. |
| 2 | The tempo cursor stopped double-firing in v0.2.1, but a new segment was still anchored to *now*, so beat 0.29 could be scheduled at 0.145 s and the later beat 0.31 at 0.1025 s — **the later note played first**. Slowing 120→70 left an ~80 ms hole. | The tempo map is a list of **segments**. A tempo change takes effect at `max(nowBeat, scheduledUpToBeat)` — the end of what is already queued — so the new segment starts exactly where the old one stopped. Dragging the slider replaces the pending segment instead of stacking one per pixel. |
| 3 | `endTake()` let the 40,000-event ring catch up immediately, so a 45,000-event take came back as 39,998. The 120,000 take limit never applied. `Recorder`'s raw/perf arrays eroded the take as soon as you typed after STOP. | Takes live in their **own buffers** (`SessionEngine.takeLog`, `Recorder.takeRaw/takePerf`), never trimmed, replaced only by the next RECORD. The scratch ring, when it does trim, prefixes the survivors with a fresh checkpoint instead of leaving a headless history. |
| 4 | The 4.2 s safety timer released by `scope + sourceSeq` alone. CLEAR ALL resets the key sequence to 0, so a timer armed before the clear could cut short a brand-new `live:0`. | A timer only fires if **its own handle** is still the registered one, and is cancelled outright when the voice is released or superseded. Layers carry a **generation** number in their voice scope, so a cleared-and-rebuilt layer cannot be cut by the previous content's timers. |

Two bugs were found *by* the new tests while writing them: a timer id of `0`
being treated as falsy (so `clearTimeout` was skipped), and the checkpoint
restore reading the audio clock a second time — a few milliseconds of drift,
which was enough to quantise a keystroke sitting on a 1/16 boundary to the
other side. Both are fixed.

**What "identical" means here, precisely:** the comparison is over the
*performance events and the layer projection* — every event field (note, freq,
velocity, duration, gated, pan, fx, chord, tune, tag) plus each layer's
`kind`, `lengthBeats`, `anchorBeat` and every note's beat position. On that
projection the replay now matches the live take exactly, where v0.2.1 still
drifted by 0.001 beat. It is **not** a claim about audio samples: see the
determinism levels above, where Level 3 is explicitly not claimed.

---

## What v0.2.1 fixed

Six defects that broke re-performability, plus the quality claims that were
larger than the code.

| # | defect | fix |
|---|---|---|
| 1 | A note held **through** the Enter that committed a layer kept its default length in the layer, because `commitLayer` copied it before the keyup. Live 0.518 s vs replay 1.5 s. | Keyups now address notes by `sourceSeq` and reach every copy — pending, phrase and already-committed layers (`LoopEngine.applyHoldBySeq`). The log stores a **snapshot** at keydown instead of a shared object that quietly gains a `holdMs` later. |
| 2 | `setBpm` rewound the scheduler cursor to "now", so the lookahead window already handed to Web Audio was re-issued at the new tempo. The same beat fired twice. | The cursor is a **beat**, not a wall-clock time. Beats are continuous across a tempo change, so the cursor can never revisit a scheduled region. It is no longer touched by `setBpm`. |
| 3 | During REPLAY the pause/space macro still read the *live* `InputEngine`, so reverb and layer levels depended on whatever had been typed before pressing REPLAY. | While replaying, keys/sec and silence are derived from the log being replayed. |
| 4 | `session_start` carried only version numbers, so a scratch REPLAY began from the current knob positions rather than the ones it was played with. | `session_start` now carries the same opening snapshot a take does (`settings` + `beatAtStart`), and both use one restore path. |
| 5 | The 40 000-event ring buffer trimmed by array index while `beginTake` remembered an index, so a take started on a full history silently lost its head. | Takes are delimited by **monotonic event IDs**; the buffer never trims during a take; a take past 120 000 events stops itself with a visible message rather than dropping anything. `Recorder.raw/perf` follow the same rule. |
| 6 | CLEAR ALL during recording wiped the session while `MediaRecorder` kept running, leaving audio and JSON describing different things. | Refused, with the button disabled *and* a guard in the handler. |

The self-tests were rebuilt too. Several v0.2 tests compared a function with
itself, and test 1 handed out a free pass whenever the settings had been touched
— excusing itself in exactly the case most likely to be broken.

---

## Verification

Everything below was run in Chrome on this build. Nothing is carried over from
an earlier version.

### Self tests (ADVANCED → self-test) — **18 pass, 0 fail, 0 skipped**

| test | result |
|---|---|
| 5c trimmed scratch history replays to the same state | **PASS** — counter live 40,001, replay 40,001. Verified end-to-end through the real `PerformanceEngine` + `LoopEngine`, and once more through `allEvents()`, the path the UI actually uses |
| 5d queued tempo change survives the checkpoint | **PASS** — 200 ms after the checkpoint both live and replay give beat 0.700 @ 240 bpm; `beatAt` and `secAt` agree either side of the segment boundary; the restored engine still schedules monotonically with 0 duplicates |
| 5e `reset()` discards pre-reset checkpoints | **PASS** — live 41 / replay 41, head `null`, 0 stale checkpoints, no id mixing, with the checkpoint provider returning `null` *and* throwing. The broken form gave replay **91** with head counter **50** |
| 5f restored layer is re-queued on the new engine | **PASS** — a note between the checkpoint beat and the old cursor is queued **once**, at checkpoint + 50.0 ms, with a 400 ms lead-in; also correct when `atSec` is now, and skipped rather than fired late when it is 500 ms in the past. The broken form queued **nothing** |
| 5g 3-segment tempo map keeps its topology | **PASS** — 120→70→170 exported with **no seconds axis**; `beatAt` and `secAt` monotonic across every boundary, `secAt(beatAt(t)) == t`, beat order == second order |
| 1 take checkpoint: replay == the continuous performance | **PASS** — 8 events identical on every field, layer beats/lengths/anchors identical. **Counter-example reproduced**: the take's first J is note 61/chromatic with the checkpoint and 60/scale without it |
| 1b live take == re-simulated session log | **PASS** — 10 events identical on *every* field (note, freq, velocity, duration, gated, pan, fx, chord, tune, tag) |
| 2 session replay determinism + sensitivity | **PASS** — same log twice identical; perturbing one keystroke *does* change the result |
| 3 tempo: no duplicate or out-of-order scheduling | **PASS** — 120→240: beat 0.29 @0.1450 s then beat 0.31 @0.1525 s, **no inversion**; 120→70 boundary gap 13.6 ms (no hole); 0 duplicates and beat-order monotonic across 4 runs; 26 slider steps leave 2 segments; `setOrigin` resync; tab-return does not replay the past |
| 4 note held through Enter keeps its real length | **PASS** — committed at 0.45 s, keyup corrects to 1.5 s; replay 1.5 s |
| 5 take survives a full ring, STOP and further typing | **PASS** — 39,990 scratch at RECORD, **45,000/45,000** after STOP and still 45,000 after 10,000 more scratch events |
| 5b take overflow: warn once, drop nothing | **PASS** — pushed 120,500 against a 120,000 limit, kept 120,501, flagged once |
| 6 scratch replay restores its opening settings | **PASS** — from bpm170/cx95/noise/OFF to bpm96/cx20/minimal/STRONG |
| 7 CLEAR ALL refused while recording | **PASS** — `clearBtn.disabled === true`, button click and a direct `CLEAR_ALL` both refused |
| 8 stale release timer cannot cut a reused key | **PASS** — the old note's timer is cancelled; firing every stale timer does not release the new `live:0` |
| 9 Backspace is a note, not an undo | **PASS** |
| 10 IME confirm ignored; held-key guard reports correctly | **PASS** — `hasHeldKeys` true while down, false after keyup |
| 11 boot sequence | **PASS** — shipped disabled, exactly one click, first click after `MODULE_READY` |

### Manual checks in Chrome

- **Boot.** `H01 → M01 → M02 → M03 → M04 → C01 → B01 → A01 → A02 → L01 →
  APP_READY`, one click. `session_start` carries `formatVersion 3`,
  `engineVersion poc-5`, and a checkpoint with all ten
  `performanceState` fields and all eight `loopState` fields.
- **Held-key RECORD guard.** Pressing RECORD with a key down was refused with
  「すべてのキーを離してからRECORDしてください」 and `recorder.recording`
  stayed false. Releasing the key and pressing again started normally.
- **The counter-example, live.** Beat layer running → J → RECORD → J: the
  take's first J is **note 61 / chromatic**, i.e. the state from before RECORD
  was carried into the take.
- **Live take vs real-time REPLAY, identical on the verified projection**
  (performance events + layer projection; not audio samples). After the take, layers 0
  and 1 were cleared, BPM set to 92 and Sound to `noise`. REPLAY restored the
  pre-existing Beat layer immediately from the checkpoint, restored
  bpm 144 / cx 40 / electronic, and rebuilt both layers **exactly** — kind,
  `lengthBeats`, `anchorBeat` and every note's beat, pitch, velocity, duration
  and tag matched the live take with **zero** differences.
- **Static checks.** `node --check` passes on all 18 JavaScript files. No
  `Math.random()` anywhere (only the comments that say so). No console errors
  across a full session.

---

## Known weaknesses

- **Level 2 is best effort, not a guarantee** (see above). The synth's shared
  delay-feedback control, pause macro and tempo-locked delay time are not part
  of a performance event, so ambience can differ slightly between renderings of
  the same notes.
- **A tempo change takes effect at the end of the queued lookahead**, up to
  150 ms later, by design: that is what keeps the schedule monotonic. Measured
  in the self-tests: no duplicates, no inversion, and a 13.6 ms boundary gap
  when slowing 120→70 (i.e. the natural spacing, not a hole). The UI shows the
  new tempo immediately; the loops arrive at it on the next boundary.
- **The SoundEngine's delay time is re-locked immediately on a tempo change**,
  not scheduled to the same boundary as the loops. For up to one lookahead the
  echoes are at the new tempo while the loop is still at the old one. Audible
  only on large jumps; scheduling it as AudioParam automation is v0.3 work.
- **Live notes are not quantized** — Timing applies when a phrase becomes a
  loop. Quantizing live would delay every note by up to 125 ms and wreck the
  feel of playing. So a phrase can sound slightly different live than looping.
- **CLEAR ALL discards a finished take** along with everything else, so export
  before clearing. It is refused outright while recording.
- **The mapping is unbalanced for prose** (see the distribution table above).
- **REPLAY reconstructs text from physical keys**, so a Japanese IME session
  replays as `fujirokku`, not `フジロック`. The musical events are reproduced
  (Level 1); the ambience around them is best effort. The real text is in
  `text.txt`.
- **Enter commits everything pending** — no partial commit, no undo for a commit.
- **Layer length is auto-fitted** (1–8 bars) with no manual override.
- **No session import UI.** The format is replayable and `simulateSession()`
  reads it, but there is no "open a session file" button yet.
- **Voices are synthesised per note** with no voice cap; very dense typing over
  four busy layers will eventually cost CPU.
- **The loop scheduler is a `setInterval`**, which browsers throttle in
  background tabs. The app now warns when the tab is hidden, but the real fix is
  an AudioWorklet clock.
- **Note durations inside loops are stored in seconds**, not beats, so changing
  the tempo stretches the loop without stretching the individual notes.

---

## Not in v0.2.2 (deliberately)

Spotify · Ableton · MIDI export · WAV import · microphone sampling · AI ·
cloud · login · collaboration · full DAW · AudioWorklet migration.

---

## License

**No open-source license is granted. All rights reserved.**

This repository is public for **evaluation and discussion** — so the design and
the code can be read and talked about — not as an open-source release.

Nothing here removes the limited rights GitHub's
[Terms of Service](https://docs.github.com/site-policy/github-terms/github-terms-of-service)
give every user of a public repository: you may view the source and fork it
within GitHub. Beyond that, **no additional permission is granted** to modify,
redistribute, sublicense or reuse this work.

A licence may be chosen for a later release. If you want to do something with
this code before then, please ask.
