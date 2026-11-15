/**
 * pages/app.js
 * UI statis untuk feed yang dibangun GitHub Actions.
 * Tidak ada backend: daftar feed dibaca dari feeds.json,
 * penambahan feed baru lewat GitHub Issue yang sudah terisi otomatis.
 */

const REPO_FALLBACK = 'SietekMalut/rss-anywhere';

const $ = (id) => document.getElementById(id);
const state = { feeds: [], query: '', generatedAt: null };

function repoSlug() {
  const parts = location.pathname.split('/').filter(Boolean);
  if (location.hostname.endsWith('github.io') && parts.length >= 2) {
    return parts[0] + '/' + parts[1];
  }
  return REPO_FALLBACK;
}

function normalizeUrl(raw) {
  let value = String(raw || '').trim();
  if (!value) return null;
  if (!/^https?:\/\//i.test(value)) value = 'https://' + value.replace(/^\/+/, '');
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (!url.hostname.includes('.')) return null;
    return url;
  } catch {
    return null;
  }
}

function hostOf(u) {
  try {
    return new URL(u).hostname.replace(/^www\./, '');
  } catch {
    return u;
  }
}

/** Kunci pembanding: abaikan www., garis miring di akhir, dan huruf besar. */
function matchKey(raw) {
  const u = normalizeUrl(raw);
  if (!u) return null;
  return (u.hostname.replace(/^www\./, '') + u.pathname.replace(/\/+$/, '') + u.search).toLowerCase();
}

function pathOf(u) {
  try {
    const url = new URL(u);
    const p = url.pathname.replace(/\/$/, '');
    return p === '' ? '' : p;
  } catch {
    return '';
  }
}

function timeAgo(iso) {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return '';
  const diff = Math.max(0, Date.now() - then);
  const min = Math.round(diff / 60000);
  if (min < 1) return 'baru saja';
  if (min < 60) return min + ' menit lalu';
  const hour = Math.round(min / 60);
  if (hour < 24) return hour + ' jam lalu';
  const day = Math.round(hour / 24);
  if (day < 30) return day + ' hari lalu';
  return new Date(iso).toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: 'numeric' });
}

function stamp(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return 'Diperbarui ' + d.toLocaleString('id-ID', { dateStyle: 'medium', timeStyle: 'short' });
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const el = document.createElement('textarea');
    el.value = text;
    el.setAttribute('readonly', '');
    el.style.position = 'fixed';
    el.style.opacity = '0';
    document.body.appendChild(el);
    el.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    el.remove();
    return ok;
  }
}

function el(tag, attrs, children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'text') node.textContent = v;
    else if (k === 'class') node.className = v;
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else node.setAttribute(k, v === true ? '' : String(v));
  }
  for (const child of children || []) if (child) node.appendChild(child);
  return node;
}

function badge(source) {
  const map = {
    native: ['feed asli', 'ok'],
    path: ['feed asli', 'ok'],
    html: ['dari HTML', 'warn'],
    sitemap: ['dari sitemap', 'warn'],
    error: ['gagal', 'bad'],
  };
  const [label, tone] = map[source] || [source || 'feed', ''];
  return el('span', { class: 'badge ' + tone, text: label });
}

function feedItem(feed) {
  const title = el('div', { class: 'feed-title' }, [
    el('span', { text: feed.title || hostOf(feed.url) }),
    badge(feed.error ? 'error' : feed.source),
  ]);

  const source = el('a', {
    class: 'feed-src',
    href: feed.url,
    target: '_blank',
    rel: 'noreferrer',
    text: hostOf(feed.url) + pathOf(feed.url),
  });

  const meta = el('div', {
    class: 'feed-meta',
    text: feed.error
      ? (feed.feedUrl ? 'Pengambilan terakhir gagal — memakai hasil sebelumnya. ' : 'Pengambilan gagal: ') + feed.error
      : feed.count + ' item · diperbarui ' + timeAgo(feed.updatedAt),
  });

  const actions = el('div', { class: 'feed-actions' });
  if (feed.feedUrl) {
    const copy = el('button', { type: 'button', class: 'chip strong', text: 'Salin link' });
    copy.addEventListener('click', async () => {
      const ok = await copyText(feed.feedUrl);
      copy.textContent = ok ? 'Tersalin ✓' : 'Gagal menyalin';
      setTimeout(() => { copy.textContent = 'Salin link'; }, 1600);
    });
    actions.appendChild(copy);
    actions.appendChild(el('a', { class: 'chip', href: feed.feedUrl, target: '_blank', rel: 'noreferrer', text: 'XML' }));
    actions.appendChild(el('a', {
      class: 'chip',
      href: 'https://feedly.com/i/subscription/feed/' + encodeURIComponent(feed.feedUrl),
      target: '_blank',
      rel: 'noreferrer',
      text: 'Feedly',
    }));
    actions.appendChild(el('a', {
      class: 'chip',
      href: 'https://www.inoreader.com/?add_feed=' + encodeURIComponent(feed.feedUrl),
      target: '_blank',
      rel: 'noreferrer',
      text: 'Inoreader',
    }));
    if (feed.jsonUrl) actions.appendChild(el('a', { class: 'chip', href: feed.jsonUrl, target: '_blank', rel: 'noreferrer', text: 'JSON' }));
  }

  return el('li', { class: 'feed', dataset: { id: feed.id } }, [
    el('div', { class: 'feed-main' }, [title, source, meta]),
    actions,
  ]);
}

