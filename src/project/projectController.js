// ---------------------------------------------------------------------------
// PROJECT CONTROLLER  --  the piece you are working on, kept safe.
//
// Sits between the engines and the store. It owns exactly three things:
//
//   1. WHAT a project snapshot contains (built by the `capture` callback the
//      shell hands in, so this file never has to know about engines);
//   2. WHEN to save (debounced, after a change that means something);
//   3. WHAT THE USER IS TOLD about saving, which is the part that is easy to
//      get dishonest.
//
// On (3): "Saved" is shown only after the store has read the record back and
// confirmed its hash. Showing it optimistically at the moment of the write is
// a lie of exactly the kind that costs someone an evening's work, because it
// is indistinguishable from the truth right up until the moment it matters.
// ---------------------------------------------------------------------------

import { ProjectStore, StoreUnavailable } from './projectStore.js';
import {
  makeProject, validateProject, fromExportFile, toExportFile, safeFileName,
  defaultTitle, variationTitle, cleanTitle, projectHash, documentHash, makeProjectId,
} from './projectFormat.js';
import { deepClone } from '../core/hash.js';

export const SAVE_STATE = {
  IDLE: 'idle',
  DIRTY: 'dirty',
  SAVING: 'saving',
  SAVED: 'saved',
  FAILED: 'failed',
  UNAVAILABLE: 'unavailable',
};

const DEBOUNCE_MS = 1200;
const MAX_DEBOUNCE_MS = 6000; // never let a stream of edits postpone a save forever

export class ProjectController {
  /**
   * @param {object} opts
   * @param {() => object} opts.capture  builds a snapshot of the live piece
   * @param {(state, info) => void} opts.onStatus
   * @param {ProjectStore} [opts.store]
   */
  constructor(opts) {
    this.capture = opts.capture;
    this.onStatus = opts.onStatus || (() => {});
    this.store = opts.store || new ProjectStore();
    this.current = null; // the project record being edited
    this.state = SAVE_STATE.IDLE;
    this.lastError = null;
    this.lastSavedHash = null;
    this._timer = null;
    this._firstDirtyAt = 0;
    this._saving = false;
    this._again = false;
    this._savePromise = null;
    this._generation = 0;
    this.deletedRecord = null; // for UNDO of a project delete
  }

  // --- status ---------------------------------------------------------------
  _setState(state, info) {
    this.state = state;
    this.onStatus(state, info || {});
  }

  get title() {
    return this.current ? this.current.title : '';
  }

  get projectId() {
    return this.current ? this.current.projectId : null;
  }

  // --- lifecycle ------------------------------------------------------------
  /** a brand new, empty piece -- not written until something happens in it */
  newProject(seed = {}) {
    this._cancelTimer();
    this._generation++;
    this.current = makeProject({
      title: seed.title || defaultTitle(),
      initialSettings: seed.settings,
      settings: seed.settings,
      sessionEvents: [],
      story: { sections: [], currentId: null },
      ui: seed.ui || {},
    });
    this.lastSavedHash = null;
    this._setState(SAVE_STATE.IDLE, { title: this.current.title });
    return this.current;
  }

  /** adopt an already-validated project (from the store or from a file) */
  adopt(project) {
    this._cancelTimer();
    this._generation++;
    this.current = deepClone(project);
    this.lastSavedHash = this.current.hash;
    this._setState(SAVE_STATE.IDLE, { title: this.current.title });
    return this.current;
  }

  async listProjects(limit) {
    try {
      return await this.store.list(limit);
    } catch (e) {
      this._noteUnavailable(e);
      return [];
    }
  }

  async lastOpenedProject() {
    try {
      const id = await this.store.lastOpenedId();
      if (!id) return null;
      return await this.store.get(id);
    } catch (e) {
      this._noteUnavailable(e);
      return null;
    }
  }

  async openProject(projectId) {
    await this.flush('before project switch');
    const p = await this.store.get(projectId);
    if (!p) return null;
    await this.store.setLastOpened(projectId);
    return this.adopt(p);
  }

  _noteUnavailable(e) {
    this.lastError = e;
    if (e instanceof StoreUnavailable) {
      this._setState(SAVE_STATE.UNAVAILABLE, { message: e.message });
    }
  }

  // --- title ----------------------------------------------------------------
  setTitle(t) {
    if (!this.current) return;
    this.current.title = cleanTitle(t);
    this.markDirty('title');
  }

