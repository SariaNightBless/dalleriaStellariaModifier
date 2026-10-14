# NOTICE

## 本包

**dalleriaStellariaModifier** —— 《卫戍协议：盟约》的模组加载器，版本 **1.1.0**（面向上游 **0.2.4**）。

以 **GNU GPL-3.0-or-later** 发布，全文见 [LICENSE](LICENSE)。

## 上游

本包是下列项目的修改版（GPL-3.0 §5 所称的 Modified Version）：

| | |
|---|---|
| 项目 | Stronghold Protocol |
| 仓库 | <https://github.com/sganggs/Stronghold-Protocol> |
| 许可 | GPL-3.0-or-later |
| 本包验证于 | 上游 0.1.1（上游默认分支当时为 0.1.2） |

上游的版权声明与许可全文保留在本包的 `LICENSE` 中，未作任何修改。

## 一、对上游文件的改动

依据 GPL-3.0 §5(a)，以下列出本包对上游文件所做的全部改动。

### 1.1 打了补丁的上游文件（28 个文件，28 条补丁）

安装时由 `install.mjs` 现场改写，安装前把原文备份进 `state/backup/`，`--undo` 逐字节还原。
**权威清单是 `catalog.mjs` 的 `THEIRS`（文件 → 补丁 id，一对一）与 `patches.mjs` 的 `PATCHES`**；README §3 有逐条说明
（每条含 `what` / `once` / `apply` / `manual`）。

| 文件 | 补丁 id | 改动内容（一句话） |
|---|---|---|
| `public/index.html` | `stylesheets` | 引入 `sp-mods.css`（`ui:slot` 的两条规则也在这一份里） |
| `public/js/main.js` | `boot` | 首帧之前加载模组包 |
| `public/js/assets.js` | `assets-provider` | `setModAssetProvider()`：内容包贡献的立绘 / Spine 合进清单查询 |
| `public/js/battle/runner.js` | `sim-extracontent-client` | 页面自己模拟的那一场也带上行为模块（`extraContent`） |
| `public/js/screens/lobby.js` | `lobby-buttons` | 顶栏的 `ui:button` 宿主 |
| `public/js/screens/title.js` | `title-buttons` | 标题页「模组」按钮 + `ui:button` 宿主 |
| `public/js/ui/fieldHost.js` | `field-ready` | 战场视图就绪 → `notifyReady(view)`（`api.ready` / `on('ready')`） |
| `public/js/render/app.js` | `render-app-hooks` | `field:event` / `field:damage` / `field:viewGone` / `field:frame` / `field:overlay` |
| `public/js/render/units.js` | `render-unit-hud` | HUD 接缝（`field:unitBars` / `enemyBars` / `chip`）+ `field:unitMotion` + `field:attack` 的**宣布**（1.1.0）+ STYLE 旋钮读点 |
| `public/js/render/spine.js` | `render-attack-plan` | `field:attack` 的**计划**（1.1.0）：`windUp` / `attack` 各一处，答案 `start` / `timeScale` / `ts` / `once` / `hold` / `rephase` |
| `public/js/render/style.js` | `style-knobs` | `COLORS` / `UNIT` 变成活对象 + 文件尾 re-export 9 组旋钮面 |
| `public/js/render/textures.js` | `style-chip` | 等级牌图集读 `chip.*` 旋钮（含 `chip.textGoldTier`）+ 写旋钮即重画 |
| `public/js/render/fx.js` | `style-dmg-rebuild` | barrel 转出 `rebuildDamageFonts` |
| `public/js/render/fx/numbers.js` | `render-damage-number` | `field:damageNumber` 的 `kind: 'allow'` 与 `kind: 'text'` |
| `public/js/render/fx/fonts.js` | `style-dmg` | 跳字字模读 `dmg.*` 旋钮 + 新增 `rebuildDamageFonts()` |
| `public/js/render/fx/system.js` | `style-dmg-system` | `FxSystem.rebuildDamageFonts()`（模组够得着） |
| `server/index.js` | `server-boot` | 启动顺序（先扫包 → 合并内容 → 加载行为模块）+ `/api/mods*` |
| `server/http/static.js` | `static-mount` | `/mods/` 静态挂载（排在 `/` 之前） |
| `server/http/routes.js` | `api-route` | `/api/mods*` 分发（落在「非 GET/HEAD → 405」之前） |
| `server/data.js` | `data-merges` | `getData()` 的默认目录 = 内容包合并后的 `.cache/mods/data` |
| `server/match/bot.js` | `bot-seams` | AI 决策接缝（`bot:params` / `bandWeights` / `cardScore` / `bondPlan` / `buyScore` / `itemScore` / `refreshValue` / `lineupScore` / `layoutParams` / `rehearsal`） |
| `server/match/effectsMeta.js` | `meta-installer` | 策略 / 盟约 / 特质 / 装备注册表接缝（`globalThis.__SP_MODS_META__`） |
| `server/match/match/clientCombat.js` | `sim-extracontent-server` | 服务端跑的每一场（接管重算 / 校验）也带上行为模块 |
| `server/sim/ai.js` | `sim-ai-hooks` | `sim:enemyAI` / `sim:targets` / `sim:targetOrder` / `sim:attackMode`（我方 + 敌人）/ `sim:attack` / `sim:strikeDelay` |
| `server/sim/battle/lifecycle.js` | `sim-battle-hooks` | `sim:battleStart` / `sim:unitTick` / `sim:battleEnd` |
| `server/sim/damage.js` | `sim-damage` | `sim:damage` —— 每次进入主管线的命中（可改 `dmg.mul` / `amount` / `type`，或取消） |
| `server/sim/snapshot.js` | `sim-snapshot` | `sim:attackRhythm`（`flags` 16…31 位的攻击节奏）+ `sim:attackAnim`（ATTACK 窗口） |
| `server/sim/spec.js` | `sim-content` | `spec → Battle` 透传 `extraContent`（行为模组的正门） |

