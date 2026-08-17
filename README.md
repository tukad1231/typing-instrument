# TYPING INSTRUMENT  ·  v0.3.1 Creator Alpha

**Typing is the instrument.**

For people who type fast but have never played anything. You already own the
skill: speed, accuracy, two independent hands, rhythm, and years of muscle
memory for where every key is. This turns that skill into playing, without
asking you to learn a keyboard, a chord chart, or a DAW first.

It is not a "press a key, hear a sound" toy, and it is not an AI that writes
music for you. It is an instrument you get better at.

> **日本語で弾き方を知りたい方へ → [演奏ガイド（PLAYER_GUIDE_JA.md）](PLAYER_GUIDE_JA.md)**
> キー配置、設定の意味、レイヤーの積み方、曲の作例まで日本語で説明しています。

---

## 1. What you can do

- **Play** — every key is an instrument. How long you hold one is how long the
  note lasts; how fast, how steadily and with which hand you type all change
  what comes out. Nothing is random.
- **Loop** — type a phrase, press <kbd>Enter</kbd>, and it starts repeating.
  Four tracks.
- **Shape it into a song** — save mixes as **sections** (INTRO, BUILD, FULL,
  SPACE, END) and perform the arrangement by pressing them, live.
- **Come back to it** — pieces save themselves, in this browser, automatically.
  Close the tab and pick up where you left off.
- **Capture and export** — record a take and get the audio plus the complete
  performance log as a zip.

**New in v0.3:** a local project library with autosave and Continue · **Piano**
and **Plucked** sound worlds that decay by themselves · the Story Strip ·
starter kits and a guided first session · undo for every destructive action ·
a rebuilt interface.

**New in v0.3.1:** Japanese/English UI switching and **DUSK PIANO**, an
original downtempo starter with restrained piano, a dusty beat and three empty
tracks left for the player. UI language is a local preference only: it never
enters the session log and cannot change replay output.

---

## 2. Using the hosted build

Open it in a modern browser and press **NEW PIECE**. There is nothing to
install, no account, and no build step — it is plain ES modules served as files.

Headphones recommended.

### Running it from this repository

Use a currently supported Node.js LTS release; this build was tested with
Node.js 24 LTS.

**Double-click `start.bat`.** It starts the local server and opens the browser.

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

> **Do not double-click `index.html`.** Opening it directly (`file://`) makes
> the browser block the ES module imports. The page detects this and says so,
> but the fix is always the same: use `start.bat`.

Add `?debug=1` to the URL for Developer Mode, which reveals the debug panel and
the self-test button.

---

## 3. Two minutes to your first piece

1. **NEW PIECE**, then pick a starting sound. Four kits: NEON PULSE
   (electronic, clear beat), WARM KEYS (piano, room to breathe), WOOD & WIRE
   (plucked, short and repeatable), EMPTY CANVAS (nothing but you).
   A kit sets up a room to play in — the music is still all yours.
2. **Type.** 8 to 24 keys. Right hand for melody, left for drums.
3. **Press <kbd>Enter</kbd>.** What you just played becomes TRACK 1 and starts
   looping.
4. **Type something different** and press <kbd>Enter</kbd> again — lower,
   sparser, or the other hand. That contrast is what makes it music rather than
   a texture.
5. **Story → Suggest a shape.** You get INTRO / BUILD / FULL / SPACE / END built
   from what you actually made. Press them in order and listen to it become a
   song.
6. **Capture**, play the arrangement, **Stop**, **Export**.

The guide on screen walks through the same seven steps and cannot be skipped by
clicking — each step completes when the instrument says it did.

---

## 4. Saving, and what that means

Pieces save themselves as you work. The state is shown in the top bar:
`Unsaved` → `Saving…` → `Saved`. **`Saved` appears only after the piece has been
written and read back with matching performance and whole-document hashes** —
never optimistically. If the newest document is damaged, the previous verified
copy is opened instead.

- Everything is stored **in this browser, on this computer**, in IndexedDB.
- **Nothing is uploaded.** There is no backend, no account, and the app makes no
  network requests at all while you play.
- **Clearing your browser's site data deletes your pieces.** So does using a
  private window, where saving may not be available at all — the app says so
  rather than pretending.
- **Use `Download project` for a backup you keep yourself.** It writes the whole
  piece as one JSON file you can open on another machine.

If a save ever fails, the top bar says `Save failed`, offers **Download a
backup**, and the piece stays fully playable. The previously verified copy is
kept as a fallback and is never overwritten by a failed write.

### Project ≠ Capture

Two different things, deliberately named differently:

| | what it is | when to use it |
|---|---|---|
| **Download project** | the whole piece — every track, section, setting and the full performance log | backup, or moving to another machine |
| **Export** | one recorded take — the audio, the text, and every key and control on one timeline | sharing a performance, or analysing it |

