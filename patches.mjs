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
 * @param {{require?: string[], forbid?: string[]}} [shapes] 0.2.4 必须有的形状 / 一代覆盖层的形状
 */
function applyHunks(src, hunks, { require = [], forbid = [] } = {}) {
  for (const f of require) if (!src.includes(f)) return null;   // 0.2.4 形状不在（上游换实现了？）
  for (const f of forbid) if (src.includes(f)) return null;     // 一代覆盖层/坏形状还在：先还原渲染层
  let out = src;
  let stripped = 0;
  for (const h of hunks) {                                                      // ① 先摘旧插入
    const before = out.length;
    out = out.replace(blockRe(h.block), () => h.anchor);
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
  '// Mod packages (sp-mods): `registerChipSprite` lets a chip cut from the atlas follow a later `chip.width/height`;',
  "// `hudHand` / `hudClockFace` / `RING_HAND_AT` draw the static hands and the plate of the redeploy clock",
  "// (`down.face: 'clock'`).",
  UNIT_STYLE_TEX_ANCHOR.replace(' } from', ', registerChipSprite, hudHand, hudClockFace, RING_HAND_AT } from'),
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
  // SP 底板（units.js:1378）：pad 与 alpha 读旋钮（HP 那处在 UNIT_HP_BLOCK 里读同一组旋钮）
  ['this.spBg.position.set(x0 - 1, sy); this.spBg.width = bw + 2; this.spBg.height = spH + 2;',
    'this.spBg.position.set(x0 - HUD.backPadPx, sy); this.spBg.width = bw + HUD.backPadPx * 2;'
    + ' this.spBg.height = spH + HUD.backPadPx * 2; this.spBg.alpha = HUD.backAlpha;'],
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
].join('\n');

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
  ' * Redraw the chip atlas after a `chip.*` knob write (see public/js/mods/style.js). Same canvas, same BaseTexture,',
  ' * same cell size — the textures already handed to sprites keep working, so every chip on screen picks the new look',
  ' * up at once. The redraw itself is upstream\'s own `refreshTierChips` (web fonts landing late use the very same path).',
  ' *',
  ' * Scope, deliberately: COLOURS / fonts / plate alpha / edges are redrawn live; `chip.width` / `chip.height` move every',
  ' * sprite\'s UV rectangle with the cell, so they are an INSTALL-TIME knob — a package writes them before the first chip',
  ' * exists (`main.js` loads packages before the first frame, `units.js:746` cuts the first chip later), which is the case',
  ' * they are for. Changing them on a live board needs a page reload; doing it here would mean re-cutting every sprite.',
  ' */',
  'function rebuildChipsFromKnobs() {',
  '  refreshTierChips();',
  '}',
  '',
  '/** Knob → atlas: one redraw per burst of writes (the engine merges them into one microtask). */',
  "onStyleChange((groups) => { if (groups.has('chip') || groups.has('*')) rebuildChipsFromKnobs(); });",
].join('\n');

/** 静止指针（再部署时钟）的纹理：几何常量 + 懒建缓存。锚点 = `let _bg = null;`（整行唯一）。 */
const TEX_HAND_ANCHOR = 'let _bg = null;';
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
const TEX_HAND_BLOCK = TEX_HAND_ANCHOR + TEX_HAND_LINES;

