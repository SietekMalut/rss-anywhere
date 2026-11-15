/**
 * scripts/lib/id.mjs
 * ID feed yang stabil dan deterministik dari URL sumber.
 * URL yang sama selalu menghasilkan ID yang sama, jadi link feed tidak berubah.
 */

import { createHash } from 'node:crypto';

export function feedId(rawUrl) {
  const u = new URL(rawUrl);
  const slug = (u.hostname + u.pathname)
    .toLowerCase()
    .replace(/^www\./, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'feed';
  const hash = createHash('sha1').update(rawUrl).digest('hex').slice(0, 6);
  return slug + '-' + hash;
}
