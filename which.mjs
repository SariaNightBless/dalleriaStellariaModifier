// which.mjs —— 「游戏目录在哪？」的唯一判定点，给 deploy.cmd / uninstall.cmd 用。
//
//   node which.mjs [--root <目录>] [--out <文件>] [--probe] [--list] [--resolve]
//
// 为什么放在包根而不是 state/：state/ 是本机记录目录、**不进版本库也不进发布包**
//   （见 .gitignore）。把它塞在 state/ 里，别人 clone 下来第一件事就是"脚本找不到文件"。
//   它跟 install.mjs / patches.mjs 一样是包自己的代码，就该跟它们并排。
//
// 为什么单独一个文件：cmd 里没法可靠地"读 base64 键 → 解出 root → 查文件"，而
// deploy.cmd（装到哪）与 uninstall.cmd（从哪卸）**必须**对"这个实例在哪"给出同一个答案。
// 两边各写一份判断，迟早出现"装进去一个目录、卸载找的是另一个"。
//
// 判定顺序（先给 --root 的独占权，与 install.mjs --root 一致）：
//   1. --root <目录>          给了就只看它，不通过就报错，绝不偷偷换一个
//   2. %SP_GAME_ROOT%         环境变量
//   3. state/last-root.txt    上次装过的目录（本包自己记的，见 deploy.cmd）
//   4. state/*.json           安装记录里的 root —— --undo 必须认这个，否则卸不掉
//   5. 包里包外的常见摆法     「包在游戏里」/「游戏在包里」/「与实例并排」
//   6. 放弃：把找过的候选打到 stderr，退出 1
//
// --out <文件>：把**机器要读的那一行**写进文件，stdout 保持干净。给 .cmd 用 ——
//   在 for /f 里收命令输出 + 命令里带重定向，引号要写成 `cmd /c "… 2^>nul"` 才转得过去，
//   稍不留神就变成"静默什么都不输出"（这坑真踩过：预览一片空、probe 永远判成没装过）。
//   写文件那条路没有这些引号机关。⚠️ 写进文件的内容一律 ASCII：cmd 用 set /p 读的是控制台
//   代码页，中文会读成乱码，所以文件里只写路径 / 状态词，给人看的说明走 stdout。
//
// --resolve：只做一件事 —— 把命令行里 `--root <目录>` 的值解出来（带引号 / 带空格都认），
//   写进 --out 或 stdout；命令行里没有 --root 就退出 2、什么都不写。给 .cmd 用：
//   cmd 的 `for %%a in (%*)` 会把引号拆掉，`--root "D:\my game"` 于是碎成两个 token，
//   批处理里再拼回去要跟半个 cmd 的引号规则搏斗 —— 交给 node 解析这条路才是准的。
//
// --probe：只回答"这个目录在本包里有安装记录吗"（uninstall.cmd 用）。
//   ← 光靠 cmd 判断不了这件事：`for %%f in ("state\*.json")` 在没有匹配时会把**通配符本身**
//     当成一个文件名交出来，于是"没有记录"会被误判成"有记录"。让 node 去数文件才可靠。
//
// 判据与 install.mjs 的 looksLikeGame() 逐字相同（三个核心文件），拿不准就交给它自己拒绝：
// 宁可让用户在 cmd 里手输一次路径，也不要"装到一个看起来像游戏根、其实不是"的目录里去。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG = path.dirname(fileURLToPath(import.meta.url));     // 本包根（安装器与 patches.mjs 也在这儿）
const STATE = path.join(PKG, 'state');                       // 本机安装记录 / 备份 / last-root.txt

const argv = process.argv.slice(2);
const argOf = (flag) => { const i = argv.indexOf(flag); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : null; };
const has = (flag) => argv.includes(flag);

/** 与 install.mjs 的 looksLikeGame() 一字不差：一个目录想过关，这三个必须都在。 */
const CORE = ['server/index.js', 'public/index.html', 'package.json'];
/** 上游的整棵树的记号，用来区分「游戏根」与「碰巧有三个文件的目录」。 */
const MORE = ['server/data.js', 'shared/constants.js', 'server/sim/spec.js'];

const isFile = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };
const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };

/** 'good' = 看起来就是游戏根；'soft' = 三个核心在、上游整棵树的记号不全（仍可用）；'bad' = 不是。 */
function grade(dir) {
  if (!isDir(dir)) return 'bad';
  if (!CORE.every((rel) => isFile(path.join(dir, rel)))) return 'bad';
  return MORE.every((rel) => isFile(path.join(dir, rel))) ? 'good' : 'soft';
}

/** 读一个文件的第一行，读不到返回空串。 */
function firstLine(p) {
  try { return fs.readFileSync(p, 'utf8').split(/\r?\n/)[0].trim(); } catch { return ''; }
}

