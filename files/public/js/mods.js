// public/js/mods.js — the client half of the mod package manager (server/mods.js is the other half).
//
// WHAT IT DOES
//   1. Asks the server which packages are installed (`/api/mods`).
//   2. Imports the client entry of every ENABLED package, in a stable order, and collects what each one registers.
//   3. Hands each mod a small, versioned API object — never the game's internals. The narrow surface is the point:
//      a mod that reaches into private state cannot be kept working across releases.
//
// WHAT A CLIENT MOD GETS
//   export default function (api) { … }              // or: export function install(api) { … }
//   api.api                — the mod API version this build speaks
//   api.mod                — { id, name, version, clientOnly, dir }
//   api.on(event, fn)      — game events (see modEvents below); returns an unsubscribe
//   api.emit(event, data)  — tell other mods something (mod-to-mod channel)
//   api.style.set(name, value)  — set a documented render/style knob (see public/js/render/style.js)
//   api.style.get(name)
//   api.log(...)           — prefixed console output
//   api.ready(fn)          — run once the game's field view exists
//
// WHY IT IS CAREFUL
//   A mod is third-party code running in the page. So: nothing loads before `boot()`, one broken package is reported
//   and skipped instead of taking the game down, and a `clientOnly: false` package is flagged loudly (it needs the
//   same package on every peer, because both sides simulate the battle and compare resultDigest — DESIGN §14).

/**
 * The style layer this build offers, and the object the renderer reads it through.
 *
 * `./mods/style.js` is the loader's OWN file (catalog.mjs OURS): the knob table, the defaults and the write/notify
 * machinery live there, while the renderer reaches it through four tiny patches (render/style.js re-exports it). So a
 * build that carries this manager ALWAYS has the knobs — including on an untouched upstream checkout, where
 * `render/style.js` keeps its frozen `COLORS` / `UNIT` and the two re-exports simply resolve to those frozen objects
 * (the knobs then read fine and `set` is refused, see below).
 *
 * `styleMod.COLORS` / `styleMod.UNIT` are the loader module's live re-exports of the renderer's two tables; on a plain
 * build they are the frozen literals, which is exactly what the read-only fallback wants.
 */
import * as styleMod from './mods/style.js';
import { hooks, HOOK_KINDS, CLIENT_SAFE_KINDS } from '../../shared/hooks.js';
import { makeApi, dropApi, makeLedger, MOD_API as API_VERSION } from './mods/resolve.js';
import { makeUi } from './mods/ui.js';
import { makeAssets } from './mods/assets.js';
import { applyContentToStore, writeToStore, createContentView } from './mods/content.js';
import { DATA_FILE_OF } from './mods/tables.js';

/**
 * Is the render layer patched? The knob ENGINE always exists (it is our own module), but the renderer only READS it
 * when `render/style.js` has been patched to hand `COLORS` / `UNIT` to `makeStyleStore()` and to re-export the nine
 * groups. On an untouched upstream checkout the two live re-exports resolve to the frozen literals, and a `set` would
 * be recorded here and change nothing on screen — so the manager degrades instead: read-only knobs, `set` returns
 * false, one clear warning, everything else (events, CSS, custom drawing) keeps working. That is what makes the
 * package usable on an unmodified game.
 *
 * The probe is exact: the patched `COLORS` is built by `makeStyleStore('color', …)`, which adds the two keys upstream's
 * literal has no equivalent for (`hpDeep` / `shieldPlain`) and installs accessors for them. The frozen literal has
 * neither. Lazy on purpose: this module is imported before `render/style.js` has been evaluated (the first frame
 * imports `../mods.js`), so the namespace property may still read `undefined` here — the fallback then applies, and
 * nothing in the manager depends on the answer at import time beyond which VIEW it exposes.
 */
function detectStyleOverlay() {
  try {
    if (typeof styleMod.STYLE !== 'object' || styleMod.STYLE === null) return false;
    if (typeof styleMod.setStyleKnob !== 'function') return false;
    const desc = styleMod.COLORS && Object.getOwnPropertyDescriptor(styleMod.COLORS, 'hpDeep');
    return !!(desc && typeof desc.get === 'function');
  } catch { return false; }
}
const HAS_STYLE_OVERLAY = detectStyleOverlay();

