// public/js/mods/ui.js — the DOM surface handed to mods as `api.ui`.
//
// WHY THIS IS A MODULE AND NOT "just let mods touch the DOM"
//   A mod can always reach `document` — nothing in a browser can stop it. What this surface adds is everything that is
//   easy to get wrong:
//     · SHARED PREACT. `html` / `Button` / `Panel` are re-exported from the game's own components, so a mod's vnodes
//       come from the same Preact instance as the game's. A mod that imports its own copy of Preact (or a second URL of
//       it) breaks hooks with "Cannot read properties of null" in ways that look like the game's fault.
//     · ONE NAMESPACE. Classes must start with `mod-<id>-`, custom properties with `--mod-<id>-`; the game's own
//       stylesheets already own `.btn`, `.panel`, `.pbanner`, … and a collision is invisible until it is ugly.
//     · LAYERS. The overlay levels of the shell (`--z-banner` 40, `--z-modal` 80 …) exist so that a mod's panel does
//       not end up behind the game's own dialogs. `api.ui.layers` hands out the right level.
//     · CLEANUP. Everything `mount()`/`render()`/`css()` creates is returned with a `dispose()`, and the loader drops
//       them when a package fails or is disabled.
//
// The `rem` rule matters too: `html { font-size: clamp(...100vw/19.2...) }` makes 1rem = 100 design px at 1920×1080,
// so a mod that styles in `px` looks right on one screen and wrong on every other. See docs/API.md.

import { html, h, Fragment, Button, Panel, Modal, Icon, MicroLabel } from '../ui/components.js';
import { toast as gameToast } from '../ui/toasts.js';
import { TIMING_KEYS, setTiming, timing, timingBase, timingOverrides, bannerMs, applyBanner, allowBanner } from './timing.js';
import { hooks } from '../../../shared/hooks.js';

/** CSS z-index levels, mirrored from css/theme.css (a mod must sit between the game's own layers). */
const Z = Object.freeze({ banner: 45, hud: 55, overlay: 70, modal: 81, toast: 92 });

/** layer name → where its div goes. Kept in one place so the manager page and the docs can list them. */
export const LAYER_NAMES = Object.freeze(Object.keys(Z));

/** The stylesheet for the layer divs; injected once (self-contained, no package needed). */
const LAYER_CSS = `
.mod-layer { position: fixed; inset: 0; pointer-events: none; }
.mod-layer > * { pointer-events: auto; }
${LAYER_NAMES.map((n) => `.mod-layer--${n} { z-index: ${Z[n]}; }`).join('\n')}
`;

let layerCssOff = null;

/** The shell element mods attach to: `.app-root` when the game has rendered, else `<body>`. */
function shell() {
  return document.querySelector('.app-root') || document.body;
}

/** One layer div per name, created on demand and kept for the life of the page. */
const layers = new Map();
function layerEl(name) {
  const key = LAYER_NAMES.includes(name) ? name : 'hud';
  let el = layers.get(key);
  if (el && el.isConnected) return el;
  if (!layerCssOff) {
    const style = document.createElement('style');
    style.dataset.spModCss = 'sp-mod-layers';
    style.textContent = LAYER_CSS;
    document.head.append(style);
    layerCssOff = () => style.remove();
  }
  el = document.createElement('div');
  el.className = `mod-layer mod-layer--${key}`;
  el.dataset.spModLayer = key;
  shell().append(el);
  layers.set(key, el);
  return el;
}

/** Preact's `render` — imported lazily so a build without the vendor bundle still loads the loader. */
let preactRender = null;
async function renderVnode(vnode, container) {
  if (!preactRender) {
    const mod = await import('preact').catch(() => null);
    preactRender = mod?.render || null;
  }
  if (!preactRender) throw new Error('preact is unavailable in this build');
  preactRender(vnode, container);
  return () => { try { preactRender(null, container); } catch { /* already gone */ } };
}

