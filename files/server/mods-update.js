// server/update.js — keeping installed packages up to date, without ever running code the user did not ask for.
//
// DESIGN
//   A package opts in by declaring `update` in its manifest:
//     "update": { "source": "url", "url": "https://…/MyMod.zip", "check": "daily", "auto": true }
//   The updater fetches that zip, looks INSIDE it (the archive is never extracted before it is validated), and installs
//   it only when all of this holds:
//     · the archive contains exactly one package, and its `id` equals the id of the installed package (no package can
//       replace another one — that would be a remote takeover of a name the user trusts);
//     · the incoming `version` is strictly newer than the installed one (a downgrade is never silent);
//     · its declared `api` is one this build speaks;
//     · the download is a real zip and stays under the size cap.
//   Installation is atomic-ish and keeps the folder name honest: the folder being replaced is renamed aside, the new
//   files are written under the INCOMING version's name (`Foo-v0.1.0` → `Foo-v0.2.0`), and only then is the old copy
//   removed. If anything fails, the previous copy is put back under its own name.
//
//   ⚠️ NOTHING IS AUTO-EXECUTED. A downloaded package is still third-party JavaScript: `auto: true` only means "keep the
//   files fresh". The page still loads it the same way as a hand-copied folder, and the manager page shows where each
//   copy came from (manifest.update + `state/updates.json`).

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { compareVersions, validateManifest, MANIFEST, MODS_DIRNAME } from './manifest.js';
import { listZipEntries, readZipEntry, extractZip } from './mods.js';

const noopLog = { info() {}, warn() {}, error() {} };

/** Nothing bigger than this is downloaded (a mod package is code + data + maybe art). */
export const MAX_DOWNLOAD_BYTES = 64 * 1024 * 1024;

/** How long a `check` hint waits before the same package is polled again. */
const CHECK_MS = { startup: 0, hourly: 3600_000, daily: 24 * 3600_000, weekly: 7 * 24 * 3600_000, manual: Infinity };

/**
 * Read the manifest straight out of a zip buffer, without extracting anything.
 * @param {Buffer} buf
 * @returns {{ manifest: object|null, problems: string[], dirName: string|null, files: string[] }}
 */
export function inspectZipManifest(buf) {
  let entries;
  try { entries = listZipEntries(buf); } catch (e) { return { manifest: null, problems: [e.message], dirName: null, files: [] }; }
  const files = entries.filter((e) => !e.dir).map((e) => e.name);
  // the manifest must sit at the root, or inside exactly one wrapping folder (the shape a GitHub zip has)
  const byDepth = new Map();
  for (const name of files) {
    const parts = name.split('/').filter(Boolean);
    byDepth.set(parts.length, (byDepth.get(parts.length) || 0) + 1);
  }
  const rootManifest = files.find((n) => n === MANIFEST);
  const nested = files.filter((n) => n.split('/').length === 2 && n.endsWith(`/${MANIFEST}`));
  const manifestName = rootManifest || (nested.length === 1 ? nested[0] : null);
  if (!manifestName) {
    return { manifest: null, problems: [`no ${MANIFEST} at the archive root (or in exactly one wrapping folder)`], dirName: null, files };
  }
  const entry = entries.find((e) => e.name === manifestName);
  let raw;
  try { raw = JSON.parse(readZipEntry(buf, entry, buf.length).toString('utf8')); }
  catch (e) { return { manifest: null, problems: [`${MANIFEST} is not valid JSON: ${e.message}`], dirName: null, files }; }
  const dirName = manifestName === MANIFEST ? null : manifestName.split('/')[0];
  const { manifest, problems, warnings } = validateManifest(raw, dirName || 'package');
  if (!manifest) return { manifest: null, problems, warnings, dirName, files };
  return { manifest, problems, warnings, dirName, files };
}

