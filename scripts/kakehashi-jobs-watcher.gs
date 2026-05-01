/**
 * Kakehashi Jobs Watcher — Google Apps Script (Exa-powered)
 *
 * HOW TO SET UP (one time only):
 * 1. Go to https://sheets.google.com → create a new blank spreadsheet.
 * 2. Click Extensions → Apps Script.
 * 3. Delete all existing code, paste this entire file, click Save.
 * 4. Refresh the sheet — a "🔍 Check Jobs" menu will appear.
 * 5. Click  🔍 Check Jobs → Enter Exa API key  and paste your key.
 * 6. Click  🔍 Check Jobs → Set up sheets  (run once).
 * 7. Click  🔍 Check Jobs → Search for new jobs  to run your first search.
 *
 * ADDING NEW EMPLOYERS:
 *   Go to the "Employers" tab → add a new row with name + domain. That's it.
 *
 * MARKING JOBS:
 *   In the "Jobs Found" tab, set the Status column to:
 *   "Added"     — you've added it to your manual-jobs.json
 *   "Skip"      — not relevant, won't show again
 *   (blank)     — new / not yet reviewed
 */

// ── Menu ──────────────────────────────────────────────────────────────────

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('🔍 Check Jobs')
    .addItem('Enter Exa API key', 'enterApiKey')
    .addItem('Set up sheets (run once)', 'setupSheets')
    .addSeparator()
    .addItem('Search for new jobs now', 'searchForJobs')
    .addSeparator()
    .addItem('Schedule weekly search (every Monday)', 'scheduleWeekly')
    .addItem('Remove weekly schedule', 'removeSchedule')
    .addToUi();
}

// ── API Key setup ─────────────────────────────────────────────────────────

function enterApiKey() {
  const ui  = SpreadsheetApp.getUi();
  const res = ui.prompt(
    'Enter your Exa API key',
    'Paste your Exa API key below (find it at exa.ai → Dashboard → API Keys):',
    ui.ButtonSet.OK_CANCEL
  );
  if (res.getSelectedButton() !== ui.Button.OK) return;
  const key = res.getResponseText().trim();
  if (!key) { ui.alert('No key entered.'); return; }
  PropertiesService.getUserProperties().setProperty('EXA_API_KEY', key);
  ui.alert('✅ API key saved! Now run "Set up sheets" if you haven\'t already.');
}

function getApiKey() {
  return PropertiesService.getUserProperties().getProperty('EXA_API_KEY') || '';
}

// ── One-time setup ────────────────────────────────────────────────────────

