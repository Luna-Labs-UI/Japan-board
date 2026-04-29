const fs   = require('fs');
const path = require('path');

// Job aggregators, agencies, and middlemen — direct employer links only
const BLOCKED_DOMAINS = [
  'gaijinpot.com','daijob.com','careercross.com','jobsinjapan.com',
  'ohayosensei.com','eslcafe.com','tokyojobs.com','expat.com',
  'careerjet.com','careerjet.co.jp','indeed.com','indeed.co.jp',
  'linkedin.com','glassdoor.com','seek.com.au','monster.com','ziprecruiter.com',
  'rikunabi.com','mynavi.jp','en-japan.com','doda.jp','bizreach.jp',
  'type.jp','recruit.co.jp','townwork.net',
  'interac.co.jp','borderlink.co.jp','altia-central.co.jp','heart.co.jp',
  'joytalk.co.jp','nova.co.jp','gaba.co.jp','passionworks.co.jp','jtjs.jp',
  'jac-recruitment.co.jp','robertwalters.co.jp','michaelpage.co.jp',
  'hays.co.jp','manpower.co.jp','adecco.co.jp','randstad.co.jp',
];

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate');

  try {
    const threeWeeksAgo = new Date(Date.now() - 21 * 24 * 60 * 60 * 1000).toISOString();

    // ── Run all three sources in parallel ──────────────────────────────────
    const [manualJobs, trustedResults, boeResults] = await Promise.all([
      loadManualJobs(),
      fetchTrustedUrls(),
      searchBOEJobs(threeWeeksAgo),
    ]);

    // Combine, deduplicate by URL
    const seen = new Set();
    const rawResults = [...trustedResults, ...boeResults].filter(r => {
      if (seen.has(r.url)) return false;
      seen.add(r.url);
      return true;
    });

    // Filter broken links
    const aliveChecks = await Promise.all(rawResults.map(r => isLinkAlive(r.url)));
    const liveResults = rawResults.filter((_, i) => aliveChecks[i]);

    // Translate all live results in one batch
    let translatedJobs = [];
    if (liveResults.length > 0) {
      translatedJobs = await translateAndBuild(liveResults);
    }

    const allJobs = [...manualJobs, ...translatedJobs];
    res.status(200).json({ jobs: allJobs });

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
    return jobs.map((j, i) => ({ ...j, id: `manual-${i}`, isLive: false }));
  } catch {
    return [];
  }
}

// ── Source 2: Specific trusted URLs fetched directly ──────────────────────
async function fetchTrustedUrls() {
  let urls = [];
  try {
    const file = path.join(process.cwd(), 'data', 'trusted-urls.json');
    urls = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch { return []; }

  const results = await Promise.allSettled(
    urls.map(async url => {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(6000),
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; KakehashiBot/1.0)' },
      });
      if (!res.ok) return null;
      const html = await res.text();
      const text = stripHtml(html).slice(0, 2000);
      return { url, title: extractTitle(html), text, publishedDate: null, isTrusted: true };
    })
  );

  return results
    .filter(r => r.status === 'fulfilled' && r.value)
    .map(r => r.value);
}

// ── Source 3: Exa search targeting Japanese government sites only ──────────
async function searchBOEJobs(since) {
  const res = await fetch('https://api.exa.ai/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.Exa },
    body: JSON.stringify({
      query: '外国語指導助手 募集 教育委員会 直接雇用 外国人英語指導 ALT 在留資格 ビザ支援',
      numResults: 12,
      contents: { text: { maxCharacters: 1000 } },
      type: 'neural',
      useAutoprompt: true,
      startPublishedDate: since,
      includeDomains: ['lg.jp'],
      excludeDomains: BLOCKED_DOMAINS,
    }),
  });
  if (!res.ok) return [];
  const { results } = await res.json();
  return results || [];
}

