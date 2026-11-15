/**
 * src/core.js
 * Router + pembentuk respons HTTP. Dipakai bersama oleh adapter
 * Cloudflare Worker, Vercel, dan server Node lokal.
 */

import { buildFeed, FeedError, clampInt, VERSION } from './feed.js';
import { buildRss, buildJsonFeed } from './render.js';

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, HEAD, OPTIONS',
  'access-control-allow-headers': '*',
  'access-control-expose-headers': 'x-feed-source, x-feed-items, x-feed-ms, x-feed-target',
};

const DEFAULT_TTL = 900;

function json(data, status, extraHeaders) {
  return new Response(JSON.stringify(data, null, 2), {
    status: status || 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...CORS,
      ...(extraHeaders || {}),
    },
  });
}

function normalizeXmlDeclaration(xml) {
  return String(xml)
    .replace(/^\uFEFF/, '')
    .replace(/^(<\?xml[^>]*?encoding\s*=\s*)(["'])[^"']*\2/i, '$1$2UTF-8$2');
}

function readOptions(url) {
  const q = url.searchParams;
  return {
    target: q.get('url') || q.get('u') || q.get('q') || '',
    limit: clampInt(q.get('limit'), 20, 1, 100),
    ttl: clampInt(q.get('ttl'), DEFAULT_TTL, 60, 86400),
    filter: (q.get('filter') || q.get('contains') || '').slice(0, 120),
    mode: q.get('mode') || 'auto',
    nocache: q.get('nocache') === '1' || q.get('nocache') === 'true',
  };
}

function feedUrlFor(requestUrl, target, opts, format) {
  const u = new URL(requestUrl);
  const path = format === 'json' ? '/feed.json' : '/feed';
  const p = new URLSearchParams();
  p.set('url', target);
  if (opts.limit !== 20) p.set('limit', String(opts.limit));
  if (opts.ttl !== DEFAULT_TTL) p.set('ttl', String(opts.ttl));
  if (opts.filter) p.set('filter', opts.filter);
  if (opts.mode && opts.mode !== 'auto') p.set('mode', opts.mode);
  return u.origin + path + '?' + p.toString();
}

function errorResponse(err, target) {
  const isFeedError = err instanceof FeedError;
  const status = isFeedError ? err.status : 500;
  return json({
    ok: false,
    error: isFeedError ? err.message : 'Terjadi kesalahan internal: ' + (err && err.message ? err.message : 'unknown'),
    hint: isFeedError ? err.hint : 'Coba lagi beberapa saat lagi.',
    target: (isFeedError && err.target) || target || '',
    tried: (isFeedError && err.tried) || [],
    docs: 'https://github.com/',
  }, status);
}

/**
 * GET /feed  dan  GET /feed.json
 */
export async function serveFeed(request, deps) {
  const d = deps || {};
  const format = d.format === 'json' ? 'json' : 'rss';
  const url = new URL(request.url);
  const opts = readOptions(url);

  if (!opts.target) {
    return json({
      ok: false,
      error: 'Parameter "url" belum diisi.',
      contoh: '/feed?url=https://www.kompas.com',
      parameter: {
        url: 'wajib - halaman atau feed yang mau dijadikan RSS',
        limit: 'opsional - jumlah item (1-100, default 20)',
        ttl: 'opsional - detik cache di edge (60-86400, default 900)',
        filter: 'opsional - hanya item yang link/judulnya mengandung teks ini',
        mode: 'opsional - auto | html | feed',
        nocache: 'opsional - 1 untuk melewati cache',
      },
    }, 400);
  }

  const cacheKey = url.origin + '/__rss_cache?format=' + format
    + '&url=' + encodeURIComponent(opts.target)
    + '&limit=' + opts.limit
    + '&filter=' + encodeURIComponent(opts.filter)
    + '&mode=' + encodeURIComponent(opts.mode);

  if (!opts.nocache && d.cache) {
    try {
      const hit = await d.cache.match(cacheKey);
      if (hit) {
        const res = new Response(hit.body, hit);
        res.headers.set('x-cache', 'HIT');
        return res;
      }
    } catch { /* cache rusak, lanjut */ }
  }

  let result;
  try {
    result = await buildFeed(opts.target, {
      limit: opts.limit,
      filter: opts.filter,
      mode: opts.mode,
      allowPrivate: !!d.allowPrivate,
    });
  } catch (err) {
    return errorResponse(err, opts.target);
  }

  const selfUrl = feedUrlFor(request.url, opts.target, opts, format);
  let body;
  let contentType;
  if (format === 'json') {
    body = buildJsonFeed({ feed: result.feed, items: result.items, selfUrl, ttl: opts.ttl });
    contentType = 'application/feed+json; charset=utf-8';
  } else if (result.rawXml) {
    body = normalizeXmlDeclaration(result.rawXml);
    contentType = result.contentType === 'application/atom+xml'
      ? 'application/atom+xml; charset=utf-8'
      : 'application/rss+xml; charset=utf-8';
  } else {
    body = buildRss({ feed: result.feed, items: result.items, selfUrl, ttl: opts.ttl });
    contentType = 'application/rss+xml; charset=utf-8';
  }

  const headers = {
    'content-type': contentType,
    'cache-control': 'public, max-age=300, s-maxage=' + opts.ttl + ', stale-while-revalidate=600',
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, HEAD, OPTIONS',
    'access-control-expose-headers': 'x-feed-source, x-feed-items, x-feed-ms, x-feed-target',
    'x-robots-tag': 'noindex',
    'x-feed-source': result.source,
    'x-feed-items': String(result.items.length),
    'x-feed-ms': String(result.elapsedMs),
    'x-feed-target': encodeURIComponent(result.targetUrl),
    'x-feed-version': VERSION,
  };

  const res = new Response(request.method === 'HEAD' ? null : body, { status: 200, headers });

  if (!opts.nocache && d.cache) {
    try {
      await d.cache.put(cacheKey, new Response(body, { status: 200, headers }));
    } catch { /* tidak fatal */ }
  }
  return res;
}

/**
 * GET /api/preview  -> JSON berisi item yang berhasil diekstrak (untuk UI)
 */
export async function servePreview(request, deps) {
  const d = deps || {};
  const url = new URL(request.url);
  const opts = readOptions(url);
  if (!opts.target) return json({ ok: false, error: 'Parameter "url" belum diisi.' }, 400);

  try {
    const result = await buildFeed(opts.target, {
      limit: opts.limit,
      filter: opts.filter,
      mode: opts.mode,
      allowPrivate: !!d.allowPrivate,
    });
    return json({
      ok: true,
      source: result.source,
      sourceUrl: result.sourceUrl,
      targetUrl: result.targetUrl,
      elapsedMs: result.elapsedMs,
      feed: result.feed,
      warnings: result.warnings,
      feedUrl: feedUrlFor(request.url, opts.target, opts, 'rss'),
      jsonFeedUrl: feedUrlFor(request.url, opts.target, opts, 'json'),
      count: result.items.length,
      items: result.items.slice(0, 12),
    }, 200, { 'cache-control': 'no-store' });
  } catch (err) {
    return errorResponse(err, opts.target);
  }
}

/**
 * GET /api/discover -> hanya metadata + kandidat feed asli
 */
export async function serveDiscover(request, deps) {
  const d = deps || {};
  const url = new URL(request.url);
  const opts = readOptions(url);
  if (!opts.target) return json({ ok: false, error: 'Parameter "url" belum diisi.' }, 400);
  try {
    const result = await buildFeed(opts.target, {
      limit: 5,
      mode: opts.mode,
      allowPrivate: !!d.allowPrivate,
    });
    return json({
      ok: true,
      source: result.source,
      sourceUrl: result.sourceUrl,
      feed: result.feed,
      count: result.items.length,
      warnings: result.warnings,
    }, 200, { 'cache-control': 'no-store' });
  } catch (err) {
    return errorResponse(err, opts.target);
  }
}

/**
 * Router untuk adapter yang punya kontrol penuh atas path (Worker & server lokal).
 * Mengembalikan null kalau path bukan milik API (biar adapter menyajikan aset statis).
 */
export async function route(request, deps) {
  const d = deps || {};
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/{2,}/g, '/').replace(/\/+$/, '') || '/';

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: { ...CORS, 'access-control-max-age': '86400' } });
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return json({ ok: false, error: 'Gunakan GET.' }, 405, { allow: 'GET, HEAD, OPTIONS' });
  }

  if (path === '/healthz' || path === '/api/health') {
    return json({ ok: true, name: 'rss-anywhere', version: VERSION, time: new Date().toISOString() }, 200);
  }
  if (path === '/feed' || path === '/rss' || path === '/feed.xml' || path === '/rss.xml') {
    return serveFeed(request, { ...d, format: 'rss' });
  }
  if (path === '/feed.json' || path === '/rss.json') {
    return serveFeed(request, { ...d, format: 'json' });
  }
  if (path === '/api/preview' || path === '/preview') {
    return servePreview(request, d);
  }
  if (path === '/api/discover') {
    return serveDiscover(request, d);
  }
  return null;
}

export { CORS, json, DEFAULT_TTL, VERSION };
