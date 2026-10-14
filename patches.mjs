// patches.mjs —— 修改器 v2 对**上游 0.2.4** 的全部接线（15 条，覆盖 16 个上游文件）
//
// 设计口径（与 v1 的 36 条相比，这里是刻意的"少"）：
//   · 每条只碰**几行**，锚点写在明面上，`once` 判据是"接线后的形状"，所以重复安装是幂等的；
//   · 每条都必须能 `--undo` 还原（安装器把原文备份进 state/backup）；
//   · 不整份复制任何上游文件 —— 这是 v1 翻车的根因（见 catalog.mjs 的说明）；
//   · 只剩"模组怎么被加载、怎么被服务、外观旋钮怎么被读到"这件事必须动上游，其余全部落在我方文件里
//     （server/mods.js、server/loader.js、public/js/mods.js、public/js/mods/style.js …）；
//
// 移植到更新的上游版本时：只改这个文件。用 `node install.mjs --audit --root <干净的上游>` 逐条试锚点，
// 哪条 ✘ 就照着上游新代码改哪条的 anchor/apply —— 不要去 files/ 里放拷贝。

// =================================================================================================================
// 0) 渲染接缝（public/js/render/**）共用的插入块与工具
//
// 上游文件里只出现**一行 import + 每个接缝一行调用**；守卫、ctx 对象、返回值归一化全部在
// `files/public/js/mods/render.js` 里（OURS，随便改）。这么分的理由见 catalog.mjs 开头：
// 一代翻车就是因为往 files/ 里塞了渲染层的整份拷贝（`files/public/js/render/**`），
// 覆盖上去既丢上游 0.2.4 的新实现（impostor 帧槽 / poseHeld / 眼睑遮罩降级 / ItemView），又把性能拖回去。
//
// 每条插入（或替换）块的第一行都是 `// Mod packages (sp-mods): …`，与文件里既有接缝注释同风格；
// `once` 与 `apply` 用的是**同一份文本**（下面的常量），所以「装好了」的判据 = 这些块逐字都在 + 0.2.4 形状在 +
// 一代覆盖层形状不在 + 没有插两遍。

const MARK = '// Mod packages (sp-mods):';

/** 正则转义。 */
const escRe = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** 这个片段在正文里**恰好出现一次**？（出现两次 = 上一次插了两遍，必须逼 apply 重来。） */
const count1 = (s, piece) => (s.match(new RegExp(escRe(piece), 'g')) || []).length === 1;

/** 这个片段在正文里出现了几次？ */
const countOf = (s, piece) => (s.match(new RegExp(escRe(piece), 'g')) || []).length;

/** 这个锚点在正文里**恰好出现一次**？（不唯一就是"位置没法确定"——宁可拒绝，也不瞎猜。） */
const anchorOnce = (s, anchor) => s.split(anchor).length === 2;

/**
 * 匹配一段插入块：逐行比对，**每行的前导空白自由**（上游只是重排缩进时不至于把块认丢），
 * 块内其余字符逐字相等。`apply` 用它把旧插入整段摘掉。
 */
function blockRe(block) {
  const body = block.split('\n').map((l) => '[ \\t]*' + escRe(l.replace(/^[ \t]+/, ''))).join('\\n');
  return new RegExp(body, 'g');
}

/**
 * 摘除/退役时把"被 `blockRe` 的 `[ \t]*` 吃掉的空白"还给替换文本（1.0.1 修的一个老毛病）。
 *
 * 为什么需要：`blockRe` 每行都以 `[ \t]*` 开头（上游重排缩进也认得出块）⇒ **匹配本身包含了行首空白**；
 * 而换回去的 `to`（上游原句、或退役条目的 `''`）通常不带缩进 ⇒ 替换之后那段的第一行落到第 0 列。
 * JS 语义不变，但两件事会坏：
 *   · "实例 = 干净上游 + 本版补丁"这条不变量断掉（`tools/verify-patch-drift.mjs` 会报出来）；
 *   · 一行行地被啃掉缩进以后，文件越来越不像上游，读 diff 时噪声大。
 * 规则：
 *   · `to === ''`（整块退役、不留痕）→ 原样删，绝不补空白；
 *   · `to` 自己就以空白开头（带缩进的块锚点，例如 `UNIT_BARS_ANCHOR` 的 `    const bw = …`）→ 不补，避免双份缩进；
 *   · 其余（**不带缩进的 SUBS 锚点**：`let cy = y - 4;`、`? FLY_HOVER : 0;`、`this.spBg.position.set(…)` …）
 *     → 把匹配到的那段空白接回前面，恢复原样。
 *
 * @param {string} to @returns {(m: string) => string}
 */
const keepIndent = (to) => (m) => {
  if (to === '') return to;
  if (/^[ \t]/.test(to)) return to;
  return (/^[ \t]*/.exec(m) || [''])[0] + to;
};

/**
 * 一条接缝：`anchor` 是 0.2.4 里的原句（必须唯一），`block` 是**替换**它的完整文本。
 *
 * 用「替换」而不是「在锚点之后插入」，是为了让摘除有确定的逆：把 `block` 整段换回 `anchor`，
 * 文件就回到 0.2.4 原样 —— 于是 `apply` 永远是「先摘旧的、再插新的」，不可能插出两份（AGENTS §0b 第 3 条）。
 */

/**
 * 落一条补丁：先按插入块整段摘掉旧的插入（还原它替换掉的上游原句），再逐条查锚点、插回去。
 *
 * 返回 `null` = 拒绝改动（文件留给维护者）：0.2.4 形状不在 / 一代覆盖层形状还在 / 锚点缺失或不唯一 /
 * 旧插入摘不干净。install.mjs 会把它报成「锚点失效」，`--audit` 报成 ✘。
 *
 * @param {string} src 上游文件正文
 * @param {Array<{anchor: string, block: string}>} hunks
 * @param {{require?: string[], forbid?: string[], staleBlocks?: string[][]}} [shapes]
 *   0.2.4 必须有的形状 / 一代覆盖层的形状 / **退役的插入块**（见下）
 */
function applyHunks(src, hunks, { require = [], forbid = [], staleBlocks = [] } = {}) {
  for (const f of require) if (!src.includes(f)) return null;   // 0.2.4 形状不在（上游换实现了？）
  for (const f of forbid) if (src.includes(f)) return null;     // 一代覆盖层/坏形状还在：先还原渲染层
  let out = src;
  let stripped = 0;
  // ① 先摘**退役**的插入：上一版插件插过、这一版不再插在同一处的块。
  //
  // 为什么必须有这一步（AGENTS §0b 第 3 条的同一条教训）：块的首行就是上游锚点行，而块内容一变，
  // `blockRe(h.block)` 就再也匹配不上文件里那一份旧的 —— 旧块留在原处，新版再把新块插到别处 = 两份，
  // 或者干脆因为「有一个规范块之外的标记」而**拒绝改动**（下面的第 ④ 步），于是装过坏版本的实例被判成
  // "已装好"、永远修不回来（§0b 说的 CoreBehaviourFixes 2.3.1 就是这个坑）。
  //
  // ⚠️ 顺序：必须在 ①′ 的规范摘除**之前**。旧块（`block`）里往往就含锚点行 —— 规范摘除只认
  // `h.block`（新版文本）逐字命中，走过旧块时什么都不会发生，于是锚点行在文件里出现两次，
  // 到第 ③ 步 `anchorOnce` 直接判死。先退役旧块，锚点行才回到唯一。
  //
  // ⚠️ 这里**不能**用 `anchorOnce` 当门槛：退役场景里锚点本来就可能出现两次（旧块自带一份 + 上游原句
  // 一份），要求"唯一"等于永远摘不掉 —— 正是要修的那个坑。判据只是"这段旧插入逐字在"；块被逐字认得，
  // 摘除就一定有确定的逆（换回 `to`）。摘完若还有歧义，第 ③ 步的 `anchorOnce` 会兜住并拒绝。
  //
  // 每条 = [锚点行, 旧块正文, 换回什么（默认锚点行本身；旧块不含锚点行、新版把插入点挪到锚点之后时用 '')]。
  // 旧块正文可以写成 `{ when, probe, re }`（duck-typing）：`when` 是"这段确实重复了"的前置判据、`probe`
  // 是逐字命中的那一段、`re` 是替换用的正则 —— 仍然先逐字认出旧插入，绝不凭形状猜整段。
  for (const [anchor, block, to = anchor] of staleBlocks) {
    const isRe = typeof block === 'object' && block !== null;
    if (isRe && block.when && !block.when(out)) continue;          // "装了两份"这类前置判据
    const probe = isRe ? block.probe : block;
    if (!out.includes(probe)) continue;                            // 先逐字认出这段旧插入
    if (isRe) block.re.lastIndex = 0;                              // 正则带 g：跨调用复用前先复位
    const before = out.length;
    out = out.replace(isRe ? block.re : blockRe(block), keepIndent(to));   // `keepIndent`：别把行首空白啃掉
    if (out.length !== before) stripped++;
  }
  for (const h of hunks) {                                                      // ①′ 再摘规范插入
    const before = out.length;
    out = out.replace(blockRe(h.block), keepIndent(h.anchor));
    if (out.length !== before) stripped++;
  }
  // ② 摘不干净就绝不插第二份。判据不是"文本里还有没有标记"（有几种接线的锚点行就在 `// Mod packages (sp-mods):`
  //    这句注释下面，例如 render/style.js 的 import），而是三件事：**有没有摘下来** / **规范块在不在** /
  //    **标记是不是比规范块还多**（多出来的就是别人插的残留）。
  const marks = (out.match(/\/\/ Mod packages \(sp-mods\):/g) || []).length;
  const blocks = hunks.filter((h) => out.includes(h.block)).length;
  if (!stripped) {
    if (blocks === hunks.length) return out;      // 已经装好了：apply 幂等，原样返回
    if (marks > blocks) return null;              // 有规范块之外的残留：拒绝，交给 --audit 与人
  }
  for (const h of hunks) {
    if (!anchorOnce(out, h.anchor)) return null;                                // ③ 锚点必须唯一命中
    out = out.replace(h.anchor, () => h.block);
  }
  return out;
}

// ---- 7) public/js/render/app.js：5 条接缝（event / damage / viewGone / frame / overlay）--------------------------------

const APP_IMPORT_ANCHOR = "import { t } from '../../../shared/i18n.js';";
const APP_IMPORT_BLOCK = APP_IMPORT_ANCHOR + '\n' + [
  '// Mod packages (sp-mods): the battlefield seams — every raw battle event, the damage call, a view leaving the',
  '// snapshot, the once-per-frame tick and the "draw it yourself" overlay pass. Each call site below is ONE call:',
  '// the guard, the context object and the zero-allocation rule live in public/js/mods/render.js (a file the loader',
  '// owns, never an upstream one). With no package mounted every seam is one Map lookup and allocates nothing.',
  "import * as modRender from '../mods/render.js';",
].join('\n');

const APP_EVENT_ANCHOR = '    interp.takeEvents(renderT, EVS, renderT - 1.5, LATE);';
const APP_EVENT_BLOCK = APP_EVENT_ANCHOR + '\n' + [
  '    // Mod packages (sp-mods): `field:event` — a package sees the same raw tuples the view does, before the view',
  "    // handles any of them (the same stream is what `api.on('event')` delivers). One guard per frame; the payload",
  '    // object is built only when somebody is registered, and it is reused for every event of that frame.',
  '    if (modRender.wantsEvents()) modRender.consumeEvents(EVS, renderT, battleMeta?.fieldId ?? null);',
].join('\n');

const APP_DAMAGE_ANCHOR = '        fx.damage(v, amt, e[3], src);';
const APP_DAMAGE_BLOCK = [
  '        // Mod packages (sp-mods): `field:damage` — a package may take this hit over; it then owns the drawn number',
  '        // AND the hit feedback (the flash, `view.onHit`, the blood), which only `fx.damage` itself plays — a handler',
  '        // that just moves the number calls `fx.damage` from inside it. One `has(...)` per hit when nobody is',
  '        // registered, and the context object is built only when the registry answers.',
  '        if (!modRender.takeDamage(v, amt, e[3], src, now, fx, battleMeta?.fieldId ?? null)) fx.damage(v, amt, e[3], src);',
].join('\n');

const APP_GONE_ANCHOR = '        if (v.alive) { v.alive = false; v.dying = 0.25; v.dieDur = 0.25; }';
const APP_GONE_BLOCK = [
  "        // Mod packages (sp-mods): `field:viewGone` — a package may play the view's own death instead of the 0.25 s",
  '        // fade (answering `{ die: true }`), which is what an operator needs: the sim drops a knocked-out operator',
  '        // from `units` in the very frame it falls and the interpolation buffer can miss that frame, which otherwise',
  '        // freezes the view on its last action frame. One `has(...)` per view that LEAVES the snapshot, not per frame.',
  '        if (v.alive) {',
  '          const out = modRender.viewGone(v, now, battleMeta?.fieldId ?? null);',
  "          if (out && typeof out === 'object' && out.die && typeof v.die === 'function') v.die(!!out.instant);",
  '          else { v.alive = false; v.dying = 0.25; v.dieDur = 0.25; }',
  '        }',
].join('\n');

const APP_FRAME_ANCHOR = '      fx.update(dt);\n      impostors.flush();';
const APP_FRAME_BLOCK = APP_FRAME_ANCHOR + '\n' + [
  "      // Mod packages (sp-mods): the per-frame seams, inside this frame's `try`, so a throwing package is caught by",
  "      // the block below and the frame keeps rendering. `frameTick` serves `api.on('frame')` and `field:frame`;",
  '      // `overlay` is the "draw it yourself" pass (the real `ctx`; `layers.overlay` is world space, `layers.screen`',
  '      // screen space). Both return on their first `has(...)` when nobody is registered: no payload, no allocation.',
  '      modRender.frameTick(dtRaw, interp.renderT, mode, clock, battleMeta?.fieldId ?? null);',
  '      modRender.overlay(ctx, cam, clock, dtRaw, mode, layers, views, fx, tiles, battleMeta?.fieldId ?? null);',
].join('\n');

/** app.js 的五条接缝：一条补丁一起装、一起摘（半装状态由 `once` 的逐块比对逼 apply 重来）。 */
const APP_HUNKS = [
  { anchor: APP_IMPORT_ANCHOR, block: APP_IMPORT_BLOCK },
  { anchor: APP_EVENT_ANCHOR, block: APP_EVENT_BLOCK },
  { anchor: APP_DAMAGE_ANCHOR, block: APP_DAMAGE_BLOCK },
  { anchor: APP_GONE_ANCHOR, block: APP_GONE_BLOCK },
  { anchor: APP_FRAME_ANCHOR, block: APP_FRAME_BLOCK },
];

// ---- 8) public/js/render/fx/numbers.js：field:damageNumber 的两个 kind（allow / text）--------------------------------

const NUM_IMPORT_ANCHOR = "import { DMG_STYLE, HIT_TINT, dmgStyleKey } from '../style.js';";
const NUM_IMPORT_BLOCK = NUM_IMPORT_ANCHOR + '\n' + [
  '// Mod packages (sp-mods): a damage number is a package surface — `allowDamageNumber` (draw it at all) and',
  '// `damageNumberStyle` (what it says and looks like), both with their guard inside public/js/mods/render.js.',
  "import { allowDamageNumber, damageNumberStyle } from '../../mods/render.js';",
].join('\n');

const NUM_ALLOW_ANCHOR = '    const n = Math.round(amount);\n    if (!(n > 0) || !view) return;';
const NUM_ALLOW_BLOCK = [
  "    // Mod packages (sp-mods): `field:damageNumber`, `kind: 'allow'` — is this figure drawn at all? A package may",
  '    // swallow it; the hit flash and every other effect still play (that is `field:damage`, a different seam). One',
  "    // `has(...)` per hit, nothing allocated when nobody is registered. The caller's `settings.damageNumbers` switch",
  '    // is upstream and still runs first: with the numbers turned off this seam is never asked at all.',
  '    const n = Math.round(amount);',
  '    if (!(n > 0) || !view) return;',
  '    if (!allowDamageNumber(view, amount, style, big)) return;',
].join('\n');

const NUM_LIFE_ANCHOR = '    const life = near >= NUM_CROWD ? NUM_LIFE * 0.62 : NUM_LIFE;';
const NUM_LIFE_BLOCK = [
  "    // Mod packages (sp-mods): `field:damageNumber`, `kind: 'text'` — the first non-null answer wins. ONE run per NEW",
  '    // figure (a hit merged into a running total returns above, upstream structure: this is per figure, not per hit).',
  '    // `{ text, color, life, big }`; `scale` / `rise` are NOT wired here — they need `_sizeNum` / `_numSlotPx` too.',
  '    const ms = damageNumberStyle(view, amount, style, big);',
  '    const life = (near >= NUM_CROWD ? NUM_LIFE * 0.62 : NUM_LIFE)',
  '      * (ms && Number.isFinite(ms.life) ? Math.max(0.05, ms.life) / NUM_LIFE : 1);',
].join('\n');

const NUM_TEXT_ANCHOR = [
  '    const t = this._takeNum(style);',
  '    t.text.visible = true;',
  '    t.text.alpha = 1;',
  "    t.text.text = (style === 'heal' ? '+' : '') + n;",
  '    Object.assign(t, {',
  '      unit: view, style, value: n, life: 0, end: life, born: now, lastHit: now, pop: 1, big: !!big, fading: false,',
  '      ox: cx - ax, oy: cy - ay, x0: view.x, y0: view.y, z0: base, risePx, _x: cx, _y: cy, _w: w, _h: h,',
  '    });',
  '    this.nums.push(t);',
].join('\n');
const NUM_TEXT_BLOCK = [
  "    // Mod packages (sp-mods): the figure `kind: 'text'` asked for (`ms` above) — and the tint reset, which is not",
  '    // cosmetic: `_takeNum` hands out a POOLED BitmapText, so a colour a package set once would otherwise stick to',
  '    // every later number of the battle (the pool keeps `t.text` alive across releases).',
  '    const t = this._takeNum(style);',
  '    t.text.visible = true;',
  '    t.text.alpha = 1;',
  "    t.text.text = ms && typeof ms.text === 'string' ? ms.text : (style === 'heal' ? '+' : '') + n;",
  '    if (ms && ms.color != null) t.text.tint = ms.color;',
  '    else if (t.text.tint !== 0xffffff) t.text.tint = 0xffffff;',
  '    Object.assign(t, {',
  '      unit: view, style, value: n, life: 0, end: life, born: now, lastHit: now, pop: 1,',
  "      big: ms && typeof ms.big === 'boolean' ? ms.big : !!big, fading: false,",
  '      ox: cx - ax, oy: cy - ay, x0: view.x, y0: view.y, z0: base, risePx, _x: cx, _y: cy, _w: w, _h: h,',
  '    });',
  '    this.nums.push(t);',
].join('\n');

const NUM_HUNKS = [
  { anchor: NUM_IMPORT_ANCHOR, block: NUM_IMPORT_BLOCK },
  { anchor: NUM_ALLOW_ANCHOR, block: NUM_ALLOW_BLOCK },
  { anchor: NUM_LIFE_ANCHOR, block: NUM_LIFE_BLOCK },
  { anchor: NUM_TEXT_ANCHOR, block: NUM_TEXT_BLOCK },
];

/** 每条补丁的 `once` 都要求「这些块逐字都在」——半装/插两遍都算没装好，逼 apply 先摘后插。 */
const allBlocks = (s, hunks) => hunks.every((h) => s.includes(h.block));

/** 每条补丁的 `once` 都要求「没有插两遍」（§0b 第 3 条）。 */
const noDuplicates = (s, pieces) => pieces.every((p) => count1(s, p));

// ---- 9) public/js/render/units.js：HUD 接缝（unitBars / enemyBars / chip）---------------------------------------------

const UNIT_IMPORT_ANCHOR = "import { UF, ANIM } from '../../../shared/constants.js';";
const UNIT_IMPORT_BLOCK = UNIT_IMPORT_ANCHOR + '\n' + [
  '// Mod packages (sp-mods): the per-unit HUD seams — `field:unitBars` / `field:enemyBars` (length, thickness,',
  '// colours, the plate) and `field:chip` (the tier chip). The guards and the context objects live in',
  '// public/js/mods/render.js; with no package mounted each of them is one Map lookup and allocates nothing.',
  "import * as modRender from '../mods/render.js';",
].join('\n');

const UNIT_BARS_ANCHOR = [
  '    const bw = clamp(s * (this.isBoss ? UNIT.bossBarWidth : UNIT.barWidth), 24, this.isBoss ? 260 : 96);',
  '    const bh = clamp(s * (this.isBoss ? 0.12 : 0.075), 3, this.isBoss ? 12 : 7);',
].join('\n');
const UNIT_BARS_BLOCK = [
  '    // Mod packages (sp-mods): `field:unitBars` / `field:enemyBars` — the bar length, thickness, colours and the',
  '    // plate behind them. `bw` / `bh` are `let` for that reason; with nobody registered `barStyle` stays null and',
  '    // every value below is the shipped one (the guard is the first statement of `unitBars`, so no object is built).',
  '    // The length cap reads the `hud.max*` knobs (public/js/mods/style.js): 260 / 96 / 96 is what stands there.',
  '    let bw = clamp(s * (this.isBoss ? UNIT.bossBarWidth : UNIT.barWidth), 24, this.isBoss ? HUD.maxBoss : this.isEnemy ? HUD.maxEnemy : HUD.maxAlly);',
  '    let bh = clamp(s * (this.isBoss ? 0.12 : 0.075), 3, this.isBoss ? 12 : 7);',
  '    const barStyle = modRender.unitBars(this.isEnemy, this, bw, bh, !!(this.flags & UF.SHIELD));',
  '    if (barStyle) {',
  '      if (Number.isFinite(barStyle.width)) bw = barStyle.width;',
  '      if (Number.isFinite(barStyle.height)) bh = barStyle.height;',
  '    }',
].join('\n');

const UNIT_HP_ANCHOR = [
  '      this.hpBg.position.set(x0 - 1, cy); this.hpBg.width = bw + 2; this.hpBg.height = bh + 2;',
  '      this.hpGhost.position.set(x0, cy); this.hpGhost.width = bw * g; this.hpGhost.height = bh;',
  '      this.hpFill.position.set(x0, cy); this.hpFill.width = bw * k; this.hpFill.height = bh;',
  '      if (!this.isEnemy) this.hpFill.tint = k < 0.3 ? COLORS.hpAllyLow : COLORS.hpAlly;',
].join('\n');
const UNIT_HP_BLOCK = [
  '      // Mod packages (sp-mods): the plate (`backPadPx` / `backAlpha`) and the HP colours of `field:unitBars`, then the',
  '      // same two values as SHIPPED DEFAULTS from the `hud.*` knob group (public/js/mods/style.js — 1 px pad, 0.85 alpha,',
  '      // exactly what stood here before). A package answer wins; with none mounted `barStyle` is null and the knobs are',
  '      // still the shipped numbers, so this is the same plate as upstream.',
  '      const backPad = barStyle && Number.isFinite(barStyle.backPadPx) ? Math.max(0, barStyle.backPadPx) : HUD.backPadPx;',
  '      const backAlpha = barStyle && Number.isFinite(barStyle.backAlpha) ? clamp(barStyle.backAlpha, 0, 1) : HUD.backAlpha;',
  '      this.hpBg.position.set(x0 - backPad, cy); this.hpBg.width = bw + backPad * 2; this.hpBg.height = bh + backPad * 2;',
  '      if (this.hpBg.alpha !== backAlpha) this.hpBg.alpha = backAlpha;',
  '      this.hpGhost.position.set(x0, cy); this.hpGhost.width = bw * g; this.hpGhost.height = bh;',
  '      this.hpFill.position.set(x0, cy); this.hpFill.width = bw * k; this.hpFill.height = bh;',
  '      if (!this.isEnemy) {',
  '        const low = barStyle && Number.isFinite(barStyle.lowHpRatio) ? barStyle.lowHpRatio : 0.3;',
  '        this.hpFill.tint = k < low ? (barStyle && barStyle.hpLowColor != null ? barStyle.hpLowColor : COLORS.hpAllyLow)',
  '          : (barStyle && barStyle.hpColor != null ? barStyle.hpColor : COLORS.hpAlly);',
  '      }',
].join('\n');

const UNIT_SP_ANCHOR = '      this.spFill.tint = ammo ? COLORS.ammo : active ? COLORS.spActive : ready ? COLORS.spReady : COLORS.sp;';
const UNIT_SP_BLOCK = [
  '      // Mod packages (sp-mods): the SP / ammo colours of `field:unitBars` (`spColor` / `spActiveColor` / `spReadyColor`).',
  '      this.spFill.tint = ammo ? COLORS.ammo',
  '        : active ? (barStyle && barStyle.spActiveColor != null ? barStyle.spActiveColor : COLORS.spActive)',
  '        : ready ? (barStyle && barStyle.spReadyColor != null ? barStyle.spReadyColor : COLORS.spReady)',
  '        : (barStyle && barStyle.spColor != null ? barStyle.spColor : COLORS.sp);',
].join('\n');

const UNIT_CHIP_ANCHOR = [
  '    // tier chip (left of the bars in battle; above the head in prep)',
  '    if (this.chip) {',
  '      const cs = clamp(s * (prep ? 0.24 : 0.19), 11, 28) / 44;',
  '      this.chip.scale.set(cs);',
  '      this.chip.visible = this.alive;',
].join('\n');
const UNIT_CHIP_BLOCK = [
  '    // Mod packages (sp-mods): `field:chip` — scale, alpha or hide the tier chip. `null` (nobody registered, or no',
  '    // answer) keeps every line below on the shipped value; the alpha is put back when a package goes away, or the',
  '    // chip would stay at whatever the last mounted package wrote (`this.chip` outlives the package).',
  '    // The `/ 44` denominator is the `chip.height` knob now (public/js/mods/style.js): 44 is what stands there.',
  '    // tier chip (left of the bars in battle; above the head in prep)',
  '    if (this.chip) {',
  '      const chipStyle = modRender.chip(this, prep);',
  '      const cs = clamp(s * (prep ? 0.24 : 0.19), 11, 28) / CHIP.height',
  '        * (chipStyle && Number.isFinite(chipStyle.scaleMul) ? chipStyle.scaleMul : 1);',
  '      this.chip.scale.set(cs);',
  '      this.chip.visible = !(chipStyle && chipStyle.hidden === true) && this.alive;',
  '      if (chipStyle && Number.isFinite(chipStyle.alpha)) this.chip.alpha = chipStyle.alpha;',
  '      else if (this.chip.alpha !== 1) this.chip.alpha = 1;',
].join('\n');

/** 新建等级牌之后登记精灵（写 `chip.width/height` 后重切纹理用；见 textures.js 的 registerChipSprite）。 */
const UNIT_CHIP_REG_ANCHOR = '      h.addChild(this.chip);';
const UNIT_CHIP_REG_BLOCK = UNIT_CHIP_REG_ANCHOR + '\n' + [
  '      // Mod packages (sp-mods): a chip cut from the atlas has to learn about a later `chip.width/height` change',
  '      // (textures.js rebuildChipsFromKnobs → registerChipSprite). With no package writing those two keys it is one',
  '      // push into a module-level array, once per operator view — never per frame.',
  '      registerChipSprite(this.chip, this.tier, () => this.golden);',
].join('\n');

// ---- STYLE 旋钮：units.js 的十余处字面量（§3.3 的锚点表；顺序 = 先旋钮、后钩子）-------------------------------------

const UNIT_STYLE_IMPORT_ANCHOR = "import { COLORS, TIER_COLORS, ENEMY_FRAME, UNIT, PROJ, statusIconKey, statusIconSuppressed } from './style.js';";
const UNIT_STYLE_IMPORT_BLOCK = [
  '// Mod packages (sp-mods): the style knobs (public/js/mods/style.js, re-exported by render/style.js) — the numbers',
  '// and colours below that upstream keeps as literals in THIS file. Every default equals the literal it replaced.',
  UNIT_STYLE_IMPORT_ANCHOR.replace(' } from', ', HUD, SHIELD, HIT_FLASH, FLY, DOWN, CHIP } from'),
].join('\n');

const UNIT_STYLE_TEX_ANCHOR = "import { diamondTexture, shadowTexture, fxAtlas, tierChip, statusTexture, itemTexture, hudRings, ringArc, downLabel, HUD_DISC, ELEMENT_RING } from './textures.js';";
const UNIT_STYLE_TEX_BLOCK = [
  '// Mod packages (sp-mods): `registerChipSprite` / `unregisterChipSprite` let a chip cut from the atlas follow a later',
  "// `chip.width/height` (and leave the registry when the view goes); `hudHand` / `hudClockFace` / `RING_HAND_AT` draw",
  "// the static hands and the plate of the redeploy clock (`down.face: 'clock'`).",
  UNIT_STYLE_TEX_ANCHOR.replace(' } from', ', registerChipSprite, unregisterChipSprite, hudHand, hudClockFace, RING_HAND_AT } from'),
].join('\n');

/**
 * 上一版那两行的块（没有 unregisterChipSprite）。
 *
 * ⚠️ 这里**不含**锚点行：文件里既有旧块又有新块时，上游原句会被两份块各带一次（不唯一），
 * `anchorOnce` 就废了 —— `applyHunks` 的 `staleBlocks` 因此是"anchor + 块正文"两部分分开给的：
 * 先 `includes(block)` 认出旧插入，再用 anchor 把它整段换回上游原句。
 */
const UNIT_STYLE_TEX_STALE_LINES = [
  '// Mod packages (sp-mods): `registerChipSprite` lets a chip cut from the atlas follow a later `chip.width/height`;',
  "// `hudHand` / `hudClockFace` / `RING_HAND_AT` draw the static hands and the plate of the redeploy clock",
  "// (`down.face: 'clock'`).",
  UNIT_STYLE_TEX_ANCHOR.replace(' } from', ', registerChipSprite, hudHand, hudClockFace, RING_HAND_AT } from'),
].join('\n');

/** `UnitView.destroy()`：把等级牌从登记表里摘掉（登记表是模块级的，不摘就是一条常驻的死引用）。 */
const UNIT_CHIP_UNREG_ANCHOR = '    this.shadow.destroy();';
const UNIT_CHIP_UNREG_BLOCK = [
  '    // Mod packages (sp-mods): the chip sprite goes with the view — the registry in textures.js is module-level, so a',
  '    // view that is torn down has to leave it (see registerChipSprite).',
  '    if (this.chip) unregisterChipSprite(this.chip);',
  UNIT_CHIP_UNREG_ANCHOR,
].join('\n');