---

## 5. Sound Worlds

A Sound World is `synthesis model + timbre + tonal material + character`.
Picking one also picks the scale and root it is paired with, so changing the
sound gives you a genuinely different piece rather than a filtered version of
the same one. What a Sound World may **not** change is which key plays which
role — muscle memory carries across all five.

| world | model | what it rewards |
|---|---|---|
| **Electronic** | held | speed and density. The forgiving one. |
| **Piano** | struck | phrasing, and the gaps you leave |
| **Plucked** | struck | short figures you repeat |
| **Minimal** | held | soft, lo-fi, room-y |
| **Noise** | held | harsh, industrial, loud |

### Held vs struck, and what "hold a key" means

- On **Electronic / Minimal / Noise**, a sustaining role (bass, melody, chord,
  voice) holds at a steady level for as long as the key is down, then releases.
- On **Piano** and **Plucked**, a note is loudest the instant it is struck and
  **decays from there — including while you are still holding the key**.
  Letting go does not cut it off: it **damps** it, over about 0.24 s at the
  bottom of the range and 0.09 s at the top, the way felt on a real instrument
  does. Low notes ring for seconds; the top octave is gone in about one.
  Holding a key therefore delays the damping; it does not sustain a level.
- **Drums, FX and bells are one-shots in every world.** They finish on their own
  schedule and never wait for a key to come up, so a held drum key can never
  leave anything ringing.

Both struck models are synthesised — no samples, no downloads, no network. Piano
uses six slightly inharmonic partials that each decay at their own rate; Plucked
uses a short deterministic excitation into a body filter that closes as it
decays. The same event always produces the same sound.

Nothing is left ringing: window blur, the tab going away, **Stop**, **Clear**,
stopping a replay and switching pieces all end in silence, and a key that was
down when focus was lost is released through the ordinary path — so the log
records a real key-up at the moment it happened.

---

## 6. The Story Strip

Stacking four loops gives you a texture, not a song. What a song has is
**change over time**.

A full DAW answers that with an arrangement timeline. That is the wrong answer
here for one specific reason: it stops being a performance. You would be editing
the piece instead of playing it.

So a **section** is not a region on a timeline — it is a saved **mix** (which
tracks are on, muted, and how loud) with a name. Pressing a section applies that
mix right now, live, as a performance gesture. The strip is the set of gestures
you have prepared; playing the piece means pressing them in order, by hand, on
the beat. In Perform view they become big buttons.

Sections are yours to edit: save the current mix into one, rename, duplicate,
reorder, delete. **Suggest a shape** proposes five from what is actually in your
tracks — a starting point, not a rule.

Pressing a section writes ordinary `layer_on` / `layer_mute` / `layer_volume`
events into the log, in a fixed order, always the complete mix. That is why the
same section pressed twice does the same thing, and why a replay reproduces the
arrangement exactly. There is no AUTO ARRANGE and no generated structure.

---

## 7. Export

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

Every file carries `formatVersion` (**4**) and `engineVersion` (`poc-6`).

**Format 4** adds one event type, `restore_layer`, which is what makes deleting
a track undoable without lying to the log — see
[`src/session/sessionEvents.js`](src/session/sessionEvents.js) for why a generic
"undo" event was rejected. **Format 2 and 3 logs still open and still replay**:
every reader skips types it does not know, and an older log is simply a log
without that event in it. Checked by self-test 31.

A saved project carries its own `PROJECT_FORMAT_VERSION` (**1**), separate from
the session format on purpose — so the project format can move without touching
the format that guarantees determinism.

---

## 8. How it works, and what is guaranteed

### Levels of determinism

| level | claim | status |
|---|---|---|
| **1** | same session log + settings → **same PerformanceEvent list** | **GUARANTEED**, and self-tested |
| **2** | same PerformanceEvent list → **audibly the same music** | best effort |
| **3** | bit-identical audio samples | **not claimed**, and not a goal |

Level 2 is deliberately not a guarantee: the sound engine holds state that is
not part of any performance event — one shared delay feedback written by every
note, the pause macro, and the tempo-locked delay time. Two renderings of the
same `performance.json` agree on every note and can still differ slightly in
ambience.

There is no `Math.random()` anywhere in the project. Everything that looks
random — noise buffers, reverb impulses, the plucked excitation — comes from a
fixed seed or from the note itself. Self-test 29 reads every shipped module back
off the server and checks.

### The session log is the document

Every user action — typing, tempo, sound, mute, volume, presets, sections —
goes through `SessionEngine.dispatch()`, which **records the event and then
applies it**. Replay re-applies the same log through the same handlers. There is
no second code path, which is why what you hear and what gets exported cannot
drift apart.

