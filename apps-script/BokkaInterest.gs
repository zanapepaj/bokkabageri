/**
 * Bokka Bageri — interest list + opening-notice email (Google Apps Script)
 * =============================================================================
 * A SEPARATE file that EXTENDS BokkaDelivery.gs (does not modify it). It reuses the
 * shared globals/helpers from there: headerCols_, cell_, toId_, indexByName_ and the
 * ACTIVE_WEEKEND value (via activeWeekend_()).
 *
 * Flow: you paste the Formspree interest CSV into a tab called "Interesse", then run
 * "Oppdater interessenter" to build a deduped "Interessenter" dashboard. From the
 * 🌾 Bokka ▸ Interessenter menu you can preview, send a test to yourself, and — only
 * behind an explicit confirmation — send the opening notice to eligible contacts.
 *
 * Privacy: everything stays inside this private Sheet + your Gmail. No public API,
 * no external services. Emails are sent one-by-one (never a shared To/CC).
 */

/* ===================== CONFIG ===================== */

var INTEREST_RAW_SHEET_NAME = 'Interesse';       // where you paste the Formspree CSV
var INTERESSENTER_SHEET_NAME = 'Interessenter';  // the clean, deduped dashboard

// The new interest form submits this form_type; submitting it IS the opt-in.
var NEW_CONSENT_FORM_TYPE = 'interest_notification_signup';

var ORDER_URL = 'https://bokkabageri.no/#helgens-bestilling';
var EMAIL_SUBJECT = 'Bokka baker i helgen 🌾';
var EMAIL_FROM_NAME = 'Bokka Bageri';

var INTERESSENTER_HEADERS = ['Dato', 'Fornavn', 'E-post', 'Mobil', 'Produkter',
  'Dager', 'Nabolag', 'Samtykke', 'Aktiv', 'Sist varslet', 'Kilde-ID'];

// Reuse ACTIVE_WEEKEND from BokkaDelivery.gs; fall back if this file runs alone.
function activeWeekend_() {
  return (typeof ACTIVE_WEEKEND !== 'undefined' && ACTIVE_WEEKEND) ? ACTIVE_WEEKEND : '2026-09-19_20';
}

/* ===================== MENU ENTRY POINTS (wired from BokkaDelivery.gs onOpen) ===================== */

function oppdaterInteressenter() {
  var res = rebuildInteressenter_();
  SpreadsheetApp.getUi().alert('Interessenter oppdatert',
    res.total + ' kontakter i listen (' + res.consented + ' med samtykke).',
    SpreadsheetApp.getUi().ButtonSet.OK);
}

function forhandsvisVarsel() {
  var e = eligibleRecipients_();
  Logger.log('Forhåndsvisning (' + activeWeekend_() + '): ' + e.list.length + ' mottakere → ' +
    e.list.map(function (x) { return x.email; }).join(', '));
  SpreadsheetApp.getUi().alert('Forhåndsvis varsel', summaryText_(e), SpreadsheetApp.getUi().ButtonSet.OK);
}

function sendTestTilMeg() {
  var ui = SpreadsheetApp.getUi();
  var owner = Session.getEffectiveUser().getEmail();
  if (!owner) { ui.alert('Fant ikke din e-postadresse.'); return; }
  GmailApp.sendEmail(owner, '[TEST] ' + EMAIL_SUBJECT, buildEmailBody_('Bokka-venn'), { name: EMAIL_FROM_NAME });
  ui.alert('Testvarsel sendt', 'Sendte en testkopi til ' + owner + '.\n«Sist varslet» ble ikke endret.', ui.ButtonSet.OK);
}