/** Adapt the plain build's frozen defaults into the same shape as the overlay's `STYLE` (read-only). */
function readOnlyStyleView() {
  const groups = {
    color: styleMod.COLORS || {},
    unit: styleMod.UNIT || {},
  };
  const out = {};
  for (const [g, src] of Object.entries(groups)) {
    const o = {};
    for (const k of Object.keys(src)) {
      Object.defineProperty(o, k, { enumerable: true, get: () => src[k] });
    }
    out[g] = Object.freeze(o);
  }
  return Object.freeze(out);
}

/** The effective `STYLE` view: the overlay's when present, a read-only view of the defaults otherwise. */
export const STYLE = HAS_STYLE_OVERLAY ? styleMod.STYLE : readOnlyStyleView();

/** The published knobs. With no overlay every key is listed but `set` rejects it. */
export const styleKnobs = HAS_STYLE_OVERLAY
  ? styleMod.STYLE_KEYS
  : Object.freeze(Object.fromEntries(Object.entries(STYLE).map(([g, o]) => [g, Object.freeze(Object.keys(o))])));

/** Whether this build can actually apply style overrides (false on an untouched upstream checkout). */
export const canSetStyle = HAS_STYLE_OVERLAY;
if (!HAS_STYLE_OVERLAY) {
  console.warn('[mods] the render layer is not patched for the style knobs (render/style.js does not re-export '
    + 'public/js/mods/style.js): api.style.set() is disabled, event hooks and api.css() still work');
}

/** The published knobs. With no overlay the keys are still listed, but `set` rejects every one of them. */
export const publishedStyleKeys = styleKnobs;

/** Emit to every subscriber; a throwing handler never breaks the frame. */
function emit(event, data) {
  const set = listeners.get(event);
  if (!set) return;
  for (const fn of set) {
    try { fn(data); } catch (e) { console.error(`[mods] handler for "${event}" threw`, e); }
  }
}

/** The effective value of one knob, e.g. `'color.hpAlly'` (a mod's value once set, the default otherwise). */
export function styleValue(path) {
  const [group, key] = String(path).split('.');
  if (HAS_STYLE_OVERLAY) return styleMod.styleKnob(group, key);
  const g = STYLE[group];
  return g && key in g ? g[key] : undefined;
}

/** Write one knob. Returns false (and says why) when the build has no overlay or the key is not published. */
export function styleSet(path, value) {
  const [group, key] = String(path).split('.');
  if (!HAS_STYLE_OVERLAY) return false;
  return styleMod.setStyleKnob(group, key, value);
}

/** Every override a mod has made (empty on a build without the overlay). */
export const styleOverrideList = HAS_STYLE_OVERLAY ? styleMod.styleOverrides : () => ({});
/** Drop every override (a no-op without the overlay). */
export const resetStyle = HAS_STYLE_OVERLAY ? styleMod.resetStyleKnobs : () => {};

/** Must match server/mods.js MOD_API. A package declaring a higher api is not loaded. */
export const MOD_API = 1;

const noop = () => {};
const listeners = new Map();      // event → Set<fn>
const readyQueue = [];            // callbacks waiting for the first field view
let fieldView = null;
let booted = false;

/** Events a client mod may subscribe to (the game pushes these; the list is the contract). */
export const modEvents = Object.freeze([
  'ready',        // { view }            the field view was created
  'battleStart',  // { meta }            a battle (or sandbox run) started
  'battleEnd',    // { result }
  'matchResult',  // { result, me }      a WHOLE match settled (server/match/results.js buildResult; 战绩 / 奖杯 live here)
  'event',        // { ev, renderT }     every raw battle event tuple
  'frame',        // { dt, renderT }     once per rendered frame (keep the handler cheap)
]);

/**
 * Subscribe to one of `modEvents` from outside a package — the game's own modules (render/app.js, battle/runner.js) push
 * their notifications through the `notify*` functions; this is the matching read side, for diagnostics and tests that
 * must observe exactly what a package would receive. A package itself uses `api.on(event, fn)`.
 * @param {string} event
 * @param {(data: any) => void} fn
 * @returns {() => void} unsubscribe
 */
