import { json, VERSION } from '../src/core.js';

/** Vercel: GET /api/healthz -> cek cepat bahwa fungsi hidup */
export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('access-control-allow-methods', 'GET, HEAD, OPTIONS');
    res.end();
    return;
  }
  const response = json({
    ok: true,
    name: 'rss-anywhere',
    version: VERSION,
    runtime: 'vercel',
    time: new Date().toISOString(),
  }, 200);
  res.statusCode = response.status;
  response.headers.forEach((value, key) => res.setHeader(key, value));
  res.end(await response.text());
}
