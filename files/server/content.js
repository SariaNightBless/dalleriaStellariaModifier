// server/content.js — the server half of content packs: read the pack files off disk, merge them with the shared rules,
// hand the merged tables to the simulation and to the static `/data/` mount.
//
// The merge semantics live in `shared/content.js` (one implementation for the server and the page). This file only does
// what the server can do and the page cannot:
//   · read `content/*.json` from a package folder (with a path guard: a pack cannot reach outside its own folder),
//   · decide WHICH packs apply (enabled + `status: 'ok'`, sorted by id),
//   · materialise the merged tables into a directory the static mount can serve, so the page's own loader
//     (`loadBrowserSim` → `setSimData`) and the UI data store read modded data with no coordination at all.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { mergePacks, normalizePackTable, changedTables, summarize, idFieldOf } from '../shared/content.js';

const noop = { info() {}, warn() {}, error() {} };

/** A package must not point a table at anything outside itself. */
function safeRel(file) {
  if (typeof file !== 'string' || !file.trim()) return null;
  const norm = file.replace(/\\/g, '/');
  if (norm.startsWith('/') || /^[a-zA-Z]:/.test(norm)) return null;
  if (norm.split('/').some((p) => p === '..' || p === '')) return null;
  return norm;
}

/**
 * Read the tables one package declares.
 * @param {object} rec a manager record (`id`, `baseAbs`, `content`)
 * @returns {{ id: string, version: string|null, tables: Record<string,{raw:any}>, problems: string[] }}
 */
export function readPack(rec) {
  const out = { id: rec.id, version: rec.version ?? null, tables: {}, problems: [] };
  for (const [table, file] of Object.entries(rec.content || {})) {
    const rel = safeRel(file);
    if (!rel) { out.problems.push(`content.${table}: unsafe path ${JSON.stringify(file)}`); continue; }
    const abs = path.join(rec.baseAbs || path.join(rec.dir || '.', ''), rel);
    try {
      out.tables[table] = { raw: JSON.parse(fs.readFileSync(abs, 'utf8')) };
    } catch (e) {
      out.problems.push(`content.${table}: cannot read ${rel}: ${e.message}`);
    }
  }
  return out;
}

/**
 * Merge every enabled content pack of a scan result into the base tables.
 * @param {object} base tables as `server/data.js` loadData produced them
 * @param {Array<object>} records manager records
 * @param {{ log?: object }} [opts]
 */
export function applyContentPacks(base, records, { log = noop } = {}) {
  const packs = (records || [])
    .filter((r) => r && r.status === 'ok' && r.enabled !== false && r.content && Object.keys(r.content).length)
    .map(readPack);
  const problems = [];
  for (const p of packs) for (const problem of p.problems) problems.push({ id: p.id, problem });
  const usable = packs.filter((p) => Object.keys(p.tables).length);
  if (!usable.length) return { tables: base, packs: [], problems, conflicts: [], changes: [] };

  const res = mergePacks(base, usable);
  const changes = changedTables(base, res.tables);
  if (res.packs.length) log.info?.(`[mods] content: ${summarize(res.packs)}`);
  for (const p of problems) log.warn?.(`[mods] ${p.id}: ${p.problem}`);
  // a record stored under a DERIVED key is usually a mistake: the game looks records up by the table's own id field, so
  // a chess record without `id` is indexed as `<mod>:<name>` and cannot be resolved when the operator is drawn.
  for (const w of res.derived || []) log.warn?.(`[mods] content: ${w}`);
  if (res.conflicts.length) {
    log.warn?.(`[mods] content: ${res.conflicts.length} record(s) written by more than one pack (last writer wins): `
      + res.conflicts.slice(0, 5).map((c) => `${c.table}/${c.id}: ${c.alsoMod} → ${c.mod}`).join(', '));
  }
  // provenance, non-enumerable so it never reaches JSON.stringify or the wire
  try {
    Object.defineProperty(res.tables, '__mods', {
      value: { packs: res.packs.map((p) => p.id), owner: res.owner }, enumerable: false, configurable: true,
    });
  } catch { /* the caller owns the object */ }
  return { tables: res.tables, packs: res.packs, problems, conflicts: res.conflicts, changes };
}

