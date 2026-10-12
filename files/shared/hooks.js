// shared/hooks.js — the hook contract of the mod loader, shared by the page and the simulation.
//
// WHY A REGISTRY (and not "monkey-patch the game modules")
//   A mod must not be able to reach into the game's internals: those change every release, and a patch that lands badly
//   breaks the whole page for everyone. So the game code calls NAMED HOOK POINTS at the places that matter, and a mod
//   registers a handler for the name. The loader owns the list, the order and the error isolation.
//
// THE FOUR RULES THE IMPLEMENTATION GUARANTEES
//   1. NEVER THROW: a handler that throws is reported (once per hook+handler) and skipped; the frame keeps rendering and
//      the simulation keeps ticking.
//   2. DETERMINISTIC ORDER: handlers run sorted by (priority desc, mod id asc). Under client-side combat both peers run
//      the same handler set, so the same order is what keeps `resultDigest` equal.
//   3. PASS-THROUGH: a hook that carries a value hands it along the chain. Returning `undefined`/`null` means "no
//      change"; returning a value replaces it. A handler can therefore read what the previous one produced.
//   4. NO GLOBAL SIDE EFFECTS: a handler gets a frozen context object and must only touch what it returns. This file
//      exports no game state, so it is safe to import from `server/sim/*` (where the page mounts it at /sim/hooks.js)
//      and from the page alike.
//
// The context object a handler receives always carries `mod` (the package id that registered it) and, when the call site
// has one, a mutable `scratch` object shared by every handler of THAT call — so a chain can pass notes forward.

/** Hook kinds the game calls. A mod declares the ones it uses in `mod.json` (`hooks`), which is what the manager shows. */
export const HOOK_KINDS = Object.freeze([
  // ---- page shell (DOM / CSS): safe, clientOnly ---------------------------------------------------------------
  'ui:button',        // contribute buttons to a host (title bar, room bar, in-battle bar)
  'ui:panel',         // contribute a panel/dialog the host can open
  'ui:screen',        // contribute a whole screen (a route)
  'ui:banner',        // restyle or retime a banner (stage banner, boss intro, wave notice)
  'ui:toast',         // receive every toast, or supply your own text
  'ui:css',           // inject a stylesheet (authoritative: the loader keeps one <link> per mod)
  'ui:slot',          // the game declares a named DOM area (a layout seam); `api.ui.slots.*` moves elements into it
  // ---- battlefield view (PIXI): safe, clientOnly --------------------------------------------------------------
  'field:unitBars',   // our operators' HP + SP bars: colours, geometry, extra segments
  'field:enemyBars',  // enemy / elite / boss bars
  'field:chip',       // the tier chip above a unit ("等级牌")
  'field:damageNumber', // damage numbers / floating text
  'field:unitSprite', // our operators' model: scale, tint, offset, animation choice
  'field:enemySprite',  // enemies' model: the same, plus per-enemy overrides
  'field:animation',  // animation state machine: what pose/loop/speed a state uses
  'field:attack',     // an attack happened (the 'atk' event): facing, phase, the damage number's timing
  'field:unitMotion', // per frame: where a unit's body and shadow are drawn, and which way it faces
  'field:damage',     // a hit is about to be drawn: take the damage number over (or leave it alone)
  'field:viewGone',   // a view left the snapshot: play its own death instead of the short fade?
  'field:event',      // every battle event tuple, before the view handles it
  'field:frame',      // once per rendered frame, from the render loop (same payload shape as the 'frame' event)
  'field:overlay',    // draw on top of the battlefield (world space or screen space)
  // ---- simulation (authoritative): changes the outcome, so clientOnly MUST be false ---------------------------------
  'sim:enemyAI',      // enemy movement/target decisions, per enemy per tick
  'sim:damage',       // damage/heal numbers, before they are applied
  'sim:unitTick',     // per-unit per-tick adjustments (speed, cooldowns, statuses)
  'sim:battleStart',  // a battle was constructed (last chance to mutate its starting state)
  'sim:battleEnd',    // the battle finished, before the result is compacted
  'sim:content',      // contribute data tables (the in-code half of a content pack)
  'sim:attackAnim',     // how long a unit's ATTACK animation lasts (the ATTACK window / an enemy's attack pause)
  'sim:attackRhythm',   // seconds between a unit's attacks, published in the snapshot so the swing can be timed to it
  'sim:strikeDelay',    // how long after an ally attack starts its damage lands (the logic frame on the strike frame)
  'sim:targets',        // the enemies an ally may pick as targets (value in / value out: the candidate list)
  'sim:targetOrder',    // the FINAL order of an attack's candidate list — put the first-blocked enemy first (value in / out)
  'sim:attackMode',     // the mode of ONE swing: 'melee' or 'ranged' (value in / value out; a ground unit in a block
                        // relation uses its melee attack — high-ground operators never enter a block state)
  'sim:attack',         // the damage multiplier of ONE attack against ONE target (value in / value out)
]);