/** textures.js 的六处 hunks（一条补丁一起装、一起摘）。 */
const TEXTURE_HUNKS = [
  { anchor: TEX_IMPORT_ANCHOR, block: TEX_IMPORT_BLOCK },
  { anchor: TEX_UTIL_ANCHOR, block: TEX_UTIL_BLOCK },
  { anchor: TEX_DRAW_ANCHOR, block: TEX_DRAW_BLOCK },
  { anchor: '    const w = 64, h = 44;', block: '    const w = CHIP.width, h = CHIP.height;' },
  { anchor: TEX_REFRESH_ANCHOR, block: TEX_REFRESH_BLOCK },
  { anchor: TEX_HAND_ANCHOR, block: TEX_HAND_BLOCK },
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
  // ④ 其余旋钮替换（都不落在任何接缝块内部）
  { anchor: UNIT_DOWNLOOK_ANCHOR, block: UNIT_DOWNLOOK_BLOCK },
  ...UNIT_STYLE_SUBS.map(([from, to]) => ({ anchor: from, block: to })),
  // ⑤ 再部署时钟（down.face）：标签行 + 指针
  ...DOWN_FACE_HUNKS,
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
  //      还有两处**新分支**（默认关）：`chip.textGoldTier`（在 textures.js 里生效）与 `down.face: 'clock'`。
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
    what: 'HUD 接缝（unitBars / enemyBars / chip）+ STYLE 旋钮（HUD/护盾/隐匿/受击闪/飞行/倒地/时钟盘面）',
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
      + `  ⑨ 新建等级牌之后登记精灵（\`registerChipSprite\`），等级牌那一段用旋钮算缩放\n`
      + `  ⑩ _updateDownRing：加 \`const clock = DOWN.face === 'clock';\`，中央标签在 clock 档给空串并隐藏，\n`
      + `     再画/藏两根静止指针（\`hudHand\` + RING_HAND_AT，颜色 down.handInk，底板 down.faceInk）\n`
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
      && noDuplicates(s, ['modRender.unitBars(', 'modRender.chip(', 'registerChipSprite(',
        "const clock = DOWN.face === 'clock';"]),                              // 没有插两遍
    apply: (s) => applyHunks(s, UNIT_HUNKS, {
      require: ['this._updateElementBar(', 'showBars && !!this.el'],
      forbid: ['this.shieldVal', 'pickNum(', 'MOTION_DEFAULTS', 'hudTiming('],
    }),
  },

  // =============================================================================================================
  // R) server/sim/ai.js —— **修复**：一代接线留下的坏形状（用了 simHas/simLogic 却没带 import）
  //
  // 症状（2026-10-11 在 test 上实测）：每次敌人攻击抛一次
  //   `[sim] internal:updateEnemy failed: ReferenceError: simHas is not defined`
  // 被 sim 的守卫吞成一行 internal 报错，表现成「敌人不还手」。
  // 根因：一代加载器往这个文件插了三个 `simHas('sim:attackMode')` / `simLogic.run(...)` 调用点，
  // 却没把 `import { simLogic, simHas } from './modlogic.js';` 一起插进去 —— 正是 AGENTS.md §0b
  // 第 1 条说的那类"`--check` 一律放过"的错。同批被一代改过的 `damage.js` / `snapshot.js` 都带了 import。
  //
  // 二代自己还没有 sim 接缝（那是下一轮的事），但**装了二代的实例不该带着这个坏形状跑**，所以这条只做修复：
  //   · 文件里有裸 `simHas(` / `simLogic.` 且没有对应 import → 补上；
  //   · 文件里根本没有这些标识（干净上游，或将来二代自己的 sim 接缝换成 `./modlogic.js` 导入）→ 无需修复。
  // 这条补丁是**幂等**的：修好之后 `once` 为真，重复安装不会再插第二遍。
  {
    id: 'sim-ai-import-repair',
    file: 'server/sim/ai.js',
    what: '修复一代接线留下的坏形状：ai.js 用了 simHas/simLogic 却没有 import（每次敌人攻击 ReferenceError）',
    manual: `server/sim/ai.js —— 顶部 import 区加一行：\n  import { simLogic, simHas } from './modlogic.js';`,
    once: (s) => !/\bsimHas\s*\(|\bsimLogic\./.test(s) || /\bimport\b[^;\n]*\b(simLogic|simHas)\b/.test(s),
    apply(s) {
      if (!/\bsimHas\s*\(|\bsimLogic\./.test(s)) return s;                       // 干净文件：无需修复
      if (/\bimport\b[^;\n]*\b(simLogic|simHas)\b/.test(s)) return s;           // 已经修好了
      const anchor = "import { hypot, powi } from './detmath.js';";
      if (!anchorOnce(s, anchor)) return null;
      return s.replace(anchor, anchor
        + '\n// Mod packages (sp-mods): repair — 一代的接线用了 simHas/simLogic 却没带 import（每次敌人攻击\n'
        + "// ReferenceError，被守卫吞成一行 internal 报错）。见 patches.mjs 的 sim-ai-import-repair。\n"
        + "import { simLogic, simHas } from './modlogic.js';");
    },
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
  //   · `tierChip` 的格子尺寸读 CHIP.width / CHIP.height（`_chips` 的矩形与精灵的 UV 都是从这里算的）；
  //   · 新增两个颜色工具 + 一个 `onStyleChange` 订阅：写 chip.* → 微任务里重画同一张画布、同一张 BaseTexture
  //     ⇒ 已经发出去的牌自动跟着变（上游的 `refreshTierChips` 用的就是这个机制，这里只是换成"旋钮变了也走它"）。
  {
    id: 'style-chip',
    file: 'public/js/render/textures.js',
    what: '等级牌图集读 chip.* 旋钮（含 chip.textGoldTier：精锐牌数字保持该等级的 ink）+ 写旋钮即重画',
    manual: `public/js/render/textures.js —— 五处：\n`
      + `  ① 第 15 行 import 加两个名字：\`… linearToSrgb255, CHIP, onStyleChange\`\n`
      + `  ② \`let _chips = null;\` 之后加两个颜色小工具（chipCssColor / chipPlateFill）\n`
      + `  ③ 整个 drawChips() 换成 §B 的版本（读 CHIP；golden 且 chip.textGoldTier 时数字色用该等级的 ink）\n`
      + `  ④ tierChip() 的 \`const w = 64, h = 44;\` → \`const w = CHIP.width, h = CHIP.height;\`\n`
      + `  ⑤ refreshTierChips() 之后加 \`rebuildChipsFromKnobs()\` 与一行订阅：\n`
      + `     \`onStyleChange((groups) => { if (groups.has('chip') || groups.has('*')) rebuildChipsFromKnobs(); });\`\n`
      + `     （重画就是上游的 refreshTierChips：同画布、同 BaseTexture、同格子尺寸 ⇒ 已发出的牌立刻跟着变）\n`
      + `  ⑥ \`let _bg = null;\` 之前加静止指针与盘面的纹理：\`RING_HAND_W\`（带环宽度，由 RING_W 与那圈深色边缘算\n`
      + `     出）/ \`RING_HAND_A0\` / \`RING_HAND_LEN\` / \`RING_HAND_AT\` + \`hudHand(angle)\` + \`hudClockFace()\``,
    once: (s) => s.includes('const K = CHIP;') && s.includes('const w = CHIP.width, h = CHIP.height;')
      && s.includes("onStyleChange((groups) => { if (groups.has('chip')")
      && s.includes('K.textGoldTier === true') && s.includes('CHIP, onStyleChange')
      && !s.includes("c.font = `700 ${t >= 4 ? 24 : 27}px Bender"),      // 上游字面量形状不在 = 真的改过了
    apply: (s) => applyHunks(s, TEXTURE_HUNKS, {
      require: ['function roundRect(ctx, x, y, w, h, r)', 'export function refreshTierChips()'],
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
      + `  ② FxSystem 类里（\`ensureDamageFonts();\` 那次构造调用所在的方法之后）加：\n`
      + `       rebuildDamageFonts() {\n`
      + `         rebuildDamageFonts();\n`
      + `         for (const t of this._nums || []) this._releaseNum?.(t);\n`
      + `         (this._nums || []).length = 0;\n`
      + `       }`,
    once: (s) => s.includes('rebuildDamageFonts() {') && s.includes('rebuildDamageFonts } from'),
    apply: (s) => {
      const imp = "import { ensureDamageFonts } from './fonts.js';";
      if (!anchorOnce(s, imp)) return null;
      const out = s.replace(imp, "import { ensureDamageFonts, rebuildDamageFonts } from './fonts.js';");
      const anchor = '    ensureDamageFonts();';
      if (!anchorOnce(out, anchor)) return null;
      return out.replace(anchor, [
        anchor,
        '    // Mod packages (sp-mods): a package may retune `dmg.*` at run time; this forwards to the one place that',
        '    // bakes the bitmap fonts and drops the numbers already in flight (a pooled BitmapText would otherwise keep',
        '    // the OLD glyphs — `BitmapFont.from` on an existing name replaces the texture set, not the live text objects).',
        '    // See public/js/mods/style.js (`DMG`) and reports/seam-style.md §3.5.',
        '  }',
        '',
        '  /**',
        "   * Re-bake the damage-number fonts from the current `dmg.*` knobs (`api.style.set('dmg.flat', true)` …) and",
        '   * release every number still on screen, so the next hit draws with the new look.',
        '   */',
        '  rebuildDamageFonts() {',
        '    rebuildDamageFonts();',
        '    for (const t of this._nums || []) this._releaseNum?.(t);',
        '    if (this._nums) this._nums.length = 0;',
      ].join('\n'));
    },
  },

  // =============================================================================================================
  // 再部署计时器的第二种盘面（`down.face: 'clock'`，静止指向 9:00）**不是**单独一条补丁：
  // 它落在 `public/js/render/units.js` 的 `_updateDownRing` 里，和上面那条 `render-unit-hud` 同文件 ——
  // install.mjs:216 的记账是"每文件一条"，所以两条 hunks（DOWN_FACE_HUNKS）并进了 UNIT_HUNKS。
  // 中性路径：`down.face` 不是字面量 `'clock'` 时走 `r.text.texture = downLabel(…)` 那一段原句，
  // 指针精灵一个都不创建。
];
