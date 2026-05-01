const { createClient } = require('redis');

const HASH_KEY = 'job_likes';
let client = null;

async function getClient() {
  if (client && client.isReady) return client;
  client = createClient({ url: process.env.REDIS_URL });
  client.on('error', err => console.error('[redis]', err));
  await client.connect();
  return client;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', process.env.SITE_ORIGIN || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (!process.env.REDIS_URL) {
    if (req.method === 'GET') return res.json({ counts: {}, debug: 'REDIS_URL missing' });
    return res.json({ id: (req.body || {}).id || '', count: 0, debug: 'REDIS_URL missing' });
  }

  try {
    const redis = await getClient();

    if (req.method === 'GET') {
      const raw = await redis.hGetAll(HASH_KEY);
      const counts = {};
      for (const [key, val] of Object.entries(raw || {})) {
        counts[key] = parseInt(val, 10) || 0;
      }
      res.setHeader('Cache-Control', 'no-store');
      return res.json({ counts });
    }

    if (req.method === 'POST') {
      const { id, action } = req.body || {};
      if (!id) return res.status(400).json({ error: 'Missing id' });

      let count;
      if (action === 'unlike') {
        const current = parseInt(await redis.hGet(HASH_KEY, id), 10) || 0;
        count = Math.max(0, current - 1);
        await redis.hSet(HASH_KEY, id, count);
      } else {
        count = await redis.hIncrBy(HASH_KEY, id, 1);
      }
      return res.json({ id, count: parseInt(count, 10) || 0 });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('[api/likes]', err.message);
    if (req.method === 'GET') return res.json({ counts: {}, debug: err.message });
    return res.json({ id: (req.body || {}).id || '', count: 0, debug: err.message });
  }
};