/** Which kinds a package may use while claiming `clientOnly: true`. */
export const CLIENT_SAFE_KINDS = Object.freeze(HOOK_KINDS.filter((k) => !k.startsWith('sim:')));

const noop = () => {};

/**
 * One hook kind's handlers. Kept as a tiny class so the call sites stay cheap: `run` is a length check plus a loop, and
 * a kind nobody registered on costs one property read.
 */
class HookList {
  constructor(kind) {
    this.kind = kind;
    /** @type {Array<{mod:string, fn:Function, priority:number, seq:number}>} */
    this.items = [];
    this.sorted = true;
    this.seq = 0;
    /** Handlers that threw, so each one is reported exactly once. */
    this.reported = new Set();
  }

  add(mod, fn, priority = 0) {
    const rec = { mod: String(mod || 'anonymous'), fn, priority: Number(priority) || 0, seq: this.seq++ };
    this.items.push(rec);
    this.sorted = false;
    return () => {
      const i = this.items.indexOf(rec);
      if (i >= 0) this.items.splice(i, 1);
    };
  }

  order() {
    if (!this.sorted) {
      // priority desc, then mod id, then registration order: deterministic across peers and reloads
      this.items.sort((a, b) => (b.priority - a.priority) || (a.mod < b.mod ? -1 : a.mod > b.mod ? 1 : 0) || (a.seq - b.seq));
      this.sorted = true;
    }
    return this.items;
  }

  report(rec, err, where) {
    const key = `${rec.mod}:${rec.fn?.name || 'fn'}`;
    if (this.reported.has(key)) return;
    this.reported.add(key);
    console.error(`[mods] hook "${this.kind}" handler of "${rec.mod}" threw${where ? ` (${where})` : ''} — skipped from now on`, err);
  }
}

/** The registry handed to every mod (`api.hooks`). */
export class HookRegistry {
  /** @param {{ owner?: string, onError?: (kind: string, mod: string, err: any) => void }} [opts] */
  constructor({ owner = 'mods', onError = null } = {}) {
    /** @type {Map<string, HookList>} */
    this.lists = new Map();
    this.owner = owner;
    this.onError = onError;
    /** Every registration ever made, for the manager page and for unloading a package. */
    this.byMod = new Map();
  }

  /** @returns {HookList} */
  list(kind) {
    let l = this.lists.get(kind);
    if (!l) { l = new HookList(kind); this.lists.set(kind, l); }
    return l;
  }

  /** Is any handler registered for this kind? Call sites use it to skip work entirely. */
  has(kind) { const l = this.lists.get(kind); return !!(l && l.items.length); }

  /** How many handlers per kind (diagnostics / manager page). */
  counts() {
    const out = {};
    for (const [kind, l] of this.lists) if (l.items.length) out[kind] = l.items.length;
    return out;
  }

  /** Which package registered what. */
  attribution() {
    const out = {};
    for (const [kind, l] of this.lists) {
      if (!l.items.length) continue;
      out[kind] = l.items.map((r) => r.mod);
    }
    return out;
  }

