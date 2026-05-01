// Vercel KV (Upstash Redis) — uses Node https module for compatibility with all Node versions.
// Env vars are added automatically when you link a KV database in Vercel → Storage.

const https   = require('https');
const urlMod  = require('url');

const KV_URL   = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;
const HASH_KEY = 'job_likes';

function kvRequest(command) {
  return new Promise((resolve, reject) => {
    if (!KV_URL || !KV_TOKEN) return reject(new Error('KV not configured'));
    const path = '/' + command.map(c => encodeURIComponent(String(c))).join('/');
    const parsed = new urlMod.URL(KV_URL + path);
    const options = {
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method: 'GET',
      headers: { Authorization: `Bearer ${KV_TOKEN}` },
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(data).result); } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', process.env.SITE_ORIGIN || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (!KV_URL || !KV_TOKEN) {
    res.setHeader('X-KV-Status', 'not-configured');
    if (req.method === 'GET') return res.json({ counts: {}, debug: 'KV env vars missing' });
    return res.json({ id: (req.body || {}).id || '', count: 0, debug: 'KV env vars missing' });
  }

  try {
    if (req.method === 'GET') {
      const raw = await kvRequest(['hgetall', HASH_KEY]);
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
        const current = parseInt(await kvRequest(['hget', HASH_KEY, id]), 10) || 0;
        count = Math.max(0, current - 1);
        await kvRequest(['hset', HASH_KEY, id, count]);
      } else {
        const result = await kvRequest(['hincrby', HASH_KEY, id, 1]);
        count = parseInt(result, 10) || 0;
      }
      return res.json({ id, count });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('[api/likes] error:', err.message);
    if (req.method === 'GET') return res.json({ counts: {}, debug: err.message });
    return res.json({ id: (req.body || {}).id || '', count: 0, debug: err.message });
  }
};