function sendAapningsvarsel() {
  var ui = SpreadsheetApp.getUi();
  var week = activeWeekend_();
  var e = eligibleRecipients_();

  if (!e.list.length) {
    ui.alert('Ingen mottakere', 'Ingen kvalifiserte mottakere for bakehelg ' + week + '.\n\n' + summaryText_(e), ui.ButtonSet.OK);
    return;
  }

  // Quota check BEFORE sending — never start a batch we cannot finish.
  var quota = MailApp.getRemainingDailyQuota();
  if (quota < e.list.length) {
    ui.alert('For lav e-postkvote',
      'Du kan sende ' + quota + ' e-post i dag, men trenger ' + e.list.length + '.\nAvbryter uten å sende noe. Prøv igjen senere.',
      ui.ButtonSet.OK);
    return;
  }

  var resp = ui.alert('Send åpningsvarsel?',
    'Dette sender EKTE e-post til ' + e.list.length + ' mottaker(e) for bakehelg ' + week + '.\n\nFortsette?',
    ui.ButtonSet.YES_NO);
  if (resp !== ui.Button.YES) return;

  // Lock so a double-click can't start a second concurrent send.
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) {
    ui.alert('Kjører allerede', 'En sendejobb kjører allerede. Prøv igjen om litt.', ui.ButtonSet.OK);
    return;
  }

  var dash = SpreadsheetApp.getActive().getSheetByName(INTERESSENTER_SHEET_NAME);
  var col = indexByName_(INTERESSENTER_HEADERS);
  var sent = 0, failed = 0;
  try {
    for (var i = 0; i < e.list.length; i++) {
      var rec = e.list[i];
      try {
        GmailApp.sendEmail(rec.email, EMAIL_SUBJECT, buildEmailBody_(rec.fornavn), { name: EMAIL_FROM_NAME });
        // Stamp per successful send so a mid-batch failure resumes safely (no re-send).
        dash.getRange(rec.row, col['Sist varslet']).setValue(week);
        SpreadsheetApp.flush();
        sent++;
      } catch (err) {
        failed++;
        Logger.log('Feil ved sending til ' + rec.email + ': ' + (err && err.message));
      }
    }
  } finally {
    lock.releaseLock();
  }

  Logger.log('Åpningsvarsel ' + week + ': sendt=' + sent + ' feilet=' + failed +
    ' | hoppet: ugyldig=' + e.invalid + ', uten samtykke=' + e.noConsent +
    ', inaktive=' + e.inactive + ', allerede=' + e.alreadyNotified);
  ui.alert('Åpningsvarsel sendt',
    'Sendt: ' + sent + '\nFeilet: ' + failed + '\n\nHoppet over — ugyldig: ' + e.invalid +
    ', uten samtykke: ' + e.noConsent + ', inaktive: ' + e.inactive + ', allerede varslet: ' + e.alreadyNotified,
    ui.ButtonSet.OK);
}

/* ===================== BUILD / DEDUPE INTERESSENTER ===================== */

function rebuildInteressenter_() {
  var book = SpreadsheetApp.getActive();
  var raw = book.getSheetByName(INTEREST_RAW_SHEET_NAME);
  if (!raw) {
    throw new Error('Fant ikke fanen «' + INTEREST_RAW_SHEET_NAME + '». Lim inn Formspree-CSV der først.');
  }
  var cols = headerCols_(raw, 1);
  var lastRow = raw.getLastRow(), lastCol = raw.getLastColumn();
  var values = lastRow > 1 ? raw.getRange(2, 1, lastRow - 1, lastCol).getValues() : [];

  // Collapse raw rows per normalized email: newest-by-_date wins for profile,
  // and consent is TRUE if ANY row for that email is an explicit consent event.
  var perEmail = {};
  for (var i = 0; i < values.length; i++) {
    var row = values[i];
    var email = normEmail_(cell_(row, cols, 'epost'));
    if (!email) continue;

    var rec = perEmail[email] || (perEmail[email] = { dateVal: -Infinity, consent: false, profile: null });
    if (rawRowConsents_(row, cols)) rec.consent = true;

    var dv = parseDateVal_(cell_(row, cols, '_date'), i);
    if (rec.profile === null || dv > rec.dateVal) {
      rec.dateVal = dv;
      rec.profile = {
        dato: cell_(row, cols, '_date'),
        fornavn: String(cell_(row, cols, 'fornavn') || '').trim(),
        mobil: String(cell_(row, cols, 'mobil') || '').trim(),
        produkter: String(cell_(row, cols, 'produkter') || '').trim(),
        dager: String(cell_(row, cols, 'dager') || '').trim(),
        nabolag: String(cell_(row, cols, 'nabolag') || '').trim(),
        kildeId: toId_(cell_(row, cols, '_date'))
      };
    }
  }

  // Preserve prior workflow state (Aktiv, Sist varslet) + sticky consent.
  var dash = ensureInteressenterSheet_(book);
  var existing = readExisting_(dash);

  var emails = {};
  Object.keys(existing).forEach(function (e) { emails[e] = true; });
  Object.keys(perEmail).forEach(function (e) { emails[e] = true; });

  var out = [], consented = 0;
  Object.keys(emails).forEach(function (email) {
    var ex = existing[email];
    var rc = perEmail[email];
    var profile = (rc && rc.profile) ? rc.profile : (ex ? {
      dato: ex.dato, fornavn: ex.fornavn, mobil: ex.mobil, produkter: ex.produkter,
      dager: ex.dager, nabolag: ex.nabolag, kildeId: ex.kildeId
    } : null);
    if (!profile) return;

    // STICKY CONSENT: Ja if it was already Ja, or if any raw submission consented.
    // A later ambiguous submission can never revoke an earlier valid consent.
    var alreadyJa = ex && String(ex.samtykke).trim().toLowerCase() === 'ja';
    var samtykke = (alreadyJa || (rc && rc.consent)) ? 'Ja' : 'Nei';
    if (samtykke === 'Ja') consented++;

    // Aktiv is the manual opt-out switch — never overwrite an existing value.
    var aktiv = (ex && String(ex.aktiv).trim()) ? ex.aktiv : 'Ja';
    var sistVarslet = ex ? ex.sistVarslet : '';

    out.push([profile.dato, profile.fornavn, email, profile.mobil, profile.produkter,
      profile.dager, profile.nabolag, samtykke, aktiv, sistVarslet, profile.kildeId]);
  });

  out.sort(function (a, b) { return parseDateSort_(b[0]) - parseDateSort_(a[0]); }); // newest first
  writeInteressenter_(dash, out);
  return { total: out.length, consented: consented };
}

