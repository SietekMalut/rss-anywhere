/**
 * scripts/build-static.mjs
 * Membangun feed statis untuk GitHub Pages.
 *
 *   sources.json  ->  feeds/<id>.xml + feeds/<id>.json + feeds.json
 *                 ->  dist/ (siap di-upload sebagai artefak GitHub Pages)
 *
 * Cepat: sumber diambil paralel (BUILD_CONCURRENCY, default 8), jadi total waktu
 * mengikuti sumber terlama — bukan jumlah semua sumber. Karena itu build penuh
 * lebih cepat daripada menyalin feed lama satu per satu dari situs yang tayang.
 *
 * Valid: setiap dokumen diperiksa dengan src/validate.js sebelum ditulis.
 * Kalau XML asli dari situs ternyata tidak well-formed (mis. berisi &nbsp;
 * tanpa deklarasi entity), feed dirender ulang dari item hasil parsing.
 *
 * feeds/ hanya ada di dist/ dan di disk; folder itu tidak di-commit supaya
 * riwayat git tidak menggelembung.
 *
 * Dijalankan oleh .github/workflows/feeds.yml (tiap 30 menit / manual / issue baru),
 * tapi bisa juga dijalankan manual di lokal: node scripts/build-static.mjs
 */

import { readFile, writeFile, mkdir, rm, cp } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildFeed } from '../src/feed.js';
import { buildRss, buildJsonFeed } from '../src/render.js';
import { validateFeedXml, validateJsonFeed, validatePair } from '../src/validate.js';
import { feedId } from './lib/id.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const SOURCES_FILE = path.join(ROOT, 'sources.json');
const REGISTRY_FILE = path.join(ROOT, 'feeds.json');
const FEEDS_DIR = path.join(ROOT, 'feeds');
const PAGES_DIR = path.join(ROOT, 'pages');
const DIST_DIR = path.join(ROOT, 'dist');