const UNIT_DOWNLOOK_ANCHOR = [
  'export const DOWN_LOOK = Object.freeze({',
  '  tint: 0xb4b4b4, alpha: 0.92,',
  '  ring: Object.freeze({ [DOWN_STATE.COUNTING]: 0x4ed8af, [DOWN_STATE.WAIT_DP]: 0xffc600, [DOWN_STATE.WAIT_TILE]: 0xff4b3e }),',
  '  size: 0.42, height: 1.02,',
  '});',
].join('\n');
const UNIT_DOWNLOOK_BLOCK = [
  '// Mod packages (sp-mods): the knocked-down look is a knob group now (public/js/mods/style.js `down.*`). The field',
  '// names match 1:1 (tint / alpha / ring / size / height), so aliasing the constant to the live object leaves the six',
  '// read sites in this file untouched — and `DOWN_LOOK.ring[state]` reads a mod value the moment one is written.',
  'export const DOWN_LOOK = DOWN;',
].join('\n');

/**
 * SP 行：底板（units.js:1378 上游原句）、行高（:1370）与两行缝隙（:1377）。
 *
 * 1.0.1 修的三件事（同一个 bug 的三张脸，见 `render-unit-hud` 的 what）：
 *   · `spBg` 只读 `HUD.backPadPx` / `HUD.backAlpha` 两个**旋钮**，不看 `field:unitBars` 交回的 `backPadPx` /
 *     `backAlpha`（HP 行读钩子）—— 同一个包只要两处写得不一样，两行底板就立刻不等宽、不等浓；
 *   · 行高 `0.6` 与缝隙 `1.5` 是写死的字面量，而时序表**早就发布了** `hud.spHeightFactor` / `hud.spGapPx`
 *     两个键（`files/public/js/mods/timing.js`，出厂值就是这两个字面量）却没有任何读点 ——
 *     模组 `api.ui.setTiming('hud.spHeightFactor', 1)` / `('hud.spGapPx', 0)` 写进去石沉大海，
 *     于是"两行等高贴合"永远做不到（一行 6px 一行 3.6px、中间还留 1.5px 缝）。
 *
 * ⚠️ 这三处都必须**就地**读（`barStyle` 在 `_updateHud` 顶层作用域里，钩子答案随处可取）：HP 行在
 * `UNIT_HP_BLOCK` 里已经算过一份 `backPad` / `backAlpha`，SP 行这里算**同一表达式**的第二份 ——
 * 两份表达式一模一样，所以两行不可能不一致；把 HP 那两行提升到接缝块外面会改到 `UNIT_BARS_BLOCK` 的正文，
 * 那就要为它再退役一整块（升级路径的活），不值当。
 */
const UNIT_SPBG_ANCHOR = 'this.spBg.position.set(x0 - 1, sy); this.spBg.width = bw + 2; this.spBg.height = spH + 2;';
const UNIT_SPBG_BLOCK = 'const spBackPad = barStyle && Number.isFinite(barStyle.backPadPx) ? Math.max(0, barStyle.backPadPx) : HUD.backPadPx;'
  + ' const spBackAlpha = barStyle && Number.isFinite(barStyle.backAlpha) ? clamp(barStyle.backAlpha, 0, 1) : HUD.backAlpha;'
  + ' this.spBg.position.set(x0 - spBackPad, sy); this.spBg.width = bw + spBackPad * 2; this.spBg.height = spH + spBackPad * 2;'
  + ' this.spBg.alpha = spBackAlpha;';
/** 1.0.0 插在这里的正文（只读旋钮）—— 退役用：块正文变了，`blockRe` 认不出旧的，必须在 `staleBlocks` 里摘。 */
const UNIT_SPBG_BLOCK_100 = 'this.spBg.position.set(x0 - HUD.backPadPx, sy); this.spBg.width = bw + HUD.backPadPx * 2;'
  + ' this.spBg.height = spH + HUD.backPadPx * 2; this.spBg.alpha = HUD.backAlpha;';

/** SP 行的厚度系数（units.js:1370 上游原句）：时序表 `hud.spHeightFactor`，出厂 0.6 = 这个字面量。 */
const UNIT_SPH_ANCHOR = 'const spH = Math.max(2, bh * (ammo ? AMMO_BAR.height : 0.6));';
const UNIT_SPH_BLOCK = "const spH = Math.max(2, bh * (ammo ? AMMO_BAR.height : modRender.hudSpacing('hud.spHeightFactor', 0.6)));";

/** 两行之间的缝隙（units.js:1377 上游原句）：时序表 `hud.spGapPx`，出厂 1.5px = 这个字面量。 */
const UNIT_SYGAP_ANCHOR = 'sy = cy + bh / 2 + spH / 2 + 1.5;';
const UNIT_SYGAP_BLOCK = "sy = cy + bh / 2 + spH / 2 + modRender.hudSpacing('hud.spGapPx', 1.5);";

/**
 * "字面量 → 旋钮读"的替换（每条锚点在 0.2.4 里都唯一；报告 §3.3 的行号表）。
 *
 * ⚠️ 这里**只放不落在任何接缝插块内部**的那些。会落进插块内部的（条长上限 `:1338`、护盾细线 `:1364`、
 * 等级牌缩放 `:1393`）写在 UNIT_HUNKS 的第 ② 组 —— 它们必须在接缝块之前落地，否则插块的文本会被改写，
 * `once` 的"block 逐字都在"就不成立（详见 UNIT_HUNKS 的顺序说明）。
 */
const UNIT_STYLE_SUBS = [
  // 飞行的悬停高度（units.js:1163；`179` 的 FLY_HOVER 常量保留，只是不再被这一行读）
  ['? FLY_HOVER : 0;', '? FLY.altitude : 0;'],
  // 隐匿的 alpha（units.js:1181）
  ['alpha *= 0.45;', 'alpha *= UNIT.stealthAlpha;'],
  // 受击白闪：:1221 有 ×0.8，:1261 隐含 ×1（两处乘数不同是有意的），:1264 是衰减 —— 锚点必须整行
  ['mixTint(tint, 0xff8a80, flashK * 0.8)', 'mixTint(tint, HIT_FLASH.tint, flashK * HIT_FLASH.mix)'],
  ['mixTint(0xffffff, 0xff8a80, this.flash)', 'mixTint(0xffffff, HIT_FLASH.tint, this.flash)'],
  ['this.flash = Math.max(0, this.flash - dt * 6);', 'this.flash = Math.max(0, this.flash - dt * HIT_FLASH.decay);'],
  // 条带与头顶的间距（units.js:1345）
  ['let cy = y - 4;', 'let cy = y - HUD.gap;'],
  // SP 行：底板 pad/alpha 与 HP 行同源（:1378）、行高（:1370）、行间缝隙（:1377）
  [UNIT_SPBG_ANCHOR, UNIT_SPBG_BLOCK],
  [UNIT_SPH_ANCHOR, UNIT_SPH_BLOCK],
  [UNIT_SYGAP_ANCHOR, UNIT_SYGAP_BLOCK],
  // 倒地环的高度与直径（units.js:1420 / 1606）
  ['this.screen.y - DOWN_LOOK.height * s', 'this.screen.y - DOWN.height * s'],
  ['const d = clamp(s * DOWN_LOOK.size, 22, 52);', 'const d = clamp(s * DOWN.size, DOWN.min, DOWN.max);'],
];



// =================================================================================================================
// STYLE 旋钮层（4 条：render/style.js / render/units.js 的同一文件追加 / render/textures.js / render/fx/fonts.js）
//
// 规格与逐键默认值证据：工作区 `reports/seam-style.md`。三条口径：
//   · 默认值逐键等于**上游 0.2.4 的字面量**（一代那张表里有 15 个键是本项目观感，照抄会改变"没模组时"的画面）；
//   · 上游文件只留"把字面量交给旋钮店"和"把 9 组名字 re-export 出去"，78+ 键的表全在我方
//     `files/public/js/mods/style.js`（OURS，改旋钮不用重打上游补丁）；
//   · units.js 的 6 处旋钮并进**已有的** `render-unit-hud`（一个上游文件只准一条补丁：install.mjs:216 的
//     `st.patched[p.file]` 是每文件一条记录，两条补丁打同一文件会让 --verify/--undo 的记账只剩后一条）。

/** 我方旋钮引擎的文件名（补丁里的注释与 manual 都引用它）。 */
const STYLE_MOD = 'public/js/mods/style.js';

// ---- S1) public/js/render/style.js：COLORS / UNIT 变成活对象 + 文件尾 re-export 9 组旋钮面 --------------------------

const STYLE_HEAD_ANCHOR = '// render/style.js — palette and visual tunables of the battlefield renderer (pure data).';
const STYLE_HEAD_BLOCK = STYLE_HEAD_ANCHOR + '\n' + [
  '// Mod packages (sp-mods): the knob layer lives in public/js/mods/style.js — see reports/seam-style.md. `COLORS` and',
  '// `UNIT` below are handed to `makeStyleStore()` there, so a package may retune them (and the nine group names are',
  '// re-exported at the end of this file). The literals themselves are untouched: with no package mounted every read',
  '// returns exactly the value written here.',
  "import { makeStyleStore } from '../mods/style.js';",
].join('\n');

const STYLE_TAIL_ANCHOR = '  barWidth: 0.64,\n  bossBarWidth: 2.2,\n});';
const STYLE_TAIL_BLOCK = STYLE_TAIL_ANCHOR + '\n\n' + [
  '// ---- Mod packages (sp-mods): the mod-overridable style layer -----------------------------------------------',
  '// Names and key sets match the v1 overlay (9 groups); every default is the literal above / in render/units.js,',
  '// render/textures.js and render/fx/fonts.js. The table itself lives in public/js/mods/style.js (a file the loader',
  '// owns). `STYLE.color === COLORS` and `STYLE.unit === UNIT`, so the renderer reads the very objects a package writes.',
  'export {',
  '  STYLE, STYLE_KEYS, STYLE_BASE, setStyleKnob, styleKnob, styleOverrides, resetStyleKnobs, onStyleChange,',
  '  HIT_FLASH, FLY, HUD, DOWN, CHIP, SHIELD, DMG,',
  "} from '../mods/style.js';",
].join('\n');

// ---- S2) public/js/render/textures.js：等级牌的旋钮化 +\* 静止指针的纹理 -------------------------------------------
const TEX_IMPORT_ANCHOR = "import { statusIconKey, ORIGINIUM, linearToSrgb255 } from './style.js';";
const TEX_IMPORT_BLOCK = TEX_IMPORT_ANCHOR + '\n' + [
  '// Mod packages (sp-mods): the tier-chip atlas and the redeploy-clock hands are drawn from knobs',
  `// (public/js/mods/style.js, re-exported by render/style.js) — see reports/seam-style.md.`,
  "import { CHIP, onStyleChange } from './style.js';",
].join('\n');

/** 追加的常量与两个颜色小工具（锚点 = 上游 `let _chips = null;`，整行唯一）。 */
const TEX_UTIL_ANCHOR = 'let _chips = null;';

/**
 * 上一版那次插入的尾巴 —— 退役用，见 TEXTURE_STALE ③。
 *
 * 实测形状（`test` 实例）：`let _chips = null;` → 小工具 → 登记表 → **再来一份小工具** → `/** … drawChips`。
 * 也就是新版块（工具 + 登记表）已经在了，旧块那一份被留在了**后面**。所以退役要摘的是"第二份工具"：
 *   `when`  先确认真的重复（`const chipCssColor = ` 出现两次）—— 全新安装时它只有一份，这条必须空转；
 *   `re`    从行首的 `const chipCssColor` 一直吃到 `function drawChips(c, w, h) {` 之前（`[\s\S]*?` 配右锚点，
 *           不会吃掉 `chipPlateFill` 里那个同名的 `return chipCssColor(paint);`）。
 */
const TEX_UTIL_DUP_BLOCK = [
  '// ---- Mod packages (sp-mods): helpers for the knob-driven chip atlas + a reused texture rectangle -------------',
  '',
  '/** One knob colour as a canvas style: `0xrrggbb` / a CSS string; a `{top,bottom}` pair is a vertical gradient. */',
  'const chipCssColor = (v) => (typeof v === \'number\' ? `#${(v >>> 0).toString(16).padStart(6, \'0\')}` : String(v));',
  '',
  '/** The plate fill of one chip (see chipCssColor).',
  ' * @param {CanvasRenderingContext2D} c @param {number|string|{top:number,bottom?:number}} paint',
  ' * @param {number} y0 @param {number} y1 the cell\'s top / bottom edge, the gradient\'s own span (as shipped) */',
  'function chipPlateFill(c, paint, y0, y1) {',
  '  if (paint && typeof paint === \'object\') {',
  '    const g = c.createLinearGradient(0, y0, 0, y1);',
  '    g.addColorStop(0, chipCssColor(paint.top));',
  '    g.addColorStop(1, chipCssColor(paint.bottom ?? paint.top));',
  '    return g;',
  '  }',
  '  return chipCssColor(paint);',
  '}',
  '',
].join('\n');
/** 同理的第三种兼容形状：工具那一段直接跟在锚点行后面（旧块的文档注释也还在）。 */
const TEX_UTIL_STALE_TAIL_DOC = ['', '/**', ' * Every LIVE tier chip, so a `chip.width` / `chip.height` write can hand the already-cut sprites the atlas\' new'].join('\n');

/**
 * 本版要插的形状：同样的两行开头 + 两个小工具，**尾部接上精灵登记表**（见 TEXTURE_STALE ③ 为什么这算"换写法"）。
 */
const TEX_UTIL_BLOCK = [
  TEX_UTIL_ANCHOR,
  '',
  '// ---- Mod packages (sp-mods): helpers for the knob-driven chip atlas + a reused texture rectangle -------------',
  '',
  '/** One knob colour as a canvas style: `0xrrggbb` / a CSS string; a `{top,bottom}` pair is a vertical gradient. */',
  'const chipCssColor = (v) => (typeof v === \'number\' ? `#${(v >>> 0).toString(16).padStart(6, \'0\')}` : String(v));',
  '',
  '/** The plate fill of one chip (see chipCssColor).',
  ' * @param {CanvasRenderingContext2D} c @param {number|string|{top:number,bottom?:number}} paint',
  ' * @param {number} y0 @param {number} y1 the cell\'s top / bottom edge, the gradient\'s own span (as shipped) */',
  'function chipPlateFill(c, paint, y0, y1) {',
  '  if (paint && typeof paint === \'object\') {',
  '    const g = c.createLinearGradient(0, y0, 0, y1);',
  '    g.addColorStop(0, chipCssColor(paint.top));',
  '    g.addColorStop(1, chipCssColor(paint.bottom ?? paint.top));',
  '    return g;',
  '  }',
  '  return chipCssColor(paint);',
  '}',
  '',
  '/**',
  ' * Every LIVE tier chip, so a `chip.width` / `chip.height` write can hand the already-cut sprites the atlas\' new',
  ' * rectangles. A chip\'s texture is a `Rectangle` INTO the atlas canvas (`tierChip` below), so the cell size is baked',
  ' * into every sprite handed out so far — while a colour / font / alpha knob is a pure repaint that reaches them by',
  ' * itself (same canvas, same BaseTexture). Registering is a single push per operator view (`units.js`, right after the',
  ' * chip is built), never per frame; `__chipTier` is stamped there so the re-cut follows a promotion (`this.tier`).',
  ' */',
  'const chipSprites = [];',
  '',
  '/**',
  ' * @param {import(\'pixi.js\').Sprite} sprite @param {number} tier @param {() => boolean} isGolden',
  ' *   `isGolden` is a THUNK: `units.js` reads `this.golden` at re-cut time, and a chip promoted in between must come',
  ' *   back with the golden plate.',
  ' */',
  'export function registerChipSprite(sprite, tier, isGolden) {',
  '  if (!sprite) return;',
  '  sprite.__chipTier = tier | 0 || 1;',
  '  chipSprites.push({ sprite, isGolden: typeof isGolden === \'function\' ? isGolden : () => false });',
  '}',
  '',
  '/** The other half of registerChipSprite: `UnitView.destroy` must not leave a dead sprite in the registry. */',
  'export function unregisterChipSprite(sprite) {',
  '  for (let i = chipSprites.length - 1; i >= 0; i--) if (chipSprites[i].sprite === sprite) chipSprites.splice(i, 1);',
  '}',
  '',
  '/**',
  ' * Re-cut every registered chip from the (possibly repainted) atlas, and drop the ones whose view is gone.',
  ' *',
  ' * ⚠️ Only called after the cell GEOMETRY moved (`rebuildChipsFromKnobs` below checks that first): every other chip',
  ' * knob keeps texture identity, so a re-cut there would be pure churn on a live board. Never throws out — a broken',
  ' * sprite must not take the frame (or the microtask that queued the rebuild) down.',
  ' */',
  'function recutChipSprites() {',
  '  if (!_chips) return;',
  '  for (let i = chipSprites.length - 1; i >= 0; i--) {',
  '    const { sprite, isGolden } = chipSprites[i];',
  '    if (!sprite || sprite.destroyed || !sprite.texture) { chipSprites.splice(i, 1); continue; }',
  '    try {',
  '      const t = sprite.__chipTier | 0 || 1;',
  '      sprite.texture = new (PIXI().Texture)(_chips.base,',
  '        new (PIXI().Rectangle)(t * _chips.w, (isGolden() ? 1 : 0) * _chips.h, _chips.w, _chips.h));',
  '    } catch { /* keep the old texture: a wrong-looking chip beats a frame that throws */ }',
  '  }',
  '}',
].join('\n');

/**
 * 登记表那一段（`TEX_UTIL_BLOCK` 的尾巴）：从 `/**` + ` * Every LIVE tier chip` 那一行到块尾。
 *
 * 从 `TEX_UTIL_BLOCK` 里**切**出来，不复制第二份字面量 —— 退役条目（见 `TEX_UTIL_REG_DUP`）要靠它逐字认人。
 */
const TEX_UTIL_REG_BLOCK = TEX_UTIL_BLOCK.slice(TEX_UTIL_BLOCK.indexOf('/**\n * Every LIVE tier chip'));

/**
 * **1.0.0 的重装事故**（退役条目，见 `TEXTURE_STALE` ⑤）：登记表在文件里出现两份。
 *
 * 怎么来的：`TEXTURE_STALE` ③ 那条 `[TEX_UTIL_ANCHOR, TEX_UTIL_DUP_BLOCK, '']` 没有 `when` 守卫（它的注释
 * 明明写着"必须先用 when 确认真的重复"）—— 于是**文件本来是对的**时候它也会开火：把规范块里的"两个小工具"
 * 那一段删掉，③ 再把 `anchor + 小工具 + 登记表` 整块插回锚点行，而原来那份登记表还留在文件里 ⇒
 * `const chipSprites = [];` 两份 ⇒ `SyntaxError: Identifier 'chipSprites' has already been declared`，
 * textures.js 一 import 就整层起不来。任何一次"因为别的原因而重装"都会踩到它（1.0.1 就是这么踩到的）。
 *
 * 这一条把"两份登记表"吃成一份（`when` 确认重复 ⇒ 健康的文件上永远空转）。
 */
const TEX_UTIL_REG_DUP = {
  when: (s) => countOf(s, 'const chipSprites = [];') > 1,
  probe: TEX_UTIL_REG_BLOCK,
  re: new RegExp(blockRe(TEX_UTIL_REG_BLOCK).source + '[\\s]*?' + blockRe(TEX_UTIL_REG_BLOCK).source),
};

/** `drawChips` 整段替换（旧 18 行 → 新 ~40 行）。 */
const TEX_DRAW_ANCHOR = [
  'function drawChips(c, w, h) {',
  '  c.clearRect(0, 0, w * 7, h * 2);',
  '  for (let g = 0; g < 2; g++) for (let t = 1; t <= 6; t++) {',
  '    const x = t * w, y = g * h;',
  '    c.save();',
  '    roundRect(c, x + 3, y + 3, w - 6, h - 6, 7);',
  '    const grad = c.createLinearGradient(0, y, 0, y + h);',
  "    if (g) { grad.addColorStop(0, '#ffe27a'); grad.addColorStop(1, '#d99a00'); }",
  "    else { grad.addColorStop(0, '#2c3335'); grad.addColorStop(1, '#111516'); }",
  '    c.fillStyle = grad; c.fill();',
  "    c.lineWidth = 2.5; c.strokeStyle = g ? '#fff3b8' : 'rgba(210,225,220,0.55)'; c.stroke();",
  "    c.fillStyle = g ? '#2a1a00' : '#f2f2f2';",
  '    c.font = `700 ${t >= 4 ? 24 : 27}px Bender, Oxanium, "Segoe UI", sans-serif`;',
  "    c.textAlign = 'center'; c.textBaseline = 'middle';",
  '    c.fillText(ROMAN[t], x + w / 2, y + h / 2 + 1.5);',
  '    c.restore();',
  '  }',
  '}',
].join('\n');
const TEX_DRAW_BLOCK = [
  'function drawChips(c, w, h) {',
  '  // Mod packages (sp-mods): the whole chip look is the `chip.*` knob group. Every default equals the literal that',
  '  // stood here before, so an instance with no package mounted draws the same pixels (reports/seam-style.md §5).',
  '  c.clearRect(0, 0, w * 7, h * 2);',
  '  const K = CHIP;',
  '  // One knob colour as a canvas style; `null` / `undefined` answers `null` instead of the string "null" (1.0.1).',
  '  // ⚠️ 1.0.0 passed the raw value to chipCssColor, `String(null)` is the string "null", assigning it to fillStyle /',
  '  // strokeStyle is a SILENT no-op — the canvas then keeps whatever paint was set last (the plate colour, and BLACK',
  '  // before any was set). A package that writes `strokeInk: null` / `textInk: null` ("unset — fall back") therefore',
  '  // got a pure black ring and a pure black numeral on a black plate: the whole chip was one black blob.',
  '  const css = (v) => (v == null || v === \'\' ? null : chipCssColor(v));',
  '  for (let g = 0; g < 2; g++) for (let t = 1; t <= 6; t++) {',
  '    const x = t * w, y = g * h;',
  '    // The TIER INK is the floor of the whole fallback chain (`ink1..ink6`, one per level), and it is what a package',
  '    // means by `null`: 「未设置、请回退」. Upstream sets every key, so this chain resolves to the shipped literals.',
  '    const tierInk = K[`ink${t}`];',
  '    // Ring / stroke: `strokeGold` (elite) or `strokeInk` (normal), else the tier ink.',
  '    const stroke = (g ? K.strokeGold : K.strokeInk) ?? tierInk;',
  '    // Numeral: `textGold` → the tier ink when `chip.textGoldTier` asks for it (`ink{t}` = the colour before the',
  '    // promotion) → `textInk` → the ring colour. `null` anywhere in that chain falls through to the next link.',
  '    const ink = ((g && K.textGoldTier === true) ? (tierInk ?? K.textInk) : (g ? (K.textGold ?? K.textInk) : K.textInk)) ?? stroke;',
  '    const glow = g ? (K.glowGold ?? K.glowInk) : K.glowInk;',
  '    c.save();',
  '    c.globalAlpha = K.plateAlpha;',
  '    const e = K.edge;',
  '    roundRect(c, x + e, y + e, w - e * 2, h - e * 2, K.radius);',
  '    const platePaint = g ? (K.plateGold ?? K.plate) : K.plate;',
  '    if (platePaint != null) { c.fillStyle = chipPlateFill(c, platePaint, y, y + h); c.fill(); }',
  '    const glowCss = css(glow);',
  '    if (K.glowPx > 0 && glowCss) {',
  '      // outer glow (upstream has none: glowPx defaults to 0): the same rounded path stroked once more, blurred',
  '      c.save();',
  '      c.shadowColor = glowCss;',
  '      c.shadowBlur = Math.min(K.glowPx, e);',
  '      c.globalAlpha = K.plateAlpha * K.glowAlpha;',
  '      c.lineWidth = K.stroke; c.strokeStyle = glowCss; c.stroke();',
  '      c.restore();',
  '    }',
  '    c.globalAlpha = K.plateAlpha;',
  '    const strokeCss = css(stroke);',
  '    if (strokeCss) { c.lineWidth = K.stroke; c.strokeStyle = strokeCss; c.stroke(); }',
  '    c.globalAlpha = 1;',
  '    const inkCss = css(ink) ?? strokeCss;',
  '    if (inkCss) c.fillStyle = inkCss;',
  '    c.font = `${K.fontWeight} ${t >= 4 ? K.fontNarrow : K.fontWide}px Bender, Oxanium, "Segoe UI", sans-serif`;',
  "    c.textAlign = 'center'; c.textBaseline = 'middle';",
  '    c.fillText(ROMAN[t], x + w / 2, y + h / 2 + 1.5);',
  '    c.restore();',
  '  }',
  '}',
].join('\n');
/**
 * 1.0.0 的 `drawChips`（退役用，见 TEXTURE_STALE ④）：逐个字面量与新版相同，只有"颜色回退链"是坏的 ——
 * `chipCssColor(null)` 得到字符串 `"null"`，赋给 `fillStyle` / `strokeStyle` 是**静默无效**，画布于是留着上一次的
 * 颜色（底板色；在它之前是画布默认的纯黑）。模组写 `strokeInk: null` / `textInk: null`（"未设置 ⇒ 回退该等级的
 * ink"）就得到"黑描边 + 黑数字 + 黑板" = 一整块黑。块正文变了 ⇒ `blockRe` 认不出它，必须在 `staleBlocks` 里逐字摘。
 */
const TEX_DRAW_BLOCK_100 = [
  'function drawChips(c, w, h) {',
  '  // Mod packages (sp-mods): the whole chip look is the `chip.*` knob group. Every default equals the literal that',
  '  // stood here before, so an instance with no package mounted draws the same pixels (reports/seam-style.md §5).',
  '  c.clearRect(0, 0, w * 7, h * 2);',
  '  const K = CHIP;',
  '  for (let g = 0; g < 2; g++) for (let t = 1; t <= 6; t++) {',
  '    const x = t * w, y = g * h;',
  '    // gold plate: `textGold` (its own colour) → `ink{t}` (the tier ink: what the numeral had before the promotion,',
  '    // only when `chip.textGoldTier` asks for it) → `strokeGold` (the ring colour, as shipped)',
  '    const ink = (g && K.textGoldTier === true)',
  '      ? (K[`ink${t}`] ?? K.textInk)',
  '      : (g ? (K.textGold ?? K.textInk) : K.textInk) ?? (g ? K.strokeGold : K.strokeInk);',
  '    c.save();',
  '    c.globalAlpha = K.plateAlpha;',
  '    const e = K.edge;',
  '    roundRect(c, x + e, y + e, w - e * 2, h - e * 2, K.radius);',
  '    c.fillStyle = chipPlateFill(c, g ? (K.plateGold ?? K.plate) : K.plate, y, y + h);',
  '    c.fill();',
  '    const glow = g ? (K.glowGold ?? K.glowInk) : K.glowInk;',
  '    if (K.glowPx > 0 && glow != null) {',
  '      // outer glow (upstream has none: glowPx defaults to 0): the same rounded path stroked once more, blurred',
  '      c.save();',
  '      c.shadowColor = chipCssColor(glow);',
  '      c.shadowBlur = Math.min(K.glowPx, e);',
  '      c.globalAlpha = K.plateAlpha * K.glowAlpha;',
  '      c.lineWidth = K.stroke; c.strokeStyle = chipCssColor(glow); c.stroke();',
  '      c.restore();',
  '    }',
  '    c.globalAlpha = K.plateAlpha;',
  '    c.lineWidth = K.stroke; c.strokeStyle = chipCssColor(g ? K.strokeGold : K.strokeInk); c.stroke();',
  '    c.globalAlpha = 1;',
  '    c.fillStyle = chipCssColor(ink);',
  '    c.font = `${K.fontWeight} ${t >= 4 ? K.fontNarrow : K.fontWide}px Bender, Oxanium, "Segoe UI", sans-serif`;',
  "    c.textAlign = 'center'; c.textBaseline = 'middle';",
  '    c.fillText(ROMAN[t], x + w / 2, y + h / 2 + 1.5);',
  '    c.restore();',
  '  }',
  '}',
].join('\n');

/** `refreshTierChips()` 之后追加"旋钮变了就重画"的订阅（含改格子尺寸时的重建）。 */
const TEX_REFRESH_ANCHOR = [
  'export function refreshTierChips() {',
  '  if (!_chips) return;',
  '  try {',
  '    drawChips(_chips.canvas.getContext(\'2d\'), _chips.w, _chips.h);',
  '    _chips.base.update();',
  '  } catch { /* keep the old glyphs */ }',
  '}',
].join('\n');
const TEX_REFRESH_BLOCK = [
  TEX_REFRESH_ANCHOR,
  '',
  '/**',
  ' * Redraw the chip atlas after a `chip.*` knob write (see public/js/mods/style.js).',
  ' *',
  ' * Two cases, and they are not the same work:',
  ' *   · COLOURS / fonts / plate alpha / glow / edges — a pure REPAINT. The canvas, the cell size and the BaseTexture',
  ' *     all stay, so the textures already handed to sprites keep working and every chip on screen picks the new look',
  ' *     up at once (upstream\'s own `refreshTierChips`, the path a late-landing web font already uses).',
  ' *   · `chip.width` / `chip.height` — the atlas GEOMETRY moved, and a chip texture is a `Rectangle` into that canvas',
  ' *     (`tierChip`), so every sprite cut so far now samples the wrong region. The canvas is resized in place, the',
  ' *     rectangle cache is dropped, and the registered sprites are re-cut from the same BaseTexture.',
  ' *',
  ' * A package that writes the two geometry knobs does it before the first frame (`main.js` loads packages before the',
  ' * first frame, `units.js` cuts the first chip later), where `_chips` is still null and the first atlas is simply',
  ' * drawn at the right size — the re-cut below is for a LIVE write.',
  ' */',
  'function rebuildChipsFromKnobs() {',
  '  if (!_chips) return;                       // no atlas yet: the first tierChip() draws it from the knobs anyway',
  '  if (CHIP.width === _chips.w && CHIP.height === _chips.h) { refreshTierChips(); return; }',
  '  try {',
  '    _chips.canvas.width = CHIP.width * 7;    // same canvas object: assigning the size resets it, drawChips repaints',
  '    _chips.canvas.height = CHIP.height * 2;',
  '    _chips.w = CHIP.width;',
  '    _chips.h = CHIP.height;',
  '    _chips.base.setSize(CHIP.width * 7, CHIP.height * 2, 1);',
  '    _chips.tex.clear();                      // the cached Rectangles point into the old layout',
  '    drawChips(_chips.canvas.getContext(\'2d\'), _chips.w, _chips.h);',
  '    _chips.base.update();',
  '    recutChipSprites();',
  '  } catch (e) {',
  '    console.error(\'[style] chip atlas rebuild failed; keeping the previous chips\', e);',
  '  }',
  '}',
  '',
  '/** Knob → atlas: one redraw per burst of writes (the engine merges them into one microtask). */',
  "onStyleChange((groups) => { if (groups.has('chip') || groups.has('*')) rebuildChipsFromKnobs(); });",
].join('\n');