A saved project keeps that log as its canonical content and the engine state
only as a cache. Opening reduces the log through a headless, silent instrument
and imports the resulting state into the live audio engine. No historical note
is sounded during that reduction, and a stale cache can never overrule the log.

### Architecture

```
src/
  input/inputEngine.js         physical keys -> RawTypingEvent (knows no music)
  perf/mapping.js              which key is which instrument   (pure data)
  perf/scale.js                pitch material                  (pure data)
  perf/performanceEngine.js    typing -> musical intention      <- the soul
  perf/performKey.js           the one path a keystroke takes
  sound/soundSets.js           five Sound Worlds               (pure data)
  sound/soundEngine.js         performance events -> Web Audio (knows no keys)
  loop/loopEngine.js           phrases, layers, the BEAT grid
  loop/builtinLoops.js         the foundations you can drop in
  session/sessionEvents.js     the vocabulary of a performance
  session/sessionEngine.js     one timeline, one code path, replay
  session/simulate.js          headless re-run of a session log
  project/projectFormat.js     what a saved piece IS, and validation
  project/projectStore.js      IndexedDB, with a verified fallback copy
  project/projectController.js autosave, the library, import/export
  story/storyStrip.js          sections: a mix you can perform
  ui/tracksView.js             the four track cards + the timeline
  ui/commitLoop.js             the button and the key are the same gesture
  ui/starterKits.js            four rooms to play in
  ui/guidedJam.js              the first session, driven by real state
  ui/nextMove.js               one suggestion, never a checklist
  ui/dom.js                    user text is text, never markup
  record/recorder.js           audio capture + session export
  record/zip.js                dependency-free ZIP writer
  tests/selfTest.js            the promises, checked in the browser
  tests/fixture.js             a whole instrument nobody is listening to
  tests/probes.js              a recording AudioContext, for envelope tests
  main.js                      wiring and screens
tools/
  analyzeTypingDistribution.js key-frequency analysis of real text
docs/
  SAMPLER_DESIGN.md            designed, deliberately not implemented
```

The hard boundary is still between **Performance Engine** and **Sound Engine**:
the performance engine never touches Web Audio; the sound engine never sees a
key code, a keys/sec value or a word. The UI never reaches into an engine's
arrays — it reads `composerSnapshot()`, which hands out deep copies and computes
every derived number so that no rule constant is written down twice.

### Tempo is musical, not wall-clock

Layer length, anchor and every note inside a layer are stored in **beats**.
Seconds are derived at playback from the current tempo, and the tempo map is
piecewise: each `setBpm` closes the current segment at the beat it had reached.
That is what lets the tempo move mid-set without the loops sliding off the grid.

### Japanese IME

Performance follows **physical keys**, display follows the IME. Typing
`フジロック` physically plays `f u j i r o k k u`.

While the IME is composing, **Space** means "next candidate" and **Enter** means
"confirm". Those are text operations, not musical ones, so both are ignored
entirely during composition — no sound, no transport. Every other key still
plays. Without this, finishing a Japanese word would commit a loop.

### Keyboard support

Letter-centric JIS and US keyboards. A key is part of the performance only if
the mapping gives it a job — an **allowlist**, not a denylist, which is the only
rule that stays correct as layouts vary. `Convert`, `NonConvert`, `KanaMode`,
`IntlRo`, `IntlYen`, the numpad and every media key are silent and cannot
disturb the performance. `Space`, `Enter`, `NumpadEnter`, `Backspace` and `Tab`
are in the mapping, so they keep working.

### Key distribution in real text

`node tools/analyzeTypingDistribution.js`

| fixture | left | right | Melody | Drums | Bell | Bass |
|---|---|---|---|---|---|---|
| Japanese romaji (lyrics) | 36.5% | 43.6% | **8.3%** | 17.9% | **26.9%** | 16.0% |
| Japanese romaji (prose) | 37.2% | 45.9% | **11.0%** | 23.8% | **25.6%** | 12.2% |
| English prose | 42.0% | 39.4% | **9.5%** | 17.7% | 20.8% | 20.8% |
| Deliberate playing | 26.2% | 60.7% | 60.7% | 26.2% | 0.0% | 0.0% |

**The lead voice is the least-played zone** when people write prose. Left
unchanged on purpose: the last row shows the mapping does what it promises when
you play it as an instrument rather than write with it, and remapping would
throw away the muscle memory of everyone who has already learned it.

---

## 9. Development history

