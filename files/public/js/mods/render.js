// public/js/mods/render.js — the LOGIC behind the battlefield (render layer) seams of the mod package loader.
//
// WHY THE LOGIC LIVES HERE AND NOT IN THE UPSTREAM FILES
//   `public/js/render/**` belongs to upstream. Every line the loader adds there is a line the next upstream release can
//   move out from under it — which is exactly how the v1 manager rotted: it shipped whole copies of the render layer and
//   silently lost 0.2.4's impostor scheduling, `poseHeld`, the eye-mask fallback and `ItemView`. So an upstream file gets
//   ONE import and one call per seam, and every decision (the guard, the context object, the normalisation of the answer)
//   is made here — in a file the loader owns (`catalog.mjs` OURS) and can replace at will.
//
// THE RULES THIS FILE OBEYS
//   1. ZERO COST WITH NO PACKAGE MOUNTED. Every entry point returns after ONE `hooks.has(...)` / `hasSubscriber(...)`
//      lookup, and that lookup is its FIRST statement: the per-frame seams (`frameTick` / `overlay`), the per-unit ones
//      (`unitBars` / `chip`) and the per-hit ones (`consumeEvents` / `takeDamage`) are the hot paths, so no object,
//      array or string may be built before the guard has answered. A page with no package installed has to run at exactly
//      the old speed — that is the property the seams are judged on (workspace `reports/seam-app-fx.md` §0, §8).
//   2. NO IMPORT OF AN UPSTREAM RENDER MODULE. `render/app.js`, `render/units.js` and `render/fx/numbers.js` import THIS
//      file; importing any of them back would close a cycle whose bindings are `undefined` when the first frame runs.
//      Only the shared hook registry, the package registry (`../mods.js`) and `./timing.js` are imported here.
//   3. NEVER THROW INTO THE GAME. A third-party handler that throws must not break a frame. The hook registry already
//      isolates and reports handlers; the calls below are wrapped as well.
//
// THE HOOKS BEHIND THESE SEAMS (names and kinds: shared/hooks.js; a package declares them in mod.json `hooks`)
//   field:event         every raw battle event tuple, before the view handles it          per frame (per event tuple)
//   field:damage        a hit is about to be drawn — a package may take it over           per hit
//   field:viewGone      a view left the snapshot: play its own death instead of the fade  per view that leaves
//   field:frame         once per rendered frame, from inside the frame's own `try`        per frame
//   field:overlay       draw into the battlefield, with the real render context           per frame
//   field:unitBars      our operators' HP + SP bars: length, thickness, colours, plate    per unit per frame
//   field:enemyBars     the same for enemies / elites / bosses                            per unit per frame
//   field:chip          the tier chip above a unit                                        per unit per frame
//   field:damageNumber  `kind: 'allow'` (draw it at all) and `kind: 'text'` (what it looks like)
//
// THE `battleId` ARGUMENT
//   The 0.2.4 render layer has no battle id of its own (`render/interp.js` carries none, and `battle/runner.js` does not
//   put one into the snapshot), so the call sites pass `battleMeta.fieldId` — the board the stream on screen belongs to.
//   It is constant inside one battle and changes between battles, which is what a package needs to scope per-battle
//   state. A real `battleId` would need the `battle/runner.js` seam (one more THEIRS file) — see the report, §1.3 ③.

import { hooks } from '../../../shared/hooks.js';
import { notifyEvent, notifyFrame, hasSubscriber } from '../mods.js';

/**
 * The two phases of `field:damageNumber`, straight from `./timing.js` (the loader's timing/figure table), which is where
 * the `hooks.has('field:damageNumber')` guard and the answer normalisation live: `allowDamageNumber` → is the figure
 * drawn at all, `damageNumberStyle` → `{ text, color, life, big }`. Re-exported so the upstream render files import the
 * whole render-side surface from ONE module.
 */
export { allowDamageNumber, damageNumberStyle } from './timing.js';

// ---------------------------------------------------------------------------------------------------------------
// field:event — the raw battle event stream

/**
 * Is anybody interested in the event stream at all (`field:event`, or `api.on('event')`)?
 *
 * The call site in `render/app.js` asks this once per frame, so it must not allocate: two lookups and nothing else.
 * (NOT `subscriberCount()`, which builds an object per call — one allocation per frame.)
 *
 * @returns {boolean}
 */
export function wantsEvents() {
  return hooks.has('field:event') || hasSubscriber('event');
}

