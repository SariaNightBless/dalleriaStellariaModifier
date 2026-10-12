// server/mods.js — the mod package manager (load, validate, hot-mount).
//
// DESIGN
//   A mod is a folder or a .zip dropped into `mods/` (project root). The manager owns four jobs:
//     1. SCAN    — find every mod, parse its mod.json, validate it, report problems instead of throwing.
//     2. MOUNT   — serve each mod's files at /mods/<id>/… so its ES modules can be imported by the page.
//     3. HOT     — watch `mods/` and re-scan on change: dropping a folder or zip in mounts it without a restart.
//     4. CONTROL — enable / disable / remove, persisted in `mods/mods.state.json` (a file, not a database).
//
// WHY IT IS DEFENSIVE
//   Mods are arbitrary third-party code and this is a server-authoritative, deterministic game (DESIGN §14): both
//   peers simulate the same battle and compare `resultDigest`. So a mod that changes the simulation must be present
//   on BOTH sides, and the manifest has to say so (`clientOnly`). A mod that fails to parse, fails to load, or lies
//   about its api version is reported as a problem and left unmounted — never allowed to take the game down.
//
// MANIFEST (`mod.json` in the mod root)
//   {
//     "id": "covenant-fidelity",        required, [a-zA-Z0-9._-], must be unique
//     "name": "盟约保真包",              optional, defaults to the id
//     "version": "1.0.0",               optional but strongly encouraged
//     "api": 1,                         required: the mod API the package was written against
//     "author": "…", "description": "…", "homepage": "…"
//     "clientOnly": true,               true = rendering only, safe to install on one side
//     "entry": { "client": "client.js", "sim": "sim.js" }
//     "provides": { "bonds": [], "kits": [], "styles": [] }   what it adds, for the conflict report
//     "requires": { "mods": ["other-id"], "game": ">=0.1.7" }  dependencies
//   }
//   A package with no mod.json is still mounted, as a PROBLEM entry: dropping a folder in must never be a silent
//   no-op, and it must never be a silent crash either.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
// The manifest schema lives in ONE place (server/manifest.js): the installer validates with it, the manager scans with
// it, the page reads the same fields. Keeping a second copy here is how a schema drifts.
import {
  MOD_API, MODS_DIRNAME, STATE_FILE, MANIFEST, ID_RE, validateManifest, modUrl, contentKind, compareVersions,
  packageFolderName, packageIdFromFolder,
} from './manifest.js';
import { createUpdater, inspectZipManifest } from './mods-update.js';
import { contentReport } from './content.js';

export { MOD_API, MODS_DIRNAME, validateManifest, compareVersions, inspectZipManifest, contentKind, packageFolderName };

/** How long to wait for the filesystem to settle before re-scanning (a zip extraction fires many events). */
const WATCH_DEBOUNCE_MS = 400;

const noopLog = { info() {}, warn() {}, error() {} };

/** Read + parse a JSON file, returning null instead of throwing. */
function readJsonSync(abs) {
  try { return JSON.parse(fs.readFileSync(abs, 'utf8')); } catch { return null; }
}


// ---------------------------------------------------------------------------------------------------------------
// zip extraction (no dependencies: a .zip is a central directory + per-entry local headers, and Node has zlib)

/**
 * List a zip's entries (central directory walk). Supports what mod packages actually use: store (0) and deflate (8).
 * @param {Buffer} buf
 * @returns {Array<{ name: string, method: number, size: number, csize: number, offset: number, dir: boolean }>}
 */
