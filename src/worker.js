/**
 * src/worker.js
 * Entry point Cloudflare Workers.
 * Deploy: npx wrangler deploy
 */

import { route } from './core.js';

function makeCache(ctx) {
  return {
    async match(key) {
      try {
        const hit = await caches.default.match(new Request(key, { method: 'GET' }));
        return hit || null;
      } catch {
        return null;
      }
    },
    async put(key, response) {
      const promise = caches.default.put(new Request(key, { method: 'GET' }), response);
      if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(promise.catch(() => {}));
      else await promise.catch(() => {});
    },
  };
}

export default {
  async fetch(request, env, ctx) {
    const res = await route(request, {
      cache: makeCache(ctx),
      allowPrivate: env && env.ALLOW_PRIVATE === '1',
    });
    if (res) return res;

    if (env && env.ASSETS) {
      const asset = await env.ASSETS.fetch(request);
      if (asset.status !== 404) return asset;
      const index = await env.ASSETS.fetch(new Request(new URL('/', request.url), request));
      if (index.status === 200) return index;
      return asset;
    }

    return new Response('RSS Anywhere - endpoint tidak dikenal. Coba /feed?url=https://example.com', {
      status: 404,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    });
  },
};
