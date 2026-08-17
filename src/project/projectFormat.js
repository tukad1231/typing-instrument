// ---------------------------------------------------------------------------
// PROJECT FORMAT  --  what a saved piece of music actually is.
//
// -- WHY THIS IS NOT THE SESSION FORMAT -------------------------------------
// The Session Event Log is the performance: one timeline of everything the
// player did, and the canonical document an export is built from. A PROJECT is
// a workspace that HOLDS a performance, plus the things a performance has no
// opinion about -- what the piece is called, when it was last opened, and the
// song sections the player has set up.
//
// Keeping them apart is what lets the project format move (sections, titles,
// whatever v0.4 needs) without touching the format that guarantees Level 1
// determinism. PROJECT_FORMAT_VERSION and FORMAT_VERSION are therefore
// separate numbers on purpose.
//
// -- WHAT IS CANONICAL AND WHAT IS A CACHE ----------------------------------
//   sessionEvents   CANONICAL. Replaying it reproduces the piece.
//   state           A CACHE. The engine state at save time, so that opening a
//                   project is instant and silent instead of a replay of
//                   everything that ever happened. It can always be thrown
//                   away and recomputed from sessionEvents; if the two ever
//                   disagree, sessionEvents wins.
//   hash            Performance identity only. A title change does not alter it.
//   documentHash    Integrity of the entire saved document. Storage verification
//                   and last-known-good recovery use this hash, because losing a
//                   section or a mixer setting is still data loss.
// ---------------------------------------------------------------------------

import { deepClone, hashValue, isStorable, clamp } from '../core/hash.js';
import { FORMAT_VERSION, ENGINE_VERSION, MIN_READABLE_FORMAT_VERSION } from '../session/sessionEvents.js';

export const PROJECT_FORMAT_VERSION = 1;

/** refuse anything absurd long before it reaches IndexedDB */
export const LIMITS = {
  title: 120,
  text: 200000,
  events: 200000,
  sections: 32,
  sectionName: 40,
};

const ID_ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';

/**
 * A project id is storage identity, not musical input. It must be unique across
 * tabs: a timestamp plus per-page counter can collide when two tabs create a
 * piece in the same millisecond and overwrite one another in IndexedDB.
 */
let idCounter = 0;
export function makeProjectId(now = Date.now()) {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return 'p-' + crypto.randomUUID();
  }
  let t = Math.floor(now);
  let s = '';
  while (t > 0) {
    s = ID_ALPHABET[t % 32] + s;
    t = Math.floor(t / 32);
  }
  idCounter = (idCounter + 1) % 1024;
  return 'p' + s + '-' + idCounter.toString(32).padStart(2, '0');
}

/** "Untitled — 2026-08-17 14:03", which is unique enough to tell two apart */
export function defaultTitle(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return (
    'Untitled — ' +
    date.getFullYear() + '-' + p(date.getMonth() + 1) + '-' + p(date.getDate()) +
    ' ' + p(date.getHours()) + ':' + p(date.getMinutes())
  );
}

/** "Title — Variation 2", counting past whatever variations already exist */
export function variationTitle(title, existing = []) {
  const base = String(title).replace(/\s+—\s+Variation\s+\d+$/u, '');
  let n = 2;
  const taken = new Set(existing.map((t) => String(t)));
  while (taken.has(`${base} — Variation ${n}`) && n < 999) n++;
  return `${base} — Variation ${n}`;
}

/** the part a hash is taken over: the performance, and nothing else */
export function canonicalPart(p) {
  return {
    sessionEvents: p.sessionEvents || [],
    initialSettings: p.initialSettings || null,
  };
}

export function projectHash(p) {
  return hashValue(canonicalPart(p));
}

/** Every persisted field that must survive a save, excluding the hash itself. */
export function documentPart(p) {
  return {
    projectFormatVersion: p.projectFormatVersion,
    sessionFormatVersion: p.sessionFormatVersion,
    engineVersion: p.engineVersion,
    projectId: p.projectId,
    revision: p.revision,
    title: p.title,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
    lastOpenedAt: p.lastOpenedAt,
    initialSettings: p.initialSettings || null,
    settings: p.settings || null,
    text: typeof p.text === 'string' ? p.text : '',
    sessionEvents: p.sessionEvents || [],
    state: p.state || null,
    story: p.story || { sections: [], currentId: null },
    ui: p.ui || {},
    stats: p.stats || {},
    performanceHash: projectHash(p),
  };
}

export function documentHash(p) {
  return hashValue(documentPart(p));
}