export function listZipEntries(buf) {
  // End Of Central Directory: signature 0x06054b50, scanned from the end (a trailing comment may follow it)
  let eocd = -1;
  const minEocd = Math.max(0, buf.length - 66000);
  for (let i = buf.length - 22; i >= minEocd; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a zip file (no end-of-central-directory record)');
  const count = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOff = buf.readUInt32LE(eocd + 16);
  if (cdOff + cdSize > buf.length) throw new Error('truncated zip (central directory past end of file)');
  const out = [];
  let p = cdOff;
  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    // 20 = compressed size, 24 = uncompressed size. The COMPRESSED one is what indexes the payload; using the
    // uncompressed size here reads past a deflated entry (and short of a stored one) — "unexpected end of file".
    const csize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const offset = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    out.push({ name, method, size, csize, offset, dir: name.endsWith('/') || name.endsWith('\\') });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

/**
 * Inflate one zip entry (store or deflate).
 * The length comes from the central directory, but a streamed archive (PowerShell's Compress-Archive among them) may
 * write zeros in the local header: those entries are bounded by the next local header instead.
 */
export function readZipEntry(buf, ent, nextOffset) {
  if (ent.size === 0 && ent.csize === 0) return Buffer.alloc(0);
  const p = ent.offset;
  if (buf.readUInt32LE(p) !== 0x04034b50) throw new Error(`bad local header for ${ent.name}`);
  const nameLen = buf.readUInt16LE(p + 26);
  const extraLen = buf.readUInt16LE(p + 28);
  let start = p + 30 + nameLen + extraLen;
  let len = ent.csize;
  // local header sizes are authoritative when present; 0 with a non-zero central size means "in a data descriptor"
  const localCsize = buf.readUInt32LE(p + 18);
  if (localCsize > 0) len = localCsize;
  if (!(len > 0) && nextOffset > start) len = nextOffset - start;
  const end = Math.min(buf.length, start + len);
  const data = buf.subarray(start, end);
  if (ent.method === 0) return Buffer.from(data);
  if (ent.method === 8) {
    // a deflate stream ends at its own terminator, so trailing bytes (a data descriptor) are harmless
    return zlib.inflateRawSync(data);
  }
  throw new Error(`unsupported compression method ${ent.method} for ${ent.name}`);
}

/** Reject absolute / traversing entry names: a zip is untrusted input. */
function safeEntryPath(root, name) {
  const clean = name.replace(/\\/g, '/').replace(/^\/+/, '');
  if (!clean || clean.split('/').some((s) => s === '..' || s === '.')) return null;
  const abs = path.resolve(root, clean);
  const rel = path.relative(root, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return abs;
}

/**
 * Extract a zip into `destDir`. Entries are written one by one; a bad entry aborts with the archive left as-is
 * (the caller removes the whole directory on failure).
 * @param {string} zipPath @param {string} destDir
 * @returns {Promise<{ files: number, skipped: string[] }>}
 */
export async function extractZip(zipPath, destDir) {
  const buf = await fsp.readFile(zipPath);
  const entries = listZipEntries(buf);
  // local-header offsets in file order, so a size-less entry can be bounded by the next one
  const offsets = entries.filter((e) => !e.dir).map((e) => e.offset).sort((a, b) => a - b);
  const nextAfter = (off) => { const i = offsets.indexOf(off); return i >= 0 && i + 1 < offsets.length ? offsets[i + 1] : buf.length; };
  const skipped = [];
  let files = 0;
  for (const ent of entries) {
    const abs = safeEntryPath(destDir, ent.name);
    if (!abs) { skipped.push(ent.name); continue; }
    if (ent.dir) { await fsp.mkdir(abs, { recursive: true }); continue; }
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    await fsp.writeFile(abs, readZipEntry(buf, ent, nextAfter(ent.offset)));
    files++;
    if (files > 20000) throw new Error('zip has more than 20000 files; refusing');
  }
  return { files, skipped };
}

// ---------------------------------------------------------------------------------------------------------------
// the revision: what a client uses to bust its own module cache (`/mods/<id>/client.js?v=<revision>`)

/** Directories a content fingerprint never walks (a package with node_modules would dominate the scan). */
const FP_SKIP_DIRS = new Set(['node_modules', '.git', '.cache', '__payload']);
/** How many files a fingerprint reads metadata for before it stops counting (the name is kept either way). */
const FP_MAX_FILES = 5000;

/**
 * A cheap, stable fingerprint of one package folder: its files' relative paths, sizes and mtimes.
 *
 * WHY NOT THE FILE CONTENTS: this runs on every scan (including every server start) over every package, and the
 * packages are small text files — but reading them all is still the wrong shape for a value whose only job is
 * "did anything change". Path + size + mtime changes on every edit, install, uninstall and rename, which is exactly
 * the set of events that has to invalidate a client's module cache.
 *
 * @param {string} dirAbs
 * @returns {Promise<string>} e.g. `12f:3` (hash, file count) — '' for a directory that cannot be read
 */
async function folderFingerprint(dirAbs) {
  /** @type {string[]} */
  const rows = [];
  let truncated = false;
  async function walk(dir, prefix, depth) {
    if (truncated || depth > 8) return;
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const ent of entries) {
      if (truncated) return;
      const abs = path.join(dir, ent.name);
      const relPath = prefix ? `${prefix}/${ent.name}` : ent.name;
      if (ent.isDirectory()) {
        if (FP_SKIP_DIRS.has(ent.name)) continue;
        await walk(abs, relPath, depth + 1);
        continue;
      }
      if (!ent.isFile()) continue;
      let st;
      try { st = await fsp.stat(abs); } catch { continue; }
      rows.push(`${relPath}\u0000${st.size}\u0000${Math.round(st.mtimeMs)}`);
      if (rows.length >= FP_MAX_FILES) { truncated = true; return; }
    }
  }
  await walk(dirAbs, '', 0);
  // FNV-1a over the sorted rows: not a security hash, just a change detector
  let h = 0x811c9dc5;
  const joined = rows.join('\n');
  for (let i = 0; i < joined.length; i++) {
    h ^= joined.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `${h.toString(16)}:${rows.length}${truncated ? '+' : ''}`;
}

/** The `revision` + fingerprints remembered from the previous run (`mods/mods.cache.json`).
 *  ⚠️ also listed in the server's `MOD_PRIVATE` set — this file is bookkeeping, not content. */
const CACHE_STATE_FILE = 'mods.cache.json';

/**
 * 我们**自己**会往 `mods/` 里写的簿记文件 —— watch 回调必须忽略它们，否则
 * `writeCacheState → watch → scan → refreshRevision → writeCacheState` 会无限自转。
 *
 * ⚠️ 这里踩过一次坑（2026-10）：过滤当时只写了 `STATE_FILE`（`mods.state.json`），而
 * `refreshRevision()` 写的是 `CACHE_STATE_FILE`（`mods.cache.json`）—— 两个名字不一样，于是**每次扫描都自我触发**。
 * 实测一次运行里 26 644 次扫描只有 12 次真的发现了变化，代价是每秒若干轮全量指纹重算加写盘。
 * **以后再加簿记文件，记得加进这个集合。**
 */
const SELF_WRITTEN_FILES = new Set([STATE_FILE, CACHE_STATE_FILE]);

/** `file` 拿不到名字时的兜底：刚写完簿记文件的一小段时间里，事件一律先当作自己的。 */
const SELF_WRITE_GRACE_MS = 800;

/**
 * @param {{ root?: string, log?: object }} [opts] `root` = project root; mods live in `<root>/mods`.
 */
export function createModManager({ root = process.cwd(), log = noopLog, fetchFn = globalThis.fetch, apply = null } = {}) {
  const modsDir = path.join(root, MODS_DIRNAME);
  const statePath = path.join(modsDir, STATE_FILE);
  /** @type {Map<string, object>} id → record (mounted or problem) */
  let records = new Map();
  let watcher = null;
  let debounce = null;
  /** 我们自己刚往 `mods/` 写完簿记文件的时刻 + 宽限 —— 见 `SELF_WRITTEN_FILES` 与 `watch()`。 */
  let selfWriteUntil = 0;
  /** Bumped on every change so clients can poll cheaply — see `refreshRevision`: it is monotonic across restarts. */
  let revision = 0;
  const listeners = new Set();
  /** The updater is created after `scan` exists (it re-scans after installing). */
  let updater = null;

  const rel = (p) => path.relative(root, p).split(path.sep).join('/');

  /** Persisted enable flags: `{ [id]: boolean }`. A missing id means "enabled" (drop-in default). */
  function readState() {
    const s = readJsonSync(statePath);
    return s && typeof s === 'object' && !Array.isArray(s) ? s : {};
  }
  async function writeState(state) {
    await fsp.mkdir(modsDir, { recursive: true });
    await fsp.writeFile(statePath, JSON.stringify(state, null, 2));
  }

  /**
   * The revision bookkeeping kept between runs: `mods/mods.cache.json`.
   *
   * WHY IT IS PERSISTED — the user-visible bug it fixes: `revision` is what a client puts in
   * `/mods/<id>/client.js?v=<revision>`, so it is the ONLY thing that makes a browser fetch a mod's code again after
   * the files changed. It used to start at 0 on every server start: after a restart the counter handed out the same
   * `?v=1` / `?v=2` … the browser had already cached, so the page kept running the mod code from BEFORE the last
   * edits — which reads exactly like "the mod rolled back to an older version every time I restart the server".
   *
   * So: the counter never goes down, and it only advances when a package folder actually changed (fingerprint
   * comparison). A restart with untouched files therefore keeps serving the same `?v=`, which is what makes the
   * browser cache useful instead of harmful.
   */
  const cacheStatePath = path.join(modsDir, CACHE_STATE_FILE);
  let fingerprints = {};
  function readCacheState() {
    const s = readJsonSync(cacheStatePath);
    if (!s || typeof s !== 'object' || Array.isArray(s)) return { revision: 0, fingerprints: {} };
    const rev = Number(s.revision);
    return {
      revision: Number.isFinite(rev) && rev >= 0 ? Math.floor(rev) : 0,
      fingerprints: s.fingerprints && typeof s.fingerprints === 'object' && !Array.isArray(s.fingerprints) ? s.fingerprints : {},
    };
  }
  // Pick the counter up where the previous run left it: that is what keeps `?v=` from repeating after a restart.
  {
    const prev = readCacheState();
    revision = prev.revision;
    fingerprints = prev.fingerprints;
  }
  async function writeCacheState() {
    // 先开时间窗再写：`file` 拿不到名字时 watch 回调靠它判断"这是我们自己写的"
    selfWriteUntil = Date.now() + SELF_WRITE_GRACE_MS;
    try {
      await fsp.mkdir(modsDir, { recursive: true });
      await fsp.writeFile(cacheStatePath, JSON.stringify({ revision, fingerprints }, null, 2));
    } catch (e) {
      log.warn(`[mods] cannot write ${CACHE_STATE_FILE}: ${e.message} (版本号无法记住，重启后可能又发旧代码)`);
    }
  }

  /**
   * Recompute every package folder's fingerprint and advance the revision when something changed.
   * Called at the end of `scan()`, i.e. on start, on a watched change and after an install.
   */
  async function refreshRevision() {
    const dirs = [];
    try {
      for (const ent of await fsp.readdir(modsDir, { withFileTypes: true })) {
        if (!ent.isDirectory() || ent.name.startsWith('.') || ent.name.startsWith('_')) continue;
        dirs.push(ent.name);
      }
    } catch { /* mods/ may not exist yet */ }
    dirs.sort();
    /** @type {Record<string, string>} */
    const next = {};
    for (const dir of dirs) next[dir] = await folderFingerprint(path.join(modsDir, dir));
    const changed = dirs.filter((d) => next[d] !== fingerprints[d]).length
      + Object.keys(fingerprints).filter((d) => !(d in next)).length;
    if (changed > 0 && Object.keys(fingerprints).length > 0) {
      revision++;
      log.info(`[mods] ${changed} 个模组目录有变化 → revision ${revision}`);
    }
    fingerprints = next;
    await writeCacheState();
    return revision;
  }

  /** A record that could not be mounted, kept visible so the user sees what they dropped. */
  function problemRecord(dirName, problems, warnings = [], extra = {}) {
    return {
      id: dirName, name: dirName, version: null, api: null, clientOnly: false,
      status: 'problem', problems, warnings, dir: rel(path.join(modsDir, dirName)), folder: dirName,
      entry: { client: null, sim: null }, provides: { bonds: [], kits: [], styles: [] }, requires: { mods: [], game: null },
      url: null, enabled: false, ...extra,
    };
  }

  /**
   * Inspect one package directory. Accepts a manifest at the root or one level down (so a zip whose entries were
   * wrapped in a single folder still mounts).
   */
  async function inspect(dirName) {
    const abs = path.join(modsDir, dirName);
    let st;
    try { st = await fsp.stat(abs); } catch { return null; }
    if (!st.isDirectory()) return null;
    if (dirName === MODS_DIRNAME || dirName.startsWith('.') || dirName.startsWith('_')) return null;
    let manifestAbs = path.join(abs, MANIFEST);
    let base = abs;
    if (!fs.existsSync(manifestAbs)) {
      // one level down: <dir>/<inner>/mod.json
      let inner = null;
      try { inner = (await fsp.readdir(abs, { withFileTypes: true })).filter((e) => e.isDirectory()); } catch { inner = []; }
      const withManifest = inner.filter((e) => fs.existsSync(path.join(abs, e.name, MANIFEST)));
      if (withManifest.length === 1) { base = path.join(abs, withManifest[0].name); manifestAbs = path.join(base, MANIFEST); }
      else if (withManifest.length > 1) {
        return problemRecord(dirName, ['several subfolders contain a mod.json; expected one package per folder']);
      } else {
        return problemRecord(dirName, [`no ${MANIFEST} found (looked in the folder and one level down)`]);
      }
    }
    const raw = readJsonSync(manifestAbs);
    if (raw === null) return problemRecord(dirName, [`${MANIFEST} is missing or not valid JSON`]);
    const { manifest, problems, warnings } = validateManifest(raw, dirName);
    if (!manifest) return problemRecord(dirName, problems, warnings);
    // entry files must exist (a typo would otherwise fail only when the client tries to import it)
    for (const [kind, file] of Object.entries(manifest.entry)) {
      if (file && !fs.existsSync(path.join(base, file))) problems.push(`entry.${kind} not found: ${file}`);
    }
    // content tables must exist too — a pack whose chess.json is misspelled would otherwise mount as "ok" and simply
    // contribute nothing, which is indistinguishable from "the mod does not work".
    for (const [table, file] of Object.entries(manifest.content || {})) {
      if (!fs.existsSync(path.join(base, file))) problems.push(`content.${table} file not found: ${file}`);
    }
    if (problems.length) return { ...problemRecord(dirName, problems, warnings), ...manifest, status: 'problem' };
    return {
      ...manifest, status: 'ok', problems: [], warnings,
      // ⚠️ `url` is built from the **folder name**, never from the manifest id: the static mount serves
      // `/mods/<folder>/…` off the filesystem, so a package whose folder is not named after its id (hand-copied, or
      // unzipped under a different name) would otherwise be handed a URL that 404s — the failure then shows up only
      // as "Failed to fetch dynamically imported module" in the browser console.
      dir: rel(base), url: modUrl(dirName), folder: dirName,
      baseAbs: base,
      files: { clientAbs: manifest.entry.client ? path.join(base, manifest.entry.client) : null,
               simAbs: manifest.entry.sim ? path.join(base, manifest.entry.sim) : null },
    };
  }

  /** Rescan `mods/` from disk. Never throws: a broken package becomes a `problem` record. */
  async function scan() {
    await fsp.mkdir(modsDir, { recursive: true });
    const state = readState();
    let names = [];
    try {
      names = (await fsp.readdir(modsDir, { withFileTypes: true }))
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .sort((a, b) => a.localeCompare(b));
    } catch (e) {
      log.warn(`[mods] cannot read ${rel(modsDir)}: ${e.message}`);
    }
    const next = new Map();
    for (const name of names) {
      const rec = await inspect(name);
      if (!rec) continue;
      // state key is the resolved id (a folder may be named differently from the manifest id)
      rec.enabled = state[rec.id] !== false;
      if (rec.status === 'problem') rec.enabled = false;
      if (next.has(rec.id)) {
        next.set(rec.id, problemRecord(rec.id, [`duplicate mod id ${rec.id}: also provided by ${next.get(rec.id).dir}`]));
        continue;
      }
      next.set(rec.id, rec);
    }
    // dependency check (only against what is present here)
    for (const rec of next.values()) {
      if (rec.status !== 'ok') continue;
      const missing = rec.requires.mods.filter((d) => !next.has(d));
      if (missing.length) {
        rec.status = 'problem';
        rec.problems.push(`missing dependencies: ${missing.join(', ')}`);
        rec.enabled = false;
      }
    }
    records = next;
    // The revision may only advance when a package folder actually changed (fingerprints), and it never goes down:
    // clients cache `/mods/<id>/client.js?v=<revision>`, so reusing an old number after a restart means the page
    // keeps running the code from before the last edit — see the note on `refreshRevision`.
    await refreshRevision();
    log.info(`[mods] ${countOk()} mounted, ${countProblems()} problem(s), revision ${revision}`);
    for (const fn of listeners) { try { fn(); } catch { /* a listener must not break the scan */ } }
    return list();
  }

  const countOk = () => [...records.values()].filter((r) => r.status === 'ok').length;
  const countProblems = () => [...records.values()].filter((r) => r.status === 'problem').length;

  /** Public view of every package (manifest fields + status + live update state; no absolute paths). */
  function list() {
    const ups = updater ? updater.status() : {};
    return {
      api: MOD_API,
      revision,
      dir: rel(modsDir),
      mods: [...records.values()].map((r) => ({
        id: r.id, name: r.name, version: r.version, api: r.api, author: r.author, description: r.description,
        homepage: r.homepage, clientOnly: r.clientOnly, kind: r.kind ?? null, status: r.status, enabled: r.enabled,
        problems: r.problems, warnings: r.warnings, dir: r.dir, url: r.url,
        entry: {
          client: r.entry.client ? `${r.url}${r.entry.client}` : null,
          sim: r.entry.sim ? `${r.url}${r.entry.sim}` : null,
        },
        // content / hooks / update describe what a package can DO (see docs/API.md); the page groups by them and the
        // client loader uses `content` to know which tables to fetch.
        content: r.content || {},
        hooks: r.hooks || {},
        update: r.update || null,
        updateState: ups[r.id] || null,
        provides: r.provides, requires: r.requires,
      })).sort((a, b) => (a.status === b.status ? a.id.localeCompare(b.id) : a.status === 'problem' ? -1 : 1)),
    };
  }

  /**
   * Turn one package on or off, and APPLY the change.
   *
   * ⚠️ Flipping the flag is not enough, and this used to be the whole bug: the effect of a package is not "it is listed",
   * it is (a) its `entry.sim` modules being loaded into the battle, and (b) its content tables being merged into the
   * tables the game reads. Both are materialised with the LOADER (`installMods` → merged data directory + sim modules),
   * so toggling has to re-run it — otherwise:
   *   · disabling a content pack leaves its records on disk (the `/data/` directory is still the merged one),
   *   · disabling a behaviour pack leaves its sim modules registered,
   *   · enabling anything after a boot changes nothing at all (this is the case that is WORSE than "no effect": the
   *     data directory is removed, so `/data/*.json` 404s and the page cannot boot).
   *
   * `apply` is injected by server/index.js (it is the same `installMods` the boot path uses), so this module stays
   * independent of the loader's internals.
   *
   * @param {string} id @param {boolean} on
   * @returns {Promise<{ ok: boolean, error?: string, mod?: object, applied?: object }>}
   */
  async function enable(id, on) {
    const rec = records.get(id);
    if (!rec) return { ok: false, error: `no such mod: ${id}` };
    if (on && rec.status !== 'ok') return { ok: false, error: `${id} cannot be enabled: ${rec.problems[0] || 'invalid package'}` };
    const state = readState();
    state[id] = !!on;
    await writeState(state);
    rec.enabled = !!on;
    revision++;
    void writeCacheState();   // keep the counter durable (it may only ever go up)
    let applied = null;
    if (apply) {
      try { applied = await apply({ reason: on ? 'enable' : 'disable', id }); }
      catch (e) { log.error(`[mods] applying "${id}" failed`, e); return { ok: false, error: `applied with errors: ${e.message}`, mod: list().mods.find((m) => m.id === id) }; }
    }
    for (const fn of listeners) { try { fn(); } catch { /* a listener must not break the toggle */ } }
    return { ok: true, mod: list().mods.find((m) => m.id === id), applied };
  }

  /** Remove a package from disk (and its enable flag). Confined to `mods/`. */
  async function remove(id) {
    const rec = records.get(id);
    if (!rec) return { ok: false, error: `no such mod: ${id}` };
    const target = path.resolve(root, rec.dir);
    const guard = path.resolve(modsDir) + path.sep;
    if (!(target + path.sep).startsWith(guard)) return { ok: false, error: 'refusing to delete outside mods/' };
    try { await fsp.rm(target, { recursive: true, force: true }); }
    catch (e) { return { ok: false, error: `cannot delete: ${e.message}` }; }
    const state = readState();
    delete state[id];
    await writeState(state);
    records.delete(id);
    revision++;
    void writeCacheState();   // keep the counter durable (it may only ever go up)
    return { ok: true };
  }

  /**
   * Install a zip buffer (the drag-and-drop upload path). The archive is extracted into a staging area, then its
   * contents are moved into `mods/<id>-v<version>/` — **flattened** when everything sits under one top-level folder,
   * which is what every "compress this folder" tool produces. Without that, a package would land at
   * `mods/<id>-v<version>/<name>/mod.json` and its manifest URLs (and enable/remove) would not line up.
   *
   * THE FOLDER IS NAMED AFTER THE MANIFEST, NOT AFTER THE FILE (maintainer's rule, 2026-10-08): the loader reads
   * `mod.json` **inside** the archive (`inspectZipManifest` — it never extracts before it validates) and names the
   * folder `<id>-v<version>`, so the folder on disk says which package and which build it holds. The zip's own file
   * name is only the fallback for an archive whose manifest cannot be read, and a package that declares no usable
   * version lands under its bare id.
   *
   * A zip whose id is ALREADY mounted is treated as an update of that package: its folder is replaced, and renamed
   * when the version in the name changed. Without that, dropping `Foo_v0.2.zip` next to an installed `Foo` would leave
   * two folders claiming the same id — which the scan reports as a duplicate and then mounts neither.
   *
   * @param {string} filename @param {Buffer} buf
   */
  async function installZip(filename, buf) {
    const stem = path.basename(filename, path.extname(filename)).replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 64) || 'mod';
    await fsp.mkdir(modsDir, { recursive: true });
    const probe = inspectZipManifest(buf);
    const id = probe.manifest?.id || stem;
    const wanted = packageFolderName(id, probe.manifest?.version);
    let existing = records.get(id) || null;
    // a folder dropped in by hand may not be in the map yet, and "is this an update?" must not be answered by a stale one
    if (!existing) { await scan(); existing = records.get(id) || null; }
    if (existing?.folder) {
      return installZipAt(buf, wanted, { replaceFolder: existing.folder, expectId: id });
    }
    // not a package we know: never clobber an unrelated folder that happens to carry the same name
    let dirName = wanted;
    for (let i = 2; fs.existsSync(path.join(modsDir, dirName)); i++) dirName = `${wanted}-${i}`;
    return installZipAt(buf, dirName, { replaceFolder: null, expectId: id });
  }

  /**
   * The one extraction path.
   *
   * `replaceFolder` is the package folder (a name under `mods/`) this install REPLACES, or null for a fresh install:
   * it is the update path and the "drop a newer zip on an installed package" path. It may differ from `dirName`,
   * because an update renames `Foo-v0.1` to `Foo-v0.2` — the old folder is moved aside first and only deleted once the
   * new one is in place. If anything fails, it is put back, so a failed install never costs the user their package.
   *
   * @param {Buffer} buf @param {string} dirName
   * @param {{ replaceFolder?: string|null, expectId?: string|null }} [opts]
   */
  async function installZipAt(buf, dirName, { replaceFolder = null, expectId = null } = {}) {
    const replace = !!replaceFolder;
    const dest = path.join(modsDir, dirName);
    const stage = path.join(modsDir, `.tmp-${dirName}-${process.pid}-${Date.now()}`);
    /** Package folders moved out of the way; restored if anything below throws. Dot-prefixed so the scan ignores them. */
    const aside = [];
    const moveAside = async (from) => {
      let n = 1;
      while (fs.existsSync(path.join(modsDir, `.old-${path.basename(from)}-${n}`))) n++;
      const to = path.join(modsDir, `.old-${path.basename(from)}-${n}`);
      await fsp.rename(from, to);
      aside.push({ from, to });
    };
    /** Did WE create `dest`? Only a folder this call created may be removed on the way out. */
    let freshDest = false;
    try {
      await fsp.mkdir(stage, { recursive: true });
      const zipPath = path.join(stage, 'package.zip');
      await fsp.writeFile(zipPath, buf);
      const unpack = path.join(stage, 'unpack');
      await fsp.mkdir(unpack, { recursive: true });
      const { files, skipped } = await extractZip(zipPath, unpack);
      // pick the payload root: a single top-level folder is unwrapped, anything else is taken as-is
      const top = await fsp.readdir(unpack, { withFileTypes: true });
      const dirs = top.filter((e) => e.isDirectory());
      const loose = top.filter((e) => !e.isDirectory());
      const rootDir = dirs.length === 1 && loose.length === 0 ? path.join(unpack, dirs[0].name) : unpack;
      if (!fs.existsSync(path.join(rootDir, MANIFEST))) {
        const found = await findManifestBelow(rootDir);
        if (found) throw new Error(`no ${MANIFEST} at the package root (found a nested one at ${path.relative(unpack, found)})`);
      }
      // an update must not silently change what the package IS: the id has to match the folder it replaces
      if (replace) {
        const incoming = readJsonSync(path.join(rootDir, MANIFEST));
        const declared = incoming && typeof incoming.id === 'string' && incoming.id.trim() ? incoming.id.trim() : null;
        const want = expectId || packageIdFromFolder(replaceFolder);
        if (declared && declared !== want) throw new Error(`the archive is "${declared}", not "${want}" — refusing to replace another package`);
      }
      // the folder being replaced may still carry the previous version in its name — move it aside before the new copy lands
      const old = replaceFolder ? path.join(modsDir, replaceFolder) : null;
      if (old && fs.existsSync(old) && path.resolve(old) !== path.resolve(dest)) await moveAside(old);
      if (fs.existsSync(dest)) {
        if (!replace) throw new Error(`${dest} already exists`);
        await moveAside(dest);
      }
      freshDest = true;
      await fsp.mkdir(dest, { recursive: true });
      await fsp.rename(rootDir, path.join(dest, '__payload'));
      const payload = path.join(dest, '__payload');
      for (const e of await fsp.readdir(payload)) {
        await fsp.rename(path.join(payload, e), path.join(dest, e));
      }
      await fsp.rmdir(payload);
      await fsp.rm(stage, { recursive: true, force: true });
      for (const { to } of aside) await fsp.rm(to, { recursive: true, force: true }).catch(() => {});
      await scan();
      const wantDir = rel(dest);
      const rec = [...records.values()].find((r) => r.dir === wantDir) || null;
      return {
        ok: true, id: rec ? rec.id : dirName, folder: dirName,
        replaced: replace ? replaceFolder : null,
        renamed: replace && replaceFolder !== dirName ? [replaceFolder, dirName] : null,
        files, skipped: skipped.length, status: rec ? rec.status : 'unknown',
        problems: rec ? rec.problems : [],
      };
    } catch (e) {
      // put the previous copy back (an update that failed must not cost the user their package)
      try {
        if (freshDest) await fsp.rm(dest, { recursive: true, force: true });
        for (const { from, to } of aside.reverse()) if (fs.existsSync(to)) await fsp.rename(to, from);
        await fsp.rm(stage, { recursive: true, force: true });
      } catch (restoreErr) {
        log.error(`[mods] ${dirName}: install failed AND the previous copy could not be restored`, restoreErr);
      }
      if (replace) await scan().catch(() => {});
      return { ok: false, error: e.message };
    }
  }

  /** Shallow search (2 levels) for a mod.json below `dir`, used to explain a mis-shaped archive. */
  async function findManifestBelow(dir) {
    for (const a of await fsp.readdir(dir, { withFileTypes: true }).catch(() => [])) {
      if (!a.isDirectory()) continue;
      const p1 = path.join(dir, a.name, MANIFEST);
      if (fs.existsSync(p1)) return p1;
      for (const b of await fsp.readdir(path.join(dir, a.name), { withFileTypes: true }).catch(() => [])) {
        if (!b.isDirectory()) continue;
        const p2 = path.join(dir, a.name, b.name, MANIFEST);
        if (fs.existsSync(p2)) return p2;
      }
    }
    return null;
  }

  /** Start watching `mods/` so a dropped folder or zip mounts itself. */
  function watch() {
    if (watcher) return;
    try {
      watcher = fs.watch(modsDir, { persistent: false }, (_ev, file) => {
        // 我们自己写的簿记文件（mods.cache.json / mods.state.json / .tmp-*）必须忽略，
        // 否则 `writeCacheState → watch → scan → writeCacheState` 会无限自转 —— 见 SELF_WRITTEN_FILES。
        if (file) {
          const name = String(file);
          if (SELF_WRITTEN_FILES.has(name) || name.startsWith('.tmp-')) return;
        } else if (Date.now() < selfWriteUntil) {
          // Node 不保证给出 `file`；拿不到名字时，刚写完的那一小段时间是我们的，不是用户的
          return;
        }
        if (debounce) clearTimeout(debounce);
        debounce = setTimeout(() => { debounce = null; scan().catch((e) => log.error('[mods] rescan failed', e)); }, WATCH_DEBOUNCE_MS);
      });
      watcher.on('error', (e) => log.warn(`[mods] watcher error: ${e.message}`));
    } catch (e) {
      log.warn(`[mods] cannot watch ${rel(modsDir)}: ${e.message} (drop-in mounting disabled; /api/mods/scan still works)`);
    }
  }

  function stop() {
    if (debounce) { clearTimeout(debounce); debounce = null; }
    if (watcher) { try { watcher.close(); } catch { /* already closed */ } watcher = null; }
  }

  // ---------------------------------------------------------------------------------------------------------------
  // updates: a package declares `update` in its manifest; the updater fetches, validates and swaps the folder.
  // The installer is injected so the updater never grows a second unzip path (see server/update.js).

  /**
   * Install a zip buffer as an ALREADY MOUNTED package (the update path): same extraction rules, and the folder is
   * renamed to whatever version the incoming archive declares (`Foo-v0.1` → `Foo-v0.2`), so the name on disk keeps
   * matching the manifest it holds.
   */
  async function installOver(id, buf, manifest) {
    const rec = records.get(id);
    if (!rec) return { ok: false, error: `no such mod: ${id}` };
    const target = path.resolve(root, rec.dir);
    const guard = path.resolve(modsDir) + path.sep;
    if (!(target + path.sep).startsWith(guard)) return { ok: false, error: 'refusing to write outside mods/' };
    const dirName = packageFolderName(id, manifest?.version ?? rec.version);
    const res = await installZipAt(buf, dirName, { replaceFolder: rec.folder, expectId: id });
    if (res.ok) {
      log.info(`[mods] ${id} replaced with ${manifest?.version ?? '?'} → ${res.folder}`);
      await scan();
    }
    return res;
  }

  if (typeof createUpdater === 'function') {
    updater = createUpdater({
      root, log, fetchFn,
      install: installOver,
      scan: () => scan(),
    });
  }

  /** Check the declared update sources. `force` ignores the `check` interval; `install: false` only reports. */
  async function checkUpdates({ force = true, install = true, id = null } = {}) {
    if (!updater) return { ok: false, error: 'this build has no updater' };
    if (id) {
      const rec = records.get(id);
      if (!rec) return { ok: false, error: `no such mod: ${id}` };
      const report = await updater.check(rec, { force, install });
      if (report.status === 'updated') await scan();
      return { ok: true, reports: [report], status: updater.status() };
    }
    const out = await updater.checkAll({ force, install, records: [...records.values()] });
    if ((out.reports || []).some((r) => r.status === 'updated')) await scan();
    return { ok: true, ...out, status: updater.status() };
  }

  function startUpdates(opts = {}) {
    if (!updater) return false;
    return updater.start({ ...opts, records: [...records.values()] });
  }

  /** Per-package content report (what a pack contributes, and which built-in ids it overrides). */
  function contentOf(id, { baseTables = null } = {}) {
    const rec = records.get(id);
    if (!rec || rec.status !== 'ok') return null;
    if (!rec.content || !Object.keys(rec.content).length) return { id, tables: {}, problems: [], records: 0 };
    return contentReport(rec, { baseTables });
  }

  return {
    modsDir,
    get revision() { return revision; },
    list,
    scan,
    enable,
    remove,
    installZip,
    watch,
    stop,
    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    /** Resolved entry paths for the client bootstrap (absolute; server-side use only). */
    entryFor(id) {
      const r = records.get(id);
      if (!r || r.status !== 'ok' || !r.enabled) return null;
      return { id: r.id, clientAbs: r.files.clientAbs, simAbs: r.files.simAbs, url: r.url, clientOnly: r.clientOnly };
    },
    records: () => records,
    // ---- updates / content / diagnostics (the extended surface) --------------------------------------------------
    /** Where each package's update stands: `{ [id]: { checkedAt, version, status, detail } }`. */
    updateStatus: () => (updater ? updater.status() : {}),
    checkUpdates,
    startUpdates,
    contentOf,
    /** Enabled packages that contribute simulation code or data — the "both peers must install it" set. */
    simMods: () => [...records.values()].filter((r) => r.status === 'ok' && r.enabled && !r.clientOnly)
      .map((r) => ({ id: r.id, version: r.version, simAbs: r.files.simAbs, content: Object.keys(r.content || {}), hooks: Object.keys(r.hooks || {}) })),
    /** A compact summary for the log line at boot. */
    summary: () => ({
      mounted: countOk(),
      problems: countProblems(),
      clientOnly: [...records.values()].filter((r) => r.status === 'ok' && r.enabled && r.clientOnly).length,
      updateSources: [...records.values()].filter((r) => r.status === 'ok' && r.update?.url).length,
      contentPacks: [...records.values()].filter((r) => r.status === 'ok' && r.enabled && Object.keys(r.content || {}).length).length,
    }),
  };
}
