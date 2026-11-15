/**
 * src/feed.js
 * Lapisan jaringan: ambil halaman, cari feed asli, ekstrak artikel, fallback sitemap.
 * Hanya memakai Web API standar (fetch, TextDecoder, AbortController) sehingga
 * jalan di Cloudflare Workers, Vercel, Deno, dan Node 18+.
 */

import {
  parseHtml, extractFromRoot, parseDate, norm, textOf, firstOf, findAll, titleFromUrl, stripHash,
  decodeEntities, readMeta,
} from './html.js';
import { itemsFromJsonFeed } from './render.js';

export const VERSION = '1.0.0';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const MAX_BYTES = 3 * 1024 * 1024;

export class FeedError extends Error {
  constructor(message, details) {
    super(message);
    this.name = 'FeedError';
    const d = details || {};
    this.status = d.status || 422;
    this.hint = d.hint || '';
    this.tried = d.tried || [];
    this.target = d.target || '';
  }
}

/* ------------------------------------------------------------------ */
/* Util                                                                */
/* ------------------------------------------------------------------ */

export function clampInt(value, fallback, min, max) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** "example.com" -> "https://example.com/" */
export function normalizeTargetUrl(raw) {
  let s = String(raw || '').trim();
  if (!s) throw new FeedError('Parameter "url" wajib diisi.', { status: 400 });
  if (s.length > 2048) throw new FeedError('URL terlalu panjang.', { status: 400 });
  if (s.startsWith('//')) s = 'https:' + s;
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(s)) s = 'https://' + s;
  let u;
  try {
    u = new URL(s);
  } catch {
    throw new FeedError('URL tidak valid: ' + raw, { status: 400 });
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new FeedError('Hanya URL http/https yang didukung.', { status: 400 });
  }
  u.hash = '';
  return u.href;
}

const BLOCKED_HOSTS = new Set([
  'localhost', 'localhost.localdomain', 'ip6-localhost', 'ip6-loopback',
  'metadata.google.internal', 'metadata.goog', 'instance-data',
]);

function isPrivateIPv4(host) {
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true; // link-local + cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a >= 224) return true; // multicast / reserved
  return false;
}

/** Cegah SSRF: tolak localhost, IP privat, dan hostname internal. */
export function assertSafeUrl(raw, allowPrivate) {
  let u;
  try { u = new URL(raw); } catch {
    throw new FeedError('URL tidak valid.', { status: 400 });
  }
  if (allowPrivate) return u;
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (BLOCKED_HOSTS.has(host) || host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.home.arpa')) {
    throw new FeedError('Host internal tidak diizinkan.', { status: 400, hint: 'Gunakan domain publik.' });
  }
  if (isPrivateIPv4(host)) {
    throw new FeedError('Alamat IP privat tidak diizinkan.', { status: 400 });
  }
  if (host.includes(':') && /^(fc|fd|fe80|::1|::ffff:)/i.test(host)) {
    throw new FeedError('Alamat IPv6 privat tidak diizinkan.', { status: 400 });
  }
  return u;
}