/**
 * Build a project record. Everything is deep-copied on the way in, so a saved
 * project can never be mutated afterwards by the engines it came from.
 */
export function makeProject(input = {}) {
  const now = new Date();
  const iso = now.toISOString();
  const p = {
    projectFormatVersion: PROJECT_FORMAT_VERSION,
    sessionFormatVersion: FORMAT_VERSION,
    engineVersion: ENGINE_VERSION,
    projectId: input.projectId || makeProjectId(now.getTime()),
    revision: 1,
    title: cleanTitle(input.title || defaultTitle(now)),
    createdAt: input.createdAt || iso,
    updatedAt: input.updatedAt || iso,
    lastOpenedAt: input.lastOpenedAt || iso,
    initialSettings: deepClone(input.initialSettings || null),
    settings: deepClone(input.settings || null),
    text: String(input.text || '').slice(0, LIMITS.text),
    sessionEvents: deepClone(input.sessionEvents || []),
    state: deepClone(input.state || null),
    story: normaliseStory(input.story),
    ui: deepClone(input.ui || {}),
    stats: deepClone(input.stats || {}),
    hash: '',
    documentHash: '',
  };
  p.hash = projectHash(p);
  p.documentHash = documentHash(p);
  return p;
}

export function cleanTitle(t) {
  // Control characters out, length capped, never empty. The title is rendered
  // with textContent everywhere, so this is about sanity rather than about
  // escaping -- but a title containing a newline still breaks every list it
  // appears in, and one containing only spaces looks like a bug.
  const s = String(t == null ? '' : t)
    .replace(/[\u0000-\u001F\u007F]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, LIMITS.title);
  return s || defaultTitle();
}

export function normaliseStory(story) {
  const src = story && Array.isArray(story.sections) ? story.sections : [];
  const sections = src.slice(0, LIMITS.sections).map((s, i) => ({
    id: typeof s.id === 'string' && s.id ? s.id.slice(0, 40) : 'sec-' + i,
    name: String(s.name == null ? 'SECTION' : s.name)
      .replace(/[\u0000-\u001F\u007F]/gu, ' ')
      .trim()
      .slice(0, LIMITS.sectionName) || 'SECTION',
    mix: Array.isArray(s.mix)
      ? s.mix.slice(0, 16).map((m, j) => ({
          layer: Number.isInteger(m && m.layer) ? m.layer : j,
          on: !!(m && m.on),
          muted: !!(m && m.muted),
          volume: clamp(typeof (m && m.volume) === 'number' && Number.isFinite(m.volume) ? m.volume : 1, 0, 1),
        }))
      : [],
  }));
  return { sections, currentId: typeof (story && story.currentId) === 'string' ? story.currentId : null };
}

/**
 * Validate a document that came from OUTSIDE -- a file the user picked, or a
 * record read back from a store that may have been written by a different
 * version.
 *
 * The contract this has to keep is the important part: it either returns a
 * clean project, or it returns an error and CHANGES NOTHING. It never repairs
 * a document in place and never hands back a half-accepted one, because the
 * caller's next move on success is to replace whatever the user is currently
 * looking at.
 *
 * @returns {{ok: true, project: object, warnings: string[]} | {ok: false, error: string}}
 */
