# dalleriaStellariaModifier v2.4-v1.1.0

《卫戍协议：盟约》的模组加载器（第二代架构），面向**上游 0.2.4**。标识读法：`v2.4` 是它面向的上游版本，`v1.0.0` 是修改器自己的版本（`version.mjs` 是唯一权威）。

装完之后：标题页多一个「模组」按钮 → `/mods.html`（拖 zip / 放文件夹 /
启停 / 删除 / 检查更新），游戏根多一个 `mods/` 目录，里面每个包都能往界面里加东西、往数据里加内容。

## 0. 怎么装、怎么卸（双击就行）

**默认安装目标 = 本包的上一级目录（`..`）。** 也就是说：把整个包目录放进游戏根里
（变成 `<游戏目录>\dalleriaStellariaModifier1x\`），双击 `deploy.cmd` 就装到那个游戏根上 ——
**没有任何写死的绝对路径**，换机器、换实例目录名都不用改任何东西。

| 双击 | 干什么 |
|---|---|
| **`deploy.cmd`** | 部署：定位到 `..`（或 `--root` 指的目录）→ 显示那儿现在装没装 → 问一句 → 装 → 自检 |
| **`uninstall.cmd`** | 卸载：同一个目标 → 确认有安装记录 → 问一句 → 逐字节还原上游、删掉本修改器的文件 |

命令行用法（参数**放哪都行**，路径带空格 / 中文请加引号）：

```bat
deploy.cmd                              :: 装进本包的上一级目录
deploy.cmd --root "D:\你的游戏目录"      :: 装到别处去
deploy.cmd --root "D:\..." --yes        :: 不问确认
deploy.cmd --verify                     :: 只看现在装没装好（不改任何文件）
deploy.cmd --audit                      :: 只逐条试补丁锚点（换新上游时第一步跑它）
deploy.cmd --list                       :: 只列出"找过哪些候选目录"

