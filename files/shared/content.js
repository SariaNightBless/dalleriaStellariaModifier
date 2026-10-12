// shared/content.js — the content-pack merge rules. ONE implementation, used by the server (filesystem) and the page
// (HTTP), because a difference between the two would show up as "the mod works alone but the battle result diverges".
//
// A CONTENT PACK is a package that declares tables in its manifest:
//     "content": { "chess": "content/chess.json", "enemies": "content/enemies.json" }
// Each file holds either an array of records or a map of id → record. Both shapes appear in `data/*.json`.
//
// THE MERGE (fixed, not configurable — a mod cannot change how another mod's data lands)
//   · identity      : `key` for enemies/waves, `id` for everything else; a record without one gets
//                     `<mod-id>:<slug>` derived from its name, so a pack never has to invent ids.
//   · new id        : appended (arrays) / added (maps).
//   · existing id   : DEEP MERGED. Objects merge key by key, arrays and scalars REPLACE.
//                     Rationale: a pack that wants to "buff an operator's HP" writes `{ id, stats: { hp: 1200 } }`
//                     instead of a full copy of the record — which would silently freeze every other field at the value
//                     of the day it was written.
//   · order         : packs apply sorted by mod id, then by table order in the manifest. Same everywhere.
//   · provenance    : every element of the returned report says which pack wrote which id, so the manager and the
//                     server log can answer "who put this here" and "who overrode whom".
//
// Nothing here touches the filesystem or the network: the callers hand in plain parsed JSON.

/** Records of these tables are addressed by `key`; everything else by `id`. */
export const KEY_FIELD = Object.freeze({ enemies: 'key', waves: 'key' });

/** The tables a pack may write. Closed list: a typo becomes a manifest problem, not a silent no-op. */
export const CONTENT_TABLES = Object.freeze([
  'chess', 'tokens', 'enemies', 'waves', 'bonds', 'items', 'kits', 'bands', 'stages', 'garrisons', 'effects', 'choices',
]);

export const idFieldOf = (table) => KEY_FIELD[table] || 'id';

/** `My Pack!` → `my-pack`: the slug used when a record carries no id. */
export function slug(s) {
  return String(s || '').trim().toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
}

/**
 * Normalise one table file into a list of records, filling in ids where they are missing.
 *
 * ⚠️ THE KEY OF A RECORD IS THE TABLE'S ID FIELD, AND THE GAME LOOKS RECORDS UP BY IT.
 *   For an object-shaped table (which `chess.json` is) the client index is keyed by the JSON **object key**, so a chess
 *   record whose `id`/`chessId` disagree ends up stored under the wrong key and `data.lookup('chess', …)` misses it —
 *   the operator then shows up in the pool but cannot be resolved when it is drawn. When a derived key is used the
 *   caller reports it (see `warnAboutKeys`), because silently storing a record under `<mod>:<name>` looks like it works.
 *
 * @param {string} modId @param {string} table @param {any} raw parsed JSON
 * @returns {{ ok: true, records: object[], shape: 'array'|'map', derived: string[] } | { ok: false, error: string }}
 */
export function normalizePackTable(modId, table, raw) {
  const field = idFieldOf(table);
  const derived = [];
  if (Array.isArray(raw)) {
    const records = [];
    for (const r of raw) {
      if (!r || typeof r !== 'object' || Array.isArray(r)) return { ok: false, error: `content.${table}: every entry must be an object` };
      const id = r[field] ?? r.id ?? r.key;
      if (typeof id === 'string' && id.trim()) { records.push(r); continue; }
      const name = r.name || r.nameZh || r.nameEn || r.id || 'entry';
      const made = `${modId}:${slug(name) || 'entry'}`;
      derived.push(`${made} (from the name "${name}")`);
      records.push({ ...r, [field]: made });
    }
    return { ok: true, records, shape: 'array', derived };
  }
  if (raw && typeof raw === 'object') {
    const records = [];
    for (const [k, v] of Object.entries(raw)) {
      if (!v || typeof v !== 'object') return { ok: false, error: `content.${table}: "${k}" must be an object` };
      // an object-shaped table is keyed by its own keys: a record whose own id disagrees would be indexed under the
      // wrong one, so the key wins and the disagreement is reported
      if (v[field] && v[field] !== k) derived.push(`${k}: the record says ${field}="${v[field]}" but the file keys it "${k}" — the key wins`);
      records.push({ ...v, [field]: k });
    }
    return { ok: true, records, shape: 'map', derived };
  }
  return { ok: false, error: `content.${table}: the file must contain an array or an object` };
}

