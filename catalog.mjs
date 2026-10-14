// catalog.mjs —— 修改器 v2 的**文件所有权目录**（重写的核心约束）
//
// 旧版（v1）的毛病：它的 `files/` 里躺着一份**上游文件的拷贝**（渲染层 27 个、server/update.js、
// server/match/effectsMeta.js、assets.js、runner.js、game.js …），安装时整层覆盖过去。上游 0.2.4
// 把渲染层整个重构（fx.js → fx/*.js 12 个、app.js → app/*.js 7 个）之后，那些拷贝全都过期：
// 覆盖上去不仅丢掉了上游的新功能，还因为**同名文件语义不同**直接把服务端搞崩
// （`server/update.js`：上游要 applyPendingUpdate，旧加载器那份是包下载器 → http/boot.js 崩）。
//
// v2 的规矩，就两条：
//   OURS   —— 上游没有这个文件，随便写。装 = 复制，卸 = 删掉。
//   THEIRS —— 上游拥有的文件，**永远不整份复制**；只允许经 PATCHES 打"锚点明确的接线"，
//             而且每条都必须能 --undo 还原。任何"我们想改它"的冲动，先问：能不能做成插件式增量？
//
// 加新文件时：只往 OURS 里加；要动上游文件，去 patches.mjs 加一条，别往 files/ 里塞拷贝。

/** 这些文件/目录是修改器自己的：上游没有，装的时候整个复制过去。 */
export const OURS = [
  // ---- 客户端：模组加载器（页面侧）----
  'public/js/mods.js',                  // 入口：main.js 只 import 它（见 patches 里的接线）
  'public/js/mods/assets.js',
  'public/js/mods/content.js',
  'public/js/mods/render.js',           // 渲染接缝的实现（上游 render/** 里只留一行 import + 一行调用）
  'public/js/mods/resolve.js',
  'public/js/mods/sim.js',
  'public/js/mods/style.js',            // 外观旋钮引擎（9 组旋钮面 + 默认值；上游 render/style.js 只 re-export 它）
  'public/js/mods/tables.js',
  'public/js/mods/timing.js',
  'public/js/mods/ui.js',

  // ---- 客户端：管理器页面与按钮宿主 ----
  'public/mods.html',
  'public/css/sp-mods.css',
  'public/js/ui/modsButton.js',         // 标题页那颗「模组」按钮
  'public/js/ui/modButtons.js',         // ui:button 的渲染器（宿主把描述对象交给它）

  // ---- 服务端：包管理 + 内容合并 + 接线用的 HTTP 面 ----
  'server/mods.js',
  'server/modapi.js',
  'server/loader.js',
  'server/manifest.js',
  'server/content.js',
  'server/mods-update.js',              // ⚠️ 不叫 update.js：那个名字上游占着（见 patches 里的说明）
  'server/match/botlogic.js',           // bot:* 钩子的实现（上游没有这个文件）
  'server/sim/modlogic.js',             // sim:* 钩子的实现（上游没有这个文件）

  // ---- 两端共用的契约 ----
  'shared/hooks.js',                    // 钩子注册表（HOOK_KINDS / run / emit / collect / first）
  'shared/content.js',                  // 内容表清单与深合并规则
];

/**
 * 上游的文件：**只许打补丁，不许整份覆盖**。列在这里是为了让安装器一眼看得出
 * "哪些文件会被改动"，以及给 --verify 一个清单去核对。
 * 每条对应 patches.mjs 里同名的 id。
 */
