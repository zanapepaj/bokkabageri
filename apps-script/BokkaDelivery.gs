/**
 * Bokka Bageri — private delivery dashboard (Google Apps Script)
 * =============================================================
 * Lives INSIDE the Google Sheet that Formspree fills in. It never talks to the
 * outside world: only SpreadsheetApp + plain Google Maps search URLs (no API key,
 * no UrlFetch, no external services). The Formspree tab is treated as RAW DATA and
 * is never renamed, reordered or overwritten.
 *
 * It maintains two extra tabs:
 *   1. "Bestillinger"      — adult operational dashboard (all weekend orders)
 *   2. "Barn - Bokka-rute" — child-friendly delivery view (minimum info only)
 *
 * Install: Extensions → Apps Script → paste this file → Save → run syncBokkaOrders.
 * A "🌾 Bokka" menu also appears in the sheet after the first reload.
 */

/* ===================== CONFIG ===================== */

// Leave '' to auto-detect the Formspree tab (the sheet that has _date + form_type).
// Or set it to the exact tab name, e.g. 'Skjema svar 1'.
var RAW_SHEET_NAME = '';

var ORDERS_SHEET_NAME = 'Bestillinger';
var KIDS_SHEET_NAME = 'Barn - Bokka-rute';

var STATUS_OPTIONS = ['Ny', 'Bekreftet', 'Pakket', 'Ute på tur', 'Levert'];
var DEFAULT_STATUS = 'Ny';

var MAPS_BASE = 'https://www.google.com/maps/search/?api=1&query=';
var ADDRESS_SUFFIX = ', Stavanger, Norway';

var WEEKEND = 'weekend_order';

// Only orders tagged with this baking-weekend batch appear in the dashboard. Must
// match the hidden "bakehelg" field on the website order form. Change it each weekend.
var ACTIVE_WEEKEND = '2026-09-19_20';

// Raw Formspree header names (matched by name, never by column letter).
var RAW = {
  date: '_date',
  formType: 'form_type',
  bestilling: 'bestilling',
  klassisk: 'antall_klassisk_surdeigsbrod',
  bokka: 'antall_bokka_brod',
  kanel: 'antall_kanelbolle',
  kanelVanilje: 'antall_kanelbolle_vaniljekrem',
  fornavn: 'fornavn',
  mobil: 'mobil',
  epost: 'epost',
  adresse: 'adresse',
  lordag: 'lordag_tid',
  sondag: 'sondag_tid',
  kommentar: 'kommentar',
  levering: 'levering',
  bakehelg: 'bakehelg'
};

// Columns of the tabs this script owns (rewritten on every sync). "Kilde-ID" is the
// hidden internal identifier (Formspree _date) used to match rows; never shown to kids.
var ORDER_HEADERS = ['Dato', 'Fornavn', 'Mobil', 'E-post', 'Adresse', 'Bestilling',
  'Leveringstid', 'Kommentar', 'Stopp', 'Status', 'Pakket', 'Levert', 'Kart', 'Kilde-ID'];
var KIDS_HEADERS = ['Stopp', 'Adresse', 'Bestilling', 'Leveringstid', 'Kart', 'Levert', 'Kilde-ID'];
var KIDS_HEADER_ROW = 4; // rows 1–2 hold the summary, row 4 is the table header.

/* ===================== MENU ===================== */

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('🌾 Bokka')
    .addItem('Synk bestillinger nå', 'syncBokkaOrders')
    .addToUi();
}

/* ===================== MAIN SYNC ===================== */

