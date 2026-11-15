/**
 * scripts/serve-dist.mjs
 * Menyajikan folder dist/ (hasil build GitHub Pages) di lokal,
 * supaya tampilan dan link feed bisa dicek sebelum di-push.
 *
 * Jalankan: node scripts/serve-dist.mjs   ->  http://localhost:8790
 */

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(HERE, '..', 'dist');
const PORT = Number(process.env.PORT || 8790);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.txt': 'text/plain; charset=utf-8',
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://localhost');
  let rel = decodeURIComponent(url.pathname);
  if (rel.endsWith('/')) rel += 'index.html';
  const file = path.resolve(DIST, rel.replace(/^\/+/, ''));
  if (!file.startsWith(DIST)) {
    res.statusCode = 403;
    res.end('Forbidden');
    return;
  }
  try {
    const data = await readFile(file);
    res.statusCode = 200;
    res.setHeader('content-type', MIME[path.extname(file).toLowerCase()] || 'application/octet-stream');
    res.setHeader('cache-control', 'no-cache');
    res.setHeader('content-length', String(data.byteLength));
    res.end(data);
  } catch {
    res.statusCode = 404;
    res.setHeader('content-type', 'text/plain; charset=utf-8');
    res.end('404 - ' + rel);
  }
});

server.listen(PORT, () => {
  console.log('');
  console.log('  Pratinjau build GitHub Pages: http://localhost:' + PORT + '/');
  console.log('  Feed contoh: /feeds/<id>.xml   Daftar: /feeds.json');
  console.log('');
});
