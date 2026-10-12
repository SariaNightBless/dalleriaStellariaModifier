// server/modapi.js — the HTTP surface of the mod manager, in one file.
//
// WHY A MODULE AND NOT INLINE PATCHES
//   The installer used to insert an API handler, its routes and its body reader as separate snippets into
//   `server/index.js`. Every one of those snippets is a place where a newer upstream file can move an anchor and leave
//   the game with a half-wired manager. Keeping the whole surface here means the installer's change to `index.js` is
//   ONE line — `if (await handleModsApi(req, res)) return;` — and everything else lives in a file this package owns.
//
// ENDPOINTS (all under /api/mods so they never collide with the static mounts)
//   GET  /api/mods                    every package: manifest fields, status, content, hooks, update state
//   GET  /api/mods/list               the same (alias)
//   GET  /api/mods/status             manager + loader summary: mounted counts, merged tables, sim modules, hooks
//   GET  /api/mods/content            per package: which records a content pack contributes and what it overrides
//   GET  /api/mods/updates            where each package's update stands
//   POST /api/mods/updates            check every declared update source now (installs a newer copy)
//   POST /api/mods/rescan             re-read mods/ from disk
//   POST /api/mods/upload             a .zip body (header `x-mod-filename`), installed as a new package
//   POST /api/mods/enable/<id>        enable
//   POST /api/mods/disable/<id>       disable
//   POST /api/mods/remove/<id>        delete the package folder
//
// A package's own files are served by the static handler's `/mods/` mount (`createStaticHandler({ modsDir })`), not
// here: a mod's `client.js` / `sim.js` / `content/*.json` must be plain GETs so the browser can `import` and `fetch`
// them.
//
// The only writer is this file, and the only scope it can write to is `mods/` (plus `.cache/mods`, through the loader).

import { loaderStatus } from './loader.js';
import { LOADER_VERSION } from './manifest.js';

/** Nothing bigger than this is accepted as an upload (a package is code + data + maybe art). */
export const MAX_UPLOAD_BYTES = 64 * 1024 * 1024;

/** Read a request body with a hard cap; resolves to a Buffer, rejects with a code the caller can turn into a status. */
export function readBody(req, maxBytes = MAX_UPLOAD_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > maxBytes) {
        reject(Object.assign(new Error(`request body larger than ${maxBytes} bytes`), { code: 'TOO_LARGE' }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/**
 * Build the handler. Every argument is injected so this module never reaches into the server's own scope.
 *
 * @param {{ mods: object, sendJson: Function, sendError: Function, log?: object, loadMods?: Function }} deps
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<boolean>}
 *   `true` when the request was handled (the caller must not fall through to the static handler).
 */
export function createModsApi({ mods, sendJson, sendError, log = console, loadMods = null }) {
  return async function handleModsApi(req, res) {
    const url = req.url || '/';
    const q = url.indexOf('?');
    const rawPath = q >= 0 ? url.slice(0, q) : url;
    if (rawPath !== '/api/mods' && !rawPath.startsWith('/api/mods/')) return false;
    const sub = rawPath.slice('/api/mods'.length).replace(/^\/|\/$/g, '');
    const isPost = req.method === 'POST';

    // ---- reads ------------------------------------------------------------------------------------------------
    if (sub === '' || sub === 'list') {
      if (isPost) { sendError(req, res, 405, '需要 GET · GET required'); return true; }
      // `loaderVersion` rides along so the manager page can show which build of the loader is serving it
      sendJson(req, res, 200, { ...mods.list(), loaderVersion: LOADER_VERSION });
      return true;
    }
    if (sub === 'status') {
      // `loader.version` = the loader package's own version (manifest.js LOADER_VERSION), next to its data dir,
      // sim/meta modules and hook census.
      sendJson(req, res, 200, {
        ...mods.summary(),
        loader: { ...(safe(loaderStatus) || {}), version: LOADER_VERSION },
        update: mods.updateStatus(),
      });
      return true;
    }
    if (sub === 'content') {
      const withRecords = new URLSearchParams(q >= 0 ? url.slice(q + 1) : '').get('records') === '1';
      const list = [...mods.records().values()].filter((r) => r.status === 'ok');
      sendJson(req, res, 200, {
        ok: true,
        mods: list.map((r) => {
          const report = mods.contentOf(r.id);
          if (!report) return { id: r.id, tables: {}, records: 0, problems: [] };
          return withRecords ? report : { id: report.id, records: report.records, problems: report.problems, tables: Object.fromEntries(Object.entries(report.tables).map(([t, v]) => [t, { count: v.count, overrides: v.overrides }])) };
        }),
      });
      return true;
    }

    // ---- writes -----------------------------------------------------------------------------------------------
    if (sub === 'updates') {
      if (!isPost) { sendJson(req, res, 200, { ok: true, status: mods.updateStatus() }); return true; }
      // never let a slow remote host hold the request open forever
      const out = await Promise.race([
        mods.checkUpdates({ force: true, install: true }),
        new Promise((r) => setTimeout(() => r({ ok: false, error: 'update check timed out' }), 45000)),
      ]);
      sendJson(req, res, 200, out);
      return true;
    }
    if (sub === 'rescan') {
      await mods.scan();
      sendJson(req, res, 200, mods.list());
      return true;
    }
    if (sub === 'upload') {
      if (!isPost) { sendError(req, res, 405, '需要 POST · POST required'); return true; }
      const name = decodeURIComponent(String(req.headers['x-mod-filename'] || 'mod.zip')).replace(/[\\/]/g, '_');
      if (!/\.zip$/i.test(name)) { sendJson(req, res, 400, { ok: false, error: 'only .zip packages can be uploaded' }); return true; }
      let buf;
      try { buf = await readBody(req, MAX_UPLOAD_BYTES); }
      catch (e) { sendJson(req, res, e && e.code === 'TOO_LARGE' ? 413 : 400, { ok: false, error: e.message }); return true; }
      const out = await mods.installZip(name, buf);
      log.info?.(`[mods] upload ${name}: ${out.ok ? `installed as mods/${out.folder || out.id}` : 'failed: ' + out.error}`);
      sendJson(req, res, out.ok ? 200 : 400, out);
      return true;
    }
    const m = /^(enable|disable|remove|reload)\/(.+)$/.exec(sub);
    if (m) {
      if (!isPost) { sendError(req, res, 405, '需要 POST · POST required'); return true; }
      const id = decodeURIComponent(m[2]);
      let out;
      if (m[1] === 'remove') out = await mods.remove(id);
      else if (m[1] === 'reload') out = await mods.scan().then(() => ({ ok: true }));
      else out = await mods.enable(id, m[1] === 'enable');
      sendJson(req, res, out.ok ? 200 : 400, out);
      return true;
    }
    sendJson(req, res, 404, { ok: false, error: `unknown mods endpoint: ${sub}` });
    return true;
  };
}

function safe(fn) {
  try { return fn(); } catch { return null; }
}
