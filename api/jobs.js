const fs   = require('fs');
const path = require('path');


const ALLOWED_ORIGINS = (process.env.SITE_ORIGIN || '')
  .split(',').map(s => s.trim()).filter(Boolean);

function isAllowedRequest(req) {
  const origin  = req.headers['origin']  || '';
  const referer = req.headers['referer'] || '';
  // If no origin/referer header, allow (same-origin browser fetch omits these)
  if (!origin && !referer) return true;
  const check = origin || referer;
  if (ALLOWED_ORIGINS.length === 0) return true; // no env var set → open (dev mode)
  return ALLOWED_ORIGINS.some(o => check.startsWith(o));
}

function toGoUrl(rawUrl) {
  return '/api/go?id=' + Buffer.from(rawUrl).toString('base64url');
}

module.exports = async function handler(req, res) {
  if (!isAllowedRequest(req)) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  res.setHeader('Access-Control-Allow-Origin', process.env.SITE_ORIGIN || '*');
  res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate');

  try {
    const jobs = loadManualJobs();
    res.status(200).json({ jobs });
  } catch (err) {
    console.error('[api/jobs]', err);
    res.status(500).json({ error: err.message });
  }
};

// ── Source 1: Manually verified jobs from data/manual-jobs.json ────────────
function loadManualJobs() {
  try {
    const file = path.join(process.cwd(), 'data', 'manual-jobs.json');
    const jobs = JSON.parse(fs.readFileSync(file, 'utf8'));
    return jobs.map((j, i) => ({
      ...j,
      id: `manual-${i}`,
      isLive: false,
      url: j.url ? toGoUrl(j.url) : j.url,
    }));
  } catch {
    return [];
  }
}