/** 写 --out 那个文件（ASCII 单行）。丢了不算错：stdout 那条路还在。 */
function writeOut(text) {
  const out = argOf('--out');
  if (!out) return;
  try { fs.writeFileSync(path.resolve(out), text + '\n', 'utf8'); } catch { /* 写不进去就只靠 stdout */ }
}

/** state/*.json 里记的 root（安装时写的，含绝对路径）。 */
function rootsFromState() {
  const out = [];
  let entries = [];
  try { entries = fs.readdirSync(STATE, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith('.json')) continue;
    try {
      const rec = JSON.parse(fs.readFileSync(path.join(STATE, e.name), 'utf8'));
      if (typeof rec?.root === 'string' && rec.root) out.push({ dir: path.resolve(rec.root), why: `安装记录 state/${e.name}` });
    } catch { /* 坏记录跳过：那不该拦住别的候选 */ }
  }
  return out;
}

/** 「包放在哪」推断出来的候选：包在游戏里、游戏在包里、与游戏并排。 */
function layouts() {
  const up = [PKG, path.dirname(PKG), path.resolve(PKG, '..', '..')];
  const down = [
    path.join(PKG, 'game'),                     // <包>/game/
    path.resolve(PKG, '..', 'game'),            // <某个目录>/<包>/../game
    path.resolve(PKG, '..', 'version', 'test'), // 开发机常见：modloader/<包> 与 version/test 并排
    path.resolve(PKG, '..', 'version', 'modified_0'),
  ];
  const named = ['Stronghold-Protocol', 'game', 'app']
    .flatMap((n) => [path.resolve(PKG, '..', '..', 'version', n), path.resolve(PKG, '..', n)]);
  const seen = new Set();
  const out = [];
  for (const dir of [...up, ...down, ...named]) {
    const key = dir.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ dir, why: '按包的位置推断' });
  }
  return out;
}

const candidates = [];
const explicit = argOf('--root');
if (explicit) {
  candidates.push({ dir: path.resolve(explicit), why: '--root 指定（独占）' });
} else {
  const saved = firstLine(path.join(STATE, 'last-root.txt'));
  if (saved) candidates.push({ dir: path.resolve(saved), why: '上次装过的目录 state/last-root.txt' });
  if (process.env.SP_GAME_ROOT) candidates.push({ dir: path.resolve(process.env.SP_GAME_ROOT), why: '环境变量 SP_GAME_ROOT' });
  candidates.push(...rootsFromState());
  candidates.push(...layouts());
}

const graded = candidates.map((c) => ({ ...c, grade: grade(c.dir) }));
const hit = graded.find((c) => c.grade === 'good' || c.grade === 'soft');

// --resolve：只解 `--root <目录>` 的值（不做"像不像游戏根"的判断 —— 那是下一步的事）
if (has('--resolve')) {
  if (!explicit) { process.stderr.write('no --root given\n'); process.exit(2); }
  writeOut(path.resolve(explicit));
  process.stdout.write(path.resolve(explicit) + '\n');
  process.exit(0);
}

// --probe：这个目录在本包里有安装记录吗？（stdout/--out 只写 ASCII 的 'installed'）
if (has('--probe')) {
  const target = explicit ? path.resolve(explicit) : hit?.dir;
  if (!target) { process.stderr.write('no target\n'); process.exit(2); }
  const rec = rootsFromState().find((r) => r.dir.toLowerCase() === target.toLowerCase());
  if (!rec) { process.stderr.write(`no install record: ${target}\n`); process.exit(2); }
  writeOut('installed');
  process.stdout.write(`已装过（${rec.why}）\n`);
  process.exit(0);
}

if (has('--list')) {
  for (const c of graded) console.log(`${c.grade.padEnd(4)}  ${c.dir}   （${c.why}）`);
  process.exit(0);
}

if (hit) {
  if (hit.grade === 'soft') {
    process.stderr.write(`[!] ${hit.dir} 有三个核心文件，但上游整棵树的记号不全（${MORE.filter((r) => !isFile(path.join(hit.dir, r))).join('、')}）——仍按游戏根使用\n`);
  }
  writeOut(hit.dir);
  process.stdout.write(hit.dir + '\n');
  process.exit(0);
}

process.stderr.write(explicit
  ? `\n[X] --root 指的这个目录不是游戏根：${path.resolve(explicit)}\n    它里面必须有 server\\index.js、public\\index.html、package.json。\n\n`
  : '\n[X] 找不到游戏目录。\n\n');
process.stderr.write('找过这些地方：\n');
if (graded.length === 0) process.stderr.write('  （一个候选都没有）\n');
for (const c of graded) process.stderr.write(`  [${c.grade}] ${c.dir}   （${c.why}）\n`);
process.stderr.write('\n办法：\n');
process.stderr.write('  1) 用 --root 指过去，例如：  deploy.cmd --root "D:\\你的游戏目录"\n');
process.stderr.write('  2) 设环境变量 SP_GAME_ROOT\n');
process.stderr.write('  3) 把本包直接放进游戏目录里（安装器会认出来）\n');
process.exit(1);
