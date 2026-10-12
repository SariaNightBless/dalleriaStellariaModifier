// public/js/mods/sim.js — the client's simulation modules: the `entry.sim` files of behaviour mods.
//
// WHY THIS IS SEPARATE FROM mods.js
//   `battle/runner.js` builds a Battle and needs the modules synchronously at that moment. It cannot wait for the whole
//   loader, and it must not import the loader's client half (which pulls in the style overlay and the UI surface). So the
//   loader stores the modules here, and the runner reads them from here: two tiny functions, no cycle.
//
// A module is imported from the package's own mount (`/mods/<id>/sim.js`), which the manager serves read-only. It never
// runs game code it was not given: it is handed the *loader's* hook registry and its own package record, nothing else.

/** Loaded modules, in apply order (package id ascending) — the order the server uses too. */
const modules = [];
let loadToken = 0;

/** What a sim module's `install` receives. Kept deliberately small: it is the contract across peers. */
export function makeSimApi(rec) {
  return Object.freeze({
    api: 1,
    mod: Object.freeze({ id: rec.id, name: rec.name ?? rec.id, version: rec.version ?? null, clientOnly: !!rec.clientOnly }),
    /** Data the server merged for this battle round (`/data/*.json` after the server's content merge). */
    data: null,
    log: (...a) => console.log(`[mod:${rec.id}:sim]`, ...a),
    warn: (...a) => console.warn(`[mod:${rec.id}:sim]`, ...a),
    error: (...a) => console.error(`[mod:${rec.id}:sim]`, ...a),
  });
}

/**
 * Import the sim entry of the given packages. Safe to call twice (a token guards against an older run finishing later).
 * @param {Array<{ id: string, url: string, version?: string|null }>} entries `url` = the package's `entry.sim` path
 * @returns {Promise<{ loaded: string[], failed: { id: string, error: string }[] }>}
 */
export async function setSimModules(entries) {
  const token = ++loadToken;
  const out = { loaded: [], failed: [] };
  modules.length = 0;
  const seen = new Set();
  for (const ent of entries || []) {
    const id = ent?.id;
    const url = ent?.url;
    if (typeof id !== 'string' || seen.has(id)) continue;
    seen.add(id);
    if (typeof url !== 'string' || !url) { out.failed.push({ id, error: 'no entry.sim in the manifest' }); continue; }
    let mod = null;
    try {
      // `?v=` so a reinstalled package is not served from a stale cache
      mod = await import(/* @vite-ignore */ `${url}${url.includes('?') ? '&' : '?'}v=${encodeURIComponent(String(ent.version ?? ''))}`);
    } catch (e) {
      out.failed.push({ id, error: String(e?.message || e) });
      console.error(`[mods] sim module "${id}" failed to load`, e);
      continue;
    }
    if (token !== loadToken) return out;          // superseded by a newer load
    const install = typeof mod.install === 'function' ? mod.install
      : (typeof mod.default === 'function' ? mod.default : (typeof mod.default?.install === 'function' ? mod.default.install : null));
    if (!install) { out.failed.push({ id, error: 'entry.sim exports no install(battle)' }); continue; }
    modules.push({ id, module: mod, install });
    out.loaded.push(id);
  }
  return out;
}

/**
 * The `extraContent` array for a Battle: the loaded modules, in order.
 * `server/sim/content/index.js` calls `install(battle)` on each entry — the same contract the game's own content
 * modules use.
 */
export function modSimModules() {
  return modules.map((m) => m.module);
}

/** Ids of the loaded sim modules (diagnostics / the manager page). */
export function simModuleIds() {
  return modules.map((m) => m.id);
}

/**
 * Load the sim entries the loader recorded (`mods.js` keeps `simUrl` per loaded package).
 *
 * Called by `battle/runner.js` right before a Battle is built, and only when `hasSimMods()` said there is something to
 * load — so a page with only presentation mods never runs this. The import of `mods.js` is dynamic on purpose: it keeps
 * this module free of the loader's client half (no style overlay, no UI surface) for every other caller.
 *
 * @returns {Promise<{ loaded: string[], failed: { id: string, error: string }[] }>}
 */
export async function loadSimModulesFromLoader() {
  const mods = await import('../mods.js');
  const entries = (mods.loaded?.ok || [])
    .filter((m) => m && m.simUrl)
    .map((m) => ({ id: m.id, url: m.simUrl, version: m.version }));
  if (!entries.length) return { loaded: [], failed: [] };
  return setSimModules(entries);
}
