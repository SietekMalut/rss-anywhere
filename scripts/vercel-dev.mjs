/**
 * scripts/vercel-dev.mjs
 * Meniru perilaku Vercel di lokal, supaya adapter api/*.js bisa diuji
 * tanpa login/deploy. Tiga hal yang ditiru:
 *
 *   1. File statis dari folder public/ (seperti Vercel: file dulu, baru rewrite)
 *   2. Rewrites di vercel.json  ->  /feed  diarahkan ke api/feed.js
 *   3. Handler gaya Vercel: module default export (req, res)
 *
 * Jalankan: node scripts/vercel-dev.mjs
 * Lalu uji : BASE=http://localhost:8788 node scripts/api-test.mjs
 */

import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const PORT = Number(process.env.PORT || 8788);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
};

const config = JSON.parse(await readFile(path.join(ROOT, 'vercel.json'), 'utf8'));
const rewrites = Array.isArray(config.rewrites) ? config.rewrites : [];

/**
 * vercel.json di proyek ini hanya memakai dua bentuk:
 *   "/feed"     -> cocok persis
 *   "/(.*)"     -> cocok semua (catch-all)
 */
function matchSource(source, pathname) {
  if (source.endsWith('/(.*)')) {
    return pathname.startsWith(source.slice(0, -'/(.*)'.length) || '/');
  }
  return source === pathname;
}

function rewrite(pathname) {
  for (const rule of rewrites) {
    if (matchSource(rule.source, pathname)) return rule.destination;
  }
  return null;
}

/** /api/feed -> api/feed.js */
async function loadHandler(destination) {
  const rel = destination.replace(/^\/+/, '');
  const file = path.join(ROOT, rel.endsWith('.js') ? rel : rel + '.js');
  if (!file.startsWith(ROOT)) return null;
  try {
    const mod = await import('file://' + file.split(path.sep).join('/'));
    return typeof mod.default === 'function' ? mod.default : null;
  } catch (err) {
    console.error('[vercel-dev] gagal memuat ' + rel + ': ' + err.message);
    return null;
  }
}

async function fileAt(urlPath) {
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const file = path.resolve(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR)) return null;
  try {
    const info = await stat(file);
    if (info.isDirectory()) return fileAt(urlPath.replace(/\/?$/, '/index.html'));
    return file;
  } catch {
    return null;
  }
}

async function serveStatic(res, file) {
  const data = await readFile(file);
  res.statusCode = 200;
  res.setHeader('content-type', MIME[path.extname(file).toLowerCase()] || 'application/octet-stream');
  res.setHeader('cache-control', 'no-cache');
  res.setHeader('content-length', String(data.byteLength));
  res.end(data);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', 'http://' + (req.headers.host || 'localhost:' + PORT));
    req.headers['x-forwarded-host'] = req.headers.host || 'localhost:' + PORT;
    req.headers['x-forwarded-proto'] = 'http';

    // 1. filesystem lebih dulu, sama seperti Vercel
    const direct = await fileAt(url.pathname);
    if (direct) return await serveStatic(res, direct);

    // 2. folder api/ = serverless function (konvensi Vercel, tanpa rewrite)
    if (url.pathname.startsWith('/api/')) {
      const handler = await loadHandler(url.pathname);
      if (handler) return await handler(req, res);
    }

    // 3. baru rewrites
    const destination = rewrite(url.pathname);
    if (destination) {
      const destPath = destination.split('?')[0];
      const destFile = await fileAt(destPath);
      if (destFile) return await serveStatic(res, destFile);
      const handler = await loadHandler(destPath);
      if (handler) {
        req.url = destination + url.search;
        return await handler(req, res);
      }
    }

    // 4. tidak ada file, tidak ada rewrite
    res.statusCode = 404;
    res.setHeader('content-type', 'text/plain; charset=utf-8');
    res.end('404 - halaman tidak ditemukan (tidak ada file atau rewrite yang cocok)');
  } catch (err) {
    res.statusCode = 500;
    res.setHeader('content-type', 'text/plain; charset=utf-8');
    res.end('500 - ' + (err && err.message ? err.message : String(err)));
  }
});

server.listen(PORT, () => {
  console.log('');
  console.log('  RSS Anywhere - simulator Vercel (lokal)');
  console.log('  UI      : http://localhost:' + PORT + '/');
  console.log('  Feed    : http://localhost:' + PORT + '/feed?url=https://github.blog');
  console.log('  Preview : http://localhost:' + PORT + '/api/preview?url=https://github.blog');
  console.log('');
  console.log('  Rewrites yang aktif:');
  for (const r of rewrites) console.log('    ' + r.source + '  ->  ' + r.destination);
  console.log('');
  console.log('  Uji: $env:BASE="http://localhost:' + PORT + '"; node scripts/api-test.mjs');
  console.log('');
});
