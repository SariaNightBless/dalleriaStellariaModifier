// server/match/botlogic.js — the **prep-side (AI 决策) hook registry** (sp-mods).
//
// WHY THIS FILE EXISTS
//   `server/sim/modlogic.js` is the *battle* seam: it lets a package change what happens inside a fight. It cannot
//   change what the built-in AI **decides** during the prep (which strategy it picks, what it buys, how it levels, how
//   it re-ranks a lineup, which layout it rehearses). Those decisions live in `server/match/bot.js`, and this file is
//   the guarded door into them: `bot.js` asks `botBoost(kind, value, ctx)` at each decision point, and the shipped
//   value comes back unchanged when no package registered anything.
//
// THE HOOKS (all VALUE hooks: `(value, ctx) → value`, `undefined`/`null` keeps the current value)
//
//   bot:params          (params, ctx)        → a plain object of policy knobs (see botParam below)
//   bot:bandWeights     (weights[], ctx)     → the draw weights of the offered strategies (botPickBand)
//   bot:cardScore       (score, ctx)         → the score of one 机变 card (botPickCard)
//   bot:bondPlan        ({focus, second})    → the盟约 the bot builds around (bondPlan)
//   bot:buyScore        (score, ctx)         → the score of acquiring one copy of chess `id` (buyScore)
//   bot:refreshValue    (value, ctx)         → the expected value of one shop refresh (refreshValue)
//   bot:lineupScore     (score, ctx)         → the score of one deployed set (lineupScore)
//   bot:layoutParams    (params, ctx)        → the exposure model's tunables for this round (planLayout)
//   bot:rehearsal       ({variants, count})  → the layout candidates the rehearsal compares
//
// `ctx` always carries `{ m, ps, mod }` plus whatever that decision point knows (`id`, `card`, `ctx`, `set`, `chosen`…).
//
// THE POLICY KNOBS (`botParam(name, fallback)`, answered by `bot:params`)
//   mergeHit pairHit maxRefreshes buyFullMin levelTarget   —— 每个都对应 bot.js 里同名的出厂常量
//
// DETERMINISM
//   A bot is part of the match: its decisions consume `m.rngBots()` and every peer (and the server's audit) expects the
//   same decisions from the same seed. So a handler must NOT call `Math.random()` / `Date.now()` and must NOT draw from
//   `m.rngBots()` — the same rules the battle seam states. Iterate the game's own arrays; their order is stable.
//   A handler that throws is reported once and skipped (the shipped decision stands).

/** Hook kinds this registry serves (kept in sync with `shared/hooks.js` by name only). */
export const BOT_HOOKS = Object.freeze([
  'bot:params', 'bot:bandWeights', 'bot:cardScore', 'bot:bondPlan', 'bot:buyScore',
  'bot:refreshValue', 'bot:lineupScore', 'bot:layoutParams', 'bot:rehearsal',
]);

const noopLogger = { warn() {}, error() {} };

class BotHookList {
  constructor(kind) {
    this.kind = kind;
    this.items = [];
    this.sorted = true;
    this.seq = 0;
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
      // priority desc, then owner id, then registration: the same order in every process and every run
      this.items.sort((a, b) => (b.priority - a.priority) || (a.owner < b.owner ? -1 : a.owner > b.owner ? 1 : 0) || (a.seq - b.seq));
      this.sorted = true;
    }
    return this.items;
  }
}

/** The registry. One instance per process (the server's). */
export class BotLogic {
  constructor({ logger = noopLogger } = {}) {
    /** @type {Map<string, BotHookList>} */
    this.lists = new Map();
    this.logger = logger;
    this.byOwner = new Map();
    this.paramsVersion = 0;
    this._params = null;
    this._paramsAt = -1;
  }
  list(kind) {
    let l = this.lists.get(kind);
    if (!l) { l = new BotHookList(kind); this.lists.set(kind, l); }
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
    if (typeof fn !== 'function') throw new TypeError(`bot hook "${kind}": handler must be a function`);
    if (!BOT_HOOKS.includes(kind)) {
      console.warn(`[mods] unknown bot hook "${kind}" — see docs/API.md (AI 决策接缝); registered anyway so a newer build can call it`);
    }
    const off = this.list(kind).add(owner, fn, priority);
    let set = this.byOwner.get(owner);
    if (!set) { set = []; this.byOwner.set(owner, set); }
    set.push(off);
    this.paramsVersion++;
    return () => { off(); this.paramsVersion++; const i = set.indexOf(off); if (i >= 0) set.splice(i, 1); };
  }

  /** Drop everything one package registered. */
  dropOwner(owner) {
    const set = this.byOwner.get(owner);
    if (!set) return 0;
    for (const off of set.splice(0)) { try { off(); } catch { /* already gone */ } }
    this.byOwner.delete(owner);
    this.paramsVersion++;
    return 1;
  }

  /** Run a value hook: each handler gets `(value, ctx)`; a throw is reported once and skipped. */
  run(kind, value, ctx = {}) {
    const l = this.lists.get(kind);
    if (!l || !l.items.length) return value;
    let v = value;
    for (const rec of l.order()) {
      let out;
      try { out = rec.fn(v, Object.freeze({ kind, ...ctx, mod: rec.owner })); }
      catch (err) { this._report(l, rec, err); continue; }
      if (out !== undefined && out !== null) v = out;
    }
    return v;
  }

  /**
   * The merged policy knobs: every `bot:params` handler returns a partial object and they are shallow-merged in hook
   * order (later handlers win). Cached until a package registers or unregisters.
   */
  params() {
    if (this._params && this._paramsAt === this.paramsVersion) return this._params;
    let out = {};
    const l = this.lists.get('bot:params');
    if (l && l.items.length) {
      for (const rec of l.order()) {
        let part;
        try { part = rec.fn(null, Object.freeze({ kind: 'bot:params', mod: rec.owner })); }
        catch (err) { this._report(l, rec, err); continue; }
        if (part && typeof part === 'object' && !Array.isArray(part)) out = { ...out, ...part };
      }
    }
    this._params = out;
    this._paramsAt = this.paramsVersion;
    return out;
  }

  _report(l, rec, err) {
    const key = `${l.kind}:${rec.owner}:${rec.fn?.name || 'fn'}`;
    if (l.reported.has(key)) return;
    l.reported.add(key);
    this.logger.warn?.(`[mods] bot hook "${l.kind}" of "${rec.owner}" threw — skipped from now on`, err);
  }
}

/** The process-wide registry the patched `server/match/bot.js` reads. */
export const botLogic = new BotLogic({ logger: console });

/** Register one handler: `(kind, owner, fn, opts) → off`. Used by the loader when it installs a package. */
export const registerBotLogic = (kind, owner, fn, opts) => botLogic.register(kind, owner, fn, opts);

/** Shorthand for the patched call sites: `if (botHas('…'))` keeps the no-mod path free. */
export const botHas = (kind) => botLogic.has(kind);

/** Value threading for the patched call sites. */
export const botBoost = (kind, value, ctx) => botLogic.run(kind, value, ctx);

/**
 * A policy knob: the package's answer when it gave one, the shipped constant otherwise.
 * @template T @param {string} name @param {T} fallback @returns {T}
 */
export function botParam(name, fallback) {
  if (!botLogic.has('bot:params')) return fallback;
  const p = botLogic.params();
  const v = p ? p[name] : undefined;
  return v === undefined || v === null ? fallback : v;
}

/** Diagnostics: which packages contributed decisions. */
export const botLogicCounts = () => botLogic.counts();
export const botLogicOwners = () => botLogic.owners();
