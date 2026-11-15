/**
 * scripts/build-static.mjs
 * Membangun feed statis untuk GitHub Pages.
 *
 *   sources.json  ->  feeds/<id>.xml  +  feeds/<id>.json  +  feeds.json
 *                 ->  dist/ (siap di-upload sebagai artefak GitHub Pages)
 *
 * feeds/ hanya ada di dist/ dan di disk; folder itu tidak di-commit supaya
 * riwayat git tidak menggelembung (XML bisa ratusan KB per feed per build).
 * feeds.json kecil dan di-commit sebagai metadata + penanda build terakhir.
 *
 * Dijalankan oleh .github/workflows/feeds.yml (tiap 30 menit / manual / issue baru),
 * tapi bisa juga dijalankan manual di lokal: node scripts/build-static.mjs
 */

import { readFile, writeFile, mkdir, rm, cp } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildFeed } from '../src/feed.js';
import { buildRss, buildJsonFeed } from '../src/render.js';
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

const abs = (p) => SITE_BASE + p;

function normalizeXmlDeclaration(xml) {
  return String(xml)
    .replace(/^\uFEFF/, '')
    .replace(/^(<\?xml[^>]*?encoding\s*=\s*)(["'])[^"']*\2/i, '$1$2UTF-8$2');
}

function safeInt(value, fallback, min, max) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

/** Ambil file yang sedang tayang di GitHub Pages (untuk fallback saat sumber gagal). */
async function fetchPublished(name) {
  try {
    const res = await fetch(SITE_BASE + name + '?t=' + Date.now(), {
      headers: { 'user-agent': 'RSSAnywhere/1.0 (+' + SITE_BASE + ')' },
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

async function main() {
  const sourcesDoc = await readJson(SOURCES_FILE, { sources: [] });
  const sources = Array.isArray(sourcesDoc.sources) ? sourcesDoc.sources : [];
  const previous = await readJson(REGISTRY_FILE, { feeds: [] });
  const previousById = new Map((previous.feeds || []).map((f) => [f.id, f]));

  await mkdir(FEEDS_DIR, { recursive: true });

  const feeds = [];
  let ok = 0;
  let failed = 0;

  console.log(`[build] ${sources.length} sumber, ${SITE_BASE}`);

  for (const source of sources) {
    const rawUrl = String(source.url || '').trim();
    let id;
    try {
      id = feedId(rawUrl);
    } catch {
      console.log(`  skip  ${rawUrl} (URL tidak valid)`);
      continue;
    }

    const limit = safeInt(source.limit, DEFAULT_LIMIT, 1, 100);
    const filter = String(source.filter || '').slice(0, 120);
    const mode = ['auto', 'html', 'feed'].includes(source.mode) ? source.mode : 'auto';
    const selfUrl = abs('feeds/' + id + '.xml');
    const jsonUrl = abs('feeds/' + id + '.json');
    const startedAt = Date.now();

    try {
      const result = await buildFeed(rawUrl, { limit, filter, mode });
      let xml;
      if (result.rawXml) {
        xml = normalizeXmlDeclaration(result.rawXml);
      } else {
        xml = buildRss({ feed: result.feed, items: result.items, selfUrl, ttl: TTL_SECONDS });
      }
      const json = buildJsonFeed({ feed: result.feed, items: result.items, selfUrl: jsonUrl, ttl: TTL_SECONDS });

      await writeFile(path.join(FEEDS_DIR, id + '.xml'), xml, 'utf8');
      await writeFile(path.join(FEEDS_DIR, id + '.json'), json, 'utf8');

      feeds.push({
        id,
        url: rawUrl,
        title: result.feed.title || new URL(rawUrl).hostname,
        siteUrl: result.targetUrl || result.feed.link || rawUrl,
        count: result.items.length,
        source: result.source,
        feedUrl: selfUrl,
        jsonUrl,
        updatedAt: new Date().toISOString(),
        elapsedMs: Date.now() - startedAt,
        error: null,
      });
      ok++;
      console.log(`  ok    ${String(result.items.length).padStart(2)} item  ${result.source.padEnd(7)}  ${rawUrl}`);
    } catch (err) {
      failed++;
      const message = String((err && err.message) || err).slice(0, 200);
      const old = previousById.get(id) || null;

      // Fallback: pakai file yang masih tayang di GitHub Pages supaya feed
      // tidak hilang hanya karena satu pengambilan gagal.
      const liveXml = await fetchPublished('feeds/' + id + '.xml');
      const liveJson = await fetchPublished('feeds/' + id + '.json');

      if (liveXml && liveJson) {
        await writeFile(path.join(FEEDS_DIR, id + '.xml'), liveXml, 'utf8');
        await writeFile(path.join(FEEDS_DIR, id + '.json'), liveJson, 'utf8');
        feeds.push({
          id,
          url: rawUrl,
          title: (old && old.title) || new URL(rawUrl).hostname,
          siteUrl: (old && old.siteUrl) || rawUrl,
          count: (old && old.count) || 0,
          source: (old && old.source) || 'unknown',
          feedUrl: selfUrl,
          jsonUrl,
          updatedAt: (old && old.updatedAt) || new Date().toISOString(),
          elapsedMs: Date.now() - startedAt,
          stale: true,
          error: message,
        });
        console.log(`  gagal (pakai versi tayang terakhir)  ${rawUrl} - ${message}`);
      } else if (old && old.feedUrl) {
        feeds.push({ ...old, error: message });
        console.log(`  gagal (metadata lama)  ${rawUrl} - ${message}`);
      } else {
        feeds.push({
          id,
          url: rawUrl,
          title: new URL(rawUrl).hostname,
          siteUrl: rawUrl,
          count: 0,
          source: 'error',
          feedUrl: null,
          jsonUrl: null,
          updatedAt: new Date().toISOString(),
          elapsedMs: Date.now() - startedAt,
          error: message,
        });
        console.log(`  gagal  ${rawUrl} - ${message}`);
      }
    }
  }

  const registry = {
    generatedAt: new Date().toISOString(),
    site: SITE_BASE,
    ok,
    failed,
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

  console.log(`[build] selesai: ${ok} ok, ${failed} gagal -> dist/`);
  if (!sources.length) console.log('[build] sources.json masih kosong (belum ada feed).');
}

main().catch((err) => {
  console.error('[build] fatal:', err);
  process.exit(1);
});
