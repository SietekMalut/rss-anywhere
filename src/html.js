/**
 * src/html.js
 * Parser HTML minimalis + ekstraksi daftar artikel.
 * Tanpa dependensi apa pun supaya bisa jalan di Cloudflare Workers,
 * Deno, Node 18+, dan Vercel Edge/Node.
 */

const VOID = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr',
]);

// Tag yang isinya tidak diparse sebagai HTML.
const RAW = new Set(['script', 'style', 'textarea', 'title']);

// Tag yang otomatis tertutup saat tag sejenis muncul lagi.
const AUTOCLOSE = {
  li: ['li'],
  p: ['p'],
  dt: ['dt', 'dd'],
  dd: ['dt', 'dd'],
  tr: ['tr', 'td', 'th'],
  td: ['td', 'th'],
  th: ['td', 'th'],
  option: ['option'],
  thead: ['tbody', 'tfoot'],
  tbody: ['tbody', 'tfoot'],
};

const MAX_NODES = 80000;

// Mode XML (untuk membaca feed RSS/Atom): <link> bukan tag kosong.
const XML_VOID = new Set([...VOID].filter((t) => t !== 'link'));
// Di mode XML, <title> boleh berisi CDATA, jadi jangan diperlakukan sebagai raw text.
const XML_RAW = new Set(['script', 'style', 'textarea']);

// Subtree yang isinya tidak mungkin berisi daftar artikel.
const SKIP_CONTENT = new Set(['svg', 'template', 'noscript']);

/* ------------------------------------------------------------------ */
/* Entity decoding                                                     */
/* ------------------------------------------------------------------ */

const NAMED = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0',
  ndash: '\u2013', mdash: '\u2014', hellip: '\u2026', middot: '\u00b7',
  bull: '\u2022', laquo: '\u00ab', raquo: '\u00bb', copy: '\u00a9',
  reg: '\u00ae', trade: '\u2122', deg: '\u00b0', euro: '\u20ac',
  pound: '\u00a3', yen: '\u00a5', cent: '\u00a2', times: '\u00d7',
  divide: '\u00f7', plusmn: '\u00b1', frac12: '\u00bd', frac14: '\u00bc',
  rsquo: '\u2019', lsquo: '\u2018', ldquo: '\u201c', rdquo: '\u201d',
  sbquo: '\u201a', bdquo: '\u201e', lsaquo: '\u2039', rsaquo: '\u203a',
  shy: '\u00ad', ensp: '\u2002', emsp: '\u2003', thinsp: '\u2009',
  zwnj: '\u200c', zwj: '\u200d', lrm: '\u200e', rlm: '\u200f',
  dagger: '\u2020', Dagger: '\u2021', permil: '\u2030', prime: '\u2032',
  Prime: '\u2033', infin: '\u221e', ne: '\u2260', le: '\u2264', ge: '\u2265',
  aacute: '\u00e1', agrave: '\u00e0', acirc: '\u00e2', atilde: '\u00e3',
  auml: '\u00e4', aring: '\u00e5', aelig: '\u00e6', ccedil: '\u00e7',
  eacute: '\u00e9', egrave: '\u00e8', ecirc: '\u00ea', euml: '\u00eb',
  iacute: '\u00ed', igrave: '\u00ec', icirc: '\u00ee', iuml: '\u00ef',
  ntilde: '\u00f1', oacute: '\u00f3', ograve: '\u00f2', ocirc: '\u00f4',
  otilde: '\u00f5', ouml: '\u00f6', oslash: '\u00f8', uacute: '\u00fa',
  ugrave: '\u00f9', ucirc: '\u00fb', uuml: '\u00fc', yacute: '\u00fd',
  yuml: '\u00ff', szlig: '\u00df', Aacute: '\u00c1', Eacute: '\u00c9',
  Iacute: '\u00cd', Oacute: '\u00d3', Uacute: '\u00da', Ntilde: '\u00d1',
  Uuml: '\u00dc', Ouml: '\u00d6', Auml: '\u00c4',
};

export function decodeEntities(input) {
  const s = String(input == null ? '' : input);
  if (s.indexOf('&') === -1) return s;
  return s.replace(/&(#[xX]?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]{1,31});/g, (match, group) => {
    if (group[0] === '#') {
      const hex = group[1] === 'x' || group[1] === 'X';
      const cp = hex ? parseInt(group.slice(2), 16) : parseInt(group.slice(1), 10);
      if (!Number.isFinite(cp) || cp <= 0 || cp > 0x10ffff) return match;
      try {
        return String.fromCodePoint(cp);
      } catch {
        return match;
      }
    }
    const v = NAMED[group] !== undefined ? NAMED[group] : NAMED[group.toLowerCase()];
    return v === undefined ? match : v;
  });
}

/* ------------------------------------------------------------------ */
/* Tokenizer / tree builder                                            */
/* ------------------------------------------------------------------ */

function makeNode(tag, attrs) {
  return { tag, attrs: attrs || {}, children: [] };
}

function isWs(c) {
  return c === 32 || c === 9 || c === 10 || c === 13 || c === 12;
}