/**
 * 静止指针（再部署时钟）的纹理：几何常量 + 懒建缓存。
 *
 * ⚠️ 锚点是 `let _rings = null;`（不是 `let _bg = null;`）—— 这段代码读 `RING_R` / `RING_W` / `RC`，而它们
 * 声明在 ring atlas 那一节（`let _rings = null;` 就在 `HUD_DISC` 之后一行）。插在 `let _bg = null;`（上游
 * 1119 行）时三个都是 `const`，模块求值到这里就是 TDZ：`ReferenceError: Cannot access 'RING_W' before
 * initialization` —— textures.js 整个模块 import 失败，units.js 接着报"没有这个导出"，**PIXI 层根本起不来**，
 * 页面退回 game.js 的简化视图（"渲染器暂时未能加载…"）。这个坑只有真开页面才会暴露，`node --check` 看不见。
 */
const TEX_HAND_MOVE_ANCHOR = 'let _rings = null;';
/** 上一版插错位置的旧块（见 applyHunks 的 `staleBlocks`）：读同样的常量、却插在 `let _bg = null;` 下面。 */
const TEX_HAND_STALE_ANCHOR = 'let _bg = null;';
const TEX_HAND_LINES = [
  '',
  '// ---- Mod packages (sp-mods): the STATIC hands of the redeploy clock (`down.face: \'clock\'`) ---------------------',
  '',
  '/**',
  ' * The clock hand\'s geometry, in the ring atlas\' own cell pixels (the frame is RC px across, the ring RC / 2 wide):',
  ' *',
  ' *   RING_HAND_W  the hand\'s thickness = the timing ring\'s visible band width. `RING_W` is the arc\'s stroke width and',
  ' *                the 2.5 px darker edge stroked under it straddles that band, 1.25 px each side — so the colour that',
  ' *                reads as "the ring" is RING_W - 2.5. Both live in a cell whose scale is (drawn diameter / RC), the',
  ' *                same convention as HUD_DISC, so the "in cell" width has to be multiplied by (2 * RING_R / RC) to',
  ' *                become a share of the ring\'s own diameter. Net effect: the hand is exactly as thick as the ring.',
  ' *   RING_HAND_A0 the hand starts at 0.62 * RING_R from the centre — in cell px, i.e. BEFORE the scale conversion, so',
  ' *                the two ends are stated where they are drawn. It ends at 1.25 * RING_R, i.e. inside the timing band',
  ' *                (the arc is stroked at RING_R ± 2.0 cell px: RING_R * 0.92 … RING_R * 1.08).',
  ' *   RING_HAND_AT the midpoint of the line the sprite holds, from the centre — the sprite is anchored THERE and',
  ' *                rotated about it, which is what puts both ends at the radii above.',
  ' */',
  'export const RING_HAND_W = (RING_W - 2.5) * (2 * RING_R / RC);',
  'export const RING_HAND_A0 = 0.62 * RING_R;',
  'export const RING_HAND_LEN = (1.25 - 0.62) * RING_R;',
  'export const RING_HAND_AT = (RING_HAND_A0 + (RING_HAND_A0 + RING_HAND_LEN)) / 2;',
  'const HAND_PX = Math.ceil(2 * (RING_HAND_A0 + RING_HAND_LEN) + RING_HAND_W);',
  'const _handTex = new Map();',
  '',
  '/**',
  ' * The texture of one redeploy-clock hand (built once per angle, reused by every knocked-out operator).',
  ' *',
  ' * A BARE arc stroke rather than a slice of the ring frames: those are white and carry a thin dark edge to stay',
  ' * readable on light ground, which down the middle of a clock hand would read as a drawn outline. The hand is built',
  ' * from the arc\'s own geometry instead — same stroke width, same round caps, same "white, tinted by the caller"',
  ' * convention — and the caller tints it with `down.handInk`.',
  ' *',
  ' * @param {number} angle radians, screen space (0 = right, +π/2 = DOWN): π = 9 o\'clock, 1.5π = 12 o\'clock',
  ' */',
  'export function hudHand(angle) {',
  '  const key = Math.round((angle / Math.PI) * 3600);',
  '  let tex = _handTex.get(key);',
  '  if (tex) return tex;',
  '  const P = PIXI();',
  '  const canvas = makeCanvas(HAND_PX, HAND_PX);',
  '  const c = canvas.getContext(\'2d\');',
  '  // the line is drawn at the canvas centre and the caller anchors the sprite at the line\'s midpoint',
  '  const cx = canvas.width / 2, cy = canvas.height / 2;',
  '  c.lineCap = \'round\';',
  '  c.strokeStyle = \'#ffffff\';',
  '  c.lineWidth = RING_HAND_W;',
  '  c.beginPath();',
  '  c.moveTo(cx + Math.cos(angle) * RING_HAND_A0, cy + Math.sin(angle) * RING_HAND_A0);',
  '  c.lineTo(cx + Math.cos(angle) * (RING_HAND_A0 + RING_HAND_LEN), cy + Math.sin(angle) * (RING_HAND_A0 + RING_HAND_LEN));',
  '  c.stroke();',
  '  tex = P.Texture.from(canvas);',
  '  _handTex.set(key, tex);',
  '  return tex;',
  '}',
  '',
  'let _clockFace = null;',
  '',
  '/**',
  ' * The clock face plate: a WHITE disc the caller tints with `down.faceInk` (a sprite\'s `tint` MULTIPLIES, so the',
  ' * ring\'s own `downDisc` — a dark radial gradient — can only ever be made darker, never light). Same cell and same',
  ' * radius as that disc, opaque in the middle and fading out at the rim so the timing ring keeps its edge.',
  ' */',
  'export function hudClockFace() {',
  '  if (_clockFace) return _clockFace;',
  '  const P = PIXI();',
  '  const canvas = makeCanvas(RC, RC);',
  '  const c = canvas.getContext(\'2d\');',
  '  const cx = RC / 2, cy = RC / 2;',
  '  const g = c.createRadialGradient(cx, cy, 2, cx, cy, RING_R + 3);',
  '  g.addColorStop(0, \'rgba(255,255,255,1)\');',
  '  g.addColorStop(0.84, \'rgba(255,255,255,0.98)\');',
  '  g.addColorStop(1, \'rgba(255,255,255,0)\');',
  '  c.fillStyle = g;',
  '  c.beginPath(); c.arc(cx, cy, RING_R + 3, 0, Math.PI * 2); c.fill();',
  '  _clockFace = P.Texture.from(canvas);',
  '  return _clockFace;',
  '}',
].join('\n');
const TEX_HAND_BLOCK = TEX_HAND_MOVE_ANCHOR + TEX_HAND_LINES;
/** 上一版插错位置的那一份（同样的行，只是锚点是 `let _bg = null;`）。 */
const TEX_HAND_STALE_BLOCK = TEX_HAND_STALE_ANCHOR + TEX_HAND_LINES;

/** textures.js 的六处 hunks（一条补丁一起装、一起摘）。 */
const TEXTURE_HUNKS = [
  { anchor: TEX_IMPORT_ANCHOR, block: TEX_IMPORT_BLOCK },
  { anchor: TEX_UTIL_ANCHOR, block: TEX_UTIL_BLOCK },
  { anchor: TEX_DRAW_ANCHOR, block: TEX_DRAW_BLOCK },
  { anchor: '    const w = 64, h = 44;', block: '    const w = CHIP.width, h = CHIP.height;' },
  { anchor: TEX_REFRESH_ANCHOR, block: TEX_REFRESH_BLOCK },
  { anchor: TEX_HAND_MOVE_ANCHOR, block: TEX_HAND_BLOCK },
];
/**
 * 退役的插入块（`applyHunks` 的 `staleBlocks`）：
 *   ① 静止指针那一节上一版插在 `let _bg = null;` 下面 —— 读 `RING_R` / `RING_W` / `RC` 却是 TDZ，整层起不来。
 *      块内容一字未改（只换了位置），所以新版块永远匹配不上旧的那份，必须单独摘。
 *   ② "整块换写法"的第二种退役：`rebuildChipsFromKnobs` 的旧版本（只 `refreshTierChips()`），新版要按
 *      几何/重绘分两路。旧块的首行就是上游锚点 `function rebuildChipsFromKnobs() {`，块内容变了 ⇒ 同样摘不到。
 *   ③ 同理的第三种：`let _chips = null;` 下面那一对小工具。代码一字没改，但新版把插入点从"锚点行之后"
 *      挪到了"登记表之后"（`const chipSprites = []` 与 `registerChipSprite` / `recutChipSprites` 夹在中间），
 *      于是旧的那一份留在文件**后面**：`blockRe` 只认整块逐字命中，新版块匹配不上它 —— 不摘就是两份
 *      `chipCssColor`，整个模块 `SyntaxError: Identifier 'chipCssColor' has already been declared`。
 *      这一条用 `when`（确认重复）+ `re`（吃掉第二份到 `drawChips` 之前），第三项 `''`：摘掉、不复制锚点。
 *      ⚠️ **2026-10-13 加上了 `when` 守卫**（1.0.0 发出去的那份没有，是个地雷）：`when` 判据是
 *      "`const chipCssColor = ` 出现两次以上"。没有它时，**健康的文件**上这一条也会开火（`includes(probe)`
 *      恒真），删掉规范块里的小工具、再让 ③ 把整块插回锚点 —— 原来的登记表留在后面成了第二份
 *      （见 ⑤ `TEX_UTIL_REG_DUP`），`SyntaxError: Identifier 'chipSprites' has already been declared`。
 *   ④ 1.0.1：`drawChips` 整个函数换了写法（颜色回退链把 `null` 当"未设置"）。同样"块正文变了 ⇒ 认不出旧的"，
 *      旧块必须在插入新版之前逐字摘掉、退回上游那 18 行，否则文件里会留下两份 `drawChips`
 *      （`SyntaxError: Identifier 'drawChips' has already been declared`，textures.js 一 import 就整层起不来）。
 *   ⑤ 1.0.1：③ 那条地雷已经炸出来的现场（两份登记表）—— 吃成一份，`when` 守卫保证健康文件上永远空转。
 */
const TEXTURE_STALE = [
  [TEX_HAND_STALE_ANCHOR, TEX_HAND_STALE_BLOCK],
  ['function rebuildChipsFromKnobs() {', [
    'function rebuildChipsFromKnobs() {',
    '  refreshTierChips();',
    '}',
  ].join('\n')],
  [TEX_UTIL_ANCHOR, {
    // ③ 只在**真的重复**时开火（判据与它的注释一致）：没有这一行，健康的文件会被它拆坏（见 ⑤）
    when: (s) => countOf(s, 'const chipCssColor = ') > 1,
    probe: TEX_UTIL_DUP_BLOCK,
    re: new RegExp(blockRe(TEX_UTIL_DUP_BLOCK).source + '[\\s\\S]*?(?=' + escRe('function drawChips(c, w, h) {') + ')'),
  }, ''],
  [TEX_DRAW_ANCHOR, TEX_DRAW_BLOCK_100],
  [TEX_UTIL_ANCHOR, TEX_UTIL_REG_DUP, TEX_UTIL_REG_BLOCK],
];

// ---- S3) public/js/render/fx/fonts.js：整个文件重写（21 → 约 60 行） ------------------------------------------------

/**
 * 上游 fonts.js 的"指纹"：去掉空行与纯注释行之后剩下的 14 行。整个文件是**整份替换**（不是 hunk 拼接），
 * 所以判据用"这 14 行逐字都在"而不是锚点唯一 —— 上游改了这个文件就拒绝，绝不半装。
 * 每一条都是 0.2.4 的原句（含那句"PIXI 7.4.2 遇 stroke:null 会抛"的血泪注释）。
 */
const FONTS_SIGNATURE = [
  "import { DMG_STYLE } from '../style.js';",
  'let fontsReady = false;',
  'export function ensureDamageFonts() {',
  '  if (fontsReady) return;',
  '  const P = globalThis.PIXI;',
  '  for (const st of Object.values(DMG_STYLE)) {',
  '    try {',
  '      P.BitmapFont.from(st.font, {',
  "        fontFamily: ['Bender', 'Oxanium', 'Rajdhani', 'Arial Black', 'sans-serif'], fontSize: 44, fontWeight: '700',",
  '        fill: st.fill, fillGradientStops: [0.25, 1], stroke: st.stroke, strokeThickness: 7,',
  "        dropShadow: true, dropShadowColor: '#000000', dropShadowAlpha: 0.45, dropShadowDistance: 2, dropShadowBlur: 2,",
  "      }, { chars: [['0', '9'], '+-×!'], resolution: 2, padding: 6 });",
  "    } catch (err) { console.warn('[fx] bitmap font', st.font, err?.message || err); }",
  '}',
];

const FONTS_SOURCE = [
  '// public/js/render/fx/fonts.js — damage-number bitmap fonts (one module-level ready flag).',
  '//',
  '// Mod packages (sp-mods): the face stack, the per-style fill and the flat/stroked paint come from the `dmg.*` knob',
  '// group (public/js/mods/style.js, re-exported by render/style.js) instead of being three literals in this file.',
  '// Every default equals the literal that stood here before, so an instance with no package mounted bakes the same',
  '// five fonts — `flat: false` keeps the two-stop gradient + stroke + drop shadow, `stroke: null` keeps each style\'s',
  '// own DMG_STYLE stroke (PIXI 7.4.2 throws on `stroke: null`, which is why the flat branch drops all three).',
  '// See reports/seam-style.md §3.5.',
  '',
  "import { DMG_STYLE, DMG } from '../style.js';",
  '',
  'let fontsReady = false;',
  '',
  '/** The font family stack: `dmg.font` when a package wrote one (a string or an array), else the shipped stack. */',
  'function faceStack() {',
  '  const v = DMG.font;',
  '  if (Array.isArray(v)) {',
  '    const list = v.filter((f) => typeof f === \'string\' && f.trim());',
  '    if (list.length) return list;',
  '  } else if (typeof v === \'string\' && v.trim()) {',
  '    return [v.trim()];',
  '  }',
  '  return [\'Bender\', \'Oxanium\', \'Rajdhani\', \'Arial Black\', \'sans-serif\'];',
  '}',
  '',
  '/**',
  ' * The paint of one damage style: `dmg.<key>Fill` replaces the style\'s gradient top; `dmg.flat` collapses the whole',
  ' * thing to that one colour with no stroke and no shadow; `dmg.stroke` overrides the style\'s own stroke.',
  ' */',
  'function paint(key, st) {',
  '  const top = DMG[`${key}Fill`];',
  '  const base = Array.isArray(st.fill) && st.fill.length ? st.fill : [\'#ffffff\'];',
  '  const flat = DMG.flat === true;',
  '  const fill = flat ? [top ?? base[0]] : (top == null || top === base[0] ? base : [top, base[1] ?? top]);',
  '  return { flat, fill, stroke: flat ? null : (DMG.stroke ?? st.stroke ?? null) };',
  '}',
  '',
  '/** Generate the damage-number bitmap fonts (after web fonts loaded, if possible). */',
  'export function ensureDamageFonts() {',
  '  if (fontsReady) return;',
  '  const P = globalThis.PIXI;',
  '  const fontFamily = faceStack();',
  '  for (const [key, st] of Object.entries(DMG_STYLE)) {',
  '    try {',
  '      const p = paint(key, st);',
  '      const opts = { fontFamily, fontSize: 44, fontWeight: \'700\', fill: p.fill };',
  '      if (!p.flat) {',
  '        if (p.fill.length > 1) opts.fillGradientStops = [0.25, 1];',
  '        // a `null` / empty stroke must NOT reach PIXI 7.4.2 (it throws) — a flat style has none by design',
  '        if (p.stroke) { opts.stroke = p.stroke; opts.strokeThickness = 7; }',
  '        opts.dropShadow = true; opts.dropShadowColor = \'#000000\'; opts.dropShadowAlpha = 0.45;',
  '        opts.dropShadowDistance = 2; opts.dropShadowBlur = 2;',
  '      }',
  '      P.BitmapFont.from(st.font, opts, { chars: [[\'0\', \'9\'], \'+-×!\'], resolution: 2, padding: 6 });',
  '    } catch (err) { console.warn(\'[fx] bitmap font\', st.font, err?.message || err); }',
  '  }',
  '  fontsReady = true;',
  '}',
  '',
  '/**',
  ' * Drop the baked fonts and bake them again from the CURRENT `dmg.*` knobs (the upstream file has no such function).',
  ' *',
  ' * `BitmapFont.from` on a name that already exists throws, so the old entry has to leave',
  ' * `PIXI.BitmapFont.available` first — and it has to be DESTROYED rather than forgotten, or its atlas texture stays',
  ' * on the GPU for the rest of the page\'s life. The live `BitmapText` objects keep their old atlas until they are',
  ' * reused, which is why the FxSystem wrapper (render/fx/system.js) drops the numbers in flight as well.',
  ' */',
  'export function rebuildDamageFonts() {',
  '  const P = globalThis.PIXI;',
  '  const avail = P && P.BitmapFont && P.BitmapFont.available;',
  '  if (avail) {',
  '    for (const st of Object.values(DMG_STYLE)) {',
  '      const f = avail[st.font];',
  '      if (!f) continue;',
  '      try { f.destroy?.(); } catch { /* the name still has to go */ }',
  '      delete avail[st.font];',
  '    }',
  '  }',
  '  fontsReady = false;',
  '  ensureDamageFonts();',
  '}',
  '',
].join('\n');

// ---- S4) public/js/render/units.js：再部署计时器的时钟盘面（并进已有的 render-unit-hud） ----------------------------

/** 中央标签那一行：加了 `clock` 判定（`'clock'` 时给出空串 ⇒ 共享标签纹理不换、精灵由下面那行隐藏）。 */
const DOWN_LABEL_ANCHOR = "    const label = counting ? String(Math.ceil(left - 1e-6)) : dn.state === DOWN_STATE.WAIT_DP ? 'DP' : '!';";
const DOWN_LABEL_BLOCK = [
  "    // Mod packages (sp-mods): `down.face` (public/js/mods/style.js, default 'number' = the countdown digits above).",
  "    // With 'clock' the middle shows no digits at all: the label stays '' and the sprite is hidden below. Anything",
  "    // other than the exact string 'clock' takes the upstream branch — that is what keeps an unset knob neutral.",
  "    const clock = DOWN.face === 'clock';",
  "    const label = clock ? '' : (counting ? String(Math.ceil(left - 1e-6)) : dn.state === DOWN_STATE.WAIT_DP ? 'DP' : '!');",
].join('\n');

/** 指针精灵：建一次、之后只改属性；`number` 档只把两个精灵藏起来（不销毁、不建）。 */
const DOWN_CLOCK_ANCHOR = '    r.text.scale.set((d * (label.length > 2 ? 0.34 : 0.44)) / 32);';
const DOWN_CLOCK_BLOCK = [
  DOWN_CLOCK_ANCHOR,
  "    if (clock) {",
  "      // Mod packages (sp-mods): two STATIC hands at 9:00 — the hour hand to the left (π), the minute hand up",
  "      // (1.5π). They never move: the ring under them is the timer (its arc still sweeps with the seconds left).",
  "      // Thickness: `RING_HAND_W` in textures.js (the timing ring's own visible band width). Colour: `down.handInk`",
  "      // (default the same white the countdown digits use). `down.faceInk` paints a face plate behind them when a",
  "      // package wants one (`null` = none, the hands sit on the disc the ring already draws).",
  "      // ⚠️ 容器只能走 `r.root`：`root` 是上面 `if (!r) { … }` 里的块级 `const`，出了那个块就不存在 ——",
  "      // 1.0.1 之前这里写的是裸 `root`，于是**第一个倒下的干员**开始每帧抛 `ReferenceError: root is not defined`：",
  "      // 那帧从 `_updateHud` 直接跳出（`fx.update(dt)` 在它后面），特效只出不清、画面看着卡死，战斗一结束又正常。",
  "      if (!r.hands) {",
  "        const P = this.P;",
  "        const mkHand = (tex) => { const sp = new P.Sprite(tex); sp.anchor.set(0.5); r.root.addChild(sp); return sp; };",
  "        r.hands = { hour: mkHand(hudHand(Math.PI)), minute: mkHand(hudHand(Math.PI * 1.5)), face: null };",
  "      }",
  "      if (DOWN.faceInk != null) {",
  "        // a WHITE plate texture tinted by the knob: a sprite's tint multiplies, so the ring's own dark disc could",
  "        // never be made light. Built lazily, once, and reused by every ring on the board.",
  "        if (!r.hands.face) {",
  "          const P = this.P;",
  "          r.hands.face = new P.Sprite(hudClockFace());",
  "          r.hands.face.anchor.set(0.5);",
  "          r.root.addChild(r.hands.face);",
  "        }",
  "        r.hands.face.tint = DOWN.faceInk; r.hands.face.scale.set(k); r.hands.face.visible = true;",
  "      } else if (r.hands.face) r.hands.face.visible = false;",
  "      const handInk = DOWN.handInk ?? 0xffffff;",
  "      // with a face plate the ring's inner edge is covered, so the hands pull in a little to keep their tips inside",
  "      const off = RING_HAND_AT * k * 2 * (DOWN.faceInk != null ? 0.92 : 1);",
  "      const h = r.hands.hour, m = r.hands.minute;",
  "      h.tint = handInk; m.tint = handInk;",
  "      h.scale.set(k); m.scale.set(k);",
  "      h.rotation = Math.PI; m.rotation = Math.PI * 1.5;",
  "      h.position.set(-off, 0); m.position.set(0, -off);",
  "    } else if (r.hands && r.hands.hour.visible) {",
  "      // back to the digits: hide the hands and the plate (nothing is destroyed — the sprites and their three",
  "      // textures are reused, so switching faces leaks neither a sprite nor a texture)",
  "      r.hands.hour.visible = false; r.hands.minute.visible = false;",
  "      if (r.hands.face) r.hands.face.visible = false;",
  "    }",
  "    r.text.visible = !clock;",
].join('\n');
/**
 * 1.0.0 / 1.0.1-rc 插在这里的正文（退役用）：**裸 `root`** —— 那块级 `const` 只活在 `if (!r) { … }` 里，
 * 出了那个块就是 `ReferenceError`。块正文变了（两处 `root.addChild` → `r.root.addChild`）⇒ `blockRe` 认不出旧的，
 * 必须在插入新版之前逐字摘掉，否则文件里会留下两份 `if (clock) { … }`（旧的那份每次都会抛）。
 */
const DOWN_CLOCK_BLOCK_100 = [
  DOWN_CLOCK_ANCHOR,
  "    if (clock) {",
  "      // Mod packages (sp-mods): two STATIC hands at 9:00 — the hour hand to the left (π), the minute hand up",
  "      // (1.5π). They never move: the ring under them is the timer (its arc still sweeps with the seconds left).",
  "      // Thickness: `RING_HAND_W` in textures.js (the timing ring's own visible band width). Colour: `down.handInk`",
  "      // (default the same white the countdown digits use). `down.faceInk` paints a face plate behind them when a",
  "      // package wants one (`null` = none, the hands sit on the disc the ring already draws).",
  "      if (!r.hands) {",
  "        const P = this.P;",
  "        const mkHand = (tex) => { const sp = new P.Sprite(tex); sp.anchor.set(0.5); root.addChild(sp); return sp; };",
  "        r.hands = { hour: mkHand(hudHand(Math.PI)), minute: mkHand(hudHand(Math.PI * 1.5)), face: null };",
  "      }",
  "      if (DOWN.faceInk != null) {",
  "        // a WHITE plate texture tinted by the knob: a sprite's tint multiplies, so the ring's own dark disc could",
  "        // never be made light. Built lazily, once, and reused by every ring on the board.",
  "        if (!r.hands.face) {",
  "          const P = this.P;",
  "          r.hands.face = new P.Sprite(hudClockFace());",
  "          r.hands.face.anchor.set(0.5);",
  "          root.addChild(r.hands.face);",
  "        }",
  "        r.hands.face.tint = DOWN.faceInk; r.hands.face.scale.set(k); r.hands.face.visible = true;",
  "      } else if (r.hands.face) r.hands.face.visible = false;",
  "      const handInk = DOWN.handInk ?? 0xffffff;",
  "      // with a face plate the ring's inner edge is covered, so the hands pull in a little to keep their tips inside",
  "      const off = RING_HAND_AT * k * 2 * (DOWN.faceInk != null ? 0.92 : 1);",
  "      const h = r.hands.hour, m = r.hands.minute;",
  "      h.tint = handInk; m.tint = handInk;",
  "      h.scale.set(k); m.scale.set(k);",
  "      h.rotation = Math.PI; m.rotation = Math.PI * 1.5;",
  "      h.position.set(-off, 0); m.position.set(0, -off);",
  "    } else if (r.hands && r.hands.hour.visible) {",
  "      // back to the digits: hide the hands and the plate (nothing is destroyed — the sprites and their three",
  "      // textures are reused, so switching faces leaks neither a sprite nor a texture)",
  "      r.hands.hour.visible = false; r.hands.minute.visible = false;",
  "      if (r.hands.face) r.hands.face.visible = false;",
  "    }",
  "    r.text.visible = !clock;",
].join('\n');

/** units.js：时钟盘面的 hunks（并进 UNIT_HUNKS）。textures.js 的 import 由 `UNIT_STYLE_TEX_BLOCK` 一并加名字。 */
const DOWN_FACE_HUNKS = [
  { anchor: DOWN_LABEL_ANCHOR, block: DOWN_LABEL_BLOCK },
  { anchor: DOWN_CLOCK_ANCHOR, block: DOWN_CLOCK_BLOCK },
];

// ---- units.js：field:unitMotion（每帧每个单位一次的身体 / 影子落点与朝向）------------------------------------------
//
// 一个接缝、三处应用点（都在 `UnitView.update(dt, cam, t)` 里，紧跟"上游把 z / hover / lift 缓动完"之后）：
//   · 身体高度：`cam.project(…, this.z + this.hover + this.lift, this.screen)` 的高度项换成模组答案；
//   · 水平锚点：`let bx = p.x` 之后（在 lunge 抖动之后，模组的显式答案该压过它）；
//   · 朝向：`const flip = …visFacing…` 之前把 `motion.face` 写进 `visFacing`（不动 `this.dir` / `this.facing`，
//     所以不会触发 Front⇄Back 换模型 —— 这是 CoreBehaviourFixes「攻击其他方向的敌人时转身」要的性质）；
//   · 影子：`const shz = this.shadowZ ?? this.z;` 换成模组答案（`Number.isFinite` 才算数，`null` 保持出厂）。
//
// ⚠️ 锚点都**避开** `const hoverTo = … ? FLY_HOVER : 0;` 那一行 —— 上一节 UNIT_STYLE_SUBS 会把 `FLY_HOVER`
//    换成 `FLY.altitude`，把这一行写进锚点会让两条 hunk 互相改写（见 UNIT_HUNKS 的顺序约定①）。
//
// 为什么值一条接缝：CoreBehaviourFixes 2.3.1 用 `field:unitMotion` 做两件事 —— 飞行体按自己的高度悬浮（其影子留在地面）
// 与"攻击其他方向的敌人时把模型转过去"。0.2.4 的 `units.js` 里这三处与一代 overlay 的形状一致，`groundZ(ctx, x, y)`
// 甚至是同一个导出，所以这是**薄接缝**，不是一代那种整文件覆盖。

const UNIT_MOTION_BODY_ANCHOR = [
  '    if (this.hover !== hoverTo) this.hover = Math.abs(hoverTo - this.hover) < 1e-3 ? hoverTo : this.hover + (hoverTo - this.hover) * Math.min(1, dt * 6);',
  '    const p = cam.project(this.x, this.y, this.z + this.hover + this.lift, this.screen);',
].join('\n');
const UNIT_MOTION_BODY_BLOCK = [
  '    if (this.hover !== hoverTo) this.hover = Math.abs(hoverTo - this.hover) < 1e-3 ? hoverTo : this.hover + (hoverTo - this.hover) * Math.min(1, dt * 6);',
  '    // Mod packages (sp-mods): `field:unitMotion` — where this body and its shadow are drawn, and which way it faces.',
  '    // The shipped values are what the lines above computed; a package may answer `{ bodyZ, screenX, face, shadowZ }`',
  '    // (a flyer that floats at an altitude of its own, a model that faces what it hits). `t` is the game clock, `ground`',
  '    // the tile top under the unit (the same `groundZ` the shipped placement uses). With nobody registered this is one',
  '    // Map lookup and `motion` is null — every expression below is then the shipped one.',
  '    const motion = modRender.unitMotion(this, dt, cam, t, groundZ(this.ctx, this.x, this.y));',
  '    const p = cam.project(this.x, this.y, motion && motion.bodyZ != null ? motion.bodyZ : this.z + this.hover + this.lift, this.screen);',
].join('\n');

const UNIT_MOTION_X_ANCHOR = [
  '    let bx = p.x, by = p.y;',
  '    if (lungeK) { const q = cam.project(this.x + lx, this.y + ly, this.z + this.hover + this.lift, LG_P); bx = q.x; by = q.y; }',
  '    this.root.position.set(bx, by);',
].join('\n');
const UNIT_MOTION_X_BLOCK = [
  '    let bx = p.x, by = p.y;',
  '    if (lungeK) { const q = cam.project(this.x + lx, this.y + ly, this.z + this.hover + this.lift, LG_P); bx = q.x; by = q.y; }',
  '    // Mod packages (sp-mods): `field:unitMotion`, `screenX` — the horizontal anchor of a raised body. A tilted camera',
  '    // scales every world point away from its centre, so a body drawn at an altitude gets dragged sideways unless the',
  '    // anchor stays the GROUND point of its tile; a package that lifts a model answers this. After `lungeK` on purpose:',
  '    // an explicit answer beats the shipped jolt. `null` = keep the shipped `bx`.',
  '    if (motion && motion.screenX != null) bx = motion.screenX;',
  '    this.root.position.set(bx, by);',
].join('\n');

const UNIT_MOTION_FACE_ANCHOR = '    const flip = (this.isEnemy ? (ENEMY_MODEL_FACES_LEFT ? -this.visFacing : this.visFacing) : this.visFacing) * (this.mirrorX ? -1 : 1);';
const UNIT_MOTION_FACE_BLOCK = [
  '    // Mod packages (sp-mods): `field:unitMotion`, `face` — only `visFacing` is written, never `dir` / `facing`: those',
  '    // two pick the model (Front ⇄ Back), a flip does not. `0` (or absent) leaves the shipped facing alone.',
  '    if (motion && motion.face) this.visFacing = motion.face;',
  UNIT_MOTION_FACE_ANCHOR,
].join('\n');

const UNIT_MOTION_SHADOW_ANCHOR = [
  '    const shz = this.shadowZ ?? this.z;',
  '    placeOnGround(this.ctx, this.shadow, this.ctx.layers.shadow, this.y, shz);',
].join('\n');
const UNIT_MOTION_SHADOW_BLOCK = [
  '    // Mod packages (sp-mods): `field:unitMotion`, `shadowZ` — where the shadow is dropped. A body that owns an altitude',
  '    // (see `bodyZ` above) keeps its shadow on the surface below it instead of on its own tile top. Only a finite answer',
  '    // counts: `null` keeps the shipped `this.shadowZ ?? this.z`.',
  '    const shz = motion && Number.isFinite(motion.shadowZ) ? motion.shadowZ : (this.shadowZ ?? this.z);',
  '    placeOnGround(this.ctx, this.shadow, this.ctx.layers.shadow, this.y, shz);',
].join('\n');