uninstall.cmd                           :: 卸本包的上一级目录那一份
uninstall.cmd --root "D:\你的游戏目录" --yes
uninstall.cmd --clean                   :: 还原之后顺手删掉内容合并缓存 .cache\mods
```

三点须知：

* **本修改器不搬任何模组包**。模组包留在实例的 `mods\` 目录里（拖进 `/mods.html` 或手工放进去都行）；
  `uninstall.cmd` **也不会删** `mods\` —— 卸载只还原上游文件、删掉加载器自己的文件。
* 装完 / 卸完都要**重启游戏服务器**才生效（只改到 `public/**` 的话刷新页面即可）。
* "游戏目录在哪"只由 `which.mjs` 一家判定，两个脚本认的是同一个答案，顺序是：
  `--root` → **本包的上一级目录 `..`** → `SP_GAME_ROOT` → `state\last-root.txt`（上次装成功的那个）
  → `state\*.json` 里的安装记录（**卸载靠它认回"装到别处去"的那一份**）→ 包里包外的其它摆法。
  都找不到才让你手输一次，绝不偷偷装到别的目录里去。

> 为什么 `..` 要排在"上次装过哪"前面：一段陈旧记录（比如包里 `state\` 是从别的机器 / 别的实例
> 一起拷过来的）会盖过真正的安装目标，于是"包明明已经放进这个实例了、脚本却装去另一个目录"。
> 记录只在 `..` 不是合法游戏根的时候才起作用。

不想用脚本、只要等价的原生命令：

```powershell
node install.mjs --root "D:\你的游戏目录"             # 安装
node install.mjs --verify --root "D:\你的游戏目录"     # 自检（不改任何东西）
node install.mjs --undo   --root "D:\你的游戏目录"     # 还原
node install.mjs --audit                              # 移植用：逐条试补丁锚点
```

---

## 1. 为什么有 v2（v1 是怎么翻车的）

v1 的 `files/` 里躺着一份**上游文件的拷贝**（渲染层 27 个文件、`server/update.js`、`server/match/effectsMeta.js`、
`assets.js`、`battle/runner.js`、`screens/game.js` …），安装时整层覆盖上去。0.1.1 时代这没问题，因为拷贝
就是照着那个版本改的。上游升到 **0.2.4** 之后，上游**整个重构了渲染层**（`fx.js` → `fx/*.js` 12 个、
`app.js` → `app/*.js` 7 个、`style.js` 483→211 行），于是那些拷贝同时变成了两种灾难：

* **过期**：覆盖上去等于把上游的新渲染层扔了；
* **语义撞车**：`server/update.js` 这个名字上游 0.2.4 也在用，但含义完全不同 ——
  上游要 `applyPendingUpdate`（`http/boot.js` 导入它），v1 那份是"包下载器"（`server/mods.js` 导入 `createUpdater`）。
  谁覆盖谁，另一边就在**导入期**崩 —— 服务端直接起不来。

v2 的做法是立一条不可谈判的规矩，并且用工具强住它。

## 2. 三条规矩（`catalog.mjs` 是唯一权威）

| 类别 | 含义 | 安装时怎么处理 |
|---|---|---|
| **OURS** | 上游**没有**这个文件 | 复制过去；`--undo` 删掉 |
| **THEIRS** | 上游**拥有**这个文件 | **永远不整份复制**；只经 `patches.mjs` 里锚点明确的接线改几行；改前备份，`--undo` 逐字节还原 |

* 加新文件 → 只往 `OURS` 里加。
* 想动上游文件 → 去 `patches.mjs` 加一条**最小接线**，不要往 `files/` 里塞拷贝。
* `FORBIDDEN_OVERWRITE` 里列的名字（目前只有 `server/update.js`）会被安装器直接拒绝。

## 3. 它到底改了上游哪几行（28 条，都在 `patches.mjs`）

| # | id | 文件 | 干什么 |
|---|---|---|---|
| 1 | `boot` | `public/js/main.js` | 首帧之前 `import('./mods.js')` 并把包加载起来（模组要能影响第一帧、内容包要在任何界面读数据前进 store） |
| 2 | `server-boot` | `server/index.js` | 启动顺序：先扫包 → 合并内容包 → 加载行为模块，再读表；把 `modsDir` / `modsApi` 交给静态与路由 |
| 3 | `static-mount` | `server/http/static.js` | `/mods/` 静态挂载（**排在 `/` 之前**，否则被它吃掉） |
| 4 | `api-route` | `server/http/routes.js` | `/api/mods*` 分发给修改器的 HTTP 面（必须落在「非 GET/HEAD → 405」**之前**，否则 POST 端点全废） |
| 5 | `lobby-buttons` | `public/js/screens/lobby.js` | 顶栏的 `ui:button` 宿主 —— 插在「干员调配」与「博士名片」之间 |
| 6 | `title-buttons` | `public/js/screens/title.js` | 标题页那颗「**模组**」按钮（打开 `/mods.html`）+ `ui:button` 宿主（slot `title.actions`） |
| 7 | `stylesheets` | `public/index.html` | 引入 `sp-mods.css`（`ui:slot` 的 `[data-prts-slot]` / `[data-prts-hidden]` 两条规则也在这一份里） |
| 8 | `render-app-hooks` | `public/js/render/app.js` | 战场接缝 5 条：`field:event` / `field:damage` / `field:viewGone` / `field:frame` / `field:overlay` |
| 9 | `render-damage-number` | `public/js/render/fx/numbers.js` | 跳字接缝：`field:damageNumber` 的 `kind: 'allow'` 与 `kind: 'text'`（text / color / life / big） |
| 10 | `render-unit-hud` | `public/js/render/units.js` | HUD 接缝（unitBars / enemyBars / chip）+ `field:unitMotion`（每帧每个单位的身体高度 / 水平锚点 / 朝向 / 影子落点）+ STYLE 旋钮（HUD / 护盾 / 隐匿 / 受击闪 / 飞行 / 倒地 / 时钟盘面） |
| 11 | `style-knobs` | `public/js/render/style.js` | STYLE 旋钮层：`COLORS` / `UNIT` 变成活对象 + 9 组旋钮面从 `public/js/mods/style.js` re-export |
| 12 | `style-chip` | `public/js/render/textures.js` | 等级牌图集读 `chip.*` 旋钮（含 `chip.textGoldTier`：精锐牌数字保持该等级的 ink）+ 写旋钮即重画 |
| 13 | `style-dmg` | `public/js/render/fx/fonts.js` | 跳字字模读 `dmg.*` 旋钮（面栈 / 单色 / 描边 / 五档填充色）+ 新增 `rebuildDamageFonts()` |
| 14 | `style-dmg-rebuild` | `public/js/render/fx.js` | barrel 转出 `rebuildDamageFonts`（`fx/fonts.js` 的新导出） |
| 15 | `style-dmg-system` | `public/js/render/fx/system.js` | `FxSystem.rebuildDamageFonts()`：转发给 `fx/fonts.js` 并丢掉在飞 / 池里的数字 |
| 16 | `sim-battle-hooks` | `server/sim/battle/lifecycle.js` | `sim:battleStart` / `sim:unitTick`（双方，每 tick）/ `sim:battleEnd` |
| 17 | `sim-ai-hooks` | `server/sim/ai.js` | `sim:enemyAI` / `sim:targets` / `sim:targetOrder` / `sim:attackMode`（我方 + 敌人）/ `sim:attack` / `sim:strikeDelay` |
| 18 | `sim-damage` | `server/sim/damage.js` | `sim:damage` —— 每一次进入主管线的命中（可改 `dmg.mul` / `amount` / `type`，或 `dmg.cancel` 取消） |
| 19 | `sim-snapshot` | `server/sim/snapshot.js` | `sim:attackRhythm`（`flags` 16…31 位的攻击节奏）+ `sim:attackAnim`（ATTACK 窗口长度） |
| 20 | `sim-content` | `server/sim/spec.js` | spec → Battle 透传 `extraContent`（`installContent` 会对每个模块跑 `install(battle)`） |
| 21 | `sim-extracontent-server` | `server/match/match/clientCombat.js` | 服务端跑的每一场（接管重算 / 校验）也带上行为模块 —— 否则两边 `resultDigest` 不一致 |
| 22 | `sim-extracontent-client` | `public/js/battle/runner.js` | 页面自己模拟的那一场同样（`hasSimMods()` 为假时两次调用都不发生） |
| 23 | `bot-seams` | `server/match/bot.js` | `bot:params` / `bandWeights` / `cardScore` / `bondPlan` / `buyScore` / `itemScore` / `refreshValue` / `lineupScore` / `layoutParams` / `rehearsal` + `botParam` 旋钮 |
| 24 | `data-merges` | `server/data.js` | `getData()` 的默认目录 = 内容包合并后的 `.cache/mods/data`（没装包时仍是自带的 `data/`） |
| 25 | `meta-installer` | `server/match/effectsMeta.js` | 策略 / 盟约 / 特质 / 装备 的注册表接缝（读 `globalThis.__SP_MODS_META__`，每次 `createRegistry` 都问一次） |
| 26 | `assets-provider` | `public/js/assets.js` | `setModAssetProvider()` —— 内容包贡献的立绘 / Spine 合进 manifest 查询（游戏自己的条目永远优先） |
| 27 | `field-ready` | `public/js/ui/fieldHost.js` | 战场视图就绪 → `notifyReady(view)`（`api.ready` 与 `on('ready')` 的前提） |
| 28 | `render-attack-plan` | `public/js/render/spine.js` | `field:attack` 的**计划**（`windUp` / `attack` 各一处）：`start` / `timeScale` / `ts` / `once` / `hold` / `rephase` |

> ✅ **1.1.0 把 `field:attack` 补齐了**（上一轮报告 `reports/round-2026-10-11.md` §四 里列的"行为类接缝另行决策"第一项）。这条接缝一代是靠
> `files/public/js/render/**` 的两份上游拷贝（`spine.js` / `units.js`）提供的，二代按规矩不能这么干，于是 1.0.x 里
> 它**没有任何调用点**：`hooks.js` 列着它、模组声明着它，却永远不会被调用。
> 现在两半都在，且都只改几行：**宣布**在 `render-unit-hud`（第 10 条，`onAttack` 里一次 `run` + 给 `attack` / `windUp`
> 多传一个 `view` 实参），**计划**在第 28 条（`windUp` / `attack` 各问一次，答案里多了 `hold` / `rephase`）。
> 两半的守卫、ctx、归一化都在 `files/public/js/mods/render.js`（OURS）；ctx 里的 `rhythm` 是快照 `flags` 16…31 位里
> **模拟自己的** `u.s.interval`（`sim:attackRhythm` 发布的那半）—— 于是"动画从第 0 帧起手"与"`sim:strikeDelay` 把伤害
> 推到出手帧"能用同一个数算，画面与伤害不会各算各的。`CoreBehaviourFixes` 3.0.0 就是这条接缝的第一个消费者。
> 没模组时逐字等价于 0.2.4（计划那一半在未注册路径上**不分配任何对象**）。

每条都幂等（`once` 判据看的是"接线后的形状"）、可还原（原文备份在 `state/backup/`）。
`--audit` 会把它们逐条对一份**干净的上游**试一遍并报告哪条锚点失效 —— **上游再升级时第一步就跑它**。

> ✅ **2026-10-12 两处对不上已闭环**（上一版 README 在这里记的两条缺口）：
> * `public/js/screens/title.js` → `title-buttons` **现在真的在补丁清单里**（第 6 条）：标题页那颗「模组」按钮
>   （`ui/modsButton.js`）与 `ui:button` 宿主（`ui/modButtons.js`，slot `title.actions`）都从干净上游装得出来，
>   不再依赖任何实例里手改过的文件。
> * `server/mods.js` → `updater-rename` **已从 `THEIRS` 删掉**：上游 0.2.4 的 `server/` 下没有 `mods.js`
>   （只有 `data / index / lobby / net / packs / update`），这个文件本来就在 `OURS` 里，它自己 import
>   `./mods-update.js`（官方那个 `server/update.js` 是 `applyPendingUpdate`，名字被它占着 —— 见 `FORBIDDEN_OVERWRITE`），
>   所以没有任何 import 需要改名。删掉之后 `THEIRS` 与 `PATCHES` **一一对应**（27 ↔ 27），
>   `--verify` 报的"会改动上游文件 N 个"就是真实接线数。
> * 这一轮同时把 `sim:*`（12 个钩子）与 `bot:*`（10 个钩子）从"一代接线残渣"重做成了正式接缝，
>   并把一代在 `server/sim/simdata.js`、`public/js/screens/loadout.js` 里留下的**无人认领**的改动
>   从实例里还原成了上游原件（那两处在新架构下是死代码：`attackAnim` 已由上游自己烘进 `def`，
>   而 `loadout.actions` 槽位在 PRTSDataBase 2.0.0 里已经不用了）。

## 4. 给模组作者的能力

* **钩子注册表**（`shared/hooks.js`）：`api.hooks.register(kind, fn, { priority })`；
  四种调用约定 `run` / `emit` / `collect` / `first`（后三种 handler **只收到一个参数**，ctx 在第 1 位）。
* **`api.ui`**：`html` / `h` / `Fragment` / 游戏自己的 `Button`·`Panel`·`Modal`·`Icon`·`MicroLabel`、
  `components()` 懒加载组件、`cls()` 强制前缀、`layers` / `shell`、`mount()` / `render()`、`style()` / `css()`、
  `toast()`、`banner.*`。
* **`api.content`**：12 张内容表的深合并（只写差异）、`api.storage`、`api.on('battleStart' …)` 等事件。
* **`mod.json`**：`id` / `name` / `version` / `api` / `clientOnly` / `entry.client` / `hooks`，
  由 `server/manifest.js` 校验（未知钩子名、版本号格式、缺 entry 都会在 `/mods.html` 上报成 problem）。
* 当前 **`ui:button`** 有两个宿主：`lobby.topbar`（选择模拟协议顶栏，位于干员调配与博士名片之间）与
  `title.actions`（标题页那一行）。返回值是一个**纯数据描述对象**
  `{ id, label, icon, img, title, variant, size, class, onClick, element }` —— 位置与外观归宿主。

## 5. 目录

```
deploy.cmd       一键部署（双击即可）：定位到 `..` → 预览 → 确认 → 装 → 自检
uninstall.cmd    一键卸载（双击即可）：同一个目标 → 确认有记录 → 还原上游 + 删我方文件
findnode.cmd     上面两个共用的"找一个可用的 node"
which.mjs        "游戏目录在哪"的唯一判定点（两个 .cmd 都问它，不允许各说各话）
                 ⚠️ 它里面**不许写绝对路径**：默认目标就是本包的上一级（`..`）
install.mjs      安装器（复制 OURS / 打 PATCHES / 备份 / 还原 / 自检 / 审计锚点）
catalog.mjs      文件所有权目录：OURS 与 THEIRS，**改东西先看这里**
patches.mjs      对上游的全部接线（28 条），带 what / once / apply / manual
files/           本修改器自己的文件（上游没有的那些）—— 24 个
state/           本机安装记录与备份 + last-root.txt（不进版本库也不进 zip：按实例分开存，含绝对路径）
LICENSE          GPL-3.0（上游同许可）
NOTICE.md        上游出处、改动清单、素材不在 GPL 范围、非商业
```

`findroot.mjs` 是**上一代**留下的探测脚本（读 `state/manifest.json`、判据与 `install.mjs` 不同），
这一版的安装器不用它；`.cmd` 走的是 `which.mjs`。留着没删是为了对照，别在它上面加东西。

## 5b. 包该放在哪（约定摆法）

```
<游戏目录>\                       ← 安装目标（本包的 `..`）
├─ package.json  server\  public\ …   上游本体
├─ mods\                          模组包住这儿（部署 / 卸载都不碰它）
└─ dalleriaStellariaModifier1x\   ← 本包整个放进来
   ├─ deploy.cmd / uninstall.cmd
   └─ …
```

这样摆，双击 `deploy.cmd` 就装到 `<游戏目录>` —— 不含任何写死的路径。
想把包装在别处、或要装到另一个实例：用 `--root "D:\那个实例"`（或设 `SP_GAME_ROOT`）。

## 6. 上游升级时怎么办

1. `node install.mjs --audit --root <新的干净上游>` —— 看哪几条 ✘；
2. ✘ 的照着上游新代码改 `patches.mjs` 里那一条的锚点（`apply` 用**缩进无关**的行级匹配，
   因为上游改过缩进量）；
3. 拿一份干净上游 → 装 → `--verify` 全绿 → 起服务 → 进游戏看「模组」按钮与顶栏按钮；
4. **别**为了省事往 `files/` 里放上游拷贝。