function isNameChar(c) {
  return (c >= 97 && c <= 122) // a-z
    || (c >= 65 && c <= 90) // A-Z
    || (c >= 48 && c <= 57) // 0-9
    || c === 58 || c === 95 || c === 45; // : _ -
}

function parseAttributes(src) {
  const attrs = {};
  const len = src.length;
  let i = 0;
  while (i < len) {
    let c = src.charCodeAt(i);
    while (i < len && (isWs(c) || c === 47)) { i++; c = src.charCodeAt(i); }
    if (i >= len) break;
    const nameStart = i;
    while (i < len) {
      c = src.charCodeAt(i);
      if (isWs(c) || c === 61 || c === 47 || c === 62) break;
      i++;
    }
    const name = src.slice(nameStart, i).toLowerCase();
    if (!name) { i++; continue; }
    while (i < len && isWs(src.charCodeAt(i))) i++;
    let value = '';
    if (src.charCodeAt(i) === 61) {
      i++;
      while (i < len && isWs(src.charCodeAt(i))) i++;
      const q = src.charCodeAt(i);
      if (q === 34 || q === 39) {
        i++;
        const vs = i;
        while (i < len && src.charCodeAt(i) !== q) i++;
        value = src.slice(vs, i);
        i++;
      } else {
        const vs = i;
        while (i < len) {
          const cc = src.charCodeAt(i);
          if (isWs(cc) || cc === 62) break;
          i++;
        }
        value = src.slice(vs, i);
      }
    }
    if (attrs[name] === undefined) attrs[name] = decodeEntities(value);
  }
  return attrs;
}

/**
 * Ubah string HTML menjadi pohon node sederhana.
 * Node: { tag, attrs, children } atau { tag: '#text', text }
 * @param {string} input
 * @param {{xml?: boolean}} [options] xml=true untuk membaca dokumen RSS/Atom
 */
export function parseHtml(input, options) {
  const xmlMode = !!(options && options.xml);
  const voidSet = xmlMode ? XML_VOID : VOID;
  const rawSet = xmlMode ? XML_RAW : RAW;
  const autoclose = xmlMode ? null : AUTOCLOSE;

  const html = String(input == null ? '' : input);
  const lower = html.toLowerCase();
  const root = makeNode('#root');
  const stack = [root];
  let i = 0;
  let nodes = 1;

  const pushText = (raw, literal) => {
    if (!raw) return;
    const parent = stack[stack.length - 1];
    const text = literal ? raw : decodeEntities(raw);
    const prev = parent.children[parent.children.length - 1];
    if (prev && prev.tag === '#text') prev.text += text;
    else parent.children.push({ tag: '#text', text, parent });
    nodes++;
  };

  const push = (node) => {
    node.parent = stack[stack.length - 1];
    stack[stack.length - 1].children.push(node);
    nodes++;
  };

  while (i < html.length && nodes < MAX_NODES) {
    const lt = html.indexOf('<', i);
    if (lt === -1) break;
    if (lt > i) pushText(html.slice(i, lt));

    // Komentar / doctype / instruksi processing
    if (html.startsWith('<!--', lt)) {
      const end = html.indexOf('-->', lt + 4);
      i = end === -1 ? html.length : end + 3;
      continue;
    }
    if (html.startsWith('<![CDATA[', lt)) {
      const end = html.indexOf(']]>', lt + 9);
      const inner = html.slice(lt + 9, end === -1 ? html.length : end);
      pushText(inner, true);
      i = end === -1 ? html.length : end + 3;
      continue;
    }
    if (html.startsWith('<!', lt) || html.startsWith('<?', lt)) {
      const end = html.indexOf('>', lt);
      i = end === -1 ? html.length : end + 1;
      continue;
    }

    // Closing tag
    if (html[lt + 1] === '/') {
      const end = html.indexOf('>', lt);
      const name = html.slice(lt + 2, end === -1 ? html.length : end).trim().toLowerCase();
      i = end === -1 ? html.length : end + 1;
      for (let k = stack.length - 1; k > 0; k--) {
        if (stack[k].tag === name) {
          stack.length = k;
          break;
        }
      }
      continue;
    }

    // Opening tag
    let j = lt + 1;
    while (j < html.length && isNameChar(html.charCodeAt(j))) j++;
    const tag = html.slice(lt + 1, j).toLowerCase();
    if (!tag) { i = lt + 1; continue; }

    // Cari akhir tag, hormati tanda kutip di dalam atribut
    let k = j;
    let quote = null;
    while (k < html.length) {
      const ch = html[k];
      if (quote) {
        if (ch === quote) quote = null;
      } else if (ch === '"' || ch === "'") {
        quote = ch;
      } else if (ch === '>') {
        break;
      }
      k++;
    }
    if (k >= html.length) break; // tag terpotong
    const attrsRaw = html.slice(j, k);
    const selfClosing = attrsRaw.trimEnd().endsWith('/');
    i = k + 1;

    // Auto-close tag sejenis (li, p, td, ...)
    const closeList = autoclose ? autoclose[tag] : null;
    if (closeList) {
      const top = stack[stack.length - 1];
      if (top && closeList.includes(top.tag)) stack.pop();
    }

    const node = makeNode(tag, parseAttributes(selfClosing ? attrsRaw.trimEnd().slice(0, -1) : attrsRaw));

    if (voidSet.has(tag) || selfClosing) {
      push(node);
      continue;
    }

    // Lewati subtree yang tidak pernah berisi artikel (hemat CPU & memori).
    if (SKIP_CONTENT.has(tag)) {
      const end = lower.indexOf('</' + tag, i);
      if (end === -1) { i = html.length; } else {
        const gt = lower.indexOf('>', end);
        i = gt === -1 ? html.length : gt + 1;
      }
      continue;
    }

    // Raw text (script/style/textarea/title): ambil isi apa adanya
    if (rawSet.has(tag)) {
      const closeTag = '</' + tag;
      const end = lower.indexOf(closeTag, i);
      const inner = html.slice(i, end === -1 ? html.length : end);
      if (inner) node.children.push({ tag: '#text', text: tag === 'script' || tag === 'style' ? inner : decodeEntities(inner) });
      push(node);
      if (end === -1) { i = html.length; } else {
        const gt = html.indexOf('>', end);
        i = gt === -1 ? html.length : gt + 1;
      }
      continue;
    }

    push(node);
    stack.push(node);
  }

  return root;
}