export function validateProject(raw, opts = {}) {
  const warnings = [];
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'This file is not a Typing Instrument project.' };
  }

  const v = raw.projectFormatVersion;
  if (!Number.isInteger(v)) {
    return { ok: false, error: 'This file is not a Typing Instrument project (no project version).' };
  }
  if (v > PROJECT_FORMAT_VERSION) {
    return {
      ok: false,
      error:
        `This project was saved by a newer version of Typing Instrument ` +
        `(project format ${v}, this build reads ${PROJECT_FORMAT_VERSION}). Update, then open it again.`,
    };
  }
  if (v < 1) return { ok: false, error: `Unsupported project format ${v}.` };

  if (!Array.isArray(raw.sessionEvents)) {
    return { ok: false, error: 'The project has no performance in it (sessionEvents is missing).' };
  }
  if (raw.sessionEvents.length > LIMITS.events) {
    return { ok: false, error: `Too large: ${raw.sessionEvents.length} events, the limit is ${LIMITS.events}.` };
  }
  for (let i = 0; i < raw.sessionEvents.length; i++) {
    const e = raw.sessionEvents[i];
    if (!e || typeof e !== 'object' || typeof e.type !== 'string' || typeof e.time !== 'number' || !Number.isFinite(e.time)) {
      return { ok: false, error: `Event ${i} is malformed.` };
    }
  }

  const sfv = raw.sessionFormatVersion;
  if (Number.isInteger(sfv)) {
    if (sfv > FORMAT_VERSION) {
      return {
        ok: false,
        error: `This project holds a session format (${sfv}) newer than this build understands (${FORMAT_VERSION}).`,
      };
    }
    if (sfv < MIN_READABLE_FORMAT_VERSION) {
      return { ok: false, error: `Session format ${sfv} is too old to open.` };
    }
    if (sfv < FORMAT_VERSION) {
      warnings.push(`opened from session format ${sfv} (this build writes ${FORMAT_VERSION})`);
    }
  } else {
    warnings.push('no session format version recorded; assuming the current one');
  }

  if (typeof raw.text === 'string' && raw.text.length > LIMITS.text) {
    return { ok: false, error: 'The typed text in this project is too large.' };
  }
  if (!isStorable(raw.sessionEvents)) {
    return { ok: false, error: 'The performance data contains values that cannot be stored.' };
  }

  // Check the bytes we received BEFORE normalising them. Recomputing a hash on
  // the rebuilt object and comparing that rebuilt object with itself used to
  // turn a corrupt record into a healthy-looking one.
  const expectedPerformanceHash = projectHash(raw);
  if (typeof raw.hash === 'string' && raw.hash && raw.hash !== expectedPerformanceHash) {
    return { ok: false, error: 'The performance integrity check failed.' };
  }
  const expectedDocumentHash = documentHash(Object.assign({}, raw, { hash: expectedPerformanceHash }));
  if (typeof raw.documentHash === 'string' && raw.documentHash) {
    if (raw.documentHash !== expectedDocumentHash) {
      return { ok: false, error: 'The project integrity check failed.' };
    }
  } else if (opts.requireIntegrity) {
    return { ok: false, error: 'The saved project has no complete integrity check.' };
  } else {
    warnings.push('opened a legacy project without a complete document integrity check');
  }

  // Rebuild rather than accept: unknown fields are dropped here, which is what
  // makes "a newer minor version added a field" a non-event.
  const project = makeProject({
    projectId: typeof raw.projectId === 'string' ? raw.projectId.slice(0, 64) : undefined,
    title: raw.title,
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : undefined,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : undefined,
    lastOpenedAt: typeof raw.lastOpenedAt === 'string' ? raw.lastOpenedAt : undefined,
    initialSettings: raw.initialSettings,
    settings: raw.settings,
    text: typeof raw.text === 'string' ? raw.text : '',
    sessionEvents: raw.sessionEvents,
    state: raw.state,
    story: raw.story,
    ui: raw.ui && typeof raw.ui === 'object' && !Array.isArray(raw.ui) ? raw.ui : {},
    stats: raw.stats && typeof raw.stats === 'object' && !Array.isArray(raw.stats) ? raw.stats : {},
  });
  project.revision = Number.isInteger(raw.revision) && raw.revision > 0 ? raw.revision : 1;
  project.hash = projectHash(project);
  project.documentHash = documentHash(project);
  return { ok: true, project, warnings };
}

/** the row shown in the library: cheap to read, nothing heavy in it */
export function projectSummary(p) {
  return {
    projectId: p.projectId,
    title: p.title,
    updatedAt: p.updatedAt,
    createdAt: p.createdAt,
    lastOpenedAt: p.lastOpenedAt,
    revision: p.revision,
    stats: deepClone(p.stats || {}),
    soundSet: (p.settings && p.settings.soundSet) || (p.initialSettings && p.initialSettings.soundSet) || 'electronic',
  };
}

/** the file a user downloads as a backup */
export function toExportFile(p) {
  return {
    kind: 'typing-instrument-project',
    projectFormatVersion: PROJECT_FORMAT_VERSION,
    sessionFormatVersion: p.sessionFormatVersion,
    engineVersion: p.engineVersion,
    exportedAt: new Date().toISOString(),
    project: deepClone(p),
  };
}

/** accepts either the wrapper above or a bare project object */
export function fromExportFile(raw) {
  if (raw && typeof raw === 'object' && raw.project && typeof raw.project === 'object') {
    return validateProject(raw.project);
  }
  return validateProject(raw);
}

export function safeFileName(title) {
  const s = String(title)
    .replace(/[^\p{L}\p{N}\-_ ]/gu, '')
    .replace(/\s+/gu, '_')
    .slice(0, 60);
  return (s || 'project') + '.tiproj.json';
}
