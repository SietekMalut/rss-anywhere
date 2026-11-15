import { servePreview } from '../src/core.js';
import { toRequest, send, preflight, fail } from './_http.js';

/** Vercel: GET /api/preview -> JSON pratinjau untuk UI */
export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return preflight(res);
  try {
    const response = await servePreview(toRequest(req), {});
    await send(res, response);
  } catch (err) {
    fail(res, err);
  }
}
