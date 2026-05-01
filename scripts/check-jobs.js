#!/usr/bin/env node
/**
 * check-jobs.js — scan watched employer career pages for new job listings.
 *
 * Usage:
 *   node scripts/check-jobs.js
 *
 * On first run: fetches every page, saves a snapshot, prints everything found.
 * On later runs: prints only pages that have changed since last time.
 *
 * Snapshots are saved to data/url-snapshots.json (commit this file so "last
 * seen" persists between your sessions).
 */

const fs   = require('fs');
const path = require('path');

const WATCHED_FILE   = path.join(__dirname, '..', 'data', 'watched-urls.json');
const SNAPSHOTS_FILE = path.join(__dirname, '..', 'data', 'url-snapshots.json');

const JOB_KEYWORDS = [
  'job', 'vacancy', 'vacancies', 'position', 'opening', 'career',
  'employment', 'hiring', 'recruit', 'opportunity', 'apply', 'application',
  'staff', 'teacher', 'officer', 'manager', 'assistant', 'coordinator',
  '採用', '募集', '求人', '職員', '教員',
];

const SKIP_KEYWORDS = [
  'privacy', 'cookie', 'sitemap', 'login', 'logout', 'register',
  'newsletter', 'subscribe', 'donate', 'shop', 'store',
];

// ── Fetch a page and extract job-like signals ─────────────────────────────

async function fetchPage(url) {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(10000),
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml',
      'Accept-Language': 'en-US,en;q=0.9,ja;q=0.8',
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

function extractJobSignals(html, baseUrl) {
  const signals = [];

  // Extract all <a> tags with href + visible text
  const linkRe = /<a\s[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = linkRe.exec(html)) !== null) {
    const href    = m[1].trim();
    const rawText = m[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

    if (!rawText || rawText.length < 3 || rawText.length > 200) continue;
    const lc = rawText.toLowerCase();
    if (SKIP_KEYWORDS.some(k => lc.includes(k))) continue;

    const isJobLike =
      JOB_KEYWORDS.some(k => lc.includes(k)) ||
      href.toLowerCase().endsWith('.pdf') ||
      /\/(job|career|vacanc|recruit|employ|position|opening)/i.test(href);

    if (!isJobLike) continue;

    // Resolve relative URLs
    let fullHref = href;
    try {
      fullHref = new URL(href, baseUrl).href;
    } catch (_) {}

    signals.push(`${rawText} → ${fullHref}`);
  }

  // Also grab <title> and any <h1>/<h2> that look job-related
  const titleM = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  if (titleM) signals.unshift(`[page title] ${titleM[1].trim()}`);

  return [...new Set(signals)]; // deduplicate
}

function simpleHash(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(31, h) + str.charCodeAt(i) | 0;
  }
  return (h >>> 0).toString(16);
}

// ── Main ──────────────────────────────────────────────────────────────────

async function main() {
  const watched   = JSON.parse(fs.readFileSync(WATCHED_FILE, 'utf8'));
  let   snapshots = {};
  try {
    snapshots = JSON.parse(fs.readFileSync(SNAPSHOTS_FILE, 'utf8'));
  } catch (_) {}

  const autoEntries   = watched.filter(e => !e.manual);
  const manualEntries = watched.filter(e => e.manual);

  const isFirstRun = Object.keys(snapshots).length === 0;
  console.log(`\n🔍 Kakehashi Jobs — checking ${autoEntries.length} employer pages…`);
  if (isFirstRun) console.log('   (First run: saving baseline. All current listings will be shown.)\n');
  else console.log('   (Showing only pages that changed since last check.)\n');

  const newSnapshots = { ...snapshots };
  const changed      = [];
  const errors       = [];

  await Promise.allSettled(
    autoEntries.map(async entry => {
      process.stdout.write(`  Checking ${entry.employer}… `);
      try {
        const html    = await fetchPage(entry.url);
        const signals = extractJobSignals(html, entry.url);
        const hash    = simpleHash(signals.join('\n'));
        const prev    = snapshots[entry.url];

        newSnapshots[entry.url] = {
          employer:   entry.employer,
          type:       entry.type,
          hash,
          checkedAt:  new Date().toISOString(),
          signalCount: signals.length,
        };

        if (!prev || prev.hash !== hash) {
          console.log(signals.length > 0 ? `✅ ${signals.length} listing signal(s)` : '⚠️  page changed but no job links found');
          changed.push({ entry, signals, isNew: !prev });
        } else {
          console.log('— no change');
        }
      } catch (err) {
        console.log(`❌ error: ${err.message}`);
        errors.push({ entry, error: err.message });
      }
    })
  );

  // Save updated snapshots
  fs.writeFileSync(SNAPSHOTS_FILE, JSON.stringify(newSnapshots, null, 2));

  // ── Print report ────────────────────────────────────────────────────────
  console.log('\n' + '─'.repeat(60));

  if (changed.length === 0 && errors.length === 0) {
    console.log('\n✅ No changes detected. All pages look the same as last check.');
  }

  if (changed.length > 0) {
    console.log(`\n📋 ${changed.length} page(s) with new or changed content:\n`);
    for (const { entry, signals, isNew } of changed) {
      const tag = isNew ? '[FIRST RUN]' : '[CHANGED]';
      console.log(`${tag} ${entry.employer} (${entry.type})`);
      console.log(`  URL: ${entry.url}`);
      if (signals.length === 0) {
        console.log('  ⚠️  No job links extracted — check the page manually.');
      } else {
        const toShow = signals.slice(0, 8);
        for (const s of toShow) console.log(`  • ${s}`);
        if (signals.length > 8) console.log(`  … and ${signals.length - 8} more`);
      }
      console.log();
    }
  }

  if (errors.length > 0) {
    console.log(`⚠️  ${errors.length} page(s) failed to load:`);
    for (const { entry, error } of errors) {
      console.log(`  • ${entry.employer}: ${error}`);
    }
    console.log();
  }

  if (manualEntries.length > 0) {
    console.log(`\n👀 ${manualEntries.length} page(s) to check manually:\n`);
    for (const entry of manualEntries) {
      console.log(`  ${entry.employer} (${entry.type})`);
      console.log(`  → ${entry.url}`);
      if (entry.note) console.log(`     Note: ${entry.note}`);
      console.log();
    }
  }

  console.log('─'.repeat(60));
  console.log(`\nSnapshot saved to data/url-snapshots.json`);
  console.log(`Run again any time to check for new listings.\n`);
  console.log(`To add a new employer, edit data/watched-urls.json and add:`);
  console.log(`  { "employer": "Name", "type": "embassy|school|boe|club", "domain": "example.com", "url": "https://..." }\n`);
}

main().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