// ── Translate + build job objects ─────────────────────────────────────────
async function translateAndBuild(results) {
  const texts = [
    ...results.map(r => r.title || ''),
    ...results.map(r => (r.text || '').slice(0, 800)),
  ];

  const translateRes = await fetch(
    `https://translation.googleapis.com/language/translate/v2?key=${process.env.Translate}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: texts, target: 'en', format: 'text' }),
    }
  );
  if (!translateRes.ok) return [];
  const { data: { translations } } = await translateRes.json();
  const n = results.length;

  return results.map((r, i) => {
    const titleT = translations[i];
    const descT  = translations[i + n];

    const isJaTitle = titleT.detectedSourceLanguage === 'ja';
    const isJaDesc  = descT.detectedSourceLanguage  === 'ja';

    const titleEn = titleT.translatedText || r.title;
    const titleJp = isJaTitle ? r.title : '';
    const descEn  = descT.translatedText || '';
    const descJp  = isJaDesc ? (r.text || '').slice(0, 800) : '';

    let domain = r.url;
    try { domain = new URL(r.url).hostname.replace(/^www\./, ''); } catch (_) {}

    const combined = (titleEn + ' ' + descEn).toLowerCase();
    const jpReq    = detectJpRequirement(combined + ' ' + (r.text || ''));

    return {
      id:           `live-${i}`,
      titleEn,
      titleJp,
      employer:     domain,
      short:        titleEn.split(/\s+/).slice(0, 2).map(w => (w[0] || '').toUpperCase()).join('').slice(0, 3) || 'JB',
      location:     detectLocation(combined) || 'Japan',
      pref:         detectPref(combined),
      type:         detectType(combined),
      contract:     /part.time|パート/i.test(combined) ? 'part-time' : 'full-time',
      visa:         r.isTrusted || /visa.spon|ビザ.*スポンサー|在留資格|就労ビザ|sponsor.*visa|work.*visa/i.test(combined),
      jlpt:         jpReq.jlpt,
      jpLevel:      jpReq.jpLevel,
      otherLangs:   [],
      industry:     detectType(combined),
      careerLevel:  'entry',
      employerType: /board.of.edu|教育委員会|boe/i.test(combined + r.url) ? 'boe' : 'company',
      remoteOk:     /remote|リモート/i.test(combined),
      overseasOk:   false,
      salary:       extractSalary(descEn + ' ' + (r.text || '')) || 'See listing',
      salaryRank:   2,
      posted:       formatPosted(r.publishedDate),
      deadline:     'See listing',
      url:          r.url,
      source:       r.isTrusted ? domain + ' (verified)' : domain,
      mhlw:         false,
      desc:         descEn,
      descJp,
      req:          [],
      benefits:     [],
      hours:        'See listing',
      isLive:       true,
      isVerified:   !!r.isTrusted,
      // Trusted sources (embassies, BOE pages) hire foreigners by definition
      // For search results, require explicit visa mention
    };
  });
}

// ── Helpers ────────────────────────────────────────────────────────────────
async function isLinkAlive(url) {
  try {
    const res = await fetch(url, {
      method: 'HEAD',
      signal: AbortSignal.timeout(4000),
      redirect: 'follow',
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; KakehashiBot/1.0)' },
    });
    return res.status < 400;
  } catch { return false; }
}

function stripHtml(html) {
  return html.replace(/<style[\s\S]*?<\/style>/gi, '')
             .replace(/<script[\s\S]*?<\/script>/gi, '')
             .replace(/<[^>]+>/g, ' ')
             .replace(/\s+/g, ' ').trim();
}

function extractTitle(html) {
  const m = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  return m ? m[1].trim() : '';
}

function detectJpRequirement(text) {
  if (/日本語不問|日本語不要|no japanese|japanese not required|english only|英語のみ/i.test(text))
    return { jlpt: 'none', jpLevel: 'none' };
  if (/jlpt\s*n1|n1以上|ネイティブ.*日本語|native.*japanese|fluent.*japanese|日本語.*堪能/i.test(text))
    return { jlpt: 'n1', jpLevel: 'native' };
  if (/jlpt\s*n2|n2以上|ビジネス.*日本語|business.*japanese/i.test(text))
    return { jlpt: 'n2', jpLevel: 'business' };
  if (/jlpt\s*n3|n3以上|日常会話|conversational.*japanese/i.test(text))
    return { jlpt: 'n3', jpLevel: 'conversational' };
  if (/jlpt\s*n[45]|n[45]以上|簡単.*日本語|basic.*japanese|挨拶程度/i.test(text))
    return { jlpt: 'n4', jpLevel: 'basic' };
  const hasJapanese = /[぀-ヿ一-鿿]/.test(text);
  return hasJapanese
    ? { jlpt: 'n4', jpLevel: 'basic' }
    : { jlpt: 'none', jpLevel: 'none' };
}

function detectType(text) {
  if (/\b(alt|english teach|efl|english instruct|board of edu|外国語指導)\b/.test(text)) return 'education';
  if (/\b(engineer|developer|programmer|software|it support|tech)\b/.test(text))          return 'it';
  if (/\b(sales|account exec|business dev|bdr|csm)\b/.test(text))                         return 'sales';
  if (/\b(admin|government|prefecture|municipal|civil serv)\b/.test(text))                 return 'admin';
  return 'education';
}

function detectPref(text) {
  const map = {
    tokyo:'tokyo', osaka:'osaka', kyoto:'kyoto',
    sapporo:'hokkaido', hokkaido:'hokkaido',
    fukuoka:'fukuoka', nagoya:'aichi', yokohama:'kanagawa',
    saitama:'saitama', satte:'saitama', chiba:'chiba', hiroshima:'hiroshima',
    sendai:'miyagi', kobe:'hyogo', nara:'nara', okinawa:'okinawa',
  };
  for (const [k, v] of Object.entries(map)) if (text.includes(k)) return v;
  return 'japan';
}

function detectLocation(text) {
  const cities = ['Tokyo','Osaka','Kyoto','Sapporo','Fukuoka','Nagoya','Yokohama',
                  'Kobe','Hiroshima','Sendai','Satte','Saitama','Chiba','Nara','Okinawa'];
  for (const c of cities) if (text.includes(c.toLowerCase())) return c;
  return null;
}

function extractSalary(text) {
  const m = text.match(/[¥￥]\s*[\d,]+(?:\s*[–~\-]\s*[¥￥]?\s*[\d,]+)?(?:\s*\/?\s*(?:month|mo|year|yr))?/i);
  return m ? m[0].trim() : null;
}

function formatPosted(dateStr) {
  if (!dateStr) return 'Recently';
  try {
    const days = Math.floor((Date.now() - new Date(dateStr)) / 86400000);
    if (days === 0) return 'Today';
    if (days === 1) return '1 day ago';
    if (days < 7)   return `${days} days ago`;
    if (days < 14)  return '1 week ago';
    return `${Math.floor(days / 7)} weeks ago`;
  } catch (_) { return 'Recently'; }
}
