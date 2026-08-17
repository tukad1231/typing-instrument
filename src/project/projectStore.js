// ---------------------------------------------------------------------------
// PROJECT STORE  --  local, private, and hard to lose.
//
// IndexedDB, not localStorage. A session log is tens of thousands of events;
// localStorage is a synchronous string store with a ~5 MB budget shared across
// the whole origin, so putting a performance in it means blocking the audio
// thread's own main loop on a JSON.stringify and then running out of room.
//
// -- THE ONE RULE ----------------------------------------------------------
// A failed save must never cost the user the previous good save.
//
// Every record therefore carries TWO copies:
//
//     latest          what was written last
//     lastKnownGood   the newest copy that was read back and verified
//
// A save writes `latest` and, in the SAME transaction, promotes the previous
// `latest` to `lastKnownGood` -- but only if that previous copy had verified.
// IndexedDB transactions are all-or-nothing, so there is no instant at which
// both copies are half-written. If the browser dies mid-write, the worst case
// is that `latest` is missing and `lastKnownGood` is intact, which is exactly
// the state open() knows how to recover from.
//
// Nothing here talks to the network. There is no server, no account and no
// sync: the data is on this machine, in this browser profile, and that is the
// whole story the user has to be told (and is, in the Help sheet).
// ---------------------------------------------------------------------------

import { deepClone, isStorable } from '../core/hash.js';
import { projectHash, documentHash, projectSummary, validateProject } from './projectFormat.js';

const DB_NAME = 'typing-instrument';
const DB_VERSION = 1;
const STORE = 'projects';
const META = 'meta';

/** IndexedDB is unavailable in some private-browsing modes; say so, do not crash */
export class StoreUnavailable extends Error {
  constructor(reason) {
    super(reason);
    this.name = 'StoreUnavailable';
  }
}

function req(r) {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error || new Error('IndexedDB request failed'));
  });
}

export class ProjectStore {
  /**
   * @param {object} [opts]
   * @param {IDBFactory} [opts.indexedDB] injectable, so the self-test can point
   *   this at a factory that fails on demand instead of waiting for a real disk
   *   to fill up.
   */
  constructor(opts = {}) {
    this.idb = opts.indexedDB || (typeof indexedDB !== 'undefined' ? indexedDB : null);
    this.dbName = opts.dbName || DB_NAME;
    this.db = null;
    this.available = null; // null = not yet known
    this.lastError = null;
  }