function setupSheets() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  // ── Employers tab ────────────────────────────────────────────────────
  let emp = ss.getSheetByName('Employers');
  if (!emp) emp = ss.insertSheet('Employers');
  emp.clearContents();

  styleHeader(emp.getRange(1, 1, 1, 3), ['Employer', 'Type', 'Domain to search']);
  emp.setColumnWidth(1, 240);
  emp.setColumnWidth(2, 100);
  emp.setColumnWidth(3, 220);
  emp.setFrozenRows(1);

  emp.getRange(2, 1, 1, 1)
    .setNote('Add new employers here any time. Just fill in all three columns and run the search again.');

  const defaultEmployers = [
    ['U.S. Embassy Tokyo',               'Embassy', 'jp.usembassy.gov'],
    ['Australian Embassy Tokyo',          'Embassy', 'dfatcareers.nga.net.au'],
    ['Embassy of Switzerland Tokyo',      'Embassy', 'eda.admin.ch'],
    ['Embassy of Ireland Tokyo',          'Embassy', 'ireland.ie'],
    ['New Zealand Embassy Tokyo',         'Embassy', 'mfat.govt.nz'],
    ['British Embassy Tokyo',             'Embassy', 'fco.tal.net'],
    ['German Embassy Tokyo',              'Embassy', 'japan.diplo.de'],
    ['EU Delegation to Japan',            'Embassy', 'eeas.europa.eu'],
    ['Canadian Embassy Tokyo',            'Embassy', 'canada.ca'],
    ['American School in Japan (ASIJ)',   'School',  'asij.ac.jp'],
    ['British School Tokyo (BST)',        'School',  'bst.ac.jp'],
    ['Yokohama International School',     'School',  'yis.ac.jp'],
    ['Intl School of the Sacred Heart',   'School',  'issh.ac.jp'],
    ['American Club of Tokyo',            'Club',    'americancluboftokyo.org'],
    ['Tokyo International School',        'School',  'tokyois.com'],
    ['Canadian Academy (Kobe)',           'School',  'canadianacademy.ac.jp'],
    ['St. Maur International School',     'School',  'stmaur.ac.jp'],
    ["St. Michael's Intl School (Kobe)",  'School',  'smiskobe.ac.jp'],
    ['Nagano Prefectural BOE',            'BOE',     'pref.nagano.lg.jp'],
    ['Satte City BOE',                    'BOE',     'city.satte.lg.jp'],
  ];
  emp.getRange(2, 1, defaultEmployers.length, 3).setValues(defaultEmployers);

  // ── Jobs Found tab ───────────────────────────────────────────────────
  let jobs = ss.getSheetByName('Jobs Found');
  if (!jobs) jobs = ss.insertSheet('Jobs Found');
  jobs.clearContents();

  styleHeader(jobs.getRange(1, 1, 1, 7),
    ['Status', 'Employer', 'Type', 'Job Title', 'Entry Level?', 'URL', 'Found On']);
  jobs.setColumnWidth(1, 100);
  jobs.setColumnWidth(2, 200);
  jobs.setColumnWidth(3, 90);
  jobs.setColumnWidth(4, 280);
  jobs.setColumnWidth(5, 110);
  jobs.setColumnWidth(6, 80);
  jobs.setColumnWidth(7, 120);
  jobs.setFrozenRows(1);

  // ── Seen URLs tab (hidden — tracks what we've already surfaced) ──────
  let seen = ss.getSheetByName('_Seen');
  if (!seen) {
    seen = ss.insertSheet('_Seen');
    seen.getRange(1, 1, 1, 2).setValues([['URL', 'FoundOn']]);
    seen.hideSheet();
  }

  ss.setActiveSheet(emp);
  SpreadsheetApp.getUi().alert(
    '✅ Setup complete!\n\n' +
    '• "Employers" tab — add/remove employers any time\n' +
    '• "Jobs Found" tab — new job listings appear here\n\n' +
    'Now click  🔍 Check Jobs → Search for new jobs'
  );
}

// ── Main search ───────────────────────────────────────────────────────────

