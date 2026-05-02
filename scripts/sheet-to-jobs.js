#!/usr/bin/env node
/**
 * sheet-to-jobs.js
 * ─────────────────────────────────────────────────────────────────
 * Pulls your live Google Sheet and updates data/manual-jobs.json,
 * then optionally commits + pushes to GitHub (auto-deploys on Vercel).
 *
 * Usage (no export needed — pulls directly from Google Sheets):
 *   node scripts/sheet-to-jobs.js
 *
 * Or use a local CSV if you prefer:
 *   node scripts/sheet-to-jobs.js ~/Downloads/"Jobs Direct Japan - Sheet1.csv"
 * ─────────────────────────────────────────────────────────────────
 */

const fs      = require('fs');
const path    = require('path');
const https   = require('https');
const { execSync } = require('child_process');

// ── Your Google Sheet ID (from the URL) ───────────────────────────
const SHEET_ID  = '1LHUiuD9LHbDpqRtAaXHrP-ispHukQEk-t4UaJOnQ8uI';
const SHEET_GID = '0';
const SHEET_CSV_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv&gid=${SHEET_GID}`;

// ── 1. Get CSV — from live sheet or local file ────────────────────
function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      // Follow redirects (Google issues a redirect to the actual CSV)
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchUrl(res.headers.location).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

async function getCsv() {
  const localPath = process.argv[2];
  if (localPath) {
    const resolved = localPath.replace(/^~/, process.env.HOME);
    if (!fs.existsSync(resolved)) {
      console.error(`\n❌  File not found: ${resolved}\n`); process.exit(1);
    }
    console.log(`\n📂  Reading local file: ${resolved}`);
    return fs.readFileSync(resolved, 'utf8');
  }
  console.log('\n🌐  Fetching live Google Sheet…');
  return fetchUrl(SHEET_CSV_URL);
}

// ── 2. Parse CSV ───────────────────────────────────────────────────
function parseCsv(text) {
  const lines = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      if (inQuotes && text[i + 1] === '"') { current += '"'; i++; }
      else inQuotes = !inQuotes;
    } else if (ch === '\n' && !inQuotes) {
      lines.push(current); current = '';
    } else {
      current += ch;
    }
  }
  if (current) lines.push(current);

  const rows = lines.map(line => {
    const cells = []; let cell = ''; let q = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '"') { if (q && line[i+1] === '"') { cell += '"'; i++; } else q = !q; }
      else if (c === ',' && !q) { cells.push(cell.trim()); cell = ''; }
      else cell += c;
    }
    cells.push(cell.trim());
    return cells;
  });

  if (rows.length < 2) return [];
  const headers = rows[0];
  return rows.slice(1).map(row => {
    const obj = {};
    headers.forEach((h, i) => { obj[h.trim()] = (row[i] || '').trim(); });
    return obj;
  });
}

// ── 3. Field mapping helpers ───────────────────────────────────────

function toShort(employer) {
  return employer.split(/[\s\(\)]+/).filter(Boolean)
    .map(w => w[0].toUpperCase()).join('').slice(0, 3) || 'JB';
}

function toDomain(employer, url) {
  const MAP = {
    'australian embassy': 'dfat.gov.au',
    'british embassy':    'gov.uk',
    'u.s. embassy':       'jp.usembassy.gov',
    'embassy of switzerland': 'eda.admin.ch',
    'swiss':              'eda.admin.ch',
    'asij':               'asij.ac.jp',
    'american school in japan': 'asij.ac.jp',
    'nagano':             'pref.nagano.lg.jp',
    'issh':               'isshtokyo.org',
    'sacred heart':       'isshtokyo.org',
  };
  const emp = employer.toLowerCase();
  for (const [k, v] of Object.entries(MAP)) {
    if (emp.includes(k)) return v;
  }
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}

function toPref(location) {
  const l = location.toLowerCase();
  if (l.includes('tokyo') || l.includes('minato')) return 'tokyo';
  if (l.includes('osaka')) return 'osaka';
  if (l.includes('kyoto')) return 'kyoto';
  if (l.includes('fukuoka')) return 'fukuoka';
  if (l.includes('nagoya')) return 'aichi';
  if (l.includes('sapporo') || l.includes('hokkaido')) return 'hokkaido';
  if (l.includes('yokohama')) return 'kanagawa';
  return 'japan';
}

function toType(label, title) {
  const t = (label + ' ' + title).toLowerCase();
  if (/edu|alt|teach|school|language|boe/.test(t)) return 'education';
  if (/tech|engineer|developer|it|software/.test(t)) return 'it';
  if (/sales|marketing|comms|social media|content/.test(t)) return 'sales';
  return 'admin';
}

function toIndustry(label, title) {
  const t = (label + ' ' + title).toLowerCase();
  if (/edu|alt|teach|school|language/.test(t)) return 'education';
  if (/gov|embassy|defence|logistics/.test(t)) return 'government';
  if (/market|sales|comms/.test(t)) return 'sales';
  return 'government';
}

function toEmployerType(label, employer) {
  const t = (label + ' ' + employer).toLowerCase();
  if (/boe|board of edu|prefectural.*edu/.test(t)) return 'boe';
  if (/gov|embassy|prefecture|municipal|defence/.test(t)) return 'government';
  return 'company';
}

function toContract(jobType) {
  const t = jobType.toLowerCase();
  if (/part.time|irregular|30.hr/.test(t)) return 'part-time';
  return 'full-time';
}

function toJpLevel(raw) {
  const t = raw.toLowerCase();
  if (/native|fluent.*teach/.test(t)) return { jlpt: 'n1', jpLevel: 'fluent' };
  if (/fluent/.test(t)) return { jlpt: 'n1', jpLevel: 'fluent' };
  if (/n2|business|professional|high proficiency/.test(t)) return { jlpt: 'n2', jpLevel: 'business' };
  if (/n3|conversational/.test(t)) return { jlpt: 'n3', jpLevel: 'conversational' };
  if (/n4|n5|basic/.test(t)) return { jlpt: 'n4', jpLevel: 'basic' };
  if (/none|not (specified|required)|no japanese|english only/.test(t)) return { jlpt: 'none', jpLevel: 'none' };
  return { jlpt: 'none', jpLevel: 'none' };
}

function toVisa(raw) {
  const t = raw.toLowerCase();
  if (/^yes$/.test(t.trim())) return { visa: true, visaRenewal: false };
  if (/pre.existing|valid.*visa|must.*reside|already.*japan/.test(t)) return { visa: false, visaRenewal: true };
  return { visa: false, visaRenewal: false };
}

function toSalaryRank(salary) {
  const clean = salary.replace(/[,¥\s]/g, '');
  const monthly = clean.match(/(\d+)\+?\/mo/i);
  if (monthly) {
    const n = parseInt(monthly[1]);
    if (n >= 500000) return 6;
    if (n >= 400000) return 5;
    if (n >= 350000) return 4;
    if (n >= 300000) return 3;
    return 2;
  }
  if (/highly.competitive/i.test(salary)) return 7;
  if (/competitive/i.test(salary)) return 3;
  if (/\d+.*hr/i.test(salary)) return 2;
  return 1;
}

function toPosted(raw) {
  if (!raw || /asap|not specified/i.test(raw)) return 'Recently';
  const d = new Date(raw);
  if (!isNaN(d)) {
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  }
  return raw;
}

function toCareerLevel(title, desc) {
  const t = (title + ' ' + desc).toLowerCase();
  if (/director|executive|vp |chief/.test(t)) return 'executive';
  if (/senior|manager|head of|lead /.test(t)) return 'senior';
  if (/mid|experienced|associate/.test(t)) return 'mid';
  return 'entry';
}

function toAltFriendly(type, careerLevel, label) {
  if (type === 'education') return true;
  if (careerLevel === 'entry') return true;
  if (/social media|content|comms/i.test(label)) return true;
  return false;
}

// ── 4. Main ───────────────────────────────────────────────────────
async function main() {
  // Fetch CSV from live Google Sheet (or local file if path given)
  const rawCsv = await getCsv();

  // Strip UTF-8 BOM if present (Google Sheets adds this)
  const csv = rawCsv.replace(/^﻿/, '');

  const rows = parseCsv(csv);
  const activeRows = rows.filter(r => /yes/i.test(r['Active'] || ''));

  console.log(`📄  Found ${rows.length} rows, ${activeRows.length} active.\n`);

  // Safety check — never overwrite with an empty list
  if (activeRows.length === 0) {
    console.error('❌  No active rows found. Check that your "Active" column contains "Yes".');
    console.error('   Column headers detected:', rows[0] ? Object.keys(rows[0]).join(', ') : '(none)');
    console.error('   Aborting — manual-jobs.json was NOT changed.\n');
    process.exit(1);
  }

const jobs = activeRows.map((r, i) => {
  const title    = r['Title'] || '';
  const employer = r['Employer'] || '';
  const label    = r['Label'] || '';
  const location = r['Location'] || 'Tokyo, Japan';
  const url      = r['URL'] || '';
  const salary   = r['Salary'] || 'See listing';
  const jpRaw    = r['Japanese Level'] || '';
  const visaRaw  = r['Visa Sponsored'] || '';
  const jobType  = r['Job Type'] || 'Full Time';
  const desc     = r['Description'] || '';
  const aiNote   = r['AI Note (AI can make mistakes)'] || '';
  const deadline = r['Closing date'] || 'See listing';
  const posted   = r['Posted Date'] || 'Recently';

  const { jlpt, jpLevel } = toJpLevel(jpRaw);
  const { visa, visaRenewal } = toVisa(visaRaw);
  const type        = toType(label, title);
  const careerLevel = toCareerLevel(title, desc);
  const contract    = toContract(jobType);
  const salaryClean = salary.replace(/\s+/g, ' ').trim();

  const reqItems = [];
  if (visaRenewal) reqItems.push('Pre-existing work rights in Japan required');
  if (!visa && !visaRenewal && /no|not available/i.test(visaRaw)) reqItems.push('Visa sponsorship not available');
  if (aiNote && !/ai can make/i.test(aiNote)) reqItems.push(aiNote.replace(/\.$/, ''));

  return {
    titleEn:      title,
    titleJp:      '',
    employer:     employer,
    short:        toShort(employer),
    domain:       toDomain(employer, url),
    location:     location,
    pref:         toPref(location),
    type:         type,
    contract:     contract,
    visa:         visa,
    visaRenewal:  visaRenewal,
    altFriendly:  toAltFriendly(type, careerLevel, label),
    jlpt:         jlpt,
    jpLevel:      jpLevel,
    enLevel:      'native',
    otherLangs:   [],
    industry:     toIndustry(label, title),
    careerLevel:  careerLevel,
    employerType: toEmployerType(label, employer),
    remoteOk:     false,
    overseasOk:   false,
    salary:       salaryClean,
    salaryRank:   toSalaryRank(salaryClean),
    posted:       toPosted(posted),
    deadline:     deadline,
    url:          url,
    source:       employer,
    mhlw:         false,
    desc:         desc,
    descJp:       '',
    responsibilities: [],
    req:          reqItems,
    benefits:     [],
    hours:        jobType,
  };
});

  // ── 5. Save JSON ─────────────────────────────────────────────────
  const outPath = path.join(__dirname, '..', 'data', 'manual-jobs.json');
  fs.writeFileSync(outPath, JSON.stringify(jobs, null, 2) + '\n', 'utf8');

  console.log(`✅  Saved ${jobs.length} jobs to data/manual-jobs.json\n`);
  jobs.forEach(j => console.log(`   • ${j.titleEn} — ${j.employer} (${j.salary})`));

  // ── 6. Ask to commit & push ───────────────────────────────────────
  const readline = require('readline');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  rl.question('\n🚀  Commit and push to GitHub? (y/n): ', answer => {
    rl.close();
    if (answer.trim().toLowerCase() !== 'y') {
      console.log('\n👍  JSON saved locally. Push when ready with: git add data/manual-jobs.json && git push origin main\n');
      return;
    }
    try {
      execSync('git add data/manual-jobs.json', { stdio: 'inherit' });
      execSync(`git commit -m "Update manual jobs from Google Sheet (${jobs.length} active listings)"`, { stdio: 'inherit' });
      execSync('git push origin main', { stdio: 'inherit' });
      console.log('\n✅  Done! Vercel will deploy in about 30 seconds.\n');
    } catch (e) {
      console.error('\n❌  Git error:', e.message);
      console.error('   Try running git push manually.\n');
    }
  });
}

main().catch(err => {
  console.error('\n❌  Error:', err.message, '\n');
  process.exit(1);
});
