// public/js/mods/style.js — the mod-overridable style layer of the battlefield renderer.
//
// WHY THIS FILE EXISTS (and not a 28 KB copy of the old overlay)
//   Upstream 0.2.4 has no knob layer at all: `COLORS`, `UNIT` and a dozen literals scattered over `render/units.js`,
//   `render/textures.js` and `render/fx/fonts.js` ARE the look. A package that wants to retune it must be able to write
//   a named knob and have the renderer read it. So the knobs live HERE — a file the mod loader owns (catalog.mjs OURS,
//   copied on install) — and the upstream files are patched in four places only:
//     · `render/style.js`   — `COLORS` / `UNIT` become LIVE objects handed to `makeStyleStore()`; the nine group names
//                             are re-exported from here at the end of the file (4 substitutions, 0 lines deleted);
//     · `render/units.js`   — the HUD / shield / stealth / hit-flash / fly / knocked-down literals read the knobs;
//     · `render/textures.js`— the tier-chip atlas is drawn from `CHIP`, and a write to `chip.*` redraws it;
//     · `render/fx/fonts.js`— the damage-number bitmap fonts bake from `DMG` (+ `rebuildDamageFonts()`).
//   Nothing above imports THIS file's names from `render/style.js`'s point of view — see "NO CYCLE" below.
//
// NO CYCLE
//   This module does NOT import `render/style.js`. The two upstream literals it needs (`COLORS` / `UNIT`) are handed in
//   by the patched `render/style.js` itself, through `makeStyleStore('color'|'unit', {…})`; and this module re-exports
//   `COLORS` / `UNIT` as live bindings so `public/js/mods.js` can read the plain-build fallback from ONE import.
//   (`import { COLORS, UNIT } from './render/style.js'` there would drag the whole render palette into the manager page
//   for nothing; a live re-export of a `let` binding is the same object once `render/style.js` has been evaluated.)
//
// NEUTRALITY (the property that is judged here)
//   Every default below is **byte-for-byte the upstream 0.2.4 value** — not the v1 overlay's. The v1 table had 15 keys
//   whose default was this project's own look (`hitFlash.tint` red, `fly.altitude` 1.55, `hud.gap` 14, grey down-rings,
//   per-tier `ink1..6` …); copying those would change the picture of an instance with NO package mounted. Evidence and
//   the per-key table: workspace `reports/seam-style.md` §5. Regression check: `tools/check-style-neutral.mjs`
//   (it re-reads the literals from the CLEAN upstream checkout and compares them key by key).
//
// ZERO-COST READS
//   A knob read is one plain property read: `HUD.backAlpha`, `DOWN.ring[state]`, `COLORS.hpAlly` — the groups ARE the
//   objects the renderer already reads (`STYLE.color === COLORS`). Accessors on `Object.defineProperties` (NOT a Proxy:
//   a trap per read would deoptimise every frame) and a read that found no override returns the frozen default.
//   Nothing here allocates per frame: invalidation is PUSHED (a write → one microtask → the listeners), never polled.

// ---------------------------------------------------------------------------------------------------------------
// the published knob surface (9 groups / 82 keys)

/**
 * The keys a package may write, per group. This IS the contract (`mod.json` `provides.styles` lists a subset of it,
 * and `api.style.set()` answers `false` for anything not listed here).
 */
export const STYLE_KEYS = Object.freeze({
  color: Object.freeze(['hpAlly', 'hpDeep', 'hpEnemy', 'hpBoss', 'hpGhost', 'hpBack', 'sp', 'spActive', 'shield',
    'shieldPlain', 'range', 'rangeStand', 'legal', 'illegal', 'gold', 'gateRed', 'objBlue']),
  unit: Object.freeze(['barWidth', 'bossBarWidth', 'diamond', 'headroom', 'modelScale', 'stealthAlpha']),
  hitFlash: Object.freeze(['tint', 'mix', 'decay']),
  fly: Object.freeze(['altitude']),
  hud: Object.freeze(['gap', 'stripePx', 'maxAlly', 'maxEnemy', 'maxBoss', 'backPadPx', 'backAlpha']),
  down: Object.freeze(['tint', 'alpha', 'size', 'height', 'min', 'max', 'ring', 'face', 'handInk', 'faceInk']),
  dmg: Object.freeze(['font', 'flat', 'stroke', 'physFill', 'artsFill', 'trueFill', 'healFill', 'elemFill']),
  chip: Object.freeze(['width', 'height', 'radius', 'stroke', 'plateAlpha', 'edge', 'fontWide', 'fontNarrow',
    'fontWeight', 'plate', 'plateGold', 'strokeInk', 'strokeGold', 'ink1', 'ink2', 'ink3', 'ink4', 'ink5', 'ink6',
    'textInk', 'textGold', 'textGoldTier', 'glowPx', 'glowInk', 'glowGold', 'glowAlpha']),
  shield: Object.freeze(['lineWidth', 'lineOffset', 'overSplit', 'gapPx']),
});

