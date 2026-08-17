# SAMPLER — design, and why it is not in v0.3

**Status: designed, deliberately not implemented.**

There is no sampler button in v0.3, no disabled control, and no "Coming soon"
badge. A feature you can see but cannot use is a worse experience than one that
is not there, and a half-built sampler is worse than either: it would let people
put work into an asset pipeline whose lifecycle rules had not been settled, and
the first time a project was duplicated or deleted their sounds would go missing.

The bar for shipping it is written below. Every line has to be true at once,
because the failures interact — the delete rule and the duplicate rule and the
export rule are one problem, not three.

---

## Why it is worth doing

The instrument's claim is that typing skill becomes playing skill. That claim is
about the PERFORMANCE layer, and it is independent of what makes the sound. A
sampler is the honest next step: your own voice, a snare from a record, a door
closing — mapped onto the same fixed key roles, played with the same hands.

It is also the only feature on the list that changes what the instrument IS
rather than what it can do.

## Why not yet

Sampling drags in a whole second kind of data. Everything the project format
handles today is small, structured, and describable in JSON. An audio asset is
none of those. It is large, opaque, shared between projects, and it has a
lifecycle: it can be added, referenced from several places, orphaned, and it has
to survive an export/import round trip taken on a different machine.

Getting that wrong is not a cosmetic bug. It is somebody opening a piece they
made last month and finding it silent.

---

## Data model

### Asset

Stored in its own IndexedDB object store, `assets`, keyed by content hash:

```
{
  assetId:   'sha256-<64 hex>',   // the key IS the content hash
  bytes:     Blob,                // the decoded-once, original file bytes
  mime:      'audio/wav',
  bytesLen:  1048576,
  duration:  1.83,                // seconds, from decodeAudioData
  channels:  2,
  sampleRate: 48000,
  createdAt: '2026-..',
  refCount:  2                    // how many projects reference it
}
```

**Content-addressed, not name-addressed.** The same file imported twice is one
asset, and the filename is never the identity. That is what makes deduplication
free and makes an export/import round trip land on the same asset id on another
machine.

### Reference, inside a project

```
{
  assetId: 'sha256-...',
  label:   'my snare',      // user-facing, editable, NOT the identity
  role:    'drum',          // which key zone it replaces
  mode:    'one-shot' | 'gate' | 'loop',
  gain:    1.0,
  tune:    0,               // semitones
  trim:    { start: 0.0, end: 1.83 }
}
```

### What a Session Event may carry

**Only the `assetId`.** Never a filename, never a local path, never an object
URL.

This is not a style preference. `session-events.json` is a document people
export and send to each other, and a filename is personal information
(`C:\Users\haruka\Desktop\demo\voice.wav` names a person and their machine). A
content hash names the audio and nothing else.

---

## Determinism

Level 1 is "same session log → same PerformanceEvent list", and a sampler must
not weaken it.

- A PerformanceEvent gains one optional field, `assetId`. Everything else about
  note selection, timing and expression is unchanged.
- The PerformanceEvent list is therefore still a pure function of the log. A
  missing asset changes what you HEAR (Level 2), never what was PLAYED
  (Level 1).
- Playback offsets inside a sample are derived from the event, exactly as the
  existing deterministic noise offsets are. No `Math.random()`, no wall clock.

### A missing asset is announced, never substituted

If a referenced asset is not present, the note is **silent** and the track says
so — "3 sounds missing". Quietly falling back to the synth is the single worst
option available: the piece would play, sound wrong, and give no hint why.

---

## Lifecycle

This is the part that has to be right, and it is the reason for the wait.

| event | what happens to the asset |
|---|---|
| import a file | hash it; if the hash exists, reuse it and `refCount++`; otherwise store it with `refCount = 1` |
| duplicate a project | every reference is copied; `refCount++` per referenced asset. **No bytes are copied.** |
| delete a reference | `refCount--` |
| delete a project | `refCount--` for each reference it held |
| `refCount` reaches 0 | the asset becomes eligible for collection — **not deleted immediately** |
| collection | runs at startup, not during play, and only over assets whose `refCount` has been 0 for more than 7 days |