// ---------------------------------------------------------------------------------------------------------------
// ui:slot — named DOM areas the GAME declares, so a package can rearrange the shell without touching its files
//
// THE PROBLEM THIS SOLVES
//   "Put the loadout screen's action bar under the detail card, and hide its title row" is a LAYOUT request against
//   markup the package does not own. A package used to have two options: edit the game's own JSX (what this project's
//   first design rule forbids), or query the DOM by hand and re-assert it against every re-render (what the PRTS
//   package did first — and it broke twice: Preact rebuilds the nodes, and the re-assert interval fought the user's Esc).
//
// THE CONTRACT
//   · The GAME (or a loader patch) marks an element with `data-prts-slot="<name>"` — that is the seam, and it is the
//     only thing that has to live in the game's files.
//   · The loader puts a hidden placeholder `<span>` inside it (so "before / after the seam" stays a layout question
//     instead of a child-index guess) and registers the name as a `ui:slot` handler.
//   · A package asks the loader to LAYOUT things: `api.ui.slots.assign('loadout.actions', el)`,
//     `slots.before('…', el)`, `slots.after('…', el)`, `slots.hide(el)`.
//   · The loader reconciles on a throttled tick: if Preact rebuilds the seam the moved node is detached and the
//     action runs again on the fresh element; if the game destroys the SOURCE element the moved node is put back
//     where it came from. A package never has to know when to re-assert, and Esc/story flow is never fought over.

/** How often a layout action re-checks itself while the page is visible. */
const SLOT_TICK_MS = 250;
/** Packages that asked for layout — the tick only runs while this is non-empty. */
const slotOwners = new Set();
let slotTimer = null;

/** The placeholder's data attribute (also how `discoverSlots` finds an existing one). */
const SLOT_PH_ATTR = 'prtsSlotPh';

/** Every `data-prts-slot` marker currently in the document, as `{ name, host, ph }` (creating the placeholder). */
function discoverSlots() {
  const out = [];
  for (const host of document.querySelectorAll('[data-prts-slot]')) {
    const name = host.getAttribute('data-prts-slot');
    if (!name) continue;
    let ph = [...host.children].find((c) => c.dataset && c.dataset[SLOT_PH_ATTR] === name);
    if (!ph) {
      ph = document.createElement('span');
      ph.dataset[SLOT_PH_ATTR] = name;
      ph.setAttribute('aria-hidden', 'true');
      ph.style.cssText = 'display:none!important';
      host.prepend(ph);
    }
    out.push({ name, host, ph });
  }
  return out;
}

/** The seam a name refers to right now (null while the host screen is not mounted). */
function findSlot(name) {
  return discoverSlots().find((s) => s.name === name) || null;
}

/** Run reconcile on every tick while at least one package is using slots. */
function scheduleSlotTick() {
  if (slotTimer != null || slotOwners.size === 0) return;
  slotTimer = setTimeout(() => {
    slotTimer = null;
    for (const owner of [...slotOwners]) {
      try { owner.reconcile(); } catch (err) { console.warn('[mods] ui:slot reconcile failed', err); }
    }
    scheduleSlotTick();
  }, SLOT_TICK_MS);
}

// ---------------------------------------------------------------------------------------------------------------
// 隐藏：为什么要单独一套"每帧"的机制
//
// `slots.hide(el)` 的意图是"这个东西别出现"。如果只在 250ms 的对账节拍里给它打属性，那么宿主把它渲染出来的
// 那一刻到下一个节拍之间（最长 250ms）它是**可见的** —— 用户看到的就是"抬头闪一下"（实测就是这个）。
// 所以隐藏走两条腿：
//   · 触发时立刻打属性（同一次任务里，浏览器还没绘制，不会闪）；
//   · 只要还有 hide 待命，就每帧（rAF）重新查一遍并补打 —— 宿主晚一点才渲染、或把节点重建掉，都会在**绘制之前**
//     被补上，而不是等下一个 250ms 节拍。布局类动作（搬进接缝）仍然走 250ms 那一套，不需要这么急。
/** Selectors with an active `hide()` — re-checked every animation frame. */
const pendingHides = new Set();
/**
 * Declarative hides (`slots.hideWhen`): a predicate says "while this is true, hide what matches".
 * They exist because `hide(el)` can only start working once the element exists — and by then the host may already
 * have painted it (that is the "抬头闪一下": the original screen's title row showed for one or two frames before the
 * loader's pass hid it). A predicate can be declared ONCE, long before the screen mounts, and then the per-frame pass
 * below hides each matching element in the same frame it appears — before anything is drawn.
 * @type {Set<{ sel: string, when: () => boolean, mod: string }>}
 */