| version | what it was for |
|---|---|
| **v0.3 Creator Alpha** | a tool you come back to: local project library with autosave and Continue, project export/import, Piano and Plucked, the Story Strip, starter kits and a guided first session, undo everywhere, polyphony cap and limiter, a rebuilt interface, and a self-test suite that no longer runs on the user's work |
| v0.2.2 Public Beta | the tempo map rewritten as piecewise segments; take and scratch given separate buffers; stale release timers made harmless |
| v0.2.1 | six release blockers around checkpoints, trimming and replay causality |
| v0.2 | the Session Event Log became the canonical document; RECORD gained a checkpoint so a take replays as the continuous performance it was |
| v0.1 | the proof of concept: typing → PerformanceEvents → Web Audio |

### What v0.3 fixed

| # | defect | fix |
|---|---|---|
| P1 | Self-test 15 drove the **live application** and restored a handful of array lengths. `session.nextId`, the checkpoint counter, the recorder's take buffers, `InputEngine.word`, the caret and the compose panel were all left wherever it put them — and `word` rides inside every logged key event, so running the suite twice made the test fail the second time for a reason unrelated to what it tested. | Tests that drive an instrument now build **their own** (`tests/fixture.js`): real engines, real InputEngine, a detached textarea, its own clock. Self-test 34 takes a deep snapshot of the live app before and after the whole suite and requires them to be identical — not "the arrays are the same length", which is exactly what hid the original bug. |
| P1 | A volume drag that ended **outside the window** never fired `pointerup` on the slider, so rendering stayed suppressed and the next ON / MUTE / DELETE appeared to do nothing. | One `VolumeDrag` owner with `setPointerCapture` plus window-level `pointerup`, `pointercancel`, `blur` and `visibilitychange` listeners. Self-test 15b exercises all five exit paths and checks that ending twice rebuilds once. |
| P1 | `planPendingLayer()` copied a PerformanceEvent with `Object.assign({}, ev)`, sharing `fx` and `chord` — so reading the plan could reach through and retune a note that had not been committed yet. | Structural deep copies everywhere (`deepClone`, which keeps value types rather than round-tripping through JSON). Self-test 17 writes through both the plan and `composerSnapshot()` and asserts the live notes are unchanged. |
| P1 | `clearLayer()` left `anchorBeat`, `on`, `muted` and `volume` behind, so an emptied track quietly remembered state nothing on screen could show, and the next loop to land there inherited it. | A cleared track is blank. Caught by self-test 34. |

---

## Known weaknesses

- **Level 2 is best effort, not a guarantee** (see above).
- **A tempo change takes effect at the end of the queued lookahead**, up to
  150 ms later, by design: that is what keeps the schedule monotonic. The UI
  shows the new tempo immediately; the loops arrive at it on the next boundary.
- **The SoundEngine's delay time is re-locked immediately on a tempo change**,
  not scheduled to the same boundary as the loops. Audible only on large jumps.
- **Live notes are not quantized** — Timing applies when a phrase becomes a
  loop. Quantizing live would delay every note by up to 125 ms and wreck the
  feel of playing.
- **The mapping is unbalanced for prose** (see the distribution table).
- **REPLAY reconstructs text from physical keys**, so a Japanese IME session
  replays as `fujirokku`, not `フジロック`. The musical events are reproduced;
  the real text is in `text.txt`.
- **Enter commits everything pending** — no partial commit.
- **Layer length is auto-fitted** (1–8 bars) with no manual override.
- **Note durations inside loops are stored in seconds**, not beats, so changing
  the tempo stretches the loop without stretching the individual notes.
- **The loop scheduler is a `setInterval`**, which browsers throttle in
  background tabs. The app warns when the tab is hidden; the real fix is an
  AudioWorklet clock.
- **Stop is not part of the performance.** It stops the scheduler and silences
  everything, like turning an amp off, and is deliberately not logged — a replay
  should not stop halfway because somebody hit Stop during the original take.
- **Project delete is undoable only while the toast is on screen** (about nine
  seconds), and only from the screen it happened on.
- **No sampler.** Designed in full in
  [`docs/SAMPLER_DESIGN.md`](docs/SAMPLER_DESIGN.md) and deliberately not built:
  the asset lifecycle rules (deduplication, reference counting, delete, export)
  have to all be right at once, and a half-built one would lose people's sounds.

---

## Not in v0.3 (deliberately)

Spotify · Ableton · MIDI export · WAV import · microphone sampling · AI
composition · cloud sync · login · collaboration · payment · full DAW ·
AudioWorklet migration.

---

## License

**No open-source license is granted. All rights reserved.**

This repository is public for **evaluation and discussion** — so the design and
the code can be read and talked about — not as an open-source release.

Nothing here removes the limited rights GitHub's
[Terms of Service](https://docs.github.com/site-policy/github-terms/github-terms-of-service)
grant to every visitor of a public repository (viewing and forking on GitHub).
