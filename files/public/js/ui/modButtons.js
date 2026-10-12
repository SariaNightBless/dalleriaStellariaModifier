// public/js/ui/modButtons.js — the `ui:button` call site: buttons a MOD contributes to a host of the game's own UI.
//
// WHY THIS FILE EXISTS
//   `ui:button` used to be a name with no caller (docs/API.md called it 已声明，本版本无调用点), so a package that wanted
//   a button next to 玩法说明 had exactly one option: reach into the DOM itself (`document.querySelector('.topbar__right')`
//   + a MutationObserver, because Preact re-renders the bar). That worked, but it is the kind of code that breaks on the
//   next UI reshuffle and that nobody can find by grepping for the hook name. A host that asks for buttons instead means:
//
//     · the package only describes a button (label / icon / what it does), never where it goes;
//     · the host owns the markup, so a contributed button looks like the game's own buttons (it IS `<Button>`);
//     · unloading a package takes its button away with it (the loader bumps its revision, this re-renders).
//
// WHAT A HANDLER RETURNS (one descriptor per contributed button; `undefined`/`null` contributes nothing):
//
//     api.hooks.register('ui:button', (value, ctx) => {
//       if (ctx.slot !== 'lobby.topbar') return undefined;      // only the host I want
//       return { id: 'prts', label: 'PRTS', icon: 'book', title: '打开图鉴',
//                variant: 'secondary', size: 'sm', class: 'my-mod-btn', onClick: () => openMyThing() };
//     });
//
//   | field     | meaning                                                                            |
//   |---|---|
//   | `id`      | stable key (two buttons of one package cannot share it); defaults to the package id |
//   | `label`   | the button's text                                                                  |
//   | `icon`    | one of the game's icon names (`js/ui/components.js` ICONS: book, grid, search, …)   |
//   | `img`     | an image URL for the icon slot instead of `icon` (a package's own PNG, a data URI)   |
//   | `title`   | tooltip / `aria-label`                                                             |
//   | `variant` | the game's button variants: `primary` `secondary` `ghost` `amber` `ice` `danger`    |
//   | `size`    | `sm` `md` `lg` `xl`                                                                 |
//   | `class`   | extra classes (keep your `mod-<id>-` prefix; the host adds its own too)             |
//   | `onClick` | called with the click event                                                        |
//   | `element` | build the whole button yourself (you style it; the host still owns placement)       |
//
//   The descriptor is PLAIN DATA on purpose: no vnodes, no HTML string. A host that wants the game's own look for a
//   package's own artwork gets it through `img` (plus `class` for its own CSS); a package that needs something the
//   fields cannot express hands in `element` and keeps the responsibility for how it looks.
//   Placeholders (`${…}`) inside `label` / `title` are NOT expanded — re-register for live text, or use `element`.
//   A descriptor that is not an object is ignored with one warning per package.
//
// THE SLOTS THAT EXIST TODAY
//   · `lobby.topbar`   — the right side of 选择模拟协议's top bar (`/js/screens/lobby.js`), next to 玩法说明.
//   · `title.actions`  — the row under 开始 on the title screen (`/js/screens/title.js`), next to 模组 / 玩法说明.
//     A screen that grows a host should call `run('ui:button', [], { slot: '…' })` the same way and document the name here.

import { html, Button } from './components.js';
import { useEffect, useState } from '../../vendor/hooks.module.js';
import { hooks } from '../../../shared/hooks.js';
import { modsRevision, onModsChanged } from '../mods.js';

/** Variants / sizes a contributed button may ask for; anything else falls back to the host's default. */
const VARIANTS = new Set(['primary', 'secondary', 'ghost', 'amber', 'ice', 'danger']);
const SIZES = new Set(['sm', 'md', 'lg', 'xl']);

const warned = new Set();

