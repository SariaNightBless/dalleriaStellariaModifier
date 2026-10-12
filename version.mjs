// version.mjs —— 修改器的版本号（**唯一权威**）
//
// 为什么单独一个文件：v1 把版本号放在 `files/server/manifest.js` 里，而那个文件同时又服务另一个用途
// （面向模组的 `MOD_API` 契约）；v2 起版本号独立，安装器、归档工具、README 都读它。
//
// 三档规则（维护者手写，工具绝不自动 +1）：
//   x +1  大改 / 结构重写（v1 → v2 就是这一档）
//   y +1  一次功能改动
//   z +1  对同一功能的微调
//
// ⚠️ 运行时那份（`files/server/manifest.js` 的 LOADER_VERSION）必须与本文件的 LOADER_VERSION 一致：
// 前者是 `/api/mods/status` 报的 `loader.version`，后者是安装横幅与 `state` 记录用的。两处不同时，
// 页面显示的版本会与安装时打印的版本对不上。
export const LOADER_VERSION = '1.0.0';

/** 本包面向的上游版本（README 与安装横幅都用它；升级上游时改这里）。 */
export const UPSTREAM_TARGET = '0.2.4';

/**
 * 对外标识：`v<上游简写>-v<本修改器版本>`，即 `v2.4-v1.0.0`。
 * 归档 zip、README 标题、安装横幅都用它 —— 一眼看出「给哪个上游版本用的哪一版」。
 */
export const VERSION_TAG = `v${UPSTREAM_TARGET.replace(/^0\./, '')}-v${LOADER_VERSION}`;