export function on(event, fn) {
  if (typeof fn !== 'function') return noop;
  let set = listeners.get(event);
  if (!set) { set = new Set(); listeners.set(event, set); }
  set.add(fn);
  return () => set.delete(fn);
}

/** How many handlers are attached per event, e.g. `{ frame: 1 }` (diagnostics: is anyone listening at all?). */
export function subscriberCount() {
  const out = {};
  for (const [event, set] of listeners) if (set.size) out[event] = set.size;
  return out;
}

/**
 * Is anyone subscribed to this event? One Map lookup and nothing else — this is the guard the per-frame call sites use
 * (`public/js/mods/render.js` → the `frame` / `field:frame` / `event` seams, 60 × per second).
 *
 * NOT `subscriberCount()` for that job: it builds an object per call, i.e. one allocation per frame even when no package
 * is installed at all.
 * @param {string} event
 * @returns {boolean}
 */
export function hasSubscriber(event) {
  const set = listeners.get(event);
  return !!(set && set.size);
}

/**
 * The API object is built by ./mods/resolve.js (one manifest record in, one `api` object out) — the shape of the
 * surface lives there, the loading policy lives here. Nothing in this file knows what `api.ui` or `api.hooks` are.
 */


/** Every installed package, as the server sees it. Never throws (an offline server yields an empty list). */
export async function fetchMods() {
  try {
    const r = await fetch('/api/mods', { cache: 'no-store' });
    if (!r.ok) return { api: MOD_API, revision: -1, mods: [], error: `HTTP ${r.status}` };
    return await r.json();
  } catch (e) {
    return { api: MOD_API, revision: -1, mods: [], error: e.message };
  }
}

/** What actually got loaded, for the manager page and bug reports. */
export const loaded = { revision: -1, ok: [], failed: [], skipped: [], content: [] };

/**
 * How many installed packages declare simulation content (`clientOnly: false`): content tables or an `entry.sim`.
 *
 * `battle/runner.js` reads this when it builds a Battle: it has to WAIT for the loader when the answer is not zero, and
 * must NOT wait when it is zero (a page with only presentation mods boots at exactly the old speed). The loader bumps it
 * at the very start of `loadMods()`, before any await, so a caller that checks it after the first await sees the truth.
 */
let simModCount = 0;
/** The same, for content packs: the client simulation reads merged tables from /data/, so a pack means "the server has work to do". */
let contentPackCount = 0;

/** @returns {boolean} whether this page has any package that changes the simulation */
export const hasSimMods = () => simModCount > 0;
/** @returns {number} packages that declare `clientOnly: false` */
export const simModTotal = () => simModCount;
/** @returns {boolean} whether the server announced content packs (the /data/ tables are merged) */
export const hasContentPacks = () => contentPackCount > 0;

/** The in-flight `loadMods()` promise, so a caller can await the same load instead of starting a second one. */
let loadPromise = null;

/** Await the loader's first pass (no-op when it already finished or never started). */
export async function modsReady() {
  if (loadPromise) await loadPromise.catch(() => {});
  return loaded;
}

/** Modules the client loader built, so `api.dispose()` can take a package out again without a page reload. */
const liveApis = new Map();

// ---------------------------------------------------------------------------------------------------------------
// the live-package counter — how a CALL SITE learns that buttons appeared or went away

/**
 * Bumped whenever the set of loaded packages changes: after `loadMods()` finishes and after every `unloadMod()`.
 *
 * Why a counter and not an event: the call sites that consume mod-contributed UI (`ui:button` → `ui/modButtons.js`)
 * are Preact components, and a counter read during render is what makes them re-render — the same value/setter pair
 * `useSubscribed()` already gives the game's own stores. A mod that registers a button AFTER the first render (its own
 * `await`, a later state) therefore still shows up, and unloading a package takes its button away again.
 */
let modsVersion = 0;
const versionListeners = new Set();

/** The current revision of the loaded-package set (subscribe with `onModsChanged`). */
export const modsRevision = () => modsVersion;

/**
 * Subscribe to loaded-package changes. Returns an unsubscribe function.
 * @param {() => void} fn
 * @returns {() => void}
 */
export function onModsChanged(fn) {
  if (typeof fn !== 'function') return () => {};
  versionListeners.add(fn);
  return () => versionListeners.delete(fn);
}

