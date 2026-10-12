# NOTICE

## 本包

**dalleriaStellariaModifier** —— 《卫戍协议：盟约》的模组加载器，版本 **1.0.0**。

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

### 1.1 打了补丁的上游文件（22 个文件，36 条补丁）

安装时由 `install-patches.js` 现场改写。每条补丁的完整实现、幂等判据（`once`）与手工插入片段都在该文件里。

| 文件 | 补丁数 | 改动内容 |
|---|---|---|
| `public/index.html` | 2 | 引入管理器样式表<br>引入槽位样式表（sp-mods-slots.css） |
| `public/js/assets.js` | 1 | 干员美术清单可扩展（内容包自带 spine / 头像 / 半身像 / 盟约与策略图标） |
| `public/js/battle/runner.js` | 1 | 客户端 sim 模组（extraContent）+ battleStart / battleEnd 通知 |
| `public/js/main.js` | 2 | 启动模组加载器（首次渲染之前）<br>整局结算通知模组（`api.on('matchResult')`） |
| `public/js/screens/game.js` | 2 | 把"正在观战的那个玩家"传给 TopBar（顶部 LP 塔据此显示队友的生命）<br>横幅时长 / 改写 / 抑制（`api.ui.banner` + timing 表） |
| `public/js/screens/loadout.js` | 1 | 干员调配的 `ui:slot` 接缝（slot `loadout.actions`） |
| `public/js/screens/lobby.js` | 1 | `ui:button` 调用点（选择模拟协议顶栏接纳模组按钮） |
| `public/js/screens/title.js` | 2 | 标题页「玩法说明」旁的模组管理按钮<br>标题页的 `ui:button` 宿主（slot `title.actions`） |
| `public/js/ui/fieldHost.js` | 1 | field view 就绪时通知模组（`api.ready`） |
| `public/js/ui/hud.js` | 1 | 观战时顶部 LP 塔显示队友的生命（`topBarLp` 纯函数 + TopBar 的 `watchP` 参数） |
| `server/data.js` | 1 | 内容包数据入口（`getData` 读到合并后的表） |
| `server/index.js` | 2 | 启动顺序（先扫模组 → 合并内容 → 加载 sim 模块）+ `/api/mods/status\|updates\|content`<br>模组目录的记账文件不进静态服务（`mods/mods.cache.json`） |
| `server/match/bot.js` | 1 | AI 决策接缝（`bot:bandWeights` / `bot:cardScore` / `bot:bondPlan` / `bot:buyScore` / `bot:refreshValue` / `bot:lineupScore` / `bot:layoutParams` / `bot:rehearsal` + `botParam` 旋钮）；无模组时逐次决策不变 |
| `server/match/effectsMeta.js` | 1 | prep 效果注册表开一个模组扩展点（策略 / 盟约的机制入口） |
| `server/sim/Battle.js` | 3 | 模拟接缝（`sim:enemyAI` / `sim:unitTick` / `sim:battleEnd`）<br>快照带上屏障数值<br>生成敌人时把攻击动画时长 / 出手帧带给单位 |
| `server/sim/ai.js` | 4 | 阻挡两规则：候选表最终顺序（`sim:targetOrder`）与这一挥的攻击形态（`sim:attackMode`）<br>干员攻击可按出手帧结算（`sim:strikeDelay`）<br>敌人攻击也可按出手帧结算<br>攻击接缝：候选目标值透传（`sim:targets`）+ 每目标伤害倍率（`sim:attack`） |
| `server/sim/content/enemies.js` | 1 | "解压"生成的子代不计入敌人总数（`x/y` 的 `y`） |
| `server/sim/damage.js` | 1 | 模拟接缝（`sim:damage`：命中前的数值 / 类型可改） |
| `server/sim/simdata.js` | 2 | 敌人数据的攻击动画时长 / 出手帧可读<br>干员数据的攻击动画时长 / 出手帧可读 |
| `server/sim/snapshot.js` | 3 | 快照带上屏障数值<br>快照的 ATTACK 窗口走模拟钩子（`simAttackWindow`）<br>快照带上模拟的攻击节奏 |
| `server/sim/spec.js` | 1 | `spec → Battle` 透传 `extraContent`（行为模组的正门） |
| `tools/build-data.mjs` | 2 | 敌人 / 干员数据带上攻击动画时长与出手帧（`attackAnimTime` / `attackStrikeAt`） |

这些补丁在**无模组时保持上游行为**：所有调用点都以「有没有模组注册」为守卫，没有模组逐帧、逐字节与上游一致。补丁的幂等判据检查文件的实际内容而非日志，因此可以重复安装。

### 1.2 整层替换的渲染层（22 个文件）

`public/js/render/**` 下的文件被本包的改写版整体覆盖：

```
app.js  boardArt.js  drag.js  fx.js  impostor.js  interp.js  pen.js  pick.js
prepfield.js  projection.js  promote.js  spine.js  style.js  textures.js
tiles.js  units.js  board3d/{atlas,layout,load,materials,obj,scene}.js
```

改写的目的是把原先写死在渲染代码里的外观数值（配色、条带几何、等级牌画法、跳字样式…）变成运行时可写的旋钮（`STYLE`，9 组 78 个键）。**默认值全部等于上游**，所以没有模组时画面与上游一致；安装器的 `--verify` 每次逐键核对这一点。

`upstream/style.js` 与 `upstream/textures.js` 是这两份文件的上游原始版本，随包分发**仅用于上述核对**。

## 二、本包新增的文件（24 个）

游戏原本没有这些文件，由安装器新增。它们**不是**对上游文件的修改：

```
server/mods.js  server/manifest.js  server/update.js  server/content.js
server/loader.js  server/modapi.js           模组管理器（服务端）
server/sim/modlogic.js                        模拟侧钩子注册表
server/match/botlogic.js                      AI 决策侧钩子注册表
public/mods.html                             管理页面
public/css/sp-mods.css  public/css/sp-mods-slots.css
public/js/ui/modsButton.js  public/js/ui/modButtons.js
public/js/mods.js  public/js/mods/{resolve,ui,content,tables,timing,sim,assets}.js
shared/hooks.js  shared/content.js            钩子注册表与内容包合并规则（页面与服务端共用）
public/dev/render-demo.js                     开发用页面（用同一套加载器预览渲染层）
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
