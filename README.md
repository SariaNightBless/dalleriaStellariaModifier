# dalleriaStellariaModifier v2.4-v1.0.0

《卫戍协议：盟约》的模组加载器（第二代架构），面向**上游 0.2.4**。标识读法：`v2.4` 是它面向的上游版本，`v1.0.0` 是修改器自己的版本（`version.mjs` 是唯一权威）。

装完之后：标题页多一个「模组」按钮 → `/mods.html`（拖 zip / 放文件夹 /
启停 / 删除 / 检查更新），游戏根多一个 `mods/` 目录，里面每个包都能往界面里加东西、往数据里加内容。

## 0. 怎么装、怎么卸（双击就行）

| 双击 | 干什么 |
|---|---|
| **`deploy.cmd`** | 部署：自动找游戏目录 → 显示那儿现在装没装 → 问一句 → 装 → 自检 |
| **`uninstall.cmd`** | 卸载：自动找游戏目录 → 确认有安装记录 → 问一句 → 逐字节还原上游、删掉本修改器的文件 |

命令行用法（参数**放哪都行**，路径带空格 / 中文请加引号）：

```bat
deploy.cmd                              :: 自动找游戏目录
deploy.cmd --root "D:\你的游戏目录"      :: 指定目录
deploy.cmd --root "D:\..." --yes        :: 不问确认
deploy.cmd --verify                     :: 只看现在装没装好（不改任何文件）
deploy.cmd --audit                      :: 只逐条试补丁锚点（换新上游时第一步跑它）
deploy.cmd --list                       :: 只列出"找过哪些候选目录"

uninstall.cmd                           :: 自动找游戏目录
uninstall.cmd --root "D:\你的游戏目录" --yes
uninstall.cmd --clean                   :: 还原之后顺手删掉内容合并缓存 .cache\mods
```

三点须知：

* **本修改器不搬任何模组包**。模组包留在实例的 `mods\` 目录里（拖进 `/mods.html` 或手工放进去都行）；
  `uninstall.cmd` **也不会删** `mods\` —— 卸载只还原上游文件、删掉加载器自己的文件。
* 装完 / 卸完都要**重启游戏服务器**才生效。
* "游戏目录在哪"只由 `which.mjs` 一家判定，两个脚本认的是同一个答案（顺序：`--root` →
  `SP_GAME_ROOT` → `state\last-root.txt` → `state\*.json` 里的安装记录 → 按包的位置推断）。
  找不到时会让你手输一次，绝不偷偷装到别的目录里去。

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

## 3. 它到底改了上游哪几行（6 条，都在 `patches.mjs`）

| # | 文件 | 干什么 |
|---|---|---|
| 1 | `public/js/main.js` | 首帧之前 `import('./mods.js')` 并把包加载起来（模组要能影响第一帧、内容包要在任何界面读数据前进 store） |
| 2 | `server/index.js` | 启动顺序：先扫包 → 合并内容包 → 加载行为模块，再读表；把 `modsDir` / `modsApi` 交给静态与路由 |
| 3 | `server/http/static.js` | `/mods/` 静态挂载（**排在 `/` 之前**，否则被它吃掉） |
| 4 | `server/http/routes.js` | `/api/mods*` 分发给修改器的 HTTP 面 |
| 5 | `public/js/screens/lobby.js` | 顶栏的 `ui:button` 宿主 —— 插在「干员调配」与「博士名片」之间 |
| 6 | `public/index.html` | 引入 `sp-mods.css` |

每条都幂等（`once` 判据看的是"接线后的形状"）、可还原（原文备份在 `state/backup/`）。
`--audit` 会把它们逐条对一份**干净的上游**试一遍并报告哪条锚点失效 —— **上游再升级时第一步就跑它**。

> ⚠️ **已知对不上（2026-10-11 核对，尚未修）**：`catalog.mjs` 的 `THEIRS` 列了 **8** 个文件、
> 名字里还挂着 `title-buttons` 与 `updater-rename` 两条 id，但 `patches.mjs` 里只有 **6** 条接线
> —— 标题页那颗「模组」按钮（`public/js/screens/title.js` 引 `ModsButton` / `ModButtons`）**不在补丁清单里**。
> 换句话说：`--verify` 会照 `THEIRS` 的长度报"会改动上游文件 8 个"，而装完实际只动 6 个；
> 当前测试实例 `D:\sp\version\test` 的 `title.js` 是**手工改过**的，所以本机看着正常，
> **换一台干净上游装出来会只有顶栏按钮、标题页没有入口**（顶栏那个还在，功能不至于丢）。
> 另：上游 0.2.4 的 `server/` 下**没有** `mods.js` —— 这一版把它放在 `OURS` 里是对的，
> `THEIRS` 里那条 `'server/mods.js': ['updater-rename']` 是上一代写法的残留。

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
deploy.cmd       一键部署（双击即可）：找目录 → 预览 → 确认 → 装 → 自检
uninstall.cmd    一键卸载（双击即可）：找目录 → 确认有记录 → 还原上游 + 删我方文件
findnode.cmd     上面两个共用的"找一个可用的 node"
which.mjs        "游戏目录在哪"的唯一判定点（两个 .cmd 都问它，不允许各说各话）
install.mjs      安装器（复制 OURS / 打 PATCHES / 备份 / 还原 / 自检 / 审计锚点）
catalog.mjs      文件所有权目录：OURS 与 THEIRS，**改东西先看这里**
patches.mjs      对上游的全部接线（6 条），带 what / once / apply / manual
files/           本修改器自己的文件（上游没有的那些）—— 22 个
state/           本机安装记录与备份 + last-root.txt（不进版本库也不进 zip：按实例分开存，含绝对路径）
LICENSE          GPL-3.0（上游同许可）
NOTICE.md        上游出处、改动清单、素材不在 GPL 范围、非商业
```

`findroot.mjs` 是**上一代**留下的探测脚本（读 `state/manifest.json`、判据与 `install.mjs` 不同），
这一版的安装器不用它；`.cmd` 走的是 `which.mjs`。留着没删是为了对照，别在它上面加东西。

## 6. 上游升级时怎么办

1. `node install.mjs --audit --root <新的干净上游>` —— 看哪几条 ✘；
2. ✘ 的照着上游新代码改 `patches.mjs` 里那一条的锚点（`apply` 用**缩进无关**的行级匹配，
   因为上游改过缩进量）；
3. 拿一份干净上游 → 装 → `--verify` 全绿 → 起服务 → 进游戏看「模组」按钮与顶栏按钮；
4. **别**为了省事往 `files/` 里放上游拷贝。