  // --- saving ---------------------------------------------------------------
  /**
   * Something changed. `reason` is only for the status line and the tests;
   * every reason is treated identically.
   *
   * The debounce has a CEILING as well as a delay: a player typing continuously
   * for two minutes produces a change every few hundred milliseconds, and a
   * pure trailing debounce would never fire during that whole stretch -- which
   * is precisely the stretch worth not losing.
   */
  markDirty(reason) {
    if (!this.current) return;
    if (this.state !== SAVE_STATE.UNAVAILABLE) this._setState(SAVE_STATE.DIRTY, { reason });
    const now = Date.now();
    if (!this._firstDirtyAt) this._firstDirtyAt = now;
    if (this._timer) clearTimeout(this._timer);
    const waited = now - this._firstDirtyAt;
    const delay = waited >= MAX_DEBOUNCE_MS ? 0 : Math.min(DEBOUNCE_MS, MAX_DEBOUNCE_MS - waited);
    this._timer = setTimeout(() => this.saveNow(reason), delay);
  }

  _cancelTimer() {
    if (this._timer) clearTimeout(this._timer);
    this._timer = null;
    this._firstDirtyAt = 0;
  }

  /** Wait for the current write and every coalesced follow-up write. */
  async flush(reason = 'flush') {
    if (!this.current) return null;
    this._cancelTimer();
    return this.saveNow(reason);
  }

  /** force a save immediately -- used by STOP, project switch and pagehide */
  async saveNow(reason = 'manual') {
    if (!this.current) return null;
    this._cancelTimer();
    if (this._savePromise) {
      // The promise does not resolve until this requested follow-up has also
      // landed, so a project switch can genuinely wait for a quiescent store.
      this._again = true;
      return this._savePromise;
    }
    const generation = this._generation;
    const projectId = this.current.projectId;
    const run = async () => {
      let result = null;
      let passReason = reason;
      do {
        this._again = false;
        result = await this._saveOnce(passReason, generation, projectId);
        passReason = 'coalesced';
      } while (this._again && this._generation === generation && this.projectId === projectId);
      return result;
    };
    this._savePromise = run();
    try {
      return await this._savePromise;
    } finally {
      this._savePromise = null;
    }
  }

  async _saveOnce(reason, generation, projectId) {
    if (!this.current || this._generation !== generation || this.projectId !== projectId) return null;
    this._saving = true;
    this._setState(SAVE_STATE.SAVING, { reason });
    try {
      const snap = this.capture();
      // Save an immutable target. If the player changes something while the
      // IndexedDB transaction is in flight, markDirty schedules another pass;
      // this pass can never start writing into a newly adopted project.
      const p = deepClone(this.current);
      p.settings = deepClone(snap.settings);
      if (!p.initialSettings) p.initialSettings = deepClone(snap.initialSettings || snap.settings);
      p.text = String(snap.text || '');
      p.sessionEvents = deepClone(snap.sessionEvents || []);
      p.state = deepClone(snap.state || null);
      p.story = deepClone(snap.story || { sections: [], currentId: null });
      p.ui = deepClone(snap.ui || {});
      p.stats = deepClone(snap.stats || {});
      p.revision = (p.revision || 0) + 1;
      p.updatedAt = new Date().toISOString();
      p.hash = projectHash(p);
      p.documentHash = documentHash(p);

      const res = await this.store.save(p);
      const stillCurrent = this._generation === generation && this.projectId === projectId;
      if (stillCurrent) {
        this.current.revision = p.revision;
        this.current.updatedAt = res.updatedAt;
        this.current.hash = res.hash || p.hash;
        this.current.documentHash = res.documentHash || p.documentHash;
        this.lastSavedHash = this.current.hash;
        this.lastError = null;
      }
      const morePending = this._again || !!this._timer;
      if (res.verified && stillCurrent && !morePending) {
        this._setState(SAVE_STATE.SAVED, { at: res.updatedAt, revision: p.revision });
      } else if (res.verified && stillCurrent) {
        this._setState(SAVE_STATE.DIRTY, { reason: 'changes arrived during save' });
      } else if (!res.verified && stillCurrent) {
        // Written, but it did not read back identical. That is not "Saved".
        this._setState(SAVE_STATE.FAILED, {
          message: 'The piece was written but did not read back correctly. Download a backup.',
          recoverable: true,
        });
      }
      return res;
    } catch (e) {
      if (this._generation !== generation || this.projectId !== projectId) return null;
      this.lastError = e;
      const unavailable = e instanceof StoreUnavailable;
      this._setState(unavailable ? SAVE_STATE.UNAVAILABLE : SAVE_STATE.FAILED, {
        message: e && e.message ? e.message : String(e),
      });
      return null;
    } finally {
      this._saving = false;
    }
  }