/** Deep merge: objects merge, arrays and scalars replace. */
export function mergeRecord(a, b) {
  if (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)) {
    const out = { ...a };
    for (const [k, v] of Object.entries(b)) out[k] = k in out ? mergeRecord(out[k], v) : v;
    return out;
  }
  return b;
}

/**
 * Apply one already-parsed table to a base table value (pure: returns the new value).
 * @param {string} table @param {any} base @param {object[]} records @param {'array'|'map'} shape
 * @returns {{ value: any, added: string[], overridden: string[] }}
 */
export function mergeTable(table, base, records, shape) {
  const field = idFieldOf(table);
  const added = [];
  const overridden = [];
  if (Array.isArray(base)) {
    const next = base.slice();
    const at = new Map();
    next.forEach((r, i) => { const k = r && r[field]; if (typeof k === 'string') at.set(k, i); });
    for (const r of records) {
      const id = r[field];
      const i = at.get(id);
      if (i === undefined) { at.set(id, next.length); next.push(r); added.push(String(id)); }
      else { next[i] = mergeRecord(next[i], r); overridden.push(String(id)); }
    }
    return { value: next, added, overridden };
  }
  if (base && typeof base === 'object') {
    const next = { ...base };
    for (const r of records) {
      const id = r[field];
      if (Object.prototype.hasOwnProperty.call(next, id)) { next[id] = mergeRecord(next[id], r); overridden.push(String(id)); }
      else { next[id] = r; added.push(String(id)); }
    }
    return { value: next, added, overridden };
  }
  // the base build has no such table at all: the pack creates it
  if (shape === 'map') {
    const value = {};
    for (const r of records) { value[r[field]] = r; added.push(String(r[field])); }
    return { value, added, overridden };
  }
  return { value: records.slice(), added: records.map((r) => String(r[field])), overridden: [] };
}

/**
 * Apply a list of packs (already parsed) to a set of base tables.
 *
 * @param {object} base `{ chess: [...], enemies: {...}, … }`
 * @param {Array<{ id: string, version?: string, tables: Record<string, { raw: any }> }>} packs in final apply order
 * @returns {{ tables: object, packs: object[], problems: {id:string, problem:string}[], conflicts: object[] }}
 */
export function mergePacks(base, packs) {
  let tables = { ...base };
  const report = [];
  const problems = [];
  const conflicts = [];
  const derived = [];
  /** @type {Map<string,string>} `table/id` → mod id */
  const owner = new Map();
  const ordered = packs.slice().sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const pack of ordered) {
    const applied = [];
    for (const [table, entry] of Object.entries(pack.tables || {})) {
      const norm = normalizePackTable(pack.id, table, entry.raw);
      if (!norm.ok) { problems.push({ id: pack.id, problem: norm.error }); continue; }
      for (const d of norm.derived || []) derived.push(`${pack.id} · ${table}: ${d}`);
      const res = mergeTable(table, tables[table], norm.records, norm.shape);
      tables[table] = res.value;
      for (const id of res.added.concat(res.overridden)) {
        const key = `${table}/${id}`;
        const prev = owner.get(key);
        if (prev) conflicts.push({ table, id, mod: pack.id, alsoMod: prev });
        owner.set(key, pack.id);
      }
      applied.push({ table, added: res.added.length, overridden: res.overridden });
    }
    report.push({ id: pack.id, version: pack.version ?? null, applied });
  }
  return { tables, packs: report, problems, conflicts, derived, owner: Object.fromEntries(owner) };
}

/** Which tables actually changed (used to decide whether the merged set has to be materialised at all). */
export function changedTables(before, after) {
  const out = [];
  for (const k of Object.keys(after)) {
    if (k.startsWith('__')) continue;
    if (before[k] !== after[k]) out.push(k);
  }
  return out;
}

/** One-line summary for a log line or the manager page: `chess +12/3, enemies +2/0`. */
export function summarize(packs) {
  return (packs || []).map((p) => {
    const parts = p.applied.map((a) => `${a.table} +${a.added}${a.overridden ? `/${a.overridden}` : ''}`);
    return `${p.id}: ${parts.join(', ')}`;
  }).join(' | ');
}