/**
 * Hand this frame's raw event tuples to the packages BEFORE the view handles them (`render/app.js` `processEvents`).
 *
 * ONE payload object serves the whole frame, its `ev` field moved from tuple to tuple: that is the zero-allocation form
 * of the v1 loop. `notifyEvent` hands the object out by reference, so an `api.on('event')` handler must read it inside
 * the handler and never keep it; `field:event` handlers get a frozen copy (the registry freezes what it emits). The
 * tuples themselves are the view's own — read only, never rewrite them.
 *
 * @param {Array<Array>} evs the reused `EVS` array of `render/app.js` (reused: do not keep it either)
 * @param {number} renderT the render time of this frame (game seconds)
 * @param {string|null} battleId the board this stream belongs to (`battleMeta.fieldId`)
 */
export function consumeEvents(evs, renderT, battleId) {
  const wantEvent = hasSubscriber('event');
  const wantHook = hooks.has('field:event');
  if (!wantEvent && !wantHook) return;      // a package mounted mid-frame: the call site's guard was true a moment ago
  const payload = { ev: null, renderT, battleId };
  for (const e of evs) {
    payload.ev = e;
    if (wantEvent) { try { notifyEvent('event', payload); } catch { /* a broken package never breaks the frame */ } }
    if (wantHook) { try { hooks.emit('field:event', payload); } catch { /* idem */ } }
  }
  payload.ev = null;
}

// ---------------------------------------------------------------------------------------------------------------
// field:damage / field:viewGone — the two per-hit seams

/**
 * `field:damage` (`render/app.js`, the `dmg` event): a hit is about to be drawn.
 *
 * A truthy answer means "a package took this hit over" and the caller skips its own `fx.damage`. That call is what plays
 * the hit flash, `view.onHit` and the blood particles, so a handler that only wants to move or restyle the number has to
 * call `fx.damage(view, amount, type, src)` itself — otherwise the hit lands with no feedback at all.
 *
 * @param {object} view the target's view @param {number} amount the damage @param {any} type the damage type
 * @param {object|null} src the attacker's view, when this hit is a melee follow-up
 * @param {number} now the event's render time @param {object} fx the effect system
 * @param {string|null} battleId
 * @returns {boolean} true = the call site must NOT draw the hit itself
 */
export function takeDamage(view, amount, type, src, now, fx, battleId) {
  if (!hooks.has('field:damage')) return false;
  const out = hooks.first('field:damage', {
    view, amount, type, src, now, fx, battleId,
    renderT: null,                                   // the v1 contract's field: this seam is per event, not per frame
    side: view.isEnemy ? 'enemy' : 'ally',
  });
  return out !== undefined && out !== null;
}

/**
 * `field:viewGone` (`render/app.js` `syncBattle`): a view left the snapshot.
 *
 * A package may answer `{ die: true }` to play the view's own death instead of the shipped 0.25 s fade — what an operator
 * needs, because the simulation drops a knocked-out operator from `units` in the very frame it falls and the
 * interpolation buffer can miss that frame (the model would freeze on its last action frame). `{ instant: true }` asks
 * for the instant death. Answering for a view with no `die` (a device, an item, a scout board) is ignored.
 *
 * @param {object} view @param {number} now @param {string|null} battleId
 * @returns {object|null} the first non-null answer, or null when nobody is registered
 */
export function viewGone(view, now, battleId) {
  if (!hooks.has('field:viewGone')) return null;
  return hooks.first('field:viewGone', {
    view, now, battleId,
    kind: view.info?.kind ?? null,
    side: view.isEnemy ? 'enemy' : 'ally',
  });
}

// ---------------------------------------------------------------------------------------------------------------
// field:unitBars / field:enemyBars / field:chip — the per-unit HUD seams

/**
 * `field:unitBars` / `field:enemyBars` (`render/units.js` `_updateHud`): the bars above one unit.
 *
 * A handler may return `{ width, height, backPadPx, backAlpha, hpColor, hpLowColor, lowHpRatio, spColor, spActiveColor,
 * spReadyColor }` — every field optional, an absent field keeps the shipped value. `null` (nobody registered, or no
 * answer) leaves the whole HUD on the shipped values.
 *
 * ⚠️ 0.2.4 has NO numeric barrier: `shield` is a boolean line (`UF.SHIELD`) and is passed as `shield: 0` +
 * `shieldPlain`, so a v1 handler that expected a shield amount sees `0` here rather than a wrong number.
 *
 * @param {boolean} isEnemy @param {object} view the `UnitView` @param {number} width @param {number} height the shipped
 *   bar geometry (a handler may read it and scale relative to it)
 * @param {boolean} shieldPlain whether the unit currently shows the plain shield line
 * @returns {object|null}
 */
