/**
 * src/render.js
 * Pembentuk dokumen RSS 2.0 dan JSON Feed 1.1.
 */

const INVALID_XML = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g;

export function esc(value) {
  return String(value == null ? '' : value)
    .replace(INVALID_XML, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** CDATA aman: pecah kalau ada "]]>" di dalam teks. */
export function cdata(value) {
  const s = String(value == null ? '' : value).replace(INVALID_XML, '');
  return '<![CDATA[' + s.split(']]>').join(']]]]><![CDATA[>') + ']]>';
}

export function rfc822(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toUTCString();
}

function prettyUrl(u) {
  try {
    return new URL(u).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

function truncate(s, n) {
  const str = String(s || '');
  if (str.length <= n) return str;
  return str.slice(0, n - 1).replace(/\s+\S*$/, '') + '…';
}

/**
 * @param {object} input {feed:{title,description,link,icon,language,image}, items:[], selfUrl, ttl, note}
 */
export function buildRss(input) {
  const feed = input.feed || {};
  const items = input.items || [];
  const selfUrl = input.selfUrl || '';
  const ttlMinutes = Math.max(1, Math.round((input.ttl || 900) / 60));
  const host = prettyUrl(feed.link) || 'sumber';

  const lines = [];
  lines.push('<?xml version="1.0" encoding="UTF-8"?>');
  lines.push('<rss version="2.0"');
  lines.push('     xmlns:atom="http://www.w3.org/2005/Atom"');
  lines.push('     xmlns:content="http://purl.org/rss/1.0/modules/content/"');
  lines.push('     xmlns:dc="http://purl.org/dc/elements/1.1/"');
  lines.push('     xmlns:media="http://search.yahoo.com/mrss/">');
  lines.push('  <channel>');
  lines.push('    <title>' + esc(feed.title || host) + '</title>');
  lines.push('    <link>' + esc(feed.link || '') + '</link>');
  lines.push('    <description>' + esc(feed.description || ('Feed untuk ' + host)) + '</description>');
  if (feed.language) lines.push('    <language>' + esc(feed.language) + '</language>');
  lines.push('    <generator>RSS Anywhere 1.0</generator>');
  lines.push('    <lastBuildDate>' + new Date().toUTCString() + '</lastBuildDate>');
  lines.push('    <ttl>' + ttlMinutes + '</ttl>');
  lines.push('    <docs>https://www.rssboard.org/rss-specification</docs>');
  if (selfUrl) {
    lines.push('    <atom:link href="' + esc(selfUrl) + '" rel="self" type="application/rss+xml"/>');
  }
  if (feed.icon) {
    lines.push('    <image>');
    lines.push('      <url>' + esc(feed.icon) + '</url>');
    lines.push('      <title>' + esc(feed.title || host) + '</title>');
    lines.push('      <link>' + esc(feed.link || '') + '</link>');
    lines.push('    </image>');
  }

  for (const it of items) {
    const title = truncate(it.title || it.link || 'Tanpa judul', 300);
    const desc = String(it.summary || '');
    const html = [];
    if (it.image) html.push('<p><img src="' + esc(it.image) + '" alt=""></p>');
    if (desc) html.push('<p>' + esc(desc) + '</p>');

    lines.push('    <item>');
    lines.push('      <title>' + esc(title) + '</title>');
    lines.push('      <link>' + esc(it.link) + '</link>');
    lines.push('      <guid isPermaLink="true">' + esc(it.link) + '</guid>');
    if (it.date) lines.push('      <pubDate>' + rfc822(it.date) + '</pubDate>');
    if (it.date) lines.push('      <dc:date>' + esc(it.date) + '</dc:date>');
    if (desc) lines.push('      <description>' + esc(desc) + '</description>');
    if (html.length) lines.push('      <content:encoded>' + cdata(html.join('')) + '</content:encoded>');
    if (it.image) lines.push('      <media:content url="' + esc(it.image) + '" medium="image"/>');
    lines.push('    </item>');
  }

  lines.push('  </channel>');
  lines.push('</rss>');
  return lines.join('\n');
}

export function buildJsonFeed(input) {
  const feed = input.feed || {};
  const items = input.items || [];
  const host = prettyUrl(feed.link) || 'sumber';

  const out = {
    version: 'https://jsonfeed.org/version/1.1',
    title: feed.title || host,
    home_page_url: feed.link || '',
    feed_url: input.selfUrl || undefined,
    description: feed.description || ('Feed untuk ' + host),
    language: feed.language || undefined,
    icon: feed.icon || undefined,
    favicon: feed.icon || undefined,
    authors: feed.siteName ? [{ name: feed.siteName }] : undefined,
    items: items.map((it) => {
      const obj = {
        id: it.link,
        url: it.link,
        title: it.title || it.link,
        content_text: it.summary || '',
      };
      if (it.date) obj.date_published = it.date;
      if (it.image) obj.image = it.image;
      return obj;
    }),
  };
  return JSON.stringify(out, null, 2);
}

/** Ubah feed JSON (jsonfeed.org) menjadi daftar item internal. */
export function itemsFromJsonFeed(data, fallbackLink) {
  const list = Array.isArray(data && data.items) ? data.items : [];
  const items = [];
  for (const it of list) {
    if (!it) continue;
    const link = it.url || it.external_url || it.id || '';
    if (!/^https?:/i.test(link)) continue;
    let summary = it.summary || it.content_text || '';
    if (!summary && it.content_html) summary = String(it.content_html).replace(/<[^>]+>/g, ' ');
    items.push({
      title: String(it.title || '').trim(),
      link,
      summary: String(summary).replace(/\s+/g, ' ').trim().slice(0, 500),
      date: it.date_published || it.date_modified || '',
      image: it.image || '',
    });
  }
  return {
    feed: {
      title: String(data.title || ''),
      description: String(data.description || ''),
      link: data.home_page_url || fallbackLink,
      icon: data.icon || data.favicon || '',
      language: data.language || '',
      siteName: String(data.title || ''),
    },
    items,
  };
}
