// Vercel KV (Upstash Redis) REST API — set these env vars in Vercel dashboard:
//   KV_REST_API_URL   → your Upstash Redis REST URL
//   KV_REST_API_TOKEN → your Upstash Redis REST token
//
// To set up: Vercel dashboard → Storage → Create KV Database → link to project.
// The env vars are added automatically. Likes fall back to zero if KV is absent.

const KV_URL   = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;
const HASH_KEY = 'job_likes';

async function kv(command) {
  const path = command.map(c => encodeURIComponent(String(c))).join('/');
  const r = await fetch(`${KV_URL}/${path}`, {
    headers: { Authorization: `Bearer ${KV_TOKEN}` },
  });
  const json = await r.json();
  return json.result;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', process.env.SITE_ORIGIN || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (!KV_URL || !KV_TOKEN) {
    if (req.method === 'GET') return res.json({ counts: {} });
    return res.json({ id: (req.body || {}).id || '', count: 0 });
  }

  try {
    if (req.method === 'GET') {
      const raw = await kv(['hgetall', HASH_KEY]);
      const counts = {};
      if (Array.isArray(raw)) {
        for (let i = 0; i < raw.length; i += 2) {
          counts[raw[i]] = parseInt(raw[i + 1], 10) || 0;
        }
      }
      res.setHeader('Cache-Control', 'no-store');
      return res.json({ counts });
    }

    if (req.method === 'POST') {
      const { id, action } = req.body || {};
      if (!id) return res.status(400).json({ error: 'Missing id' });

      let count;
      if (action === 'unlike') {
        const current = parseInt(await kv(['hget', HASH_KEY, id]), 10) || 0;
        count = Math.max(0, current - 1);
        await kv(['hset', HASH_KEY, id, count]);
      } else {
        const result = await kv(['hincrby', HASH_KEY, id, 1]);
        count = parseInt(result, 10) || 0;
      }
      return res.json({ id, count });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('[api/likes]', err);
    if (req.method === 'GET') return res.json({ counts: {} });
    return res.json({ id: (req.body || {}).id || '', count: 0 });
  }
};
