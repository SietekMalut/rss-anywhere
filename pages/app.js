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
    el('li', { text: 'Link feed di bawah aktif otomatis — statusnya berubah sendiri saat sudah tayang.' }),
  ]));
  box.appendChild(el('a', { class: 'primary link', href: issueUrl, target: '_blank', rel: 'noreferrer', text: 'Buka halaman GitHub untuk ' + hostOf(url) }));
  box.appendChild(el('p', { class: 'hint', text: 'Kalau tab baru tidak terbuka otomatis, klik tombol di atas.' }));
  return box;
}

/* ------------------------------------------------------------------ */
/* Link deterministik: bisa dihitung di browser, sama dengan yang      */
/* dibuat scripts/lib/id.mjs (host + path + sha1(URL) 6 karakter).     */
/* ------------------------------------------------------------------ */

function slugOf(url) {
  const u = new URL(url);
  return (u.hostname + u.pathname)
    .toLowerCase()
    .replace(/^www\./, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'feed';
}

async function feedIdFor(rawUrl) {
  const u = new URL(rawUrl);
  u.hash = '';
  const bytes = new TextEncoder().encode(u.href);
  const digest = await crypto.subtle.digest('SHA-1', bytes);
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 6);
  return slugOf(u.href) + '-' + hex;
}

function siteBase() {
  return new URL('./', location.href).href;
}

/** Tampilkan link yang sedang disiapkan + status live-nya. */
function showPending(box, feedUrl, jsonUrl) {
  const status = el('span', { class: 'badge warn', text: 'menunggu' });

  const input = el('input', { type: 'text', readonly: true, value: feedUrl, class: 'mono' });
  const copy = el('button', { type: 'button', class: 'primary', text: 'Salin link' });
  copy.addEventListener('click', async () => {
    const ok = await copyText(feedUrl);
    copy.textContent = ok ? 'Tersalin ✓' : 'Gagal menyalin';
    setTimeout(() => { copy.textContent = 'Salin link'; }, 1600);
  });

  const wrap = el('div', { class: 'pending' }, [
    el('p', { class: 'pending-head' }, [el('strong', { text: 'Link feed Anda ' }), status]),
    input,
    el('div', { class: 'feed-actions' }, [
      copy,
      el('a', { class: 'chip', href: feedUrl, target: '_blank', rel: 'noreferrer', text: 'Cek XML' }),
      el('a', { class: 'chip', href: jsonUrl, target: '_blank', rel: 'noreferrer', text: 'JSON' }),
    ]),
    el('p', { class: 'hint', text: 'Link ini tidak berubah. Biasanya aktif dalam ±30 detik setelah issue dikirim.' }),
  ]);
  box.appendChild(wrap);

  return { wrap, status, feedUrl };
}

async function pollLive(pending, tries) {
  const max = tries || 60;
  for (let i = 0; i < max; i++) {
    if (!pending.wrap.isConnected) return false;
    try {
      const res = await fetch(pending.feedUrl + '?t=' + Date.now(), { cache: 'no-store' });
      if (res.ok) {
        const text = await res.text();
        const looksRss = /<rss[\s>]|<feed[\s>]/i.test(text.slice(0, 800));
        const hasItems = /<(item|entry)([\s>])/i.test(text);
        if (looksRss && hasItems) {
          pending.status.className = 'badge ok';
          pending.status.textContent = 'aktif ✓';
          pending.wrap.classList.add('live');
          load();
          return true;
        }
      }
    } catch { /* belum tayang, coba lagi */ }
    await new Promise((r) => setTimeout(r, 4000));
  }
  pending.status.className = 'badge bad';
  pending.status.textContent = 'belum aktif';
  return false;
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

  const box = showNext(href, issueUrl);
  const win = window.open(issueUrl, '_blank', 'noopener');
  if (!win) {
    // popup diblokir: tombol manual di kartu "next" tetap bisa dipakai
    box.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }

  // Link bisa dihitung langsung di browser, jadi pengguna tidak perlu menunggu
  // komentar bot: cukup salin sekarang, statusnya menyusul.
  feedIdFor(href).then((id) => {
    const base = siteBase();
    const pending = showPending(box, base + 'feeds/' + id + '.xml', base + 'feeds/' + id + '.json');
    pending.status.textContent = 'menunggu';
    pollLive(pending);
  }).catch(() => {
    box.appendChild(el('p', { class: 'hint', text: 'Link akan dikirim di komentar issue setelah build selesai.' }));
  });
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
