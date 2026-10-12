// public/js/mods/content.js — the page half of content packs.
//
// A content pack's data has to reach two places in the page:
//   1. the SIMULATION — already solved without touching anything: the simulation fetches its tables from `/data/*.json`
//      (`battle/runner.js` loadBrowserSim → setSimData), and the server serves the MERGED tables there. A pack that is
//      installed on the server therefore reaches the client simulation for free.
//   2. the UI data store (`public/js/data.js`) — because the shop, the detail card, the loadout screen and the band
//      draft read records from it. This module merges the packs into that store.
//
// HOW (and why not by patching the store's API)
//   The store keeps a per-file index built lazily from the raw JSON it fetched. Writing the merged records into that raw
//   JSON and dropping the index is enough — no upstream file is modified, no wrapper is left behind that the game would
//   have to know about. The merge rules are the shared ones (`shared/content.js`), i.e. exactly what the server applied,
//   so UI and simulation can never disagree about a record.
//
//   The pack files are fetched over HTTP from the package's own mount (`/mods/<id>/content/chess.json`), which the
//   manager already serves read-only; nothing here evaluates package code.

import { mergePacks, normalizePackTable, idFieldOf, summarize } from '../../../shared/content.js';
import { DATA_FILE_OF } from './tables.js';

/**
 * Fetch one pack's declared tables.
 * @param {object} rec a `/api/mods` record (needs `content`, `url`, `id`, `version`)
 * @param {typeof fetch} fetchFn
 */
async function fetchPack(rec, fetchFn) {
  const tables = {};
  const problems = [];
  for (const [table, file] of Object.entries(rec.content || {})) {
    try {
      const res = await fetchFn(`${rec.url}${String(file).replace(/^\/+/, '')}`, { cache: 'no-store' });
      if (!res.ok) { problems.push(`${table}: HTTP ${res.status} for ${file}`); continue; }
      tables[table] = { raw: await res.json() };
    } catch (e) {
      problems.push(`${table}: ${e?.message || e}`);
    }
  }
  return { id: rec.id, version: rec.version ?? null, tables, problems };
}

/**
 * Apply the content packs of an already-fetched `/api/mods` payload to the UI data store.
 *
 * @param {{ mods: object[] }} list the `/api/mods` payload
 * @param {{ store: object, fetchFn?: typeof fetch, log?: (...a:any[])=>void }} deps
 * @returns {Promise<{ applied: object[], problems: object[], conflicts: object[], records: object }>}
 */
export async function applyContentToStore(list, { store, fetchFn = (...a) => globalThis.fetch(...a), log = () => {} }) {
  const packs = [];
  const problems = [];
  for (const rec of list?.mods || []) {
    if (!rec || rec.status !== 'ok' || !rec.enabled) continue;
    if (!rec.content || !Object.keys(rec.content).length) continue;
    const pack = await fetchPack(rec, fetchFn);
    for (const p of pack.problems) problems.push({ id: rec.id, problem: p });
    if (Object.keys(pack.tables).length) packs.push(pack);
  }
  if (!packs.length) return { applied: [], problems, conflicts: [], records: {} };

  // The base for the merge is what the store has already loaded; a table that is not loaded yet is merged from empty,
  // so the pack's records exist from the first render and the store's own fetch can only ADD to them (see below).
  const base = {};
  for (const pack of packs) {
    for (const table of Object.keys(pack.tables)) {
      if (table in base) continue;
      const raw = store?.get?.(table);
      base[table] = raw == null ? (Array.isArray(pack.tables[table].raw) ? [] : {}) : clone(raw);
    }
  }
  const res = mergePacks(base, packs);
  for (const p of problems) log(`[mods] ${p.id}: ${p.problem}`);

  // write the merged tables back into the store and drop its index so it is rebuilt from the merged value
  const writes = [];
  for (const table of Object.keys(res.tables)) {
    const merged = res.tables[table];
    writes.push({ table, merged, hadRaw: store?.get?.(table) != null });
  }
  return { applied: res.packs, problems, conflicts: res.conflicts, records: res.tables, writes };
}

