/* RSS Anywhere — logika UI */

const $ = (id) => document.getElementById(id);

const els = {
  form: $('feed-form'),
  url: $('url'),
  submit: $('submit-btn'),
  limit: $('limit'),
  ttl: $('ttl'),
  filter: $('filter'),
  mode: $('mode'),
  status: $('status'),
  result: $('result'),
  resultTitle: $('result-title'),
  resultMeta: $('result-meta'),
  sourceDot: $('source-dot'),
  badges: $('badges'),
  feedUrl: $('feed-url'),
  copyBtn: $('copy-btn'),
  copyMd: $('copy-md'),
  openXml: $('open-xml'),
  openJson: $('open-json'),
  feedly: $('add-feedly'),
  inoreader: $('add-inoreader'),
  warnings: $('warnings'),
  items: $('items'),
  previewCount: $('preview-count'),
  historyCard: $('history-card'),
  history: $('history'),
  clearHistory: $('clear-history'),
};

const SOURCE_LABEL = {
  native: 'Feed asli ditemukan',
  'native-json': 'JSON Feed asli',
  html: 'Diekstrak dari HTML',
  sitemap: 'Diambil dari sitemap.xml',
};

const HISTORY_KEY = 'rss-anywhere:history';

/* ------------------------------------------------------------------ */
/* Util                                                               */
/* ------------------------------------------------------------------ */

function normalizeInput(value) {
  let v = String(value || '').trim();
  if (!v) return '';
  if (v.startsWith('//')) v = 'https:' + v;
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(v)) v = 'https://' + v;
  return v;
}

function readOptions() {
  return {
    limit: Number(els.limit.value) || 20,
    ttl: Number(els.ttl.value) || 900,
    filter: els.filter.value.trim(),
    mode: els.mode.value || 'auto',
  };
}

function queryString(target, opts) {
  const p = new URLSearchParams();
  p.set('url', target);
  if (opts.limit && opts.limit !== 20) p.set('limit', String(opts.limit));
  if (opts.ttl && opts.ttl !== 900) p.set('ttl', String(opts.ttl));
  if (opts.filter) p.set('filter', opts.filter);
  if (opts.mode && opts.mode !== 'auto') p.set('mode', opts.mode);
  return p.toString();
}

function feedUrlFor(target, opts) {
  return location.origin + '/feed?' + queryString(target, opts);
}

function jsonUrlFor(target, opts) {
  return location.origin + '/feed.json?' + queryString(target, opts);
}

function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; }
}

function prettyDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  try {
    return new Intl.DateTimeFormat('id-ID', { dateStyle: 'medium', timeStyle: 'short' }).format(d);
  } catch {
    return d.toISOString().slice(0, 16).replace('T', ' ');
  }
}

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = text;
  return node;
}

/* ------------------------------------------------------------------ */
/* Status & hasil                                                     */
/* ------------------------------------------------------------------ */

function showLoading(target) {
  els.status.className = 'card status';
  els.status.innerHTML = '';
  els.status.append(el('div', 'spinner'), el('span', '', 'Mengambil ' + hostOf(target) + ' …'));
  els.result.classList.add('hidden');
}

function showError(message, hint) {
  els.status.className = 'card status error';
  els.status.innerHTML = '';
  const box = el('div');
  box.append(el('strong', '', message || 'Gagal membuat feed.'));
  if (hint) box.append(el('div', 'tiny muted', hint));
  els.status.append(box);
  els.result.classList.add('hidden');
}

function hideStatus() {
  els.status.className = 'card status hidden';
  els.status.innerHTML = '';
}

async function copyText(text, button) {
  let ok = false;
  try {
    await navigator.clipboard.writeText(text);
    ok = true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.append(ta);
    ta.select();
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    ta.remove();
  }
  if (ok && button) {
    const old = button.textContent;
    button.textContent = 'Tersalin ✓';
    setTimeout(() => { button.textContent = old; }, 1400);
  }
  return ok;
}