function decodeBytes(bytes, contentType, peekText) {
  let charset = '';
  const m = /charset\s*=\s*["']?([\w-]+)/i.exec(contentType || '');
  if (m) charset = m[1];
  if (!charset) {
    const head = peekText || new TextDecoder('windows-1252').decode(bytes.subarray(0, 4096));
    const mm = /<meta[^>]+charset\s*=\s*["']?([\w-]+)/i.exec(head)
      || /<\?xml[^>]+encoding\s*=\s*["']([\w-]+)/i.exec(head);
    if (mm) charset = mm[1];
  }
  const candidates = [charset, 'utf-8', 'windows-1252'].filter(Boolean);
  for (const cs of candidates) {
    try {
      return new TextDecoder(cs, { fatal: false }).decode(bytes);
    } catch { /* coba berikutnya */ }
  }
  return new TextDecoder('utf-8').decode(bytes);
}

async function readLimited(response, maxBytes) {
  const len = Number(response.headers.get('content-length') || 0);
  if (len && len > maxBytes * 4) {
    // Terlalu besar; tetap baca sebagian kecil saja.
  }
  if (!response.body || typeof response.body.getReader !== 'function') {
    const ab = await response.arrayBuffer();
    const u8 = new Uint8Array(ab);
    return { bytes: u8.length > maxBytes ? u8.subarray(0, maxBytes) : u8, truncated: u8.length > maxBytes };
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  let truncated = false;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    chunks.push(value);
    total += value.byteLength;
    if (total > maxBytes) { truncated = true; break; }
  }
  if (truncated) { try { await reader.cancel(); } catch { /* ignore */ } }
  const out = new Uint8Array(Math.min(total, maxBytes));
  let off = 0;
  for (const c of chunks) {
    if (off >= out.length) break;
    const slice = c.byteLength > out.length - off ? c.subarray(0, out.length - off) : c;
    out.set(slice, off);
    off += slice.byteLength;
  }
  return { bytes: out, truncated };
}

/**
 * fetch dengan validasi SSRF, batas ukuran, batas waktu, dan redirect manual.
 */
export async function fetchDoc(target, options) {
  const opts = options || {};
  const timeout = clampInt(opts.timeout, 12000, 2000, 30000);
  const maxBytes = opts.maxBytes || MAX_BYTES;
  const allowPrivate = !!opts.allowPrivate;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    let current = target;
    let res = null;
    for (let hop = 0; hop <= 4; hop++) {
      assertSafeUrl(current, allowPrivate);
      res = await fetch(current, {
        method: 'GET',
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          'user-agent': opts.userAgent || UA,
          accept: opts.accept || 'text/html,application/xhtml+xml,application/xml;q=0.9,application/rss+xml;q=0.9,application/atom+xml;q=0.9,*/*;q=0.8',
          'accept-language': 'id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7',
          'cache-control': 'no-cache',
        },
      });
      const status = res.status;
      const loc = res.headers.get('location');
      if (status >= 300 && status < 400 && loc) {
        if (res.body) { try { await res.body.cancel(); } catch { /* ignore */ } }
        current = new URL(loc, current).href;
        continue;
      }
      break;
    }

    if (!res) throw new FeedError('Tidak ada respons dari sumber.', { status: 502 });

    const contentType = (res.headers.get('content-type') || '').toLowerCase();
    const { bytes, truncated } = await readLimited(res, maxBytes);
    const text = decodeBytes(bytes, contentType);

    return {
      requestedUrl: target,
      finalUrl: res.url || target,
      status: res.status,
      ok: res.ok,
      contentType,
      text,
      truncated,
      bytes: bytes.byteLength,
    };
  } catch (err) {
    if (err && err.name === 'AbortError') {
      throw new FeedError('Sumber tidak merespons dalam ' + Math.round(timeout / 1000) + ' detik.', {
        status: 504,
        hint: 'Coba lagi, atau naikkan parameter timeout.',
      });
    }
    if (err instanceof FeedError) throw err;
    throw new FeedError('Gagal mengambil halaman: ' + (err && err.message ? err.message : 'error jaringan'), {
      status: 502,
      hint: 'Pastikan URL bisa dibuka di browser dari jaringan publik.',
    });
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------------------------------------------ */
/* Deteksi feed                                                        */
/* ------------------------------------------------------------------ */

export function looksLikeFeed(contentType, text) {
  const ct = String(contentType || '').toLowerCase();
  const head = String(text || '').slice(0, 2000).replace(/^\uFEFF/, '').trimStart();

  if (/json/.test(ct) || (head.startsWith('{') && !/<html/i.test(head))) {
    try {
      const j = JSON.parse(text);
      if (j && typeof j === 'object' && j.version && Array.isArray(j.items)) return 'json';
    } catch { /* bukan JSON feed */ }
  }
  if (head.startsWith('{')) {
    try {
      const j = JSON.parse(text);
      if (j && j.version && Array.isArray(j.items)) return 'json';
    } catch { /* ignore */ }
  }
  if (/^<\?xml|^<rss[\s>]|^<feed[\s>]|^<rdf:RDF/i.test(head)) {
    if (/<rss[\s>]|<feed[\s>]|<\?xml[\s\S]{0,200}<rss/i.test(head) || /<feed[\s>]/i.test(head) || /<rdf:RDF/i.test(head)) {
      return 'xml';
    }
  }
  if (/rss\+xml|atom\+xml/.test(ct) && /<rss[\s>]|<feed[\s>]/i.test(text.slice(0, 8000))) return 'xml';
  return '';
}

function countFeedItems(xml) {
  const m = String(xml).match(/<item[\s>]|<entry[\s>]/gi);
  return m ? m.length : 0;
}

function childNode(node, tag) {
  if (!node || !node.children) return null;
  const want = String(tag).toLowerCase();
  for (const c of node.children) if (c.tag === want) return c;
  return null;
}

function childText(node, tags) {
  for (const t of tags) {
    const c = childNode(node, t);
    if (!c) continue;
    const s = textOf(c);
    if (s) return s;
  }
  return '';
}

function stripTags(s) {
  return norm(String(s || '').replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<[^>]+>/g, ' '));
}

/** Beberapa feed menulis entity dua kali (&amp;#8212;) — rapikan sekali lagi. */
function cleanFeedText(s) {
  return decodeEntities(stripTags(s));
}

/** Parse feed XML (RSS 2.0 / Atom / RDF) jadi struktur internal. */
export function parseFeedXml(xml, limit) {
  const root = parseHtml(xml, { xml: true });
  const channel = firstOf(root, (n) => n.tag === 'channel');
  const atomFeed = firstOf(root, (n) => n.tag === 'feed');
  const container = channel || atomFeed || root;

  const linkEls = findAll(container, (n) => n.tag === 'link');
  let siteLink = '';
  for (const l of linkEls) {
    const rel = (l.attrs && l.attrs.rel) || '';
    const href = (l.attrs && l.attrs.href) || '';
    const txt = textOf(l);
    if (rel === 'self') continue;
    if (!siteLink && rel === 'alternate' && href) siteLink = href;
    if (!siteLink && txt && /^https?:/i.test(txt)) siteLink = txt;
  }

  const nodes = findAll(root, (n) => n.tag === 'item' || n.tag === 'entry');
  const items = [];
  for (const n of nodes) {
    let link = childText(n, ['link']);
    if (!link) {
      const l = findAll(n, (x) => x.tag === 'link' && x.attrs && x.attrs.href)[0];
      if (l) link = l.attrs.href;
    }
    if (!link) link = childText(n, ['guid', 'id']);
    if (!link || !/^https?:/i.test(link.trim())) continue;

    const title = childText(n, ['title']) || titleFromUrl(link);
    let summary = childText(n, ['description', 'summary']);
    if (!summary) summary = childText(n, ['encoded', 'content']);
    summary = cleanFeedText(summary).slice(0, 500);

    const rawDate = childText(n, ['pubDate', 'published', 'updated', 'date'])
      || childText(n, ['date']);
    const d = rawDate ? parseDate(rawDate) : null;

    let image = '';
    const enclosure = firstOf(n, (x) => x.tag === 'enclosure' && x.attrs && /image/i.test(x.attrs.type || ''));
    if (enclosure) image = enclosure.attrs.url || '';
    if (!image) {
      const media = firstOf(n, (x) => x.tag === 'content' && x.attrs && x.attrs.url && /image/i.test(x.attrs.medium || 'image'));
      if (media) image = media.attrs.url;
    }

    items.push({
      title: norm(title),
      link: link.trim(),
      summary,
      date: d ? d.toISOString() : '',
      image,
    });
    if (limit && items.length >= limit) break;
  }

  return {
    feed: {
      title: cleanFeedText(childText(container, ['title'])),
      description: cleanFeedText(childText(container, ['description', 'subtitle', 'tagline'])),
      link: siteLink || '',
      icon: (function () {
        const ic = firstOf(container, (x) => x.tag === 'icon' || (x.tag === 'image' && x.attrs && x.attrs.href));
        if (ic) return ic.tag === 'icon' ? textOf(ic) : (ic.attrs.href || '');
        const img = firstOf(container, (x) => x.tag === 'url');
        return img ? textOf(img) : '';
      })(),
      language: childText(container, ['language', 'dc:language']),
      siteName: childText(container, ['title']) || '',
    },
    items,
  };
}

/* ------------------------------------------------------------------ */
/* Probing & fallback                                                  */
/* ------------------------------------------------------------------ */

const COMMON_PATHS = [
  '/feed', '/rss', '/feed.xml', '/rss.xml', '/atom.xml', '/index.xml',
  '/feed/', '/rss/', '/?feed=rss2', '/feeds/posts/default?alt=rss',
  '/feed.json', '/news/feed', '/blog/feed', '/blog/rss.xml',
];

async function probeOne(url, timeout, allowPrivate) {
  try {
    const doc = await fetchDoc(url, { timeout, maxBytes: 900 * 1024, allowPrivate, accept: 'application/rss+xml,application/atom+xml,application/xml;q=0.9,application/json;q=0.8,text/xml;q=0.9' });
    if (doc.status >= 400) return null;
    const kind = looksLikeFeed(doc.contentType, doc.text);
    if (kind === 'xml' && countFeedItems(doc.text) > 0) {
      return { url: doc.finalUrl, kind, text: doc.text, items: countFeedItems(doc.text) };
    }
    if (kind === 'json') {
      try {
        const j = JSON.parse(doc.text);
        if (Array.isArray(j.items) && j.items.length) return { url: doc.finalUrl, kind: 'json', text: doc.text, items: j.items.length };
      } catch { /* ignore */ }
    }
  } catch { /* diamkan, lanjut kandidat berikutnya */ }
  return null;
}

async function probeCommonFeeds(pageUrl, deadline, allowPrivate) {
  const origin = new URL(pageUrl).origin;
  const seen = new Set();
  const candidates = [];
  for (const p of COMMON_PATHS) {
    const abs = new URL(p, origin).href;
    if (seen.has(abs)) continue;
    seen.add(abs);
    candidates.push(abs);
  }
  // Kalau halaman ada di sub-path (mis. /blog), coba juga di bawah path itu.
  try {
    const u = new URL(pageUrl);
    const segs = u.pathname.split('/').filter(Boolean);
    if (segs.length) {
      const basePath = '/' + segs.slice(0, 1).join('/') + '/';
      for (const p of ['feed', 'rss', 'rss.xml', 'feed.xml', 'atom.xml', 'index.xml']) {
        const abs = new URL(basePath + p, origin).href;
        if (!seen.has(abs)) { seen.add(abs); candidates.push(abs); }
      }
    }
  } catch { /* ignore */ }

  for (let i = 0; i < candidates.length; i += 4) {
    if (Date.now() > deadline) break;
    const batch = candidates.slice(i, i + 4);
    const results = await Promise.allSettled(batch.map((u) => probeOne(u, 5000, allowPrivate)));
    for (const r of results) {
      if (r.status === 'fulfilled' && r.value) return r.value;
    }
  }
  return null;
}

function sitemapToItems(xml, pageUrl, limit) {
  const pageHost = (() => { try { return new URL(pageUrl).hostname; } catch { return ''; } })();
  const blocks = String(xml).split(/<\/url>/i);
  const rows = [];
  for (const b of blocks) {
    const loc = /<loc>\s*(?:<!\[CDATA\[)?\s*([^<\s]+)/i.exec(b);
    if (!loc) continue;
    let href;
    try { href = new URL(loc[1].trim(), pageUrl).href; } catch { continue; }
    try {
      const u = new URL(href);
      if (pageHost && u.hostname !== pageHost) continue;
      if (u.pathname.split('/').filter(Boolean).length === 0) continue;
      if (/\/(tag|category|kategori|author|page|search|topik|feed|rss)\//i.test(u.pathname)) continue;
    } catch { continue; }
    const lastmod = /<lastmod>\s*([^<]+)/i.exec(b);
    const d = lastmod ? parseDate(lastmod[1].trim()) : null;
    rows.push({ href, date: d ? d.toISOString() : '', ts: d ? d.getTime() : 0 });
  }
  // Kalau ada lastmod, tampilkan yang terbaru dulu.
  if (rows.some((r) => r.ts)) rows.sort((a, b) => b.ts - a.ts);
  const seen = new Set();
  const items = [];
  for (const r of rows) {
    const k = stripHash(r.href).toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    items.push({ title: titleFromUrl(r.href), link: r.href, summary: '', date: r.date, image: '' });
    if (items.length >= limit) break;
  }
  if (items.length && !items.some((i) => i.date)) items[0].summary = '';
  return items;
}

async function trySitemap(pageUrl, limit, allowPrivate, warnings) {
  const origin = new URL(pageUrl).origin;
  const paths = ['/sitemap.xml', '/sitemap_index.xml', '/sitemap-index.xml', '/wp-sitemap.xml', '/news-sitemap.xml'];
  for (const p of paths) {
    try {
      const doc = await fetchDoc(new URL(p, origin).href, { timeout: 7000, maxBytes: 3 * 1024 * 1024, allowPrivate });
      if (doc.status >= 400 || !doc.text) continue;
      const text = doc.text;
      if (/<sitemapindex[\s>]/i.test(text.slice(0, 3000))) {
        const locs = [...text.matchAll(/<loc>\s*(?:<!\[CDATA\[)?\s*([^<\s]+)/gi)].map((m) => m[1].trim());
        for (const child of locs.slice(0, 3)) {
          try {
            const sub = await fetchDoc(child, { timeout: 7000, maxBytes: 3 * 1024 * 1024, allowPrivate });
            if (sub.status >= 400) continue;
            const items = sitemapToItems(sub.text, pageUrl, limit);
            if (items.length) return items;
          } catch { /* lanjut */ }
        }
        continue;
      }
      if (/<urlset[\s>]/i.test(text.slice(0, 3000))) {
        const items = sitemapToItems(text, pageUrl, limit);
        if (items.length) {
          warnings.push('Daftar artikel diambil dari sitemap.xml; judul dibentuk dari URL.');
          return items;
        }
      }
    } catch { /* coba path berikutnya */ }
  }
  return [];
}

/* ------------------------------------------------------------------ */
/* Orchestrator                                                        */
/* ------------------------------------------------------------------ */

/**
 * @returns {Promise<{
 *   source: 'native'|'native-json'|'html'|'sitemap',
 *   sourceUrl: string,
 *   targetUrl: string,
 *   feed: object,
 *   items: Array,
 *   rawXml?: string,
 *   contentType: string,
 *   warnings: string[],
 *   elapsedMs: number,
 * }>}
 */
export async function buildFeed(target, options) {
  const started = Date.now();
  const opts = options || {};
  const limit = clampInt(opts.limit, 20, 1, 100);
  const mode = opts.mode === 'html' || opts.mode === 'feed' ? opts.mode : 'auto';
  const filter = String(opts.filter || '').slice(0, 120);
  const timeout = clampInt(opts.timeout, 10000, 3000, 30000);
  const allowPrivate = !!opts.allowPrivate;
  const warnings = [];

  const pageUrl = normalizeTargetUrl(target);
  assertSafeUrl(pageUrl, allowPrivate);

  const doc = await fetchDoc(pageUrl, { timeout, maxBytes: MAX_BYTES, allowPrivate });

  if (doc.status === 401 || doc.status === 403) {
    throw new FeedError('Sumber menolak akses (HTTP ' + doc.status + ').', {
      status: 502,
      target: pageUrl,
      hint: 'Situs ini memblokir akses otomatis (bot protection). Coba URL halaman lain, atau pakai RSS-Bridge.',
    });
  }
  if (doc.status === 405) {
    throw new FeedError('Sumber menolak permintaan (HTTP 405).', {
      status: 502,
      target: pageUrl,
      hint: 'Sebagian situs memblokir akses dari jaringan server/datacenter. Coba lewat RSS-Bridge atau situs lain.',
    });
  }
  if (doc.status === 429) {
    throw new FeedError('Sumber membatasi jumlah permintaan (HTTP 429).', {
      status: 429,
      target: pageUrl,
      hint: 'Tunggu beberapa menit lalu coba lagi.',
    });
  }
  if (doc.status === 404 || doc.status === 410) {
    throw new FeedError('Halaman tidak ditemukan (HTTP ' + doc.status + ').', { status: 404, target: pageUrl });
  }
  if (doc.status >= 400) {
    throw new FeedError('Sumber membalas HTTP ' + doc.status + '.', { status: 502, target: pageUrl });
  }
  if (/^(image|video|audio|font)\/|application\/(pdf|zip|octet-stream)/i.test(doc.contentType)) {
    throw new FeedError('URL itu bukan halaman web (' + doc.contentType + ').', { status: 422, target: pageUrl });
  }

  // 1) URL yang diberikan ternyata sudah feed
  if (mode !== 'html') {
    const kind = looksLikeFeed(doc.contentType, doc.text);
    if (kind === 'xml') {
      const parsed = parseFeedXml(doc.text, limit);
      if (parsed.items.length) {
        return {
          source: 'native',
          sourceUrl: doc.finalUrl,
          targetUrl: pageUrl,
          feed: normalizeFeedMeta(parsed.feed, doc.finalUrl, pageUrl),
          items: parsed.items,
          rawXml: doc.text,
          contentType: /<feed[\s>]/i.test(doc.text.slice(0, 1200)) ? 'application/atom+xml' : 'application/rss+xml',
          warnings,
          elapsedMs: Date.now() - started,
        };
      }
    }
    if (kind === 'json') {
      try {
        const data = JSON.parse(doc.text);
        const parsed = itemsFromJsonFeed(data, doc.finalUrl);
        if (parsed.items.length) {
          return {
            source: 'native-json',
            sourceUrl: doc.finalUrl,
            targetUrl: pageUrl,
            feed: normalizeFeedMeta(parsed.feed, doc.finalUrl, pageUrl),
            items: parsed.items.slice(0, limit),
            contentType: 'application/feed+json',
            warnings,
            elapsedMs: Date.now() - started,
          };
        }
      } catch { /* jatuh ke HTML */ }
    }
  }

  if (mode === 'feed') {
    throw new FeedError('URL tersebut bukan feed RSS/Atom/JSON yang valid.', {
      status: 422,
      target: pageUrl,
      hint: 'Hapus parameter mode=feed untuk mengekstrak otomatis dari HTML.',
    });
  }

  // 2) Parse sekali, pakai untuk discovery + ekstraksi
  const root = parseHtml(doc.text);
  const pageMeta = readMeta(root, doc.finalUrl);

  if (mode !== 'html' && pageMeta.feedLinks.length) {
    const tried = [];
    for (const fl of pageMeta.feedLinks.slice(0, 3)) {
      tried.push(fl.href);
      try {
        const fd = await fetchDoc(fl.href, { timeout: 8000, maxBytes: 2 * 1024 * 1024, allowPrivate });
        if (fd.status >= 400) continue;
        const kind = looksLikeFeed(fd.contentType, fd.text);
        if (kind === 'xml' && countFeedItems(fd.text) > 0) {
          const parsed = parseFeedXml(fd.text, limit);
          return {
            source: 'native',
            sourceUrl: fd.finalUrl,
            targetUrl: pageUrl,
            feed: normalizeFeedMeta(parsed.feed, fd.finalUrl, pageUrl),
            items: parsed.items,
            rawXml: fd.text,
            contentType: /<feed[\s>]/i.test(fd.text.slice(0, 1200)) ? 'application/atom+xml' : 'application/rss+xml',
            warnings,
            elapsedMs: Date.now() - started,
          };
        }
        if (kind === 'json') {
          const data = JSON.parse(fd.text);
          const parsed = itemsFromJsonFeed(data, fd.finalUrl);
          if (parsed.items.length) {
            return {
              source: 'native-json',
              sourceUrl: fd.finalUrl,
              targetUrl: pageUrl,
              feed: normalizeFeedMeta(parsed.feed, fd.finalUrl, pageUrl),
              items: parsed.items.slice(0, limit),
              contentType: 'application/feed+json',
              warnings,
              elapsedMs: Date.now() - started,
            };
          }
        }
      } catch { /* lanjut */ }
    }
  }

  // 3) Tebak path feed umum
  if (mode !== 'html') {
    const deadline = Date.now() + Math.min(7000, Math.max(2500, timeout / 2));
    const hit = await probeCommonFeeds(doc.finalUrl, deadline, allowPrivate);
    if (hit) {
      warnings.push('Feed asli ditemukan di ' + new URL(hit.url).pathname);
      const parsed = hit.kind === 'json'
        ? itemsFromJsonFeed(JSON.parse(hit.text), hit.url)
        : parseFeedXml(hit.text, limit);
      if (parsed.items.length) {
        return {
          source: hit.kind === 'json' ? 'native-json' : 'native',
          sourceUrl: hit.url,
          targetUrl: pageUrl,
          feed: normalizeFeedMeta(parsed.feed, hit.url, pageUrl, pageMeta),
          items: parsed.items.slice(0, limit),
          rawXml: hit.kind === 'xml' ? hit.text : undefined,
          contentType: hit.kind === 'json' ? 'application/feed+json' : 'application/rss+xml',
          warnings,
          elapsedMs: Date.now() - started,
        };
      }
    }
  }

  // 4) Ekstraksi dari HTML
  let extracted = extractFromRoot(root, doc.finalUrl, { limit, filter, now: Date.now() });
  let source = 'html';
  let items = extracted.items;
  if (extracted.warnings.length) warnings.push(...extracted.warnings);

  // 5) Fallback sitemap bila hasil ekstraksi sedikit (dan waktu masih cukup)
  if (items.length < 3 && Date.now() - started < 18000) {
    const smItems = await trySitemap(doc.finalUrl, limit, allowPrivate, warnings);
    if (smItems.length > items.length) {
      items = smItems;
      source = 'sitemap';
      warnings.push('HTML tidak menghasilkan cukup artikel; memakai sitemap sebagai gantinya.');
    }
  }

  return {
    source,
    sourceUrl: doc.finalUrl,
    targetUrl: pageUrl,
    feed: {
      title: extracted.meta.title || extracted.meta.siteName || new URL(doc.finalUrl).hostname,
      description: extracted.meta.description || '',
      link: doc.finalUrl,
      icon: extracted.meta.icon || (new URL(doc.finalUrl).origin + '/favicon.ico'),
      image: extracted.meta.image || '',
      language: extracted.meta.language || 'id',
      siteName: extracted.meta.siteName || extracted.meta.title || '',
    },
    items,
    contentType: 'text/html',
    warnings: dedupe(warnings),
    elapsedMs: Date.now() - started,
  };
}

function dedupe(arr) {
  return [...new Set(arr.filter(Boolean))];
}

function normalizeFeedMeta(feed, feedUrl, pageUrl, fallbackMeta) {
  const host = (() => { try { return new URL(pageUrl).hostname.replace(/^www\./, ''); } catch { return pageUrl; } })();
  const fb = fallbackMeta || {};
  return {
    title: norm(feed.title) || norm(fb.title) || host,
    description: norm(feed.description) || norm(fb.description) || ('Feed untuk ' + host),
    link: feed.link || pageUrl,
    icon: feed.icon || fb.icon || '',
    image: fb.image || '',
    language: norm(feed.language) || norm(fb.language) || 'id',
    siteName: norm(feed.siteName) || norm(fb.siteName) || host,
  };
}