function syncBokkaOrders() {
  var book = SpreadsheetApp.getActive();
  var raw = findRawSheet_(book);
  var rawCols = headerCols_(raw, 1);

  var lastRow = raw.getLastRow();
  var lastCol = raw.getLastColumn();
  var values = lastRow > 1 ? raw.getRange(2, 1, lastRow - 1, lastCol).getValues() : [];

  var orders = [];
  var seen = {};
  for (var i = 0; i < values.length; i++) {
    var row = values[i];
    if (cell_(row, rawCols, RAW.formType) !== WEEKEND) continue;
    if (String(cell_(row, rawCols, RAW.bakehelg)).trim() !== ACTIVE_WEEKEND) continue;

    var id = toId_(cell_(row, rawCols, RAW.date));
    if (!id || seen[id]) continue; // skip blank ids and any duplicate rows
    seen[id] = true;

    orders.push({
      id: id,
      dato: cell_(row, rawCols, RAW.date),
      fornavn: cell_(row, rawCols, RAW.fornavn),
      mobil: cell_(row, rawCols, RAW.mobil),
      epost: cell_(row, rawCols, RAW.epost),
      adresse: cell_(row, rawCols, RAW.adresse),
      bestilling: cell_(row, rawCols, RAW.bestilling),
      leveringstid: buildLeveringstid_(row, rawCols),
      kommentar: cell_(row, rawCols, RAW.kommentar),
      delivery: isDelivery_(row, rawCols),
      bread: num_(cell_(row, rawCols, RAW.klassisk)) + num_(cell_(row, rawCols, RAW.bokka)),
      buns: num_(cell_(row, rawCols, RAW.kanel)) + num_(cell_(row, rawCols, RAW.kanelVanilje))
    });
  }

  var ordersSheet = ensureOrdersSheet_(book);
  upsertOrders_(ordersSheet, orders);
  refreshKids_(book, ordersSheet, orders);
}

/* ===================== BESTILLINGER ===================== */

function ensureOrdersSheet_(book) {
  var sheet = book.getSheetByName(ORDERS_SHEET_NAME) || book.insertSheet(ORDERS_SHEET_NAME);
  sheet.getRange(1, 1, 1, ORDER_HEADERS.length)
    .setValues([ORDER_HEADERS])
    .setFontWeight('bold')
    .setBackground('#efe1c4');
  sheet.setFrozenRows(1);
  return sheet;
}

function upsertOrders_(sheet, orders) {
  var col = indexByName_(ORDER_HEADERS); // 1-based
  var lastRow = sheet.getLastRow();

  // Map existing rows by their hidden Kilde-ID.
  var existing = {};
  if (lastRow > 1) {
    var ids = sheet.getRange(2, col['Kilde-ID'], lastRow - 1, 1).getValues();
    for (var i = 0; i < ids.length; i++) {
      var id = String(ids[i][0]).trim();
      if (id) existing[id] = i + 2;
    }
  }

  var infoOrder = ['Dato', 'Fornavn', 'Mobil', 'E-post', 'Adresse', 'Bestilling', 'Leveringstid', 'Kommentar'];

  orders.forEach(function (o) {
    var info = [o.dato, o.fornavn, o.mobil, o.epost, o.adresse, o.bestilling, o.leveringstid, o.kommentar];

    if (existing[o.id]) {
      // Update ONLY customer/order info + Kart. Never touch Stopp/Status/Pakket/Levert.
      var r = existing[o.id];
      for (var j = 0; j < infoOrder.length; j++) {
        sheet.getRange(r, col[infoOrder[j]]).setValue(info[j]);
      }
      setMapLink_(sheet, r, col['Kart'], o.adresse);
    } else {
      // Append a brand-new order with default workflow values.
      var rn = sheet.getLastRow() + 1;
      for (var k = 0; k < infoOrder.length; k++) {
        sheet.getRange(rn, col[infoOrder[k]]).setValue(info[k]);
      }
      sheet.getRange(rn, col['Stopp']).setValue('');
      sheet.getRange(rn, col['Status']).setValue(DEFAULT_STATUS);
      sheet.getRange(rn, col['Pakket']).setValue(false);
      sheet.getRange(rn, col['Levert']).setValue(false);
      setMapLink_(sheet, rn, col['Kart'], o.adresse);
      sheet.getRange(rn, col['Kilde-ID']).setValue(o.id);
    }
  });

  applyOrderValidations_(sheet, col);
  formatOrdersSheet_(sheet, col);
  scopeToActiveWeekend_(sheet, col, orders);
  sheet.hideColumns(col['Kilde-ID']);
}

