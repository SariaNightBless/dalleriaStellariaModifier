// server/sim/modlogic.js — the simulation's side of the mod loader: one registry, four hook points.
//
// MOUNTED AT /sim/modlogic.js
//   The page imports the simulation straight from the server (`/sim/**`), so this file is what a behaviour mod's client
//   copy can reach. It is deliberately dependency-free (no imports at all): the simulation loads it at module-eval time
//   and a cycle would be fatal.
//
// THE FOUR HOOK POINTS (patched into Battle.js/ai.js by the installer — each call site is guarded and wrapped)
//
//   sim:battleStart   `(battle)`            the battle was constructed and its units are set up. A mod may add
//                                           persistent buffs, rewrite `enemyOverrides`, register its own `battle.on`.
//   sim:enemyAI       `(enemy, ctx) → e2`   per enemy, per tick, BEFORE the enemy thinks. Return the enemy (or a
//                                           stand-in) to let the mod adjust it: `pauseUntil`, `route`, `x/y`, `atkCd`,
//                                           `profile.canTarget`, … The shipped AI then runs as usual.
//   sim:unitTick      `(unit, ctx) → u2`    per unit (both sides), per tick, before its update.
//   sim:damage        `(ctx) → ctx2`        right before a hit is applied: `{ source, target, dmg }`. Mutating
//                                           `dmg.amount` / `dmg.mul` / `dmg.type` here is the supported way to change
//                                           damage ("the damage the game computed, plus or minus what the mod says").
//   sim:battleEnd     `(battle, result)`    the battle finished; the result object can still be adjusted.
//
// DETERMINISM IS THE CONTRACT (read this before writing a behaviour mod)
//   Both peers run this file. The server re-simulates a battle with the same spec (`SP_VERIFY`) and compares
//   `resultDigest`; a difference means the server's result replaces the client's. So:
//     · handlers run in a fixed order — sorted by `priority` (desc) then by owner id — never "registration order";
//     · NO `Math.random()`, NO `Date.now()` / `performance.now()`, NO `await` / timers / network in a handler;
//     · randomness only through `battle.rng` (the seeded mulberry32), and NEVER a bare extra `battle.rng()` call:
//       it is a shared stateful sequence, one extra draw shifts every later draw. A mod that needs its own stream must
//       derive one — `deriveSeed(battle.seed, 'mod:<id>')` — so the main sequence stays untouched;
//     · iterate the game's own arrays (`battle.enemies`, `battle.allies()`); their order is stable. Never iterate a
//       `Set`/`Map` you built from them expecting a meaningful order;
//     · a handler that throws is caught, reported once and skipped — the battle keeps running and stays deterministic.
//
// A mod declares `clientOnly: false` when it uses any of these: every peer (and the server's verify pass) must have the
// same package, otherwise the digests differ.

/** Hook kinds this registry serves. Kept in sync with `shared/hooks.js` (the page's list) by name only. */
export const SIM_HOOKS = Object.freeze([
  'sim:battleStart', 'sim:enemyAI', 'sim:unitTick', 'sim:damage', 'sim:battleEnd',
  // asked by `simAttackWindow` below (the ATTACK window / an enemy's attack pause), not by a patched call site
  'sim:attackAnim',
  // asked by `attackRhythmBits` (the per-unit attack rhythm published in the snapshot's `flags`), not by a call site
  'sim:attackRhythm',
  // asked by `simStrikeDelay` below (how long after an ally attack starts its damage lands), not by a patched call site
  'sim:strikeDelay',
  // asked by the patched `server/sim/ai.js` call sites: the candidate targets of an ally attack (`acquireTargets`) and
  // the damage multiplier of one attack against one target (`performAttack` → `resolveHit`)
  'sim:targets', 'sim:attack',
  // 阻挡两规则（2026-10）：一次攻击候选表的**最终顺序**（把最先挡住的排最前），以及**这一挥的形态**（'melee' / 'ranged'）
  'sim:targetOrder', 'sim:attackMode',
]);

const noopLogger = { warn() {}, error() {} };

class SimHookList {
  constructor(kind) {
    this.kind = kind;
    this.items = [];
    this.sorted = true;
    this.seq = 0;
    /** Reported handlers (one line each, however many times they throw). */
    this.reported = new Set();
  }
  add(owner, fn, priority) {
    const rec = { owner: String(owner || 'anonymous'), fn, priority: Number(priority) || 0, seq: this.seq++ };
    this.items.push(rec);
    this.sorted = false;
    return () => { const i = this.items.indexOf(rec); if (i >= 0) this.items.splice(i, 1); };
  }
  order() {
    if (!this.sorted) {
      // priority desc, then owner id, then registration: the same order on every peer and every run
      this.items.sort((a, b) => (b.priority - a.priority) || (a.owner < b.owner ? -1 : a.owner > b.owner ? 1 : 0) || (a.seq - b.seq));
      this.sorted = true;
    }
    return this.items;
  }
}

/**
 * The registry. One instance per process; the page and the server each have their own (they are separate JS realms).
 */
