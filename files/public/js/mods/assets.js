// public/js/mods/assets.js — the art surface of the mod API (`api.assets`).
//
// WHY IT EXISTS
//   The page resolves every operator asset through the manifest `/data/assets.json`: `chars[<charId>]` holds the avatar,
//   the half-body portrait and the Spine URLs. That manifest is built from the game's own asset dump and is NOT one of
//   the content tables a package may declare, so a pack that adds a `chess` record had no way to give it art — the unit
//   was drawn as an image-less placeholder.
//
//   `registerChars(provider)` closes that hole: the provider returns manifest entries keyed by asset id, and the game's
//   asset store merges them under the real manifest (`public/js/assets.js` `setModAssetProvider` — the one seam the
//   installer adds there). Entries the game already has always win, and a provider may return `null` while its own data
//   is not ready — it is asked again on every lookup.
//
//   Registrations are collected into the API's `registered.assets` list, so `dropApi` (a failed install, or a package
//   disabled at runtime) takes the art out again with everything else.

/**
 * Build the asset surface for one package.
 * @param {object} rec the `/api/mods` record
 * @param {{ assets: Array<() => void> }} registered the API's registration ledger
 * @returns {object} `api.assets`
 */
export function makeAssets(rec, registered) {
  const modId = rec.id;
  const tag = `[mod:${modId}]`;

  return {
    /**
     * Contribute operator art: `{ chars: { <assetId>: { avatar, portrait, spine } } }`, i.e. the shape of
     * `/data/assets.json`. The provider is called lazily, so it may return `null` until its data is ready.
     *
     * @param {() => (Record<string, any>|null|undefined)} provider
     * @returns {() => void} unregister
     */
    registerChars(provider) {
      if (typeof provider !== 'function') throw new TypeError('api.assets.registerChars expects a function');
      const state = { off: null, dropped: false };
      const drop = () => {
        state.dropped = true;
        if (state.off) { try { state.off(); } catch { /* already gone */ } state.off = null; }
      };
      registered.assets.push(drop);
      // the store is imported lazily: a build whose field view never mounts should not pull it in
      import('../assets.js').then((m) => {
        if (state.dropped) return;
        if (typeof m.setModAssetProvider !== 'function') {
          console.warn(`${tag} this build has no art seam (public/js/assets.js exports no setModAssetProvider): `
            + 'operator art shipped inside packages is unavailable');
          return;
        }
        state.off = m.setModAssetProvider(provider);
      }).catch((err) => console.warn(`${tag} art registration failed`, err));
      return drop;
    },

    /**
     * The URL of a file inside this package (`api.assets.url('assets/x.png')`) — what a manifest entry should point
     * at: `/mods/<package>/…`, served by the same static mount the entry itself came from.
     * @param {string} rel @returns {string}
     */
    url(rel) {
      const base = String(rec.url || `/mods/${modId}/`);
      return base.replace(/\/?$/, '/') + String(rel).replace(/^\/+/, '');
    },
  };
}