  async open() {
    if (this.db) return this.db;
    if (!this.idb) {
      this.available = false;
      throw new StoreUnavailable('This browser has no IndexedDB, so pieces cannot be saved here.');
    }
    try {
      const openReq = this.idb.open(this.dbName, DB_VERSION);
      openReq.onupgradeneeded = () => {
        const db = openReq.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'projectId' });
        if (!db.objectStoreNames.contains(META)) db.createObjectStore(META, { keyPath: 'key' });
      };
      // Firefox in permanent private browsing rejects the open() outright;
      // Safari can hang instead, so a blocked open is treated as unavailable
      // rather than left pending forever.
      const db = await new Promise((resolve, reject) => {
        openReq.onsuccess = () => resolve(openReq.result);
        openReq.onerror = () => reject(openReq.error || new Error('IndexedDB could not be opened'));
        openReq.onblocked = () => reject(new Error('another tab is holding the database open'));
      });
      this.db = db;
      this.available = true;
      return db;
    } catch (e) {
      this.available = false;
      this.lastError = e;
      throw new StoreUnavailable(
        'Saving is unavailable in this browser or window (' + (e && e.message ? e.message : e) + ').'
      );
    }
  }

  _tx(stores, mode) {
    const tx = this.db.transaction(stores, mode);
    const done = new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error('transaction failed'));
      tx.onabort = () => reject(tx.error || new Error('transaction aborted'));
    });
    return { tx, done };
  }

  /**
   * Write a project.
   *
   * Refuses BEFORE opening a transaction if the document is not
   * structured-cloneable. Finding that out inside the transaction aborts it,
   * and an aborted transaction is indistinguishable from a disk error to the
   * code above -- so the user would be told "save failed" for what is really a
   * programming mistake.
   */
  async save(project) {
    await this.open();
    if (!isStorable(project)) {
      throw new Error('This piece contains something that cannot be saved (a non-data value got into the project).');
    }
    const record = deepClone(project);
    record.updatedAt = new Date().toISOString();
    record.hash = projectHash(record);
    record.documentHash = documentHash(record);

    const { tx, done } = this._tx([STORE, META], 'readwrite');
    const store = tx.objectStore(STORE);
    const existing = await req(store.get(record.projectId));

    const next = {
      projectId: record.projectId,
      latest: record,
      // Only a copy that was verified may become the fallback. An unverified
      // previous save is exactly the thing we must not fall back to.
      lastKnownGood:
        existing && existing.latest && existing.verified
          ? existing.latest
          : (existing && existing.lastKnownGood) || null,
      verified: false,
      summary: projectSummary(record),
      updatedAt: record.updatedAt,
    };
    store.put(next);
    tx.objectStore(META).put({ key: 'lastOpened', projectId: record.projectId, at: record.updatedAt });
    await done;

    // Read it back and confirm it survived the trip. Only then is it allowed
    // to become the next fallback.
    const { tx: checkTx, done: checkDone } = this._tx([STORE], 'readonly');
    const checkRow = await req(checkTx.objectStore(STORE).get(record.projectId));
    await checkDone;
    const check = checkRow && checkRow.latest;
    const verified = !!check &&
      check.hash === record.hash &&
      check.documentHash === record.documentHash &&
      projectHash(check) === record.hash &&
      documentHash(check) === record.documentHash;
    let certified = false;
    if (verified) {
      const { tx: tx2, done: done2 } = this._tx([STORE], 'readwrite');
      const s2 = tx2.objectStore(STORE);
      const cur = await req(s2.get(record.projectId));
      // Compare-and-set: another tab may have written a newer revision between
      // our read-back and this transaction. Never certify somebody else's bytes
      // using the hash we just checked.
      if (cur && cur.latest &&
          cur.latest.revision === record.revision &&
          cur.latest.documentHash === record.documentHash) {
        cur.verified = true;
        s2.put(cur);
        certified = true;
      }
      await done2;
    }
    return {
      revision: record.revision,
      verified: verified && certified,
      updatedAt: record.updatedAt,
      hash: record.hash,
      documentHash: record.documentHash,
    };
  }

  /** the current copy, or the last verified one if the current is unreadable */
  async get(projectId) {
    await this.open();
    const { tx, done } = this._tx([STORE], 'readonly');
    const rec = await req(tx.objectStore(STORE).get(projectId));
    await done;
    if (!rec) return null;
    const candidate = rec.latest || rec.lastKnownGood;
    if (!candidate) return null;
    const v = validateProject(candidate, { requireIntegrity: true });
    if (v.ok) return v.project;
    if (rec.lastKnownGood && rec.lastKnownGood !== candidate) {
      const g = validateProject(rec.lastKnownGood, { requireIntegrity: true });
      if (g.ok) return g.project;
    }
    return null;
  }

  /** true when the newest copy is unreadable and a good older one exists */
  async recoveredFromBackup(projectId) {
    await this.open();
    const { tx, done } = this._tx([STORE], 'readonly');
    const rec = await req(tx.objectStore(STORE).get(projectId));
    await done;
    if (!rec || !rec.latest) return false;
    if (validateProject(rec.latest, { requireIntegrity: true }).ok || !rec.lastKnownGood) return false;
    return validateProject(rec.lastKnownGood, { requireIntegrity: true }).ok;
  }

  async list(limit = 24) {
    await this.open();
    const { tx, done } = this._tx([STORE], 'readonly');
    const all = await req(tx.objectStore(STORE).getAll());
    await done;
    return all
      .map((r) => r.summary || (r.latest ? projectSummary(r.latest) : null))
      .filter(Boolean)
      .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))
      .slice(0, limit);
  }

  /**
   * Remove a project, handing back the whole record so the caller can put it
   * straight back. That is what makes DELETE undoable without a tombstone
   * field, a "deleted" flag, or a sweeper that has to run later.
   */
  async remove(projectId) {
    await this.open();
    const { tx, done } = this._tx([STORE], 'readwrite');
    const s = tx.objectStore(STORE);
    const rec = await req(s.get(projectId));
    if (rec) s.delete(projectId);
    await done;
    return rec || null;
  }

  /** put a removed record back exactly as it was */
  async restoreRecord(record) {
    if (!record || !record.projectId) return false;
    await this.open();
    const { tx, done } = this._tx([STORE], 'readwrite');
    tx.objectStore(STORE).put(record);
    await done;
    return true;
  }

  async lastOpenedId() {
    await this.open();
    const { tx, done } = this._tx([META], 'readonly');
    const m = await req(tx.objectStore(META).get('lastOpened'));
    await done;
    return m ? m.projectId : null;
  }

  async setLastOpened(projectId) {
    await this.open();
    const { tx, done } = this._tx([META], 'readwrite');
    tx.objectStore(META).put({ key: 'lastOpened', projectId, at: new Date().toISOString() });
    await done;
  }

  async touchOpened(projectId) {
    await this.open();
    const { tx, done } = this._tx([STORE], 'readwrite');
    const s = tx.objectStore(STORE);
    const rec = await req(s.get(projectId));
    if (rec) {
      const at = new Date().toISOString();
      if (rec.latest) rec.latest.lastOpenedAt = at;
      if (rec.summary) rec.summary.lastOpenedAt = at;
      s.put(rec);
    }
    await done;
  }

  close() {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }
}
