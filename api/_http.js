/**
 * Helper bersama untuk fungsi serverless Vercel.
 * Mengubah req/res gaya Node menjadi Request/Response standar Web.
 */

export function toRequest(req) {
  const host = req.headers['x-forwarded-host'] || req.headers.host || 'localhost';
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const url = new URL(req.url || '/', String(proto) + '://' + String(host));
  const headers = {};
  for (const [key, value] of Object.entries(req.headers || {})) {
    if (value !== undefined && value !== null) headers[key] = Array.isArray(value) ? value.join(', ') : String(value);
  }
  return new Request(url, { method: req.method || 'GET', headers });
}

export async function send(res, response) {
  res.statusCode = response.status;
  response.headers.forEach((value, key) => res.setHeader(key, value));
  if (response.status === 204 || response.status === 304) { res.end(); return; }
  const buffer = Buffer.from(await response.arrayBuffer());
  res.setHeader('content-length', String(buffer.byteLength));
  res.end(buffer);
}

/** Jawab preflight CORS tanpa menjalankan handler. */
export function preflight(res) {
  res.statusCode = 204;
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-methods', 'GET, HEAD, OPTIONS');
  res.setHeader('access-control-allow-headers', '*');
  res.setHeader('access-control-max-age', '86400');
  res.end();
}

export function fail(res, err) {
  res.statusCode = 500;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(JSON.stringify({ ok: false, error: String(err && err.message ? err.message : err) }));
}

/**
 * Cache dalam memori proses. Di Vercel lambda yang masih "hangat" akan
 * memakainya ulang, jadi request berulang tidak perlu mengambil ulang situs
 * sumber. Kalau lambda dibekukan/dimatikan, cache hilang - tidak fatal.
 */
const memory = new Map();
const MAX_ENTRIES = 200;
const TTL_MS = 15 * 60 * 1000;

export const cache = {
  async match(key) {
    const entry = memory.get(key);
    if (!entry) return null;
    if (entry.expires < Date.now()) { memory.delete(key); return null; }
    return entry.response.clone();
  },
  async put(key, response) {
    if (memory.size >= MAX_ENTRIES) memory.clear();
    memory.set(key, { response: response.clone(), expires: Date.now() + TTL_MS });
  },
};