/** units.js：field:unitMotion 的 hunks（并进 UNIT_HUNKS）。 */
const UNIT_MOTION_HUNKS = [
  { anchor: UNIT_MOTION_BODY_ANCHOR, block: UNIT_MOTION_BODY_BLOCK },
  { anchor: UNIT_MOTION_X_ANCHOR, block: UNIT_MOTION_X_BLOCK },
  { anchor: UNIT_MOTION_FACE_ANCHOR, block: UNIT_MOTION_FACE_BLOCK },
  { anchor: UNIT_MOTION_SHADOW_ANCHOR, block: UNIT_MOTION_SHADOW_BLOCK },
];

// ---- units.js：field:attack 的**宣布**（每次攻击一次；**计划**那半边在 render/spine.js，见 7b）----------------------
//
// 一条钩子、两半调用（一代就是这么分的，二代照搬落点、只改签名）：
//   · 宣布（这里，`onAttack`）："这个单位刚打了一下，打的是谁"；
//   · 计划（`render/spine.js` 的 `windUp` / `attack`）："这一挥的 clip 怎么起手、攻击态多长"。
// 一代的宣布用 `emit`（handler 只收到 **1 个**参数 = ctx），计划用 `run`（`(value, ctx)`）—— 按 `(value, ctx)` 写的
// handler 在宣布那半边**永远读不到 ctx**（一代的真 bug，`CoreBehaviourFixes` 的转身就是被它坑掉的）。二代两处都用
// `run`，ctx 归一化在 `files/public/js/mods/render.js` 的 `attackNotice` / `attackClipPlan` 里。
//
// 三处必须**一起**改（少一处就是半装状态，`once` 判据把三处一起验）：
//   ① `onAttack` 里插宣布调用（锚点含它下面那行 `attack`，所以这两处是一条 hunk）；
//   ② `this.actor.attack(this.atkInterval, once)` → 多传一个 `this`；
//   ③ `this.actor.windUp(this.atkInterval, lead, …)` → 同样多传一个 `this`。
// ②③ 传的 `this` 就是 `render/spine.js` 那两个方法的 `view` 形参：模组要从它读 `flags`（快照里打包的攻击节奏，
// 见 `files/public/js/mods/render.js` 的 `rhythmOf`），也要拿它当"是哪个单位"的凭据。

const UNIT_ATTACK_ANCHOR = [
  '    if (target) {',
  '      const dx = target.x - this.x, dy = target.y - this.y, len = Math.hypot(dx, dy) || 1;',
  '      this.lungeDir.x = dx / len; this.lungeDir.y = dy / len;',
  '    }',
  '    this.lunge = 1;',
  "    if (this.actor) this.actor.attack(this.atkInterval, once); // game seconds: the actor's clock runs in game time",
].join('\n');
const UNIT_ATTACK_BLOCK = [
  '    if (target) {',
  '      const dx = target.x - this.x, dy = target.y - this.y, len = Math.hypot(dx, dy) || 1;',
  '      this.lungeDir.x = dx / len; this.lungeDir.y = dy / len;',
  '    }',
  '    this.lunge = 1;',
  '    // Mod packages (sp-mods): `field:attack`, the ANNOUNCEMENT — "this unit just attacked, and this is what it',
  '    // hit". One call per attack; the guard, the ctx and the `run`-not-`emit` choice live in',
  '    // files/public/js/mods/render.js, so with no package mounted this is ONE Map lookup and nothing is allocated.',
  '    // The ctx carries no `phase` — that is how a handler tells this half apart from the clip plan below.',
  '    modRender.attackNotice(this, target, kind, once, now);',
  "    if (this.actor) this.actor.attack(this.atkInterval, once, this); // game seconds: the actor's clock runs in game time",
].join('\n');

const UNIT_WINDUP_ANCHOR = '    const ok = this.actor.windUp(this.atkInterval, lead, !!PROJ[kind]?.once);';
const UNIT_WINDUP_BLOCK = [
  '    // Mod packages (sp-mods): the fourth argument is this view — `render/spine.js windUp` hands it to the',
  '    // `field:attack` clip-plan seam (see the ANNOUNCEMENT above; both halves share one signature).',
  '    const ok = this.actor.windUp(this.atkInterval, lead, !!PROJ[kind]?.once, this);',
].join('\n');

/** units.js：field:attack 宣布的两条 hunk（三处改动；并进 UNIT_HUNKS，排在最后）。 */
const UNIT_ATTACK_HUNKS = [
  { anchor: UNIT_ATTACK_ANCHOR, block: UNIT_ATTACK_BLOCK },
  { anchor: UNIT_WINDUP_ANCHOR, block: UNIT_WINDUP_BLOCK },
];


/**
 * units.js 的 hunks。**顺序是这份表最讲究的地方**，两条约束同时成立：
 *   ① `applyHunks` 的 `once` 判据要求"每条 hunk 的 block 逐字都在正文里"—— 所以**任何 block 都不允许被后面的
 *      hunk 改写**。凡是要改到某个接缝块**内部**那一行的旋钮（条长上限、护盾细线、等级牌缩放），都要并进那条
 *      接缝块本身（改 block 文本），或排在它**之前**改上游原句。
 *   ② 反过来，接缝块的 **anchor** 是上游原句，所以旋钮替换只能碰 anchor 之外的区域 —— 由 ① 的顺序保证。
 */
const UNIT_HUNKS = [
  // ① 两个 import：先立名字（hook 插块与旋钮替换都要用）
  { anchor: UNIT_IMPORT_ANCHOR, block: UNIT_IMPORT_BLOCK },
  { anchor: UNIT_STYLE_IMPORT_ANCHOR, block: UNIT_STYLE_IMPORT_BLOCK },
  { anchor: UNIT_STYLE_TEX_ANCHOR, block: UNIT_STYLE_TEX_BLOCK },
  // ② 会落进接缝块内部的旋钮替换 —— 必须在接缝块之前。
  //    ⚠️ 只有护盾细线那一处落在锚点**之外**（它在 `UNIT_HP_ANCHOR` 的下方）；等级牌缩放的 `/ 44`
  //    在 `UNIT_CHIP_ANCHOR` 的三行**之内**，所以那一处并进了 `UNIT_CHIP_BLOCK` 的正文，不在这里替换。
  { anchor: 'this.shieldBar.position.set(x0, cy - bh / 2 - 1); this.shieldBar.width = bw; this.shieldBar.height = Math.max(1.5, bh * 0.35);',
    block: 'this.shieldBar.position.set(x0, cy - bh / 2 - SHIELD.lineOffset); this.shieldBar.width = bw;'
      + ' this.shieldBar.height = Math.max(1.5, bh * SHIELD.lineWidth);' },
  // ③ HUD 接缝（钩子）：整段包住上面那一行（锚点仍是上游原句 —— bars 两行、HP 四行、chip 三行）。
  //    `UNIT_BARS_BLOCK` 的正文里已经写好了 `HUD.maxBoss / maxEnemy / maxAlly`（见该常量的定义）。
  { anchor: UNIT_BARS_ANCHOR, block: UNIT_BARS_BLOCK },
  { anchor: UNIT_HP_ANCHOR, block: UNIT_HP_BLOCK },
  { anchor: UNIT_SP_ANCHOR, block: UNIT_SP_BLOCK },
  { anchor: UNIT_CHIP_ANCHOR, block: UNIT_CHIP_BLOCK },
  { anchor: UNIT_CHIP_REG_ANCHOR, block: UNIT_CHIP_REG_BLOCK },
  { anchor: UNIT_CHIP_UNREG_ANCHOR, block: UNIT_CHIP_UNREG_BLOCK },
  // ④ 其余旋钮替换（都不落在任何接缝块内部）
  { anchor: UNIT_DOWNLOOK_ANCHOR, block: UNIT_DOWNLOOK_BLOCK },
  ...UNIT_STYLE_SUBS.map(([from, to]) => ({ anchor: from, block: to })),
  // ④b field:unitMotion 的四处（锚点都避开 ③④ 改写过的那一行 —— 见 UNIT_MOTION_HUNKS 的说明）
  ...UNIT_MOTION_HUNKS,
  // ⑤ 再部署时钟（down.face）：标签行 + 指针
  ...DOWN_FACE_HUNKS,
  // ⑥ field:attack 的宣布两处（三处改动）—— **排在最后**：没有任何后续 hunk 会碰 `onAttack` 那几行，
  //    于是"block 不被后面的 hunk 改写"这条约束自动成立（见上面那张表的两条约束）。
  ...UNIT_ATTACK_HUNKS,
];
// =================================================================================================================
// 9b) public/js/render/spine.js：field:attack 的**计划**（`windUp` / `attack` 两处）
//
// 一条接缝、两处调用点（都在 `SpineActor` 上；`view` 由 units.js 的两个包装方法传进来，见 9) 的宣布那一段）：
//   · `windUp(interval, lead, once, view)` —— 提前起手那一帧（`app.js windUpAttacks` 每帧对 1.5 s 内待办的 'atk' 问一次）；
//   · `attack(interval, once, view)`       —— 'atk' 事件帧。
//
// 它回答的是什么（守卫、ctx、归一化都在 files/public/js/mods/render.js 的 `attackClipPlan`）：
//   `start`    从第几帧起手（`null` = 还没到，`windUp` 于是返回 false、下一帧再问）；
//   `timeScale` 这一挥的播放速度；`ts` 起手交回节奏时用的速度（`windUntil` 那一步）；
//   `once`     只播一遍（不循环，末帧定住到攻击态到期）；`hold` **攻击态**从攻击事件起算多长；
//   `rephase`  事件帧那一步闭合多少相位误差（上游是 0.8，`0` = 别动我的轨道）。
//
// ⚠️ 没装包时**逐字等价**于 0.2.4：`modRender.attackClipPlan` 在第一次查表就返回 `null`，随后每一处都回落到上游自己
// 的值（`plan.tsWind` / `plan.ts` / `plan.start` / `ts` / `Math.max(0.45, …)` / 重相位的 `0.8`），而且**不为此分配任何
// 对象**（`mp === null` 的三个分支都是纯读）。这条是本接缝的验收硬指标：没模组 = 与上游一致。
//
// ⚠️ 这里**没有**引入任何新状态。一代那套「攻击编排」（`spine.js` 里约 200 行 + `_swing` / `_glide` / `_modOnce`
// 三个字段 + `update()` 里的滑行消费段）**不搬** —— 见 reports/seam-units.md §7 与 AGENTS §0b 第 3 条：那套东西单独搬
// 会让 `_glide` 永远不清零（攻击态卡死），而 `--check` 一律放过。`forbid` 里明确拒绝它们的形状。
//
// ⚠️ `attack()` 里 `wasAttacking` / `whole` / `single` 三条分支与本接缝交叉：`single` 决定「播一遍还是循环」，
// `hold` 决定攻击态何时到期，`rephase` 只影响**非** single 那一支的相位闭合。`whole` 从 `if (!wasAttacking)` 分支里
// 提到了 `hit` 之后（纯读 `this.interval`，等价），因为 ctx 的 `shipped.start` 要用它。

const SPINE_IMPORT_ANCHOR = 'const clampN = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);';
const SPINE_IMPORT_BLOCK = [
  '// Mod packages (sp-mods): the `field:attack` clip-plan seam. Every decision (the guard, the context object, the',
  '// normalisation of the answer) lives in files/public/js/mods/render.js — a file the loader owns and can replace at',
  '// will; this file keeps one import, the one-line adapter `modAttackPlan` below, and one call per question.',
  "import * as modRender from '../mods/render.js';",
  '',
  SPINE_IMPORT_ANCHOR,
].join('\n');

const SPINE_PLAN_ANCHOR = [
  '  return { ts, tsWind, start };',
  '}',
].join('\n');
const SPINE_PLAN_BLOCK = [
  '  return { ts, tsWind, start };',
  '}',
  '',
  '/**',
  ' * Mod packages (sp-mods): the `field:attack` CLIP PLAN of one swing. `shipped` is what this file\'s own',
  ' * `windUpPlan` worked out (`start` / `timeScale` = `tsWind` / `ts`); a package may override any of it, and may',
  ' * answer `once` / `hold` / `rephase` on top (the contract is documented in files/public/js/mods/render.js',
  ' * `attackClipPlan`).',
  ' *',
  ' * With nobody mounted `modRender.attackClipPlan` returns `null` on its first lookup and every call site falls back',
  ' * to the shipped value — byte for byte the 0.2.4 behaviour, and not a single object is allocated for it.',
  ' *',
  ' * @returns {{start: (number|null), timeScale: number, ts: number, hold: (number|null), once: boolean,',
  ' *   rephase: (number|null)}|null} `null` = "keep the shipped values"',
  ' */',
  'function modAttackPlan(view, phase, loopDur, hit, interval, lead, start, timeScale, ts) {',
  '  return view ? modRender.attackClipPlan(view, phase, loopDur, hit, interval, lead, start, timeScale, ts) : null;',
  '}',
].join('\n');

const SPINE_WINDUP_SIG_ANCHOR = '  windUp(interval, lead, once = false) {';
const SPINE_WINDUP_SIG_BLOCK = [
  '  // Mod packages (sp-mods): the fourth argument is the unit view (`units.js` passes `this`), which the',
  '  // `field:attack` clip-plan seam needs for the packed attack rhythm in its `flags`. A caller without one passes',
  '  // nothing and gets the shipped plan (see `modAttackPlan`).',
  '  windUp(interval, lead, once = false, view = null) {',
].join('\n');

const SPINE_WINDUP_ANCHOR = [
  '    // clip per attack: its own speed, sped up only when the attacks come quicker than the clip',
  '    const plan = windUpPlan(loopDur, hit, this.clipPerAttack && !once ? Math.min(iv, loopDur) : iv, lead);',
  '    if (!(hit > 0) || lead * plan.ts > hit + 1e-6) return false;',
  '    if (!once) this.interval = iv;',
  '    this.mode = \'attack\';',
  '    this.attackUntil = this.clock + lead + (single ? Math.max(0, loopDur - hit) / plan.ts : Math.max(0.45, iv * 1.4));',
  '    this._play(clip.loop, !single, { timeScale: plan.tsWind, start: plan.start, mix: 0.06 });',
  '    this.windTs = plan.ts;',
].join('\n');
const SPINE_WINDUP_BLOCK = [
  '    // clip per attack: its own speed, sped up only when the attacks come quicker than the clip',
  '    const plan = windUpPlan(loopDur, hit, this.clipPerAttack && !once ? Math.min(iv, loopDur) : iv, lead);',
  '    // Mod packages (sp-mods): `field:attack` — the clip plan of this wind-up. `shipped` is what `windUpPlan` just',
  '    // worked out; a package may answer `start: null` = "not yet" (this call then returns false and',
  '    // `app.js windUpAttacks` asks again on the next frame), or take the swing over: `start` / `timeScale` / `ts`,',
  '    // `once` (play the clip once) and `hold` = how long the ATTACK STATE lasts, measured from the attack EVENT.',
  '    // `mp === null` = nobody mounted, and then every value below is the shipped one (`plan.*`, `single`, and the',
  '    // two `Math.max(...)` lengths) — no object is allocated on that path.',
  '    const mp = modAttackPlan(view, \'windUp\', loopDur, hit, iv, lead,',
  '      hit > 0 && lead * plan.ts <= hit + 1e-6 ? plan.start : null, plan.tsWind, plan.ts);',
  '    if (!(hit > 0) || (mp ? mp.start == null : lead * plan.ts > hit + 1e-6)) return false;',
  '    const mStart = mp ? mp.start : plan.start;',
  '    const mScale = mp ? mp.timeScale : plan.tsWind;',
  '    const mTs = mp ? mp.ts : plan.ts;',
  '    const mHold = mp ? mp.hold : null;',
  '    if (!once) this.interval = iv;',
  '    this.mode = \'attack\';',
  '    this.attackUntil = this.clock + lead + (mHold != null ? mHold',
  '      : (single ? Math.max(0, loopDur - hit) / mTs : Math.max(0.45, iv * 1.4)));',
  '    this._play(clip.loop, !(single || (mp ? mp.once : false)), { timeScale: mScale, start: mStart, mix: 0.06 });',
  '    this.windTs = mTs;',
].join('\n');

const SPINE_ATTACK_SIG_ANCHOR = '  attack(interval, once = false) {';
const SPINE_ATTACK_SIG_BLOCK = [
  '  // Mod packages (sp-mods): the fourth argument is the unit view — same seam, same shape as `windUp` above.',
  '  attack(interval, once = false, view = null) {',
].join('\n');

const SPINE_ATTACK_PLAN_ANCHOR = [
  '    // (a clip-per-attack actor still playing the previous attack\'s clip was not wound up for this one)',
  '    const wasAttacking = this.mode === \'attack\' && this.current === clip.loop && (!per || this.wound);',
  '    this.mode = \'attack\';',
  '    this.attackUntil = this.clock + (single ? Math.max(0, loopDur - hit) / ts : Math.max(0.45, this.interval * 1.4));',
  '    this.windUntil = null;',
  '    this.wound = false;',
].join('\n');
const SPINE_ATTACK_PLAN_BLOCK = [
  '    // (a clip-per-attack actor still playing the previous attack\'s clip was not wound up for this one)',
  '    const wasAttacking = this.mode === \'attack\' && this.current === clip.loop && (!per || this.wound);',
  '    // Mod packages (sp-mods): `field:attack` — the plan of the swing that just happened (the event frame). `whole`',
  '    // is computed here instead of inside the `!wasAttacking` branch below: it is a pure read of `this.interval`, and',
  '    // the shipped `start` handed to a package depends on it. `mp === null` = nobody mounted ⇒ the shipped values.',
  '    const whole = per && this.interval >= loopDur;',
  '    const mp = modAttackPlan(view, \'attack\', loopDur, hit, once ? loopDur : this.interval, 0, whole ? 0 : hit, ts, ts);',
  '    const mSingle = single || (mp ? mp.once : false);',
  '    const mScale = mp ? mp.timeScale : ts;',
  '    const mTs = mp ? mp.ts : ts;',
  '    const mHold = mp ? mp.hold : null;',
  '    const mRephase = mp && mp.rephase != null ? mp.rephase : 0.8;',
  '    this.mode = \'attack\';',
  '    this.attackUntil = this.clock + (mHold != null ? mHold',
  '      : (mSingle ? Math.max(0, loopDur - hit) / mTs : Math.max(0.45, this.interval * 1.4)));',
  '    this.windUntil = null;',
  '    this.wound = false;',
].join('\n');

const SPINE_ATTACK_BRANCH_ANCHOR = [
  '    if (!wasAttacking) {',
  '      // not wound up (no look-ahead, e.g. a batch that arrived late): the sim already resolved the hit, so show the',
  '      // strike frame now — unless a clip-per-attack actor\'s rhythm leaves room for the whole clip (interval ≥ clip):',
  '      // then the clip plays complete from its wind-up at its own speed, the strike a little late (重犯\'s iron ball',
  '      // lifts before the slam; #246 by @TsangAsuna, accepted by the owner on 2026-10-07)',
  '      const whole = per && this.interval >= loopDur;',
  '      if (whole) this.attackUntil = this.clock + loopDur / ts;',
  '      this._play(clip.loop, !single, { timeScale: ts, start: whole ? 0 : hit, mix: 0.06 });',
  '    } else if (single) {',
  '      const e = this.spine.state.tracks[0];',
  '      if (e) e.timeScale = ts;',
  '    } else {',
  '      const e = this.spine.state.tracks[0];',
  '      if (e) {',
  '        e.timeScale = ts;',
  '        // re-phase gently so the strike frame lines up with this attack',
  '        const t = e.trackTime % loopDur;',
  '        let d = hit - t;',
  '        if (d > loopDur / 2) d -= loopDur; else if (d < -loopDur / 2) d += loopDur;',
  '        e.trackTime += d * 0.8;',
  '      }',
  '    }',
].join('\n');
const SPINE_ATTACK_BRANCH_BLOCK = [
  '    if (!wasAttacking) {',
  '      // not wound up (no look-ahead, e.g. a batch that arrived late): the sim already resolved the hit, so show the',
  '      // strike frame now — unless a clip-per-attack actor\'s rhythm leaves room for the whole clip (interval ≥ clip):',
  '      // then the clip plays complete from its wind-up at its own speed, the strike a little late (重犯\'s iron ball',
  '      // lifts before the slam; #246 by @TsangAsuna, accepted by the owner on 2026-10-07)',
  '      // Mod packages (sp-mods): a package that answered `hold` owns the attack state (it measured the window itself).',
  '      if (mHold == null && whole) this.attackUntil = this.clock + loopDur / mTs;',
  '      this._play(clip.loop, !mSingle, { timeScale: mScale, start: mp && mp.start != null ? mp.start : (whole ? 0 : hit), mix: 0.06 });',
  '    } else if (mSingle) {',
  '      const e = this.spine.state.tracks[0];',
  '      if (e) e.timeScale = mScale;',
  '    } else {',
  '      const e = this.spine.state.tracks[0];',
  '      if (e) {',
  '        e.timeScale = mScale;',
  '        // re-phase gently so the strike frame lines up with this attack',
  '        const t = e.trackTime % loopDur;',
  '        let d = hit - t;',
  '        if (d > loopDur / 2) d -= loopDur; else if (d < -loopDur / 2) d += loopDur;',
  '        e.trackTime += d * mRephase;',
  '      }',
  '    }',
].join('\n');

/** spine.js 的 hunks（顺序：先 import，再计划适配器，再两个方法的签名与正文）。 */
const SPINE_HUNKS = [
  { anchor: SPINE_IMPORT_ANCHOR, block: SPINE_IMPORT_BLOCK },
  { anchor: SPINE_PLAN_ANCHOR, block: SPINE_PLAN_BLOCK },
  { anchor: SPINE_WINDUP_SIG_ANCHOR, block: SPINE_WINDUP_SIG_BLOCK },
  { anchor: SPINE_WINDUP_ANCHOR, block: SPINE_WINDUP_BLOCK },
  { anchor: SPINE_ATTACK_SIG_ANCHOR, block: SPINE_ATTACK_SIG_BLOCK },
  { anchor: SPINE_ATTACK_PLAN_ANCHOR, block: SPINE_ATTACK_PLAN_BLOCK },
  { anchor: SPINE_ATTACK_BRANCH_ANCHOR, block: SPINE_ATTACK_BRANCH_BLOCK },
];

// =================================================================================================================
// 11) 服务端：**模拟接缝**（sim:*，12 个钩子）与 **AI 决策接缝**（bot:*，9 个钩子）
//
// 这两组是"行为模组"的正门：逻辑一行都不抄进上游文件 —— 上游只多一行 `simHas(...)` 守卫和一次调用，
// 注册表与 ctx 归一化全在我方 `files/server/sim/modlogic.js` 与 `files/server/match/botlogic.js`。
//
// 落点（每个钩子只有一处调用点，"没装包时"逐处都是一次布尔判断）：
//   sim:battleStart   server/sim/battle/lifecycle.js  start() 的 `emit('battleStart')` 处
//   sim:battleEnd     server/sim/battle/lifecycle.js  _finish() 的 `emit('battleEnd')` 之前
//   sim:unitTick      server/sim/battle/lifecycle.js  step() 的敌人/我方两个循环里
//   sim:enemyAI       server/sim/ai.js                updateEnemy() 开头（每个敌人每 tick，思考之前）
//   sim:targets       server/sim/ai.js                acquireTargets() 拿到候选表之后
//   sim:targetOrder   server/sim/ai.js                acquireTargets() 排序之后、截断之前
//   sim:attackMode    server/sim/ai.js                performAttack()（我方）+ enemyAttack()（敌人）
//   sim:attack        server/sim/ai.js                performAttack() 的每个目标
//   sim:strikeDelay   server/sim/ai.js                performAttack() / enemyAttack() 的结算处
//   sim:damage        server/sim/damage.js            dealDamage() 的 `hit` 钩子之后
//   sim:attackAnim    server/sim/snapshot.js          animOf() 的 ATTACK 窗口（经 simAttackWindow）
//   sim:attackRhythm  server/sim/snapshot.js          flagsOf()（经 attackRhythmBits）
//
// ⚠️ `sim:enemyAI` / `sim:unitTick` / `sim:attack` / `sim:targets` 都是**值型**钩子：handler 可能交回一个替身对象，
// 所以循环里的局部变量必须是 `let`（`const` 会每 tick 抛 "Assignment to constant variable"，引擎的内部错误预算
// 随后把整场战斗 force-end 成 timeout —— 一代就在这儿翻过车）。
//
// ⚠️ 12 个钩子本身还不够：模拟模块得先**被装进 Battle**。`extraContent` 由 `server/sim/spec.js` 透传给
// `installContent(battle, { extra })`，两个"谁把模块交出去"的调用点各一条补丁：服务端的 `_specBattle`
// （server/match/match/clientCombat.js）与页面自己的模拟（public/js/battle/runner.js）。

/** 我方模拟接缝模块的名字（补丁里的注释与 manual 都引用它）。 */
const SIM_MOD = 'server/sim/modlogic.js';

/** `sim:` / `bot:` 接缝的守卫注释统一用这句开头（与渲染接缝同一风格）。 */

// ---- 11a) server/sim/battle/lifecycle.js：battleStart / unitTick / battleEnd --------------------------------------

const LIFE_IMPORT_ANCHOR = "import { updateAlly, updateEnemy } from '../ai.js';";
const LIFE_IMPORT_BLOCK = LIFE_IMPORT_ANCHOR + '\n' + [
  '// Mod packages (sp-mods): the simulation-side hook registry — a file the loader owns (files/server/sim/modlogic.js),',
  '// deliberately dependency-free so importing it here cannot make a cycle. Every call site below is one guarded lookup;',
  '// with no behaviour package mounted the tick runs exactly as shipped (one boolean per unit, nothing allocated).',
  "import { simLogic, simHas } from '../modlogic.js';",
].join('\n');

const LIFE_START_ANCHOR = "    this.emit('battleStart', {});";
const LIFE_START_BLOCK = LIFE_START_ANCHOR + '\n' + [
  '    // Mod packages (sp-mods): `sim:battleStart` — the battle is deployed and every unit is set up, so a package may',
  '    // add persistent buffs, rewrite `enemyOverrides` or register its own `battle.on(...)` handlers here. A throwing',
  '    // handler is reported once and skipped (modlogic.js); with nobody registered this is one Map lookup.',
  "    if (simHas('sim:battleStart')) simLogic.emit('sim:battleStart', { battle: this });",
].join('\n');

const LIFE_ENEMY_ANCHOR = [
  '          const e = list[i];',
  '          if (!e.alive) continue;',
].join('\n');
const LIFE_ENEMY_BLOCK = [
  '          let e = list[i];',
  '          if (!e.alive) continue;',
  '          // Mod packages (sp-mods): `sim:unitTick` — every unit of both sides, once per tick, before the shipped AI',
  '          // runs. A VALUE hook: a package may hand back a stand-in object, so the loop local is `let` (and the answer',
  '          // is only taken when it is an object carrying the same `id` — a broken handler must not swap in junk).',
  "          if (simHas('sim:unitTick')) {",
  "            const _m = simLogic.run('sim:unitTick', e, { battle: this, dt, side: 'enemy' });",
  "            if (_m && typeof _m === 'object' && _m !== e && _m.id === e.id) { e = _m; list[i] = _m; }",
  '          }',
].join('\n');

const LIFE_ALLY_ANCHOR = [
  '          const u = list[i];',
  '          if (!u.alive || !u.deployed) continue;',
].join('\n');
const LIFE_ALLY_BLOCK = [
  '          let u = list[i];',
  '          if (!u.alive || !u.deployed) continue;',
  '          // Mod packages (sp-mods): `sim:unitTick` for the ally side — same hook, same rules as the enemy loop above.',
  "          if (simHas('sim:unitTick')) {",
  "            const _m = simLogic.run('sim:unitTick', u, { battle: this, dt, side: u.side });",
  "            if (_m && typeof _m === 'object' && _m !== u && _m.id === u.id) { u = _m; list[i] = _m; }",
  '          }',
].join('\n');

const LIFE_END_ANCHOR = "    this.emit('battleEnd', { result: res });";
const LIFE_END_BLOCK = [
  '    // Mod packages (sp-mods): `sim:battleEnd` — the battle is over and its result is built; a package may still adjust',
  "    // it here, before the game's own `battleEnd` handlers run and before the per-player objects are re-synced below.",
  "    if (simHas('sim:battleEnd')) simLogic.emit('sim:battleEnd', { battle: this, result: res });",
  LIFE_END_ANCHOR,
].join('\n');

const LIFE_HUNKS = [
  { anchor: LIFE_IMPORT_ANCHOR, block: LIFE_IMPORT_BLOCK },
  { anchor: LIFE_START_ANCHOR, block: LIFE_START_BLOCK },
  { anchor: LIFE_ENEMY_ANCHOR, block: LIFE_ENEMY_BLOCK },
  { anchor: LIFE_ALLY_ANCHOR, block: LIFE_ALLY_BLOCK },
  { anchor: LIFE_END_ANCHOR, block: LIFE_END_BLOCK },
];

// ---- 11b) server/sim/ai.js：enemyAI / targets / targetOrder / attackMode / attack / strikeDelay --------------------

const AI_IMPORT_ANCHOR = "import { hypot, powi } from './detmath.js';";
const AI_IMPORT_BLOCK = AI_IMPORT_ANCHOR + '\n' + [
  '// Mod packages (sp-mods): the AI seams of one fight. `simHas` keeps the no-package path at one Map lookup per call',
  '// site; `simStrikeDelay` is the "when does the damage of this attack land" contract (see files/server/sim/modlogic.js).',
  "import { simLogic, simHas, simStrikeDelay } from './modlogic.js';",
].join('\n');

const AI_ENEMY_ANCHOR = [
  'export function updateEnemy(b, e, dt) {',
  '  const R = e.route;',
  '  if (!e.alive) return;',
].join('\n');
const AI_ENEMY_BLOCK = [
  'export function updateEnemy(b, e, dt) {',
  '  const R = e.route;',
  '  if (!e.alive) return;',
  '  // Mod packages (sp-mods): `sim:enemyAI` — per enemy, per tick, BEFORE it thinks. The package may adjust `pauseUntil`',
  '  // / `route` / `x` / `y` / `atkCd` / `profile.canTarget` in place, or hand back a stand-in object (same `id`); the',
  '  // shipped AI then runs exactly as before. Deterministic: handlers must not read wall-clock time or draw from `rng`.',
  "  if (simHas('sim:enemyAI')) {",
  "    const _m = simLogic.run('sim:enemyAI', e, { battle: b, dt, tick: b.tickCount });",
  "    if (_m && typeof _m === 'object' && _m !== e && _m.id === e.id) e = _m;",
  '  }',
].join('\n');

