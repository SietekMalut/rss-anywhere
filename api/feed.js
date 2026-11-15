import { serveFeed } from '../src/core.js';
import { toRequest, send, preflight, fail, cache } from './_http.js';

/** Vercel: GET /api/feed -> RSS */
export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return preflight(res);
  try {
    const response = await serveFeed(toRequest(req), { format: 'rss', cache });
    await send(res, response);
  } catch (err) {
    fail(res, err);
  }
}
