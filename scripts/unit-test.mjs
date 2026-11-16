/**
 * scripts/unit-test.mjs
 * Uji parser + ekstraktor tanpa jaringan. Jalankan: node scripts/unit-test.mjs
 */

import assert from 'node:assert/strict';
import { parseHtml, extractPage, parseDate, decodeEntities, textOf } from '../src/html.js';
import { parseFeedXml } from '../src/feed.js';
import { buildRss, buildJsonFeed, esc } from '../src/render.js';
import { validateXml, validateFeedXml, validateJsonFeed, validatePair } from '../src/validate.js';

let pass = 0;
let fail = 0;

function test(name, fn) {
  try {
    fn();
    pass++;
    console.log('  ok   ' + name);
  } catch (err) {
    fail++;
    console.log('  FAIL ' + name);
    console.log('       ' + (err && err.message ? err.message : err));
  }
}

/* ---------------- parser ---------------- */

test('parseHtml: teks & atribut + entity', () => {
  const root = parseHtml('<div class="a b" data-x=1>Satu &amp; dua &lt;3 &#169;</div>');
  const div = root.children[0];
  assert.equal(div.tag, 'div');
  assert.equal(div.attrs.class, 'a b');
  assert.equal(div.attrs['data-x'], '1');
  assert.equal(textOf(div), 'Satu & dua <3 ©');
});

test('parseHtml: void element & unclosed tag', () => {
  const root = parseHtml('<p>Halo<br>Dunia<p>Kedua<img src="x.png">');
  const ps = root.children.filter((n) => n.tag === 'p');
  assert.equal(ps.length, 2);
  assert.equal(textOf(ps[0]), 'Halo Dunia');
  assert.equal(textOf(ps[1]), 'Kedua');
});

test('parseHtml: script berisi < tidak merusak struktur', () => {
  const root = parseHtml('<div><script>if (a<b) { c = "</div>" }</script><span>aman</span></div>');
  assert.equal(textOf(root.children[0]), 'aman');
});

test('decodeEntities: numerik dan named', () => {
  assert.equal(decodeEntities('a&#8217;b'), 'a’b');
  assert.equal(decodeEntities('&hellip;&nbsp;x'), '…\u00a0x');
  assert.equal(decodeEntities('&unknown;'), '&unknown;');
});

test('parseDate: beberapa format', () => {
  assert.equal(parseDate('2026-11-15T10:30:00Z').toISOString(), '2026-11-15T10:30:00.000Z');
  assert.equal(parseDate('15 November 2026').getUTCDate(), 15);
  assert.equal(parseDate('Nov 5, 2024').getUTCMonth(), 10);
  const rel = parseDate('3 jam yang lalu', Date.UTC(2026, 0, 1, 12, 0, 0));
  assert.equal(rel.getUTCHours(), 9);
});

/* ---------------- ekstraksi ---------------- */

const ARTICLE_PAGE = `<!doctype html><html lang="id"><head>
<title>Berita Contoh</title>
<meta name="description" content="Situs berita contoh">
<link rel="alternate" type="application/rss+xml" href="/feed.xml">
</head><body>
<header><a href="/">Beranda</a><a href="/login">Masuk</a></header>
<main>
  <article>
    <h2><a href="/berita/satu">Pemerintah meluncurkan program baru</a></h2>
    <time datetime="2026-11-14T08:00:00+07:00">14 Nov 2026</time>
    <p>Program ini menyasar ribuan keluarga di seluruh daerah dan akan berjalan bertahap.</p>
    <img src="/img/satu.jpg" alt="">
  </article>
  <article>
    <h3><a href="/berita/dua">Harga pangan mulai turun di pasar</a></h3>
    <span class="date">15 November 2026</span>
    <p>Pedagang melaporkan penurunan harga setelah panen raya minggu lalu.</p>
  </article>
</main>
<footer><a href="/tentang">Tentang</a></footer>
</body></html>`;

test('extractPage: <article> + tanggal + gambar + link absolut', () => {
  const r = extractPage(ARTICLE_PAGE, 'https://contoh.com/berita');
  assert.equal(r.meta.title, 'Berita Contoh');
  assert.equal(r.items.length, 2);
  assert.equal(r.items[0].link, 'https://contoh.com/berita/satu');
  assert.equal(r.items[0].title, 'Pemerintah meluncurkan program baru');
  assert.ok(r.items[0].date.startsWith('2026-11-14'));
  assert.equal(r.items[0].image, 'https://contoh.com/img/satu.jpg');
  assert.ok(r.items[1].summary.includes('Pedagang'));
  assert.equal(r.meta.feedLinks.length, 1);
});