const AI_TARGETS_ANCHOR = '  const cands = b.enemiesInKeys(u.rangeKeys, u, prof);';
const AI_TARGETS_BLOCK = [
  '  let cands = b.enemiesInKeys(u.rangeKeys, u, prof);',
  '  // Mod packages (sp-mods): `sim:targets` — the candidate list of this attack, before the blocked-first rule below,',
  '  // the priority sort and the target-count cut. A package may replace it (the shipped pipeline then runs on its list).',
  "  if (simHas('sim:targets')) {",
  "    const _t = simLogic.run('sim:targets', cands, { battle: b, unit: u, profile: prof });",
  "    if (Array.isArray(_t)) cands = _t.filter((e) => e && typeof e === 'object' && e.alive && e.side === 'enemy');",
  '  }',
].join('\n');

const AI_ORDER_ANCHOR = [
  '  const n = targetCount(u, prof);',
  '  sortEnemyTargets(b, u, cands, prof.priority);',
  '  return n >= cands.length ? cands : cands.slice(0, n);',
].join('\n');
const AI_ORDER_BLOCK = [
  '  const n = targetCount(u, prof);',
  '  sortEnemyTargets(b, u, cands, prof.priority);',
  '  // Mod packages (sp-mods): `sim:targetOrder` — the FINAL order of the candidate list, right before the cut. The',
  '  // shipped sort already ran (this is an ordering hint, not a re-sort): 阻挡两规则 puts the first enemy the unit',
  '  // blocked in front, which upstream has no dimension for (its blocked group is sorted by priority / aggro / distance).',
  "  if (simHas('sim:targetOrder')) {",
  "    const _o = simLogic.run('sim:targetOrder', cands, { battle: b, unit: u, profile: prof });",
  "    if (Array.isArray(_o)) cands = _o.filter((e) => e && typeof e === 'object' && e.alive && e.side === 'enemy');",
  '  }',
  '  return n >= cands.length ? cands : cands.slice(0, n);',
].join('\n');

const AI_MODE_ALLY_ANCHOR = [
  "  const ranged = !prof._fortressMelee && prof.attack === 'ranged' && prof.projectile && prof.projectile !== 'none' && prof.projectile !== 'beam';",
  "  const vis = prof._fortressMelee ? 'none' : (prof.projectile || 'none');",
].join('\n');
const AI_MODE_ALLY_BLOCK = [
  '  // Mod packages (sp-mods): `sim:attackMode` — the shape of THIS swing (melee / ranged). ⚠️ The answer is kept in a',
  "  // LOCAL, never written back to `prof`: `effectiveProfile` returns `u.profile` itself when no skill is active, so",
  '  // writing `prof._fortressMelee` here would turn every unit of that def into a melee unit for the rest of the battle.',
  "  let _blockMelee = prof._fortressMelee;",
  "  if (simHas('sim:attackMode')) {",
  "    const _shipped = prof._fortressMelee ? 'melee'",
  "      : (prof.attack === 'ranged' && prof.projectile && prof.projectile !== 'none' && prof.projectile !== 'beam' ? 'ranged' : 'melee');",
  '    const _mode = simLogic.run(\'sim:attackMode\', _shipped, {',
  '      battle: b, unit: u, profile: prof, isSkill, isEnemy: false,',
  '      blocking: u.blocking ? u.blocking.length : 0, blockedBy: !!u.blockedBy,',
  '    });',
  "    _blockMelee = _mode === 'melee';",
  '  }',
  "  const ranged = !_blockMelee && prof.attack === 'ranged' && prof.projectile && prof.projectile !== 'none' && prof.projectile !== 'beam';",
  "  const vis = _blockMelee ? 'none' : (prof.projectile || 'none');",
].join('\n');

const AI_MODE_ENEMY_ANCHOR = "  const melee = e.profile?.melee ?? def.applyWay === 'MELEE';";
const AI_MODE_ENEMY_BLOCK = [
  "  let melee = e.profile?.melee ?? def.applyWay === 'MELEE';",
  '  // Mod packages (sp-mods): the enemy half of `sim:attackMode` — an enemy in a block relation swings melee (阻挡两规则).',
  "  if (simHas('sim:attackMode')) {",
  "    const _m = simLogic.run('sim:attackMode', melee ? 'melee' : 'ranged', {",
  '      battle: b, unit: e, profile: e.profile, isSkill: false, isEnemy: true,',
  '      blocking: 0, blockedBy: !!e.blockedBy,',
  '    });',
  "    melee = _m === 'melee';",
  '  }',
].join('\n');

const AI_INFO_ANCHOR = '    const info = { isSkill, index: i, attackId, energy: i === 0 ? energy : 0 };';
const AI_INFO_BLOCK = [
  AI_INFO_ANCHOR,
  '    // Mod packages (sp-mods): `sim:attack` — the damage multiplier of THIS attack against THIS target (`performAttack`',
  '    // → `resolveHit`; the splash / chain victims are other damage instances and go through `sim:damage` instead).',
  "    if (simHas('sim:attack')) {",
  '      const _f = simLogic.run(\'sim:attack\', 1, {',
  '        battle: b, unit: u, profile: prof, target: t, attackId, isSkill, index: i,',
  '      });',
  '      if (Number.isFinite(_f) && _f >= 0) info.atkMul = _f;',
  '    }',
].join('\n');

const AI_STRIKE_ANCHOR = [
  '  const energy = !isHeal && prof.releaseEnergy ? prof.releaseEnergy(b, u) : 0;',
  '  for (let i = 0; i < targets.length; i++) {',
].join('\n');
const AI_STRIKE_BLOCK = [
  '  const energy = !isHeal && prof.releaseEnergy ? prof.releaseEnergy(b, u) : 0;',
  '  // Mod packages (sp-mods): `sim:strikeDelay` — how long after this attack event its damage should land, in game',
  '  // seconds. **0 without a package**: every target resolves on the spot, exactly as shipped. A positive answer is',
  '  // scheduled on the battle clock (`b.after`, deterministic — it advances with the tick), so the damage is a separate',
  '  // step that re-checks the target in `dealDamage` (a target that died or left in between is skipped).',
  '  const _delay = simHas(\'sim:strikeDelay\') ? simStrikeDelay(u, { battle: b, profile: prof, targets, isSkill }) : 0;',
  '  const _strike = (fn) => {',
  '    if (_delay > 0) b.after(_delay, () => b._safe(fn, \'sim:strikeDelay\', u));',
  '    else fn();',
  '  };',
  '  for (let i = 0; i < targets.length; i++) {',
].join('\n');

const AI_RESOLVE_ANCHOR = [
  "    if (ranged && foe && prof.projectile === 'boomerang') {",
  '      throwBoomerang(b, u, prof, t, info);',
  '    } else if (ranged && foe) {',
  '      const speed = PROJECTILE_SPEEDS[prof.projectile] ?? PROJECTILE_SPEED;',
  '      // projectiles land even if the shooter died meanwhile (damage is credited to it)',
  '      b.addProjectile({ from: u, target: t, speed, visual: prof.projectile, source: u, hitDead: prof.splashRadius > 0,',
  '        onHit: (c) => resolveHit(b, u, prof, c.target, info, c.x, c.y) });',
  '    } else {',
  '      resolveHit(b, u, prof, t, info, t.x, t.y);',
  '    }',
].join('\n');
const AI_RESOLVE_BLOCK = [
  '    // Mod packages (sp-mods): `sim:strikeDelay` wraps all three paths — the boomerang and the projectile LAUNCH at the',
  '    // strike frame too (the model reaches its own strike frame then; launching earlier is what makes the blow and the',
  '    // damage disagree). With no package `_strike(fn)` is just `fn()`.',
  '    _strike(() => {',
  "      if (ranged && foe && prof.projectile === 'boomerang') {",
  '        throwBoomerang(b, u, prof, t, info);',
  '      } else if (ranged && foe) {',
  '        const speed = PROJECTILE_SPEEDS[prof.projectile] ?? PROJECTILE_SPEED;',
  '        // projectiles land even if the shooter died meanwhile (damage is credited to it)',
  '        b.addProjectile({ from: u, target: t, speed, visual: prof.projectile, source: u, hitDead: prof.splashRadius > 0,',
  '          onHit: (c) => resolveHit(b, u, prof, c.target, info, c.x, c.y) });',
  '      } else {',
  '        resolveHit(b, u, prof, t, info, t.x, t.y);',
  '      }',
  '    });',
].join('\n');

const AI_HITMUL_ANCHOR = '    let mulT = skillMul;';
const AI_HITMUL_BLOCK = [
  '    // Mod packages (sp-mods): the `sim:attack` answer for this target (set in `performAttack`, `1` when nobody',
  '    // registered). The main target only — splash and chain build their own DamageInfo below.',
  '    let mulT = skillMul * (Number.isFinite(info.atkMul) ? info.atkMul : 1);',
].join('\n');

const AI_ENEMY_DELAY_ANCHOR = [
  '  e.lastAttackAt = b.time;',
  '  e.stats.attacks++;',
  '  const attackId = ++b._attackSeq;',
  "  const type = dmgType === 'heal' ? 'arts' : dmgType;",
].join('\n');
const AI_ENEMY_DELAY_BLOCK = [
  '  e.lastAttackAt = b.time;',
  '  e.stats.attacks++;',
  '  const attackId = ++b._attackSeq;',
  "  const type = dmgType === 'heal' ? 'arts' : dmgType;",
  '  // Mod packages (sp-mods): `sim:strikeDelay` for the enemy side (an enemy that stands still for its own clip lands its',
  '  // damage on that clip\'s strike frame — see files/server/sim/modlogic.js). 0 without a package: nothing changes.',
  "  const _delay = simHas('sim:strikeDelay') ? simStrikeDelay(e, { battle: b, profile: e.profile, targets, isSkill: false }) : 0;",
  '  const _strike = (fn) => {',
  "    if (_delay > 0) b.after(_delay, () => b._safe(fn, 'sim:strikeDelay', e));",
  '    else fn();',
  '  };',
].join('\n');

const AI_ENEMY_SHOT_ANCHOR = [
  '    if (rangedShot && hypot(t.x - e.x, t.y - e.y) > 0.75) {',
  "      b.addProjectile({ from: e, target: t, speed: PROJECTILE_SPEEDS.enemy, visual: 'enemy', source: e, onHit: (c) => hit(c.target, true) });",
  '    } else hit(t);',
].join('\n');
const AI_ENEMY_SHOT_BLOCK = [
  "    if (_delay > 0) _strike(() => {",
  '      // Mod packages (sp-mods): `sim:strikeDelay` (see above) — the shot leaves at the strike frame too.',
  '      if (rangedShot && hypot(t.x - e.x, t.y - e.y) > 0.75) {',
  "        b.addProjectile({ from: e, target: t, speed: PROJECTILE_SPEEDS.enemy, visual: 'enemy', source: e, onHit: (c) => hit(c.target, true) });",
  '      } else hit(t);',
  '    });',
  "    else if (rangedShot && hypot(t.x - e.x, t.y - e.y) > 0.75) {",
  "      b.addProjectile({ from: e, target: t, speed: PROJECTILE_SPEEDS.enemy, visual: 'enemy', source: e, onHit: (c) => hit(c.target, true) });",
  '    } else hit(t);',
].join('\n');

const AI_HUNKS = [
  { anchor: AI_IMPORT_ANCHOR, block: AI_IMPORT_BLOCK },
  { anchor: AI_ENEMY_ANCHOR, block: AI_ENEMY_BLOCK },
  { anchor: AI_TARGETS_ANCHOR, block: AI_TARGETS_BLOCK },
  { anchor: AI_ORDER_ANCHOR, block: AI_ORDER_BLOCK },
  { anchor: AI_MODE_ALLY_ANCHOR, block: AI_MODE_ALLY_BLOCK },
  { anchor: AI_MODE_ENEMY_ANCHOR, block: AI_MODE_ENEMY_BLOCK },
  { anchor: AI_INFO_ANCHOR, block: AI_INFO_BLOCK },
  { anchor: AI_STRIKE_ANCHOR, block: AI_STRIKE_BLOCK },
  { anchor: AI_RESOLVE_ANCHOR, block: AI_RESOLVE_BLOCK },
  { anchor: AI_HITMUL_ANCHOR, block: AI_HITMUL_BLOCK },
  { anchor: AI_ENEMY_DELAY_ANCHOR, block: AI_ENEMY_DELAY_BLOCK },
  { anchor: AI_ENEMY_SHOT_ANCHOR, block: AI_ENEMY_SHOT_BLOCK },
];

// ---- 11c) server/sim/damage.js：sim:damage ----------------------------------------------------------------------

const DMG_IMPORT_ANCHOR = "import { evadesGround } from './targeting.js';";
const DMG_IMPORT_BLOCK = DMG_IMPORT_ANCHOR + '\n' + [
  '// Mod packages (sp-mods): the damage seam. `sim:damage` sees every hit of the main pipeline — the last chance to',
  '// change what the game is about to apply (see files/server/sim/modlogic.js for the determinism rules).',
  "import { simLogic, simHas } from './modlogic.js';",
].join('\n');

const DMG_HIT_ANCHOR = '  const type = dmg.type;';
const DMG_HIT_BLOCK = [
  '  // Mod packages (sp-mods): `sim:damage` — `(value, ctx)`, `value = { battle, source, target, dmg }`. The handler',
  '  // MUTATES `dmg` in place (`dmg.mul`, `dmg.amount`, `dmg.type`) and may set `dmg.cancel` to swallow the hit; a',
  '  // throwing handler is reported once and skipped. Element damage took the branch above and never reaches this seam.',
  "  if (simHas('sim:damage')) {",
  '    simLogic.run(\'sim:damage\', { battle, source: hs, target, dmg }, { battle });',
  '    if (dmg.cancel || !target.alive || !target.deployed) return 0;',
  '  }',
  DMG_HIT_ANCHOR,
].join('\n');

const DMG_HUNKS = [
  { anchor: DMG_IMPORT_ANCHOR, block: DMG_IMPORT_BLOCK },
  { anchor: DMG_HIT_ANCHOR, block: DMG_HIT_BLOCK },
];

// ---- 11d) server/sim/snapshot.js：attackRhythm + ATTACK 窗口（attackAnim）----------------------------------------

const SNAP_IMPORT_ANCHOR = "import { enemyStealthed } from './targeting.js';";
const SNAP_IMPORT_BLOCK = SNAP_IMPORT_ANCHOR + '\n' + [
  '// Mod packages (sp-mods): the two snapshot-side seams — the attack rhythm a unit publishes in `flags` (`sim:attackRhythm`)',
  '// and the ATTACK window (`sim:attackAnim`, through `simAttackWindow`). Both are pure reads of the tick.',
  "import { simLogic, simHas, simAttackWindow } from './modlogic.js';",
].join('\n');

const SNAP_RHYTHM_ANCHOR = 'const r2 = (v) => Math.round(v * 100) / 100;';
const SNAP_RHYTHM_BLOCK = [
  '/**',
  " * The attack rhythm of one unit, packed for the snapshot's `flags` (hundredths of a second in bits 16…31).",
  ' * 0 when the unit has no usable interval: the client then keeps its own estimate.',
  ' *',
  ' * `sim:attackRhythm` is asked first, so a behaviour mod can publish the rhythm its animation actually runs at.',
  ' * Determinism: the hook runs inside the tick like every `sim:` hook and must not read wall-clock time.',
  ' *',
  ' * @param {object} u a unit of the battle',
  ' * @returns {number} the packed bits (0 when unknown)',
  ' */',
  'export function attackRhythmBits(u) {',
  '  const base = u && u.s ? u.s.interval : NaN;',
  "  const iv = simHas('sim:attackRhythm') ? simLogic.run('sim:attackRhythm', base, { unit: u }) : base;",
  '  if (!(iv > 0)) return 0;',
  '  return Math.min(65535, Math.round(iv * 100)) << 16;',
  '}',
  '',
  SNAP_RHYTHM_ANCHOR,
].join('\n');

const SNAP_FLAGS_ANCHOR = [
  "  if (u.motion === 'FLY') bits |= UF.FLYING;",
  '  return bits;',
].join('\n');
const SNAP_FLAGS_BLOCK = [
  "  if (u.motion === 'FLY') bits |= UF.FLYING;",
  '  // Mod packages (sp-mods): the attack rhythm the UI needs (the sim\'s own seconds between attacks, packed into bits',
  '  // 16…31 by `attackRhythmBits` above). One guarded call per snapshot tuple; 0 when nobody answers.',
  '  bits |= attackRhythmBits(u);',
  '  return bits;',
].join('\n');

const SNAP_ANIM_ANCHOR = '  if (t - u.lastAttackAt < ATTACK_ANIM_TIME) return u.skill && u.skill.active && u.skill.kind !== \'passive\' ? ANIM.SKILL : ANIM.ATTACK;';
const SNAP_ANIM_BLOCK = [
  '  // Mod packages (sp-mods): the ATTACK window is `sim:attackAnim`\'s answer when a package gave one, so the state the',
  '  // client shows is as long as the model\'s own swing (`simAttackWindow` asks the hook first and falls back to the',
  '  // baked clip length / the shipped ATTACK_ANIM_TIME). With nobody registered the expression is the shipped one.',
  "  if (simHas('sim:attackAnim') && t - u.lastAttackAt < simAttackWindow(u, ATTACK_ANIM_TIME)) return u.skill && u.skill.active && u.skill.kind !== 'passive' ? ANIM.SKILL : ANIM.ATTACK;",
  SNAP_ANIM_ANCHOR,
].join('\n');

const SNAP_HUNKS = [
  { anchor: SNAP_IMPORT_ANCHOR, block: SNAP_IMPORT_BLOCK },
  { anchor: SNAP_RHYTHM_ANCHOR, block: SNAP_RHYTHM_BLOCK },
  { anchor: SNAP_FLAGS_ANCHOR, block: SNAP_FLAGS_BLOCK },
  { anchor: SNAP_ANIM_ANCHOR, block: SNAP_ANIM_BLOCK },
];

// ---- 11e) server/sim/spec.js：spec → Battle 透传 extraContent（行为模组的正门）-----------------------------------

const SPEC_ANCHOR = '  const battleOpts = {';
const SPEC_BLOCK = [
  SPEC_ANCHOR,
  '    // Mod packages (sp-mods): the installed behaviour modules. `Battle` hands this to `installContent(battle,',
  '    // { extra })`, which calls `install(battle)` on each entry — the contract the game\'s own content modules use,',
  '    // so a behaviour mod needs no patch of its own. `null` without a caller that has any (the shipped behaviour).',
  '    extraContent: opts.extraContent ?? null,',
].join('\n');

const SPEC_HUNKS = [{ anchor: SPEC_ANCHOR, block: SPEC_BLOCK }];

// ---- 11f) server/match/match/clientCombat.js + public/js/battle/runner.js：谁把模块交给 Battle --------------------

const CC_IMPORT_ANCHOR = "import { buildBattleSpec, createBattleFromSpec } from '../../sim/spec.js';";
const CC_IMPORT_BLOCK = CC_IMPORT_ANCHOR + '\n' + [
  '// Mod packages (sp-mods): every server-run field (a takeover re-simulation, a verification pass) must run the SAME',
  '// behaviour modules as the client, or the two `resultDigest`s disagree and the server replaces the client\'s result.',
  "import { simContent } from '../../loader.js';",
].join('\n');

const CC_BATTLE_ANCHOR = '      return createBattleFromSpec(spec, this.ds, { BattleClass: this.BattleClass, sharedBoss, logger: this.log, recordEvents: false });';
const CC_BATTLE_BLOCK = [
  '      // Mod packages (sp-mods): `extraContent` = the loaded behaviour modules, in a deterministic (id) order.',
  '      // `simContent()` is `[]` when nothing is mounted, so the shipped path is untouched.',
  '      return createBattleFromSpec(spec, this.ds, { BattleClass: this.BattleClass, sharedBoss, logger: this.log, recordEvents: false,',
  '        extraContent: simContent() });',
].join('\n');

const CC_HUNKS = [
  { anchor: CC_IMPORT_ANCHOR, block: CC_IMPORT_BLOCK },
  { anchor: CC_BATTLE_ANCHOR, block: CC_BATTLE_BLOCK },
];

const RUN_IMPORT_ANCHOR = "import { recordError, setBattleSource } from '../diag.js';";
const RUN_IMPORT_BLOCK = RUN_IMPORT_ANCHOR + '\n' + [
  '// Mod packages (sp-mods): the page simulates its own battles, so the behaviour packages\' simulation entries have to',
  '// be loaded here and handed to the Battle (see below). Both imports are dynamic-free and tiny; the loader module',
  '// itself pulls the sim entries lazily, only when `hasSimMods()` says there is one.',
  "import { hasSimMods } from '../mods.js';",
  "import { loadSimModulesFromLoader, modSimModules } from '../mods/sim.js';",
].join('\n');

const RUN_BATTLE_ANCHOR = '        battle = sim.spec.createBattleFromSpec(e.spec, sim.ds, { logger });';
const RUN_BATTLE_BLOCK = [
  '        // Mod packages (sp-mods): the simulation entries of the mounted behaviour packages. With none, neither call',
  '        // does anything (`hasSimMods()` is false, `modSimModules()` is `[]`) and the battle is the shipped one.',
  '        if (hasSimMods()) {',
  '          try { await loadSimModulesFromLoader(); } catch (err) { console.warn(\'[runner] mod simulation entries unavailable\', err); }',
  '          if (!wanted()) return;',
  '        }',
  '        battle = sim.spec.createBattleFromSpec(e.spec, sim.ds, { logger, extraContent: modSimModules() });',
].join('\n');

const RUN_HUNKS = [
  { anchor: RUN_IMPORT_ANCHOR, block: RUN_IMPORT_BLOCK },
  { anchor: RUN_BATTLE_ANCHOR, block: RUN_BATTLE_BLOCK },
];

// ---- 11g) server/data.js：内容包合并目录成为 getData() 的默认（见 loader.js 的文件头）----------------------------

const DATA_IMPORT_ANCHOR = "import { fileURLToPath } from 'node:url';";
const DATA_IMPORT_BLOCK = DATA_IMPORT_ANCHOR + '\n' + [
  '// Mod packages (sp-mods): the merged tables directory the loader publishes (server/loader.js `modDataDir`). It is a',
  '// COMPLETE data/ (the packs\' changes applied over hard links of every other table), so this one default is all the',
  '// server half needs; with no content pack it is `null` and the built-in `data/` is read as before.',
  "import { modDataDir } from './loader.js';",
].join('\n');

const DATA_GET_ANCHOR = 'export function getData({ dir = DATA_DIR, log = console } = {}) {';
const DATA_GET_BLOCK = 'export function getData({ dir = modDataDir() || DATA_DIR, log = console } = {}) {';

const DATA_HUNKS = [
  { anchor: DATA_IMPORT_ANCHOR, block: DATA_IMPORT_BLOCK },
  { anchor: DATA_GET_ANCHOR, block: DATA_GET_BLOCK },
];

// ---- 11h) server/match/effectsMeta.js：策略 / 盟约 的注册表接缝 ----------------------------------------------------

const META_HELPER_ANCHOR = 'let defaultRegistry = null;';
const META_HELPER_BLOCK = [
  '// Mod packages (sp-mods): the prep-effect (策略 / 盟约 / 特质 / 装备) extension point. `server/loader.js` — a file the',
  '// loader owns — publishes `{ install }` on this `globalThis` key, and every registry build asks it (never cached),',
  '// so a package enabled at run time is picked up by the NEXT registry without a restart. Importing the loader from',
  '// here would drag its whole module graph in (and the loader deliberately does not import this file back).',
  "const MOD_META_KEY = '__SP_MODS_META__';",
  '',
  '/** The loader-registered installer, or null (this file is the shipped one when the loader is not installed). */',
  'function modMetaInstaller() {',
  '  const world = globalThis[MOD_META_KEY];',
  "  return world && typeof world.install === 'function' ? world.install : null;",
  '}',
  '',
  META_HELPER_ANCHOR,
].join('\n');

const META_CALL_ANCHOR = '  if (reg.warnings.length) log.warn?.(`[meta] ${reg.warnings.length} handler method(s) are not hooks and will never run, e.g. ${reg.warnings.slice(0, 3).join(\'; \')}`);';
const META_CALL_BLOCK = [
  '  // Mod packages (sp-mods): the loader\'s handlers, AFTER the game\'s own content — a package may override a built-in',
  '  // key (its own 策略 / 盟约 mechanism wins), and `installModMeta` is idempotent per registry object.',
  '  const modInstall = modMetaInstaller();',
  '  if (modInstall) {',
  "    try { modInstall(reg); } catch (e) { log.error?.('[meta] the mod meta installer failed', e); }",
  '  }',
  META_CALL_ANCHOR,
].join('\n');

const META_HUNKS = [
  { anchor: META_HELPER_ANCHOR, block: META_HELPER_BLOCK },
  { anchor: META_CALL_ANCHOR, block: META_CALL_BLOCK },
];

// ---- 11i) public/js/assets.js：内容包贡献的立绘 / Spine（api.assets.registerChars）-------------------------------

const ASSET_GETTER_ANCHOR = '  const m = () => manifest || {};';
const ASSET_GETTER_BLOCK = [
  '  // Mod packages (sp-mods): what the mounted packages contribute (see `setModAssetProvider` at the bottom of this',
  '  // file). With no provider this returns `manifest || {}` — the very object, not a copy.',
  '  const m = () => {',
  '    const extra = modAssetExtras();',
  '    if (!extra) return manifest || {};',
  '    const base = manifest || {};',
  '    const out = { ...base };',
  '    for (const [group, entries] of Object.entries(extra)) out[group] = { ...(isObj(base[group]) ? base[group] : {}), ...entries };',
  '    return out;',
  '  };',
].join('\n');

const ASSET_TAIL_ANCHOR = ['/** Browser singleton. */', 'export const assets = createAssets();'].join('\n');
const ASSET_TAIL_BLOCK = [
  '// ---------------------------------------------------------------------------------------------------------------',
  '// Mod packages (sp-mods): operator art contributed by the mounted packages',
  '//',
  "// The manifest above is the game's own asset dump and `chars[<charId>]` is where an operator's avatar, portrait and",
  '// Spine URLs live. A content pack can add a `chess` record but not a manifest entry, so an operator it brings used to',
  '// be drawn as an image-less placeholder. `api.assets.registerChars(provider)` contributes exactly the shape the',
  '// manifest uses, keyed by asset id, and the getter above merges it on top:',
  '//',
  '//   setModAssetProvider(() => ({ chars: { char_130_doberm: {',
  "//     avatar: '/mods/<id>/assets/avatar/char_130_doberm.png',",
  "//     portrait: '/mods/<id>/assets/portrait/char_130_doberm_1.png',",
  "//     spine: { front: { skel: '…', atlas: '…', textures: ['…'], pma: false, anims: { idle: 'Idle', … } } },",
  '//   } } }));',
  '//',
  '// The manifest object itself is never mutated, entries the game already has always win, and with no provider the',
  '// getter returns exactly what it returned before this seam existed.',
  '// ---------------------------------------------------------------------------------------------------------------',
  '',
  '/** @type {Array<() => (Record<string, any>|null|undefined)>} */',
  'const modAssetProviders = [];',
  'let modAssetGen = 0;',
  '',
  '/**',
  ' * Contribute manifest entries keyed by asset id: `chars` (avatar / portrait / spine objects) and — for the groups',
  " * whose entries are plain URL strings — `bonds`, `bands`, `items`, `ui`, `skills` (a package that brings its own bond",
  ' * glyph or strategy icon needs those: they are looked up BY ID). `provider()` is called lazily and may return null',
  ' * while its data is not ready; entries it returns never overwrite what the game\'s own manifest already has.',
  ' * @param {() => (Record<string, any>|null|undefined)} provider',
  ' * @returns {() => void} unregister',
  ' */',
  'export function setModAssetProvider(provider) {',
  "  if (typeof provider !== 'function') throw new TypeError('setModAssetProvider: function required');",
  '  modAssetProviders.push(provider);',
  '  modAssetGen++;',
  '  return () => {',
  '    const i = modAssetProviders.indexOf(provider);',
  '    if (i >= 0) { modAssetProviders.splice(i, 1); modAssetGen++; }',
  '  };',
  '}',
  '',
  '/** Everything the providers contribute, merged (memoised per generation; an empty result is `null`). */',
  'let modAssetCache = null;',
  'let modAssetCacheGen = -1;',
  'function modAssetExtras() {',
  '  if (modAssetCacheGen === modAssetGen) return modAssetCache;',
  '  let out = null;',
  '  for (const provider of modAssetProviders) {',
  '    let add = null;',
  "    try { add = provider(); } catch (err) { console.warn('[assets] a mod asset provider failed', err); continue; }",
  '    if (!isObj(add)) continue;',
  '    for (const [group, entries] of Object.entries(add)) {',
  '      if (!isObj(entries)) continue;',
  '      const dst = (out || (out = {}))[group] || (out[group] = {});',
  '      // an entry is either an object (a `chars` record) or a plain URL string (`bonds` / `bands` / `items` / `ui`)',
  '      for (const [id, rec] of Object.entries(entries)) {',
  "        if (!(isObj(rec) || typeof rec === 'string')) continue;",
  '        if (!Object.hasOwn(dst, id)) dst[id] = rec;',
  '      }',
  '    }',
  '  }',
  '  modAssetCache = out;',
  '  modAssetCacheGen = modAssetGen;',
  '  return out;',
  '}',
  '',
  ASSET_TAIL_ANCHOR,
].join('\n');

const ASSET_HUNKS = [
  { anchor: ASSET_GETTER_ANCHOR, block: ASSET_GETTER_BLOCK },
  { anchor: ASSET_TAIL_ANCHOR, block: ASSET_TAIL_BLOCK },
];

// ---- 11j) public/js/ui/fieldHost.js：战场视图就绪 → api.ready / 'ready' 事件 ---------------------------------------

const FIELD_ANCHOR = "      return guardView(view, 'engine');";
const FIELD_BLOCK = [
  '      // Mod packages (sp-mods): the field view exists, so `api.ready` callbacks and the \'ready\' event run now.',
  '      // Fire-and-forget: a package that cannot load must never stop the field from mounting.',
  "      import('../mods.js').then((m) => m.notifyReady?.(view)).catch(() => {});",
  FIELD_ANCHOR,
].join('\n');

const FIELD_HUNKS = [{ anchor: FIELD_ANCHOR, block: FIELD_BLOCK }];

// ---- 11k) public/js/screens/title.js：标题页的「模组」按钮 + ui:button 宿主 ----------------------------------------

const TITLE_IMPORT_ANCHOR = "import { GuideButton } from '../ui/guide.js';";
const TITLE_IMPORT_BLOCK = TITLE_IMPORT_ANCHOR + '\n' + [
  '// Mod packages (sp-mods): the title screen\'s own 模组 entry (it opens /mods.html) and the ui:button host — a package',
  '// contributes plain descriptors and the host renders them with the game\'s own <Button>. Nothing renders when no',
  '// package contributes, so the shipped title screen looks exactly the same without one.',
  "import { ModsButton } from '../ui/modsButton.js';",
  "import { ModButtons } from '../ui/modButtons.js';",
].join('\n');

