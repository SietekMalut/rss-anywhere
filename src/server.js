/**
 * src/server.js
 * Server lokal untuk menguji aplikasi sebelum deploy (Node 18+).
 * Jalankan: node src/server.js   ->  http://localhost:8787
 */

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { route } from './core.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(HERE, '..', 'public');
const PORT = Number(process.env.PORT || 8787);

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

const memory = new Map();
const cache = {
  async match(key) {
    const entry = memory.get(key);
    if (!entry) return null;
    if (entry.expires < Date.now()) { memory.delete(key); return null; }
    return entry.response.clone();
  },
  async put(key, response) {
    if (memory.size > 500) memory.clear();
    memory.set(key, { response: response.clone(), expires: Date.now() + 15 * 60 * 1000 });
  },
};

async function send(res, response) {
  res.statusCode = response.status;
  response.headers.forEach((value, name) => res.setHeader(name, value));
  if (response.status === 204 || response.status === 304) { res.end(); return; }
  const buf = Buffer.from(await response.arrayBuffer());
  res.setHeader('content-length', String(buf.byteLength));
  res.end(buf);
}

async function serveStatic(res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const file = path.resolve(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR)) {
    res.statusCode = 403; res.end('Forbidden'); return;
  }
  try {
    const data = await readFile(file);
    res.statusCode = 200;
    res.setHeader('content-type', MIME[path.extname(file).toLowerCase()] || 'application/octet-stream');
    res.setHeader('cache-control', 'no-cache');
    res.end(data);
  } catch {
    const index = path.join(PUBLIC_DIR, 'index.html');
    try {
      const data = await readFile(index);
      res.statusCode = 200;
      res.setHeader('content-type', MIME['.html']);
      res.end(data);
    } catch {
      res.statusCode = 404;
      res.end('404 Not Found');
    }
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const origin = `http://${req.headers.host || 'localhost:' + PORT}`;
    const request = new Request(new URL(req.url || '/', origin), {
      method: req.method,
      headers: req.headers,
    });
    const handled = await route(request, {
      cache,
      allowPrivate: process.env.RSS_ALLOW_PRIVATE === '1',
    });
    if (handled) return await send(res, handled);
    return await serveStatic(res, new URL(request.url).pathname);
  } catch (err) {
    res.statusCode = 500;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ ok: false, error: String(err && err.stack ? err.stack : err) }, null, 2));
  }
});

server.listen(PORT, () => {
  console.log('');
  console.log('  RSS Anywhere - server lokal');
  console.log('  UI        : http://localhost:' + PORT + '/');
  console.log('  Contoh    : http://localhost:' + PORT + '/feed?url=https://github.blog');
  console.log('  Preview   : http://localhost:' + PORT + '/api/preview?url=https://github.blog');
  console.log('');
  console.log('  Tekan Ctrl+C untuk berhenti.');
  console.log('');
});
