// public/js/mods/timing.js — the timing/figure table behind `api.ui.banner` and `api.render.motion`.
//
// WHY A TABLE AND NOT "just edit the constant"
//   The render layer keeps its layout numbers as module-level `const` (fx.js NUM_RISE / NUM_LIFE, units.js gap
//   constants, components.css keyframe durations) and the constants are frozen. A mod cannot reach them, so the overlay
//   reads them through this table instead: the game asks for a value by name, the table answers with the base number or
//   with what a mod overrode.
//
// WHY `hook:` HANDLERS AND NOT JUST NUMBERS
//   Some of the interesting knobs are not numbers at all — "show this banner for 3 s instead of 1.5 s" depends on which
//   banner it is. So a key can also be answered by a function registered through the matching hook. Numbers win over
//   handlers only when a mod explicitly writes one; otherwise the handler chain decides, and the base value is the floor.

import { hooks as globalHooks } from '../../../shared/hooks.js';

/**
 * The registry every hook question here goes through. It is the shared singleton in the game; a test may swap in its
 * own instance so cases stay isolated without touching global state (`__setHooksForTest`).
 */
let hooks = globalHooks;
export function __setHooksForTest(registry) { hooks = registry || globalHooks; }

const noop = () => {};

/**
 * The published timing keys with their shipped defaults. The list is the contract: a mod writing a key that is not here
 * is refused (with a message), exactly like an unknown style knob.
 *
 * `banner.*`  —— the stage/phase banner (public/js/ui/components.js PhaseBanner + css/components.css keyframes)
 * `number.*`  —— damage numbers (public/js/render/fx.js module constants)
 * `hud.*`     —— per-frame HUD layout spacing (public/js/render/units.js)
 */
export const TIMING_KEYS = Object.freeze({
  'banner.defaultMs': 1500,     // how long a banner that does not say otherwise stays
  'banner.closeMs': 260,        // the JS delay after which the banner is unmounted (≥ the pb-close keyframe)
  'banner.animMs': 200,         // pb-open duration (band unfold)
  'banner.lineMs': 380,         // pb-line / pb-wipe duration
  'banner.sweepMs': 700,        // pb-sweep duration
  'banner.chevMs': 480,         // chevron slide-in
  'number.rise': 0.45,          // tiles a damage number rises
  'number.riseT': 0.9,          // seconds of that rise
  'number.life': 0.9,           // seconds a number lives
  'number.maxLife': 1.8,        // a merged running total lives longer, up to this
  'number.fadeT': 0.27,         // fade-out window at the end of a life
  'number.pop': 1.35,           // birth / merge scale pop
  'number.gapPx': 7,            // horizontal gap between two numbers side by side
  'number.mergeGap': 0.3,       // hits closer than this join the running total
  'number.perTarget': 4,        // live numbers per unit
  'number.crowd': 6,            // more live numbers than this around a spot → shorter lives
  'number.maxNumbers': 90,      // pool cap
  'number.bigRatio': 0.18,      // damage ≥ this share of maxHp is drawn "big"
  'number.bigScale': 1.35,      // ...at this scale
  'number.basePx': 24,          // display size of a number (the bitmap font is baked at 44)
  'hud.headGapPx': 4,           // bars' distance below the head anchor
  'hud.spGapPx': 1.5,           // gap between the HP bar and the SP bar
  'hud.spHeightFactor': 0.6,    // SP bar height as a fraction of the HP bar
  'hud.lowHpRatio': 0.3,        // below this HP ratio the ally bar switches to its "low" colour
});

/** The mutable table: base values, plus whatever a mod wrote. */
const values = { ...TIMING_KEYS };
/** Who wrote what (for the manager page and for refusing to be surprised). */
const writers = new Map();

/** Read one key; `undefined` for an unpublished key. */
export function timing(key) {
  return values[key];
}

/**
 * Read one key without a mod override — the number the shipped build uses. Useful for "scale relative to default"
 * (e.g. `number.life: timingBase('number.life') * 2`), which keeps a mod working when the base changes.
 */
export function timingBase(key) {
  return TIMING_KEYS[key];
}

/**
 * Write one key.
 * @param {string} key @param {number|boolean} value @param {{ mod?: string }} [opts]
 * @returns {boolean} false when the key is not published
 */