const TITLE_GUIDE_ANCHOR = "          <${GuideButton} class=\"title-guide\" label=${t('玩法说明')} />";
const TITLE_GUIDE_BLOCK = TITLE_GUIDE_ANCHOR + '\n' + [
  '          <${ModsButton} class="title-guide" />',
].join('\n');

const TITLE_GEAR_ANCHOR = [
  '          <button type="button" class="title-settings fsbtn tapx" aria-label=${t(\'设置\')} title=${t(\'设置\')}',
  "            onClick=${() => setSettingsOpen(true)}><${GIcon} name=\"gear\" /></button>",
].join('\n');
const TITLE_GEAR_BLOCK = TITLE_GEAR_ANCHOR + '\n' + [
  '          <${ModButtons} slot="title.actions" class="title-modbtns" size="sm" variant="secondary" />',
].join('\n');

const TITLE_HUNKS = [
  { anchor: TITLE_IMPORT_ANCHOR, block: TITLE_IMPORT_BLOCK },
  { anchor: TITLE_GUIDE_ANCHOR, block: TITLE_GUIDE_BLOCK },
  { anchor: TITLE_GEAR_ANCHOR, block: TITLE_GEAR_BLOCK },
];

// ---- 11l) server/match/bot.js：AI 决策接缝（bot:*，9 个钩子 + botParam 旋钮）--------------------------------------
//
// 这条的形状（`/*sp-mods:bot:<name>*/` 标记 + 每个决策点一处 `botHas(...)`）来自已经跑起来的实例
// （`D:\sp\version\ai-test` 与 `test` 的 bot.js 逐字节相同），这里把它**原样**立成补丁：块文本与那两个实例
// 逐字一致，所以已经装过它的实例 `once` 为真，不需要任何升级分支。

const BOT_HUNKS = [
  { anchor: "import { computeBonds } from './bondsMeta.js';",
    block: [
      "import { computeBonds } from './bondsMeta.js';",
      '/*sp-mods:bot:import*/',
      "import { botBoost, botHas, botParam } from './botlogic.js';",
    ].join('\n') },
  { anchor: '  const pairs = ids.map((id) => [id, offBond(id) ? 0 : Math.max(1, (gd.startLp(id) - 18) ** 2) * (m.isSolo && lateFunds(id) ? 0.02 : 1)]);',
    block: [
      '  const pairs = ids.map((id) => [id, offBond(id) ? 0 : Math.max(1, (gd.startLp(id) - 18) ** 2) * (m.isSolo && lateFunds(id) ? 0.02 : 1)]);',
      '  /*sp-mods:bot:bandWeights*/',
      "  if (botHas('bot:bandWeights')) {",
      "    const w = botBoost('bot:bandWeights', pairs.map((p) => p[1]), { m, ps, ids: pairs.map((p) => p[0]) });",
      '    if (Array.isArray(w) && w.length === pairs.length) for (let i = 0; i < pairs.length; i++) pairs[i][1] = Math.max(0, Number(w[i]) || 0);',
      '  }',
    ].join('\n') },
  { anchor: "    else if (c.kind === 'tactic') s = tacticScore(m, ps, c);",
    block: [
      "    else if (c.kind === 'tactic') s = tacticScore(m, ps, c);",
      '    /*sp-mods:bot:cardScore*/',
      "    if (botHas('bot:cardScore')) { const v = botBoost('bot:cardScore', s, { m, ps, card: c, index: i }); if (Number.isFinite(v)) s = v; }",
    ].join('\n') },
  { anchor: ['    if (s > bestK) { bestK = s; second = id; }', '  }'].join('\n'),
    block: [
      '    if (s > bestK) { bestK = s; second = id; }',
      '  }',
      '  /*sp-mods:bot:bondPlan*/',
      "  if (botHas('bot:bondPlan')) {",
      "    const plan = botBoost('bot:bondPlan', { focus, second }, { m, ps, owned, pool });",
      '    if (plan && typeof plan === \'object\') { focus = plan.focus ?? focus; second = plan.second ?? second; }',
      '  }',
    ].join('\n') },
  { anchor: '  v -= Math.max(0, healers - 2) * 10;',
    block: [
      '  v -= Math.max(0, healers - 2) * 10;',
      '  /*sp-mods:bot:lineupScore*/',
      "  if (botHas('bot:lineupScore')) { const v2 = botBoost('bot:lineupScore', v, { m, ps, set, bonds, ctx }); if (Number.isFinite(v2)) v = v2; }",
    ].join('\n') },
  { anchor: '      else s += keep ? 14 : ctx.pairs < MAX_PAIRS && c.tier <= 3 ? 6 : 1;',
    block: "      else s += keep ? 14 : ctx.pairs < botParam('maxPairs', MAX_PAIRS) && c.tier <= 3 ? 6 : 1; /*sp-mods:bot:maxPairs*/" },
  { anchor: '  if (ctx.model && !isHealer(c)) s += ARMOR_WEIGHT * 0.6 * (armorFit(ctx.model, c) - 0.6);',
    block: [
      "  if (ctx.model && !isHealer(c)) s += botParam('armorWeight', ARMOR_WEIGHT) * 0.6 * (armorFit(ctx.model, c) - 0.6);",
      '  /*sp-mods:bot:buyScore*/',
      "  if (botHas('bot:buyScore')) { const v = botBoost('bot:buyScore', s, { m, ps, id, ctx, rec: c }); if (Number.isFinite(v)) s = v; }",
    ].join('\n') },
  { anchor: 'export function* planLayoutSteps(m, ps, pieces, params = LAYOUT_PARAMS, { occupied = new Set(), recOf = null } = {}) {',
    block: [
      'export function* planLayoutSteps(m, ps, pieces, params = LAYOUT_PARAMS, { occupied = new Set(), recOf = null } = {}) {',
      '  /*sp-mods:bot:layoutParams*/',
      "  if (botHas('bot:layoutParams')) { const p0 = botBoost('bot:layoutParams', params, { m, ps, pieces }); if (p0 && typeof p0 === 'object') params = p0; }",
    ].join('\n') },
  { anchor: '  const cands = distinct.slice(0, m.botRehearsal);',
    block: [
      '  /*sp-mods:bot:rehearsalCount*/',
      "  const _spCount = botHas('bot:rehearsal') ? (botBoost('bot:rehearsal', { variants: REHEARSAL_VARIANTS, count: m.botRehearsal }, { m, ps, chosen }) || {}).count : m.botRehearsal;",
      '  const cands = distinct.slice(0, Math.max(0, Math.min(16, Number(_spCount) || 0)));',
    ].join('\n') },
  { anchor: ['    if (k + 1 >= mergeNeed(m, b)) v += pShop * MERGE_HIT;', '    else if (ctx.keep.has(b)) v += pShop * PAIR_HIT;', '  }'].join('\n'),
    block: [
      "    if (k + 1 >= mergeNeed(m, b)) v += pShop * botParam('mergeHit', MERGE_HIT); /*sp-mods:bot:mergeHit*/",
      "    else if (ctx.keep.has(b)) v += pShop * botParam('pairHit', PAIR_HIT);",
      '  }',
      '  /*sp-mods:bot:refreshValue*/',
      "  if (botHas('bot:refreshValue')) { const v2 = botBoost('bot:refreshValue', v, { m, ps, ctx }); if (Number.isFinite(v2)) v = v2; }",
    ].join('\n') },
  { anchor: '  for (const { p } of all.slice(BENCH_BUDGET)) tryDo(() => ps.sell(p.uid));',
    block: "  for (const { p } of all.slice(botParam('benchBudget', BENCH_BUDGET))) tryDo(() => ps.sell(p.uid)); /*sp-mods:bot:benchBudget*/" },
  { anchor: '  yield* buyLoopSteps(m, ps, { fillOnly: false, maxRefreshes: MAX_REFRESHES });',
    block: [
      '  /*sp-mods:bot:maxRefreshes*/',
      "  yield* buyLoopSteps(m, ps, { fillOnly: false, maxRefreshes: botParam('maxRefreshes', MAX_REFRESHES) });",
    ].join('\n') },
  { anchor: ['    const target = LEVEL_TARGET[Math.min(LEVEL_TARGET.length - 1, r)];', '    const nextTarget = LEVEL_TARGET[Math.min(LEVEL_TARGET.length - 1, r + 1)];'].join('\n'),
    block: [
      '    /*sp-mods:bot:levelTarget*/',
      "    const _spLT = botParam('levelTarget', LEVEL_TARGET);",
      '    const target = _spLT[Math.min(_spLT.length - 1, r)];',
      '    const nextTarget = _spLT[Math.min(_spLT.length - 1, r + 1)];',
    ].join('\n') },
  { anchor: '          } else if (gd.isGolden(s.id) || (!ctx.keep.has(base) && !(ctx.pairs < MAX_PAIRS && (chessRec(m, s.id, ps)?.tier ?? 6) <= 3 && countFree(ps.hand) >= 3))) {',
    block: "          } else if (gd.isGolden(s.id) || (!ctx.keep.has(base) && !(ctx.pairs < botParam('maxPairs', MAX_PAIRS) /*sp-mods:bot:maxPairs2*/ && (chessRec(m, s.id, ps)?.tier ?? 6) <= 3 && countFree(ps.hand) >= 3))) {" },
  { anchor: '        sc = 6 + (gd.tierOf(s.id) || 1) * 3 - price + (ps.completesItemMerge(s.id) ? 10 : 0);',
    block: [
      '        sc = 6 + (gd.tierOf(s.id) || 1) * 3 - price + (ps.completesItemMerge(s.id) ? 10 : 0); /*sp-mods:bot:itemScore*/',
      "        if (botHas('bot:itemScore')) { const v = botBoost('bot:itemScore', sc, { m, ps, id: s.id, item: s, ctx }); if (Number.isFinite(v)) sc = v; }",
    ].join('\n') },
  { anchor: '    let buy = best >= 0 && bestS >= (boardFull ? BUY_FULL_MIN : 3);',
    block: "    let buy = best >= 0 && bestS >= (boardFull ? botParam('buyFullMin', BUY_FULL_MIN) : 3); /*sp-mods:bot:buyFullMin*/" },
  { anchor: '    for (const v of REHEARSAL_VARIANTS) plans.push(yield* planLayoutSteps(m, ps, chosen, { ...LAYOUT_PARAMS, ...v }));',
    block: [
      '    /*sp-mods:bot:rehearsal*/',
      "    const _spVariants = botHas('bot:rehearsal') ? (botBoost('bot:rehearsal', { variants: REHEARSAL_VARIANTS, count: m.botRehearsal }, { m, ps, chosen }) || {}).variants : null;",
      '    for (const v of _spVariants || REHEARSAL_VARIANTS) plans.push(yield* planLayoutSteps(m, ps, chosen, { ...LAYOUT_PARAMS, ...v }));',
    ].join('\n') },
];

/** bot.js 的 17 处插入里的标记（`once` 靠它们认人；与已装实例逐字一致）。 */
const BOT_MARKS = [
  '/*sp-mods:bot:import*/',
  '/*sp-mods:bot:bandWeights*/',
  '/*sp-mods:bot:cardScore*/',
  '/*sp-mods:bot:bondPlan*/',
  '/*sp-mods:bot:lineupScore*/',
  '/*sp-mods:bot:maxPairs*/',
  '/*sp-mods:bot:buyScore*/',
  '/*sp-mods:bot:layoutParams*/',
  '/*sp-mods:bot:rehearsalCount*/',
  '/*sp-mods:bot:mergeHit*/',
  '/*sp-mods:bot:benchBudget*/',
  '/*sp-mods:bot:maxRefreshes*/',
  '/*sp-mods:bot:levelTarget*/',
  '/*sp-mods:bot:maxPairs2*/',
  '/*sp-mods:bot:itemScore*/',
  '/*sp-mods:bot:buyFullMin*/',
  '/*sp-mods:bot:rehearsal*/',
];

/** 每条补丁：{ id, file, what, once, apply, manual }。 */