const LIST_PAGE = `<html><head><title>Kategori</title></head><body>
<nav><a href="/">Home</a><a href="/tag/berita">Berita</a></nav>
<ul class="post-list">
  <li><a href="/2026/11/artikel-satu">Artikel satu tentang ekonomi digital</a></li>
  <li><a href="/2026/11/artikel-dua">Artikel dua tentang energi terbarukan</a></li>
  <li><a href="/2026/11/artikel-tiga">Artikel tiga tentang pendidikan anak</a></li>
  <li><a href="/2026/11/artikel-empat">Artikel empat tentang transportasi kota</a></li>
  <li><a href="/2026/11/artikel-lima">Artikel lima tentang kesehatan mental</a></li>
</ul>
</body></html>`;

test('extractPage: daftar <ul> berulang', () => {
  const r = extractPage(LIST_PAGE, 'https://contoh.com/kategori');
  assert.equal(r.items.length, 5);
  assert.equal(r.items[0].link, 'https://contoh.com/2026/11/artikel-satu');
  assert.ok(!r.items.some((i) => i.link === 'https://contoh.com/'));
});

const JSONLD_PAGE = `<html><head><title>Blog</title>
<script type="application/ld+json">
{"@context":"https://schema.org","@type":"ItemList","itemListElement":[
 {"@type":"ListItem","item":{"@type":"BlogPosting","url":"https://contoh.com/a","name":"Judul A dari JSON-LD","datePublished":"2026-10-01T00:00:00Z"}},
 {"@type":"ListItem","item":{"@type":"BlogPosting","url":"https://contoh.com/b","name":"Judul B dari JSON-LD","datePublished":"2026-10-02T00:00:00Z"}}
]}
</script></head><body><div>Halo</div></body></html>`;

test('extractPage: JSON-LD ItemList', () => {
  const r = extractPage(JSONLD_PAGE, 'https://contoh.com/');
  assert.ok(r.items.length >= 2);
  assert.equal(r.items[0].title, 'Judul A dari JSON-LD');
});

test('extractPage: filter kata kunci', () => {
  const r = extractPage(LIST_PAGE, 'https://contoh.com/kategori', { filter: 'energi' });
  assert.equal(r.items.length, 1);
  assert.ok(r.items[0].link.includes('artikel-dua'));
});

test('extractPage: halaman tanpa daftar -> 0 item', () => {
  const r = extractPage('<html><body><h1>Tentang</h1><p>Hanya satu paragraf.</p></body></html>', 'https://contoh.com/tentang');
  assert.equal(r.items.length, 0);
});

/* ---------------- feed asli ---------------- */

const RSS_XML = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
<title>Feed Contoh</title><link>https://contoh.com</link>
<description>Deskripsi</description><language>id</language>
<item>
  <title><![CDATA[Judul item pertama]]></title>
  <link>https://contoh.com/1</link>
  <pubDate>Sat, 14 Nov 2026 08:00:00 +0700</pubDate>
  <description><![CDATA[<p>Isi <b>tebal</b></p>]]></description>
</item>
</channel></rss>`;

test('parseFeedXml: RSS 2.0', () => {
  const r = parseFeedXml(RSS_XML, 10);
  assert.equal(r.feed.title, 'Feed Contoh');
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].link, 'https://contoh.com/1');
  assert.equal(r.items[0].summary, 'Isi tebal');
  assert.equal(r.items[0].date.slice(0, 10), '2026-11-14');
});

const ATOM_XML = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
<title>Atom Contoh</title><subtitle>Sub</subtitle>
<link rel="alternate" href="https://contoh.com"/>
<entry>
  <title>Entri satu</title>
  <link rel="alternate" href="https://contoh.com/e1"/>
  <published>2026-09-01T00:00:00Z</published>
  <summary>Ringkasan entri</summary>
</entry>
</feed>`;

test('parseFeedXml: Atom', () => {
  const r = parseFeedXml(ATOM_XML, 10);
  assert.equal(r.feed.title, 'Atom Contoh');
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].link, 'https://contoh.com/e1');
  assert.equal(r.items[0].title, 'Entri satu');
});

/* ---------------- rendering ---------------- */

test('buildRss: escaping & struktur', () => {
  const xml = buildRss({
    feed: { title: 'A & B', description: 'Desc', link: 'https://contoh.com', language: 'id' },
    items: [
      { title: 'Satu & dua', link: 'https://contoh.com/1?a=1&b=2', summary: 'Ringkasan <b>', date: '2026-11-14T08:00:00.000Z' },
    ],
    selfUrl: 'https://app.workers.dev/feed?url=x',
    ttl: 900,
  });
  assert.ok(xml.startsWith('<?xml'));
  assert.ok(xml.includes('<title>A &amp; B</title>'));
  assert.ok(xml.includes('<link>https://contoh.com/1?a=1&amp;b=2</link>'));
  assert.ok(xml.includes('<pubDate>'));
  assert.ok(xml.includes('rel="self"'));
  // harus bisa ditutup-tag seimbang
  const opens = (xml.match(/<item>/g) || []).length;
  const closes = (xml.match(/<\/item>/g) || []).length;
  assert.equal(opens, closes);
});

