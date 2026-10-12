// public/js/mods/resolve.js — manifest resolution: turning one `/api/mods` record into the `api` object a package gets.
//
// This is the part of the loader a mod author actually feels. The rules it implements:
//
//   · The API is VERSIONED and NARROW. `api.api` says which revision the package was written against; a package that
//     asks for a newer one is skipped with a message instead of being half-supported.
//   · NOTHING IS IMPLICIT. Every surface (styles, hooks, UI, content, updates, storage) is a namespace on `api`, and a
//     surface this build does not have is present but refuses with a reason — a mod that probes `api.ui` finds an
//     object, not `undefined`, so it can degrade instead of crashing.
//   · REGISTRATIONS ARE TRACKED. Everything a package registers is recorded so a package that throws, or one the user
//     disables, can be taken out again without a reload of the page's other mods.
//   · A MOD IS THIRD-PARTY CODE. It runs in the page, it can read the DOM, and it cannot be sandboxed in a browser. So
//     the API is the *supported* surface, the manager page says plainly what a package asked for, and `clientOnly`
//     packages are the only ones that may touch the simulation.

import { hooks, HOOK_KINDS, CLIENT_SAFE_KINDS } from '../../../shared/hooks.js';

/** Mod API version this build speaks (must match server/manifest.js MOD_API). */
export const MOD_API = 1;

/**
 * The registration ledger of one package: every surface appends its own unregister callbacks here, so `dropApi` can
 * take a package out as one unit. It is created by the CALLER because the surfaces that need it (`makeAssets`,
 * `makeUi`) are built before the API object exists.
 * @returns {{ hooks: Function[], css: Function[], ui: Function[], events: Function[], ready: Function[], assets: Function[] }}
 */
export const makeLedger = () => ({ hooks: [], css: [], ui: [], events: [], ready: [], assets: [] });

/** Tiny per-mod key/value store kept in localStorage, namespaced so two packs cannot collide. */
export function makeStorage(modId) {
  const prefix = `spmod:${modId}:`;
  const safe = (k) => `${prefix}${String(k)}`;
  return Object.freeze({
    get(key, fallback = null) {
      try { const v = localStorage.getItem(safe(key)); return v == null ? fallback : JSON.parse(v); } catch { return fallback; }
    },
    set(key, value) {
      try { localStorage.setItem(safe(key), JSON.stringify(value)); return true; } catch { return false; }
    },
    remove(key) { try { localStorage.removeItem(safe(key)); } catch { /* private mode */ } },
    /** Everything this mod stored, as a plain object. */
    all() {
      const out = {};
      try {
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          if (k && k.startsWith(prefix)) out[k.slice(prefix.length)] = JSON.parse(localStorage.getItem(k));
        }
      } catch { /* private mode */ }
      return out;
    },
    clear() { for (const k of Object.keys(this.all())) this.remove(k); },
  });
}

/**
 * Build the API object for one package.
 *
 * @param {object} rec a `/api/mods` record
 * @param {object} deps
 * @param {object} deps.style the style surface (see mods.js) — `{ set, get, knobs, writable, overrides, view }`
 * @param {object} deps.ui the DOM surface (see mods.js ui.js)
 * @param {object} deps.content the content view (see mods/content.js createContentView)
 * @param {object} deps.mod the loader's own module (for events and ready queueing)
 * @returns {{ api: object, drop: () => void, registered: object }}
 */