const hideWhenRules = new Set();
let hideFrame = null;

/** Apply `data-prts-hidden` to everything matching a pending hide selector (see sp-mods-slots.css). */
function applyPendingHides() {
  hideFrame = null;
  if (hideWhenRules.size === 0 && pendingHides.size === 0) return;
  for (const sel of pendingHides) {
    let list;
    try { list = document.querySelectorAll(sel); } catch { continue; }
    for (const el of list) if (!el.dataset.prtsHidden) el.dataset.prtsHidden = '';
  }
  for (const rule of hideWhenRules) {
    let on = false;
    try { on = !!rule.when(); } catch (err) { console.warn(`[mod:${rule.mod}] ui:slot hideWhen predicate threw`, err); continue; }
    if (!on) continue;
    let list;
    try { list = document.querySelectorAll(rule.sel); } catch { continue; }
    for (const el of list) if (!el.dataset.prtsHidden) el.dataset.prtsHidden = '';
  }
  if (hideWhenRules.size || pendingHides.size) scheduleHideFrame();
  hideObserverTick();
}

function scheduleHideFrame() {
  if (hideFrame != null) return;
  if (hideWhenRules.size === 0 && pendingHides.size === 0) return;
  if (typeof requestAnimationFrame === 'function') hideFrame = requestAnimationFrame(applyPendingHides);
  else hideFrame = setTimeout(applyPendingHides, 60);
}

/**
 * 插入即隐藏：`MutationObserver` 的回调在"产生这些改动的那次任务"收尾的微任务检查点上跑 ——
 * 也就是**浏览器绘制之前**。所以宿主刚把节点插进 DOM，它就已经带上 `data-prts-hidden` 了，一帧都来不及画。
 * （只用 rAF 的话会漏掉一帧：插入发生在本帧回调之后，属性要到下一帧回调才打上。）
 * 观察范围是整棵文档，所以只在"还有 hide 待命且条件成立"时开着 —— 关掉即零开销。
 */
let hideObserver = null;
function hideWatchActive() {
  for (const rule of hideWhenRules) { try { if (rule.when()) return true; } catch { /* 谓词抛错就当作不成立 */ } }
  return pendingHides.size > 0;
}
function hideObserverTick() {
  const want = hideWatchActive();
  if (want && !hideObserver && typeof MutationObserver === 'function') {
    hideObserver = new MutationObserver(() => { applyPendingHides(); });
    hideObserver.observe(document.documentElement, { childList: true, subtree: true });
  } else if (!want && hideObserver) {
    hideObserver.disconnect();
    hideObserver = null;
  }
}

/** Stop the per-frame pass (no hide left to keep true). */
function stopHideFrame() {
  if (hideFrame == null) return;
  if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(hideFrame);
  else clearTimeout(hideFrame);
  hideFrame = null;
}

/** A stable selector for an element, used to re-find it after the host rebuilds it. */
function selectorForSlot(el) {
  if (el.dataset.prtsHideSelector) return el.dataset.prtsHideSelector;
  let sel = null;
  if (el.id && /^[A-Za-z][-\w]*$/.test(el.id)) sel = `#${el.id}`;
  else if (el.dataset.prtsSlot && el.classList.length) sel = `${el.tagName.toLowerCase()}[data-prts-slot="${el.dataset.prtsSlot}"]`;
  // the last resort: the element's own tag + first two classes, qualified by the seam it lives in
  if (!sel) {
    const cls = [...el.classList].slice(0, 2).map((c) => `.${CSS.escape(c)}`).join('');
    const seam = el.closest('[data-prts-slot]');
    sel = cls ? `${seam ? `[data-prts-slot="${seam.dataset.prtsSlot}"] ` : ''}${el.tagName.toLowerCase()}${cls}` : null;
  }
  if (sel) el.dataset.prtsHideSelector = sel;
  return sel;
}

