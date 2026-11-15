/**
 * scripts/smoke-test.mjs
 * Uji cepat: jalankan server lokal dulu (npm run dev), lalu:
 *   node scripts/smoke-test.mjs [url ...]
 */

const BASE = process.env.BASE || 'http://localhost:8787';

const DEFAULT_SITES = [
  'https://github.blog',
  'https://blog.cloudflare.com',
  'https://www.theverge.com',
  'https://nextjs.org/blog',
  'https://www.detik.com',
  'https://www.cnnindonesia.com',
  'https://www.kompas.com',
  'https://example.com',
];

const sites = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT_SITES;

function line() { console.log('-'.repeat(72)); }

for (const site of sites) {
  line();
  console.log('TARGET :', site);
  const started = Date.now();
  try {
    const url = `${BASE}/api/preview?url=${encodeURIComponent(site)}&limit=8`;
    const res = await fetch(url, { signal: AbortSignal.timeout(60000) });
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = null; }

    if (!res.ok || !data || data.ok === false) {
      console.log('STATUS :', res.status, 'GAGAL');
      console.log('ERROR  :', (data && data.error) || text.slice(0, 300));
      if (data && data.hint) console.log('HINT   :', data.hint);
      continue;
    }

    console.log('SUMBER :', data.source, '|', data.count, 'item |', data.elapsedMs, 'ms | total', Date.now() - started, 'ms');
    console.log('JUDUL  :', data.feed && data.feed.title);
    console.log('LINK   :', data.sourceUrl);
    if (data.warnings && data.warnings.length) console.log('WARN   :', data.warnings.join(' | '));
    for (const it of data.items.slice(0, 4)) {
      console.log('  •', (it.title || '').slice(0, 78));
      console.log('    ', it.link.slice(0, 100));
      if (it.date) console.log('     date:', it.date);
    }

    // Cek output RSS benar-benar XML yang bisa dibaca
    const feedRes = await fetch(`${BASE}/feed?url=${encodeURIComponent(site)}&limit=8`);
    const xml = await feedRes.text();
    const okXml = xml.startsWith('<?xml') && /<(rss|feed)[\s>]/.test(xml);
    const items = (xml.match(/<item>/g) || []).length || (xml.match(/<entry>/g) || []).length;
    console.log('RSS    :', feedRes.status, okXml ? 'XML valid' : 'BUKAN XML', '| <item> =', items,
      '|', feedRes.headers.get('x-feed-source'), '|', xml.length, 'bytes');
    if (!okXml) console.log('  cuplikan:', xml.slice(0, 200));
  } catch (err) {
    console.log('FATAL  :', err && err.message ? err.message : err);
  }
}
line();
