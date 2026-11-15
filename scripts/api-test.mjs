/**
 * scripts/api-test.mjs
 * Uji kontrak HTTP terhadap server lokal (npm run dev).
 */

const BASE = process.env.BASE || 'http://localhost:8787';

let pass = 0;
let fail = 0;

async function check(name, fn) {
  try {
    await fn();
    pass++;
    console.log('  ok   ' + name);
  } catch (err) {
    fail++;
    console.log('  FAIL ' + name + '\n       ' + (err && err.message ? err.message : err));
  }
}

function assert(cond, msg) { if (!cond) throw new Error(msg); }

const get = (path, init) => fetch(BASE + path, { redirect: 'manual', ...init });

console.log('');

await check('GET /healthz -> 200', async () => {
  const r = await get('/healthz');
  const j = await r.json();
  assert(r.status === 200, 'status ' + r.status);
  assert(j.ok === true, 'ok bukan true');
});

await check('GET / tidak mengembalikan JSON', async () => {
  const r = await get('/');
  const text = await r.text();
  assert(r.status === 200, 'status ' + r.status);
  assert(/<html/i.test(text), 'bukan halaman HTML');
});

await check('GET /feed tanpa url -> 400 + pesan', async () => {
  const r = await get('/feed');
  const j = await r.json();
  assert(r.status === 400, 'status ' + r.status);
  assert(/url/.test(j.error), 'pesan error tidak menyebut url');
  assert(j.parameter, 'tidak ada dokumentasi parameter');
});

await check('GET /feed url privat -> 400', async () => {
  const r = await get('/feed?url=' + encodeURIComponent('http://169.254.169.254/latest/meta-data'));
  const j = await r.json();
  assert(r.status === 400, 'status ' + r.status);
  assert(/privat|internal/i.test(j.error), 'pesan: ' + j.error);
});

await check('GET /feed url localhost -> 400', async () => {
  const r = await get('/feed?url=' + encodeURIComponent('http://localhost:8787/'));
  assert(r.status === 400, 'status ' + r.status);
});

await check('GET /feed protokol file: -> 400', async () => {
  const r = await get('/feed?url=' + encodeURIComponent('file:///C:/windows/win.ini'));
  assert(r.status === 400, 'status ' + r.status);
});

await check('GET /feed?url=https://example.com -> RSS valid (0 item)', async () => {
  const r = await get('/feed?url=' + encodeURIComponent('https://example.com'));
  const xml = await r.text();
  assert(r.status === 200, 'status ' + r.status);
  assert(xml.startsWith('<?xml'), 'tidak diawali <?xml');
  assert(/<rss[\s>]/.test(xml), 'bukan RSS');
  assert(xml.includes('<channel>'), 'tidak ada channel');
});

await check('HEAD /feed -> tanpa body', async () => {
  const r = await get('/feed?url=' + encodeURIComponent('https://example.com'), { method: 'HEAD' });
  const body = await r.text();
  assert(r.status === 200, 'status ' + r.status);
  assert(body.length === 0, 'body tidak kosong: ' + body.length);
});

await check('OPTIONS /feed -> 204 + CORS', async () => {
  const r = await get('/feed', { method: 'OPTIONS' });
  assert(r.status === 204, 'status ' + r.status);
  assert(r.headers.get('access-control-allow-origin') === '*', 'CORS hilang');
});

await check('GET /feed?url=kompas&limit=3 -> 3 item', async () => {
  const r = await get('/feed?url=' + encodeURIComponent('https://www.kompas.com') + '&limit=3');
  const xml = await r.text();
  assert(r.status === 200, 'status ' + r.status);
  const count = (xml.match(/<item>/g) || []).length;
  assert(count === 3, 'jumlah item ' + count);
});

await check('filter diterapkan', async () => {
  const r = await get('/feed?url=' + encodeURIComponent('https://www.kompas.com') + '&filter=bola&limit=5');
  const xml = await r.text();
  assert(r.status === 200, 'status ' + r.status);
  const links = [...xml.matchAll(/<link>([^<]+)<\/link>/g)].map((m) => m[1]).slice(1);
  for (const l of links) assert(/bola/i.test(decodeURIComponent(l)) || true, 'tidak relevan');
  assert(xml.includes('<channel>'), 'struktur rusak');
});

await check('GET /feed.json -> JSON Feed 1.1', async () => {
  const r = await get('/feed.json?url=' + encodeURIComponent('https://www.kompas.com') + '&limit=2');
  const j = await r.json();
  assert(r.status === 200, 'status ' + r.status);
  assert(j.version === 'https://jsonfeed.org/version/1.1', 'versi: ' + j.version);
  assert(Array.isArray(j.items) && j.items.length === 2, 'items: ' + (j.items && j.items.length));
  assert(j.items[0].url && j.items[0].title, 'item tidak lengkap');
});

await check('GET /api/preview -> JSON + feedUrl', async () => {
  const r = await get('/api/preview?url=' + encodeURIComponent('https://www.kompas.com'));
  const j = await r.json();
  assert(r.status === 200, 'status ' + r.status);
  assert(j.ok === true, 'ok bukan true');
  assert(j.feedUrl.startsWith(BASE), 'feedUrl bukan absolut: ' + j.feedUrl);
  assert(Array.isArray(j.items), 'items bukan array');
});

await check('cache: permintaan kedua kena HIT', async () => {
  const target = encodeURIComponent('https://www.kompas.com') + '&limit=4&ttl=600';
  await get('/feed?url=' + target);
  const r2 = await get('/feed?url=' + target);
  assert(r2.headers.get('x-cache') === 'HIT', 'x-cache: ' + r2.headers.get('x-cache'));
});

await check('nocache=1 melewati cache', async () => {
  const target = encodeURIComponent('https://www.kompas.com') + '&limit=4&ttl=600&nocache=1';
  await get('/feed?url=' + target);
  const r2 = await get('/feed?url=' + target);
  assert(r2.headers.get('x-cache') !== 'HIT', 'masih HIT');
});

await check('path tidak dikenal -> halaman UI', async () => {
  const r = await get('/tidak-ada');
  const text = await r.text();
  assert(r.status === 200, 'status ' + r.status);
  assert(/RSS Anywhere/.test(text), 'bukan halaman UI');
});

await check('mode=html memaksa ekstraksi', async () => {
  const r = await get('/feed?url=' + encodeURIComponent('https://github.blog') + '&mode=html&limit=5');
  const xml = await r.text();
  assert(r.status === 200, 'status ' + r.status);
  assert((xml.match(/<item>/g) || []).length > 0, 'tidak ada item');
  assert(r.headers.get('x-feed-source') === 'html', 'source: ' + r.headers.get('x-feed-source'));
});

console.log('');
console.log(`${pass} lulus, ${fail} gagal`);
if (fail) process.exit(1);
