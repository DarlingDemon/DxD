// SPDX-License-Identifier: AGPL-3.0-or-later
'use strict';

// The two named DxD wallpapers have fixed instance routes. Other images use the
// existing signed media proxy. Only the resolver receives the session headers.
function createBetterDiscordWallpaperResolver({converter, http, getOrigin, fetchImage = globalThis.fetch}) {
  return async function resolveWallpaper(url, signal) {
    const origin = getOrigin();
    const deadline = AbortSignal.timeout(25_000);
    const request = signal ? AbortSignal.any([signal, deadline]) : deadline;
    const knownUrl = converter.resolveImportWallpaper(url, origin);
    const knownImage = await converter.downloadKnownThemeWallpaper(knownUrl, origin, request, fetchImage)
      .catch(() => {request.throwIfAborted(); return null;});
    const image = knownImage ?? await converter.downloadThemeWallpaper(url, origin, async (source, sourceSignal) => {
      const response = await http.post('/users/@me/favorite-gifs/resolve', {
        body: {urls: [source]}, signal: sourceSignal, timeoutMs: 20_000, retries: 0,
        mode: 'silent', suppressContentBlockedModal: true,
      });
      return response.body?.entries?.[0]?.proxy_url ?? '';
    }, request, fetchImage);
    const result = await converter.prepareThemeWallpaper(image);
    request.throwIfAborted();
    return result;
  };
}

module.exports = {createBetterDiscordWallpaperResolver};