function applyOrderValidations_(sheet, col) {
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return;
  var n = lastRow - 1;

  var statusRule = SpreadsheetApp.newDataValidation()
    .requireValueInList(STATUS_OPTIONS, true).setAllowInvalid(false).build();
  sheet.getRange(2, col['Status'], n, 1).setDataValidation(statusRule);

  var checkRule = SpreadsheetApp.newDataValidation().requireCheckbox().build();
  sheet.getRange(2, col['Pakket'], n, 1).setDataValidation(checkRule);
  sheet.getRange(2, col['Levert'], n, 1).setDataValidation(checkRule);
}

function formatOrdersSheet_(sheet, col) {
  sheet.setColumnWidth(col['Adresse'], 200);
  sheet.setColumnWidth(col['Bestilling'], 240);
  sheet.setColumnWidth(col['Leveringstid'], 150);
  sheet.setColumnWidth(col['Kommentar'], 200);
  var lastRow = sheet.getLastRow();
  if (lastRow > 1) {
    var n = lastRow - 1;
    ['Adresse', 'Bestilling', 'Leveringstid', 'Kommentar'].forEach(function (name) {
      sheet.getRange(2, col[name], n, 1).setWrap(true).setVerticalAlignment('middle');
    });
  }
}

// Show only the active weekend's rows (matched by Kilde-ID); hide — never delete —
// earlier-weekend rows so the dashboard represents ACTIVE_WEEKEND while history stays.
function scopeToActiveWeekend_(sheet, col, orders) {
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return;
  var active = {};
  orders.forEach(function (o) { active[o.id] = true; });
  var ids = sheet.getRange(2, col['Kilde-ID'], lastRow - 1, 1).getValues();
  for (var i = 0; i < ids.length; i++) {
    var r = i + 2;
    if (active[String(ids[i][0]).trim()]) sheet.showRows(r);
    else sheet.hideRows(r);
  }
}

/* ===================== BARN - BOKKA-RUTE ===================== */

function refreshKids_(book, ordersSheet, orders) {
  var kids = book.getSheetByName(KIDS_SHEET_NAME) || book.insertSheet(KIDS_SHEET_NAME);
  var totalCols = KIDS_HEADERS.length;

  // Look up quantities + delivery flag per order id.
  var byId = {};
  orders.forEach(function (o) { byId[o.id] = o; });

  // Read Bestillinger for the live Stopp + Levert of each delivery order.
  var oCol = indexByName_(ORDER_HEADERS);
  var rows = [];
  var lastRow = ordersSheet.getLastRow();
  if (lastRow > 1) {
    var data = ordersSheet.getRange(2, 1, lastRow - 1, ORDER_HEADERS.length).getValues();
    data.forEach(function (r) {
      var id = String(r[oCol['Kilde-ID'] - 1]).trim();
      var o = byId[id];
      if (!o || !o.delivery) return; // only current weekend orders that chose delivery
      rows.push({
        id: id,
        stopp: r[oCol['Stopp'] - 1],
        adresse: r[oCol['Adresse'] - 1],
        bestilling: r[oCol['Bestilling'] - 1],
        leveringstid: r[oCol['Leveringstid'] - 1],
        levert: r[oCol['Levert'] - 1] === true,
        bread: o.bread,
        buns: o.buns
      });
    });
  }

  // Sort by Stopp when a number is assigned; unassigned stops fall to the bottom.
  rows.sort(function (a, b) {
    var sa = parseFloat(a.stopp), sb = parseFloat(b.stopp);
    var aHas = !isNaN(sa), bHas = !isNaN(sb);
    if (aHas && bHas) return sa - sb;
    if (aHas) return -1;
    if (bHas) return 1;
    return 0;
  });

  var stops = rows.length;
  var bread = 0, buns = 0;
  rows.forEach(function (r) { bread += r.bread; buns += r.buns; });

  // Reset the derived sheet safely (Levert lives in Bestillinger, so nothing is lost).
  if (kids.getMaxColumns() < totalCols) {
    kids.insertColumnsAfter(kids.getMaxColumns(), totalCols - kids.getMaxColumns());
  }
  kids.getRange(1, 1, kids.getMaxRows(), kids.getMaxColumns()).breakApart();
  kids.clearContents();
  kids.clearFormats();
  kids.clearDataValidations();

  // Cute-but-simple summary header.
  kids.getRange(1, 1, 1, totalCols).merge();
  kids.getRange(1, 1).setValue('🌾 Dagens Bokka-rute')
    .setFontSize(18).setFontWeight('bold').setFontColor('#2c4a32').setHorizontalAlignment('center');
  kids.getRange(2, 1, 1, totalCols).merge();
  kids.getRange(2, 1).setValue(stops + ' stopp · ' + bread + ' brød · ' + buns + ' boller')
    .setFontSize(13).setFontColor('#4a6549').setHorizontalAlignment('center');

  // Table header + freeze.
  kids.getRange(KIDS_HEADER_ROW, 1, 1, totalCols)
    .setValues([KIDS_HEADERS]).setFontWeight('bold').setBackground('#e6d4b0');
  kids.setFrozenRows(KIDS_HEADER_ROW);

  var startRow = KIDS_HEADER_ROW + 1;
  if (rows.length) {
    var out = rows.map(function (r) {
      return [r.stopp, r.adresse, r.bestilling, r.leveringstid, '', r.levert, r.id];
    });
    kids.getRange(startRow, 1, out.length, totalCols).setValues(out);

    for (var i = 0; i < rows.length; i++) {
      setMapLink_(kids, startRow + i, 5, rows[i].adresse); // Kart column
    }
    var checkRule = SpreadsheetApp.newDataValidation().requireCheckbox().build();
    kids.getRange(startRow, 6, rows.length, 1).setDataValidation(checkRule); // Levert column
  }

  formatKidsSheet_(kids, rows.length, totalCols);
  kids.hideColumns(KIDS_HEADERS.indexOf('Kilde-ID') + 1);
}