/**
 * The engine's whole mutable state — ONE object, hung off `globalThis` under a well-known key.
 *
 * Why not module-level bindings: `render/style.js` calls `makeStyleStore` from its own module body, and depending on
 * which module a graph is entered from, that can happen while THIS module is still evaluating — every `const` /
 * `let` / `class` declared below the import would then be in its temporal dead zone. A property of `globalThis` is
 * always initialised, so it is the only place a value can live that both entry points can reach. (The key is a plain
 * string, not a `Symbol.for(…)` input computed module-side, for the same reason.) `window.__SP_STYLE__` is the
 * manager's own diagnostic handle; `Symbol.keyFor`-style introspection on a Symbol key would hide it from devtools.
 */
function createState() {
  return {
    /** @type {Record<string, object>} group → the live store (`STYLE.color === COLORS`) */
    stores: Object.create(null),
    /** @type {Record<string, object>} group → the overrides a package has written */
    buckets: Object.create(null),
    /** @type {Record<string, object>} group → the frozen shipped defaults (`STYLE_BASE` reads these) */
    bases: Object.create(null),
    /** @type {Record<string, object>} group → overrides written before that group's store existed */
    pending: Object.create(null),
    /** @type {Set<(groups: Set<string>) => void>} */
    listeners: new Set(),
    /** @type {Set<string>} groups touched since the last dispatch */
    dirty: new Set(),
    /** @type {boolean} a dispatch is already queued */
    scheduled: false,
  };
}
/**
 * The one state object for this page. The key is an INLINE string literal, not a module-level constant: see above —
 * nothing in this call path may depend on a binding that this module's own body has not reached yet.
 */
function state() {
  const g = globalThis;
  return g.__SP_MODS_STYLE__ || (g.__SP_MODS_STYLE__ = createState());
}

/**
 * group → the frozen shipped defaults (`api.style.base('hud.gap')` reads these; `Object.keys` lists all nine groups).
 *
 * Built by a loop that defines one ENUMERABLE GETTER per group on this very object (own properties, so `Object.keys` /
 * `Object.entries` see them), rather than by assigning the tables in later: the assignment would have to happen after
 * this module's body reached each `makeStyleStore` call, and a getter has no such ordering to get right.
 */
export const STYLE_BASE = {};
for (const g of ['color', 'unit', 'hitFlash', 'fly', 'hud', 'down', 'chip', 'shield', 'dmg']) {
  Object.defineProperty(STYLE_BASE, g, {
    enumerable: true,
    configurable: false,
    get() { return state().bases[g]; },
  });
}

/**
 * Keys the published contract has that upstream's own literals do not (the v1 overlay shipped them; each default is the
 * upstream BEHAVIOUR, not the v1 look) — folded into the store the moment upstream's literal is handed over:
 *   color.hpDeep     0x5fe07a  upstream has no two-stage HP bar (units.js:1356 draws one colour for an ally) ⇒ = hpAlly
 *   color.shieldPlain 0xdfe8ff upstream has no numeric shield at all (b.snap carries the UF.SHIELD BIT only) ⇒ = shield
 *   unit.stealthAlpha 0.45     the literal of `units.js:1181` (`if (this.flags & UF.STEALTH) alpha *= 0.45;`)
 * @param {string} group @returns {object|null}
 */
function extrasFor(group) {
  if (group === 'color') return { hpDeep: 0x5fe07a, shieldPlain: 0xdfe8ff };
  if (group === 'unit') return { stealthAlpha: 0.45 };
  return null;
}

