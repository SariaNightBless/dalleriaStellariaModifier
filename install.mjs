// install.mjs —— 修改器 v2 的安装器
//
// 用法（和 v1 一致，方便迁移）：
//   node install.mjs                     找到游戏目录 → 安装 → 报告
//   node install.mjs --root "D:\game"    指定目录
//   node install.mjs --verify            只核对，不改任何东西
//   node install.mjs --undo              还原（上游文件按备份逐字节还原，我方文件删掉）
//   node install.mjs --audit [--root <干净的上游>]   只逐条试补丁锚点，报告哪条不认（**移植新上游时用这个**）
//   node install.mjs --clean             删掉内容合并缓存 .cache/mods
//
// 三条不可谈判的规矩（v1 就是在这三条上翻的车）：
//   1. 只复制 OURS（上游没有的文件）。上游拥有的文件永远不整份覆盖 —— 只经 PATCHES 打锚点明确的接线。
//   2. 每条补丁幂等（`once` 看的是"接线后的形状"），重复安装不叠加。
//   3. 每条补丁可还原：改之前把原文备份进 state/，--undo 逐字节放回去。
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { OURS, PATCHED_FILE_COUNT } from './catalog.mjs';
import { PATCHES } from './patches.mjs';
import { LOADER_VERSION, UPSTREAM_TARGET, VERSION_TAG } from './version.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FILES = path.join(HERE, 'files');
const STATE = path.join(HERE, 'state');


// ---------------------------------------------------------------------------------------------------------------
// 小工具

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const argOf = (f, d = null) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d; };

const ok = (s) => console.log(`  ✔ ${s}`);
const info = (s) => console.log(`  · ${s}`);
const bad = (s) => { console.error(`  ✘ ${s}`); problems++; };
let problems = 0;

const read = (p) => fs.readFileSync(p, 'utf8');
const sha = (t) => createHash('sha256').update(t, 'utf8').digest('hex');

/** 递归列出一个目录下的相对路径（正斜杠）。 */
function walk(dir, base = dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(abs, base));
    else if (e.isFile()) out.push(path.relative(base, abs).split(path.sep).join('/'));
  }
  return out;
}

/** 这个目录像不像一个游戏根。 */
function looksLikeGame(root) {
  return fs.existsSync(path.join(root, 'server', 'index.js'))
    && fs.existsSync(path.join(root, 'public', 'index.html'))
    && fs.existsSync(path.join(root, 'package.json'));
}

/** 备份/安装记录按 root 分开存：同一台机器上可以装好几个实例。 */
function statePathFor(root) {
  const key = Buffer.from(path.resolve(root).toLowerCase()).toString('base64url').slice(0, 24);
  return path.join(STATE, `${key}.json`);
}
function readState(root) {
  const p = statePathFor(root);
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(read(p)); } catch { return null; }
}
function writeState(root, s) {
  fs.mkdirSync(STATE, { recursive: true });
  fs.writeFileSync(statePathFor(root), JSON.stringify(s, null, 2));
}
const backupPathFor = (root, rel) => path.join(STATE, 'backup', Buffer.from(path.resolve(root).toLowerCase()).toString('base64url').slice(0, 24), rel);

/** 找一个游戏根：本包所在目录向上找，或它的兄弟目录（常见的 modloader/<包> 与 version/<实例> 布局）。 */
function findRoot() {
  const explicit = argOf('--root');
  if (explicit) return path.resolve(explicit);
  const up = path.resolve(HERE, '..', '..');
  if (looksLikeGame(up)) return up;
  const guesses = [path.resolve(HERE, '..', '..', 'version', 'test'), path.resolve(HERE, '..', 'test')];
  for (const g of guesses) if (looksLikeGame(g)) return g;
  return null;
}

// ---------------------------------------------------------------------------------------------------------------
// --audit：只试锚点（移植到新上游时的第一步）

function audit(root) {
  console.log(`\n  逐条试补丁锚点（不改任何文件）\n  上游：${root}\n`);
  let pass = 0, dead = 0;
  for (const p of PATCHES) {
    const abs = path.join(root, p.file);
    if (!fs.existsSync(abs)) { console.log(`  ✘ ${p.id.padEnd(14)} ${p.file} —— 文件不存在`); dead++; continue; }
    const src = read(abs);
    if (p.once(src)) { console.log(`  · ${p.id.padEnd(14)} ${p.file} —— 已接线（无需再打）`); pass++; continue; }
    let out = null;
    try { out = p.apply(src); } catch (e) { console.log(`  ✘ ${p.id.padEnd(14)} ${p.file} —— apply 抛错：${e.message}`); dead++; continue; }
    if (out && out !== src) { console.log(`  ✔ ${p.id.padEnd(14)} ${p.file} —— 可接（${p.what}）`); pass++; }
    else { console.log(`  ✘ ${p.id.padEnd(14)} ${p.file} —— 锚点失效（${p.what}）`); dead++; }
  }
  console.log(`\n  可接/已接 ${pass} · 锚点失效 ${dead}\n`);
  process.exit(dead ? 1 : 0);
}

