module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  // Cache results for 30 minutes so we don't burn API quota on every page load
  res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate');

  try {
    // 1. Ask Exa to find relevant job pages across the web
    const exaRes = await fetch('https://api.exa.ai/search', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.Exa,
      },
      body: JSON.stringify({
        query: 'English speaker job Japan direct hire Board of Education ALT foreigner visa sponsorship 外国人 求人 直接雇用',
        numResults: 10,
        contents: { text: { maxCharacters: 1000 } },
        type: 'neural',
        useAutoprompt: true,
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

    // 2. Send all titles + descriptions to Google Translate in one batch request
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

    if (!translateRes.ok) {
      const body = await translateRes.text();
      throw new Error(`Translate ${translateRes.status}: ${body}`);
    }

    const { data: { translations } } = await translateRes.json();
    const n = results.length;

    // 3. Build job objects from the combined Exa + translation data
    const jobs = results.map((r, i) => {
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
        jlpt:         detectJlpt(combined),
        jpLevel:      'none',
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

function detectJlpt(text) {
  const m = text.match(/jlpt\s*(n[1-5])/i) || text.match(/\b(n[1-5])\b/i);
  return m ? m[1].toLowerCase() : 'n5';
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