const SITE_BASE = (process.env.SITE_BASE || 'https://sietekmalut.github.io/rss-anywhere/').replace(/\/*$/, '/');
const TTL_SECONDS = 1800;
const DEFAULT_LIMIT = 20;
const CONCURRENCY = clampInt(process.env.BUILD_CONCURRENCY, 8, 1, 24);

const abs = (p) => SITE_BASE + p;

function clampInt(value, fallback, min, max) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function normalizeXmlDeclaration(xml) {
  return String(xml)
    .replace(/^\uFEFF/, '')
    .replace(/^(<\?xml[^>]*?encoding\s*=\s*)(["'])[^"']*\2/i, '$1$2UTF-8$2');
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

/** Ambil file yang sedang tayang di GitHub Pages (untuk fallback / salin cepat). */
async function fetchPublished(name) {
  try {
    const res = await fetch(SITE_BASE + name + '?t=' + Date.now(), {
      headers: { 'user-agent': 'RSSAnywhere/1.0 (+' + SITE_BASE + ')' },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

/** Jalankan fn untuk semua item dengan batas paralel, hasil tetap urut. */
async function mapPool(items, limit, fn) {
  const out = new Array(items.length);
  let cursor = 0;
  const size = Math.max(1, Math.min(limit, items.length));
  const workers = [];
  for (let w = 0; w < size; w++) {
    workers.push((async () => {
      while (true) {
        const index = cursor++;
        if (index >= items.length) return;
        out[index] = await fn(items[index], index);
      }
    })());
  }
  await Promise.all(workers);
  return out;
}

/** XML final: pakai XML asli kalau valid, render ulang kalau tidak. */
function makeXml(result, selfUrl) {
  if (result.rawXml) {
    const raw = normalizeXmlDeclaration(result.rawXml);
    const checked = validateFeedXml(raw);
    if (checked.ok && checked.items > 0) return { xml: raw, mode: 'asli' };
    const rendered = buildRss({ feed: result.feed, items: result.items, selfUrl, ttl: TTL_SECONDS });
    return {
      xml: rendered,
      mode: 'render-ulang',
      note: 'XML asli tidak valid (' + (checked.errors[0] || 'tanpa item') + '); dirender ulang.',
    };
  }
  return { xml: buildRss({ feed: result.feed, items: result.items, selfUrl, ttl: TTL_SECONDS }), mode: 'render' };
}

/**
 * Salin feed yang sudah tayang untuk sumber yang tidak perlu dibangun ulang.
 * @returns {Promise<object|null>} entri registry, atau null kalau tidak bisa disalin
 */
async function copyPublished(id, rawUrl, previous, startedAt) {
  const [xml, json] = await Promise.all([
    fetchPublished('feeds/' + id + '.xml'),
    fetchPublished('feeds/' + id + '.json'),
  ]);
  if (!xml || !json) return null;

  const x = validateFeedXml(xml);
  const j = validateJsonFeed(json);
  if (!x.ok || !j.ok || x.items < 1 || j.items < 1) return null;

  await writeFile(path.join(FEEDS_DIR, id + '.xml'), xml, 'utf8');
  await writeFile(path.join(FEEDS_DIR, id + '.json'), json, 'utf8');

  const host = (() => { try { return new URL(rawUrl).hostname; } catch { return rawUrl; } })();
  return {
    feed: {
      id,
      url: rawUrl,
      title: (previous && previous.title) || x.title || host,
      siteUrl: (previous && previous.siteUrl) || rawUrl,
      count: (previous && previous.count) || x.items,
      source: (previous && previous.source) || 'native',
      feedUrl: abs('feeds/' + id + '.xml'),
      jsonUrl: abs('feeds/' + id + '.json'),
      bytes: Buffer.byteLength(xml, 'utf8'),
      validated: true,
      carried: true,
      updatedAt: (previous && previous.updatedAt) || new Date().toISOString(),
      elapsedMs: Date.now() - startedAt,
      error: null,
    },
    log: `  salin ${String(x.items).padStart(3)} item  ${rawUrl} (tidak dibangun ulang)`,
  };
}

async function buildOne(source, previousById) {
  const rawUrl = String(source.url || '').trim();
  let id;
  try {
    id = feedId(rawUrl);
  } catch {
    return { skip: true, log: `  skip  ${rawUrl} (URL tidak valid)` };
  }

  const limit = clampInt(source.limit, DEFAULT_LIMIT, 1, 100);
  const filter = String(source.filter || '').slice(0, 120);
  const mode = ['auto', 'html', 'feed'].includes(source.mode) ? source.mode : 'auto';
  const selfUrl = abs('feeds/' + id + '.xml');
  const jsonUrl = abs('feeds/' + id + '.json');
  const startedAt = Date.now();

  try {
    const result = await buildFeed(rawUrl, { limit, filter, mode });
    const { xml, mode: xmlMode, note } = makeXml(result, selfUrl);
    const json = buildJsonFeed({ feed: result.feed, items: result.items, selfUrl: jsonUrl, ttl: TTL_SECONDS });

    const check = xmlMode === 'asli'
      ? (() => {
        const x = validateFeedXml(xml);
        const j = validateJsonFeed(json);
        const errors = [...x.errors.map((e) => 'XML: ' + e), ...j.errors.map((e) => 'JSON: ' + e)];
        return { ok: errors.length === 0 && x.items > 0 && j.items > 0, errors };
      })()
      : validatePair(xml, json);

    if (!check.ok) {
      throw new Error('hasil build tidak valid: ' + check.errors.slice(0, 2).join('; '));
    }

    await writeFile(path.join(FEEDS_DIR, id + '.xml'), xml, 'utf8');
    await writeFile(path.join(FEEDS_DIR, id + '.json'), json, 'utf8');

    const entry = {
      id,
      url: rawUrl,
      title: result.feed.title || new URL(rawUrl).hostname,
      siteUrl: result.targetUrl || result.feed.link || rawUrl,
      count: result.items.length,
      source: result.source,
      feedUrl: selfUrl,
      jsonUrl,
      bytes: Buffer.byteLength(xml, 'utf8'),
      validated: true,
      updatedAt: new Date().toISOString(),
      elapsedMs: Date.now() - startedAt,
      error: null,
    };
    if (note) entry.note = note;

    return {
      feed: entry,
      log: `  ok    ${String(result.items.length).padStart(2)} item  ${result.source.padEnd(7)}  ${xmlMode.padEnd(12)} ${rawUrl}`,
    };
  } catch (err) {
    const message = String((err && err.message) || err).slice(0, 200);
    const old = previousById.get(id) || null;

    // Fallback: pakai file yang masih tayang di GitHub Pages supaya feed
    // tidak hilang hanya karena satu pengambilan gagal. Harus valid DAN berisi item.
    const carried = await copyPublished(id, rawUrl, old, startedAt);
    if (carried) {
      return {
        feed: { ...carried.feed, stale: true, error: message },
        log: `  gagal (pakai versi tayang terakhir)  ${rawUrl} - ${message}`,
      };
    }

    // Tidak ada file valid yang bisa disajikan: jangan mengiklankan link mati.
    return {
      feed: {
        id,
        url: rawUrl,
        title: (old && old.title) || new URL(rawUrl).hostname,
        siteUrl: (old && old.siteUrl) || rawUrl,
        count: 0,
        source: 'error',
        feedUrl: null,
        jsonUrl: null,
        validated: false,
        updatedAt: new Date().toISOString(),
        elapsedMs: Date.now() - startedAt,
        error: message,
        note: old && old.feedUrl ? 'Feed sebelumnya tidak lagi tersedia.' : undefined,
      },
      log: `  gagal  ${rawUrl} - ${message}`,
    };
  }
}

async function main() {
  const startedAt = Date.now();
  const sourcesDoc = await readJson(SOURCES_FILE, { sources: [] });
  const sources = (Array.isArray(sourcesDoc.sources) ? sourcesDoc.sources : [])
    .filter((s) => s && String(s.url || '').trim());
  const previous = await readJson(REGISTRY_FILE, { feeds: [] });
  const previousById = new Map((previous.feeds || []).map((f) => [f.id, f]));

  await mkdir(FEEDS_DIR, { recursive: true });

  const jobs = sources.map((source) => {
    const url = String(source.url || '').trim();
    let id = '';
    try { id = feedId(url); } catch { id = ''; }
    return { source, id, url };
  });

  console.log(`[build] ${jobs.length} sumber, paralel ${CONCURRENCY}, ${SITE_BASE}`);

  const results = await mapPool(jobs, CONCURRENCY, async (job) => {
    if (!job.id) return { skip: true, log: `  skip  ${job.url} (URL tidak valid)` };
    return buildOne(job.source, previousById);
  });

  const feeds = [];
  let ok = 0;
  let failed = 0;
  for (const r of results) {
    if (!r || r.skip) { if (r) console.log(r.log); continue; }
    console.log(r.log);
    feeds.push(r.feed);
    if (r.feed.feedUrl && !r.feed.error) ok++;
    else failed++;
  }

  const registry = {
    generatedAt: new Date().toISOString(),
    site: SITE_BASE,
    ok,
    failed,
    buildMs: Date.now() - startedAt,
    feeds,
  };

  await writeFile(REGISTRY_FILE, JSON.stringify(registry, null, 2) + '\n', 'utf8');

  // dist/ = UI + feed + registry, persis isi yang disajikan GitHub Pages
  await rm(DIST_DIR, { recursive: true, force: true });
  await mkdir(DIST_DIR, { recursive: true });
  await cp(PAGES_DIR, DIST_DIR, { recursive: true });
  await cp(FEEDS_DIR, path.join(DIST_DIR, 'feeds'), { recursive: true });
  await writeFile(path.join(DIST_DIR, 'feeds.json'), JSON.stringify(registry, null, 2) + '\n', 'utf8');
  await writeFile(path.join(DIST_DIR, '.nojekyll'), '', 'utf8');

  const secs = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(`[build] selesai dalam ${secs}s: ${ok} ok, ${failed} gagal -> dist/`);
  if (!sources.length) console.log('[build] sources.json masih kosong (belum ada feed).');
}

main().catch((err) => {
  console.error('[build] fatal:', err);
  process.exit(1);
});