// ---------------------------------------------------------------------------------------------------------------
// change notification — a dirty-group set merged into ONE microtask (same shape as the v1 overlay)

/**
 * Subscribe to knob writes. The callback is handed the set of groups that changed (`'*'` for a full reset) and runs in
 * the microtask that follows the LAST write of the burst — a package writing 26 `chip.*` keys triggers ONE redraw.
 * @param {(groups: Set<string>) => void} fn
 * @returns {() => void} unsubscribe
 */
export function onStyleChange(fn) {
  if (typeof fn !== 'function') return () => {};
  const s = state();
  s.listeners.add(fn);
  return () => s.listeners.delete(fn);
}

/** Mark one group dirty and make sure exactly one dispatch is queued. */
function markDirty(group) {
  const s = state();
  s.dirty.add(group);
  if (s.scheduled) return;
  s.scheduled = true;
  queueMicrotask(() => {
    const s = state();
    s.scheduled = false;
    const groups = new Set(s.dirty);
    s.dirty.clear();
    for (const fn of s.listeners) {
      // One broken listener must not swallow the redraw of the others (or of a later write).
      try { fn(groups); } catch (err) { console.error('[style] change listener threw', err); }
    }
  });
}

// ---------------------------------------------------------------------------------------------------------------
// the stores

/**
 * Turn one literal default block into a LIVE object.
 *
 * The returned object is what upstream calls `COLORS` / `UNIT`: exported under the same name and read at the same call
 * sites, so every existing `COLORS.hpAlly` becomes "the package's value, else the shipped one" without a single edit
 * there. `enumerable` accessors (the manager page enumerates them), never frozen (a freeze would flatten an accessor).
 *
 * @param {string} group @param {object} defaults the upstream 0.2.4 literal
 * @returns {object} the live store
 */