function bumpModsVersion() {
  modsVersion++;
  for (const fn of [...versionListeners]) {
    try { fn(modsVersion); } catch (err) { console.error('[mods] change listener threw', err); }
  }
}

/** The style surface handed to every package (the overlay's when present, a read-only view otherwise). */
const styleSurface = Object.freeze({
  set: (path, value) => styleSet(path, value),
  get: (path) => styleValue(path),
  knobs: styleKnobs,
  writable: canSetStyle,
  overrides: styleOverrideList,
  view: STYLE,
  /**
   * The shipped default of a knob (`api.style.base('unit.barWidth')`), so a mod can scale relative to it instead of
   * hard-coding: `api.style.set('unit.barWidth', api.style.base('unit.barWidth') * 1.2)`.
   *
   * The overlay keeps the defaults in `STYLE_BASE` when it has them; a build whose style layer does not export that
   * object falls back to the frozen `COLORS` / `UNIT` tables, which is the same information for the groups they cover.
   */
  base(path) {
    const [group, key] = String(path).split('.');
    const fromOverlay = styleMod.STYLE_BASE?.[group];
    if (fromOverlay && key in fromOverlay) return fromOverlay[key];
    const frozen = group === 'color' ? styleMod.COLORS : group === 'unit' ? styleMod.UNIT : null;
    return frozen && key in frozen ? frozen[key] : undefined;
  },
  reset: () => resetStyle(),
});

/** The merged content tables of every enabled pack (array/map per table), and a view over them. */
let contentTables = {};
let contentView = null;

/**
 * Import the client entry of every enabled package, then apply the content packs.
 *
 * Order matters: content first (so a package's `install` sees the merged tables through `api.content`), then the
 * packages themselves, then the UI store merge.
 *
 * @param {{ list?: object, signal?: AbortSignal, store?: object, fetchFn?: typeof fetch, applyContent?: boolean }} [opts]
 *   `list` reuses an already-fetched /api/mods payload; `store` is the game's data store (`public/js/data.js`)
 */