export function setTiming(key, value, { mod = 'anonymous' } = {}) {
  if (!Object.prototype.hasOwnProperty.call(TIMING_KEYS, key)) return false;
  const base = TIMING_KEYS[key];
  if (typeof base === 'number' && !Number.isFinite(Number(value))) return false;
  values[key] = typeof base === 'boolean' ? !!value : Number(value);
  writers.set(key, mod);
  return true;
}

/** Every key a mod has written, e.g. `{ 'number.life': 'my-mod' }` (diagnostics / tests). */
export function timingOverrides() {
  return Object.fromEntries(writers);
}

/** Drop every override (a mod being disabled, or a test resetting the table). */
export function resetTiming() {
  for (const k of Object.keys(TIMING_KEYS)) values[k] = TIMING_KEYS[k];
  writers.clear();
}

/**
 * How long the banner should stay.
 * @param {{ phase?: string, round?: number, duration?: number, title?: string, tone?: string }} info
 * @returns {number} milliseconds
 */
export function bannerMs(info = {}) {
  if (Number.isFinite(info.duration) && info.duration > 0) return info.duration;   // the call site asked explicitly
  const asked = hooks.first('ui:banner', { kind: 'duration', ...info, defaultMs: values['banner.defaultMs'] });
  return Number.isFinite(asked) && asked > 0 ? Number(asked) : values['banner.defaultMs'];
}

/**
 * Let a mod rewrite a banner before it is shown (or drop it by returning `null`).
 * @param {object|null} banner the banner the game is about to show
 * @returns {object|null}
 */
export function applyBanner(banner) {
  if (!banner) return banner;
  if (!hooks.has('ui:banner')) return banner;
  const out = hooks.run('ui:banner', banner, { kind: 'transform', phase: banner.phase, round: banner.round });
  return out === undefined ? banner : out;
}

/** Whether the game should show a banner at all (a mod returning `false` suppresses it). */
export function allowBanner(banner) {
  if (!hooks.has('ui:banner')) return true;
  const verdict = hooks.first('ui:banner', { kind: 'allow', banner });
  return verdict !== false;
}

/** Whether a damage number should be drawn (a mod returning `false` swallows it; the hit flash still plays). */
export function allowDamageNumber(view, amount, style, big) {
  if (!hooks.has('field:damageNumber')) return true;
  const verdict = hooks.first('field:damageNumber', { kind: 'allow', view, amount, style, big });
  return verdict !== false;
}

/**
 * Ask the mods what a damage number should look like.
 *
 * A handler may return:
 *   · a string or a number      → the figure to draw (`'暴击!'`, `999`)
 *   · an object                 → `{ text?, color?, life?, scale?, big? }`; every field is optional, and a field that is
 *                                 not there keeps the game's own value
 *   · `undefined` / `null`      → keep the game's own number
 *
 * The normalised `{ text, color, life, scale, big }` shape is returned (or null when nobody wants a change), so the
 * render layer never has to know which of the two forms a mod used.
 *
 * @returns {{ text: string|null, color: number|string|null, life: number|null, scale: number|null, big: boolean|null }|null}
 */
export function damageNumberStyle(view, amount, style, big) {
  if (!hooks.has('field:damageNumber')) return null;
  let out;
  try { out = hooks.first('field:damageNumber', { kind: 'text', view, amount, style, big }); }
  catch { return null; }
  if (out === undefined || out === null) return null;
  if (typeof out === 'string' || typeof out === 'number') {
    return { text: String(out), color: null, life: null, scale: null, big: null };
  }
  if (typeof out !== 'object' || Array.isArray(out)) return null;
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
  const text = typeof out.text === 'string' ? out.text : (Number.isFinite(Number(out.text)) && out.text != null ? String(out.text) : null);
  return {
    text,
    color: out.color ?? null,
    life: num(out.life),
    scale: num(out.scale),
    big: typeof out.big === 'boolean' ? out.big : null,
  };
}

/** Backwards-compatible wrapper: the figure to draw, or null to keep the game's own text. */
export function damageNumberText(view, amount, style, big) {
  const s = damageNumberStyle(view, amount, style, big);
  return s ? s.text : null;
}

export { noop };