/**
 * The buttons the packages contribute to one slot, in the registry's deterministic order (priority desc, mod id asc).
 * Call it during a render — `collect` is a cheap loop and returns [] when nobody registered.
 * @param {string} slot e.g. 'lobby.topbar'
 * @returns {Array<{ mod: string, value: any }>}
 */
export function modButtons(slot) {
  if (!hooks.has('ui:button')) return [];
  let out = [];
  try {
    out = hooks.collect('ui:button', { slot });
  } catch (err) {
    console.warn('[mods] ui:button collection failed', err);
    return [];
  }
  return out.filter((entry) => {
    if (entry && entry.value && typeof entry.value === 'object') return true;
    const mod = entry?.mod || 'anonymous';
    if (!warned.has(mod)) {
      warned.add(mod);
      console.warn(`[mods] ui:button handler of "${mod}" returned ${entry?.value === null ? 'null' : typeof entry?.value} — `
        + 'expected a descriptor object { id?, label?, icon?, title?, variant?, size?, class?, onClick?, element? }');
    }
    return false;
  });
}

/** How many buttons a slot has (for a host that only wants to know whether to render its container). */
export const hasModButtons = (slot) => modButtons(slot).length > 0;

/**
 * One contributed button: the game's own `<Button>` unless the package handed in an element.
 *
 * The icon and the label are built HERE, not handed in as vnodes: a `Button` whose child came from the package's own
 * module rendered an empty button (measured), while a host-built children array — the same shape `components.test`/the
 * game's own buttons use — renders every time. So the descriptor stays plain data and the host owns the markup.
 */
function ModButton({ entry, hostClass, size, variant }) {
  const d = entry.value;
  const key = `${entry.mod}:${typeof d.id === 'string' && d.id ? d.id : 'main'}`;
  const cls = `mod-btn ${hostClass || ''} ${typeof d.class === 'string' ? d.class : ''}`.trim();
  if (d.element && typeof d.element === 'object' && d.element.nodeType === 1) {
    // An element the package built itself: the host still owns where it sits and when it goes away.
    return html`<span key=${key} class=${cls} ref=${(el) => { if (el && !el.contains(d.element)) el.appendChild(d.element); }}></span>`;
  }
  const img = typeof d.img === 'string' && d.img ? d.img : null;
  return html`<${Button} key=${key}
    variant=${VARIANTS.has(d.variant) ? d.variant : variant}
    size=${SIZES.has(d.size) ? d.size : size}
    icon=${!img && typeof d.icon === 'string' && d.icon ? d.icon : undefined}
    title=${typeof d.title === 'string' && d.title ? d.title : undefined}
    class=${cls}
    data-mod-btn=${entry.mod}
    onClick=${typeof d.onClick === 'function' ? d.onClick : undefined}
  >
    ${img ? html`<img key="img" class="btn__icon mod-btn__img" src=${img} alt="" draggable=${false} loading="lazy" />` : null}
    ${d.label == null ? null : html`<span key="label" class="btn__label">${String(d.label)}</span>`}
  <//>`;
}

/**
 * Every button the packages contribute to `slot` — render this inside the host it belongs to.
 *
 * @param {{ slot: string, class?: string, size?: 'sm'|'md'|'lg'|'xl', variant?: string }} props
 *   `class` is added to each contributed button (the host's own layout class, e.g. `lobby-modbtn`)
 */
export function ModButtons({ slot, class: hostClass = '', size = 'sm', variant = 'secondary' }) {
  const [, setVersion] = useState(modsRevision());
  useEffect(() => {
    // A package that registers (or is unloaded) after this render still lands: the loader bumps its revision.
    const off = onModsChanged((v) => setVersion(v));
    setVersion(modsRevision());   // catch anything that happened between render and effect
    return off;
  }, []);
  if (!slot) return null;
  const list = modButtons(slot);
  if (!list.length) return null;
  return list.map((entry) => html`<${ModButton} key=${`${entry.mod}:${entry.value?.id || 'main'}`} entry=${entry} hostClass=${hostClass} size=${size} variant=${variant} />`);
}