  /**
   * Register one handler.
   * @param {string} kind one of HOOK_KINDS
   * @param {string} mod the package id (the loader passes `api.mod.id`)
   * @param {Function} fn
   * @param {{ priority?: number }} [opts]
   * @returns {() => void} unregister
   */
  register(kind, mod, fn, { priority = 0 } = {}) {
    if (typeof fn !== 'function') throw new TypeError(`hook "${kind}": handler must be a function`);
    if (!HOOK_KINDS.includes(kind)) {
      // A typo must be loud: a hook nobody calls would otherwise look like "the mod does nothing".
      console.warn(`[mods] unknown hook kind "${kind}" — see docs/API.md (钩子清单); the handler was registered anyway so a newer build can call it`);
    }
    const off = this.list(kind).add(mod, fn, priority);
    let set = this.byMod.get(mod);
    if (!set) { set = []; this.byMod.set(mod, set); }
    const entry = { kind, off };
    set.push(entry);
    return () => {
      off();
      const i = set.indexOf(entry);
      if (i >= 0) set.splice(i, 1);
    };
  }

  /** Drop every handler a package registered (used when a package fails to load or is disabled). */
  dropMod(mod) {
    const set = this.byMod.get(mod);
    if (!set) return 0;
    for (const { off } of set.splice(0)) { try { off(); } catch { /* already gone */ } }
    this.byMod.delete(mod);
    return 1;
  }

  /**
   * Run every handler of `kind` in order, threading a value through.
   *
   * Handlers are called as `fn(value, ctx)`; returning `undefined` or `null` keeps the current value, anything else
   * becomes the new one. `ctx` carries `{ mod, kind, scratch, ...callSite }` and is frozen.
   *
   * @param {string} kind
   * @param {any} value the value the call site wants to offer
   * @param {object} [ctx] call-site data (frozen; `scratch` stays mutable for the chain)
   * @returns {any} the final value
   */
  run(kind, value, ctx = {}) {
    const l = this.lists.get(kind);
    if (!l || !l.items.length) return value;
    const items = l.order();
    const frozen = Object.freeze({ kind, scratch: {}, ...ctx });
    let v = value;
    for (const rec of items) {
      let out;
      try {
        out = rec.fn(v, Object.freeze({ ...frozen, mod: rec.mod }));
      } catch (err) {
        l.report(rec, err);
        this.onError?.(kind, rec.mod, err);
        continue;
      }
      if (out !== undefined && out !== null) v = out;
    }
    return v;
  }

  /**
   * Run handlers for their side effects only (no value threading). Use for "notification" hooks.
   * @param {string} kind @param {object} [data] @returns {number} how many ran
   */
  emit(kind, data = {}) {
    const l = this.lists.get(kind);
    if (!l || !l.items.length) return 0;
    const items = l.order();
    const frozen = Object.freeze({ kind, scratch: {}, ...data });
    let n = 0;
    for (const rec of items) {
      try { rec.fn(Object.freeze({ ...frozen, mod: rec.mod })); n++; } catch (err) { l.report(rec, err); this.onError?.(kind, rec.mod, err); }
    }
    return n;
  }

  /**
   * Ask handlers for a decision; the first non-null answer wins (a cheap "veto / override" chain).
   * @param {string} kind @param {object} [data]
   * @returns {any} the first non-undefined return, else undefined
   */
  first(kind, data = {}) {
    const l = this.lists.get(kind);
    if (!l || !l.items.length) return undefined;
    const items = l.order();
    const frozen = Object.freeze({ kind, scratch: {}, ...data });
    for (const rec of items) {
      let out;
      try { out = rec.fn(Object.freeze({ ...frozen, mod: rec.mod })); } catch (err) { l.report(rec, err); continue; }
      if (out !== undefined && out !== null) return out;
    }
    return undefined;
  }

  /** Every handler's answer, in order (filters out undefined/null). */
  collect(kind, data = {}) {
    const l = this.lists.get(kind);
    if (!l || !l.items.length) return [];
    const out = [];
    const frozen = Object.freeze({ kind, scratch: {}, ...data });
    for (const rec of l.order()) {
      try {
        const v = rec.fn(Object.freeze({ ...frozen, mod: rec.mod }));
        if (v !== undefined && v !== null) out.push({ mod: rec.mod, value: v });
      } catch (err) { l.report(rec, err); }
    }
    return out;
  }
}

/** The process-wide registry. The page has one; the simulation has one; `api.hooks` writes here. */
export const hooks = new HookRegistry({ owner: 'game' });

/** Shorthand used by the game's call sites: `if (hasHooks('field:damageNumber')) …`. */
export const hasHooks = (kind) => hooks.has(kind);
export { noop };
