/**
 * src/validate.js
 * Pemeriksa validitas tanpa dependensi: well-formed XML, RSS/Atom, dan JSON Feed.
 *
 * Dipakai oleh:
 *   - scripts/build-static.mjs  (sebelum file ditulis / diterbitkan)
 *   - scripts/verify-live.mjs   (setelah deploy, memastikan link benar-benar valid)
 *   - scripts/unit-test.mjs     (regresi)
 *
 * Sengaja ketat pada hal yang membuat pembaca RSS menolak dokumen:
 * tag tidak seimbang, atribut tanpa tanda kutip, entity tak terdeklarasi
 * (mis. &nbsp; di XML), karakter kontrol, dan CDATA yang tidak ditutup.
 */

const MAX_ERRORS = 8;

const PREDEFINED = new Set(['amp', 'lt', 'gt', 'quot', 'apos']);

const CTRL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/;

function findTagEnd(s, start) {
  let quote = '';
  for (let i = start + 1; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (c === quote) quote = '';
      continue;
    }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === '>') return i;
  }
  return -1;
}

function checkEntities(text, entities, errors, where) {
  let idx = text.indexOf('&');
  while (idx !== -1 && errors.length < MAX_ERRORS) {
    const m = /^&(#\d{1,7}|#x[0-9A-Fa-f]{1,6}|[A-Za-z_][-A-Za-z0-9_.:]*);/.exec(text.slice(idx));
    if (!m) {
      errors.push('karakter "&" tanpa entity yang valid' + where);
    } else if (m[1][0] !== '#' && !PREDEFINED.has(m[1]) && !entities.has(m[1])) {
      errors.push('entity &' + m[1] + '; tidak dideklarasikan' + where);
    }
    idx = text.indexOf('&', idx + 1);
  }
}

function checkAttributes(raw, tagName, entities, errors) {
  let rest = raw;
  const re = /^\s*([^\s=/>]+)\s*=\s*(?:"([^"<]*)"|'([^'<]*)')/;
  while (rest.trim() && errors.length < MAX_ERRORS) {
    const m = re.exec(rest);
    if (!m) {
      errors.push('atribut tidak valid pada <' + tagName + '>');
      return;
    }
    const value = m[2] !== undefined ? m[2] : m[3];
    checkEntities(value, entities, errors, ' (atribut ' + m[1] + ')');
    rest = rest.slice(m[0].length);
  }
}

/**
 * @returns {{ok: boolean, errors: string[], root: string, items: number}}
 */
export function validateXml(input) {
  const errors = [];
  let xml = String(input == null ? '' : input);
  if (xml.charCodeAt(0) === 0xfeff) xml = xml.slice(1);

  if (!xml.trim()) {
    return { ok: false, errors: ['dokumen kosong'], root: '', items: 0 };
  }
  const ctrl = CTRL.exec(xml);
  if (ctrl) errors.push('karakter kontrol ilegal (posisi ' + ctrl.index + ')');

  const entities = new Set();
  const stack = [];
  let root = '';
  let i = 0;

  while (i < xml.length && errors.length < MAX_ERRORS) {
    const lt = xml.indexOf('<', i);
    const text = lt === -1 ? xml.slice(i) : xml.slice(i, lt);
    if (text) {
      if (text.includes(']]>')) errors.push('teks mengandung "]]>" di luar CDATA');
      checkEntities(text, entities, errors, '');
    }
    if (lt === -1) break;

    if (xml.startsWith('<!--', lt)) {
      const end = xml.indexOf('-->', lt + 4);
      if (end === -1) { errors.push('komentar tidak ditutup'); break; }
      i = end + 3;
      continue;
    }
    if (xml.startsWith('<![CDATA[', lt)) {
      const end = xml.indexOf(']]>', lt + 9);
      if (end === -1) { errors.push('CDATA tidak ditutup'); break; }
      i = end + 3;
      continue;
    }
    if (xml.startsWith('<?', lt)) {
      const end = xml.indexOf('?>', lt + 2);
      if (end === -1) { errors.push('instruction tidak ditutup'); break; }
      i = end + 2;
      continue;
    }
    if (xml.startsWith('<!DOCTYPE', lt)) {
      let j = lt + 9;
      let depth = 0;
      while (j < xml.length) {
        const c = xml[j];
        if (c === '[') depth++;
        else if (c === ']') depth--;
        else if (c === '>' && depth <= 0) break;
        j++;
      }
      const decl = xml.slice(lt, j + 1);
      for (const m of decl.matchAll(/<!ENTITY\s+([A-Za-z_][-A-Za-z0-9_.]*)\s+/g)) entities.add(m[1]);
      i = j + 1;
      continue;
    }
    if (xml[lt + 1] === '!') {
      const end = xml.indexOf('>', lt + 2);
      if (end === -1) { errors.push('deklarasi tidak ditutup'); break; }
      i = end + 1;
      continue;
    }

    const gt = findTagEnd(xml, lt);
    if (gt === -1) { errors.push('tag tidak ditutup ("<" tanpa ">")'); break; }

    const raw = xml.slice(lt + 1, gt).trim();
    if (!raw) { errors.push('tag kosong "<>"'); i = gt + 1; continue; }

    if (raw.startsWith('/')) {
      const name = raw.slice(1).trim();
      if (!stack.length) errors.push('tag penutup </' + name + '> tanpa pembuka');
      else if (stack[stack.length - 1] !== name) {
        errors.push('tag tidak cocok: <' + stack[stack.length - 1] + '> ditutup dengan </' + name + '>');
        stack.pop();
      } else stack.pop();
    } else {
      const selfClose = raw.endsWith('/');
      const body = selfClose ? raw.slice(0, -1) : raw;
      const m = /^([^\s/>]+)/.exec(body);
      const name = m ? m[1] : '';
      if (!name) errors.push('nama tag tidak valid');
      if (name) {
        if (!root) root = name;
        checkAttributes(body.slice(name.length), name, entities, errors);
        if (!selfClose) stack.push(name);
      }
    }
    i = gt + 1;
  }

  if (stack.length) errors.push('tag belum ditutup: ' + stack.slice(-4).join(', '));

  const items = (xml.match(/<(?:item|entry)(?=[\s/>])/g) || []).length;
  return { ok: errors.length === 0, errors: errors.slice(0, MAX_ERRORS), root, items };
}

