/**
 * scripts/bench.mjs — ukur biaya CPU parse + ekstraksi (perkiraan batas Workers 10ms).
 */

import { parseHtml, extractFromRoot, readMeta } from '../src/html.js';

const SITES = process.argv.slice(2).length ? process.argv.slice(2) : [
  'https://www.detik.com',
  'https://www.kompas.com',
  'https://www.cnnindonesia.com',
  'https://nextjs.org/blog',
  'https://www.theverge.com',
  'https://github.blog',
];

function time(label, fn) {
  const t0 = performance.now();
  const out = fn();
  return [performance.now() - t0, out];
}

for (const site of SITES) {
  try {
    const res = await fetch(site, {
      headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36' },
      signal: AbortSignal.timeout(20000),
    });
    const html = await res.text();
    // warmup
    parseHtml(html.slice(0, 20000));

    const [tParse, root] = time('parse', () => parseHtml(html));
    const [tMeta] = time('meta', () => readMeta(root, site));
    const [tExtract, result] = time('extract', () => extractFromRoot(root, site, { limit: 20 }));
    console.log(
      site.padEnd(32),
      String(html.length).padStart(8), 'bytes |',
      'parse', tParse.toFixed(1).padStart(5), 'ms |',
      'meta', tMeta.toFixed(1).padStart(4), 'ms |',
      'extract', tExtract.toFixed(1).padStart(6), 'ms |',
      'items', String(result.items.length).padStart(2),
    );
  } catch (err) {
    console.log(site.padEnd(32), 'ERR', err.message);
  }
}