function render() {
  const list = $('feeds');
  const q = state.query.trim().toLowerCase();
  const feeds = state.feeds.filter((f) => {
    if (!q) return true;
    return (f.title || '').toLowerCase().includes(q) || (f.url || '').toLowerCase().includes(q);
  });

  list.textContent = '';
  for (const feed of feeds) list.appendChild(feedItem(feed));

  const total = state.feeds.length;
  $('count').textContent = String(total);
  $('empty').classList.toggle('hidden', total > 0);
  $('empty').textContent = total === 0
    ? 'Belum ada feed. Tambahkan URL di atas.'
    : 'Tidak ada yang cocok dengan pencarian.';
  $('updated').textContent = stamp(state.generatedAt);
}

async function load() {
  try {
    const res = await fetch('feeds.json?t=' + Date.now(), { cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    state.feeds = Array.isArray(data.feeds) ? data.feeds : [];
    state.generatedAt = data.generatedAt || null;
    render();
  } catch (err) {
    $('updated').textContent = 'Gagal memuat daftar feed: ' + (err && err.message ? err.message : err);
  }
}

function showMatch(feed) {
  const box = $('match');
  box.textContent = '';
  box.classList.remove('hidden');
  box.appendChild(el('p', { text: 'URL ini sudah punya feed:' }));
  box.appendChild(el('input', { type: 'text', readonly: true, value: feed.feedUrl, class: 'mono' }));
  const copy = el('button', { type: 'button', class: 'primary', text: 'Salin link feed' });
  copy.addEventListener('click', async () => {
    const ok = await copyText(feed.feedUrl);
    copy.textContent = ok ? 'Tersalin ✓' : 'Gagal menyalin';
    setTimeout(() => { copy.textContent = 'Salin link feed'; }, 1600);
  });
  box.appendChild(copy);
  document.querySelector('[data-id="' + feed.id + '"]')?.scrollIntoView({ block: 'center', behavior: 'smooth' });
}

function showFailed(feed) {
  const box = $('match');
  box.textContent = '';
  box.classList.remove('hidden');
  box.appendChild(el('p', { text: 'URL ini sudah terdaftar, tetapi pengambilan terakhir gagal.' }));
  box.appendChild(el('p', { class: 'hint', text: feed.error || 'Situs menolak permintaan. Coba URL halaman lain.' }));
  if (feed.url) {
    box.appendChild(el('a', { class: 'primary link', href: 'https://github.com/' + repoSlug() + '/issues/new?' + new URLSearchParams({ title: '[feed] ' + feed.url }).toString(), target: '_blank', rel: 'noreferrer', text: 'Minta coba ulang lewat issue' }));
  }
}

function showNext(url, issueUrl) {
  const box = $('next');
  box.textContent = '';
  box.classList.remove('hidden');

  box.appendChild(el('h3', { text: 'Satu klik lagi di GitHub' }));
  box.appendChild(el('ol', { class: 'steps tight' }, [
    el('li', { text: 'Halaman GitHub terbuka dengan judul dan isi issue yang sudah terisi.' }),
    el('li', { text: 'Klik "Submit new issue" (login GitHub dulu kalau diminta).' }),
    el('li', { text: 'Tunggu ±1 menit — link feed muncul di komentar issue dan di daftar halaman ini.' }),
  ]));
  box.appendChild(el('a', { class: 'primary link', href: issueUrl, target: '_blank', rel: 'noreferrer', text: 'Buka halaman GitHub untuk ' + hostOf(url) }));
  box.appendChild(el('p', { class: 'hint', text: 'Kalau tab baru tidak terbuka otomatis, klik tombol di atas.' }));
}

function submit(ev) {
  ev.preventDefault();
  const url = normalizeUrl($('url').value);
  $('match').classList.add('hidden');
  $('next').classList.add('hidden');

  if (!url) {
    $('url').focus();
    $('url').classList.add('invalid');
    setTimeout(() => $('url').classList.remove('invalid'), 1200);
    return;
  }

  const href = url.href;
  const key = matchKey(href);
  const found = state.feeds.find((f) => matchKey(f.url) === key);
  if (found && found.feedUrl) {
    showMatch(found);
    return;
  }
  if (found) {
    showFailed(found);
    return;
  }

  const issueUrl = 'https://github.com/' + repoSlug() + '/issues/new?' + new URLSearchParams({
    title: '[feed] ' + href,
    body: 'URL: ' + href + '\n\nOpsional (boleh dihapus):\nfilter: \nlimit: 20\n',
  }).toString();

  showNext(href, issueUrl);
  const win = window.open(issueUrl, '_blank', 'noopener');
  if (!win) {
    // popup diblokir: tombol manual di kartu "next" tetap bisa dipakai
    $('next').scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
}

$('add-form').addEventListener('submit', submit);
$('search').addEventListener('input', (ev) => {
  state.query = ev.target.value;
  render();
});

const repo = repoSlug();
$('repo-link').href = 'https://github.com/' + repo;
$('stamp').textContent = '';

load();
setInterval(() => {
  if (!document.hidden) load();
}, 60000);
