import { serveDiscover } from '../src/core.js';
import { toRequest, send, preflight, fail } from './_http.js';

/** Vercel: GET /api/discover -> metadata + kandidat feed asli */
export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return preflight(res);
  try {
    const response = await serveDiscover(toRequest(req), {});
    await send(res, response);
  } catch (err) {
    fail(res, err);
  }
}