export async function loadMods(opts = {}) {
  const list = opts.list || await fetchMods();
  loadPromise = (async () => {
  loaded.revision = list.revision;
  loaded.ok.length = 0; loaded.failed.length = 0; loaded.skipped.length = 0; loaded.content.length = 0;
  const mods = Array.isArray(list.mods) ? list.mods : [];

  // Announce the work BEFORE the first await: `battle/runner.js` asks `hasSimMods()` while a battle is being prepared,
  // and a page that only has presentation mods must not be made to wait for the loader.
  simModCount = mods.filter((m) => m.status === 'ok' && m.enabled && !m.clientOnly
    && (m.entry?.sim || Object.keys(m.content || {}).length)).length;
  contentPackCount = mods.filter((m) => m.status === 'ok' && m.enabled && Object.keys(m.content || {}).length).length;

  // ---- 1) content packs -----------------------------------------------------------------------------------------
  const wantsContent = mods.some((m) => m.status === 'ok' && m.enabled && m.content && Object.keys(m.content).length);
  if (wantsContent) {
    if (opts.applyContent === false) {
      console.warn('[mods] content packs are installed but applyContent:false was passed; the UI store keeps the built-in tables');
    } else if (opts.store) {
      try {
        const res = await applyContentToStore(list, { store: opts.store, fetchFn: opts.fetchFn, log: (...a) => console.log(...a) });
        contentTables = res.records || {};
        for (const p of res.applied) loaded.content.push({ id: p.id, version: p.version, tables: p.applied.map((a) => a.table) });
        for (const p of res.problems) console.warn(`[mods] ${p.id}: ${p.problem}`);
        for (const c of res.conflicts) console.warn(`[mods] content conflict: ${c.table}/${c.id} defined by both ${c.alsoMod} and ${c.mod}`);
        const written = await writeToStore(opts.store, contentTables, { log: (...a) => console.log(...a) });
        if (loaded.content.length) {
          console.log(`[mods] content applied: ${loaded.content.map((p) => `${p.id} [${p.tables.join(',')}]`).join(', ')}`
            + (written.length ? ` → store: ${written.join(', ')}` : ''));
        }
      } catch (e) {
        console.error('[mods] applying content packs failed', e);
      }
    } else {
      // No game store (the dev demo, a test): still fetch the tables so api.content answers, but there is nothing to
      // merge them into. The simulation is unaffected — it reads the merged tables from /data/ either way.
      const res = await applyContentToStore(list, { store: null, fetchFn: opts.fetchFn, log: (...a) => console.log(...a) });
      contentTables = res.records || {};
    }
  }
  contentView = createContentView(() => contentTables, (table, id) => {    const store = opts.store;
    if (!store) return null;
    const file = DATA_FILE_OF[table] || table;
    const value = store.get?.(file);
    if (value == null) return null;
    const field = table === 'enemies' || table === 'waves' ? 'key' : 'id';
    if (Array.isArray(value)) return value.find((r) => r && (String(r[field]) === String(id) || String(r.id) === String(id))) || null;
    return value[id] ?? null;
  }, () => loaded.content.map((p) => p.id));

  // ---- 2) the packages ------------------------------------------------------------------------------------------
  for (const rec of mods) {
    if (rec.status !== 'ok' || !rec.enabled) { loaded.skipped.push({ id: rec.id, why: rec.status !== 'ok' ? 'invalid' : 'disabled' }); continue; }
    if (Number(rec.api) > MOD_API) { loaded.failed.push({ id: rec.id, error: `needs mod API ${rec.api}` }); continue; }
    if (!rec.entry || !rec.entry.client) { loaded.skipped.push({ id: rec.id, why: 'no client entry' }); continue; }
    if (!rec.clientOnly) {
      console.warn(`[mods] "${rec.id}" changes the simulation (clientOnly:false): every peer in a match must install it, `
        + 'otherwise the result digests diverge (DESIGN §14)');
    }
    const registered = makeLedger();
    const api = makeApi(rec, {
      style: styleSurface,
      ui: makeUi(rec),
      content: contentView,
      assets: makeAssets(rec, registered),
      registered,
      mod: { on, notifyEvent, whenReady },
    });
    try {
      // `?v=<revision>` so a reinstalled package is not served from a stale cache
      const mod = await import(/* @vite-ignore */ `${rec.entry.client}?v=${list.revision ?? 0}`);
      const install = typeof mod.install === 'function' ? mod.install : (typeof mod.default === 'function' ? mod.default : null);
      if (!install) { dropApi(api); loaded.skipped.push({ id: rec.id, why: 'no install()/default export' }); continue; }
      const out = install(api);
      if (out && typeof out.then === 'function') await out;
      liveApis.set(rec.id, api);
      loaded.ok.push({
        id: rec.id, version: rec.version, kind: rec.kind ?? null,
        // the sim entry is imported lazily by `mods/sim.js` (through battle/runner.js) so a page with only presentation
        // mods never pays for it. Both URLs are the server's, relative to the page.
        simUrl: rec.entry?.sim || null,
        content: Object.keys(rec.content || {}),
        hooks: Object.keys(rec.hooks || {}),
      });
    } catch (e) {
      dropApi(api);                                 // a half-installed mod must not keep receiving events
      loaded.failed.push({ id: rec.id, error: String((e && e.message) || e) });
      console.error(`[mods] "${rec.id}" failed to load`, e);
    }
  }
  bumpModsVersion();   // the set of loaded packages changed: call sites that render mod UI re-render now
  return loaded;
  })();
  return loadPromise;
}

/** Queue a callback for when the field view exists (create it now when it already does). */
export function whenReady(fn) {
  if (typeof fn !== 'function') return;
  if (fieldView) { try { fn({ view: fieldView }); } catch (e) { console.error('[mods] ready handler threw', e); } }
  else readyQueue.push(fn);
}

/** Unload one package at runtime (its hooks, DOM, stylesheets and event subscriptions). */
export function unloadMod(id) {
  const api = liveApis.get(id);
  if (!api) return false;
  try { api.ui?.dispose?.(); } catch { /* already gone */ }
  dropApi(api);
  liveApis.delete(id);
  const i = loaded.ok.findIndex((m) => m.id === id);
  if (i >= 0) loaded.ok.splice(i, 1);
  bumpModsVersion();   // a `ui:button` this package contributed has to leave the host with it
  return true;
}

/** The merged content view (`api.content` outside a package, for diagnostics and tests). */
export function content() { return contentView; }