// A raw submission is an explicit consent event if EITHER:
//   (A) NEW form:  form_type === 'interest_notification_signup'  (the signup itself is the opt-in)
//   (B) OLD form:  nyhetsvarsel === 'Ja'                         (the legacy explicit checkbox)
function rawRowConsents_(row, cols) {
  var formType = String(cell_(row, cols, 'form_type') || '').trim().toLowerCase();
  if (formType === NEW_CONSENT_FORM_TYPE) return true;
  return String(cell_(row, cols, 'nyhetsvarsel') || '').trim().toLowerCase() === 'ja';
}

function ensureInteressenterSheet_(book) {
  var sheet = book.getSheetByName(INTERESSENTER_SHEET_NAME) || book.insertSheet(INTERESSENTER_SHEET_NAME);
  sheet.getRange(1, 1, 1, INTERESSENTER_HEADERS.length)
    .setValues([INTERESSENTER_HEADERS]).setFontWeight('bold').setBackground('#efe1c4');
  sheet.setFrozenRows(1);
  return sheet;
}

function readExisting_(dash) {
  var map = {}, last = dash.getLastRow();
  if (last < 2) return map;
  var col = indexByName_(INTERESSENTER_HEADERS);
  var data = dash.getRange(2, 1, last - 1, INTERESSENTER_HEADERS.length).getValues();
  data.forEach(function (r) {
    var email = normEmail_(r[col['E-post'] - 1]);
    if (!email) return;
    map[email] = {
      dato: r[col['Dato'] - 1], fornavn: r[col['Fornavn'] - 1], mobil: r[col['Mobil'] - 1],
      produkter: r[col['Produkter'] - 1], dager: r[col['Dager'] - 1], nabolag: r[col['Nabolag'] - 1],
      samtykke: r[col['Samtykke'] - 1], aktiv: r[col['Aktiv'] - 1],
      sistVarslet: r[col['Sist varslet'] - 1], kildeId: r[col['Kilde-ID'] - 1]
    };
  });
  return map;
}

function writeInteressenter_(dash, out) {
  dash.getRange(1, 1, 1, INTERESSENTER_HEADERS.length)
    .setValues([INTERESSENTER_HEADERS]).setFontWeight('bold').setBackground('#efe1c4');
  dash.setFrozenRows(1);

  var maxRows = dash.getMaxRows();
  if (maxRows > 1) dash.getRange(2, 1, maxRows - 1, INTERESSENTER_HEADERS.length).clearContent().clearDataValidations();

  if (out.length) {
    dash.getRange(2, 1, out.length, INTERESSENTER_HEADERS.length).setValues(out);
    var col = indexByName_(INTERESSENTER_HEADERS);
    var jaNei = SpreadsheetApp.newDataValidation().requireValueInList(['Ja', 'Nei'], true).setAllowInvalid(false).build();
    dash.getRange(2, col['Aktiv'], out.length, 1).setDataValidation(jaNei); // manual opt-out switch
  }
  formatInteressenter_(dash, out.length);
}

