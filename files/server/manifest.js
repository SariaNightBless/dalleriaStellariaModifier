// server/manifest.js — the manifest contract of the package manager.
//
// One file, one source of truth: server/mods.js (scan/validate), the installer (validation at install time), the mod
// manager page and the client loader all read the parsed result from here. Keeping the schema in one place is what
// keeps `mod.json` from drifting between the four of them.
//
// WHAT A PACKAGE MAY DECLARE (mod.json)
//   id            required, [a-zA-Z0-9][a-zA-Z0-9._-]{0,63}, unique, also the content namespace prefix
//   name/version  what the manager page shows; `version` is a dotted number for update comparison
//   api           required, the mod API the package was written against (this build speaks 1)
//   clientOnly    true = presentation only. false = touches the battle simulation, so EVERY peer must install it
//   entry.client  ES module with install(api) — the page imports it
//   entry.sim     ES module with install(sim) — loaded on the SERVER (and in the browser under client-side combat)
//   content       data tables this pack adds/overrides: { chess: 'content/chess.json', … }
//   hooks         named render / behaviour hooks the package registers (see docs/API.md); declared like styles
//   update        where a newer copy may be fetched from: { source: 'url' | 'github', url, check }
//   provides      what it adds, for the conflict report (styles / content / ui / hooks / binds)
//   requires      { mods: [], game: '>=0.1.7' }
//
// NOTHING IS IMPLICIT: a package that declares content is a content pack, one that declares `hooks` is a behaviour or
// appearance pack, and one that declares neither is a plain script. The manager page groups them that way, and the
// install report says which files landed where.

import path from 'node:path';

/**
 * The **loader package's own version** (the one the maintainer bumps by hand).
 *
 * THREE DOTS, THREE MEANINGS (the workspace rule, 2026-10-08):
 *   x  a big change / new content          ("大改" — many features, or a release worth announcing)
 *   y  one feature change                  (the default step when the maintainer does not say otherwise)
 *   z  a tweak to a feature that already shipped — adjusting the same feature again is `z` + 1
 * A version may still be written with fewer dots (`0.2`); the missing tail reads as 0, so `0.2` == `0.2.0`.
 *
 * It is NOT `MOD_API`: `MOD_API` is the mod-facing contract revision and only moves when the contract breaks. This is
 * the release number of `dalleriaStellariaModifier` itself, shown by `/api/mods/status` (`loader.version`), by the
 * manager page's header and by `install.mjs` — so a mod's `mod.json` version, the loader's version and the game's
 * version can be told apart at a glance.
 */
export const LOADER_VERSION = '1.0.0';
/** The mod API this build speaks. A mod declaring a higher `api` is refused rather than half-supported. */
export const MOD_API = 1;
/** Directory name (under the project root) mods are dropped into. */
export const MODS_DIRNAME = 'mods';
export const STATE_FILE = 'mods.state.json';
export const MANIFEST = 'mod.json';

/** Manifest id: also the prefix used to namespace content a pack adds (`<id>:chess_foo`). */
export const ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;

/**
 * The data tables a content pack may write into. The list is closed on purpose: every name here is one the game
 * actually loads (`server/sim/simdata.js` DataSource tables and `data/*.json`), so a typo is a manifest problem
 * instead of a table nobody reads.
 */
export const CONTENT_TABLES = Object.freeze([
  'chess',      // operators (data/chess.json)
  'tokens',     // summons / devices
  'enemies',    // enemies (data/enemies.json)
  'waves',      // wave composition
  'bonds',      // covenants (data/bonds.json)
  'items',      // equipment and spells
  'kits',       // starter kits
  'bands',      // strategies (data/bands.json)
  'stages',     // battlefields
  'garrisons',  // garrison/device tables
  'effects',    // 机变 / choice effects
  'choices',
]);

/**
 * Hook names a package may register. Grouped by what they can reach:
 *   ui:*      DOM/render layer of the shell (safe, client-only)
 *   field:*   battlefield view layer — bars, chips, numbers, animation (safe, client-only)
 *   sim:*     battle simulation — changes the outcome, so `clientOnly` must be false
 * The authoritative list of what each hook receives lives in docs/API.md; this table exists so that a manifest
 * claiming a hook nobody implements is reported as a problem instead of silently doing nothing.
 */
export const HOOK_GROUPS = Object.freeze({
  ui: ['ui:button', 'ui:panel', 'ui:screen', 'ui:banner', 'ui:toast', 'ui:css', 'ui:slot'],
  field: ['field:unitBars', 'field:enemyBars', 'field:chip', 'field:damageNumber', 'field:unitSprite',
    'field:enemySprite', 'field:animation', 'field:attack', 'field:unitMotion', 'field:damage', 'field:viewGone',
    'field:event', 'field:overlay'],
  sim: ['sim:enemyAI', 'sim:damage', 'sim:unitTick', 'sim:battleStart', 'sim:battleEnd', 'sim:content',
    'sim:attackAnim', 'sim:attackRhythm', 'sim:strikeDelay', 'sim:targets', 'sim:attack', 'sim:targetOrder', 'sim:attackMode'],
});
export const HOOK_NAMES = Object.freeze(Object.values(HOOK_GROUPS).flat());