function textOfTag(xml, tag) {
  const m = new RegExp('<' + tag + '(?:\\s[^>]*)?>([\\s\\S]*?)</' + tag + '>', 'i').exec(xml);
  if (!m) return '';
  return m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').trim();
}

/**
 * Validasi dokumen RSS 2.0 / Atom / RDF yang akan diterbitkan.
 * @returns {{ok: boolean, errors: string[], kind: string, items: number, title: string, selfUrl: string}}
 */
export function validateFeedXml(input) {
  const xml = String(input == null ? '' : input);
  const base = validateXml(xml);
  const errors = base.errors.slice();
  const root = (base.root || '').toLowerCase();
  const kind = root === 'feed' ? 'atom' : root === 'rdf:rdf' ? 'rdf' : root === 'rss' ? 'rss' : '';

  if (!kind) {
    errors.push('akar dokumen bukan <rss>, <feed>, atau <rdf:RDF> (ditemukan: ' + (base.root || 'kosong') + ')');
  }

  let title = '';
  let selfUrl = '';
  if (kind === 'rss') {
    if (!/<channel(?=[\s>])/i.test(xml)) errors.push('tidak ada <channel>');
    title = textOfTag(xml, 'title');
    if (!title) errors.push('<channel><title> kosong');
    selfUrl = (/<atom:link\b[^>]*\brel\s*=\s*["']self["'][^>]*>/i.exec(xml) || [''])[0];
    if (selfUrl) {
      const href = /\bhref\s*=\s*["']([^"']+)["']/i.exec(selfUrl);
      selfUrl = href ? href[1] : '';
    }
  } else if (kind === 'atom') {
    title = textOfTag(xml, 'title');
    if (!title) errors.push('<feed><title> kosong');
    const links = [...xml.matchAll(/<link\b[^>]*>/gi)].map((m) => m[0]);
    for (const l of links) {
      if (/\brel\s*=\s*["']self["']/i.test(l)) {
        const href = /\bhref\s*=\s*["']([^"']+)["']/i.exec(l);
        if (href) selfUrl = href[1];
      }
    }
  }

  return {
    ok: errors.length === 0,
    errors: errors.slice(0, MAX_ERRORS),
    kind: kind || 'unknown',
    items: base.items,
    title,
    selfUrl,
  };
}

/**
 * Validasi JSON Feed 1.0/1.1.
 * @returns {{ok: boolean, errors: string[], items: number, title: string, selfUrl: string}}
 */
export function validateJsonFeed(input) {
  const errors = [];
  let data;
  try {
    data = JSON.parse(String(input == null ? '' : input));
  } catch (err) {
    return { ok: false, errors: ['JSON tidak bisa di-parse: ' + (err && err.message)], items: 0, title: '', selfUrl: '' };
  }
  if (!data || typeof data !== 'object') {
    return { ok: false, errors: ['dokumen JSON bukan objek'], items: 0, title: '', selfUrl: '' };
  }
  if (!/jsonfeed\.org\/version\/1\.[01]/.test(String(data.version || ''))) {
    errors.push('field "version" bukan JSON Feed 1.0/1.1');
  }
  if (!data.title || typeof data.title !== 'string') errors.push('"title" wajib berupa teks');
  if (!Array.isArray(data.items)) errors.push('"items" wajib berupa array');
  const items = Array.isArray(data.items) ? data.items : [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (!it || typeof it !== 'object') { errors.push('item #' + i + ' bukan objek'); break; }
    if (!it.id && !it.url) { errors.push('item #' + i + ' tidak punya id/url'); break; }
  }
  return {
    ok: errors.length === 0,
    errors: errors.slice(0, MAX_ERRORS),
    items: items.length,
    title: String(data.title || ''),
    selfUrl: String(data.feed_url || ''),
  };
}

/** Ringkas: validasi pasangan XML + JSON yang akan diterbitkan. */
export function validatePair(xml, json) {
  const x = validateFeedXml(xml);
  const j = validateJsonFeed(json);
  const errors = [];
  for (const e of x.errors) errors.push('XML: ' + e);
  for (const e of j.errors) errors.push('JSON: ' + e);
  if (x.ok && x.items === 0) errors.push('XML: tidak berisi item');
  if (j.ok && j.items === 0) errors.push('JSON: tidak berisi item');
  if (x.ok && j.ok && x.items !== j.items) errors.push('jumlah item XML (' + x.items + ') != JSON (' + j.items + ')');
  return { ok: errors.length === 0, errors, xml: x, json: j };
}