/** A compact description of what this page loaded (shown in the manager page / a bug report). */
export function describeLoaded() {
  return {
    revision: loaded.revision,
    api: MOD_API,
    ok: loaded.ok.map((m) => m.id),
    failed: loaded.failed,
    skipped: loaded.skipped,
    content: loaded.content,
    hooks: hooks.counts(),
    styles: styleOverrideList(),
  };
}

/** Called once by the game when the field view exists (public/js/main.js). */
export function notifyReady(view) {
  fieldView = view;
  booted = true;
  emit('ready', { view });
  for (const fn of readyQueue.splice(0)) {
    try { fn({ view }); } catch (e) { console.error('[mods] ready handler threw', e); }
  }
}

/**
 * Inject a stylesheet a package ships, so a mod can restyle the UI (the level banner's 2 s unfold is a CSS keyframe,
 * not a value in render/style.js — CSS is the only way to reach it). `<link>` rather than inline text so the browser
 * resolves relative `url(...)` inside the sheet against the mod's own directory.
 *
 * The returned function removes the sheet again (used when a mod is unloaded in the manager page).
 * @param {string} href absolute URL, e.g. `'/mods/MyMod/theme.css'`
 * @param {string} [id] a stable id so a reload replaces instead of stacking
 * @returns {() => void}
 */
export function injectStylesheet(href, id = null) {
  const key = `sp-mod-css:${id || href}`;
  const prev = document.querySelector(`link[data-sp-mod-css="${CSS.escape(key)}"]`);
  if (prev) prev.remove();
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = href;
  link.dataset.spModCss = key;
  document.head.append(link);
  return () => link.remove();
}

/** Called by the game once per frame / per battle event (cheap no-ops when no mod listens). */
export function notifyFrame(data) { if (listeners.has('frame')) emit('frame', data); }
/**
 * Tell the subscribers of `name` — one delivery per subscriber.
 *
 * `api.on('event')` IS the raw-tuple channel: the game calls `notifyEvent('event', …)` for it and a package's
 * `api.emit('event', …)` lands in the same set, so the name needs no special case. (It used to have one — a second
 * `emit('event', …)` for `name === 'event'` — which delivered every raw battle event TWICE to each subscriber. Removed
 * when the `field:event` seam landed: the render layer now feeds this per event.)
 */
export function notifyEvent(name, data) {
  if (listeners.has(name)) emit(name, data);
}
export const isBooted = () => booted;

// ---------------------------------------------------------------------------------------------------------------
// the hook registry (shared/hooks.js) — re-exported so the game's modules import it from ONE place

/** The process-wide hook registry. Call sites: `if (hasHooks('field:damageNumber')) …`. */
export { hooks, hasHooks, HOOK_KINDS, CLIENT_SAFE_KINDS } from '../../shared/hooks.js';

/** Timing table accessors (see public/js/mods/timing.js) — the game's render code reads its numbers through these. */
export { timing, timingBase, setTiming, resetTiming, timingOverrides, bannerMs, applyBanner, allowBanner, allowDamageNumber, damageNumberText, TIMING_KEYS } from './mods/timing.js';

/** `api`-free helpers for the loader's own consumers (tests, the manager page, the dev demo). */
export { makeApi, dropApi } from './mods/resolve.js';
export const MOD_API_VERSION = API_VERSION;

/**
 * The mod-provided stylesheets/DOM a page may want to drop again (a full unload, e.g. leaving the dev demo).
 * @returns {number} how many packages were unloaded
 */
export function unloadAll() {
  let n = 0;
  for (const id of [...liveApis.keys()]) if (unloadMod(id)) n++;
  return n;
}

/**
 * The packages this client LOADED, as `[{ id, version }]` — what `net.js` reports in `hello` so a room can tell its
 * players when their sets differ. Synchronous and free: it reads the list `loadMods()` already produced, it never
 * fetches. A label for the mismatch notice only; nothing here is ever sent as code, and the server never runs it
 * (user decision A: 只显示不执行，避免被注入).
 * @returns {Array<{ id: string, version: string|null }>}
 */
export function modsForHandshake() {
  return loaded.ok.map((m) => ({ id: m.id, version: m.version ?? null })).sort((a, b) => a.id.localeCompare(b.id));
}