// ---------------------------------------------------------------------------------------------------------------
// --undo

async function undo(root) {
  const st = readState(root);
  if (!st) { bad(`没有安装记录（${statePathFor(root)}）—— 无法还原`); return; }
  if (path.resolve(st.root) !== path.resolve(root)) { bad(`安装记录里的目录是 ${st.root}，当前是 ${root}`); return; }
  console.log(`\n  还原 ${root}\n`);
  let restored = 0, removed = 0, kept = 0;

  for (const [rel, rec] of Object.entries(st.patched || {})) {
    const abs = path.join(root, rel);
    const bak = backupPathFor(root, rel);
    if (!fs.existsSync(bak)) { info(`${rel}：备份缺失，跳过`); continue; }
    if (fs.existsSync(abs) && sha(read(abs)) !== rec.after) {
      info(`${rel}：装完之后又被改过，未还原（原件在 ${path.relative(HERE, bak)}）`); kept++; continue;
    }
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, read(bak));
    restored++;
  }
  for (const rel of Object.keys(st.copies || {})) {
    const abs = path.join(root, rel);
    if (!fs.existsSync(abs)) continue;
    fs.rmSync(abs, { force: true });
    removed++;
  }
  for (const rel of st.generated || []) fs.rmSync(path.join(root, rel), { force: true });
  ok(`还原 ${restored} 个上游文件、删除 ${removed} 个我方文件${kept ? `（保留 ${kept} 个被后续改动的）` : ''}`);
  fs.rmSync(statePathFor(root), { force: true });
}

// ---------------------------------------------------------------------------------------------------------------
// --verify

async function verify(root) {
  const st = readState(root);
  console.log(`\n  核对 ${root}\n`);
  let good = 0;
  for (const rel of OURS) {
    const abs = path.join(root, rel);
    if (!fs.existsSync(abs)) { bad(`${rel} —— 缺（没装上）`); continue; }
    if (fs.existsSync(path.join(FILES, rel)) && sha(read(abs)) !== sha(read(path.join(FILES, rel)))) {
      info(`${rel} —— 与包内版本不同（可能是本地改动）`); good++; continue;
    }
    good++;
  }
  for (const p of PATCHES) {
    const abs = path.join(root, p.file);
    if (!fs.existsSync(abs)) { bad(`${p.file} —— 文件不存在（${p.what}）`); continue; }
    if (p.once(read(abs))) good++;
    else bad(`${p.file} —— 未接线（${p.what}）`);
  }
  if (st) info(`安装记录：${new Date(st.installedAt).toLocaleString()} · 修改器 v${st.loaderVersion} · ${Object.keys(st.copies || {}).length} 个我方文件 · ${Object.keys(st.patched || {}).length} 个上游接线`);
  else info('没有安装记录（state/ 里找不到这个目录的条目）');
  ok(`装上且就位 ${good} 项 · 会改动上游文件 ${PATCHED_FILE_COUNT} 个`);
}

// ---------------------------------------------------------------------------------------------------------------
// install