export const PATCHES = [
  // =============================================================================================================
  // 1) public/js/main.js —— 首帧之前把模组加载起来
  //
  // 为什么必须在首帧之前：模组要能影响**第一帧**的外观（api.style / api.ui），也要让内容包在
  // 任何界面读数据之前进到 store 里。上游那段代码本来就等字体/网络/语言三件事就绪，我们在它之后、
  // 第一次 render 之前插进去。
  {
    id: 'boot',
    file: 'public/js/main.js',
    what: '首帧之前加载模组包（ui:button / api.ui / 内容包的前提）',
    manual: `public/js/main.js —— 在 \`await Promise.all([waitForFonts(1200), connectWhenReady, langReady]);\` 之后、\n`
      + `\`const root = document.getElementById('app');\` 之前插入：\n`
      + `  try {\n`
      + `    const modsApi = await import('./mods.js');\n`
      + `    globalThis.__SP_MODS__ = modsApi;\n`
      + `    const modRes = await modsApi.loadMods({ store: data });\n`
      + `    if (modRes.ok.length) console.log('[mods] loaded: ' + modRes.ok.map((m) => m.id + '@' + (m.version || '?')).join(', '));\n`
      + `    for (const f of modRes.failed) console.error('[mods] "' + f.id + '" failed: ' + f.error);\n`
      + `  } catch (err) { console.warn('[mods] loader unavailable', err); }`,
    once: (s) => s.includes('__SP_MODS__'),
    apply(s) {
      if (s.includes('__SP_MODS__')) return s;
      const anchor = '  await Promise.all([waitForFonts(1200), connectWhenReady, langReady]);';
      if (!s.includes(anchor)) return null;
      const block = [
        anchor,
        '  // Mod packages (sp-mods): load BEFORE the first render, so a package can adjust render/style knobs and still',
        '  // affect the very first frame, and so its content packs reach the data store before any screen reads it.',
        '  // A package that fails is reported and skipped — the game boots either way.',
        '  try {',
        "    const modsApi = await import('./mods.js');",
        '    globalThis.__SP_MODS__ = modsApi;',
        '    const modRes = await modsApi.loadMods({ store: data });',
        "    if (modRes.ok.length) console.log('[mods] loaded: ' + modRes.ok.map((m) => m.id + '@' + (m.version || '?')).join(', '));",
        "    for (const f of modRes.failed) console.error('[mods] \"' + f.id + '\" failed: ' + f.error);",
        '  } catch (err) {',
        "    console.warn('[mods] loader unavailable', err);",
        '  }',
      ].join('\n');
      return s.replace(anchor, block);
    },
  },

  // =============================================================================================================
  // 2) server/index.js —— 扫包 → 合并内容 → 加载 sim → 把 modsDir / modsApi 接给静态与路由
  {
    id: 'server-boot',
    file: 'server/index.js',
    what: '服务端启动顺序（先扫模组再读表）+ 把 modsDir / modsApi 交出去',
    manual: `server/index.js ——\n`
      + `  ① 顶部 import 之后加：\n`
      + `       import { answerClientError, sendJson, sendError } from './http/common.js';   // 补上 sendJson / sendError\n`
      + `       import { createModManager } from './mods.js';\n`
      + `       import { createModsApi } from './modapi.js';\n`
      + `       import { installMods, applyMods, modDataDir } from './loader.js';\n`
      + `  ② \`const { publicDir, dataDir, sharedDir, packsDir } = serveDirs(opts);\` 换成四行（见 apply）：\n`
      + `     先 serveDirs，再扫模组/合并内容，最后 dataDir 用 modDataDir(ROOT) || dirs.dataDir\n`
      + `  ③ createStaticHandler 那行加 \`modsDir: mods.modsDir, modsDeny: MOD_PRIVATE\`\n`
      + `  ④ createRequestHandler 那行加 \`modsApi\`，并在 startServer 之前定义 MOD_PRIVATE`,
    once: (s) => s.includes('createModManager'),
    apply(s) {
      if (s.includes('createModManager')) return s;
      const commonImport = "import { answerClientError } from './http/common.js';";
      if (!s.includes(commonImport)) return null;
      let out = s;

      // ① import：给 common.js 那一行补上 sendJson / sendError（modapi.js 要用），再加三行 import
      out = out.replace(commonImport,
        "import { answerClientError, sendJson, sendError } from './http/common.js';\n"
        + "// Mod packages (sp-mods): the manager (server half), its HTTP surface, and the loader that merges content packs\n"
        + "// and loads behaviour modules. These live in files the mod loader owns — see catalog.mjs.\n"
        + "import { createModManager } from './mods.js';\n"
        + "import { createModsApi } from './modapi.js';\n"
        + "import { installMods, applyMods, modDataDir } from './loader.js';");

      // ②③④ 用**缩进无关**的行级替换：上游这几行的缩进量改过（2 ↔ 4 空格），写死缩进的锚点会碎。
      const lineRe = (needle) => new RegExp(`^([ \\t]*)${needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[ \\t]*$`, 'm');
      /** 把某一行换成多行（缩进沿用原文）。 */
      const subLine = (needle, lines) => {
        const re = lineRe(needle);
        if (!re.test(out)) return false;
        out = out.replace(re, lines.map((l, i) => (i === 0 ? '$1' + l : '$1' + l)).join('\n'));
        return true;
      };

      // ② 启动顺序：serveDirs 之后扫包/合并/加载 sim，dataDir 用合并后的目录
      if (!subLine('const { publicDir, dataDir, sharedDir, packsDir } = serveDirs(opts);', [
        'const dirs = serveDirs(opts);',
        'const { publicDir, sharedDir, packsDir } = dirs;',
        '// Mod packages (sp-mods) are scanned BEFORE anything reads the tables: a content pack changes what the shop',
        "// and the simulation see, and server/sim/simdata.js caches getData()'s result at module load — so this is the",
        '// only moment that reaches both. With no pack installed the merged dir does not exist and data/ is used as is.',
        'const mods = createModManager({ root: ROOT, log, apply: (info) => applyMods({ root: ROOT, mods, log, reason: info && info.reason }) });',
        "await mods.scan().catch((e) => log.error('[mods] initial scan failed', e));",
        'try {',
        '  await installMods({ root: ROOT, mods, log });',
        '} catch (e) {',
        "  log.error('[mods] loading content / sim modules failed', e);",
        '}',
        'mods.watch();',
        'mods.startUpdates({ records: [...mods.records().values()] });',
        'const dataDir = opts.dataDir || modDataDir(ROOT) || dirs.dataDir;',
      ])) return null;

      // ③ 静态处理器：交出 modsDir / modsDeny
      if (!subLine('const serveStatic = createStaticHandler({ publicDir, dataDir, sharedDir, packsDir, packs, log });', [
        'const serveStatic = createStaticHandler({ publicDir, dataDir, sharedDir, packsDir, packs, log,',
        '  modsDir: mods.modsDir, modsDeny: MOD_PRIVATE });',
      ])) return null;

      // ④ 请求处理器：交出 modsApi（+ 在 startServer 之前定义 MOD_PRIVATE）
      if (!subLine('const server = http.createServer(createRequestHandler({ serveStatic, health: { startedAt, network, registry, lobby }, log }));', [
        'const modsApi = createModsApi({ mods, sendJson, sendError, log, loadMods: installMods });',
        'const server = http.createServer(createRequestHandler({ serveStatic, health: { startedAt, network, registry, lobby }, log, modsApi }));',
      ])) return null;
      out = out.replace('export async function startServer(opts = {}) {',
        '/** Files under mods/ that are never served (the manager\'s own bookkeeping). */\n'
        + "const MOD_PRIVATE = new Set(['mods.state.json', 'mods.updates.json', 'mods.cache.json']);\n\n"
        + 'export async function startServer(opts = {}) {');
      return out;
    },
  },

  // =============================================================================================================
  // 3) server/http/static.js —— /mods/ 静态挂载（必须排在 '/' 之前，否则被它吃掉）
  {
    id: 'static-mount',
    file: 'server/http/static.js',
    what: '/mods/ 静态挂载（排在 / 之前）',
    manual: `server/http/static.js —— createStaticHandler 的参数表里加 \`modsDir = null, modsDeny = null\`，\n`
      + `并在 mounts 数组里、\`{ prefix: '/', … }\` **之前**插入：\n`
      + `  ...(modsDir ? [{ prefix: '/mods/', name: 'mods', dir: path.resolve(modsDir), deny: modsDeny || undefined }] : []),`,
    once: (s) => s.includes("prefix: '/mods/'"),
    apply(s) {
      if (s.includes("prefix: '/mods/'")) return s;
      const sig = "export function createStaticHandler({ publicDir, dataDir, sharedDir, simDir = path.join(ROOT, 'server', 'sim'), packsDir = path.join(ROOT, 'packs'), packs = null, log = noopLog }) {";
      const mounts = "    { prefix: '/', name: 'public', dir: path.resolve(publicDir) },";
      if (!s.includes(sig) || !s.includes(mounts)) return null;
      return s
        .replace(sig, sig.replace('packs = null, log = noopLog }', 'packs = null, modsDir = null, modsDeny = null, log = noopLog }'))
        .replace(mounts,
          '    // Mod packages (sp-mods): a package\'s files are plain GETs under /mods/<folder>/… — the page imports its\n'
          + '    // client.js and the package fetches its own content/*.json. Must come BEFORE the \'/\' mount, which would\n'
          + "    // otherwise swallow it. `modsDeny` hides the manager's own bookkeeping (mods.state.json and friends).\n"
          + "    ...(modsDir ? [{ prefix: '/mods/', name: 'mods', dir: path.resolve(modsDir), deny: modsDeny || undefined }] : []),\n"
          + mounts);
    },
  },

  // =============================================================================================================
  // 4) server/http/routes.js —— /api/mods 分发给修改器的 HTTP 面
  //
  // ⚠️ 位置是这条补丁的**全部要害**：上游 0.2.x 的 handleRequest 里有一道
  //     `if (req.method !== 'GET' && req.method !== 'HEAD') → 405`
  //   （上游只服务 GET/HEAD，那道检查对它是正确的）。修改器的 HTTP 面有 POST 端点
  //   （upload / enable / disable / remove / rescan / updates），接线**必须落在那道检查之前** ——
  //   插在它后面的话，那些写操作全部被 405 掉：管理页能打开、能看列表，但一个按钮都按不动。
  //   这个坑真的踩过：旧版把接线插在 `await serveStatic(...)` 之前（= 405 之后），
  //   于是 v2 的管理页只读不能写。所以 `once` 不只看"标记在不在"，还要看**它在不在 405 之前**；
  //   `apply` 每次都先把已有接线整段摘掉再统一插到正确位置，这样已经装错的部署重跑一次就能修好。
  {
    id: 'api-route',
    file: 'server/http/routes.js',
    what: '/api/mods* 分发给修改器（在「非 GET/HEAD → 405」之前，否则 POST 端点全废）',
    manual: `server/http/routes.js —— createRequestHandler 的参数加 \`modsApi = null\`，并在\n`
      + `\`if (req.method !== 'GET' && req.method !== 'HEAD') {\` **之前**插入：\n`
      + `  // Mod packages (sp-mods): the manager's API.\n`
      + `  if (modsApi && (parts.rawPath === '/api/mods' || parts.rawPath.startsWith('/api/mods/'))) {\n`
      + `    if (await modsApi(req, res)) return;\n`
      + `  }\n`
      + `（放在那道 405 检查之前 —— 它是给纯静态站点写的，会让 upload/enable/remove 这些 POST 全部 405）`,
    once: (s) => {
      const MARK = "// Mod packages (sp-mods): the manager's API.";
      if (!s.includes(MARK)) return false;
      const at = s.indexOf(MARK);
      const guard = s.indexOf("if (req.method !== 'GET' && req.method !== 'HEAD')");
      return guard < 0 || at < guard;          // 位置不对 = 不算装好，逼 apply 去修
    },
    apply(s) {
      const MARK = "// Mod packages (sp-mods): the manager's API.";
      const GUARD = "    if (req.method !== 'GET' && req.method !== 'HEAD') {";
      const CALL = '    await serveStatic(req, res, parts.rawPath, parts.query);';
      const sigOld = 'export function createRequestHandler({ serveStatic, health, log }) {';
      const sigNew = 'export function createRequestHandler({ serveStatic, health, log, modsApi = null }) {';
      // 整段接线（从标记行到收尾的 `}`），缩进容忍 —— 用来把旧位置的那一段摘掉
      const BLOCK_RE = new RegExp(
        "\\n?[ \\t]*// Mod packages \\(sp-mods\\): the manager's API\\.[^\\n]*\\n"
        + "[ \\t]*if \\(modsApi && \\(parts\\.rawPath === '/api/mods' \\|\\| parts\\.rawPath\\.startsWith\\('/api/mods/'\\)\\)\\) \\{\\n"
        + '[ \\t]*if \\(await modsApi\\(req, res\\)\\) return;\\n'
        + '[ \\t]*\\}\\n',
      );

      let out = s;
      if (!out.includes(sigNew)) {
        if (!out.includes(sigOld)) return null;
        out = out.replace(sigOld, sigNew);
      }
      // 先摘掉已有接线（不论它当初插在哪），再统一插到正确位置 —— 一步同时做到幂等与"修好旧部署"
      out = out.replace(BLOCK_RE, '\n');
      if (out.includes(MARK)) return null;       // 摘不干净就拒绝，绝不插出两份
      const anchor = out.includes(GUARD) ? GUARD : (out.includes(CALL) ? CALL : null);
      if (!anchor) return null;
      const block = "    // Mod packages (sp-mods): the manager's API."
        + ' Handled before the method guard (it only allows GET/HEAD) and the static mounts.\n'
        + "    if (modsApi && (parts.rawPath === '/api/mods' || parts.rawPath.startsWith('/api/mods/'))) {\n"
        + '      if (await modsApi(req, res)) return;\n'
        + '    }\n';
      return out.replace(anchor, block + anchor);
    },
  },

  // =============================================================================================================
  // 5) public/js/screens/lobby.js —— 顶栏的 ui:button 宿主
  //
  // 放在 <LoadoutButton> 与博士名片之间：上游顶栏是 续战 → 干员调配 → 名片，宿主插在干员调配之后，
  // 于是模组按钮落在"干员调配入口"和"博士名片入口"中间。
  {
    id: 'lobby-buttons',
    file: 'public/js/screens/lobby.js',
    what: "顶栏的 ui:button 宿主（slot 'lobby.topbar'，位于干员调配与博士名片之间）",
    manual: `public/js/screens/lobby.js —— 在 \`import { LoadoutButton } from './loadout.js';\` 之后加：\n`
      + `  import { ModButtons } from '../ui/modButtons.js';\n`
      + `并把 \`<\${LoadoutButton} … />\` 那一行之后插入：\n`
      + `  <\${ModButtons} slot="lobby.topbar" class="lobby-modbtns" size="sm" variant="secondary" />`,
    once: (s) => s.includes('lobby-modbtns'),
    apply(s) {
      if (s.includes('lobby-modbtns')) return s;
      const imp = "import { LoadoutButton } from './loadout.js';";
      if (!s.includes(imp)) return null;
      const line = /(\n(\s*)<\$\{LoadoutButton\}[^\n]*\/>\n)/.exec(s);
      if (!line) return null;
      let out = s.replace(imp,
        imp + '\n'
        + '// Mod packages (sp-mods): the ui:button host. A package contributes plain descriptors; the host renders them\n'
        + "// with the game's own <Button> (public/js/ui/modButtons.js) — nothing renders when no package contributes.\n"
        + "import { ModButtons } from '../ui/modButtons.js';");
      out = out.replace(line[1], `${line[1]}${line[2]}<\${ModButtons} slot="lobby.topbar" class="lobby-modbtns" size="sm" variant="secondary" />\n`);
      return out.includes('lobby-modbtns') ? out : null;
    },
  },

  // =============================================================================================================
  // 6) public/index.html —— 管理页与接缝样式表
  {
    id: 'stylesheets',
    file: 'public/index.html',
    what: '引入 sp-mods.css（管理器与模组按钮样式）',
    manual: `public/index.html —— 在 </head> 之前加一行：\n  <link rel="stylesheet" href="/css/sp-mods.css" />`,
    once: (s) => s.includes('sp-mods.css'),
    apply(s) {
      if (s.includes('sp-mods.css')) return s;
      const anchor = '  <link rel="stylesheet" href="/css/devices.css" />';
      if (!s.includes(anchor)) return null;
      return s.replace(anchor, `${anchor}\n  <link rel="stylesheet" href="/css/sp-mods.css" />`);
    },
  },

  // =============================================================================================================
  // 7) public/js/render/app.js —— 战场事件接缝 5 条，合成**一条**补丁
  //
  //   field:event      （每帧一次 processEvents，逐事件）  `interp.takeEvents(…)` 之后
  //   field:damage     （每次伤害）                        `fx.damage(v, amt, e[3], src)` 那一行
  //   field:viewGone   （每个离开快照的 view）             `if (v.alive) { … }` 那一行
  //   field:frame      （每帧）                            `fx.update(dt); impostors.flush();` 之后
  //   field:overlay    （每帧，与上面同一处）
  //
  // 为什么合成一条：五条的落点都在同一个「战场视图」里，装一半（例如 frame 在、overlay 不在）对模组作者没有任何
  // 意义，而一起装/一起摘让「先摘后插」的升级路径只有一份实现。
  //
  // `battleMeta.fieldId` 作为 `battleId` 交给模组：0.2.4 的渲染层没有战斗 id（`render/interp.js` 不带，
  // `battle/runner.js` 也没往快照里放），而 fieldId 在**一场战斗内恒定、跨场会换** —— 正是模组给每场战斗
  // 归档状态需要的那个身份。要真 battleId 得多一条 `battle/runner.js` 的补丁（多一个 THEIRS 名额），不在本轮。
  {
    id: 'render-app-hooks',
    file: 'public/js/render/app.js',
    what: '战场接缝 5 条：field:event / field:damage / field:viewGone / field:frame / field:overlay',
    manual: `public/js/render/app.js —— 五处，逻辑都在 files/public/js/mods/render.js（一段都不要抄进 app.js）：\n`
      + `  ① 顶部（第 141 行 \`import { t } from '../../../shared/i18n.js';\` 之后）加一行\n`
      + `       import * as modRender from '../mods/render.js';\n`
      + `  ② processEvents：\`interp.takeEvents(renderT, EVS, renderT - 1.5, LATE);\` 之后加\n`
      + `       if (modRender.wantsEvents()) modRender.consumeEvents(EVS, renderT, battleMeta?.fieldId ?? null);\n`
      + `  ③ handleEvent 的 case 'dmg'：\`fx.damage(v, amt, e[3], src);\` 换成\n`
      + `       if (!modRender.takeDamage(v, amt, e[3], src, now, fx, battleMeta?.fieldId ?? null)) fx.damage(v, amt, e[3], src);\n`
      + `  ④ syncBattle：\`if (v.alive) { v.alive = false; v.dying = 0.25; v.dieDur = 0.25; }\` 换成\n`
      + `       if (v.alive) {\n`
      + `         const out = modRender.viewGone(v, now, battleMeta?.fieldId ?? null);\n`
      + `         if (out && typeof out === 'object' && out.die && typeof v.die === 'function') v.die(!!out.instant);\n`
      + `         else { v.alive = false; v.dying = 0.25; v.dieDur = 0.25; }\n`
      + `       }\n`
      + `  ⑤ frameBody：\`impostors.flush();\` 之后、\`} catch (err) {\` 之前加两行\n`
      + `       modRender.frameTick(dtRaw, interp.renderT, mode, clock, battleMeta?.fieldId ?? null);\n`
      + `       modRender.overlay(ctx, cam, clock, dtRaw, mode, layers, views, fx, tiles, battleMeta?.fieldId ?? null);\n`
      + `每处都先写第一行 \`// Mod packages (sp-mods): …\` 的注释（once 与 apply 靠这些块认人）。`,
    once: (s) => allBlocks(s, APP_HUNKS)                                       // 我方插入（规范形状）都在
      && s.includes('impostorSlot: () => impSlot++')                           // 0.2.4 形状在
      && !s.includes("from '../assets.js'")                                    // 一代覆盖层形状不在
      && !s.includes("modHooks.emit('field:")                                  // 同上（一代的调用点）
      && noDuplicates(s, ['modRender.consumeEvents(', 'modRender.takeDamage(', 'modRender.viewGone(',
        'modRender.frameTick(', 'modRender.overlay(']),                        // 没有插两遍
    apply: (s) => applyHunks(s, APP_HUNKS, {
      require: ['impostorSlot: () => impSlot++'],
      forbid: ["from '../assets.js'", "modHooks.emit('field:"],
    }),
  },

  // =============================================================================================================
  // 8) public/js/render/fx/numbers.js —— field:damageNumber 的两个 kind
  //
  //   kind: 'allow'  `number()` 开头，答 false = 这个数字不画（受击闪光等其余效果照旧）
  //   kind: 'text'   新建跳字那一刻（不是每次命中：被合并进累计值的那次命中在上游结构里就 return 了）
  //
  // 这两个 kind 的实现（`allowDamageNumber` / `damageNumberStyle`）在 files/public/js/mods/timing.js，
  // 由 mods/render.js 转出。**不要**改调 `damageNumberText`：它是 `damageNumberStyle` 的薄壳，两个都插 =
  // 每次伤害跑两遍钩子链。`scale` / `rise` 没有接线（要同时改 `_sizeNum` / `_numSlotPx`），清单见
  // 工作区 reports/seam-app-fx.md §6.5 坑 1 / 坑 2。
  {
    id: 'render-damage-number',
    file: 'public/js/render/fx/numbers.js',
    what: "跳字接缝：field:damageNumber 的 kind: 'allow' 与 kind: 'text'（text / color / life / big）",
    manual: `public/js/render/fx/numbers.js —— 四处，逻辑都在 files/public/js/mods/render.js：\n`
      + `  ① 顶部（第 4 行 \`import { DMG_STYLE, … } from '../style.js';\` 之后）加一行\n`
      + `       import { allowDamageNumber, damageNumberStyle } from '../../mods/render.js';\n`
      + `  ② number()：\`if (!(n > 0) || !view) return;\` 之后加 \`if (!allowDamageNumber(view, amount, style, big)) return;\`\n`
      + `  ③ 第 192 行 \`const life = near >= NUM_CROWD ? NUM_LIFE * 0.62 : NUM_LIFE;\` 之前加\n`
      + `       const ms = damageNumberStyle(view, amount, style, big);\n`
      + `     并把 life 那一行改成乘上模组要的时长（\`ms.life\`）\n`
      + `  ④ 新建数字那一段：\`t.text.text = …\` 换成 \`ms.text\`、加 tint 覆盖与复位（池里的 BitmapText 会带上一次的颜色）、\n`
      + `     \`big: !!big\` 换成 \`ms.big\`\n`
      + `每处都先写第一行 \`// Mod packages (sp-mods): …\` 的注释。`,
    once: (s) => allBlocks(s, NUM_HUNKS)                                       // 我方插入（规范形状）都在
      && s.includes('this._layoutNumsOnce(cam);')                              // 0.2.4 形状在
      && !s.includes('pickNum(') && !s.includes('numT(')                       // 一代覆盖层的形状不在
      && noDuplicates(s, ['allowDamageNumber(', 'damageNumberStyle(']),         // 没有插两遍
    apply: (s) => applyHunks(s, NUM_HUNKS, {
      require: ['this._layoutNumsOnce(cam);'],
      forbid: ['pickNum(', 'numT('],
    }),
  },

  // =============================================================================================================
  // 9) public/js/render/units.js —— 两条接缝**并成一条补丁**：HUD 钩子（unitBars / enemyBars / chip）+ STYLE 旋钮
  //
  //   A) 钩子（原有）：field:unitBars / field:enemyBars 改 bw / bh、底板 pad 与 alpha、HP 与 SP 的颜色；
  //      field:chip 改等级牌的 scaleMul / alpha / hidden。
  //   B) 旋钮（本轮新增，规格 reports/seam-style.md §3.3）：HUD（gap / 上限 / 底板）、护盾细线、隐匿 alpha、
  //      受击闪（tint / mix / decay）、飞行高度、倒地观感（DOWN_LOOK → DOWN）—— 全部"同名同默认值"，画面不变。
  //   还有两处**新分支**（默认关）：`chip.textGoldTier`（在 textures.js 里生效）与 `down.face: 'clock'`。
  //
  //   1.0.1（与 style-chip 的 drawChips 一起是"同一个补丁"的另一半，见那一条的注释）：
  //     · `hud.spHeightFactor` / `hud.spGapPx` 两个**已发布却没人读**的时序键接上（SP 行高 / 两行缝隙）；
  //     · SP 底板改成与 HP 行**同源**的 `backPad` / `backAlpha`（钩子答案优先，否则旋钮）。
  //     症状：技力条比血条薄（0.6×）且两行之间有一条 1.5px 的缝；模组写 `api.ui.setTiming` 改不动它们。
  //
  // 为什么必须并成一条：install.mjs:216 的 `st.patched[p.file]` 是"每文件一条记录"，两条补丁打同一文件会让
  // `--verify` / `--undo` 的记账只剩后一条（备份本身安全，但记录会丢）。两条的锚点也不重叠，一起装/一起摘。
  //
  // ⚠️ 0.2.4 与一代的形状差异（照抄一代会坏）：
  //   · `const bw` / `const bh` 必须改成 `let`（一代那句 `let` 是为模组改尺寸准备的；照抄 `const` 版本会
  //     `TypeError: Assignment to constant variable`，每次渲染该单位都抛）；
  //   · 一代的 `pickNum(...)` / `this.shieldVal`（数值屏障）/ `STYLE.hud.*` 在 0.2.4 里**不存在** ——
  //     `once` 把这几个都当成坏形状，出现任何一个就不算装好；
  //   · 护盾细线的 **1.5 px 下限要保留**（一代改成 `Math.max(1, …)` 是可见偏差）；
  //   · 受击闪那两处乘数不同（`1221` 有 ×0.8、`1261` 隐含 ×1），`decay` 的锚点必须整行 —— 同文件 `1164` 也有
  //     一个 `dt * 6`（悬停缓动），别碰错。
  {
    id: 'render-unit-hud',
    file: 'public/js/render/units.js',
    what: 'HUD 接缝（unitBars / enemyBars / chip + unitMotion）+ STYLE 旋钮（HUD/护盾/隐匿/受击闪/飞行/倒地/时钟盘面）'
      + ' + 1.0.1 的血条/技力条两行几何（行高 hud.spHeightFactor、行间缝隙 hud.spGapPx、SP 底板与 HP 行同源）'
      + ' + 1.1.0 的 field:attack 宣布（onAttack 一次调用 + attack/windUp 两处传 view）',
    manual: `public/js/render/units.js —— 五处钩子 + 十余处旋钮，逻辑都在 files/public/js/mods/render.js，`
      + `旋钮表在 ${STYLE_MOD}：\n`
      + `  ① 顶部（第 68 行 \`import { UF, ANIM } from '../../../shared/constants.js';\` 之后）加一行\n`
      + `       import * as modRender from '../mods/render.js';\n`
      + `  ② _updateHud 的 \`const bw = …\` / \`const bh = …\` 两行改成 \`let\`，并在其后插入\n`
      + `       const barStyle = modRender.unitBars(this.isEnemy, this, bw, bh, !!(this.flags & UF.SHIELD));\n`
      + `       if (barStyle) { if (Number.isFinite(barStyle.width)) bw = barStyle.width; if (Number.isFinite(barStyle.height)) bh = barStyle.height; }\n`
      + `  ③ HP 那四行：底板改成 backPad / backAlpha（默认 1 与 0.85），低血颜色走 barStyle.lowHpRatio / hpLowColor / hpColor\n`
      + `  ④ SP 那一行 tint：spColor / spActiveColor / spReadyColor（ammo 仍是上游的 COLORS.ammo）\n`
      + `  ⑤ 等级牌那一段：scaleMul / alpha / hidden，并在没人应答时把 alpha 复位成 1\n`
      + `  ⑥ style.js 的 import 尾部加 \`HUD, SHIELD, HIT_FLASH, FLY, DOWN, CHIP\`（第 71 行）\n`
      + `  ⑦ \`DOWN_LOOK\` 那 5 行常量换成 \`export const DOWN_LOOK = DOWN;\`（字段名一一对应，下面 6 个读点不用改）\n`
      + `  ⑧ 十余处字面量换成旋钮读（\`FLY.altitude\` / \`UNIT.stealthAlpha\` / \`HIT_FLASH.*\` / \`HUD.*\` /\n`
      + `     \`SHIELD.*\` / \`CHIP.height\` / \`DOWN.size|height|min|max|ring\`）—— 逐条见 apply 里的 SUBS\n`
      + `  ⑨ 新建等级牌之后登记精灵（\`registerChipSprite\`），等级牌那一段用旋钮算缩放；\`UnitView.destroy()\` 开头\n`
      + `     再 \`if (this.chip) unregisterChipSprite(this.chip);\`（登记表是模块级的，不摘就是常驻死引用）\n`
      + `  ⑩ _updateDownRing：加 \`const clock = DOWN.face === 'clock';\`，中央标签在 clock 档给空串并隐藏，\n`
      + `     再画/藏两根静止指针（\`hudHand\` + RING_HAND_AT，颜色 down.handInk，底板 down.faceInk）\n`
      + `  ⑪（1.0.1）SP 行三处：\n`
      + `     · \`const spH = Math.max(2, bh * (ammo ? AMMO_BAR.height : modRender.hudSpacing('hud.spHeightFactor', 0.6)));\`\n`
      + `     · \`sy = cy + bh / 2 + spH / 2 + modRender.hudSpacing('hud.spGapPx', 1.5);\`\n`
      + `     · SP 底板自己再算一份 spBackPad / spBackAlpha（表达式与 HP 行逐字相同：钩子答案优先、否则 HUD 旋钮），\n`
      + `       并用它设 position / width / height / alpha\n`
      + `     （\`hud.spHeightFactor\` / \`hud.spGapPx\` 是 files/public/js/mods/timing.js 里**早就发布**的两个键，\n`
      + `     出厂值 0.6 / 1.5 就是这两处的上游字面量；1.0.0 没有任何读点，模组的 \`api.ui.setTiming\` 写了也没用。）\n`
      + `  ⑫（1.1.0）\`field:attack\` 的**宣布**三处（一条钩子两半，计划那半边在 render/spine.js 的补丁里）：\n`
      + `     · onAttack 里 \`this.lunge = 1;\` 之后插 \`modRender.attackNotice(this, target, kind, once, now);\`\n`
      + `     · 下一行 \`this.actor.attack(this.atkInterval, once)\` → \`(…, once, this)\`\n`
      + `     · \`windUp(lead, kind)\` 里 \`this.actor.windUp(this.atkInterval, lead, !!PROJ[kind]?.once)\` → \`(…, this)\`\n`
      + `     （那个 \`this\` 就是 spine.js 的 \`view\` 形参：模组从它读 \`flags\` 里打包的攻击节奏，也拿它当"哪个单位"的凭据；\n`
      + `     一代这条宣布用的是 \`emit\`，handler 收不到 ctx —— 二代两半都用 \`run\`。详见 9) 的说明。）\n`
      + `每处都先写第一行 \`// Mod packages (sp-mods): …\` 的注释（once 与 apply 靠这些块认人）。`,
    once: (s) => allBlocks(s, UNIT_HUNKS)                                      // 我方插入（规范形状）都在
      && s.includes('this._updateElementBar(')                                 // 0.2.4 形状在
      && s.includes('let bw = clamp(s * (this.isBoss ? UNIT.bossBarWidth')     // const → let 改过了
      && !s.includes('const bw = clamp(s * (this.isBoss ? UNIT.bossBarWidth')  // 坏形状：还是 const
      && !s.includes('this.shieldVal') && !s.includes('pickNum(')              // 坏形状：抄了一代
      && !s.includes('MOTION_DEFAULTS')                                        // 坏形状：抄了一代的每帧对象
      && !s.includes('let cy = y - 4;')                                        // 旋钮没接上（还原态）
      && s.includes('y - HUD.gap')                                             // 旋钮接上了：HUD
      && s.includes('alpha *= UNIT.stealthAlpha;')                             // 旋钮接上了：隐匿 alpha
      && s.includes('dt * HIT_FLASH.decay')                                    // 旋钮接上了：受击闪衰减
      && s.includes('DOWN.min, DOWN.max')                                      // 旋钮接上了：倒地环尺寸
      && s.includes("const clock = DOWN.face === 'clock';")                    // 旋钮接上了：时钟盘面
      && s.includes('export const DOWN_LOOK = DOWN;')                          // 倒地常量换成活对象
      // 1.0.1 的两行几何：三个读点都在 + 1.0.0 的坏形状不在（AGENTS §0b 第 3 条）
      && s.includes("modRender.hudSpacing('hud.spHeightFactor', 0.6)")         // SP 行高读时序表
      && s.includes("modRender.hudSpacing('hud.spGapPx', 1.5)")                // 行间缝隙读时序表
      && s.includes('const spBackPad = barStyle && Number.isFinite(barStyle.backPadPx)')   // SP 底板与 HP 同源
      && !s.includes('this.spBg.width = bw + HUD.backPadPx * 2;')              // 坏形状：SP 底板只读旋钮
      && !s.includes('spH / 2 + 1.5;')                                         // 坏形状：缝隙写死 1.5px
      // 1.0.1 的时钟指针容器：`r.root`（不再用块级 `root`）+ 坏形状不在（AGENTS §0b 第 3 条）
      //   ⚠️ 判据不能写 `!s.includes('root.addChild(sp)')` —— `r.root.addChild(sp)` 里也含这串；
      //   也不能写 `; root.addChild(sp); return sp; }` —— 上游 `_updateDownRing` 里那个**合法**的 `mk` 助手
      //   （`const root` 就在同一个块里）正是这个形状。所以钉整行 mkHand。
      && s.includes('r.root.addChild(sp); return sp; }')
      && s.includes('r.root.addChild(r.hands.face);')
      && !s.includes('const mkHand = (tex) => { const sp = new P.Sprite(tex); sp.anchor.set(0.5); root.addChild(sp); return sp; };')   // 坏形状：裸 root（每帧 ReferenceError 的源头）
      && !s.includes('          root.addChild(r.hands.face);')                 // 坏形状同上（盘面那处）
      && noDuplicates(s, ['modRender.unitBars(', 'modRender.chip(', 'registerChipSprite(this.chip,',
        'modRender.unitMotion(', "const clock = DOWN.face === 'clock';",
        'const spBackPad = ', "modRender.hudSpacing('hud.spGapPx', 1.5)",
        'modRender.attackNotice(', 'this.actor.attack(this.atkInterval, once, this)',
        'this.actor.windUp(this.atkInterval, lead, !!PROJ[kind]?.once, this)',
        'const mkHand = '])                                                    // 没有插两遍
      && s.includes('unregisterChipSprite(this.chip)')                          // 销毁时摘出登记表
      // 1.1.0 的 field:attack 宣布：三处都在（少一处 = 半装）+ 一代那半的形状不在（AGENTS §0b 第 3 条）
      && s.includes('modRender.attackNotice(this, target, kind, once, now)')
      && s.includes('this.actor.attack(this.atkInterval, once, this)')
      && s.includes('this.actor.windUp(this.atkInterval, lead, !!PROJ[kind]?.once, this)')
      && !s.includes("modHooks.emit('field:attack'")                            // 坏形状：一代的 emit（handler 收不到 ctx）
      && !s.includes('view.strikeDelay'),                                       // 坏形状：抄了一代的 `view.strikeDelay`,
    apply: (s) => applyHunks(s, UNIT_HUNKS, {
      require: ['this._updateElementBar(', 'showBars && !!this.el'],
      forbid: ['this.shieldVal', 'pickNum(', 'MOTION_DEFAULTS', 'hudTiming('],
      staleBlocks: [
        [UNIT_STYLE_TEX_ANCHOR, UNIT_STYLE_TEX_STALE_LINES],
        // 1.0.0 的 SP 底板（只读旋钮）：块正文变了 ⇒ blockRe 认不出旧的，必须在插入之前逐字摘掉（退回上游原句）
        [UNIT_SPBG_ANCHOR, UNIT_SPBG_BLOCK_100],
        // 1.0.0/1.1.0 之前的时钟指针块（裸 `root` ⇒ 第一个倒下的干员起每帧 ReferenceError）：同上先退役
        [DOWN_CLOCK_ANCHOR, DOWN_CLOCK_BLOCK_100],
      ],
    }),
  },

  // =============================================================================================================
  // B2) public/js/render/spine.js —— **field:attack 的计划**（`windUp` / `attack`）
  //
  // 与上面那条 units.js 补丁是**同一条钩子的两半**：宣布在那边（每次攻击一次），计划在这里（起手帧 + 事件帧各一次）。
  // 拆成两条补丁是因为它们改的是两个上游文件 —— catalog 的 THEIRS 是"文件 → 补丁 id"的一对一表。
  //
  // ⚠️ 锚点脆弱度**高**：`windUp`（0.2.4 的 365-387）与 `attack`（393-432）是上游改得最勤的两段
  // （`clipPerAttack` / `wound` / `skillClipOnce` / `_pendingDeployElapsed` 都在这几行附近进进出出）。所以 `once`
  // 钉在**我们自己写入的形状**上，并且明确拒绝一代那套编排的字段名（`_swing` / `_glide` / `_modOnce` / `ATTACK_REPLAY_EPS`）——
  // 一旦有人在 0.2.4 的 spine.js 里搬了整块，`update()` 里必须同时有滑行消费段，否则攻击态永远卡住（§0b 第 3 条）。
  {
    id: 'render-attack-plan',
    file: 'public/js/render/spine.js',
    what: 'field:attack 的 clip 计划：`windUp` / `attack` 各一处（start / timeScale / ts / once / hold / rephase）',
    manual: `public/js/render/spine.js —— 一条 import + 一个适配器 + 两个方法各改一处，逻辑都在 files/public/js/mods/render.js：\n`
      + `  ① 顶部（\`const clampN = (v, lo, hi) => …\` 那一行**之前**）加 \`import * as modRender from '../mods/render.js';\`\n`
      + `  ② \`windUpPlan\` 之后加适配器\n`
      + `       function modAttackPlan(view, phase, loopDur, hit, interval, lead, start, timeScale, ts) {\n`
      + `         return view ? modRender.attackClipPlan(view, phase, loopDur, hit, interval, lead, start, timeScale, ts) : null;\n`
      + `       }\n`
      + `  ③ \`windUp(interval, lead, once = false)\` → 多一个 \`view = null\` 形参\n`
      + `  ④ \`windUp\` 正文：\`windUpPlan\` 之后问一次计划，按答案改三件事 —— \`return false\` 的判据（\`start == null\`）、\n`
      + `     \`attackUntil\`（\`hold\`）、\`_play\` 的 timeScale/start 与 \`windTs\`。没装包时逐字等于上游那六行\n`
      + `  ⑤ \`attack(interval, once = false)\` → 多一个 \`view = null\` 形参\n`
      + `  ⑥ \`attack\` 正文：\`wasAttacking\` 之后问一次计划（\`whole\` 从下面那个分支提到这里 —— 纯读 \`this.interval\`，\n`
      + `     而 shipped.start 要用它），\`single\` / \`attackUntil\` 按答案算\n`
      + `  ⑦ \`if (!wasAttacking)\` 那三段分支：\`single\` / \`ts\` / 重相位的 \`0.8\` 换成上面算出的值，start 由答案决定\n`
      + `每个插入块第一行都是 \`// Mod packages (sp-mods): …\`。`,
    once: (s) => allBlocks(s, SPINE_HUNKS)                            // 我方插入（规范形状）都在
      && s.includes('export function windUpPlan(')                    // 0.2.4 形状在
      && s.includes('this.clipPerAttack && !once') && s.includes('_hitTime(clip.loop, loopDur)')
      && s.includes('windUp(interval, lead, once = false, view = null)')
      && s.includes('attack(interval, once = false, view = null)')
      && noDuplicates(s, ['modRender.attackClipPlan(', "import * as modRender from '../mods/render.js';",
        "modAttackPlan(view, 'windUp'", "modAttackPlan(view, 'attack'"])       // 没有插两遍
      && !s.includes('this._glide') && !s.includes('_swingRephase') && !s.includes('this._modOnce')
      && !s.includes('ATTACK_REPLAY_EPS') && !s.includes('REPHASE_GLIDE') && !s.includes('attackPhaseDefault'),
    apply: (s) => applyHunks(s, SPINE_HUNKS, {
      require: ['export function windUpPlan(', 'this.clipPerAttack && !once', 'const wasAttacking = '],
      // 一代那套"攻击编排"不许出现在 0.2.4 的 spine.js 里（见 9b) 的说明）。
      forbid: ['this._glide', 'this._swing', 'this._modOnce', 'ATTACK_REPLAY_EPS', 'REPHASE_GLIDE', 'attackPhaseDefault'],
    }),
  },

  // =============================================================================================================
  // R) server/sim/ai.js —— **模拟接缝**（sim:enemyAI / targets / targetOrder / attackMode / attack / strikeDelay）
  //
  // 这条**取代**了原来的 `sim-ai-import-repair`（那条只修一代"用了 simHas 却没 import"的坏形状）。一代往这个
  // 文件插过三个调用点（targetOrder / attackMode ×2）却没带 import，每次敌人攻击抛
  // `ReferenceError: simHas is not defined`，被 sim 的守卫吞成一行 internal 报错，表现成「敌人不还手」——
  // 正是 AGENTS §0b 第 1 条说的那类 `--check` 一律放过的错。二代不再"修"它，而是把整个文件做成正式接缝：
  // 规范形状（import + 六处守卫调用）在 = 装好；一代的覆盖层形状在 = `forbid` 拒绝（绝不半装）。
  //
  // ⚠️ 值型钩子与 `let`：`sim:enemyAI` 可能交回替身对象，`updateEnemy` 的参数是 `e`（函数形参可重赋值）；
  // `acquireTargets` 的候选表因此从 `const cands` 改成 `let cands`。写成 `const` 会每 tick 抛
  // "Assignment to constant variable"，引擎的内部错误预算随后把整场战斗 force-end 成 timeout。
  // ⚠️ `sim:attackMode` 的答案只进**局部变量**，绝不写回 `prof`：`effectiveProfile` 在没有技能时直接返回
  // `u.profile` 这个共享对象，写它会让同 def 的单位永久变成近战（一代的注释里记的就是这个坑）。
  {
    id: 'sim-ai-hooks',
    file: 'server/sim/ai.js',
    what: 'AI 接缝 6 条：sim:enemyAI / sim:targets / sim:targetOrder / sim:attackMode（我方+敌人）/ sim:attack / sim:strikeDelay',
    manual: `server/sim/ai.js —— 六处，逻辑都在 ${SIM_MOD}（一段都不要抄进这个文件）：\n`
      + `  ① 顶部（\`import { hypot, powi } from './detmath.js';\` 之后）加\n`
      + `       import { simLogic, simHas, simStrikeDelay } from './modlogic.js';\n`
      + `  ② updateEnemy() 的 \`if (!e.alive) return;\` 之后跑 \`sim:enemyAI\`（值型，可返回同 id 的替身）\n`
      + `  ③ acquireTargets()：\`const cands\` → \`let cands\`，其后跑 \`sim:targets\`（候选表可整表替换）\n`
      + `  ④ acquireTargets() 的 sortEnemyTargets 之后、截断之前跑 \`sim:targetOrder\`（最终顺序）\n`
      + `  ⑤ performAttack() 的 ranged/vis 两行：先算 \`_blockMelee\`（跑 \`sim:attackMode\`），再算 ranged/vis\n`
      + `     （**不要**写回 prof._fortressMelee）；enemyAttack() 的 \`const melee\` → \`let melee\` + 同一个钩子\n`
      + `  ⑥ performAttack()：每个目标跑 \`sim:attack\`（倍率进 info.atkMul），resolveHit 的 \`let mulT = skillMul\` 乘上它；\n`
      + `     并在目标循环之前跑 \`simStrikeDelay\`（\`_strike(fn)\` 包住三条结算路径）；enemyAttack() 同样两处\n`
      + `每处都先写 \`// Mod packages (sp-mods): …\` 的注释（once 与 apply 靠这些块认人）。`,
    once: (s) => allBlocks(s, AI_HUNKS)                                        // 我方插入（规范形状）都在
      && s.includes('export function resolveHit(b, u, prof, target, info, x, y) {')   // 0.2.4 形状在
      && s.includes("import { hypot, powi } from './detmath.js';")
      && !s.includes('/* sp-mods: block rules */')                             // 一代的覆盖层形状不在
      && noDuplicates(s, ["simLogic.run('sim:enemyAI'", "simLogic.run('sim:targets'",
        "simLogic.run('sim:targetOrder'", "simLogic.run('sim:attack'",
        'battle: b, unit: u, profile: prof, isSkill, isEnemy: false,',
        'battle: b, unit: e, profile: e.profile, isSkill: false, isEnemy: true,',
        'simStrikeDelay(u, { battle: b, profile: prof, targets, isSkill })',
        'simStrikeDelay(e, { battle: b, profile: e.profile, targets, isSkill: false })']),   // 没有插两遍
    apply: (s) => applyHunks(s, AI_HUNKS, {
      require: ['export function resolveHit(b, u, prof, target, info, x, y) {', 'export function acquireTargets(b, u, prof) {'],
      forbid: ['/* sp-mods: block rules */'],
    }),
  },

  // =============================================================================================================
  // A) public/js/render/style.js —— STYLE 旋钮层的第一半：两个上游常量变成"带访问器的活对象"
  //
  // 只做四件事，一行都不删：
  //   ① 顶部加一行 import（指向我方 files/public/js/mods/style.js）；
  //   ② `export const COLORS = Object.freeze({` → `… = makeStyleStore('color', {`；
  //   ③ `export const UNIT = Object.freeze({`   → `… = makeStyleStore('unit', {`；
  //   ④ 文件尾把 9 组旋钮面 re-export 出去（渲染层与模组侧从此读同一批对象）。
  //
  // `Object.freeze({…})` → `makeStyleStore('…', {…})` 是**括号配平**的纯 token 互换：原来的收尾 `});` 继续闭合工厂
  // 调用，导出名与对象身份都不变 ⇒ 全仓 11 个 `from '../…/style.js'` 的导入点一行都不用改，读到的值自动变成
  // "模组值 ?? 上游默认"。上游全仓没有 `Object.isFrozen(COLORS)` / `Object.keys(COLORS)` 这类用法（规格 §2.2）。
  {
    id: 'style-knobs',
    file: 'public/js/render/style.js',
    what: 'STYLE 旋钮层：COLORS / UNIT 变成活对象 + 9 组旋钮面从 public/js/mods/style.js re-export',
    manual: `public/js/render/style.js —— 四处，旋钮表本身在我方 ${STYLE_MOD}（一段都不要抄进这个文件）：\n`
      + `  ① 第 1 行注释之后加两行注释 + \`import { makeStyleStore } from '../mods/style.js';\`\n`
      + `  ② 第 41 行 \`export const COLORS = Object.freeze({\` → \`export const COLORS = makeStyleStore('color', {\`\n`
      + `  ③ 第 203 行 \`export const UNIT = Object.freeze({\` → \`export const UNIT = makeStyleStore('unit', {\`\n`
      + `  ④ 文件尾（第 211 行 \`});\` 之后）加 §A 那段 re-export（STYLE / STYLE_KEYS / STYLE_BASE / setStyleKnob /\n`
      + `     styleKnob / styleOverrides / resetStyleKnobs / onStyleChange + HIT_FLASH / FLY / HUD / DOWN / CHIP /\n`
      + `     SHIELD / DMG，全部 from '../mods/style.js'）`,
    // 三件事一起看（AGENTS §0b 第 3 条）：规范形状在 + 上游字面量形状不在 + 一代覆盖层的形状不在
    once: (s) => s.includes("makeStyleStore('unit', {") && s.includes("from '../mods/style.js'")
      && !s.includes('export const UNIT = Object.freeze({')
      && !s.includes('export const COLORS = Object.freeze({'),     // 一代覆盖层/坏形状：还是冻结字面量
    apply: (s) => applyHunks(s, [
      { anchor: STYLE_HEAD_ANCHOR, block: STYLE_HEAD_BLOCK },
      { anchor: 'export const COLORS = Object.freeze({', block: "export const COLORS = makeStyleStore('color', {" },
      { anchor: 'export const UNIT = Object.freeze({', block: "export const UNIT = makeStyleStore('unit', {" },
      { anchor: STYLE_TAIL_ANCHOR, block: STYLE_TAIL_BLOCK },
    ]),
  },

  // =============================================================================================================
  // B) public/js/render/textures.js —— 等级牌图集按 CHIP 绘制（写 chip.* 后重画）
  //
  //   · `drawChips` 的每个字面量改读 CHIP（默认逐项 = 上游，见规格 §5），并且**只有** golden + textGoldTier 这一
  //     条新分支会改变画面（默认 false ⇒ 走原句）；
  //   · 1.0.1 修的是同一个函数里的**颜色回退链**：`chipCssColor(null)` 得到字符串 `"null"`，赋给 canvas 的
  //     `fillStyle` / `strokeStyle` 是静默无效 ⇒ 画布留着上一次的涂装（底板色，之前是纯黑）。于是"描边/数字写
  //     `null` = 未设置、请回退该等级的 ink"这个语义整个失效，模组的普通牌画成**一整块黑**（描边黑 + 数字黑 +
  //     黑板）。现在三段回退都在 drawChips 里解析完再赋值：描边 ← `strokeGold|strokeInk ?? ink{t}`、
  //     数字 ← `textGold ?? textInk ?? 描边`（golden + textGoldTier 时先取 `ink{t}`）、底板为空则不填。
  //     出厂逐键非空 ⇒ 解析结果就是上游字面量，画面不变。
  //   · `tierChip` 的格子尺寸读 CHIP.width / CHIP.height（`_chips` 的矩形与精灵的 UV 都是从这里算的）；
  //   · 新增两个颜色工具 + 一个 `onStyleChange` 订阅：写 chip.* → 微任务里重画同一张画布、同一张 BaseTexture
  //     ⇒ 已经发出去的牌自动跟着变（上游的 `refreshTierChips` 用的就是这个机制，这里只是换成"旋钮变了也走它"）。
  {
    id: 'style-chip',
    file: 'public/js/render/textures.js',
    what: '等级牌图集读 chip.* 旋钮（含 chip.textGoldTier）+ 1.0.1 的颜色回退链（strokeInk/textInk 写 null = '
      + '回退该等级的 ink1..6，而不是画成纯黑）+ 写旋钮即重画',
    manual: `public/js/render/textures.js —— 五处：\n`
      + `  ① 第 15 行 import 加两个名字：\`… linearToSrgb255, CHIP, onStyleChange\`\n`
      + `  ② \`let _chips = null;\` 之后加两个颜色小工具（chipCssColor / chipPlateFill）\n`
      + `  ③ 整个 drawChips() 换成 §B 的版本（读 CHIP；golden 且 chip.textGoldTier 时数字色用该等级的 ink）\n`
      + `  ④ tierChip() 的 \`const w = 64, h = 44;\` → \`const w = CHIP.width, h = CHIP.height;\`\n`
      + `  ⑤ refreshTierChips() 之后加 \`rebuildChipsFromKnobs()\` 与一行订阅：\n`
      + `     \`onStyleChange((groups) => { if (groups.has('chip') || groups.has('*')) rebuildChipsFromKnobs(); });\`\n`
      + `     （重画就是上游的 refreshTierChips：同画布、同 BaseTexture、同格子尺寸 ⇒ 已发出的牌立刻跟着变）\n`
      + `  ⑥ \`let _rings = null;\` 之前加静止指针与盘面的纹理：\`RING_HAND_W\`（带环宽度，由 RING_W 与那圈深色边缘算\n`
      + `     出）/ \`RING_HAND_A0\` / \`RING_HAND_LEN\` / \`RING_HAND_AT\` + \`hudHand(angle)\` + \`hudClockFace()\`\n`
      + `     ⚠️ 锚点必须是 \`let _rings = null;\`：这段读 \`RING_R\` / \`RING_W\` / \`RC\`，而它们声明在 ring atlas 那一节。\n`
      + `     插在 \`let _bg = null;\`（文件前部）时三个都是 TDZ，textures.js 一 import 就抛\n`
      + `     \`ReferenceError: Cannot access 'RING_W' before initialization\` —— 整层渲染起不来（\`node --check\` 看不出来）。\n`
      + `  ⑦ \`let _chips = null;\` 之后再加等级牌的精灵登记表（\`registerChipSprite\` / \`unregisterChipSprite\` /\n`
      + `     \`recutChipSprites\`：\`chip.width/height\` 变了以后把场上的牌按新格子重切），\`rebuildChipsFromKnobs\` 分\n`
      + `     "纯重绘"与"几何变了就重切"两路\n`
      + `  ⑧（1.0.1）drawChips 里的颜色一律先过 \`css(v)\`：\`null\` / \`''\` 交回 \`null\`，赋值前判空 ——\n`
      + `     \`fillStyle = String(null)\` 是**静默无效**（画布留着上一次的涂装，默认是纯黑）。回退链三段：\n`
      + `       · \`stroke = (golden ? strokeGold : strokeInk) ?? ink{t}\`\n`
      + `       · \`ink = ((golden && textGoldTier) ? (ink{t} ?? textInk) : (golden ? (textGold ?? textInk) : textInk)) ?? stroke\`\n`
      + `       · 底板 \`plateGold|plate\` 为空则不填（不画黑板）\n`
      + `     出厂逐键非空 ⇒ 这条链解析出的就是上游那三个字面量，画面不变。`,
    // 三件事一起看（AGENTS §0b 第 3 条）：规范形状在 + 上游字面量形状不在 + 旧坏形状不在
    once: (s) => s.includes('const K = CHIP;') && s.includes('const w = CHIP.width, h = CHIP.height;')
      && s.includes("onStyleChange((groups) => { if (groups.has('chip')")
      && s.includes('K.textGoldTier === true') && s.includes('CHIP, onStyleChange')
      && s.includes('export function registerChipSprite(')                          // 精灵登记表在
      && s.includes('recutChipSprites();')                                          // 几何变了会重切
      && s.indexOf('export const RING_HAND_W =') > s.indexOf('const RING_R = 26')   // 指针那一节在常量**之后**
      && countOf(s, 'const chipSprites = [];') === 1                     // 登记表只有一份（插两遍是这个形状）
      && countOf(s, 'const chipCssColor = ') === 1                       // 两个小工具也只有一份
      && countOf(s, 'function drawChips(c, w, h) {') === 1               // drawChips 也只有一份
      && !s.includes('refreshTierChips();\n}')                                      // 旧版 rebuildChipsFromKnobs 不在
      // 1.0.1：颜色回退链在（`ink{t}` 是链条的底），且 1.0.0 的坏形状不在
      && s.includes('const tierInk = K[`ink${t}`];')
      && s.includes('const stroke = (g ? K.strokeGold : K.strokeInk) ?? tierInk;')
      && s.includes('const css = (v) => (v == null')                     // null 不再变成字符串 "null"
      && !s.includes('c.fillStyle = chipCssColor(ink);')                 // 坏形状：不看 null 直接赋值
      && !s.includes('c.strokeStyle = chipCssColor(g ? K.strokeGold : K.strokeInk); c.stroke();')
      && !s.includes("c.font = `700 ${t >= 4 ? 24 : 27}px Bender"),      // 上游字面量形状不在 = 真的改过了
    apply: (s) => applyHunks(s, TEXTURE_HUNKS, {
      require: ['function roundRect(ctx, x, y, w, h, r)', 'export function refreshTierChips()'],
      staleBlocks: TEXTURE_STALE,
    }),
  },

  // =============================================================================================================
  // C) public/js/render/fx/fonts.js —— 跳字字模按 dmg.* 烘制（并补上游没有的 rebuildDamageFonts）
  //
  // 上游 21 行、只烘一次（`fontsReady`）。这里做三件事：面栈读 `dmg.font`、每一档的涂装读 `dmg.*Fill`
  // （`flat` 单色 / `stroke` 覆盖），以及**新增** `rebuildDamageFonts()` —— 模组 client.js:892 已经在探测这个名字
  // （它用 `typeof fx.rebuildDamageFonts === 'function'` 判断能不能运行期切档）。
  //
  // `fx.js` 是一行 barrel（`export { ensureDamageFonts } from './fx/fonts.js';`），新名字要一起转出去；`fx/system.js`
  // 的 FxSystem 加一个转发方法，模组才够得着（它拿到的是 FxSystem 实例，不是模块）。
  {
    id: 'style-dmg',
    file: 'public/js/render/fx/fonts.js',
    what: '跳字字模读 dmg.* 旋钮（面栈 / 单色 / 描边 / 五档填充色）+ 新增 rebuildDamageFonts()',
    manual: `public/js/render/fx/fonts.js —— 整个文件按 §C 重写（21 行 → 约 60 行）：\n`
      + `  · import 变成 \`import { DMG_STYLE, DMG } from '../style.js';\`\n`
      + `  · 新增 faceStack()（读 dmg.font，取第一个可用族）与 paint(key, st)（读 dmg.*Fill / flat / stroke）\n`
      + `  · ensureDamageFonts() 用上面两个函数烘每一档（flat 档不描边、不投影 —— PIXI 7.4.2 遇 stroke:null 会抛，\n`
      + `    上游那句注释就是血泪）\n`
      + `  · 新增 export function rebuildDamageFonts()：先删掉 PIXI.BitmapFont.available 里的旧字模，再 fontsReady=false\n`
      + `    + ensureDamageFonts()\n`
      + `另两处（让模组够得着这个名字）：\n`
      + `  · public/js/render/fx.js:44 → \`export { ensureDamageFonts, rebuildDamageFonts } from './fx/fonts.js';\`\n`
      + `  · public/js/render/fx/system.js —— FxSystem 类里加 \`rebuildDamageFonts() { … }\`（转发 + 清空数字池）`,
    once: (s) => s.includes("import { DMG_STYLE, DMG } from '../style.js';")
      && s.includes('export function rebuildDamageFonts()') && s.includes('DMG_STYLE')
      && !s.includes("fill: st.fill, fillGradientStops: [0.25, 1], stroke: st.stroke, strokeThickness: 7,"),
    apply: (s) => {
      // 整份替换：上游那 14 行必须逐字都在，否则拒绝（认不出 = 上游换实现了，不做半装）
      for (const f of FONTS_SIGNATURE) if (!s.includes(f)) return null;
      return FONTS_SOURCE;
    },
  },

  // =============================================================================================================
  // D) public/js/render/fx.js + fx/system.js —— 把 rebuildDamageFonts() 透出去
  //
  // 为什么值一条补丁：模组的运行期切档（改 dmg.* 之后让跳字换外观）靠 `fx.rebuildDamageFonts()`，而它拿到的
  // `ctx.fx` 是 `FxSystem` 的实例 —— 上面没有这个方法就等于"旋钮收下但不换字"。两个文件各一行。
  {
    id: 'style-dmg-rebuild',
    file: 'public/js/render/fx.js',
    what: 'barrel 转出 rebuildDamageFonts（fx/fonts.js 的新导出）',
    manual: `public/js/render/fx.js —— 第 44 行：\n`
      + `  \`export { ensureDamageFonts } from './fx/fonts.js';\`\n`
      + `  → \`export { ensureDamageFonts, rebuildDamageFonts } from './fx/fonts.js';\``,
    once: (s) => s.includes('export { ensureDamageFonts, rebuildDamageFonts } from'),
    apply: (s) => {
      const anchor = "export { ensureDamageFonts } from './fx/fonts.js';";
      if (!anchorOnce(s, anchor)) return null;
      return s.replace(anchor, "export { ensureDamageFonts, rebuildDamageFonts } from './fx/fonts.js';");
    },
  },
  {
    id: 'style-dmg-system',
    file: 'public/js/render/fx/system.js',
    what: 'FxSystem.rebuildDamageFonts()：转发给 fx/fonts.js 并丢掉在飞/池里的数字',
    manual: `public/js/render/fx/system.js ——\n`
      + `  ① 第 5 行 import 加名字：\`import { ensureDamageFonts, rebuildDamageFonts } from './fonts.js';\`\n`
      + `  ② FxSystem 类里加一个方法（**插在类的收尾 \`}\\n\` 之前**，不是插在构造器里）：\n`
      + `       rebuildDamageFonts() {\n`
      + `         rebuildDamageFonts();\n`
      + `         for (const t of this._nums || []) this._releaseNum?.(t);\n`
      + `         (this._nums || []).length = 0;\n`
      + `       }\n`
      + `     ⚠️ 锚点必须用**类收尾的大括号**（\`}\\n\\nconst FX_PARTS\`）。曾经的锚点是构造器里的\n`
      + `     \`    ensureDamageFonts();\` —— 0.2.4 的构造器在那行之后还有约 60 行（建各条粒子池、\n`
      + `     \`this.parts = []\` 等），在那里收尾构造器会把**剩下半个构造器塞进新方法体**：\n`
      + `     池子从此永不初始化 → 每帧 \`fx.update()\` 抛 \`Cannot read properties of undefined (reading 'length')\`\n`
      + `     （particles.js 的 \`this.parts.length\`），整帧被 app.js 的 try/catch 吞掉 ⇒ \`field:frame\` /\n`
      + `     \`field:overlay\` 一次都不发（渲染接缝全哑）＋ 画面没有粒子/弹道/跳字。`,
    // 三件事一起看（AGENTS §0b 第 3 条）：规范块在 + 上游形状在 + 坏形状不在
    once: (s) => s.includes('rebuildDamageFonts() {') && s.includes('rebuildDamageFonts } from')
      && s.includes('this.parts = [];') && s.includes('this.atlas = fxAtlas();')
      && !s.includes('  }\n\n  /**\n   * Re-bake the damage-number fonts')     // 构造器被截断的坏形状不在
      && s.indexOf('rebuildDamageFonts() {') < s.indexOf('const FX_PARTS'),   // 方法在类内、FX_PARTS 之前
    apply: (s) => {
      const imp = "import { ensureDamageFonts } from './fonts.js';";
      if (!anchorOnce(s, imp)) return null;
      const out = s.replace(imp, "import { ensureDamageFonts, rebuildDamageFonts } from './fonts.js';");
      const anchor = '}\n\nconst FX_PARTS = ';
      if (!anchorOnce(out, anchor)) return null;
      return out.replace(anchor, [
        '  /**',
        "   * Re-bake the damage-number fonts from the current `dmg.*` knobs (`api.style.set('dmg.flat', true)` …) and",
        '   * release every number still on screen, so the next hit draws with the new look.',
        '   *',
        '   * Mod packages (sp-mods): a package may retune `dmg.*` at run time; this forwards to the one place that',
        '   * bakes the bitmap fonts and drops the numbers already in flight (a pooled BitmapText would otherwise keep',
        '   * the OLD glyphs — `BitmapFont.from` on an existing name replaces the texture set, not the live text objects).',
        '   * See public/js/mods/style.js (`DMG`) and reports/seam-style.md §3.5.',
        '   */',
        '  rebuildDamageFonts() {',
        '    rebuildDamageFonts();',
        '    for (const t of this._nums || []) this._releaseNum?.(t);',
        '    if (this._nums) this._nums.length = 0;',
        '  }',
        '}',
        '',
        'const FX_PARTS = ',
      ].join('\n'));
    },
  },

  // =============================================================================================================
  // S) 模拟接缝的其余落点（生命周期 / 伤害 / 快照 / spec / 谁把模块交出去）+ AI 决策接缝 + 内容与美术两条门
  //
  // 每条都遵守同一套判据（AGENTS §0b 第 3 条）：`once` = 规范块逐字都在 + 0.2.4 形状在 + **一代的覆盖层形状不在**
  // + 没有插两遍；`apply` 先整段摘旧再插，锚点缺失/不唯一一律返回 null（宁可拒绝，也不半装）。
  {
    id: 'sim-battle-hooks',
    file: 'server/sim/battle/lifecycle.js',
    what: '战斗生命周期接缝：sim:battleStart / sim:unitTick（双方，每 tick）/ sim:battleEnd',
    manual: `server/sim/battle/lifecycle.js —— 五处，逻辑都在 ${SIM_MOD}：\n`
      + `  ① 顶部 \`import { updateAlly, updateEnemy } from '../ai.js';\` 之后加\n`
      + `       import { simLogic, simHas } from '../modlogic.js';\n`
      + `  ② start()：\`this.emit('battleStart', {});\` 之后加 \`if (simHas('sim:battleStart')) simLogic.emit('sim:battleStart', { battle: this });\`\n`
      + `  ③ step() 的敌人循环：\`const e = list[i]\` → \`let e\`，并在 \`if (!e.alive) continue;\` 之后跑 \`sim:unitTick\`\n`
      + `  ④ step() 的我方循环：\`const u = list[i]\` → \`let u\`，同样一处（\`side: u.side\`）\n`
      + `  ⑤ _finish()：在 \`this.emit('battleEnd', { result: res });\` **之前**加 \`sim:battleEnd\`\n`
      + `⚠️ ③④ 的循环变量必须是 \`let\`：两个钩子都是值型，可能交回替身对象。`,
    once: (s) => allBlocks(s, LIFE_HUNKS)
      && s.includes("if (this._hooks.tick) this._phase('tickHook'")            // 0.2.4 形状在
      && noDuplicates(s, ["simLogic.emit('sim:battleStart'", "simLogic.emit('sim:battleEnd'",
        "simLogic.run('sim:unitTick', e,", "simLogic.run('sim:unitTick', u,"]),
    apply: (s) => applyHunks(s, LIFE_HUNKS, {
      require: ["if (this._hooks.tick) this._phase('tickHook'", 'export class BattleLifecycle {'],
      forbid: ['modUnitTick'],
    }),
  },
  {
    id: 'sim-damage',
    file: 'server/sim/damage.js',
    what: '伤害接缝：sim:damage（每一次进入主管线的命中，可改 dmg.mul / amount / type，或 dmg.cancel 取消）',
    manual: `server/sim/damage.js —— 两处，逻辑都在 ${SIM_MOD}：\n`
      + `  ① 顶部 \`import { evadesGround } from './targeting.js';\` 之后加 \`import { simLogic, simHas } from './modlogic.js';\`\n`
      + `  ② dealDamage()：在 \`const type = dmg.type;\` 之前跑 \`sim:damage\`\n`
      + `       simLogic.run('sim:damage', { battle, source: hs, target, dmg }, { battle });\n`
      + `     handler **原地改** \`dmg\`（换对象不生效）；\`dmg.cancel\` 为真时这一次命中作废。\n`
      + `⚠️ 元素伤害在上面那条分支就 return 了，走不到这个接缝（与本体自己的 \`hit\` 钩子同一范围）。`,
    once: (s) => allBlocks(s, DMG_HUNKS)
      && s.includes('export function dealDamage(battle, source, target, dmgIn) {')   // 0.2.4 形状在
      && noDuplicates(s, ["simLogic.run('sim:damage'"]),
    apply: (s) => applyHunks(s, DMG_HUNKS, {
      require: ['export function dealDamage(battle, source, target, dmgIn) {'],
      forbid: ["battle._handlerError?.('sim:damage'"],
    }),
  },
  {
    id: 'sim-snapshot',
    file: 'server/sim/snapshot.js',
    what: '快照接缝：sim:attackRhythm（flags 16…31 位的攻击节奏）+ sim:attackAnim（ATTACK 窗口长度）',
    manual: `server/sim/snapshot.js —— 四处，逻辑都在 ${SIM_MOD}：\n`
      + `  ① 顶部 \`import { enemyStealthed } from './targeting.js';\` 之后加\n`
      + `       import { simLogic, simHas, simAttackWindow } from './modlogic.js';\n`
      + `  ② \`const r2 = …\` 之前加 \`export function attackRhythmBits(u)\`（先问 \`sim:attackRhythm\`，无包时就是\n`
      + `     \`u.s.interval\`；返回 \`Math.min(65535, Math.round(iv * 100)) << 16\`，取不到就是 0）\n`
      + `  ③ flagsOf()：\`return bits;\` 之前加 \`bits |= attackRhythmBits(u);\`\n`
      + `  ④ animOf()：ATTACK 那一行改成先问 \`simAttackWindow(u, ATTACK_ANIM_TIME)\`（守卫 \`simHas('sim:attackAnim')\`）。\n`
      + `     上游 data 的 def 上没有 \`attackAnimTime\`，所以无包时 \`simAttackWindow\` 的回落就是 ATTACK_ANIM_TIME —— 出厂那一句。`,
    once: (s) => allBlocks(s, SNAP_HUNKS)
      && s.includes('export function animOf(u, t) {')                          // 0.2.4 形状在
      && noDuplicates(s, ['export function attackRhythmBits(u) {', "simLogic.run('sim:attackRhythm'",
        'bits |= attackRhythmBits(u);', 'simAttackWindow(u, ATTACK_ANIM_TIME)']),
    apply: (s) => applyHunks(s, SNAP_HUNKS, {
      require: ['export function animOf(u, t) {', 'export function flagsOf(u) {'],
      forbid: ['// sp-mods: attack rhythm'],
    }),
  },
  {
    id: 'sim-content',
    file: 'server/sim/spec.js',
    what: '行为模组的正门：spec → Battle 透传 extraContent（installContent 会 install(battle) 每一个）',
    manual: `server/sim/spec.js —— \`createBattleFromSpec\` 的 \`const battleOpts = {\` 之后加一行：\n`
      + `  extraContent: opts.extraContent ?? null,\n`
      + `（Battle.js 本来就把它交给 \`installContent(battle, { extra })\`，content/index.js 本来就循环 install —— 门早就在，缺的只是这一行。）`,
    once: (s) => allBlocks(s, SPEC_HUNKS) && s.includes('export function createBattleFromSpec(spec, dataSource, opts = {}) {'),
    apply: (s) => applyHunks(s, SPEC_HUNKS, { require: ['export function createBattleFromSpec(spec, dataSource, opts = {}) {'] }),
  },
  {
    id: 'sim-extracontent-server',
    file: 'server/match/match/clientCombat.js',
    what: '服务端跑的每一场（接管重算 / 校验）也拿到行为模组的 sim 模块（否则两边的 resultDigest 不一致）',
    manual: `server/match/match/clientCombat.js —— \`_specBattle\` 的两处：\n`
      + `  ① \`import { buildBattleSpec, createBattleFromSpec } from '../../sim/spec.js';\` 之后加\n`
      + `       import { simContent } from '../../loader.js';\n`
      + `  ② \`createBattleFromSpec(spec, this.ds, { … })\` 的选项里加 \`extraContent: simContent()\`\n`
      + `没装行为模组时 \`simContent()\` 是 \`[]\`，与本体逐字等价。`,
    once: (s) => allBlocks(s, CC_HUNKS) && s.includes('_specBattle(spec, { sharedBoss = null } = {}) {'),
    apply: (s) => applyHunks(s, CC_HUNKS, { require: ['_specBattle(spec, { sharedBoss = null } = {}) {'] }),
  },
  {
    id: 'sim-extracontent-client',
    file: 'public/js/battle/runner.js',
    what: '页面自己模拟的那一场也拿到行为模组的 sim 模块（页面 import /sim/**，与服务器各注册一次）',
    manual: `public/js/battle/runner.js —— 两处：\n`
      + `  ① \`import { recordError, setBattleSource } from '../diag.js';\` 之后加\n`
      + `       import { hasSimMods } from '../mods.js';\n`
      + `       import { loadSimModulesFromLoader, modSimModules } from '../mods/sim.js';\n`
      + `  ② 构造 Battle 之前：\`if (hasSimMods()) await loadSimModulesFromLoader();\`，然后把\n`
      + `     \`createBattleFromSpec(e.spec, sim.ds, { logger })\` 换成 \`{ logger, extraContent: modSimModules() }\`\n`
      + `没装行为模组时 \`hasSimMods()\` 为假、\`modSimModules()\` 是 \`[]\`。`,
    once: (s) => allBlocks(s, RUN_HUNKS) && s.includes('export function createBattleRunner('),
    apply: (s) => applyHunks(s, RUN_HUNKS, { require: ['export function createBattleRunner('] }),
  },
  {
    id: 'data-merges',
    file: 'server/data.js',
    what: '内容包合并目录成为 getData() 的默认（server/loader.js 的文件头就是照这条写的）',
    manual: `server/data.js —— 两处：\n`
      + `  ① 顶部加 \`import { modDataDir } from './loader.js';\`\n`
      + `  ② \`export function getData({ dir = DATA_DIR, log = console } = {}) {\` 的默认值改成 \`modDataDir() || DATA_DIR\`\n`
      + `没装内容包时 \`modDataDir()\` 返回 null，读的还是自带的 data/（**不写**上游的 data/，见 AGENTS §9.2）。`,
    once: (s) => allBlocks(s, DATA_HUNKS) && s.includes("export const DATA_DIR = path.join(ROOT, 'data');"),
    apply: (s) => applyHunks(s, DATA_HUNKS, { require: ["export const DATA_DIR = path.join(ROOT, 'data');"] }),
  },
  {
    id: 'meta-installer',
    file: 'server/match/effectsMeta.js',
    what: '策略 / 盟约 / 特质 / 装备 的注册表接缝（globalThis.__SP_MODS_META__，每次 createRegistry 都问一次）',
    manual: `server/match/effectsMeta.js —— 两处：\n`
      + `  ① \`let defaultRegistry = null;\` 之前加 \`const MOD_META_KEY = '__SP_MODS_META__';\` 与 \`function modMetaInstaller()\`\n`
      + `  ② createRegistry()：在 \`if (reg.warnings.length)\` 之前跑 loader 交来的 installer\n`
      + `为什么走 globalThis 而不是 import：server/loader.js 刻意不 import 这个文件（它的模块图里有 data.js 与内容模块），\n`
      + `方向反过来 —— loader 发布、这里读取；读取点每次 registry 构建都查一遍，所以运行期启停也生效。`,
    once: (s) => allBlocks(s, META_HUNKS) && s.includes('export function createRegistry({ builtins = true, content = true, log = console } = {}) {'),
    apply: (s) => applyHunks(s, META_HUNKS, {
      require: ['export function createRegistry({ builtins = true, content = true, log = console } = {}) {'],
    }),
  },
  {
    id: 'assets-provider',
    file: 'public/js/assets.js',
    what: '美术门：setModAssetProvider()（内容包贡献的立绘 / Spine 合进 manifest 查询；游戏自己的条目永远优先）',
    manual: `public/js/assets.js —— 两处：\n`
      + `  ① \`const m = () => manifest || {};\` 换成"manifest + 各方贡献"的合并版本（无 provider 时返回同一个对象）\n`
      + `  ② 文件尾（\`/** Browser singleton. */\` 之前）加 \`setModAssetProvider\` / \`modAssetExtras\` 与它们的表\n`
      + `消费方是 files/public/js/mods/assets.js 的 \`api.assets.registerChars\`：拿不到这个导出时它只 warn，不抛。`,
    once: (s) => allBlocks(s, ASSET_HUNKS) && s.includes('export const assets = createAssets();'),
    apply: (s) => applyHunks(s, ASSET_HUNKS, { require: ['export const assets = createAssets();', 'const isObj = (v) => v !== null'] }),
  },
  {
    id: 'field-ready',
    file: 'public/js/ui/fieldHost.js',
    what: "战场视图就绪的通知（api.ready / api.on('ready') 的前提）",
    manual: `public/js/ui/fieldHost.js —— \`return guardView(view, 'engine');\` 之前加：\n`
      + `  import('../mods.js').then((m) => m.notifyReady?.(view)).catch(() => {});\n`
      + `fire-and-forget：包坏了也绝不能挡住战场挂载（它就在那个 try 里，import 失败只会走 catch 的降级视图）。`,
    once: (s) => allBlocks(s, FIELD_HUNKS) && s.includes("return guardView(view, 'engine');"),
    apply: (s) => applyHunks(s, FIELD_HUNKS, { require: ["guardView(view, 'engine')"] }),
  },
  {
    id: 'title-buttons',
    file: 'public/js/screens/title.js',
    what: "标题页的「模组」按钮（打开 /mods.html）+ ui:button 宿主（slot 'title.actions'）",
    manual: `public/js/screens/title.js —— 三处：\n`
      + `  ① \`import { GuideButton } from '../ui/guide.js';\` 之后加\n`
      + `       import { ModsButton } from '../ui/modsButton.js';\n`
      + `       import { ModButtons } from '../ui/modButtons.js';\n`
      + `  ② \`<\\\${GuideButton} class="title-guide" … />\` 之后加 \`<\\\${ModsButton} class="title-guide" />\`\n`
      + `  ③ 设置齿轮那颗 <button> 之后加\n`
      + `       <\\\${ModButtons} slot="title.actions" class="title-modbtns" size="sm" variant="secondary" />\n`
      + `「模组」按钮走 modsButton.js（自带启用计数与坏包角标）；宿主走 modButtons.js —— 没有包贡献按钮时它渲染 null。`,
    once: (s) => allBlocks(s, TITLE_HUNKS) && s.includes('export function TitleScreen('),
    apply: (s) => applyHunks(s, TITLE_HUNKS, { require: ['export function TitleScreen('] }),
  },
  {
    id: 'bot-seams',
    file: 'server/match/bot.js',
    what: 'AI 决策接缝：bot:params / bandWeights / cardScore / bondPlan / buyScore / itemScore / refreshValue / lineupScore / layoutParams / rehearsal + botParam 旋钮',
    manual: `server/match/bot.js —— 顶部加 \`import { botBoost, botHas, botParam } from './botlogic.js';\`，然后九个决策点各插一处\n`
      + `带标记的 \`if (botHas('bot:xxx')) { … botBoost('bot:xxx', 现值, { m, ps, … }) … }\`，八个出厂常量读法换成\n`
      + `\`botParam('名字', 出厂常量)\`（maxPairs / armorWeight / mergeHit / pairHit / benchBudget / maxRefreshes /\n`
      + `levelTarget / buyFullMin）。每一处都带 \`/*sp-mods:bot:<名字>*/\` 标记，逐处幂等；一处锚点没命中就整条不装。\n`
      + `无包时每一次决策都是出厂那一次（一次布尔判断，不掷随机、不留状态）。`,
    once: (s) => allBlocks(s, BOT_HUNKS) && BOT_MARKS.every((m) => s.includes(m)),
    apply(s) {
      // 修一个从未发布过的坏形状：早期草案把 `refreshValue` 那一段插在**循环体里**（`}` 之前），于是它对每个候选
      // 副本都跑一遍、而且读到的 `v` 是半成品（AGENTS §0b 第 3 条：升级路径必须认得出自己的坏形状）。
      // 整段挪回循环之后 —— 一处文本对调，锚点不在就跳过（说明文件不是那个形状）。
      const WRONG = [
        '  /*sp-mods:bot:refreshValue*/',
        "  if (botHas('bot:refreshValue')) { const v2 = botBoost('bot:refreshValue', v, { m, ps, ctx }); if (Number.isFinite(v2)) v = v2; }",
        '  }',
      ].join('\n');
      const RIGHT = [
        '  }',
        '  /*sp-mods:bot:refreshValue*/',
        "  if (botHas('bot:refreshValue')) { const v2 = botBoost('bot:refreshValue', v, { m, ps, ctx }); if (Number.isFinite(v2)) v = v2; }",
      ].join('\n');
      let out = s.includes(WRONG) ? s.replace(WRONG, () => RIGHT) : s;
      // 逐处幂等：已装的那几处跳过；锚点没命中的那一处让整条补丁拒绝（绝不装一半）
      for (const [i, h] of BOT_HUNKS.entries()) {
        const marker = BOT_MARKS[i];
        if (out.includes(marker)) continue;
        if (!out.includes(h.anchor)) return null;
        out = out.replace(h.anchor, () => h.block);
      }
      return out;
    },
  },

  // =============================================================================================================
  // 再部署计时器的第二种盘面（`down.face: 'clock'`，静止指向 9:00）**不是**单独一条补丁：
  // 它落在 `public/js/render/units.js` 的 `_updateDownRing` 里，和上面那条 `render-unit-hud` 同文件 ——
  // install.mjs:216 的记账是"每文件一条"，所以两条 hunks（DOWN_FACE_HUNKS）并进了 UNIT_HUNKS。
  // 中性路径：`down.face` 不是字面量 `'clock'` 时走 `r.text.texture = downLabel(…)` 那一段原句，
  // 指针精灵一个都不创建。
];
