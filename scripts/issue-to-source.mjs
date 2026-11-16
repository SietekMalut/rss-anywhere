/**
 * scripts/issue-to-source.mjs
 * Membaca GitHub Issue ("[feed] https://contoh.com") lalu menambahkannya
 * ke sources.json. Dipakai oleh .github/workflows/feeds.yml.
 *
 * Hanya issue dari pemilik repo yang diproses (repo publik = siapa pun bisa
 * membuka issue, tapi hanya pemilik yang boleh menambah feed).
 */

import { readFile, writeFile, appendFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { feedId } from './lib/id.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SOURCES_FILE = path.join(HERE, '..', 'sources.json');

const SITE_BASE = (process.env.SITE_BASE || 'https://sietekmalut.github.io/rss-anywhere/').replace(/\/*$/, '/');

const title = process.env.ISSUE_TITLE || '';
const body = process.env.ISSUE_BODY || '';
const author = (process.env.ISSUE_AUTHOR || '').toLowerCase();
const owner = (process.env.REPO_OWNER || '').toLowerCase();

async function out(key, value) {
  const line = `${key}=${String(value).replace(/\r?\n/g, ' ')}\n`;
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, line);
  console.log(line.trim());
}

function extractUrl(text) {
  const match = text.match(/https?:\/\/[^\s<>"')\]]+/i);
  if (!match) return null;
  return match[0].replace(/[.,;:]+$/, '');
}

function extractOption(text, name) {
  const re = new RegExp('(?:^|\\n)\\s*' + name + '\\s*[:=]\\s*(.+)', 'i');
  const m = text.match(re);
  return m ? m[1].trim() : '';
}

function canonical(u) {
  try {
    const url = new URL(u);
    url.hash = '';
    return url.href;
  } catch {
    return null;
  }
}

async function main() {
  await out('allowed', 'false');
  await out('is_new', 'false');
  await out('duplicate', 'false');

  if (!title && !body) return;

  if (author !== owner) {
    console.log('[issue] bukan pemilik repo, diabaikan: ' + author);
    return;
  }
  await out('allowed', 'true');

  const url = extractUrl(title + '\n' + body);
  if (!url) {
    console.log('[issue] tidak ada URL http(s) di issue.');
    return;
  }

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return;

  const key = canonical(url);
  const limitRaw = extractOption(body, 'limit');
  const filter = extractOption(body, 'filter').slice(0, 120);
  const limit = Math.min(100, Math.max(1, Number.parseInt(limitRaw, 10) || 20));

  let doc;
  try {
    doc = JSON.parse(await readFile(SOURCES_FILE, 'utf8'));
  } catch {
    doc = { sources: [] };
  }
  if (!Array.isArray(doc.sources)) doc.sources = [];

  const existing = doc.sources.find((s) => canonical(String(s.url || '')) === key);

  // Kalau URL sudah terdaftar, pakai ID dari URL yang BENAR-BENAR dibangun.
  // build-static memakai s.url apa adanya, jadi ID harus dihitung dari string
  // yang sama — kalau tidak, link yang diumumkan bisa menunjuk file yang tak ada.
  const id = feedId(existing ? String(existing.url) : key);
  await out('feed_id', id);
  await out('feed_url', SITE_BASE + 'feeds/' + id + '.xml');
  await out('feed_json', SITE_BASE + 'feeds/' + id + '.json');

  if (existing) {
    await out('duplicate', 'true');
    console.log('[issue] sudah terdaftar: ' + key + ' -> ' + id);
    return;
  }

  doc.sources.push({
    url: key,
    limit,
    filter,
    mode: 'auto',
    addedAt: new Date().toISOString(),
    addedBy: 'issue',
  });
  await writeFile(SOURCES_FILE, JSON.stringify(doc, null, 2) + '\n', 'utf8');

  await out('is_new', 'true');
  console.log('[issue] ditambahkan: ' + key);
}

main().catch((err) => {
  console.error('[issue] fatal:', err);
  process.exit(1);
});
