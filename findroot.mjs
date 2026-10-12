// findroot.mjs —— 游戏目录在哪？所有启动入口共用（POSIX sh 与 cmd.exe 都来问它）。
//
//   node findroot.mjs [--root 目录]
//
// 找到就把游戏根打到 stdout 并退出 0；找不到就把查找过的候选打到 stderr 并退出 1。
// 不写任何文件、不改任何东西：它只回答一个问题。
//
// 顺序与 install.mjs 自己的 findRoot() 一致，于是包装脚本和安装器不可能对"哪个目录是游戏"各说各话：
//   1. --root 目录（独占：给了它就只认它，别的候选连试都不试）
//   2. 本包的上一级、再上一级（"包放在游戏里面"的摆法），外加 ../game
//   3. state/manifest.json 里记的 root —— --undo 必须认这个
//   4. 环境变量 $SP_GAME_ROOT
// 每个候选都用 install.mjs 的同一套判据验证（见下面的 looksLikeGame）。
//
// 为什么需要这个文件：这个包以前就放在游戏目录里，`dirname(HERE)` 就够了。现在它下移了一层
// （modloader/<包名>/），落在任何游戏树之外，所以每个入口都得明确地把游戏找出来，而不是靠猜。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const argOf = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : null; };

/**
 * 与 install.mjs 完全相同的五个判据。必须一模一样：一个目录若在这里通过、在那里不通过，
 * 用户就会看到"明明找到了却说找不到游戏目录"。
 */
const looksLikeGame = (dir) => ['server/index.js', 'server/data.js', 'public/index.html', 'shared/constants.js', 'server/sim/spec.js']
  .every((rel) => fs.existsSync(path.join(dir, rel)));

const exists = (p) => { try { return fs.existsSync(p); } catch { return false; } };

/** 读 state/manifest.json 里的 `root` 字段，读不到就返回空串。 */
function manifestRoot() {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(HERE, 'state', 'manifest.json'), 'utf8'));
    return typeof m?.root === 'string' ? m.root : '';
  } catch { return ''; }
}

const explicit = argOf('--root');
const candidates = [];
if (explicit) {
  // 明确给了 --root 就只认它：用户以为指到了某个目录、脚本却悄悄回退到别处，正是"还原错了那份安装"的成因。
  candidates.push(path.resolve(explicit));
} else {
  candidates.push(
    path.resolve(path.dirname(HERE)),                  // 本包的上一级
    path.resolve(path.dirname(HERE), '..'),            // 本包的上两级（modloader/<包名>/ 这种摆法）
    path.resolve(HERE, '..', 'game'),                  // <游戏根>/<包名>/../game（旧约定）
  );
  const fromManifest = manifestRoot();
  if (fromManifest) candidates.push(path.resolve(fromManifest));
  if (process.env.SP_GAME_ROOT) candidates.push(path.resolve(process.env.SP_GAME_ROOT));
}

for (const dir of candidates) {
  if (looksLikeGame(dir)) {
    process.stdout.write(dir + '\n');
    process.exit(0);
  }
}

process.stderr.write('找不到游戏目录（需要 server/index.js + public/index.html）\n');
process.stderr.write('找过这些地方：\n');
for (const dir of [...new Set(candidates)]) process.stderr.write('  ' + dir + '\n');
process.stderr.write('办法：用 --root <目录> 指过去，或者把本包放进游戏目录里，或者设 SP_GAME_ROOT\n');
process.exit(1);
