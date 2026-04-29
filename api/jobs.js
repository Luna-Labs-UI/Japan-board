// Job aggregators, agencies, and middlemen — never show these, direct employer links only
const BLOCKED_DOMAINS = [
  // Foreign-facing Japan job boards
  'gaijinpot.com',
  'daijob.com',
  'careercross.com',
  'jobsinjapan.com',
  'ohayosensei.com',
  'eslcafe.com',
  'tokyojobs.com',
  'expat.com',
  'careerjet.com',
  'careerjet.co.jp',
  // General aggregators
  'indeed.com',
  'indeed.co.jp',
  'linkedin.com',
  'glassdoor.com',
  'seek.com.au',
  'monster.com',
  'ziprecruiter.com',
  // Japanese aggregators
  'rikunabi.com',
  'mynavi.jp',
  'en-japan.com',
  'doda.jp',
  'bizreach.jp',
  'type.jp',
  'recruit.co.jp',
  'townwork.net',
  // Dispatch / ALT agencies
  'interac.co.jp',
  'borderlink.co.jp',
  'altia-central.co.jp',
  'heart.co.jp',
  'joytalk.co.jp',
  'nova.co.jp',
  'gaba.co.jp',
  'passionworks.co.jp',
  'jtjs.jp',
  // Recruitment agencies
  'jac-recruitment.co.jp',
  'robertwalters.co.jp',
  'michaelpage.co.jp',
  'hays.co.jp',
  'manpower.co.jp',
  'adecco.co.jp',
  'randstad.co.jp',
];

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate');

  try {
    // Only show listings published in the last 3 weeks
    const threeWeeksAgo = new Date(Date.now() - 21 * 24 * 60 * 60 * 1000).toISOString();

    const exaRes = await fetch('https://api.exa.ai/search', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.Exa,
      },
      body: JSON.stringify({
        query: 'English speaker direct hire job Japan Board of Education city government company careers page ALT foreigner visa sponsorship 外国人 直接雇用 採用 教育委員会',
        numResults: 15,
        contents: { text: { maxCharacters: 1000 } },
        type: 'neural',
        useAutoprompt: true,
        startPublishedDate: threeWeeksAgo,
        excludeDomains: BLOCKED_DOMAINS,
      }),
    });

    if (!exaRes.ok) {
      const body = await exaRes.text();
      throw new Error(`Exa ${exaRes.status}: ${body}`);
    }

    const { results } = await exaRes.json();
    if (!results || results.length === 0) {
      return res.status(200).json({ jobs: [] });
    }

    // Check all links in parallel — filter out any that are broken or unreachable
    const aliveChecks = await Promise.all(results.map(r => isLinkAlive(r.url)));
    const liveResults = results.filter((_, i) => aliveChecks[i]);

    if (liveResults.length === 0) {
      return res.status(200).json({ jobs: [] });
    }

    // Batch translate titles + descriptions in one API call
    const texts = [
      ...liveResults.map(r => r.title || ''),
      ...liveResults.map(r => (r.text || '').slice(0, 800)),
    ];

    const translateRes = await fetch(
      `https://translation.googleapis.com/language/translate/v2?key=${process.env.Translate}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ q: texts, target: 'en', format: 'text' }),
      }
    );

    if (!translateRes.ok) {
      const body = await translateRes.text();
      throw new Error(`Translate ${translateRes.status}: ${body}`);
    }

    const { data: { translations } } = await translateRes.json();
    const n = liveResults.length;

    const jobs = liveResults.map((r, i) => {
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
      const rawText  = (r.text || '');
      const jpReq    = detectJpRequirement(combined + ' ' + rawText);

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
        visa:         /visa.spon/i.test(combined),
        jlpt:         jpReq.jlpt,
        jpLevel:      jpReq.jpLevel,
        enLevel:      'native',
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
        source:       domain,
        mhlw:         false,
        desc:         descEn,
        descJp,
        req:          [],
        benefits:     [],
        hours:        'See listing',
        isLive:       true,
      };
    });

    res.status(200).json({ jobs });
  } catch (err) {
    console.error('[api/jobs]', err);
    res.status(500).json({ error: err.message });
  }
};

// Checks whether a URL actually loads — filters out dead/expired job pages
async function isLinkAlive(url) {
  try {
    const res = await fetch(url, {
      method: 'HEAD',
      signal: AbortSignal.timeout(4000),
      redirect: 'follow',
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; KakehashiBot/1.0)' },
    });
    return res.status < 400;
  } catch {
    return false;
  }
}

function detectType(text) {
  if (/\b(alt|english teach|efl|english instruct|board of edu)\b/.test(text)) return 'education';
  if (/\b(engineer|developer|programmer|software|it support|tech)\b/.test(text))  return 'it';
  if (/\b(sales|account exec|business dev|bdr|csm)\b/.test(text))                 return 'sales';
  if (/\b(admin|government|prefecture|municipal|civil serv)\b/.test(text))         return 'admin';
  return 'education';
}

function detectPref(text) {
  const map = {
    tokyo: 'tokyo', osaka: 'osaka', kyoto: 'kyoto',
    sapporo: 'hokkaido', hokkaido: 'hokkaido',
    fukuoka: 'fukuoka', nagoya: 'aichi', yokohama: 'kanagawa',
  };
  for (const [k, v] of Object.entries(map)) if (text.includes(k)) return v;
  return 'japan';
}

function detectLocation(text) {
  const cities = ['Tokyo','Osaka','Kyoto','Sapporo','Fukuoka','Nagoya','Yokohama','Kobe','Hiroshima','Sendai'];
  for (const c of cities) if (text.includes(c.toLowerCase())) return c;
  return null;
}

function detectJpRequirement(text) {
  // No Japanese required
  if (/日本語不問|日本語不要|日本語力は問わない|no japanese|japanese not required|english only|英語のみ/i.test(text)) {
    return { jlpt: 'none', jpLevel: 'none' };
  }
  // JLPT N1 / native
  if (/jlpt\s*n1|n1以上|ネイティブ.*日本語|native.*japanese|fluent.*japanese|日本語.*堪能|日本語.*流暢/i.test(text)) {
    return { jlpt: 'n1', jpLevel: 'native' };
  }
  // JLPT N2 / business
  if (/jlpt\s*n2|n2以上|ビジネス.*日本語|business.*japanese|business level.*japanese/i.test(text)) {
    return { jlpt: 'n2', jpLevel: 'business' };
  }
  // JLPT N3 / conversational
  if (/jlpt\s*n3|n3以上|日常会話|conversational.*japanese|japanese.*conversational/i.test(text)) {
    return { jlpt: 'n3', jpLevel: 'conversational' };
  }
  // N4/N5 / casual
  if (/jlpt\s*n[45]|n[45]以上|簡単.*日本語|基礎.*日本語|挨拶程度|basic.*japanese|casual.*japanese/i.test(text)) {
    return { jlpt: 'n4', jpLevel: 'basic' };
  }
  // If the ad itself is written in Japanese with no explicit level stated,
  // assume at least casual Japanese is expected in that workplace
  const hasJapaneseScript = /[぀-ヿ一-鿿]/.test(text);
  if (hasJapaneseScript) {
    return { jlpt: 'n4', jpLevel: 'basic' };
  }
  // English ad with no mention = no Japanese required
  return { jlpt: 'none', jpLevel: 'none' };
}

function extractSalary(text) {
  const m = text.match(/[¥￥]\s*[\d,]+(?:\s*[–~\-]\s*[¥￥]?\s*[\d,]+)?(?:\s*\/?\s*(?:month|mo|year|yr))?/i);
  return m ? m[0].trim() : null;
}

function formatPosted(dateStr) {
  if (!dateStr) return 'Recently';
  try {
    const days = Math.floor((Date.now() - new Date(dateStr)) / 86400000);
    if (days === 0)  return 'Today';
    if (days === 1)  return '1 day ago';
    if (days < 7)    return `${days} days ago`;
    if (days < 14)   return '1 week ago';
    return `${Math.floor(days / 7)} weeks ago`;
  } catch (_) { return 'Recently'; }
}