async function install(root) {
  console.log(`\n  ╔══════════════════════════════════════════════════════════╗`);
  console.log(`  ║  修改器 ${VERSION_TAG}  ·  面向上游 ${UPSTREAM_TARGET}                ║`);
  console.log(`  ╚══════════════════════════════════════════════════════════╝\n`);
  if (!looksLikeGame(root)) { bad(`${root} 不像游戏目录，拒绝安装`); return; }
  // 约定摆法是**把本包整个放进游戏根**（<游戏根>\<包>\），装到它的上一级 —— 也就是 root 包含本包，
  // 这是正常的，不再拒绝（曾有一条 "目标目录包含本包自己 → 拒绝" 的护栏，那是"包放在游戏树之外"
  // 时代的写法，会把默认目标 `..` 直接挡死）。这条路径安全，因为：
  //   · `files/**` 里只有"游戏根相对路径"，没有任何回指本包的路径，复制不会递归；
  //   · `--undo` 只动安装记录里列出的那些文件（OURS + patches），本包目录不在其中；
  //   · 拒绝清单永远留着 `FORBIDDEN_OVERWRITE`（上游同名的文件不许被整份覆盖）。
  // 只剩一种情况必须拒：把安装目标写成**本包自己**——那里没有 server/index.js，
  // looksLikeGame 已经先挡了；这里再兜一层，防止将来判据放宽。
  if (path.resolve(root) === path.resolve(HERE)) {
    bad('拒绝安装：目标目录就是本包自己'); return;
  }
  console.log(`  游戏目录：${root}\n`);

  const st = readState(root) || { root, installedAt: null, loaderVersion: null, copies: {}, patched: {}, generated: [] };

  // ---- 1) 复制我方文件 ---------------------------------------------------------------------------------------
  console.log('  [1/4] 复制本修改器的文件（上游没有的那些）');
  let copied = 0, same = 0;
  for (const rel of OURS) {
    const src = path.join(FILES, rel);
    if (!fs.existsSync(src)) { bad(`${rel} —— 包内缺这个文件（catalog.mjs 列了它）`); continue; }
    const dst = path.join(root, rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    const before = fs.existsSync(dst) ? read(dst) : null;
    const body = read(src);
    if (before === body) { same++; st.copies[rel] = { after: sha(body) }; continue; }
    fs.writeFileSync(dst, body);
    copied++;
    st.copies[rel] = { after: sha(body) };
  }
  ok(`复制 ${copied} 个（${same} 个已是最新）`);
  st.generated = ['public/mods.css.tmp'].filter((f) => fs.existsSync(path.join(root, f)));

  // ---- 2) 打补丁 ---------------------------------------------------------------------------------------------
  console.log('\n  [2/4] 接线（只动这几行，改前先备份）');
  for (const p of PATCHES) {
    const abs = path.join(root, p.file);
    if (!fs.existsSync(abs)) { bad(`${p.file}：文件不存在（${p.what}）`); continue; }
    const src = read(abs);
    if (p.once(src)) { info(`${p.what}（已接线）`); continue; }
    // 备份原文（只备一次：重复安装时保留"最初的上游原件"）
    const bak = backupPathFor(root, p.file);
    if (!fs.existsSync(bak)) {
      fs.mkdirSync(path.dirname(bak), { recursive: true });
      fs.writeFileSync(bak, src);
    }
    let out = null;
    try { out = p.apply(src); } catch (e) { bad(`${p.file}：apply 抛错 ${e.message}`); continue; }
    if (!out || out === src) { bad(`${p.file}：找不到锚点（${p.what}）—— 上游可能又变了，跑 --audit 看清单；手工片段见 README`); continue; }
    fs.writeFileSync(abs, out);
    st.patched[p.file] = { after: sha(out), what: p.what, backup: path.relative(HERE, bak).split(path.sep).join('/') };
    ok(`${p.file} —— ${p.what}`);
  }

  // ---- 3) 记状态 ---------------------------------------------------------------------------------------------
  console.log('\n  [3/4] 记录安装状态');
  st.root = root;
  st.loaderVersion = LOADER_VERSION;
  st.installedAt = st.installedAt || new Date().toISOString();
  writeState(root, st);
  ok(`state/${path.basename(statePathFor(root))}`);

  // ---- 4) 报告 -----------------------------------------------------------------------------------------------
  console.log('\n  [4/4] 结果');
  if (problems) console.error(`\n  ✘ 安装完成，但有 ${problems} 处问题（见上）`);
  else console.log('  ✔ 安装成功\n');
  console.log(`     管理页：http://<地址>/mods.html`);
  console.log(`     卸载：  node install.mjs --undo --root "${root}"`);
  console.log(`     自检：  node install.mjs --verify --root "${root}"\n`);
}

// ---------------------------------------------------------------------------------------------------------------

const clean = (root) => {
  const cache = path.join(root, '.cache', 'mods');
  fs.rmSync(cache, { recursive: true, force: true });
  ok(`已删除 ${path.relative(root, cache).split(path.sep).join('/') || cache}`);
};

const root = findRoot();
if (has('--audit')) {
  // 默认拿**本包的上一级**当"干净上游"试锚点：约定摆法是包放进游戏根（<游戏根>\<包>\），
  // 所以上一级通常就是一份（或就是那个）游戏根。要试别的版本：`--audit --root <那份上游>`。
  // ⚠️ 这里不要写任何写死的绝对路径 —— 包会被搬到别的实例 / 别的机器上。
  audit(path.resolve(argOf('--root') || findRoot() || path.resolve(HERE, '..')));
} else if (!root) {
  bad('找不到游戏目录。用 --root "D:\\你的游戏目录" 指定');
  process.exitCode = 1;
} else if (has('--undo')) await undo(root);
else if (has('--verify')) await verify(root);
else if (has('--clean')) clean(root);
else await install(root);

process.exitCode = problems || process.exitCode ? 1 : 0;