function formatKidsSheet_(kids, dataCount, totalCols) {
  kids.setColumnWidth(1, 64);   // Stopp
  kids.setColumnWidth(2, 230);  // Adresse
  kids.setColumnWidth(3, 240);  // Bestilling
  kids.setColumnWidth(4, 170);  // Leveringstid
  kids.setColumnWidth(5, 110);  // Kart
  kids.setColumnWidth(6, 96);   // Levert
  kids.setRowHeight(KIDS_HEADER_ROW, 34);

  if (dataCount > 0) {
    var startRow = KIDS_HEADER_ROW + 1;
    kids.setRowHeights(startRow, dataCount, 52); // larger, easy to tap
    kids.getRange(startRow, 1, dataCount, totalCols).setVerticalAlignment('middle').setFontSize(12);
    kids.getRange(startRow, 2, dataCount, 3).setWrap(true); // Adresse / Bestilling / Leveringstid
    kids.getRange(startRow, 1, dataCount, 1).setHorizontalAlignment('center').setFontWeight('bold');
    kids.getRange(startRow, 6, dataCount, 1).setHorizontalAlignment('center'); // Levert checkbox
  }
}

/* ===================== LEVERT SYNC (children → adults) ===================== */

function onEdit(e) {
  try {
    if (!e || !e.range) return;
    var sheet = e.range.getSheet();
    if (sheet.getName() !== KIDS_SHEET_NAME) return;

    var levertCol = KIDS_HEADERS.indexOf('Levert') + 1;
    var idCol = KIDS_HEADERS.indexOf('Kilde-ID') + 1;
    if (e.range.getColumn() !== levertCol) return;

    var row = e.range.getRow();
    if (row <= KIDS_HEADER_ROW) return;

    var id = String(sheet.getRange(row, idCol).getValue()).trim();
    if (!id) return;
    var checked = e.range.getValue() === true;

    var orders = (e.source || SpreadsheetApp.getActive()).getSheetByName(ORDERS_SHEET_NAME);
    if (!orders) return;
    var col = indexByName_(ORDER_HEADERS);
    var lastRow = orders.getLastRow();
    if (lastRow < 2) return;

    var ids = orders.getRange(2, col['Kilde-ID'], lastRow - 1, 1).getValues();
    for (var i = 0; i < ids.length; i++) {
      if (String(ids[i][0]).trim() === id) {
        var r = i + 2;
        orders.getRange(r, col['Levert']).setValue(checked);
        var statusCell = orders.getRange(r, col['Status']);
        if (checked) {
          statusCell.setValue('Levert');
        } else if (String(statusCell.getValue()).trim() === 'Levert') {
          statusCell.setValue('Ute på tur');
        }
        return;
      }
    }
  } catch (err) {
    // onEdit must never throw disruptively; fail quietly.
  }
}