function searchForJobs() {
  const apiKey = getApiKey();
  if (!apiKey) {
    SpreadsheetApp.getUi().alert('Please set your Exa API key first:\n🔍 Check Jobs → Enter Exa API key');
    return;
  }

  const ss       = SpreadsheetApp.getActiveSpreadsheet();
  const empSheet = ss.getSheetByName('Employers');
  const jobSheet = ss.getSheetByName('Jobs Found');
  const seenSheet= ss.getSheetByName('_Seen');

  if (!empSheet || !jobSheet || !seenSheet) {
    SpreadsheetApp.getUi().alert('Run "Set up sheets" first.');
    return;
  }

  // Load employers
  const empRows = empSheet.getDataRange().getValues().slice(1)
    .filter(r => r[0] && r[2]);

  // Load already-seen URLs
  const seenData = seenSheet.getDataRange().getValues().slice(1);
  const seenUrls = new Set(seenData.map(r => r[0]));

  const threeWeeksAgo = new Date(Date.now() - 21 * 24 * 60 * 60 * 1000).toISOString();
  const today = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'MMM d, yyyy');

  const newJobs    = [];
  const newSeenUrls= [];

  for (const [employer, type, domain] of empRows) {
    try {
      const results = searchDomain(apiKey, domain, threeWeeksAgo);
      for (const result of results) {
        if (seenUrls.has(result.url)) continue; // already surfaced before

        const title      = result.title || '(no title)';
        const entryLevel = isEntryLevel(title + ' ' + (result.text || ''));
        newJobs.push([
          '',           // Status — user fills in "Added" or "Skip"
          employer,
          type,
          title,
          entryLevel ? '✅ Yes' : '',
          result.url,
          today,
        ]);
        newSeenUrls.push([result.url, today]);
      }
    } catch (e) {
      // Log silently — don't interrupt the loop
      console.log(`Error for ${employer}: ${e.message}`);
    }

    // Pause briefly to stay within Exa rate limits
    Utilities.sleep(300);
  }

  // Append new jobs to Jobs Found sheet (newest at top)
  if (newJobs.length > 0) {
    // Insert rows after header
    jobSheet.insertRowsAfter(1, newJobs.length);
    jobSheet.getRange(2, 1, newJobs.length, 7).setValues(newJobs);

    // Make URL column clickable
    for (let i = 0; i < newJobs.length; i++) {
      const url = newJobs[i][5];
      if (url) {
        jobSheet.getRange(i + 2, 6)
          .setFormula(`=HYPERLINK("${url.replace(/"/g, '')}", "Open →")`);
      }
      // Highlight entry-level rows in light green
      if (newJobs[i][4] === '✅ Yes') {
        jobSheet.getRange(i + 2, 1, 1, 7).setBackground('#d4edda');
      }
    }

    // Save newly seen URLs
    const seenStart = seenSheet.getLastRow() + 1;
    seenSheet.getRange(seenStart, 1, newSeenUrls.length, 2).setValues(newSeenUrls);
  }

  ss.setActiveSheet(jobSheet);

  const entryCount = newJobs.filter(j => j[4] === '✅ Yes').length;
  SpreadsheetApp.getUi().alert(
    newJobs.length === 0
      ? '✅ No new jobs found since last check.\n\nAll listings have already been seen.'
      : `🔔 Found ${newJobs.length} new listing(s)!\n` +
        (entryCount > 0 ? `✅ ${entryCount} flagged as entry-level friendly.\n` : '') +
        `\nCheck the "Jobs Found" tab. Green rows are entry-level friendly.\n` +
        `Set Status to "Added" when you add one to your site, or "Skip" to hide it next time.`
  );
}

// ── Exa API search for a specific domain ─────────────────────────────────

function searchDomain(apiKey, domain, since) {
  const payload = {
    query: 'job vacancy position hiring staff recruit employment',
    numResults: 10,
    contents: { text: { maxCharacters: 400 } },
    type: 'neural',
    useAutoprompt: true,
    startPublishedDate: since,
    includeDomains: [domain],
  };

  const response = UrlFetchApp.fetch('https://api.exa.ai/search', {
    method: 'post',
    contentType: 'application/json',
    headers: { 'x-api-key': apiKey },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  });

  const code = response.getResponseCode();
  if (code !== 200) return [];

  const data = JSON.parse(response.getContentText());
  return data.results || [];
}

// ── Entry-level detection ─────────────────────────────────────────────────

function isEntryLevel(text) {
  const t = text.toLowerCase();

  // Definitely NOT entry level
  const senior = /\b(director|head of|vp |vice president|senior|lead |principal|chief|cto|coo|cfo|ceo|president)\b/;
  if (senior.test(t)) return false;

  // Positive signals
  const entry = /\b(alt|assistant|associate|coordinator|administrator|staff|officer|local hire|locally employed|les |part.time|part time|driver|kitchen|chef|server|receptionist|secretary|clerk|support|specialist|teacher|instructor|tutor|entry.level|entry level|junior|graduate|new grad|fresh|no experience)\b/;
  return entry.test(t);
}

// ── Scheduling ────────────────────────────────────────────────────────────

function scheduleWeekly() {
  removeSchedule();
  ScriptApp.newTrigger('searchForJobs')
    .timeBased()
    .everyWeeks(1)
    .onWeekDay(ScriptApp.WeekDay.MONDAY)
    .atHour(9)
    .create();
  SpreadsheetApp.getUi().alert(
    '✅ Scheduled!\n\nEvery Monday at ~9am this sheet will search for new jobs automatically.\nOpen "Jobs Found" any time to see what\'s new.'
  );
}

function removeSchedule() {
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'searchForJobs')
    .forEach(t => ScriptApp.deleteTrigger(t));
}

// ── Helpers ───────────────────────────────────────────────────────────────

function styleHeader(range, values) {
  range.setValues([values])
    .setFontWeight('bold')
    .setBackground('#1a1a2e')
    .setFontColor('#ffffff');
}