export class SimLogic {
  constructor({ logger = noopLogger } = {}) {
    /** @type {Map<string, SimHookList>} */
    this.lists = new Map();
    this.logger = logger;
    /** `owner → [off]`, so a package can be taken out again. */
    this.byOwner = new Map();
  }
  list(kind) {
    let l = this.lists.get(kind);
    if (!l) { l = new SimHookList(kind); this.lists.set(kind, l); }
    return l;
  }
  has(kind) { const l = this.lists.get(kind); return !!(l && l.items.length); }
  counts() { const out = {}; for (const [k, l] of this.lists) if (l.items.length) out[k] = l.items.length; return out; }
  owners() { const out = {}; for (const [k, l] of this.lists) if (l.items.length) out[k] = l.items.map((r) => r.owner); return out; }

  /**
   * Register one handler.
   * @param {string} kind @param {string} owner the package id @param {Function} fn @param {{ priority?: number }} [opts]
   * @returns {() => void} unregister
   */
  register(kind, owner, fn, { priority = 0 } = {}) {
    if (typeof fn !== 'function') throw new TypeError(`sim hook "${kind}": handler must be a function`);
    if (!SIM_HOOKS.includes(kind)) {
      console.warn(`[mods] unknown simulation hook "${kind}" — see docs/API.md (钩子清单); registered anyway so a newer build can call it`);
    }
    const off = this.list(kind).add(owner, fn, priority);
    let set = this.byOwner.get(owner);
    if (!set) { set = []; this.byOwner.set(owner, set); }
    set.push(off);
    return () => { off(); const i = set.indexOf(off); if (i >= 0) set.splice(i, 1); };
  }

  /** Drop everything one package registered. */
  dropOwner(owner) {
    const set = this.byOwner.get(owner);
    if (!set) return 0;
    for (const off of set.splice(0)) { try { off(); } catch { /* already gone */ } }
    this.byOwner.delete(owner);
    return 1;
  }

  /**
   * Run a "value threading" hook: each handler gets `(value, ctx)`; `undefined`/`null` keeps the current value, anything
   * else replaces it. A throwing handler is reported once and skipped.
   */
  run(kind, value, ctx = {}) {
    const l = this.lists.get(kind);
    if (!l || !l.items.length) return value;
    let v = value;
    for (const rec of l.order()) {
      let out;
      try { out = rec.fn(v, Object.freeze({ kind, ...ctx, mod: rec.owner })); }
      catch (err) { this._report(l, rec, err, ctx); continue; }
      if (out !== undefined && out !== null) v = out;
    }
    return v;
  }

  /** Run a "notification" hook (no value): `(ctx)`. */
  emit(kind, ctx = {}) {
    const l = this.lists.get(kind);
    if (!l || !l.items.length) return 0;
    let n = 0;
    for (const rec of l.order()) {
      try { rec.fn(Object.freeze({ kind, ...ctx, mod: rec.owner })); n++; }
      catch (err) { this._report(l, rec, err, ctx); }
    }
    return n;
  }

  _report(l, rec, err, ctx) {
    const key = `${l.kind}:${rec.owner}:${rec.fn?.name || 'fn'}`;
    if (l.reported.has(key)) return;
    l.reported.add(key);
    const where = ctx && ctx.battle ? `tick ${ctx.battle.tickCount ?? '?'}` : '';
    this.logger.warn?.(`[mods] sim hook "${l.kind}" of "${rec.owner}" threw ${where} — skipped from now on`, err);
  }
}

/** The process-wide registry: the server's own, and (through /sim/modlogic.js) the page's. */
export const simLogic = new SimLogic();

/** Shorthand for the patched call sites: `if (simHas('sim:enemyAI')) …` keeps the no-mod path free. */
export const simHas = (kind) => simLogic.has(kind);

/**
 * HOW LONG a unit's attack animation lasts, in **game seconds** — the one number the ATTACK window and an enemy's
 * attack pause have to agree on (`snapshot.js animOf` reports ATTACK for it; a behaviour mod that wants the enemy to
 * stand still for its swing arms `pauseUntil` with it).
 *
 * The length comes from the unit's own model: `attackAnimTime` is baked into `data/enemies.json` by
 * `tools/build-data.mjs` from the asset manifest (the simulation itself cannot read `assets.json` — it is not one of
 * `SIM_DATA_FILES`). The field is the length of the attack **clip**, and the clip is played at `rate = attackRate(...)`:
 * **its own length** (`rate` 1), squeezed only when the attack rhythm is SHORTER than the clip — exactly what
 * `render/spine.js` does to its track (`attackRate` / `RATE_FLOOR`). A 1 s swing under a 3 s rhythm therefore takes
 * 1 s on screen, and the unit walks for the other 2 s; it is never stretched into a slow-motion 3 s swing. Without the
 * field (an older `data/`, a unit that never attacks) the shipped `ATTACK_ANIM_TIME` applies.
 *
 * A mod may answer for a unit through the **`sim:attackAnim`** hook (`(unit) => seconds`), which is asked first: the
 * hook is the mod's own answer and this function is only the default.
 *
 * @param {object} u a unit (`attackAnimTime` from its def, `s.interval` = the seconds between its attacks)
 * @param {number} [fallback] seconds when nothing is known (defaults to the shipped `ATTACK_ANIM_TIME`, 0.35)
 */