/** Where an update may come from. `check` is a hint for the poller, not a promise: everything is opt-in. */
const UPDATE_SOURCES = Object.freeze(['url', 'github', 'local']);

const noop = () => {};

/** Compare dotted versions (`1.2.10` > `1.2.9`). Returns <0, 0, >0. Non-numeric parts compare as 0. */
export function compareVersions(a, b) {
  const pa = String(a ?? '0').split(/[.+-]/).map((s) => Number.parseInt(s, 10) || 0);
  const pb = String(b ?? '0').split(/[.+-]/).map((s) => Number.parseInt(s, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

/**
 * `1.2.3` — the shape a version must have to be comparable across an update.
 * Writers are expected to use all three parts (`0.2.0`); the pattern stays loose so a package that still says `1.0`
 * keeps working and only reads as `1.0.0`.
 */
export const VERSION_RE = /^\d+(\.\d+)*$/;

/**
 * The folder a package installed from a **zip** is extracted into: `<id>-v<version>` (`PRTSDataBase-v1.0.0`).
 *
 * WHY THE VERSION IS IN THE FOLDER NAME (maintainer's call, 2026-10-08): with several builds of the same pack lying
 * around — an archive folder, a copy pulled from the release page — `mods/PRTSDataBase/` gave no way to tell which
 * build was mounted. The name now answers that without opening `mod.json`.
 *
 * The id is sanitised and a version that is not a dotted number (the manifest only warns about those) is dropped
 * rather than pasted into a path, so this can never produce `../` or a name the filesystem refuses.
 *
 * @param {string} id manifest id (or the zip's file name when the archive carries no manifest)
 * @param {string|number|null|undefined} version
 * @returns {string} the folder name, without any version part when there is no usable one
 */
export function packageFolderName(id, version) {
  const safeId = String(id ?? '').trim().replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^[.-]+|[.-]+$/g, '') || 'mod';
  const v = version === null || version === undefined ? '' : String(version).trim();
  return v && VERSION_RE.test(v) ? `${safeId}-v${v}` : safeId;
}

/**
 * The reverse of {@link packageFolderName}: `PRTSDataBase-v1.0.0` → `PRTSDataBase`. Used to recognise a package that
 * was installed by this loader (the update path checks the incoming archive against the folder it replaces), so a
 * folder that never carried a version — a hand-copied one — comes back unchanged.
 */
export function packageIdFromFolder(dirName) {
  const m = /^(.*)-v\d+(?:\.\d+)*$/.exec(String(dirName ?? '').trim());
  return m && m[1] ? m[1] : String(dirName ?? '').trim();
}

/**
 * Parse and validate one manifest object.
 * @param {any} raw parsed mod.json
 * @param {string} fallbackId the folder name, used when the manifest has no id
 * @returns {{ manifest: object|null, problems: string[], warnings: string[] }}
 */
export function validateManifest(raw, fallbackId) {
  const problems = [];
  const warnings = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { manifest: null, problems: [`${MANIFEST} is not a JSON object`], warnings };
  }
  const id = typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : fallbackId;
  if (!ID_RE.test(id)) problems.push(`invalid id ${JSON.stringify(id)} (allowed: letters, digits, . _ -)`);

  const api = Number(raw.api);
  if (!Number.isFinite(api)) problems.push('missing "api" (the mod API version the package targets)');
  else if (api > MOD_API) problems.push(`needs mod API ${api}, this build speaks ${MOD_API}`);

  const rawEntry = raw.entry && typeof raw.entry === 'object' ? raw.entry : {};
  const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
  const entry = { client: str(rawEntry.client), sim: str(rawEntry.sim) };
  for (const [kind, file] of Object.entries(entry)) {
    if (file && !/\.m?js$/i.test(file)) problems.push(`entry.${kind} must be a .js/.mjs file (got ${file})`);
  }

  const version = typeof raw.version === 'string' ? raw.version : (typeof raw.version === 'number' ? String(raw.version) : null);
  if (version && !VERSION_RE.test(version)) {
    warnings.push(`version ${JSON.stringify(version)} is not a dotted number; an update cannot tell which copy is newer`);
  }

  // ---- content tables ------------------------------------------------------------------------------------------
  const content = {};
  const rawContent = raw.content && typeof raw.content === 'object' && !Array.isArray(raw.content) ? raw.content : {};
  for (const [table, file] of Object.entries(rawContent)) {
    if (!CONTENT_TABLES.includes(table)) {
      problems.push(`content.${table}: unknown table (known: ${CONTENT_TABLES.join(', ')})`);
      continue;
    }
    if (typeof file !== 'string' || !file.trim()) { problems.push(`content.${table} must be a relative file path`); continue; }
    if (path.isAbsolute(file) || file.split(/[\\/]/).includes('..')) { problems.push(`content.${table}: path must stay inside the package (${file})`); continue; }
    if (!/\.json$/i.test(file)) { problems.push(`content.${table} must be a .json file (got ${file})`); continue; }
    content[table] = file.trim();
  }

  // ---- hooks ---------------------------------------------------------------------------------------------------
  const rawHooks = raw.hooks && typeof raw.hooks === 'object' && !Array.isArray(raw.hooks) ? raw.hooks : {};
  const hooks = {};
  for (const [name, spec] of Object.entries(rawHooks)) {
    if (!HOOK_NAMES.includes(name)) { problems.push(`hooks.${name}: unknown hook (see docs/API.md "钩子清单")`); continue; }
    // `true` = "I register it from entry.client / entry.sim"; an object lets a data-only pack describe a table
    if (spec !== true && (typeof spec !== 'object' || spec === null || Array.isArray(spec))) {
      problems.push(`hooks.${name} must be true or an object`);
      continue;
    }
    const group = name.split(':')[0];
    if (group === 'sim' && raw.clientOnly === true) {
      problems.push(`hooks.${name} changes the simulation, so "clientOnly" must be false`);
      continue;
    }
    hooks[name] = spec === true ? {} : spec;
  }
  const simHookNames = Object.keys(hooks).filter((n) => n.startsWith('sim:'));

  // ---- update --------------------------------------------------------------------------------------------------
  let update = null;
  if (raw.update != null) {
    const u = raw.update && typeof raw.update === 'object' && !Array.isArray(raw.update) ? raw.update : {};
    const source = str(u.source) || 'url';
    if (!UPDATE_SOURCES.includes(source)) problems.push(`update.source ${JSON.stringify(source)} (known: ${UPDATE_SOURCES.join(', ')})`);
    else if (source !== 'local' && !str(u.url)) problems.push(`update.url is required for update.source "${source}"`);
    const check = str(u.check) || 'daily';
    if (!['startup', 'hourly', 'daily', 'weekly', 'manual'].includes(check)) problems.push(`update.check ${JSON.stringify(check)} (startup | hourly | daily | weekly | manual)`);
    update = { source, url: str(u.url), check, auto: u.auto !== false };
    if (update.url && !/^https?:\/\//i.test(update.url) && source !== 'local') {
      warnings.push('update.url does not look like an http(s) URL; the updater will refuse it');
    }
    if (!version) warnings.push('a package with an update source should declare "version"');
  }

  const provides = {
    bonds: arrayOfStrings(raw.provides?.bonds),
    kits: arrayOfStrings(raw.provides?.kits),
    styles: arrayOfStrings(raw.provides?.styles),
    content: Object.keys(content),
    hooks: Object.keys(hooks),
  };
  const requires = {
    mods: arrayOfStrings(raw.requires?.mods),
    game: str(raw.requires?.game),
  };

  const clientOnly = raw.clientOnly === true;
  // A content pack that writes simulation tables but claims to be presentation-only would split the result digest.
  const simTables = Object.keys(content).filter((t) => !['stages'].includes(t));
  if (clientOnly && simTables.length) {
    warnings.push(`declares content for ${simTables.join(', ')} but "clientOnly": true — every peer needs the same data `
      + 'or the battle results diverge (set "clientOnly": false unless the table is presentation-only)');
  }
  if (!clientOnly && !entry.sim && !simHookNames.length && !simTables.length) {
    warnings.push('"clientOnly": false but nothing sim-side is declared (no entry.sim, no sim hook, no content)');
  }

  const manifest = {
    id,
    name: str(raw.name) || id,
    version,
    api: Number.isFinite(api) ? api : null,
    author: typeof raw.author === 'string' ? raw.author : null,
    description: typeof raw.description === 'string' ? raw.description : null,
    homepage: str(raw.homepage),
    clientOnly,
    entry,
    content,
    hooks,
    update,
    provides,
    requires,
  };
  // What the manager page shows as the package "kind" — derived, never declared, so it cannot lie.
  manifest.kind = contentKind(manifest);
  return { manifest: problems.length ? null : manifest, problems, warnings };
}

function arrayOfStrings(v) {
  return Array.isArray(v) ? v.filter((s) => typeof s === 'string' && s.trim()).map((s) => s.trim()) : [];
}

/** One word for the manager page: what this package actually is. */
export function contentKind(m) {
  const sim = Object.keys(m.hooks).some((h) => h.startsWith('sim:')) || !!m.entry.sim
    || Object.keys(m.content).some((t) => t !== 'stages');
  if (Object.keys(m.content).length && sim) return 'content+sim';
  if (Object.keys(m.content).length) return 'content';
  if (sim) return 'sim';
  return m.clientOnly ? 'client' : 'script';
}

/** The static-file URL of a package, built from the FOLDER name (the mount serves the filesystem). */
export function modUrl(dirName) {
  return `/mods/${encodeURIComponent(dirName)}/`;
}

export { noop };