test('esc: buang karakter kontrol ilegal', () => {
  assert.equal(esc('a\u0000b\u0008c'), 'abc');
});

/* ---------------- validitas ---------------- */

test('validateFeedXml: RSS hasil buildRss valid', () => {
  const xml = buildRss({
    feed: { title: 'Feed Uji', description: 'Desc', link: 'https://contoh.com', language: 'id' },
    items: [{ title: 'Satu', link: 'https://contoh.com/1', summary: 'Ringkasan', date: '2026-11-14T08:00:00.000Z' }],
    selfUrl: 'https://contoh.com/feeds/x.xml',
    ttl: 900,
  });
  const v = validateFeedXml(xml);
  assert.equal(v.ok, true, v.errors.join('; '));
  assert.equal(v.kind, 'rss');
  assert.equal(v.items, 1);
  assert.equal(v.title, 'Feed Uji');
  assert.equal(v.selfUrl, 'https://contoh.com/feeds/x.xml');
});

test('validateFeedXml: RSS asli dari RSS_XML diterima', () => {
  const v = validateFeedXml(RSS_XML);
  assert.equal(v.ok, true, v.errors.join('; '));
  assert.equal(v.items, 1);
});

test('validateFeedXml: akar bukan rss/feed ditolak', () => {
  const v = validateFeedXml('<html><body>halo</body></html>');
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => e.includes('akar dokumen')));
});

test('validateXml: tag tidak ditutup -> tidak valid', () => {
  const v = validateXml('<rss><channel><title>X</title></channel>');
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => e.includes('belum ditutup')));
});

test('validateXml: tag tidak cocok -> tidak valid', () => {
  const v = validateXml('<a><b></a></b>');
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => e.includes('tidak cocok')));
});

test('validateXml: entity tak terdeklarasi (mis. &nbsp;) -> tidak valid', () => {
  const v = validateXml('<p>a&nbsp;b</p>');
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => e.includes('tidak dideklarasikan')));
});

test('validateXml: entity terdeklarasi di DOCTYPE diterima', () => {
  const v = validateXml('<!DOCTYPE rss [<!ENTITY nbsp "&#160;">]><p>a&nbsp;b</p>');
  assert.equal(v.ok, true, v.errors.join('; '));
});

test('validateXml: CDATA tidak ditutup -> tidak valid', () => {
  const v = validateXml('<a><![CDATA[isi tanpa akhir</a>');
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => e.includes('CDATA')));
});

test('validateXml: karakter kontrol ilegal -> tidak valid', () => {
  const v = validateXml('<a>be' + String.fromCharCode(7) + 'las</a>');
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => e.includes('kontrol')));
});

test('validateJsonFeed: JSON Feed 1.1 valid', () => {
  const json = buildJsonFeed({
    feed: { title: 'Feed Uji', description: 'Desc', link: 'https://contoh.com' },
    items: [{ title: 'Satu', link: 'https://contoh.com/1', summary: 'Ringkasan', date: '2026-11-14T08:00:00.000Z' }],
    selfUrl: 'https://contoh.com/feeds/x.json',
    ttl: 900,
  });
  const v = validateJsonFeed(json);
  assert.equal(v.ok, true, v.errors.join('; '));
  assert.equal(v.items, 1);
});

test('validateJsonFeed: bukan JSON / items hilang ditolak', () => {
  assert.equal(validateJsonFeed('<xml/>').ok, false);
  const v = validateJsonFeed('{"version":"https://jsonfeed.org/version/1.1","title":"X"}');
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => e.includes('items')));
});

test('validatePair: XML & JSON jumlah item sama -> ok', () => {
  const feed = { title: 'Feed Uji', description: 'Desc', link: 'https://contoh.com' };
  const items = [{ title: 'Satu', link: 'https://contoh.com/1', summary: 'R', date: '2026-11-14T08:00:00.000Z' }];
  const xml = buildRss({ feed, items, selfUrl: 'https://contoh.com/feeds/x.xml', ttl: 900 });
  const json = buildJsonFeed({ feed, items, selfUrl: 'https://contoh.com/feeds/x.json', ttl: 900 });
  const v = validatePair(xml, json);
  assert.equal(v.ok, true, v.errors.join('; '));
});

test('validatePair: feed tanpa item ditolak', () => {
  const feed = { title: 'Feed Uji', description: 'Desc', link: 'https://contoh.com' };
  const xml = buildRss({ feed, items: [], selfUrl: 'https://contoh.com/feeds/x.xml', ttl: 900 });
  const json = buildJsonFeed({ feed, items: [], selfUrl: 'https://contoh.com/feeds/x.json', ttl: 900 });
  const v = validatePair(xml, json);
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => e.includes('tidak berisi item')));
});

/* ---------------- hasil ---------------- */

console.log('');
console.log(`${pass} lulus, ${fail} gagal`);
if (fail) process.exit(1);