function renderResult(data) {
  hideStatus();
  els.result.classList.remove('hidden');

  const source = data.source || 'html';
  els.sourceDot.className = 'dot ' + (source === 'html' || source === 'sitemap' ? source : '');

  const title = data.feed && data.feed.title ? data.feed.title : hostOf(data.targetUrl || els.url.value);
  els.resultTitle.textContent = title;
  els.resultMeta.textContent = (SOURCE_LABEL[source] || source) + ' · ' + data.count + ' item · '
    + (data.elapsedMs / 1000).toFixed(1) + ' detik';

  els.badges.innerHTML = '';
  const dots = [
    source === 'native' || source === 'native-json' ? 'feed asli' : 'ekstraksi',
    hostOf(data.sourceUrl || data.targetUrl || ''),
  ];
  for (const text of dots) {
    if (text) els.badges.append(el('span', 'badge', text));
  }

  els.feedUrl.value = data.feedUrl || '';
  els.openXml.href = data.feedUrl || '#';
  els.openJson.href = data.jsonFeedUrl || '#';
  els.feedly.href = 'https://feedly.com/i/subscription/feed/' + encodeURIComponent(data.feedUrl || '');
  els.inoreader.href = 'https://www.inoreader.com/?add_feed=' + encodeURIComponent(data.feedUrl || '');

  els.warnings.innerHTML = '';
  if (data.warnings && data.warnings.length) {
    els.warnings.classList.remove('hidden');
    for (const w of data.warnings) els.warnings.append(el('li', '', w));
  } else {
    els.warnings.classList.add('hidden');
  }

  els.items.innerHTML = '';
  const items = data.items || [];
  els.previewCount.textContent = items.length ? 'menampilkan ' + items.length + ' dari ' + data.count : '';
  if (!items.length) {
    const li = el('li');
    li.append(el('span', 'sum', 'Tidak ada item yang bisa dibaca di halaman ini. Coba URL halaman kategori/daftar artikel, bukan halaman tunggal.'));
    els.items.append(li);
  }
  for (const item of items) {
    const li = el('li');
    const a = el('a', '', item.title || item.link);
    a.href = item.link;
    a.target = '_blank';
    a.rel = 'noreferrer';
    li.append(a);

    const meta = [hostOf(item.link), prettyDate(item.date)].filter(Boolean).join(' · ');
    if (meta) li.append(el('div', 'meta', meta));
    if (item.summary) li.append(el('div', 'sum', item.summary.length > 220 ? item.summary.slice(0, 219) + '…' : item.summary));
    els.items.append(li);
  }

  if (data.feedUrl) remember(data.feedUrl, title);
  els.result.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

/* ------------------------------------------------------------------ */
/* Riwayat                                                            */
/* ------------------------------------------------------------------ */

function loadHistory() {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list : [];
  } catch { return []; }
}

function saveHistory(list) {
  try { localStorage.setItem(HISTORY_KEY, JSON.stringify(list.slice(0, 10))); } catch { /* ignore */ }
}

function remember(feedUrl, title) {
  const list = loadHistory().filter((x) => x && x.feedUrl !== feedUrl);
  list.unshift({ feedUrl, title: title || hostOf(feedUrl), at: Date.now() });
  saveHistory(list);
  renderHistory();
}

function renderHistory() {
  const list = loadHistory();
  els.history.innerHTML = '';
  if (!list.length) {
    els.historyCard.classList.add('hidden');
    return;
  }
  els.historyCard.classList.remove('hidden');
  for (const entry of list) {
    const row = el('div', 'history-item');
    row.append(el('span', '', entry.title || entry.feedUrl));
    const open = el('button', '', 'Buka');
    open.addEventListener('click', () => {
      try {
        const u = new URL(entry.feedUrl);
        els.url.value = u.searchParams.get('url') || '';
        run(els.url.value);
      } catch { /* ignore */ }
    });
    row.append(open);
    els.history.append(row);
  }
}

/* ------------------------------------------------------------------ */
/* Alur utama                                                         */
/* ------------------------------------------------------------------ */

let controller = null;

async function run(rawTarget) {
  const target = normalizeInput(rawTarget);
  if (!target) { els.url.focus(); return; }

  els.url.value = target;
  const opts = readOptions();
  showLoading(target);
  els.submit.disabled = true;

  if (controller) controller.abort();
  controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 45000);

  try {
    const res = await fetch('/api/preview?' + queryString(target, opts), {
      signal: controller.signal,
      headers: { accept: 'application/json' },
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data || data.ok === false) {
      showError((data && data.error) || ('Gagal (HTTP ' + res.status + ')'), (data && data.hint) || '');
      return;
    }
    renderResult(data);
  } catch (err) {
    if (err && err.name === 'AbortError') showError('Waktu habis.', 'Sumber terlalu lambat. Coba lagi atau naikkan cache TTL.');
    else showError('Tidak bisa menghubungi server feed.', String(err && err.message ? err.message : err));
  } finally {
    clearTimeout(timer);
    els.submit.disabled = false;
  }
}

els.form.addEventListener('submit', (e) => {
  e.preventDefault();
  run(els.url.value);
});

els.copyBtn.addEventListener('click', () => copyText(els.feedUrl.value, els.copyBtn));
els.feedUrl.addEventListener('focus', () => els.feedUrl.select());

els.copyMd.addEventListener('click', () => {
  const title = els.resultTitle.textContent || 'Feed';
  copyText('[' + title + '](' + els.feedUrl.value + ')', els.copyMd);
});

for (const btn of document.querySelectorAll('#examples button')) {
  btn.addEventListener('click', () => run(btn.dataset.url));
}

els.clearHistory.addEventListener('click', () => {
  try { localStorage.removeItem(HISTORY_KEY); } catch { /* ignore */ }
  renderHistory();
});

renderHistory();

const initial = new URLSearchParams(location.search).get('url');
if (initial) run(initial);
