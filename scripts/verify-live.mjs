/**
 * scripts/verify-live.mjs
 * Memastikan link feed benar-benar hidup dan dokumennya valid.
 *
 *   node scripts/verify-live.mjs --url https://.../feeds/abc.xml
 *   node scripts/verify-live.mjs --url https://.../feeds/abc.xml --wait 90
 *   node scripts/verify-live.mjs --all            # semua feed di feeds.json
 *   node scripts/verify-live.mjs --dist           # hasil build lokal (tanpa jaringan)
 *
 * Yang diperiksa: HTTP 200, content-type, well-formed XML / JSON Feed valid,
 * minimal 1 item, dan <atom:link rel="self"> cocok dengan URL-nya.
 *
 * Opsi: --soft (jangan keluar dengan kode 1 walau ada yang gagal)
 */

import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateFeedXml, validateJsonFeed } from '../src/validate.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const DIST_DIR = path.join(ROOT, 'dist');
const REGISTRY = path.join(ROOT, 'feeds.json');
const SITE_BASE = (process.env.SITE_BASE || 'https://sietekmalut.github.io/rss-anywhere/').replace(/\/*$/, '/');

const args = process.argv.slice(2);
const has = (name) => args.includes('--' + name);
const opt = (name, fallback) => {
  const i = args.indexOf('--' + name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const optAll = (name) => {
  const out = [];
  for (let i = 0; i < args.length; i++) if (args[i] === '--' + name && args[i + 1]) out.push(args[i + 1]);
  return out;
};

const WAIT_SECONDS = Number.parseInt(opt('wait', '0'), 10) || 0;
const SOFT = has('soft');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function kindOf(url, contentType) {
  const ct = String(contentType || '').toLowerCase();
  if (/\.json(\?|$)/i.test(url) || /json/.test(ct)) return 'json';
  if (/\.xml(\?|$)/i.test(url) || /xml/.test(ct)) return 'xml';
  return '';
}

const TYPE_OK = /(application|text)\/(rss|atom)\+xml|application\/xml|text\/xml|application\/(feed\+)?json|text\/plain/i;

function selfMatches(expected, actual) {
  if (!actual) return true; // feed asli boleh tanpa atom:link self
  const norm = (u) => String(u).replace(/\/+$/, '').toLowerCase();
  try {
    return norm(new URL(actual).href) === norm(new URL(expected).href);
  } catch {
    return false;
  }
}

async function fetchText(url) {
  const sep = url.includes('?') ? '&' : '?';
  const res = await fetch(url + sep + 'v=' + Date.now(), {
    headers: { 'cache-control': 'no-cache', 'user-agent': 'RSSAnywhere-verify/1.0' },
    signal: AbortSignal.timeout(20000),
  });
  const text = await res.text();
  return { status: res.status, contentType: res.headers.get('content-type') || '', text };
}

async function checkOnce(url) {
  const out = { url, ok: false, status: 0, contentType: '', items: 0, errors: [], warnings: [] };
  let got;
  try {
    got = await fetchText(url);
  } catch (err) {
    out.errors.push('tidak bisa dihubungi: ' + (err && err.message ? err.message : err));
    return out;
  }
  out.status = got.status;
  out.contentType = got.contentType;

  if (got.status !== 200) {
    out.errors.push('HTTP ' + got.status);
    return out;
  }
  if (!TYPE_OK.test(got.contentType)) {
    out.errors.push('content-type tidak sesuai: ' + (got.contentType || 'kosong'));
  }

  const kind = kindOf(url, got.contentType);
  if (kind === 'json') {
    const v = validateJsonFeed(got.text);
    out.items = v.items;
    if (!v.ok) out.errors.push(...v.errors.map((e) => 'JSON: ' + e));
    if (v.ok && v.items < 1) out.errors.push('JSON tidak berisi item');
    if (!selfMatches(url, v.selfUrl)) out.warnings.push('feed_url menunjuk ke ' + v.selfUrl);
  } else {
    const v = validateFeedXml(got.text);
    out.items = v.items;
    if (!v.ok) out.errors.push(...v.errors.map((e) => 'XML: ' + e));
    if (v.ok && v.items < 1) out.errors.push('XML tidak berisi item');
    // Feed asli yang dipassthrough boleh membawa atom:link self milik situs asal.
    if (!selfMatches(url, v.selfUrl)) out.warnings.push('atom:link self menunjuk ke ' + v.selfUrl);
  }

  out.ok = out.errors.length === 0;
  return out;
}

async function checkWithWait(url) {
  const deadline = Date.now() + WAIT_SECONDS * 1000;
  let attempt = 0;
  while (true) {
    attempt++;
    const res = await checkOnce(url);
    if (res.ok || Date.now() + 5000 > deadline) return { ...res, attempts: attempt };
    console.log(`  ... belum siap (${res.errors[0] || 'HTTP ' + res.status}), coba lagi 5s`);
    await sleep(5000);
  }
}

async function verifyUrls(urls) {
  const results = [];
  for (const url of urls) {
    const r = await checkWithWait(url);
    results.push(r);
    const mark = r.ok ? 'VALID  ' : 'RUSAK  ';
    console.log(`  ${mark} ${String(r.status || '-').padEnd(3)} ${String(r.items).padStart(3)} item  ${r.url}`);
    for (const e of r.errors.slice(0, 4)) console.log('         - ' + e);
    for (const w of (r.warnings || []).slice(0, 2)) console.log('         ! ' + w);
  }
  return results;
}

/** Validasi berkas hasil build di dist/ tanpa menyentuh jaringan. */
async function verifyDist() {
  let registry;
  try {
    registry = JSON.parse(await readFile(path.join(DIST_DIR, 'feeds.json'), 'utf8'));
  } catch {
    console.error('dist/feeds.json tidak ada — jalankan: node scripts/build-static.mjs');
    return [false];
  }
  const files = new Set(await readdir(path.join(DIST_DIR, 'feeds')));
  const failures = [];
  console.log(`  ${registry.feeds.length} feed di dist/, ${registry.buildMs || '?'} ms build`);

  for (const feed of registry.feeds) {
    const problems = [];
    const warnings = [];
    if (!feed.feedUrl) {
      warnings.push('sumber gagal, tidak ada file yang disajikan' + (feed.error ? ': ' + feed.error : ''));
    } else {
      const name = feed.id + '.xml';
      if (!files.has(name)) problems.push('file ' + name + ' tidak ada');
      else {
        const xml = await readFile(path.join(DIST_DIR, 'feeds', name), 'utf8');
        const v = validateFeedXml(xml);
        if (!v.ok) problems.push(...v.errors.map((e) => 'XML: ' + e));
        else {
          if (v.items < 1) problems.push('XML tidak berisi item');
          const native = feed.source === 'native' || feed.source === 'native-json';
          if (!native && !selfMatches(feed.feedUrl, v.selfUrl)) problems.push('atom:link self tidak cocok');
        }
      }
      const jname = feed.id + '.json';
      if (!files.has(jname)) problems.push('file ' + jname + ' tidak ada');
      else {
        const json = await readFile(path.join(DIST_DIR, 'feeds', jname), 'utf8');
        const v = validateJsonFeed(json);
        if (!v.ok) problems.push(...v.errors.map((e) => 'JSON: ' + e));
        else if (v.items < 1) problems.push('JSON tidak berisi item');
      }
    }
    if (problems.length) {
      console.log(`  RUSAK   ${feed.id}  ${feed.url}`);
      for (const p of problems.slice(0, 4)) console.log('          - ' + p);
      failures.push(feed.id);
    } else if (warnings.length) {
      console.log(`  KOSONG  ${feed.id}  ${feed.url}`);
      for (const w of warnings) console.log('          ! ' + w);
    } else {
      console.log(`  VALID   ${String(feed.count).padStart(3)} item  ${feed.id}${feed.note ? '  (' + feed.note + ')' : ''}`);
    }
  }
  return [failures.length === 0, failures];
}

/**
 * Daftar feed yang akan diperiksa.
 *
 * Untuk --all, pakai feeds.json yang BENAR-BENAR tayang di situs, bukan file
 * lokal. Alasannya: hasil build di runner bisa berbeda dengan build lokal
 * (beberapa situs memblokir IP GitHub), jadi feeds.json lokal bisa berisi link
 * yang memang tidak diterbitkan. File lokal hanya dipakai sebagai cadangan.
 */
async function loadRegistry() {
  try {
    const res = await fetch(SITE_BASE + 'feeds.json?t=' + Date.now(), {
      headers: { 'cache-control': 'no-cache', 'user-agent': 'RSSAnywhere-verify/1.0' },
      signal: AbortSignal.timeout(20000),
    });
    if (res.ok) {
      const data = await res.json();
      if (data && Array.isArray(data.feeds)) {
        console.log('[verify] daftar feed dari ' + SITE_BASE + 'feeds.json');
        return data;
      }
    }
  } catch { /* pakai file lokal */ }
  console.log('[verify] daftar feed dari feeds.json lokal');
  return JSON.parse(await readFile(REGISTRY, 'utf8'));
}

async function main() {
  const started = Date.now();
  const urls = optAll('url');

  if (has('dist')) {
    console.log('[verify] hasil build lokal (dist/):');
    const [ok, failures] = await verifyDist();
    console.log('');
    console.log(ok ? '[verify] semua berkas valid.' : '[verify] ada berkas rusak: ' + failures.join(', '));
    if (!ok && !SOFT) process.exit(1);
    return;
  }

  if (!urls.length && has('all')) {
    const registry = await loadRegistry();
    for (const feed of registry.feeds || []) {
      if (feed.feedUrl) urls.push(feed.feedUrl);
      if (feed.jsonUrl) urls.push(feed.jsonUrl);
    }
  }

  if (!urls.length) {
    console.error('Tidak ada URL. Pakai --url <u>, --all, atau --dist.');
    process.exit(2);
  }

  console.log(`[verify] ${urls.length} link` + (WAIT_SECONDS ? `, tunggu maks ${WAIT_SECONDS}s` : '') + ':');
  const results = await verifyUrls(urls);
  const bad = results.filter((r) => !r.ok);
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  console.log('');
  console.log(`[verify] ${results.length - bad.length}/${results.length} valid dalam ${secs}s`);
  if (bad.length && !SOFT) process.exit(1);
}

main().catch((err) => {
  console.error('[verify] fatal:', err);
  process.exit(1);
});
