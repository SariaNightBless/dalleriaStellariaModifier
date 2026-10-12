// public/js/mods/tables.js — the bridge between the loader and the game's data store (`public/js/data.js`).
//
// Two things live here, both deliberately tiny:
//   1. WHICH data file a content table belongs to. The game's store addresses files by their own short name
//      (`chess`, `enemies`, …) and `lookup(name, id)` only knows the names in its DATA_FILES map, so a table a pack
//      declares has to be translated before the store is asked for it.
//   2. HOW to read a record out of a table value (array or map). Both shapes appear in `data/*.json`, and a mod asking
//      `api.content.get('enemies', 'e_foo')` should not have to know which one it is looking at.
//
// Nothing here patches the store: it only translates names and reads values.

/** Content table → the game data file that holds it (`public/js/data.js` DATA_FILES keys). */
export const DATA_FILE_OF = Object.freeze({
  chess: 'chess',
  tokens: 'tokens',
  enemies: 'enemies',
  bosses: 'bosses',
  bonds: 'bonds',
  items: 'items',
  bands: 'bands',
  stages: 'stages',
  choices: 'choices',
  config: 'config',
  // Tables the game has no client-side file for: the simulation reads them straight from `/data/<name>.json`
  // (`server/sim/simdata.js`), so the UI store cannot answer for them. `api.content.get` falls back to the pack's own
  // records and documents this.
  waves: 'waves',
  kits: 'kits',
  garrisons: 'garrisons',
  effects: 'effects',
  tuning: 'tuning',
});

/** Tables the game's own store can load (its `DATA_FILES` map) — anything else has to be fetched by the mod. */
export const STORE_TABLES = Object.freeze(new Set([
  'chess', 'bonds', 'items', 'bands', 'enemies', 'bosses', 'stages', 'tokens', 'choices', 'config', 'assets', 'local',
]));

/** The id field of a table (enemies/waves use `key`). */
export const idField = (table) => (table === 'enemies' || table === 'waves' ? 'key' : 'id');

/**
 * Read one record out of an array-shaped or map-shaped table value.
 * @param {any} value @param {string} table @param {string} id
 * @returns {object|null}
 */
export function readRecord(value, table, id) {
  if (value == null || id == null) return null;
  const field = idField(table);
  if (Array.isArray(value)) {
    for (const r of value) {
      if (r && (String(r[field]) === String(id) || String(r.id) === String(id))) return r;
    }
    return null;
  }
  if (typeof value === 'object') {
    if (Object.prototype.hasOwnProperty.call(value, id)) return value[id];
    return value[String(id)] ?? null;
  }
  return null;
}

/** Every record of a table value as an array. */
export function listRecords(value) {
  if (Array.isArray(value)) return value.slice();
  if (value && typeof value === 'object') return Object.values(value);
  return [];
}