这些补丁在**无模组时保持上游行为**：所有调用点都以「有没有模组注册」为守卫，没有模组时逐帧、逐字节与上游一致
（计划型接缝的未注册路径**不分配任何对象**）。补丁的幂等判据检查文件的实际内容（"接线后的形状"）而非日志，因此可以
重复安装；`once` 判据同时拒绝第一代覆盖层留下的坏形状，避免"装过旧版的实例被判成已装好"。

### 1.2 本包**不再**整层替换任何上游文件

第一代曾经把改过的渲染层拷贝（`public/js/render/**` 等 22 个文件）整体覆盖上去。上游 0.2.4 重构了渲染层之后，
那些拷贝同时变成"过期"与"语义撞车"（`server/update.js` 是典型：上游要 `applyUpdate`，旧拷贝是包下载器），
于是第二代把这条整个删掉：**渲染层保持上游 0.2.4 原件**，只打上面 1.1 表里的接线；外观旋钮的默认值逐键等于上游
（`--verify` 每次核对）。`catalog.mjs` 开头记录了这个决定，安装器对 `FORBIDDEN_OVERWRITE` 里的名字直接拒绝。

## 二、本包新增的文件（24 个）

游戏原本没有这些文件，由安装器新增（权威清单：`catalog.mjs` 的 `OURS`）。它们**不是**对上游文件的修改：

```
public/mods.html                              管理页面
public/css/sp-mods.css                        管理器与槽位的样式
public/js/mods.js                             页面侧加载器入口（main.js 只 import 它）
public/js/mods/{render,style,timing}.js       渲染接缝实现 / 外观旋钮引擎（9 组 82 键）/ 时序与跳字表
public/js/mods/{resolve,ui,content,tables,sim,assets}.js    api 表面、内容包、行为模块、美术注册
public/js/ui/{modsButton,modButtons}.js       标题页那颗「模组」按钮 + ui:button 渲染器
server/mods.js  server/manifest.js  server/loader.js  server/modapi.js
server/content.js  server/mods-update.js      模组管理器（服务端；包下载器叫 mods-update，别与上游的 update.js 混）
server/sim/modlogic.js                        模拟侧钩子注册表（sim:*，被页面经 /sim/ 只读共享）
server/match/botlogic.js                      AI 决策侧钩子注册表（bot:*）
shared/hooks.js  shared/content.js            钩子注册表与内容包合并规则（页面与服务端共用）
```

安装时还会生成 `mods/README.md` 与 `state/`（安装记录）。`state/` 只存在于本机，不随包分发。

## 三、游戏素材不在本许可范围内

上游项目的 `NOTICE.md` 已声明：**游戏的美术、音频、字体，以及由官方数据表生成的 `data/*.json`，不属于 GPL 的授权范围**，仅限个人非商业使用，不得单独再分发。

本仓库遵守这一条：**只包含代码与文档，不包含任何游戏素材**——没有图片、音频、字体，也没有官方的 `data/*.json`。安装器同样不写入游戏自带的 `data/`：内容包合并到 `.cache/mods/data`，未改动的表用硬链接指向上游文件。

## 四、非商业

本项目不做任何形式的变现：不出售、不付费分发、不收费开服、不投放广告、不接受打赏。也不建议或授权他人用它公开开服。

## 五、生成方式

本项目的代码与文档**主要由 DeepSeek 生成**。维护者负责提出需求、设计约束、实机试玩与验收；所有改动都在真实的游戏实例上运行验证过。

这一点如实写出，是因为它影响你对代码的信任方式：本项目没有传统意义上的人工代码审查流程，接口的稳定性与边界的正确性来自实机验证，而不是来自多人评审。使用前请自行评估。