/**
 * Build the directory the static `/data/` mount serves: the merged tables, plus every other table of the built-in
 * `data/` directory.
 *
 * WHY A COMPLETE DIRECTORY AND NOT AN OVERLAY
 *   The page fetches `/data/<name>.json` for every table it needs, and the simulation injects the same set. A mount that
 *   only carries the tables a pack touched would 404 everything else — and "fix" that inside the static handler means
 *   teaching a security-sensitive file server about layered directories. Copying (hard-linking where the filesystem
 *   allows it) is a few megabytes, happens once per boot, costs no extra request path, and keeps the server's file
 *   serving exactly as the game shipped it.
 *
 * @param {object} tables @param {string} destDir @param {string} baseDir the built-in `data/`
 * @param {{ log?: object }} [opts]
 * @returns {Promise<{ files: number, linked: number, copied: number, bytes: number }>}
 */
export async function materialize(tables, destDir, baseDir, { log = noop } = {}) {
  await fsp.mkdir(destDir, { recursive: true });
  let files = 0, linked = 0, copied = 0, bytes = 0;
  const written = new Set();
  for (const [name, value] of Object.entries(tables)) {
    if (name.startsWith('__')) continue;
    const text = JSON.stringify(value);
    await fsp.writeFile(path.join(destDir, `${name}.json`), text);
    written.add(`${name}.json`);
    files++;
    bytes += Buffer.byteLength(text);
  }
  // every other table of the built-in data/ has to be reachable at the same URL
  if (baseDir && fs.existsSync(baseDir)) {
    for (const name of fs.readdirSync(baseDir)) {
      if (!name.toLowerCase().endsWith('.json') || written.has(name)) continue;
      const from = path.join(baseDir, name);
      const to = path.join(destDir, name);
      try {
        await fsp.link(from, to);            // hard link: same bytes, no extra disk, no copy time
        linked++;
      } catch {
        try { await fsp.copyFile(from, to); copied++; }
        catch (e) { log.warn?.(`[mods] content: cannot provide ${name} in the merged data dir: ${e.message}`); }
      }
    }
  }
  log.info?.(`[mods] content: merged data dir ${path.relative(process.cwd(), destDir)} — ${files} rewritten, ${linked} linked, ${copied} copied (${(bytes / 1048576).toFixed(1)} MB rewritten)`);
  return { files, linked, copied, bytes };
}

/**
 * What the manager page shows per package: how many records a pack contributes and which ids it fights over.
 * Cheap enough to run on every list request (the files are small and read on demand).
 */
export function contentReport(rec, { baseTables = null } = {}) {
  const pack = readPack(rec);
  const out = { id: rec.id, tables: {}, problems: pack.problems.slice(), warnings: [], records: 0 };
  for (const [table, entry] of Object.entries(pack.tables)) {
    const norm = normalizePackTable(rec.id, table, entry.raw);
    if (!norm.ok) { out.problems.push(norm.error); continue; }
    const field = idFieldOf(table);
    const ids = norm.records.map((r) => String(r[field]));
    // A record the loader had to key ITSELF is almost always a mistake: the game looks a record up by the table's id
    // field, so `chess` entries without `id` end up under `<mod-id>:<name>` and can be drawn from the pool but never
    // resolved. That failure mode looks exactly like "the mod half works", so it is reported and warned about at boot.
    if ((norm.derived || []).length) {
      const arrayShaped = Array.isArray(entry.raw);
      out.warnings.push(arrayShaped
        ? `content.${table}: ${norm.derived.length} record(s) have no "${field}" and got a derived key (${norm.derived.slice(0, 3).join('; ')}) — the game looks records up by "${field}", so it will not find them. Add "${field}" to each record.`
        : `content.${table}: ${norm.derived.join('; ')}`);
    }
    let overrides = 0;
    const base = baseTables ? baseTables[table] : null;
    if (base) {
      const known = Array.isArray(base)
        ? new Set(base.map((r) => r && r[field]).filter((x) => typeof x === 'string'))
        : new Set(Object.keys(base));
      overrides = ids.filter((i) => known.has(i)).length;
    }
    out.tables[table] = { count: ids.length, ids: ids.slice(0, 200), overrides, shape: norm.shape };
    out.records += ids.length;
  }
  return out;
}

export { summarize };