/** Fetch a URL into a Buffer, refusing non-http(s), redirects off-host are allowed (CDNs) but the size is capped. */
export async function download(url, { fetchFn = globalThis.fetch, maxBytes = MAX_DOWNLOAD_BYTES, timeoutMs = 20000 } = {}) {
  if (!/^https?:\/\//i.test(String(url))) throw new Error(`refusing to fetch ${url}: only http(s) is allowed`);
  if (typeof fetchFn !== 'function') throw new Error('no fetch available in this Node runtime');
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetchFn(url, { signal: ac.signal, redirect: 'follow', headers: { accept: 'application/zip,application/octet-stream,*/*' } });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    const len = Number(res.headers?.get?.('content-length') || 0);
    if (len && len > maxBytes) throw new Error(`package is ${len} bytes (max ${maxBytes})`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > maxBytes) throw new Error(`package is ${buf.length} bytes (max ${maxBytes})`);
    return buf;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Create the updater. It only touches the filesystem under `<root>/mods`, and only after a package asked for it.
 *
 * `install` is injected by server/mods.js (the module that owns the mods directory and the extraction rules), so the
 * updater never grows a second, subtly different unzip path.
 *
 * @param {{ root: string, log?: object, fetchFn?: Function, install?: (dirName: string, buf: Buffer, manifest: object) => Promise<{ok:boolean,error?:string}>, scan?: () => Promise<any>, now?: () => number }} opts
 */
export function createUpdater({ root, log = noopLog, fetchFn = globalThis.fetch, install = null, scan = null, now = () => Date.now() } = {}) {
  const modsDir = path.join(root, MODS_DIRNAME);
  const statePath = path.join(modsDir, 'mods.updates.json');
  /** @type {Map<string, {checkedAt:number, status:string, detail?:string, from?:string, to?:string}>} */
  const last = new Map();
  let timer = null;
  let running = false;

  function readState() {
    try { return JSON.parse(fs.readFileSync(statePath, 'utf8')) || {}; } catch { return {}; }
  }
  async function writeState() {
    try {
      await fsp.mkdir(modsDir, { recursive: true });
      await fsp.writeFile(statePath, JSON.stringify(Object.fromEntries(last), null, 2));
    } catch (e) { log.warn?.('[mods] could not persist update state:', e.message); }
  }
  for (const [id, v] of Object.entries(readState())) last.set(id, v);

  /** Is this record due for a check? */
  function due(rec) {
    const u = rec.update;
    if (!u || !u.url || u.check === 'manual') return false;
    const prev = last.get(rec.id);
    if (!prev) return true;
    if (prev.version === rec.version && prev.status === 'current') return false;
    return now() - (prev.checkedAt || 0) >= (CHECK_MS[u.check] ?? CHECK_MS.daily);
  }

  /**
   * Check one installed package. Returns a report; never throws.
   * @param {object} rec a manager record
   * @param {{ force?: boolean, install?: boolean }} [opts]
   */
  async function check(rec, { force = false, install = true } = {}) {
    const out = { id: rec?.id, status: 'skipped', detail: null };
    if (!rec || rec.status !== 'ok') { out.detail = 'package is not mounted'; return out; }
    if (!rec.update?.url) { out.detail = 'no update source'; return out; }
    if (!force && !due(rec)) { out.status = 'not-due'; return out; }
    out.from = rec.version || null;
    try {
      const buf = await download(rec.update.url, { fetchFn });
      const { manifest, problems } = inspectZipManifest(buf);
      if (!manifest) { out.status = 'rejected'; out.detail = problems.join('; '); }
      else if (manifest.id !== rec.id) { out.status = 'rejected'; out.detail = `the archive is "${manifest.id}", not "${rec.id}"`; }
      else if (!rec.version) { out.status = 'rejected'; out.detail = 'the installed copy has no version to compare against'; }
      else if (compareVersions(manifest.version, rec.version) <= 0) { out.status = 'current'; out.detail = `remote ${manifest.version} ≤ installed ${rec.version}`; }
      else if (install) {
        const r = await install(rec.id, buf, manifest);
        out.status = r.ok ? 'updated' : 'failed';
        out.detail = r.ok ? null : r.error;
        out.to = r.ok ? manifest.version : null;
      } else {
        out.status = 'available';
        out.to = manifest.version;
      }
    } catch (e) {
      out.status = 'error';
      out.detail = e?.message || String(e);
    }
    last.set(rec.id, { checkedAt: now(), version: out.to || rec.version, status: out.status, detail: out.detail });
    await writeState();
    if (out.status === 'updated') log.info?.(`[mods] ${rec.id} updated ${out.from} → ${out.to}`);
    else if (out.status === 'rejected') log.warn?.(`[mods] ${rec.id} update rejected: ${out.detail}`);
    return out;
  }

  /** Check every package that asked for it (used by the startup pass and the timer). */
  async function checkAll({ force = false, install = true, records = null } = {}) {
    if (running) return { skipped: 'already running' };
    running = true;
    try {
      const list = records || (scan ? (await scan()).mods : []);
      const reports = [];
      for (const rec of list) {
        if (!rec?.update?.url) continue;
        if (!force && !due(rec)) continue;
        reports.push(await check(rec, { force, install }));
      }
      return { reports, at: now() };
    } finally {
      running = false;
    }
  }

  /** Start the background poller. `startup` packages are checked once, right away. */
  function start({ everyMs = 30 * 60 * 1000, records = null } = {}) {
    if (timer) return false;
    checkAll({ records }).then((r) => {
      if (r?.reports?.length) log.info?.(`[mods] update check: ${r.reports.map((x) => `${x.id}=${x.status}`).join(', ')}`);
    }).catch((e) => log.warn?.('[mods] update check failed', e));
    timer = setInterval(() => { checkAll({}).catch(() => {}); }, everyMs);
    timer.unref?.();
    return true;
  }
  function stop() { if (timer) { clearInterval(timer); timer = null; } }

  /** What the manager page shows next to each package. */
  function status() { return Object.fromEntries(last); }

  return { check, checkAll, start, stop, status, due };
}