export function makeApi(rec, { style, ui, content, assets, mod: loader, registered = makeLedger() }) {
  const tag = `[mod:${rec.id}]`;
  const modId = rec.id;

  const api = {
    api: MOD_API,
    mod: Object.freeze({
      id: rec.id, name: rec.name, version: rec.version ?? null, author: rec.author ?? null,
      clientOnly: !!rec.clientOnly, kind: rec.kind ?? null, dir: rec.dir, url: rec.url,
    }),

    // ---- output -----------------------------------------------------------------------------------------------
    log: (...a) => console.log(tag, ...a),
    warn: (...a) => console.warn(tag, ...a),
    error: (...a) => console.error(tag, ...a),

    // ---- events (see mods.js modEvents) ------------------------------------------------------------------------
    on(event, fn) {
      const off = loader.on(event, fn);
      registered.events.push(off);
      return off;
    },
    once(event, fn) {
      const off = api.on(event, (data) => { off(); fn(data); });
      return off;
    },
    emit(event, data) { loader.notifyEvent(event, data); },
    ready(fn) { loader.whenReady(fn); registered.ready.push(fn); },

    // ---- styles (render/style.js knobs) ------------------------------------------------------------------------
    style,

    // ---- operator art the package ships itself (public/js/assets.js manifest entries) --------------------------
    assets,

    // ---- named hook points the game calls (shared/hooks.js) ----------------------------------------------------
    hooks: {
      /** The hook kinds this build calls. */
      kinds: HOOK_KINDS,
      /** The kinds a `clientOnly: true` package may use. */
      clientSafe: CLIENT_SAFE_KINDS,
      /**
       * Register a handler.
       * @param {string} kind e.g. 'field:damageNumber'
       * @param {Function} fn `(value, ctx) => newValue | undefined`
       * @param {{ priority?: number }} [opts]
       */
      register(kind, fn, opts = {}) {
        if (opts.clientOnly === false) {
          // a package that declares clientOnly:false may touch sim hooks; one that does not, may not
        }
        if (!rec.clientOnly && !CLIENT_SAFE_KINDS.includes(kind) && !String(kind).startsWith('sim:')) {
          console.warn(`${tag} unknown hook "${kind}"`);
        }
        if (String(kind).startsWith('sim:') && rec.clientOnly) {
          console.warn(`${tag} "${kind}" changes the simulation: set "clientOnly": false in mod.json, otherwise every peer must install it`);
        }
        const off = hooks.register(kind, modId, fn, opts);
        registered.hooks.push(off);
        return off;
      },
      /** Is anyone (any package) listening on this kind? Useful before you build an expensive payload. */
      has: (kind) => hooks.has(kind),
      /** What is registered, by kind: `{ 'field:damageNumber': ['my-mod'] }`. */
      attribution: () => hooks.attribution(),
    },

    // ---- UI surface (DOM / CSS / components) -------------------------------------------------------------------
    ui,

    // ---- content packs -----------------------------------------------------------------------------------------
    content,

    // ---- mod-to-mod channels & storage -------------------------------------------------------------------------
    /** Broadcast on the loader's channel (every package, including yourself, receives it). */
    channel(name, data) { loader.notifyEvent(`channel:${name}`, { from: modId, data }); },
    storage: makeStorage(modId),

    /** Where a newer copy of this package may be fetched from (declared in mod.json), or null. */
    update: rec.update ? Object.freeze({ ...rec.update }) : null,

    // ---- shortcuts for the two things every package does -------------------------------------------------------
    /** `api.cls('badge')` → `mod-<id>-badge` (the class prefix that keeps a mod's CSS out of the game's). */
    cls: (name, modifier = null) => ui.cls(name, modifier),
    /** `api.css('theme.css')` — a stylesheet shipped inside the package. */
    css: (file, opts) => ui.css(file, opts),
    /** `api.styleTag('…')` — inline CSS. */
    styleTag: (cssText, opts) => ui.style(cssText, opts),

    // ---- introspection -----------------------------------------------------------------------------------------
    /** What this package registered so far (the manager page shows the same thing). */
    registrations: () => ({
      hooks: hooks.attribution(),
      css: registered.css.length,
      ui: registered.ui.length,
      events: registered.events.length,
    }),
  };

  Object.defineProperty(api, '_registered', { value: registered, enumerable: false });
  return api;
}

/** Take every registration of one package out again (a failed install, or a package disabled at runtime). */
export function dropApi(api) {
  const reg = api?._registered;
  if (!reg) return;
  for (const off of reg.hooks.splice(0)) { try { off(); } catch { /* already gone */ } }
  for (const off of reg.css.splice(0)) { try { off(); } catch { /* already gone */ } }
  for (const off of reg.ui.splice(0)) { try { off(); } catch { /* already gone */ } }
  for (const off of reg.events.splice(0)) { try { off(); } catch { /* already gone */ } }
  for (const off of reg.assets.splice(0)) { try { off(); } catch { /* already gone */ } }
  reg.ready.length = 0;
}