  // --- library operations ---------------------------------------------------
  async rename(projectId, title) {
    if (this.current && this.current.projectId === projectId) {
      this.setTitle(title);
      await this.saveNow('rename');
      return true;
    }
    const p = await this.store.get(projectId);
    if (!p) return false;
    p.title = cleanTitle(title);
    p.revision = (p.revision || 0) + 1;
    p.hash = projectHash(p);
    p.documentHash = documentHash(p);
    await this.store.save(p);
    return true;
  }

  /**
   * Copy a piece so it can be taken in a different direction without risking
   * the original.
   *
   * The copy gets a NEW projectId and a new title, and carries the same
   * performance -- so its hash matches the source's the instant it is made,
   * which is the property that proves nothing was lost in the copy. From the
   * next edit onwards the two are completely independent documents.
   */
  async duplicate(projectId, existingTitles = []) {
    const src = projectId === this.projectId && this.current ? this.current : await this.store.get(projectId);
    if (!src) return null;
    const copy = deepClone(src);
    copy.projectId = makeProjectId();
    copy.title = variationTitle(src.title, existingTitles);
    copy.createdAt = new Date().toISOString();
    copy.updatedAt = copy.createdAt;
    copy.lastOpenedAt = copy.createdAt;
    copy.revision = 1;
    copy.hash = projectHash(copy);
    copy.documentHash = documentHash(copy);
    await this.store.save(copy);
    return copy;
  }

  /** delete, keeping the record in hand so UNDO can put it straight back */
  async remove(projectId) {
    const rec = await this.store.remove(projectId);
    this.deletedRecord = rec;
    return !!rec;
  }

  async undoRemove() {
    if (!this.deletedRecord) return false;
    const ok = await this.store.restoreRecord(this.deletedRecord);
    this.deletedRecord = null;
    return ok;
  }

  // --- files ----------------------------------------------------------------
  exportFile() {
    if (!this.current) return null;
    const snap = this.capture();
    const p = deepClone(this.current);
    p.settings = deepClone(snap.settings);
    p.text = String(snap.text || '');
    p.sessionEvents = deepClone(snap.sessionEvents || []);
    p.state = deepClone(snap.state || null);
    p.story = deepClone(snap.story || { sections: [], currentId: null });
    p.ui = deepClone(snap.ui || {});
    p.stats = deepClone(snap.stats || {});
    p.hash = projectHash(p);
    p.documentHash = documentHash(p);
    return { json: JSON.stringify(toExportFile(p), null, 1), name: safeFileName(p.title) };
  }

  /**
   * Read a project file.
   *
   * Validates FIRST and touches nothing on the way. If the file is rejected the
   * piece currently open is exactly as it was -- no half-applied settings, no
   * cleared tracks, no "well, the tempo made it through". A failed import must
   * cost the user nothing.
   *
   * An imported project always becomes a NEW document, even when it carries a
   * projectId that already exists here: overwriting a piece because a file
   * happened to share its id is not something anyone asked for.
   */
  async importFile(text, existingTitles = []) {
    let raw;
    try {
      raw = JSON.parse(text);
    } catch (e) {
      return { ok: false, error: 'That file is not valid JSON.' };
    }
    const v = fromExportFile(raw);
    if (!v.ok) return v;

    const p = v.project;
    p.projectId = makeProjectId();
    // Two files with the same name in the library is a worse outcome than a
    // slightly longer name, so a collision becomes a variation.
    if (existingTitles.includes(p.title)) p.title = variationTitle(p.title, existingTitles);
    p.createdAt = new Date().toISOString();
    p.updatedAt = p.createdAt;
    p.lastOpenedAt = p.createdAt;
    p.revision = 1;
    p.hash = projectHash(p);
    p.documentHash = documentHash(p);
    try {
      await this.store.save(p);
    } catch (e) {
      return { ok: false, error: 'The project was readable, but could not be stored: ' + (e.message || e) };
    }
    return { ok: true, project: p, warnings: v.warnings };
  }
}

export { validateProject, makeProject, toExportFile, safeFileName };