export function simAttackWindow(u, fallback = 0.35) {
  if (simHas('sim:attackAnim')) {
    const v = simLogic.run('sim:attackAnim', undefined, { unit: u, fallback });
    if (Number.isFinite(v) && v >= 0) return v;
  }
  const dur = Number(u && u.attackAnimTime);
  if (!Number.isFinite(dur) || dur <= 0) return fallback;
  const iv = Number(u && u.s && u.s.interval);
  if (!Number.isFinite(iv) || iv <= 0) return dur;
  // rate = clamp(clip / interval, 1, 4): never slower than the clip's own length, squeezed to fit a shorter rhythm
  return dur / Math.min(4, Math.max(1, dur / iv));
}

/**
 * HOW LONG AFTER an ally attack starts its damage should land, in **game seconds** — the seam that puts the *logic
 * frame* on the model's own strike frame. `render/spine.js` plays the attack clip from its first frame at the clip's
 * own rhythm, so the strike frame arrives `strike / rate` game seconds after the attack began; a package that starts
 * the clip on the logic frame (instead of fast-forwarding the wind-up, see the `field:attack` seam) answers this and
 * `ai.js performAttack` waits that long before resolving each target.
 *
 * **0 without a mod** — the shipped behaviour, unchanged: every target is resolved on the spot:
 *
 *   const delay = simStrikeDelay(u, { battle: b, profile: prof, targets, isSkill });
 *   if (delay > 0) b.after(delay, …); else …resolve now…
 *
 * The number has to come from the model: `strike / rate` with `rate = clamp(clip / interval, 0.35, 4)` — the same
 * `rate` `render/spine.js` and `simAttackWindow` use. Both fields travel on the **def** (`u.def.attackAnimTime` = the
 * attack clip's length in clip seconds, `u.def.attackStrikeAt` = the `OnAttack` frame inside it), baked into
 * `data/enemies.json` / `data/chess.json` by `tools/build-data.mjs` — the simulation cannot read the asset manifest.
 *
 * ⚠️ Answering non-zero **changes battle outcomes** (damage lands later; a target that died or left in between is
 * skipped). Such a package must be `clientOnly: false`, installed on both peers, and must derive the number from
 * state both sides see (the def + `s.interval`) — inside the tick, never from wall-clock time or randomness.
 *
 * @param {object} u an ally unit (`u.def` from `simdata.js`, `u.s.interval` = the seconds between its attacks)
 * @param {object} [ctx] `{ battle, profile, targets, isSkill }` — handed to the handler
 * @returns {number} seconds to defer each target's resolution by; `0` = resolve immediately (shipped behaviour)
 */
export function simStrikeDelay(u, ctx = {}) {
  if (simHas('sim:strikeDelay')) {
    const v = simLogic.run('sim:strikeDelay', 0, { ...ctx, unit: u });
    if (Number.isFinite(v) && v > 0) return Math.min(10, v);
  }
  return 0;
}

/**
 * The API a behaviour mod's `install(battle)` receives, in addition to the battle itself.
 *
 * `install(battle, api)` is called by the simulation with this object, so a package never has to import the registry to
 * register a hook — and the loader can attribute every registration to the package that made it.
 *
 * @param {string} modId
 */
export function makeSimApi(modId) {
  return Object.freeze({
    api: 1,
    mod: modId,
    /** Register a simulation hook. See SIM_HOOKS for the kinds and this file's header for the determinism rules. */
    on: (kind, fn, opts) => simLogic.register(kind, modId, fn, opts),
    /** A seeded RNG of the mod's own, derived from the battle seed: safe to draw from as much as you like. */
    deriveRng(battle, salt = '') {
      let s = ((Number(battle?.seed) || 1) ^ 0x9e3779b9) >>> 0;
      const tag = `mod:${modId}${salt ? ':' + salt : ''}`;
      for (let i = 0; i < tag.length; i++) { s = Math.imul(s ^ tag.charCodeAt(i), 16777619) >>> 0; }
      return mulberry32(s);
    },
    log: (...a) => console.log(`[mod:${modId}:sim]`, ...a),
    warn: (...a) => console.warn(`[mod:${modId}:sim]`, ...a),
    error: (...a) => console.error(`[mod:${modId}:sim]`, ...a),
  });
}

/** A local copy of the sim's PRNG (no import: this file must stay dependency-free). Same algorithm as server/sim/rng.js. */
function mulberry32(seed) {
  let s = (Number(seed) >>> 0) || 0x9e3779b9;
  const next = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const rng = () => next();
  rng.int = (n) => Math.floor(next() * Math.max(0, n));
  rng.range = (a, b) => a + next() * (b - a);
  rng.chance = (p) => next() < p;
  rng.pick = (arr) => (arr && arr.length ? arr[Math.floor(next() * arr.length)] : undefined);
  rng.state = () => s;
  return rng;
}