export function unitBars(isEnemy, view, width, height, shieldPlain) {
  const kind = isEnemy ? 'field:enemyBars' : 'field:unitBars';
  if (!hooks.has(kind)) return null;         // the whole cost with no package mounted: one Map lookup, no object
  return hooks.run(kind, null, {
    view,
    side: isEnemy ? 'enemy' : 'ally',
    boss: !!view.isBoss,
    token: !!view.isToken,
    defId: view.info?.defId ?? null,
    hp: view.hp, maxHp: view.maxHp, sp: view.sp, spMax: view.spMax,
    width, height,
    shield: 0, shieldPlain,                  // 0.2.4: a boolean line, not a pool (see above)
    backPadPx: 1, backAlpha: 0.85,           // the shipped plate, for a handler that wants to scale relative to it
  });
}

/**
 * `field:chip` (`render/units.js` `_updateHud`): the tier chip left of the bars (above the head in the prep).
 *
 * A handler may return `{ scaleMul, alpha, hidden }` — every field optional. `null` keeps the shipped chip; the call site
 * puts `alpha` back to 1 when no package answers any more, so unloading a package leaves no stale transparency behind.
 *
 * @param {object} view @param {boolean} prep the prep field (the chip sits above the head there, not beside the bars)
 * @returns {object|null}
 */
export function chip(view, prep) {
  if (!hooks.has('field:chip')) return null;
  return hooks.run('field:chip', null, {
    view, prep,
    tier: view.tier,
    golden: !!view.golden,
    defId: view.info?.defId ?? null,
  });
}

// ---------------------------------------------------------------------------------------------------------------
// field:frame / field:overlay — the two per-frame seams

/**
 * The per frame seams, called from inside `render/app.js` `frameBody`'s `try` (so a throwing package is caught by the
 * frame's own handler and the frame keeps rendering).
 *
 * `frameTick` serves both halves of the frame notification: the `frame` event (`api.on('frame')`, per subscriber, by
 * reference) and `field:frame` (per handler, frozen copy). One payload object is built per frame and only when somebody
 * is registered — with no package mounted this function returns on its first lookup.
 *
 * ⚠️ `dt` is REAL seconds, un-clamped: after a hidden tab it is a large number, so a handler must clamp it itself.
 * `renderT` is `interp.renderT`, which outside battle mode is the last battle's leftover (use `clock` to drive idle
 * animations, not `renderT`).
 *
 * @param {number} dt real seconds since the last frame @param {number} renderT the interpolation time (game seconds)
 * @param {string} mode `'idle' | 'prep' | 'battle'` @param {number} clock the frame clock (`dt`, clamped)
 * @param {string|null} battleId
 */
export function frameTick(dt, renderT, mode, clock, battleId) {
  const wantEvent = hasSubscriber('frame');
  const wantHook = hooks.has('field:frame');
  if (!wantEvent && !wantHook) return;       // no package mounted: two lookups, nothing allocated, nothing called
  const payload = { dt, renderT, mode, battleId, clock };
  if (wantEvent) { try { notifyFrame(payload); } catch { /* idem */ } }
  if (wantHook) { try { hooks.emit('field:frame', payload); } catch { /* idem */ } }
}

/**
 * `field:overlay`: the "draw it yourself" pass — a package paints into the battlefield with the real render context.
 *
 * `layers.overlay` is world space (drawn under the shadows), `layers.screen` is screen space on top of everything. Two
 * hard rules for a handler, both from the 0.2.4 structure: build your `Graphics` / `Text` ONCE and reuse it (allocating
 * per frame is a dropped frame), and pass a reusable `out` object to `cam.project(x, y, z, out)` (without one it
 * allocates a point per call). Children added to a layer are NOT removed by a battle reset — clear them on `battleEnd`.
 *
 * @param {object} ctx the render context (`P`, `layers`, `cam()`, `settings`, `renderer`, `frameNo()` …)
 * @param {object} cam the camera @param {number} clock @param {number} dt real seconds @param {string} mode
 * @param {object} layers the eleven PIXI containers @param {Map} views the live views @param {object} fx the effect system
 * @param {object} tiles the tile field @param {string|null} battleId
 */
export function overlay(ctx, cam, clock, dt, mode, layers, views, fx, tiles, battleId) {
  if (!hooks.has('field:overlay')) return;   // no package mounted: one lookup, no payload object, no call
  try {
    hooks.emit('field:overlay', { ctx, cam, clock, dt, mode, battleId, layers, views, fx, tiles });
  } catch { /* idem */ }
}