/**
 * Write merged tables into a live `createDataStore()` instance and invalidate its index.
 *
 * `store.get(name)` may return null while the file is still in flight; then we wait for the store's own load to land and
 * merge again, so the pack's records survive whichever finishes first.
 *
 * @param {object} store @param {object} records table → merged value @param {{ log?: Function }} [opts]
 */
export async function writeToStore(store, records, { log = () => {} } = {}) {
  const written = [];
  for (const [table, merged] of Object.entries(records)) {
    if (table.startsWith('__')) continue;
    const name = DATA_FILE_OF[table] || table;
    const current = store?.get?.(name);
    if (current == null) {
      // not loaded (or missing): make the store fetch it, then merge into whatever arrives
      try { await store.load?.(name); } catch { /* missing files are tolerated by the store */ }
    }
    const live = store?.get?.(name);
    if (live == null) {
      // The file does not exist on this build (a pack adding a table the game has no file for): there is nowhere to put
      // it in the store. The simulation still sees it (via /data/*.json), and api.content.get() reads it directly.
      log(`[mods] content: the store has no "${name}" file to merge into; records stay available through api.content`);
      continue;
    }
    if (Array.isArray(live)) {
      live.length = 0;
      live.push(...merged);
    } else if (live && typeof live === 'object') {
      for (const k of Object.keys(live)) delete live[k];
      Object.assign(live, merged);
    }
    // drop the cached index so the next lookup/list rebuilds from the merged value
    try { store.invalidate?.(name); } catch { /* the store rebuilds lazily anyway */ }
    written.push(table);
  }
  return written;
}

const clone = (v) => (typeof structuredClone === 'function' ? structuredClone(v) : JSON.parse(JSON.stringify(v)));

/**
 * A read-only view of the merged content, handed to mods as `api.content`.
 *
 * It answers for BOTH cases a mod cares about: reading a built-in record that a pack overrode, and reading a record a
 * pack created (which the game's own store may not know about if it has no such file).
 *
 * @param {() => object} tablesFn the live merged tables
 * @param {(table: string) => object} storeLookup
 * @param {() => string[]} [packsFn] the ids of the packs that contributed (see `packs`)
 */
export function createContentView(tablesFn, storeLookup, packsFn = () => []) {
  const view = {
    /** Every merged table (a live object; do not mutate). */
    get tables() { return tablesFn(); },
    /** Which packages contributed content, in apply order (`['my-pack', …]`). */
    get packs() { return Object.keys(tablesFn()).length ? packsFn() : []; },
    /** The record with `id` from `table` (merged value; falls back to the UI data store). */
    get(table, id) {
      const t = tablesFn()[table];
      const field = idFieldOf(table);
      if (Array.isArray(t)) {
        const hit = t.find((r) => r && String(r[field]) === String(id));
        if (hit) return hit;
      } else if (t && typeof t === 'object') {
        if (Object.prototype.hasOwnProperty.call(t, id)) return t[id];
      }
      return storeLookup?.(table, id) ?? null;
    },
    /** Every record of a merged table (array), or `[]`. */
    list(table) {
      const t = tablesFn()[table];
      if (Array.isArray(t)) return t.slice();
      if (t && typeof t === 'object') return Object.values(t);
      return [];
    },
    /** Ids a pack added (vs the built-in ones), useful for a "new content" badge. */
    added(table, builtinIds) {
      const t = tablesFn()[table];
      const field = idFieldOf(table);
      const ids = Array.isArray(t) ? t.map((r) => String(r && r[field])) : Object.keys(t || {});
      const known = builtinIds instanceof Set ? builtinIds : new Set(builtinIds || []);
      return ids.filter((i) => !known.has(i));
    },
    /** `chess +12/3, enemies +2/0` for a log line or the manager page. */
    summarize: (packs) => summarize(packs),
  };
  return Object.freeze(view);
}