function formatInteressenter_(dash, dataCount) {
  var col = indexByName_(INTERESSENTER_HEADERS);
  dash.setColumnWidth(col['Dato'], 150);
  dash.setColumnWidth(col['E-post'], 210);
  dash.setColumnWidth(col['Produkter'], 220);
  dash.setColumnWidth(col['Nabolag'], 150);
  dash.setColumnWidth(col['Sist varslet'], 120);
  if (dataCount > 0) {
    dash.getRange(2, col['Produkter'], dataCount, 1).setWrap(true).setVerticalAlignment('middle');
  }
}

/* ===================== ELIGIBILITY ===================== */

// Eligible = Samtykke Ja AND Aktiv Ja AND valid email AND not yet notified this weekend.
function eligibleRecipients_() {
  var week = activeWeekend_();
  var result = { list: [], invalid: 0, noConsent: 0, inactive: 0, alreadyNotified: 0, total: 0 };
  var dash = SpreadsheetApp.getActive().getSheetByName(INTERESSENTER_SHEET_NAME);
  if (!dash) return result;
  var last = dash.getLastRow();
  if (last < 2) return result;

  var col = indexByName_(INTERESSENTER_HEADERS);
  var data = dash.getRange(2, 1, last - 1, INTERESSENTER_HEADERS.length).getValues();
  for (var i = 0; i < data.length; i++) {
    var r = data[i];
    result.total++;
    var email = normEmail_(r[col['E-post'] - 1]);
    var samtykke = String(r[col['Samtykke'] - 1]).trim().toLowerCase();
    var aktiv = String(r[col['Aktiv'] - 1]).trim().toLowerCase();
    var sist = String(r[col['Sist varslet'] - 1]).trim();

    if (!isValidEmail_(email)) { result.invalid++; continue; }
    if (samtykke !== 'ja') { result.noConsent++; continue; }
    if (aktiv !== 'ja') { result.inactive++; continue; }
    if (sist === String(week)) { result.alreadyNotified++; continue; }

    result.list.push({ row: i + 2, email: email, fornavn: String(r[col['Fornavn'] - 1] || '').trim() });
  }
  return result;
}

function summaryText_(e) {
  return 'Klar til å sende til ' + e.list.length + ' mottaker(e) for bakehelg ' + activeWeekend_() + '.\n\n' +
    'Hoppet over:\n' +
    '• ugyldig e-post: ' + e.invalid + '\n' +
    '• uten samtykke: ' + e.noConsent + '\n' +
    '• inaktive (Aktiv=Nei): ' + e.inactive + '\n' +
    '• allerede varslet denne helgen: ' + e.alreadyNotified;
}

/* ===================== EMAIL BODY ===================== */

function buildEmailBody_(fornavn) {
  var hei = fornavn ? ('Hei ' + fornavn + '!') : 'Hei!';
  return hei + '\n\n' +
    'Bokka baker i helgen 🌾\n' +
    'Bestillingen er nå åpen.\n\n' +
    'Denne helgen finner du fersk surdeigsbakst på:\n' +
    ORDER_URL + '\n\n' +
    'Vi baker i små mengder, så det kan bli utsolgt.\n\n' +
    'Hilsen\n' +
    'Bokka Bageri\n\n' +
    '—\n' +
    'Vil du ikke ha flere slike beskjeder? Svar på denne e-posten og si fra.';
}

/* ===================== SMALL HELPERS ===================== */

function normEmail_(v) { return String(v == null ? '' : v).trim().toLowerCase(); }

function isValidEmail_(v) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v || '').trim()); }

// ms timestamp for newest-wins; unparseable dates fall back to row index (later row = newer).
function parseDateVal_(v, fallbackIdx) {
  if (v instanceof Date) return v.getTime();
  var t = Date.parse(String(v));
  return isNaN(t) ? fallbackIdx : t;
}

function parseDateSort_(v) {
  var t = Date.parse(String(v));
  return isNaN(t) ? 0 : t;
}