/* ------------------------------------------------------------------ */
/* Traversal helpers                                                   */
/* ------------------------------------------------------------------ */

export function norm(s) {
  return String(s == null ? '' : s)
    .replace(/\u00a0/g, ' ')
    .replace(/[\u200b-\u200d\ufeff]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function textOf(node, opts) {
  const limits = opts || {};
  const out = [];
  const stack = [node];
  let guard = 0;
  while (stack.length && guard++ < MAX_NODES) {
    const n = stack.pop();
    if (n.tag === '#text') { out.push(n.text); continue; }
    if (n.tag === 'script' || n.tag === 'style' || n.tag === 'noscript' || n.tag === 'template') continue;
    for (let c = n.children.length - 1; c >= 0; c--) stack.push(n.children[c]);
  }
  let s = norm(out.join(' '));
  if (limits.max && s.length > limits.max) s = s.slice(0, limits.max).trim();
  return s;
}

export function allElements(root) {
  const out = [];
  const stack = [root];
  let guard = 0;
  while (stack.length && guard++ < MAX_NODES * 2) {
    const n = stack.pop();
    if (n === root) {
      for (let c = n.children.length - 1; c >= 0; c--) stack.push(n.children[c]);
      continue;
    }
    if (n.tag === '#text') continue;
    out.push(n);
    for (let c = n.children.length - 1; c >= 0; c--) stack.push(n.children[c]);
  }
  return out;
}

export function findAll(root, pred) {
  const out = [];
  const stack = [root];
  let guard = 0;
  while (stack.length && guard++ < MAX_NODES * 2) {
    const n = stack.pop();
    if (!n) continue;
    if (n !== root && n.tag !== '#text' && pred(n)) out.push(n);
    if (n.children) for (let c = n.children.length - 1; c >= 0; c--) stack.push(n.children[c]);
  }
  return out;
}

export function firstOf(root, pred) {
  const stack = [root];
  let guard = 0;
  while (stack.length && guard++ < MAX_NODES * 2) {
    const n = stack.pop();
    if (!n) continue;
    if (n !== root && n.tag !== '#text' && pred(n)) return n;
    if (n.children) for (let c = n.children.length - 1; c >= 0; c--) stack.push(n.children[c]);
  }
  return null;
}

export function childrenElements(node) {
  const out = [];
  for (const c of node.children) if (c.tag !== '#text') out.push(c);
  return out;
}

export function attr(node, name) {
  if (!node || !node.attrs) return '';
  const v = node.attrs[name.toLowerCase()];
  return v == null ? '' : v;
}

export function classOf(node) {
  return attr(node, 'class').toLowerCase();
}

/* ------------------------------------------------------------------ */
/* URL helpers                                                         */
/* ------------------------------------------------------------------ */

export function absUrl(href, base) {
  if (!href) return '';
  const raw = String(href).trim();
  if (!raw) return '';
  if (/^(#|javascript:|mailto:|tel:|data:|blob:|whatsapp:|sms:)/i.test(raw)) return '';
  try {
    const u = new URL(raw, base);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
    return u.href;
  } catch {
    return '';
  }
}

function stripHash(u) {
  const i = u.indexOf('#');
  return i === -1 ? u : u.slice(0, i);
}

function samePath(a, b) {
  try {
    const ua = new URL(a);
    const ub = new URL(b);
    return ua.hostname === ub.hostname && stripHash(ua.pathname).replace(/\/+$/, '') === stripHash(ub.pathname).replace(/\/+$/, '') && ua.search === ub.search;
  } catch {
    return false;
  }
}

const JUNK_TITLE = /^(home|beranda|utama|login|log in|masuk|daftar|sign in|sign up|register|subscribe|berlangganan|kontak|contact|about|tentang kami|privacy|kebijakan privasi|terms|syarat|ketentuan|baca juga|selengkapnya|read more|read on|next|prev|previous|selanjutnya|sebelumnya|more|lihat semua|lihat lainnya|indeks|index|arsip|archive|tag|kategori|category|share|bagikan|komentar|comment|comments|advertisement|iklan|menu|search|cari|download|unduh|rss|sitemap|pedoman|redaksi|disclaimer|faq|help|bantuan)$/i;

function isJunkText(t) {
  const s = norm(t);
  if (!s) return true;
  if (s.length < 8) return true;
  if (JUNK_TITLE.test(s)) return true;
  if (/^(\.{2,}|-{2,}|\|+)$/.test(s)) return true;
  return false;
}

const NOISE_TAGS = new Set(['nav', 'footer', 'aside', 'form', 'menu', 'dialog', 'template']);
const NOISE_ROLES = new Set(['navigation', 'banner', 'contentinfo', 'complementary', 'search', 'menu', 'menubar', 'dialog']);

function inNoise(node, root) {
  let cur = node;
  let depth = 0;
  while (cur && cur !== root && depth++ < 12) {
    if (NOISE_TAGS.has(cur.tag)) return true;
    if (NOISE_ROLES.has(attr(cur, 'role').toLowerCase())) return true;
    if (cur.tag === 'header') {
      // <header> di dalam <article> biasanya judul, bukan navigasi situs
      const p = cur.parent;
      if (!p || p === root || p.tag === 'body' || p.tag === 'html') return true;
    }
    cur = cur.parent;
  }
  return false;
}

/* ------------------------------------------------------------------ */
/* Tanggal                                                             */
/* ------------------------------------------------------------------ */

const MONTHS = {
  jan: 0, januari: 0, january: 0,
  feb: 1, februari: 1, february: 1, peb: 1,
  mar: 2, maret: 2, march: 2,
  apr: 3, april: 3,
  mei: 4, may: 4,
  jun: 5, juni: 5, june: 5,
  jul: 6, juli: 6, july: 6,
  agu: 7, agt: 7, agustus: 7, aug: 7, august: 7,
  sep: 8, sept: 8, september: 8,
  okt: 9, oktober: 9, oct: 9, october: 9,
  nov: 10, november: 10,
  des: 11, desember: 11, dec: 11, december: 11,
};

const MONTH_RE = 'jan(?:uari|uary)?|feb(?:ruari|ruary)?|peb|mar(?:et|ch)?|apr(?:il)?|mei|may|jun(?:i|e)?|jul(?:i|y)?|agu(?:stus)?|agt|aug(?:ust)?|sep(?:t(?:ember)?)?|okt(?:ober)?|oct(?:ober)?|nov(?:ember)?|des(?:ember)?|dec(?:ember)?';

function toDateOrNull(y, m, d, hh, mm, ss) {
  const year = Number(y);
  const month = Number(m);
  const day = Number(d);
  if (!year || year < 1990 || year > 2100) return null;
  if (month < 1 || month > 12) return null;
  if (day < 1 || day > 31) return null;
  const ts = Date.UTC(year, month - 1, day, hh || 0, mm || 0, ss || 0);
  const dt = new Date(ts);
  if (Number.isNaN(dt.getTime())) return null;
  return dt;
}

export function parseDate(input, now) {
  const s = norm(input);
  if (!s || s.length > 80) return null;
  const base = now || Date.now();

  // ISO 8601
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?/);
  if (iso) {
    const dt = new Date(
      Date.UTC(+iso[1], +iso[2] - 1, +iso[3], +(iso[4] || 0), +(iso[5] || 0), +(iso[6] || 0)),
    );
    if (!Number.isNaN(dt.getTime())) return dt;
  }

  // 15 November 2026 / 15 Nov 2026 / 15 November 2026 10:30
  const dmY = s.match(new RegExp(`\\b(\\d{1,2})[\\s.-]+(${MONTH_RE})[\\s.,-]+(\\d{4})(?:[\\s,T]+(\\d{1,2})[:.](\\d{2}))?`, 'i'));
  if (dmY) {
    const m = MONTHS[dmY[2].toLowerCase().slice(0, 4)] !== undefined
      ? MONTHS[dmY[2].toLowerCase().slice(0, 4)]
      : MONTHS[dmY[2].toLowerCase()];
    const dt = toDateOrNull(dmY[3], (m === undefined ? NaN : m + 1), dmY[1], dmY[4], dmY[5], 0);
    if (dt) return dt;
  }

  // November 15, 2026 / Nov 15 2026
  const MdY = s.match(new RegExp(`\\b(${MONTH_RE})[\\s.-]+(\\d{1,2})(?:st|nd|rd|th)?[\\s.,-]+(\\d{4})(?:[\\s,T]+(\\d{1,2})[:.](\\d{2}))?`, 'i'));
  if (MdY) {
    const key = MdY[1].toLowerCase();
    const m = MONTHS[key.slice(0, 4)] !== undefined ? MONTHS[key.slice(0, 4)] : MONTHS[key];
    const dt = toDateOrNull(MdY[3], (m === undefined ? NaN : m + 1), MdY[2], MdY[4], MdY[5], 0);
    if (dt) return dt;
  }

  // 15/11/2026 atau 2026/11/15
  const numeric = s.match(/\b(\d{1,4})[/.-](\d{1,2})[/.-](\d{1,4})\b/);
  if (numeric) {
    let y;
    let mo;
    let d;
    if (numeric[1].length === 4) {
      y = numeric[1]; mo = numeric[2]; d = numeric[3];
    } else {
      d = numeric[1]; mo = numeric[2]; y = numeric[3];
    }
    const dt = toDateOrNull(y, mo, d, 0, 0, 0);
    if (dt) return dt;
  }

  // Relatif: "3 jam yang lalu", "2 days ago", "kemarin"
  const lower = s.toLowerCase();
  const rel = lower.match(/(\d+)\s*(menit|jam|hari|minggu|bulan|tahun|minute|minutes|hour|hours|day|days|week|weeks|month|months|year|years)\s*(yang\s+)?(lalu|ago)/);
  if (rel) {
    const n = Number(rel[1]);
    const unit = rel[2];
    const ms = /menit|minute/.test(unit) ? n * 60e3
      : /jam|hour/.test(unit) ? n * 3600e3
        : /hari|day/.test(unit) ? n * 86400e3
          : /minggu|week/.test(unit) ? n * 7 * 86400e3
            : /bulan|month/.test(unit) ? n * 30 * 86400e3
              : n * 365 * 86400e3;
    return new Date(base - ms);
  }
  if (/^(kemarin|yesterday)$/.test(lower)) return new Date(base - 86400e3);
  if (/^(baru saja|just now|beberapa detik)/.test(lower)) return new Date(base);

  const direct = new Date(s);
  if (!Number.isNaN(direct.getTime()) && direct.getFullYear() > 1990) return direct;

  return null;
}

/* ------------------------------------------------------------------ */
/* Ekstraksi halaman                                                   */
/* ------------------------------------------------------------------ */

function readMeta(root, pageUrl) {
  const meta = { title: '', description: '', language: '', icon: '', feedLinks: [], base: pageUrl };

  const baseEl = firstOf(root, (n) => n.tag === 'base' && attr(n, 'href'));
  if (baseEl) {
    const b = absUrl(attr(baseEl, 'href'), pageUrl);
    if (b) meta.base = b;
  }

  const htmlEl = firstOf(root, (n) => n.tag === 'html');
  if (htmlEl && attr(htmlEl, 'lang')) meta.language = attr(htmlEl, 'lang').split(',')[0].trim();

  const titleEl = firstOf(root, (n) => n.tag === 'title');
  if (titleEl) meta.title = textOf(titleEl);

  for (const n of findAll(root, (x) => x.tag === 'meta')) {
    const name = (attr(n, 'property') || attr(n, 'name') || '').toLowerCase();
    const content = attr(n, 'content');
    if (!content) continue;
    if (name === 'og:site_name' && !meta.siteName) meta.siteName = content;
    if ((name === 'og:title' || name === 'twitter:title') && !meta.ogTitle) meta.ogTitle = content;
    if (name === 'description' && !meta.description) meta.description = content;
    if ((name === 'og:description' || name === 'twitter:description') && !meta.ogDescription) meta.ogDescription = content;
    if (name === 'og:image' && !meta.image) meta.image = content;
    if (name === 'og:locale' && !meta.language) meta.language = content.replace('_', '-');
  }

  for (const n of findAll(root, (x) => x.tag === 'link')) {
    const rel = attr(n, 'rel').toLowerCase();
    const href = attr(n, 'href');
    const type = attr(n, 'type').toLowerCase();
    if (!href) continue;
    if (rel.includes('icon') && !meta.icon) meta.icon = absUrl(href, meta.base);
    if (rel.includes('alternate') && /(rss|atom|json|xml)/.test(type + rel)) {
      const abs = absUrl(href, meta.base);
      if (abs) meta.feedLinks.push({ href: abs, type, title: attr(n, 'title') });
    }
  }

  // Dedupe feed links
  const seen = new Set();
  meta.feedLinks = meta.feedLinks.filter((f) => {
    if (seen.has(f.href)) return false;
    seen.add(f.href);
    return true;
  });

  if (!meta.title) meta.title = meta.ogTitle || '';
  if (!meta.description) meta.description = meta.ogDescription || '';
  return meta;
}

function pickAnchor(block, base, pageUrl) {
  const anchors = findAll(block, (n) => n.tag === 'a' && attr(n, 'href'));
  let best = null;
  let bestScore = -Infinity;
  for (const a of anchors) {
    const href = absUrl(attr(a, 'href'), base);
    if (!href) continue;
    if (samePath(href, pageUrl)) continue;
    const t = textOf(a);
    const alt = attr(firstOf(a, (n) => n.tag === 'img') || {}, 'alt');
    const text = t || norm(alt);
    if (!text) continue;
    if (isJunkText(text) && text.length < 30) continue;

    let score = 0;
    if (text.length >= 12) score += 3;
    if (text.length >= 25) score += 2;
    if (text.length > 180) score -= 4;
    if (closestTag(a, /^h[1-6]$/)) score += 5;
    if (/title|headline|judul|entry-title|post-title/i.test(classOf(a))) score += 2;
    try {
      const depth = new URL(href).pathname.split('/').filter(Boolean).length;
      if (depth >= 1) score += 1;
      if (depth >= 2) score += 2;
      if (depth === 0) score -= 2;
    } catch { /* ignore */ }
    if (/\/(tag|category|kategori|author|page|search|topik)\//i.test(href)) score -= 6;
    if (score > bestScore) {
      bestScore = score;
      best = { href, text };
    }
  }
  return best;
}

function closestTag(node, re) {
  let cur = node;
  let depth = 0;
  while (cur && depth++ < 8) {
    if (re.test(cur.tag)) return cur;
    cur = cur.parent;
  }
  return null;
}

function firstHeadingText(block) {
  const h = firstOf(block, (n) => /^h[1-4]$/.test(n.tag));
  if (h) {
    const t = textOf(h);
    if (t.length >= 10) return t;
  }
  return '';
}

function dateFromUrl(href) {
  if (!href) return null;
  try {
    const path = new URL(href).pathname;
    let m = path.match(/\/(20\d{2})[/-](\d{1,2})[/-](\d{1,2})(?:[/-]|$)/);
    if (m) {
      const d = toDateOrNull(m[1], m[2], m[3]);
      if (d) return d;
    }
    m = path.match(/\/?(20\d{2})(\d{2})(\d{2})(?:[/-]|$)/);
    if (m) {
      const d = toDateOrNull(m[1], m[2], m[3]);
      if (d) return d;
    }
  } catch { /* ignore */ }
  return null;
}

function findDateIn(block, now, href) {
  const timeEl = firstOf(block, (n) => n.tag === 'time' && (attr(n, 'datetime') || textOf(n)));
  if (timeEl) {
    const raw = attr(timeEl, 'datetime') || textOf(timeEl);
    const d = parseDate(raw, now);
    if (d) return d;
  }
  for (const name of ['data-date', 'data-time', 'data-published', 'data-timestamp', 'data-datetime']) {
    const el = firstOf(block, (n) => attr(n, name));
    if (el) {
      const d = parseDate(attr(el, name), now);
      if (d) return d;
      const num = Number(attr(el, name));
      if (Number.isFinite(num) && num > 1e9) {
        const ts = num > 1e12 ? num : num * 1000;
        const dt = new Date(ts);
        if (dt.getFullYear() > 1990) return dt;
      }
    }
  }
  if (href) {
    const fromUrl = dateFromUrl(href);
    if (fromUrl) return fromUrl;
  }
  const t = textOf(block, { max: 260 });
  const m = t.match(new RegExp(`\\b(?:\\d{1,2}[\\s./-](?:${MONTH_RE}|\\d{1,2})[\\s./-]\\d{4}|${MONTH_RE}\\s+\\d{1,2},?\\s+\\d{4})(?:[\\s,]*\\d{1,2}[:.]\\d{2})?`, 'i'));
  if (m) {
    const d = parseDate(m[0], now);
    if (d) return d;
  }
  return null;
}

function itemFromBlock(block, ctx) {
  const { base, pageUrl, now } = ctx;
  const link = pickAnchor(block, base, pageUrl);
  if (!link) return null;

  let title = firstHeadingText(block) || link.text;
  title = norm(title);
  if (!title || title.length < 6) {
    const img = firstOf(block, (n) => n.tag === 'img' && attr(n, 'alt'));
    title = norm(attr(img || {}, 'alt'));
  }
  if (!title) {
    title = titleFromUrl(link.href);
  }
  if (!title) return null;

  let summary = '';
  for (const p of findAll(block, (n) => n.tag === 'p')) {
    const t = textOf(p);
    if (t.length >= 45 && t !== title) { summary = t.slice(0, 500); break; }
  }

  const date = findDateIn(block, now, link.href);

  let image = '';
  for (const img of findAll(block, (n) => n.tag === 'img')) {
    const src = absUrl(attr(img, 'src') || attr(img, 'data-src') || attr(img, 'data-lazy-src'), base);
    if (!src) continue;
    const w = Number(attr(img, 'width'));
    const h = Number(attr(img, 'height'));
    if ((w && w <= 2) || (h && h <= 2)) continue;
    if (/sprite|pixel|tracking|blank\.|spacer|1x1/i.test(src)) continue;
    image = src;
    break;
  }

  return {
    title,
    link: link.href,
    summary,
    date: date ? date.toISOString() : '',
    image,
  };
}

export function titleFromUrl(href) {
  try {
    const u = new URL(href);
    let seg = decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() || '');
    seg = seg.replace(/\.(html?|php|aspx?|jsp|amp)$/i, '')
      .replace(/[-_+]+/g, ' ')
      .replace(/\b\d{4,}\b/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!seg) return u.hostname.replace(/^www\./, '');
    return seg.replace(/\b\p{Ll}/gu, (c) => c.toUpperCase());
  } catch {
    return '';
  }
}

function fromArticles(root, ctx) {
  const articles = findAll(root, (n) => n.tag === 'article');
  const out = [];
  for (const a of articles.slice(0, 120)) {
    const item = itemFromBlock(a, ctx);
    if (item) out.push(item);
  }
  return out;
}

function fromRepeatedLists(root, ctx) {
  const candidates = [];
  for (const el of allElements(root)) {
    if (!['ul', 'ol', 'div', 'section', 'main', 'table', 'tbody'].includes(el.tag)) continue;
    const kids = childrenElements(el);
    if (kids.length < 4 || kids.length > 60) continue;
    // Struktur berulang: mayoritas anak punya tag yang sama.
    const tag0 = kids[0].tag;
    if (!tag0 || tag0 === '#text') continue;
    let same = 0;
    for (const k of kids) if (k.tag === tag0) same++;
    if (same < 4) continue;

    const withLink = kids.filter((k) => firstOf(k, (n) => n.tag === 'a' && attr(n, 'href')));
    if (withLink.length < 4) continue;
    if (withLink.length / kids.length < 0.55) continue;
    const links = new Set();
    for (const k of withLink) {
      const a = firstOf(k, (n) => n.tag === 'a' && attr(n, 'href'));
      const abs = absUrl(attr(a, 'href'), ctx.base);
      if (abs) links.add(abs);
    }
    if (links.size < 4) continue;
    let score = links.size * 2 + withLink.length;
    if (el.tag === 'ul' || el.tag === 'ol') score += 6;
    if (/list|posts|articles|news|feed|items|archive|latest|terbaru|headline/i.test(classOf(el))) score += 8;
    if (inNoise(el, root)) score -= 30;
    candidates.push({ el, kids: withLink, score });
  }
  candidates.sort((a, b) => b.score - a.score);
  const best = candidates[0];
  if (!best) return [];
  const out = [];
  for (const k of best.kids) {
    const item = itemFromBlock(k, ctx);
    if (item) out.push(item);
  }
  return out;
}

function fromAnchorCluster(root, ctx) {
  const groups = new Map();
  for (const a of findAll(root, (n) => n.tag === 'a' && attr(n, 'href'))) {
    const href = absUrl(attr(a, 'href'), ctx.base);
    if (!href) continue;
    if (samePath(href, ctx.pageUrl)) continue;
    const text = textOf(a);
    if (isJunkText(text) && text.length < 30) continue;
    if (text.length < 18 || text.length > 220) continue;
    if (inNoise(a, root)) continue;
    let sig = '';
    try {
      const u = new URL(href);
      const segs = u.pathname.split('/').filter(Boolean);
      sig = u.hostname + '|' + segs.slice(0, Math.min(2, segs.length)).join('/');
      if (segs.length < 1) continue;
      if (/\/(tag|category|kategori|author|page|search|topik)\//i.test(href)) continue;
    } catch { continue; }
    if (!groups.has(sig)) groups.set(sig, []);
    groups.get(sig).push({ href, text, node: a });
  }
  let best = null;
  for (const [, list] of groups) {
    const uniq = new Set(list.map((x) => x.href));
    if (uniq.size < 4) continue;
    const score = uniq.size * 3 + list.length;
    if (!best || score > best.score) best = { list, score };
  }
  if (!best) return [];
  const out = [];
  for (const x of best.list) {
    let date = null;
    let cur = x.node;
    let depth = 0;
    while (cur && depth++ < 6 && !date) {
      date = findDateIn(cur, ctx.now, depth === 1 ? x.href : '');
      cur = cur.parent;
    }
    out.push({
      title: norm(x.text),
      link: x.href,
      summary: '',
      date: date ? date.toISOString() : '',
      image: '',
    });
  }
  return out;
}

function fromJsonLd(root, ctx) {
  const items = [];
  const scripts = findAll(root, (n) => n.tag === 'script' && /ld\+json/i.test(attr(n, 'type')));
  for (const sc of scripts.slice(0, 8)) {
    const raw = sc.children.map((c) => c.text || '').join('').trim();
    if (!raw) continue;
    let data;
    try { data = JSON.parse(raw); } catch { continue; }
    const visit = (node, depth) => {
      if (!node || typeof node !== 'object' || depth > 4) return;
      if (Array.isArray(node)) { for (const n of node) visit(n, depth + 1); return; }
      const type = [].concat(node['@type'] || []).join(' ').toLowerCase();
      if (/blogposting|newsarticle|article|report|posting/.test(type) && (node.url || node.mainEntityOfPage)) {
        const url = typeof node.mainEntityOfPage === 'string' ? node.mainEntityOfPage : (node.mainEntityOfPage && node.mainEntityOfPage['@id']) || node.url;
        const abs = absUrl(url, ctx.base);
        if (abs) {
          const pub = node.datePublished || node.dateCreated || '';
          const d = pub ? parseDate(String(pub), ctx.now) : null;
          items.push({
            title: norm(node.headline || node.name || ''),
            link: abs,
            summary: norm(node.description || '').slice(0, 500),
            date: d ? d.toISOString() : '',
            image: typeof node.image === 'string' ? node.image : (node.image && node.image.url) || '',
          });
        }
      }
      if (/itemlist/.test(type) && Array.isArray(node.itemListElement)) {
        for (const el of node.itemListElement) {
          const it = el && (el.item || el);
          if (!it) continue;
          const abs = absUrl(it.url || it['@id'], ctx.base);
          if (abs) {
            items.push({
              title: norm(it.name || it.headline || ''),
              link: abs,
              summary: norm(it.description || '').slice(0, 500),
              date: '',
              image: '',
            });
          }
        }
      }
      for (const k of Object.keys(node)) {
        if (k === 'itemListElement') continue;
        const v = node[k];
        if (v && typeof v === 'object') visit(v, depth + 1);
      }
    };
    visit(data, 0);
  }
  return items.filter((i) => i.title && i.link);
}

function cleanItems(items, ctx, limit, filter) {
  const seen = new Set();
  const seenTitle = new Set();
  const out = [];
  const pageUrl = ctx.pageUrl;
  for (const raw of items) {
    if (!raw || !raw.link) continue;
    let item = raw;
    const key = stripHash(item.link).replace(/\/+$/, '').toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);

    if (samePath(item.link, pageUrl)) continue;
    // Buang halaman arsip/tag/kategori — bukan artikel.
    if (/\/(tag|tags|category|categories|kategori|author|penulis|topik|topic|search|cari|page)(\/|$|\?)/i.test(item.link)) continue;
    if (/[?&](replytocom|share|utm_source=facebook)/i.test(item.link)) continue;

    if (!item.title) item.title = titleFromUrl(item.link);
    item.title = norm(item.title).replace(/^[•·\-–—|]\s*/, '').slice(0, 300);
    if (!item.title) continue;

    const titleKey = item.title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
    if (titleKey.length > 8) {
      if (seenTitle.has(titleKey)) continue;
      seenTitle.add(titleKey);
    }

    if (filter && !item.link.toLowerCase().includes(filter.toLowerCase()) && !item.title.toLowerCase().includes(filter.toLowerCase())) continue;

    if (!item.image) item.image = '';
    if (item.summary) item.summary = norm(item.summary).slice(0, 500);
    if (item.summary && item.summary === item.title) item.summary = '';
    if (item.summary && item.summary.length < 25) item.summary = '';

    out.push(item);
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * Ekstrak metadata + daftar item dari HTML.
 * @returns {{meta, items, warnings}}
 */
export function extractPage(html, pageUrl, options) {
  return extractFromRoot(parseHtml(html), pageUrl, options);
}

/**
 * Versi yang menerima pohon hasil parseHtml() supaya halaman tidak diparse dua kali.
 */
export function extractFromRoot(root, pageUrl, options) {
  const opts = options || {};
  const limit = opts.limit || 20;
  const filter = opts.filter || '';
  const now = opts.now || Date.now();
  const warnings = [];

  const meta = readMeta(root, pageUrl);
  const ctx = { base: meta.base, pageUrl, now };

  const articles = fromArticles(root, ctx);
  let items = articles;

  // Daftar berulang biasanya menambah cakupan (mis. 4 kartu unggulan + 20 daftar).
  const repeated = fromRepeatedLists(root, ctx);
  if (repeated.length) items = mergeItems(items, repeated);

  // Ekstraktor yang lebih mahal hanya dipakai kalau hasilnya masih sedikit.
  if (items.length < 3) {
    const cluster = fromAnchorCluster(root, ctx);
    if (cluster.length) items = mergeItems(items, cluster);
  }
  if (items.length < 3) {
    const jsonld = fromJsonLd(root, ctx);
    if (jsonld.length) items = mergeItems(items, jsonld);
  }

  items = cleanItems(items, ctx, Math.max(limit * 4, 60), filter);
  items = cleanItems(items, ctx, limit, filter);

  if (!items.length) warnings.push('Tidak ada artikel yang bisa dikenali di halaman ini.');
  if (items.length && !items.some((i) => i.date)) warnings.push('Tanggal publikasi tidak ditemukan; sebagian reader akan memakai waktu fetch.');

  const siteHost = (() => { try { return new URL(pageUrl).hostname.replace(/^www\./, ''); } catch { return pageUrl; } })();

  return {
    meta: {
      title: meta.siteName || meta.ogTitle || meta.title || siteHost,
      description: meta.description || meta.ogDescription || ('Feed dari ' + siteHost),
      siteName: meta.siteName || meta.ogTitle || meta.title || siteHost,
      link: pageUrl,
      icon: meta.icon || '',
      image: meta.image || '',
      language: (meta.language || 'id').slice(0, 12),
      feedLinks: meta.feedLinks,
    },
    items,
    warnings,
  };
}

function mergeItems(primary, secondary) {
  const seen = new Set(primary.map((i) => stripHash(i.link).toLowerCase()));
  const out = primary.slice();
  for (const it of secondary) {
    const k = stripHash(it.link).toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(it);
  }
  return out;
}

export { readMeta, itemFromBlock, stripHash, samePath };