/** Inject one stylesheet (inline text or a `<link>` to a file in the package). */
function addStyle({ cssText = null, href = null, id = null, mod = 'anonymous' }) {
  const key = `sp-mod-css:${id || mod}`;
  const prev = document.querySelector(`[data-sp-mod-css="${CSS.escape(key)}"]`);
  if (prev) prev.remove();
  let el;
  if (href) {
    el = document.createElement('link');
    el.rel = 'stylesheet';
    el.href = href;
  } else {
    el = document.createElement('style');
    el.textContent = String(cssText || '');
  }
  el.dataset.spModCss = key;
  el.dataset.spModId = mod;
  document.head.append(el);
  return () => el.remove();
}

/**
 * Build the UI surface for one package.
 * @param {object} rec the `/api/mods` record
 * @returns {object} `api.ui`
 */
export function makeUi(rec) {
  const modId = rec.id;
  const prefix = `mod-${modId}-`;
  /** Everything this package created, removed in one go when it is dropped. */
  const created = [];
  /** `PhaseBanner` is loaded with the rest of the game's components, on first use, so the loader's own import graph
   *  stays small (and a build without the shell still loads). */
  let bannerComponent = null;
  import('../ui/components.js').then((c) => { bannerComponent = c.PhaseBanner; }).catch(() => {});

  // ---- layout actions (see the ui:slot block above) ----------------------------------------------------------
  /** One entry per move/hide, re-checked by `reconcile` on the throttled tick. */
  const slotActions = [];
  /** Original location of every element we moved or hid, so it can be put back exactly once. */
  const slotOriginals = new Map();
  const slotUsage = new Map();   // slot name → Set of mod ids that touched it
  /** This package's hide selectors (per-frame pass) — cleared on restore. */
  const slotHideSelectors = new Set();
  /** This package's declarative hides (`hideWhen`) — cleared on restore. */
  const hideWhenOwners = new Set();

  /** Where an element came from, and how it looked (for `hide`). */
  function rememberOrigin(el) {
    let rec = slotOriginals.get(el);
    if (!rec) {
      rec = { parent: el.parentElement, next: el.nextElementSibling, display: null };
      slotOriginals.set(el, rec);
    }
    return rec;
  }

  /** True while the element is still part of the live page. */
  const inDocument = (el) => !!(el && el.isConnected);

  /**
   * Run one action: figure out its seam, and (re)place the elements if they are not where they belong.
   * Everything here is defensive: a host screen that is not mounted, a seam that was rebuilt, or a source element
   * the game destroyed are all normal, not errors.
   * @returns {boolean} whether this action is currently satisfied
   */
  function runSlotAction(a) {
    if (a.kind === 'hide') {
      const el = a.el;
      if (!inDocument(el)) return false;
      if (a.rec.display == null) a.rec.display = el.style.display || '';
      // ① 属性 = 真正生效的那一半（`[data-prts-hidden] { display: none !important }` 在 sp-mods-slots.css 里）。
      //    打上它的那一刻元素就已经不显示了 —— 不会出现"宿主先画出来、脚本再藏掉"的那一帧（"抬头闪一下"）。
      // ② 内联样式跟着写：不依赖那张样式表也能藏住。
      el.dataset.prtsHidden = '';
      el.style.display = 'none';
      // ③ 把它交给每帧那一遍：宿主以后重建出同名的元素，也会在**绘制之前**被补上属性。
      const sel = selectorForSlot(el);
      if (sel) { pendingHides.add(sel); slotHideSelectors.add(sel); scheduleHideFrame(); }
      return el.style.display === 'none';
    }
    // move / before / after: the SOURCE has to exist, the SEAM has to be on page
    const el = a.el;
    if (!inDocument(el)) return false;
    const slot = findSlot(a.slot);
    if (!slot) return false;
    const anchor = a.kind === 'before' ? slot.ph : a.kind === 'after' ? slot.ph.nextElementSibling : null;
    const already = el.parentElement === slot.host && (a.kind === 'move' || el.previousElementSibling === anchor);
    if (already) return true;
    if (!a.moved) { rememberOrigin(el); a.moved = true; }
    if (a.kind === 'before') slot.host.insertBefore(el, slot.ph);
    else if (a.kind === 'after') slot.host.insertBefore(el, slot.ph.nextElementSibling);
    else slot.host.appendChild(el);
    return true;
  }

  /** The throttle tick: re-assert every action of this package (registered while it has any). */
  function reconcileSlots() {
    for (let i = slotActions.length - 1; i >= 0; i--) {
      const a = slotActions[i];
      try { runSlotAction(a); } catch (err) { console.warn(`[mod:${modId}] ui:slot action failed`, err); }
    }
    // nothing to do any more (all sources gone or the screen left): stop ticking, and clean up on the next mount
    if (slotActions.length === 0) { slotOwners.delete(owner); }
  }
  const owner = { reconcile: reconcileSlots };

  /** Put every moved/hidden element back where it came from (package unloaded, or `slots.restore()`). */
  function restoreSlots() {
    for (const a of slotActions.slice()) {
      const el = a.el;
      if (!el) continue;
      const rec = slotOriginals.get(el);
      if (rec) {
        if (rec.display != null) el.style.display = rec.display;
        // 隐藏是"属性 + 内联样式"两半，还原也要两半（属性留着的话 `[data-prts-hidden]` 会继续藏着它）
        delete el.dataset.prtsHidden;
        // a source element the game destroyed cannot be put back — skip it
        if (inDocument(el)) {
          if (rec.next && rec.next.parentElement === rec.parent) rec.parent.insertBefore(el, rec.next);
          else if (rec.parent) rec.parent.appendChild(el);
        }
        slotOriginals.delete(el);
      }
    }
    // 每帧那一遍也要停：它按选择器打属性，而选择器命中的可能已经不是我们搬过的那一个元素了
    if (slotHideSelectors.size) {
      for (const sel of slotHideSelectors) {
        pendingHides.delete(sel);
        let list = [];
        try { list = document.querySelectorAll(sel); } catch { /* selector gone */ }
        for (const el of list) delete el.dataset.prtsHidden;
      }
      slotHideSelectors.clear();
    }
    // 声明式隐藏：取消声明，并把已经打上的属性摘掉（否则 `[data-prts-hidden]` 会一直藏着它们）
    for (const rule of hideWhenOwners) {
      hideWhenRules.delete(rule);
      let list = [];
      try { list = document.querySelectorAll(rule.sel); } catch { /* selector gone */ }
      for (const el of list) delete el.dataset.prtsHidden;
    }
    hideWhenOwners.clear();
    if (pendingHides.size === 0) stopHideFrame();
    hideObserverTick();
    slotActions.length = 0;
    slotUsage.clear();
    slotOwners.delete(owner);
  }

  /** Register one action for `name` and take the first shot at it immediately. */
  function addSlotAction(kind, name, el, { into = null } = {}) {
    if (!(el instanceof Element)) throw new TypeError(`api.ui.slots.${kind} expects an Element`);
    if (kind !== 'hide' && (!name || typeof name !== 'string')) throw new TypeError('this slot call needs a slot name (see api.ui.slots.list())');
    if (!slotUsage.has(name || '(hide)')) slotUsage.set(name || '(hide)', new Set());
    slotUsage.get(name || '(hide)').add(modId);
    const rec = slotActions.find((a) => a.el === el && a.kind === kind && a.slot === name);
    if (rec) { runSlotAction(rec); slotOwners.add(owner); scheduleSlotTick(); return rec; }
    const action = { kind, slot: name, el, into, moved: false, rec: rememberOrigin(el) };
    slotActions.push(action);
    slotOwners.add(owner);
    scheduleSlotTick();
    return action;
  }

  const slotsApi = Object.freeze({
    /** Every seam this build declares, with the packages that used each one. */
    list() {
      const used = new Map([...slotUsage].map(([k, set]) => [k, [...set]]));
      return discoverSlots().map((s) => ({ name: s.name, host: s.host, owners: used.get(s.name) || [] }));
    },
    /** Is there a seam with this name on the page right now? */
    has(name) { return !!findSlot(name); },
    /** Move `el` into the seam `name` (kept inside it as its last child). */
    assign(name, el) { return addSlotAction('move', name, el); },
    /** Put `el` at the seam's own position — before the seam's marker element. */
    before(name, el) { return addSlotAction('before', name, el); },
    /** Put `el` right after the seam's marker element. */
    after(name, el) { return addSlotAction('after', name, el); },
    /** Hide `el` (the loader remembers its inline `display` and restores it on unload / `restore`). */
    hide(el) { return addSlotAction('hide', null, el); },
    /**
     * 声明式隐藏：**只要 `when()` 为真，就把选择器 `sel` 命中的元素藏起来**（每帧检查，元素出现的那一帧就被打上
     * `data-prts-hidden`，所以在宿主把它画出来之前就已经不显示了）。
     *
     * 什么时候用它而不是 `hide(el)`：`hide(el)` 必须等元素存在才能登记，而宿主可能在登记之前就已经画了一帧 ——
     * 那一帧就是用户看到的"闪一下"。声明可以在**界面还没挂上**的时候就登记好（例如包的 `install()` 里），
     * 之后每次出现都能被同一帧拦下。
     *
     * @param {string} sel CSS 选择器（只管这个包自己的意图；多个包各自登记、互不影响）
     * @param {() => boolean} when 什么时候该藏（每帧调用，务必轻量：判断一个 class / 一个 store 字段即可）
     * @returns {{ off: () => void }} 取消这条声明
     */
    hideWhen(sel, when) {
      if (typeof sel !== 'string' || !sel) throw new TypeError('api.ui.slots.hideWhen(selector, when) needs a selector');
      if (typeof when !== 'function') throw new TypeError('api.ui.slots.hideWhen(selector, when) needs a predicate');
      const rule = { sel, when, mod: modId };
      hideWhenRules.add(rule);
      hideWhenOwners.add(rule);
      scheduleHideFrame();
      hideObserverTick();
      return { off: () => { hideWhenRules.delete(rule); hideWhenOwners.delete(rule); if (!hideWhenRules.size && !pendingHides.size) stopHideFrame(); hideObserverTick(); } };
    },
    /** Undo everything this package did to the shell layout. */
    restore() { restoreSlots(); return true; },
  });

  const ui = {
    // ---- components (the game's own, so the look and the Preact instance match) --------------------------------
    html, h, Fragment,
    Button, Panel, Modal, Icon, MicroLabel,
    /** Load the game's component modules on demand (keeps the loader's own import graph small). */
    async components() {
      const [c, g] = await Promise.all([
        import('../ui/components.js'),
        import('../ui/gameComponents.js').catch(() => null),
      ]);
      return { ...c, ...(g || {}) };
    },
    /** The mandatory class prefix for this package: `mod-<id>-`. */
    prefix,
    /** `ui.cls('btn')` → `mod-my-mod-btn` (and `ui.cls('btn', 'on')` → `mod-my-mod-btn mod-my-mod-btn--on`). */
    cls(name, modifier = null) {
      const base = `${prefix}${String(name).replace(/^[-_]+/, '')}`;
      return modifier ? `${base} ${base}--${modifier}` : base;
    },

    // ---- layers ------------------------------------------------------------------------------------------------
    get layers() { return Object.freeze(Object.fromEntries(LAYER_NAMES.map((n) => [n, layerEl(n)]))); },
    /** The element a mod should attach to when it wants to follow the game's own layout. */
    get shell() { return shell(); },

    // ---- mount / unmount ---------------------------------------------------------------------------------------
    /**
     * Attach an existing element to a layer.
     * @param {HTMLElement} el @param {string} [layer]
     * @returns {{ el: HTMLElement, dispose: () => void }}
     */
    mount(el, layer = 'hud') {
      if (!(el instanceof Element)) throw new TypeError('api.ui.mount expects an Element (use render() for vnodes)');
      layerEl(layer).append(el);
      const dispose = () => el.remove();
      created.push(dispose);
      return { el, dispose };
    },
    /**
     * Render a Preact vnode into its own container in a layer.
     * @param {any} vnode @param {string} [layer]
     * @returns {Promise<{ el: HTMLElement, dispose: () => void }>}
     */
    async render(vnode, layer = 'hud') {
      const host = document.createElement('div');
      host.className = `${prefix}host`;
      layerEl(layer).append(host);
      const off = await renderVnode(vnode, host);
      const dispose = () => { off(); host.remove(); };
      created.push(dispose);
      return { el: host, dispose };
    },

    // ---- styles ------------------------------------------------------------------------------------------------
    /** Inline CSS: `api.ui.style('my-thing { color: red }')`. */
    style(cssText, { id = null } = {}) {
      const off = addStyle({ cssText, id: id || `${modId}:inline`, mod: modId });
      created.push(off);
      return off;
    },
    /** A stylesheet shipped inside the package: `api.ui.css('theme.css')`. */
    css(file, { id = null } = {}) {
      const off = addStyle({ href: `${rec.url}${String(file).replace(/^\/+/, '')}`, id: id || `${modId}:${file}`, mod: modId });
      created.push(off);
      return off;
    },

    // ---- layout seams (ui:slot) ---------------------------------------------------------------------------------
    /**
     * The named DOM areas the game declares (`<div data-prts-slot="name">`) — the layout seams of this build.
     * An empty array means "this build has no such seam".
     * @returns {Array<{ name: string, owners: string[], host: HTMLElement }>}
     */
    get slots() { return slotsApi; },

    // ---- game-native notifications -----------------------------------------------------------------------------
    /** The game's own toast (`ui/toasts.js`). */
    toast: (text, kind = 'info', opts = {}) => gameToast(text, kind, opts),

    // ---- banners -----------------------------------------------------------------------------------------------
    banner: {
      /** `/js/ui/components.js PhaseBanner` (loaded on first use) — a mod may show its own banner. */
      Component: (props) => (bannerComponent ? bannerComponent(props) : null),
      /** The default stay for banners whose call site does not say (`banner.defaultMs`). */
      get defaultMs() { return timing('banner.defaultMs'); },
      setDefaultMs(ms) { setTiming('banner.defaultMs', ms, { mod: modId }); },
      /** Restyle/retime every banner through the `ui:banner` hook (see timing.js). */
      onBanner(fn, { priority = 0 } = {}) {
        const off = hooks.register('ui:banner', modId, fn, { priority });
        created.push(off);
        return off;
      },
      /** How long a specific banner will stay (the same query the game asks). */
      msFor: (info) => bannerMs(info),
    },

    // ---- timing table ------------------------------------------------------------------------------------------
    /** Write a published timing/figure key; unknown keys are refused (returns false). */
    setTiming(key, value) { return setTiming(key, value, { mod: modId }); },
    getTiming: (key) => timing(key),
    /** The shipped value of a key, so a mod can scale relative to it instead of hard-coding. */
    baseTiming: (key) => timingBase(key),
    timingKeys: TIMING_KEYS,
    timingOverrides,

    // ---- cleanup -----------------------------------------------------------------------------------------------
    /** Drop everything this package created through `api.ui` (the loader calls it when a package fails). */
    dispose() {
      try { restoreSlots(); } catch { /* the shell may be gone already */ }
      for (const off of created.splice(0)) { try { off(); } catch { /* already gone */ } }
    },
    _created: created,
  };
  return Object.freeze(ui);
}

export { applyBanner, allowBanner, bannerMs, hooks };
