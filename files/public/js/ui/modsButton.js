// public/js/ui/modsButton.js — the entry point into the mod package manager, and the collapsed mismatch notice.
//
// The manager itself is a plain page (/mods.html) rather than an in-game dialog: it lists packages, uploads zips,
// toggles them and shows problems — none of which needs the WebSocket session, and a full page survives a reload
// while the user is dragging files around.
//
// WHY THE NOTICE IS COLLAPSED (user decision A: 只显示不执行，避免被注入)
//   Mod packages are JavaScript. Showing another player's package list is informative; FETCHING AND RUNNING their code
//   would be remote code execution on this machine. So the room only ever reports the list, the UI only ever prints a
//   one-line verdict, and the details sit behind a click. Nothing is downloaded, and a mismatch never blocks a match —
//   it is a hint that the two sides may be seeing (or simulating) different things.

import { html, Button } from './components.js';
import { useEffect, useState } from '../../vendor/hooks.module.js';

/** Where the manager lives. Kept in one place so a host can move the page later. */
export const MODS_PAGE = '/mods.html';

/** Cached `/api/mods` payload; the button and the notice share it so a page makes at most one request. */
let cache = { at: 0, data: null };
const CACHE_MS = 5000;

/**
 * Load the installed-package summary. Never throws: a server without the manager (or an offline page) yields null.
 * @param {boolean} [force] ignore the cache
 */
export async function modsSummary(force = false) {
  const now = Date.now();
  if (!force && cache.data && now - cache.at < CACHE_MS) return cache.data;
  try {
    const r = await fetch('/api/mods', { cache: 'no-store' });
    if (!r.ok) { cache = { at: now, data: null }; return null; }
    const data = await r.json();
    cache = { at: now, data };
    return data;
  } catch { cache = { at: now, data: null }; return null; }
}

/** How many packages are installed and enabled (0 when unknown). */
export function enabledCount(list) {
  if (!list || !Array.isArray(list.mods)) return 0;
  return list.mods.filter((m) => m.status === 'ok' && m.enabled).length;
}

/**
 * The "模组" button. Shows how many packages are enabled, and a warning dot when any of them failed to mount (so a
 * broken drop is noticed without opening the page).
 * @param {{ class?: string }} props
 */
export function ModsButton({ class: cls = '' } = {}) {
  const [list, setList] = useState(null);
  useEffect(() => { let live = true; modsSummary().then((d) => { if (live) setList(d); }); return () => { live = false; }; }, []);
  const n = enabledCount(list);
  const bad = list && Array.isArray(list.mods) ? list.mods.filter((m) => m.status !== 'ok').length : 0;
  return html`<${Button} class=${`title-mods ${cls}`.trim()} size="sm" icon="grid"
    title=${list ? `${n} 个模组已启用${bad ? `，${bad} 个无法挂载` : ''}` : '模组管理'}
    onClick=${() => { location.href = MODS_PAGE; }}>
    模组${n ? html`<span class="title-mods__n">${n}</span>` : null}${bad ? html`<span class="title-mods__bad" title="${bad} 个包无法挂载">!</span>` : null}
  <//>`;
}

/** One seat's package list, e.g. `ArknightsUI@1.0.0, my-mod`. */
function names(seat) {
  const list = Array.isArray(seat?.mods) ? seat.mods : [];
  if (!list.length) return '（无）';
  return list.map((m) => (m.version ? `${m.id}@${m.version}` : m.id)).join('、');
}

/**
 * The collapsed mismatch notice for the room screen. Renders nothing unless at least one human seat is flagged, so the
 * common case (nobody has mods, or everybody has the same set) adds no UI at all.
 * @param {{ seats: Array<object|null>, me?: string|null }} props
 */
export function ModMismatch({ seats, me = null }) {
  const [open, setOpen] = useState(false);
  const list = Array.isArray(seats) ? seats : [];
  const flagged = list.filter((s) => s && !s.isBot && s.modMismatch);
  if (!flagged.length) return null;
  const withMods = list.filter((s) => s && !s.isBot && Array.isArray(s.mods) && s.mods.length);
  return html`<div class="modmm">
    <button type="button" class="modmm__bar" aria-expanded=${open} onClick=${() => setOpen(!open)}>
      <span class="modmm__dot" aria-hidden="true"></span>
      <span>模组不一致</span>
      <span class="modmm__sub">${flagged.length} 名玩家的模组与其他人不同</span>
      <span class="modmm__chev">${open ? '收起' : '详情'}</span>
    </button>
    ${open ? html`<div class="modmm__body">
      <p class="modmm__note">
        模组内容不会自动下载，也不会被执行 —— 这里只是把各自的模组列表列出来。若有人装了<strong>会改变战斗模拟</strong>的模组，
        请自行从作者处获取并安装同样的版本，否则双方算出的结果可能不一致。
      </p>
      <table class="modmm__t">
        <thead><tr><th>玩家</th><th>已加载的模组</th></tr></thead>
        <tbody>
          ${list.filter((s) => s && !s.isBot).map((s) => html`<tr class=${s.modMismatch ? 'is-off' : ''}>
            <td>${s.name}${s.playerId === me ? '（你）' : ''}</td>
            <td>${names(s)}</td>
          </tr>`)}
        </tbody>
      </table>
      <div class="modmm__acts">
        <${Button} size="sm" onClick=${() => { location.href = MODS_PAGE; }}>打开模组管理<//>
      </div>
      ${withMods.length ? null : html`<p class="modmm__note">本房间没有人的客户端上报了模组。</p>`}
    </div>` : null}
  </div>`;
}