export const THEIRS = Object.freeze({
  'public/js/main.js': ['boot'],                    // 首帧之前加载模组
  'server/index.js': ['server-boot'],               // 扫包 → 合并内容 → 加载 sim → 挂 /api/mods
  'server/http/static.js': ['static-mount'],         // /mods/ 静态挂载
  'server/http/routes.js': ['api-route'],            // /api/mods 分发
  // ⚠️ 上游 0.2.4 **没有** server/mods.js（它的 server/ 只有 data / index / lobby / net / packs / update），
  //    所以这里曾经那条 `'server/mods.js': ['updater-rename']` 是**一代遗留的伪条目**：没有文件可改，
  //    `patches.mjs` 里也从来没有这条 id。`server/mods.js` 是**我方**文件（见 OURS），它自己 import
  //    `./mods-update.js`（包下载器；上游的 `server/update.js` 是官方的 `applyPendingUpdate`，名字被它占着，
  //    见 FORBIDDEN_OVERWRITE）。删掉这条让 THEIRS 与 PATCHES 一一对应。
  'public/js/screens/lobby.js': ['lobby-buttons'],   // 顶栏的 ui:button 宿主
  'public/js/screens/title.js': ['title-buttons'],   // 标题页的「模组」按钮 + ui:button 宿主
  'public/index.html': ['stylesheets'],              // 引入 sp-mods.css
  // ---- 战场渲染接缝：上游文件里只有一行 import + 每个接缝一行调用，逻辑全在 files/public/js/mods/render.js ----
  'public/js/render/app.js': ['render-app-hooks'],   // field:event / damage / viewGone / frame / overlay
  'public/js/render/fx/numbers.js': ['render-damage-number'],   // field:damageNumber（allow / text）
  'public/js/render/units.js': ['render-unit-hud'],  // field:unitBars / enemyBars / chip + STYLE 旋钮（HUD/护盾/受击闪/飞行/倒地/时钟）+ field:attack 的**宣布**
  'public/js/render/spine.js': ['render-attack-plan'],   // field:attack 的**计划**（windUp / attack 两处；宣布那半在 units.js 那条里）
  // ---- 模拟接缝（sim:*）：每个钩子一处守卫调用，注册表在 files/server/sim/modlogic.js ----
  'server/sim/battle/lifecycle.js': ['sim-battle-hooks'],   // sim:battleStart / unitTick / battleEnd
  'server/sim/ai.js': ['sim-ai-hooks'],              // sim:enemyAI / targets / targetOrder / attackMode / attack / strikeDelay
  'server/sim/damage.js': ['sim-damage'],            // sim:damage
  'server/sim/snapshot.js': ['sim-snapshot'],        // sim:attackRhythm / sim:attackAnim（ATTACK 窗口）
  'server/sim/spec.js': ['sim-content'],             // spec → Battle 透传 extraContent（行为模组的正门）
  'server/match/match/clientCombat.js': ['sim-extracontent-server'],   // 服务端跑的每一场也带上 sim 模块
  'public/js/battle/runner.js': ['sim-extracontent-client'],           // 页面自己模拟的那一场同样
  // ---- AI 决策接缝（bot:*）：注册表在 files/server/match/botlogic.js ----
  'server/match/bot.js': ['bot-seams'],              // bot:params / bandWeights / cardScore / bondPlan / buyScore / itemScore / refreshValue / lineupScore / layoutParams / rehearsal
  // ---- 内容与美术：内容包的表、策略/盟约注册表、立绘 / Spine；以及「战场视图就绪」的通知 ----
  'server/data.js': ['data-merges'],                 // getData() 的默认目录 = 合并后的 .cache/mods/data
  'server/match/effectsMeta.js': ['meta-installer'],  // globalThis.__SP_MODS_META__（策略 / 盟约 registerMeta）
  'public/js/assets.js': ['assets-provider'],         // setModAssetProvider（api.assets.registerChars）
  'public/js/ui/fieldHost.js': ['field-ready'],       // 战场视图就绪 → notifyReady（api.ready / 'ready'）
  // ---- STYLE 旋钮层：上游文件里只有"把字面量交给旋钮店"和"把 9 组名字 re-export 出去"，表全在 files/public/js/mods/style.js ----
  'public/js/render/style.js': ['style-knobs'],      // COLORS / UNIT 变成活对象 + 文件尾 re-export
  'public/js/render/textures.js': ['style-chip'],    // 等级牌图集读 chip.*（含 chip.textGoldTier）+ 写旋钮即重画
  'public/js/render/fx/fonts.js': ['style-dmg'],     // 跳字字模读 dmg.* + 新增 rebuildDamageFonts()
  'public/js/render/fx.js': ['style-dmg-rebuild'],   // barrel 转出 rebuildDamageFonts
  'public/js/render/fx/system.js': ['style-dmg-system'],   // FxSystem.rebuildDamageFonts()（模组够得着）
});

/** 上游那些"容易被误伤"的名字：安装器会拒绝把 OURS 里的文件往这些路径上放。 */
export const FORBIDDEN_OVERWRITE = ['server/update.js'];

/** 上游在 0.2.4 里会被本修改器改动的文件总数（README 与 --verify 都引用这个数）。 */
export const PATCHED_FILE_COUNT = Object.keys(THEIRS).length;