export function makeStyleStore(group, defaults) {
  const s = state();
  const base = Object.freeze(Object.assign({}, defaults, extrasFor(group)));
  const bucket = Object.create(null);
  const out = {};
  for (const k of Object.keys(base)) {
    Object.defineProperty(out, k, {
      enumerable: true,
      configurable: false,
      get: () => (k in bucket ? bucket[k] : base[k]),
      set: (v) => { bucket[k] = v; markDirty(group); },
    });
  }
  // A write may arrive BEFORE the store exists: `public/js/mods.js` is imported by the first frame, while this store is
  // handed over when the patched `render/style.js` is evaluated. Those writes are held (`pending`) and folded in here,
  // so a set() during that window is neither lost nor reported as accepted-but-ignored.
  const held = s.pending[group];
  if (held) for (const k of Object.keys(held)) if (k in base) bucket[k] = held[k];
  delete s.pending[group];

  s.stores[group] = out;
  s.buckets[group] = bucket;
  s.bases[group] = base;      // `STYLE_BASE[group]` is a getter over this, so there is nothing to publish
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// the seven groups whose literals upstream keeps in OTHER files (every default verified against that file)
//
//   hitFlash  units.js:1221 (`mixTint(tint, 0xff8a80, flashK * 0.8)`) / :1261 (the same tint, factor 1) / :1264 (`dt * 6`)
//   fly       units.js:179  `export const FLY_HOVER = 1.3;`
//   hud       units.js:1338 (bar-length caps) / :1345 (`let cy = y - 4;`) / :1353 (`x0 - 1`, `+ 2`) / :728 (bg alpha)
//   down      units.js:212-216 (`DOWN_LOOK`) / :1606 (`clamp(s * size, 22, 52)`)
//   shield    units.js:1364 (`cy - bh / 2 - 1`, `Math.max(1.5, bh * 0.35)`)
//   dmg       fx/fonts.js:14 (font stack) + style.js DMG_STYLE[*].fill[0] (each style's gradient top)
//   chip      textures.js:1066-1089 (the atlas geometry, the two plate gradients, the inks, the fonts)

/** units.js:1221 / 1261 / 1264 — the white-out flash of a hit. */
export const HIT_FLASH = makeStyleStore('hitFlash', { tint: 0xff8a80, mix: 0.8, decay: 6 });

/** units.js:179 — how many tiles up a flying unit hovers. */
export const FLY = makeStyleStore('fly', { altitude: 1.3 });

/** units.js:1338 / 1345 / 1353 / 728 — the bars' plate, its gap and the caps on the bar length. */
export const HUD = makeStyleStore('hud', {
  gap: 4,           // units.js:1345 `let cy = y - 4;`
  stripePx: 6,      // DEAD KEY: upstream has no stripe thickness (row heights are factors of `bh`); published for v1 parity
  maxAlly: 96,      // units.js:1338 `… : this.isBoss ? 260 : 96`
  maxEnemy: 96,
  maxBoss: 260,
  backPadPx: 1,     // units.js:1353 / :1378 `x0 - 1`, `bw + 2`, `bh + 2`
  backAlpha: 0.85,  // units.js:728 the plate's own alpha at construction
});

/**
 * units.js:212-216 — the knocked-down look. `render/units.js` aliases its own `DOWN_LOOK` to THIS object (the field
 * names match 1:1), so its six read sites need no edit; only the ring diameter's clamp reads `DOWN.min` / `DOWN.max`.
 *
 * `face` is the redeploy-timer face: `'number'` (default — the countdown digits in the middle, `DP`, `!`) or `'clock'`
 * (two STATIC hands at 9:00). Anything other than the exact string `'clock'` means `'number'`, which is what keeps an
 * unset / mistyped value on the upstream path. `handInk` is the hands' colour; `faceInk` paints the disc behind them
 * (`null` = do not paint it — the hands then sit on the plate the ring already draws).
 */
export const DOWN = makeStyleStore('down', {
  tint: 0xb4b4b4, alpha: 0.92,
  ring: { 0: 0x4ed8af, 1: 0xffc600, 2: 0xff4b3e },   // units.js:214 per DOWN_STATE (COUNTING / WAIT_DP / WAIT_TILE)
  size: 0.42, height: 1.02,                          // units.js:215
  min: 22, max: 52,                                  // units.js:1606 `clamp(s * 0.42, 22, 52)`
  face: 'number',                                    // sp-mods: 'number' = upstream, 'clock' = the static 9:00 face
  handInk: 0xffffff,                                 // sp-mods: the same white the countdown digits use
  faceInk: null,                                     // sp-mods: null = no plate painted under the hands
});

/** units.js:1364 — the thin shield line over the HP bar (the `1.5` px floor stays in the renderer). */
export const SHIELD = makeStyleStore('shield', { lineWidth: 0.35, lineOffset: 1, overSplit: false, gapPx: 0 });

/** fx/fonts.js:14 + style.js DMG_STYLE — one bitmap font per damage style; `flat` / `stroke` collapse the paint. */
export const DMG = makeStyleStore('dmg', {
  font: ['Bender', 'Oxanium', 'Rajdhani', 'Arial Black', 'sans-serif'],
  flat: false,          // upstream: a two-stop gradient + stroke + drop shadow
  stroke: null,         // `null` = keep each style's OWN stroke (DMG_STYLE[*].stroke)
  physFill: 0xfffbe8, artsFill: 0xfbe8ff, trueFill: 0xffffff, healFill: 0xeafff0, elemFill: 0xfff4e0,
});

/** textures.js:1066-1089 — the tier chip (roman numerals) atlas. */
export const CHIP = makeStyleStore('chip', {
  width: 64, height: 44,      // textures.js:1089 `const w = 64, h = 44;`
  radius: 7,                  // 1071 `roundRect(c, x + 3, y + 3, w - 6, h - 6, 7)`
  stroke: 2.5,                // 1076
  plateAlpha: 1,              // upstream paints the alpha INTO the gradient colours ⇒ 1
  edge: 3,                    // 1071 `x + 3` / `w - 6`
  fontWide: 27, fontNarrow: 24, fontWeight: 700,   // 1078
  plate: { top: 0x2c3335, bottom: 0x111516 },      // 1074
  plateGold: { top: 0xffe27a, bottom: 0xd99a00 },  // 1073
  strokeInk: 'rgba(210,225,220,0.55)', strokeGold: 0xfff3b8,   // 1076
  ink1: 0xf2f2f2, ink2: 0xf2f2f2, ink3: 0xf2f2f2, ink4: 0xf2f2f2, ink5: 0xf2f2f2, ink6: 0xf2f2f2,  // 1077 (6× the same)
  textInk: 0xf2f2f2, textGold: 0x2a1a00,           // 1077
  /**
   * sp-mods, default `false` = the upstream look. `true`: a GOLDEN (精锐) chip's numeral keeps the colour it had before
   * the promotion — its tier's ink (`ink1..ink6`) — instead of falling back to the stroke / ring colour when `textGold`
   * is `null`. It is a knob of its own on purpose: "textGold = null means the ink" would be a behaviour change no
   * package could switch off.
   */
  textGoldTier: false,
  glowPx: 0, glowInk: null, glowGold: null, glowAlpha: 0.55,   // upstream has NO outer glow (0 = off, as shipped)
});

// ---------------------------------------------------------------------------------------------------------------
// the renderer's view, and the published API

/**
 * What `api.style.view` (and `mods.js`'s `STYLE`) hands out: the group objects themselves. `color` / `unit` are
 * resolved lazily because their stores are built by the patched `render/style.js` — which imports THIS module, so its
 * body runs after this one.
 */
export const STYLE = {
  get color() { return state().stores.color; },
  get unit() { return state().stores.unit; },
  get hitFlash() { return HIT_FLASH; },
  get fly() { return FLY; },
  get hud() { return HUD; },
  get down() { return DOWN; },
  get chip() { return CHIP; },
  get shield() { return SHIELD; },
  get dmg() { return DMG; },
};

/**
 * The live `COLORS` / `UNIT` of the renderer, re-exported (see NO CYCLE above) — `public/js/mods.js` reads the
 * plain-build fallback from this one import instead of reaching into the render palette itself.
 *
 * The cycle this closes is safe, and only because `makeStyleStore` is a FUNCTION DECLARATION (hoisted, so
 * `render/style.js` may call it from its own body while this module is still evaluating). It must never become a
 * `const makeStyleStore = …`: that would leave the binding in its TDZ at exactly that moment.
 */
export { COLORS, UNIT } from '../render/style.js';

/** The effective value of one knob — the package's value when it wrote one, the shipped default otherwise. */
export function styleKnob(group, key) {
  const keys = STYLE_KEYS[group];
  if (!keys || !keys.includes(key)) return undefined;
  const s = state();
  const bucket = s.buckets[group];
  if (bucket && key in bucket) return bucket[key];
  const held = s.pending[group];
  if (held && key in held) return held[key];
  return s.bases[group] && s.bases[group][key];
}

/**
 * Write one knob. `false` (and no write) when the group or key is not published; `true` otherwise.
 *
 * A write to a group whose store has not been handed over yet (see `makeStyleStore`) is HELD and applied the moment it
 * is — `true` there is a promise the engine keeps, not a value nobody reads.
 * @returns {boolean}
 */
export function setStyleKnob(group, key, value) {
  const keys = STYLE_KEYS[group];
  if (!keys || !keys.includes(key)) return false;
  const s = state();
  const bucket = s.buckets[group];
  if (!bucket) {
    (s.pending[group] || (s.pending[group] = Object.create(null)))[key] = value;
    markDirty(group);
    return true;
  }
  bucket[key] = value;
  markDirty(group);
  return true;
}

/** A snapshot of every override a package has made (shallow copy per group; for the manager page / diagnostics). */
export function styleOverrides() {
  const s = state();
  const out = {};
  for (const g of new Set([...Object.keys(s.buckets), ...Object.keys(s.pending)])) out[g] = { ...s.buckets[g], ...s.pending[g] };
  return out;
}

/**
 * Drop every override and tell the listeners everything changed (`'*'`).
 *
 * The buckets are emptied IN PLACE: a store's accessors close over their own bucket object, so replacing it here would
 * leave every live store (`COLORS`, `UNIT`, `HUD` …) reading the values this call is supposed to forget.
 */
export function resetStyleKnobs() {
  const s = state();
  for (const g of Object.keys(s.buckets)) {
    const bucket = s.buckets[g];
    for (const k of Object.keys(bucket)) delete bucket[k];
  }
  for (const g of Object.keys(s.pending)) delete s.pending[g];
  markDirty('*');
}