/* ===================== OPTIONAL AUTOMATION ===================== */

// Run this ONCE to sync automatically every 10 minutes. Safe to re-run
// (it removes any previous syncBokkaOrders trigger first).
function createSyncTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'syncBokkaOrders') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('syncBokkaOrders').timeBased().everyMinutes(10).create();
}

function removeSyncTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'syncBokkaOrders') ScriptApp.deleteTrigger(t);
  });
}

/* ===================== HELPERS ===================== */

// Find the raw Formspree sheet: by name if configured, otherwise the first tab
// (other than ours) whose header row contains both _date and form_type.
function findRawSheet_(book) {
  if (RAW_SHEET_NAME) {
    var named = book.getSheetByName(RAW_SHEET_NAME);
    if (named) return named;
  }
  var sheets = book.getSheets();
  for (var i = 0; i < sheets.length; i++) {
    var name = sheets[i].getName();
    if (name === ORDERS_SHEET_NAME || name === KIDS_SHEET_NAME) continue;
    var cols = headerCols_(sheets[i], 1);
    if ((RAW.date in cols) && (RAW.formType in cols)) return sheets[i];
  }
  throw new Error('Fant ikke Formspree-arket (mangler _date/form_type). ' +
    'Sett RAW_SHEET_NAME øverst i skriptet til navnet på Formspree-fanen.');
}

// header name -> 0-based column index, read from a given sheet + header row.
function headerCols_(sheet, headerRow) {
  var lastCol = sheet.getLastColumn();
  if (lastCol < 1) return {};
  var headers = sheet.getRange(headerRow, 1, 1, lastCol).getValues()[0];
  var map = {};
  for (var i = 0; i < headers.length; i++) {
    var key = String(headers[i]).trim();
    if (key && !(key in map)) map[key] = i;
  }
  return map;
}

// header name -> 1-based column index, from a fixed header array (our own tabs).
function indexByName_(headersArr) {
  var m = {};
  for (var i = 0; i < headersArr.length; i++) m[headersArr[i]] = i + 1;
  return m;
}

// Value of a raw cell by header name ('' if that header is absent).
function cell_(row, cols, headerName) {
  return (headerName in cols) ? row[cols[headerName]] : '';
}

function buildLeveringstid_(row, cols) {
  var parts = [];
  if (RAW.lordag in cols) {
    var l = String(row[cols[RAW.lordag]] || '').trim();
    if (l) parts.push('Lørdag · ' + l);
  }
  if (RAW.sondag in cols) {
    var s = String(row[cols[RAW.sondag]] || '').trim();
    if (s) parts.push('Søndag · ' + s);
  }
  return parts.join('\n');
}

function isDelivery_(row, cols) {
  if (!(RAW.levering in cols)) return false;
  return String(row[cols[RAW.levering]] || '').trim() !== '';
}

function setMapLink_(sheet, row, col, address) {
  var a = String(address || '').trim();
  var cell = sheet.getRange(row, col);
  if (!a) { cell.setValue(''); return; }
  var url = MAPS_BASE + encodeURIComponent(a + ADDRESS_SUFFIX);
  // RichText link (not a HYPERLINK formula) so it works in any sheet locale.
  var rich = SpreadsheetApp.newRichTextValue().setText('Åpne i kart').setLinkUrl(url).build();
  cell.setRichTextValue(rich);
}

function toId_(v) {
  if (v instanceof Date) return v.toISOString();
  return String(v == null ? '' : v).trim();
}

function num_(v) {
  var n = parseInt(v, 10);
  return isNaN(n) ? 0 : n;
}