The delay matters: deleting a project is UNDOABLE, and an undo that brings the
project back without its sounds is not an undo.

`refCount` is derived state and can be wrong after a crash, so it is
**recomputed** from the actual set of projects at startup rather than trusted.
A count that is only ever incremented and decremented will eventually be wrong;
one that is recomputed cannot be.

---

## Export and import

- `Download project` embeds every referenced asset, base64-encoded, inside the
  same JSON file. One file, no folder, nothing to lose. Size is the price.
- Import verifies each embedded asset by re-hashing its bytes and comparing to
  its `assetId`. **A hash mismatch rejects the whole file**; a partially trusted
  import is not a thing.
- An asset already present is not re-stored; the reference simply joins it.
- Round-trip test: export → import → the session log hash and the
  PerformanceEvent list are identical, and every `assetId` resolves.

---

## Safety limits

| limit | value | why |
|---|---|---|
| max file size | 10 MB | above this the base64 export becomes unusable |
| max total assets per project | 32 | four roles, room to experiment |
| max store size | 400 MB, with a warning at 300 MB | browsers evict origin data under pressure; better to refuse than to be silently evicted |
| accepted MIME | `audio/wav`, `audio/x-wav`, `audio/mpeg`, `audio/ogg`, `audio/flac` | and the extension is never trusted — `decodeAudioData` is the real test |
| decode failure | reject, change nothing | a file that will not decode must not half-import |

Object URLs are created only for the duration of a decode and revoked in a
`finally`. Nothing holds one across a render.

---

## UI

One new field in the Inspector, under the sound world:

```
Your own sounds
  [ + Add a sound ]        (nothing else until one exists)

  my snare       drum · one-shot · 0.4s      [play] [role] [remove]
  breath         voice · gate    · 1.8s      [play] [role] [remove]
```

- No file browser of the user's disk, no drag-and-drop onto the play surface
  (too easy to trigger by accident while playing).
- `role` picks which key zone the sound replaces. The key MAPPING never changes —
  the same principle every Sound World follows.
- Removing a sound is undoable through the ordinary toast.
- A missing asset shows as `⚠ missing` with the option to re-import the file.

---

## Test plan

Everything below has to pass before this ships.

1. the same file imported twice produces one asset and two references
2. `refCount` recomputed from scratch matches the incremental count after a
   random sequence of add/duplicate/delete operations
3. deleting a project decrements, and UNDO within the window restores both the
   project and its access to the assets
4. an asset with `refCount = 0` is still present the next day and gone after
   seven
5. export → import on an empty store restores every asset, byte for byte
6. import with one asset's bytes corrupted rejects the entire file and changes
   nothing
7. a project referencing a missing asset opens, plays silently for that role,
   and says which sounds are missing
8. Level 1: the PerformanceEvent list is identical with and without the assets
   present
9. a session log containing `assetId` values replays identically twice
10. no filename or local path appears anywhere in `session-events.json`
11. object URLs created during import are all revoked
12. a 10 MB file is accepted; a 10.1 MB file is refused with a readable reason
13. a `.wav` that is really a text file is refused at `decodeAudioData`
14. quota exhaustion during import leaves the store consistent and the current
    project untouched
15. it all still works on GitHub Pages with no build step and no dependencies

---

## What would change elsewhere

- `PROJECT_FORMAT_VERSION` → 2 (adds `assets` and `soundRefs`).
- `FORMAT_VERSION` → 5 **only if** a session event gains a field. `assetId` on a
  PerformanceEvent alone does not require it, because PerformanceEvents are not
  session events.
- `soundSets.js` gains `model: 'sampler'`, which is the extension point the file
  was written around from the start.
