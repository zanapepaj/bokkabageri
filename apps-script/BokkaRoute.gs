/**
 * Bokka-rute — walking route engine + private web app (Google Apps Script)
 * =============================================================================
 * A SEPARATE file that EXTENDS BokkaDelivery.gs (never modifies it). It reuses the
 * globals defined there: RAW, findRawSheet_, headerCols_, cell_, ORDER_HEADERS,
 * indexByName_, isDelivery_, toId_, num_, ORDERS_SHEET_NAME, ACTIVE_WEEKEND, WEEKEND.
 *
 * Server-side only: Maps.newGeocoder() + Maps.newDirectionFinder() (WALKING). No API
 * key, no UrlFetch. Child-safe: functions return ONLY stopToken/stop/adresse/
 * bestilling/leveringstid/levert/lat/lng (+ route geometry & aggregate totals).
 * Kilde-ID and the base location never reach the browser.
 *
 * The mobile app lives in RouteApp.html / RouteStyle.html / RouteClient.html and is
 * served by doGet below. Deploy: Extensions → Apps Script → Deploy → New deployment →
 * Web app → Execute as ME, Access = ONLY MYSELF. Open the /exec URL on the family phone.
 * Test the engine alone with bokkaRouteTest().
 */

/* ===================== WEB APP (private; deploy access = MYSELF) ===================== */

function doGet() {
  return HtmlService.createTemplateFromFile('RouteApp').evaluate()
    .setTitle('Bokka-rute')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no');
}

// Lets RouteApp.html pull in the style/script partials.
function include(name) {
  return HtmlService.createHtmlOutputFromFile(name).getContent();
}

/* ===================== CONFIG (private) ===================== */

// PRIVATE base coordinates. Kept here only — never returned to the client.
var BOKKA_BASE = { lat: 58.95927700958366, lng: 5.7170834085190885 };
var RETURN_TO_BASE = true;

var ROUTE_CACHE_SHEET = 'Rute-cache';
var ROUTE_CACHE_HEADERS = ['Type', 'Kilde-ID', 'Adresse-hash', 'Lat', 'Lng',
  'Batch', 'Dag', 'Rekkefolge', 'Polyline', 'Distanse', 'Varighet', 'Generert'];

// Delivery-window chronological order (v1). "Når det passer Bokka" stays last.
var WINDOW_RANK = { 'Før kl. 10': 1, 'Kl. 10–12': 2, 'Kl. 12–14': 3, 'Når det passer Bokka': 4 };
var FLEX_WINDOW = 'Når det passer Bokka';

/* ===================== PUBLIC API (called by the app) ===================== */

/**
 * Explicit parent action: geocode, optimize, write Stopp back, cache, return payload.
 * Refuses to silently reorder once anything is delivered unless confirmReset === true.
 */
function generateRouteForDay(day, confirmReset) {
  day = normalizeDay_(day);
  var stops = activeDeliveryOrders_(day);
  if (!stops.length) {
    return { ok: false, day: day, stops: [], message: 'Ingen leveringsstopp for ' + day + '.' };
  }

  // Guard: don't reorder a route that is already partly delivered without confirmation.
  var levertMap = leveringStatusByKilde_();
  var deliveredCount = stops.reduce(function (a, s) { return a + (levertMap[s.kildeId] ? 1 : 0); }, 0);
  if (deliveredCount > 0 && confirmReset !== true) {
    return {
      ok: false, needsConfirmReset: true, day: day, deliveredCount: deliveredCount,
      message: deliveredCount + ' stopp er allerede levert. Bekreft omstart for å regenerere ruten.'
    };
  }

  var unresolved = geocodeStops_(stops);
  var routable = stops.filter(function (s) { return s.lat != null && s.lng != null; });
  if (!routable.length) {
    return { ok: false, day: day, stops: [], unresolved: unresolved, message: 'Fant ingen koordinater å rute.' };
  }

  var plan = planRoute_(routable);
  var ordered = plan.ordered;
  var overview = plan.overview;

  ordered.forEach(function (s, idx) {
    s.stop = idx + 1;
    s.token = 'S' + (idx + 1) + '-' + Utilities.getUuid().slice(0, 8);
  });

  writeStopNumbers_(ordered); // explicit generate only

  var routeObj = {
    day: day, batch: ACTIVE_WEEKEND, generatedAt: new Date().toISOString(), approx: plan.mode === 'straight',
    distanceMeters: overview.distanceMeters, durationSec: overview.durationSec, polyline: overview.polyline,
    stops: ordered.map(function (s) {
      return {
        token: s.token, kildeId: s.kildeId, stop: s.stop, adresse: s.adresse,
        bestilling: s.bestilling, leveringstid: s.leveringstid, window: s.window,
        lat: s.lat, lng: s.lng, bread: s.bread, buns: s.buns
      };
    })
  };

  routePut_(day, routeObj);      // durable
  cachePutStatic_(day, routeObj); // optional fast layer

  return buildClientPayload_(routeObj, levertMap, unresolved);
}

/** Read-only: return the cached route for the app. Never writes Stopp, never regenerates. */
function getRouteForDay(day) {
  day = normalizeDay_(day);
  var routeObj = cacheGetStatic_(day) || routeGet_(day);
  if (!routeObj) {
    return { ok: false, generated: false, day: day, message: 'Ingen rute er generert ennå for ' + day + '.' };
  }
  return buildClientPayload_(routeObj, leveringStatusByKilde_(), []);
}

/** Mark a stop delivered/undelivered from an opaque token (Kilde-ID stays server-side). */
function markDelivered(stopToken, delivered) {
  if (!stopToken) return { ok: false, message: 'Mangler stopToken.' };
  var kildeId = resolveToken_(stopToken);
  if (!kildeId) return { ok: false, message: 'Ukjent stopToken.' };

  var sheet = SpreadsheetApp.getActive().getSheetByName(ORDERS_SHEET_NAME);
  if (!sheet) return { ok: false, message: 'Fant ikke Bestillinger.' };
  var col = indexByName_(ORDER_HEADERS);
  var last = sheet.getLastRow();
  if (last < 2) return { ok: false, message: 'Ingen bestillinger.' };

  var ids = sheet.getRange(2, col['Kilde-ID'], last - 1, 1).getValues();
  for (var i = 0; i < ids.length; i++) {
    if (String(ids[i][0]).trim() === kildeId) {
      var r = i + 2;
      var checked = delivered === true;
      sheet.getRange(r, col['Levert']).setValue(checked);
      var statusCell = sheet.getRange(r, col['Status']);
      if (checked) statusCell.setValue('Levert');
      else if (String(statusCell.getValue()).trim() === 'Levert') statusCell.setValue('Ute på tur');
      break;
    }
  }
  return progressForDay_(tokenDay_(stopToken));
}

/* ===================== ROUTE BUILDING ===================== */

// Active-weekend delivery orders for the chosen day, with earliest window (v1).
function activeDeliveryOrders_(day) {
  var raw = findRawSheet_(SpreadsheetApp.getActive());
  var rawCols = headerCols_(raw, 1);
  var lastRow = raw.getLastRow(), lastCol = raw.getLastColumn();
  var values = lastRow > 1 ? raw.getRange(2, 1, lastRow - 1, lastCol).getValues() : [];
  var dayHeader = (day === 'Lørdag') ? RAW.lordag : RAW.sondag;

  var seen = {}, list = [];
  for (var i = 0; i < values.length; i++) {
    var row = values[i];
    if (cell_(row, rawCols, RAW.formType) !== WEEKEND) continue;
    if (String(cell_(row, rawCols, RAW.bakehelg)).trim() !== ACTIVE_WEEKEND) continue;
    if (!isDelivery_(row, rawCols)) continue;

    var dayVal = String(cell_(row, rawCols, dayHeader) || '').trim();
    if (!dayVal) continue; // this order didn't pick delivery on this day

    var id = toId_(cell_(row, rawCols, RAW.date));
    if (!id || seen[id]) continue;
    seen[id] = true;

    var win = earliestWindow_(dayVal);
    list.push({
      kildeId: id,
      adresse: String(cell_(row, rawCols, RAW.adresse) || '').trim(),
      bestilling: String(cell_(row, rawCols, RAW.bestilling) || '').trim(),
      leveringstid: day + ' · ' + win,
      window: win,
      rank: WINDOW_RANK[win] || 4,
      bread: num_(cell_(row, rawCols, RAW.klassisk)) + num_(cell_(row, rawCols, RAW.bokka)),
      buns: num_(cell_(row, rawCols, RAW.kanel)) + num_(cell_(row, rawCols, RAW.kanelVanilje))
    });
  }
  return list;
}

// Earliest recognised window among a possibly comma-joined day value.
function earliestWindow_(dayValue) {
  var parts = String(dayValue || '').split(',');
  var best = null;
  for (var i = 0; i < parts.length; i++) {
    var p = parts[i].trim();
    if (WINDOW_RANK[p] != null && (best === null || WINDOW_RANK[p] < WINDOW_RANK[best])) best = p;
  }
  return best || FLEX_WINDOW;
}

// Group by window (chronological); optimise geography INSIDE each group only.
// Group 1 starts at base; each later group starts at the previous group's last stop.
function orderAllStops_(stops) {
  var groups = {};
  stops.forEach(function (s) { (groups[s.rank] = groups[s.rank] || []).push(s); });
  var ranks = Object.keys(groups).map(Number).sort(function (a, b) { return a - b; });

  var origin = { lat: BOKKA_BASE.lat, lng: BOKKA_BASE.lng };
  var finalOrder = [];
  ranks.forEach(function (rank) {
    var ordered = optimizeGroup_(origin, groups[rank]);
    finalOrder = finalOrder.concat(ordered);
    if (ordered.length) {
      var lastStop = ordered[ordered.length - 1];
      origin = { lat: lastStop.lat, lng: lastStop.lng };
    }
  });
  return finalOrder;
}

// For a small group: try each stop as the fixed destination, optimise the rest as
// walking waypoints, and keep the candidate with the lowest total walking duration.
function optimizeGroup_(origin, group) {
  if (group.length <= 1) return group.slice();
  var best = null;
  for (var d = 0; d < group.length; d++) {
    if (d > 0) Utilities.sleep(200); // pace Directions calls to dodge rate-limit errors
    var destination = group[d];
    var waypoints = group.filter(function (_, idx) { return idx !== d; });
    var r = walkDirections_(origin, waypoints, destination, true);
    if (best === null || r.durationSec < best.durationSec) {
      var ordered = r.order.map(function (i) { return waypoints[i]; });
      ordered.push(destination);
      best = { durationSec: r.durationSec, ordered: ordered };
    }
  }
  return best.ordered;
}

// One final WALKING request over the complete fixed sequence, ending at base.
function finalRoute_(orderedStops) {
  var origin = { lat: BOKKA_BASE.lat, lng: BOKKA_BASE.lng };
  var destination, waypoints;
  if (RETURN_TO_BASE) {
    destination = { lat: BOKKA_BASE.lat, lng: BOKKA_BASE.lng };
    waypoints = orderedStops.slice();
  } else {
    destination = orderedStops[orderedStops.length - 1];
    waypoints = orderedStops.slice(0, orderedStops.length - 1);
  }
  var r = walkDirections_(origin, waypoints, destination, false); // fixed order
  return { polyline: r.polyline, distanceMeters: r.distanceMeters, durationSec: r.durationSec };
}

// Plan the visiting order + overview. Uses the walking optimiser; if Maps Directions is
// unavailable (quota/outage) it falls back to greedy order + straight lines so a route is
// still produced, and marks it approximate.
function planRoute_(routable) {
  try {
    var ordered = orderAllStops_(routable);
    return { ordered: ordered, overview: finalRoute_(ordered), mode: 'walking' };
  } catch (e) {
    Logger.log('Falt tilbake til rett linje (Maps Directions utilgjengelig?): ' + (e && e.message));
    var greedy = greedyOrder_({ lat: BOKKA_BASE.lat, lng: BOKKA_BASE.lng }, routable);
    return { ordered: greedy, overview: straightOverview_(greedy), mode: 'straight' };
  }
}

// Thin wrapper over Maps DirectionFinder (WALKING). Returns waypoint order + totals + polyline.
function walkDirections_(origin, waypoints, destination, optimize) {
  var f = Maps.newDirectionFinder()
    .setMode(Maps.DirectionFinder.Mode.WALKING)
    .setOptimizeWaypoints(optimize === true)
    .setOrigin(origin.lat, origin.lng)
    .setDestination(destination.lat, destination.lng);
  (waypoints || []).forEach(function (w) { f.addWaypoint(w.lat, w.lng); });

  var res = mapsRetry_(function () { return f.getDirections(); });
  if (!res || res.status !== 'OK' || !res.routes || !res.routes.length) {
    throw new Error('Gårute feilet (' + (res && res.status) + ').');
  }
  var route = res.routes[0];
  var dur = 0, dist = 0;
  (route.legs || []).forEach(function (leg) { dur += leg.duration.value; dist += leg.distance.value; });
  return {
    order: route.waypoint_order || [],
    durationSec: dur, distanceMeters: dist,
    polyline: route.overview_polyline ? route.overview_polyline.points : ''
  };
}

/* ===================== GEOCODING (cache-first) ===================== */

function geocodeStops_(stops) {
  var sheet = ensureRouteCacheSheet_();
  var geo = loadGeoCache_(sheet);
  var geocoder = Maps.newGeocoder().setRegion('no');
  var toAppend = [], unresolved = [];

  stops.forEach(function (s) {
    var full = s.adresse + ADDRESS_SUFFIX;
    var h = hash_(full.toLowerCase());
    s.addrHash = h;
    if (geo[h]) { s.lat = geo[h].lat; s.lng = geo[h].lng; return; }

    var loc = geocodeAddress_(geocoder, full);
    if (loc) {
      s.lat = loc.lat; s.lng = loc.lng;
      geo[h] = { lat: loc.lat, lng: loc.lng };
      toAppend.push(['geo', s.kildeId, h, loc.lat, loc.lng, '', '', '', '', '', '', new Date().toISOString()]);
    } else {
      unresolved.push(s.adresse);
    }
  });

  if (toAppend.length) {
    sheet.getRange(sheet.getLastRow() + 1, 1, toAppend.length, ROUTE_CACHE_HEADERS.length).setValues(toAppend);
  }
  return unresolved;
}

function loadGeoCache_(sheet) {
  var map = {}, last = sheet.getLastRow();
  if (last < 2) return map;
  var col = routeCacheCols_();
  var vals = sheet.getRange(2, 1, last - 1, ROUTE_CACHE_HEADERS.length).getValues();
  for (var i = 0; i < vals.length; i++) {
    if (vals[i][col['Type'] - 1] !== 'geo') continue;
    var h = String(vals[i][col['Adresse-hash'] - 1]);
    var lat = parseFloat(vals[i][col['Lat'] - 1]), lng = parseFloat(vals[i][col['Lng'] - 1]);
    if (h && !isNaN(lat) && !isNaN(lng)) map[h] = { lat: lat, lng: lng };
  }
  return map;
}

// Geocode one address with retries for transient/quota errors; null if not found.
function geocodeAddress_(geocoder, full) {
  for (var i = 0; i < 2; i++) {
    var res;
    try { res = geocoder.geocode(full); }
    catch (e) { Utilities.sleep(500 * (i + 1)); continue; }
    if (res.status === 'OK' && res.results && res.results.length) return res.results[0].geometry.location;
    if (res.status === 'OVER_QUERY_LIMIT') { Utilities.sleep(800 * (i + 1)); continue; }
    return null; // ZERO_RESULTS / INVALID_REQUEST etc.
  }
  return null;
}

// Retry a Maps call that occasionally throws "An unknown error has occurred, please try again later."
// Kept short on purpose: failed Directions/Geocoding calls also count against the daily quota.
function mapsRetry_(fn) {
  var lastErr;
  for (var i = 0; i < 2; i++) {
    try { return fn(); }
    catch (e) { lastErr = e; if (i < 1) Utilities.sleep(600); }
  }
  throw lastErr;
}

/* ===================== RUTE-CACHE (durable) ===================== */

function ensureRouteCacheSheet_() {
  var book = SpreadsheetApp.getActive();
  var sheet = book.getSheetByName(ROUTE_CACHE_SHEET);
  if (!sheet) {
    sheet = book.insertSheet(ROUTE_CACHE_SHEET);
    sheet.getRange(1, 1, 1, ROUTE_CACHE_HEADERS.length).setValues([ROUTE_CACHE_HEADERS]).setFontWeight('bold');
    sheet.setFrozenRows(1);
    sheet.hideSheet(); // internal cache, keep it out of sight
  }
  return sheet;
}

function routeCacheCols_() { return indexByName_(ROUTE_CACHE_HEADERS); }

function routePut_(day, obj) {
  var sheet = ensureRouteCacheSheet_();
  var col = routeCacheCols_();
  var rowValues = ['rute', '', '', '', '', ACTIVE_WEEKEND, day,
    JSON.stringify(obj.stops), obj.polyline, obj.distanceMeters, obj.durationSec, obj.generatedAt];

  var target = null, last = sheet.getLastRow();
  if (last >= 2) {
    var vals = sheet.getRange(2, 1, last - 1, ROUTE_CACHE_HEADERS.length).getValues();
    for (var i = 0; i < vals.length; i++) {
      if (vals[i][col['Type'] - 1] === 'rute' &&
          String(vals[i][col['Batch'] - 1]) === ACTIVE_WEEKEND &&
          String(vals[i][col['Dag'] - 1]) === day) { target = i + 2; break; }
    }
  }
  var writeRow = target || (sheet.getLastRow() + 1);
  sheet.getRange(writeRow, 1, 1, rowValues.length).setValues([rowValues]);
}

function routeGet_(day) {
  var sheet = ensureRouteCacheSheet_();
  var last = sheet.getLastRow();
  if (last < 2) return null;
  var col = routeCacheCols_();
  var vals = sheet.getRange(2, 1, last - 1, ROUTE_CACHE_HEADERS.length).getValues();
  for (var i = 0; i < vals.length; i++) {
    var row = vals[i];
    if (row[col['Type'] - 1] === 'rute' &&
        String(row[col['Batch'] - 1]) === ACTIVE_WEEKEND &&
        String(row[col['Dag'] - 1]) === day) {
      var stops = [];
      try { stops = JSON.parse(row[col['Rekkefolge'] - 1] || '[]'); } catch (e) { stops = []; }
      return {
        day: day, batch: ACTIVE_WEEKEND, generatedAt: row[col['Generert'] - 1],
        distanceMeters: Number(row[col['Distanse'] - 1]) || 0,
        durationSec: Number(row[col['Varighet'] - 1]) || 0,
        polyline: String(row[col['Polyline'] - 1] || ''),
        stops: stops
      };
    }
  }
  return null;
}

function allRouteRows_() {
  var sheet = ensureRouteCacheSheet_();
  var out = [], last = sheet.getLastRow();
  if (last < 2) return out;
  var col = routeCacheCols_();
  var vals = sheet.getRange(2, 1, last - 1, ROUTE_CACHE_HEADERS.length).getValues();
  for (var i = 0; i < vals.length; i++) {
    var row = vals[i];
    if (row[col['Type'] - 1] === 'rute' && String(row[col['Batch'] - 1]) === ACTIVE_WEEKEND) {
      var stops = [];
      try { stops = JSON.parse(row[col['Rekkefolge'] - 1] || '[]'); } catch (e) { stops = []; }
      out.push({ day: String(row[col['Dag'] - 1]), obj: { stops: stops } });
    }
  }
  return out;
}

// Optional fast layer in front of Rute-cache (durable source stays the sheet).
function cachePutStatic_(day, routeObj) {
  try { CacheService.getScriptCache().put(staticKey_(day), JSON.stringify(routeObj), 1500); } catch (e) {}
}
function cacheGetStatic_(day) {
  try { var s = CacheService.getScriptCache().get(staticKey_(day)); return s ? JSON.parse(s) : null; }
  catch (e) { return null; }
}
function staticKey_(day) { return 'bokka_route_' + ACTIVE_WEEKEND + '_' + day; }

/* ===================== CHILD-SAFE PAYLOAD & PROGRESS ===================== */

// Projects the internal route to ONLY the allowed client fields. No Kilde-ID, no base.
function buildClientPayload_(routeObj, levertMap, unresolved) {
  var totals = { bread: 0, buns: 0 };
  var stops = routeObj.stops.map(function (s) {
    totals.bread += (s.bread || 0);
    totals.buns += (s.buns || 0);
    return {
      stopToken: s.token, stop: s.stop, adresse: s.adresse, bestilling: s.bestilling,
      leveringstid: s.leveringstid, lat: s.lat, lng: s.lng,
      levert: !!(levertMap && levertMap[s.kildeId])
    };
  });
  var done = stops.filter(function (s) { return s.levert; }).length;
  return {
    ok: true, day: routeObj.day, generatedAt: routeObj.generatedAt, approx: routeObj.approx || false,
    distanceMeters: routeObj.distanceMeters, durationSec: routeObj.durationSec,
    polyline: routeObj.polyline, stops: stops,
    totals: totals, progress: { done: done, total: stops.length, remaining: stops.length - done },
    unresolved: unresolved || []
  };
}

function progressForDay_(day) {
  var routeObj = routeGet_(day);
  if (!routeObj) return { ok: true, day: day, done: 0, total: 0, remaining: 0, totals: { bread: 0, buns: 0 } };
  var levertMap = leveringStatusByKilde_();
  var total = routeObj.stops.length, done = 0, bread = 0, buns = 0;
  routeObj.stops.forEach(function (s) {
    if (levertMap[s.kildeId]) done++;
    bread += (s.bread || 0); buns += (s.buns || 0);
  });
  return { ok: true, day: day, done: done, total: total, remaining: total - done, totals: { bread: bread, buns: buns } };
}

function leveringStatusByKilde_() {
  var map = {};
  var sheet = SpreadsheetApp.getActive().getSheetByName(ORDERS_SHEET_NAME);
  if (!sheet) return map;
  var last = sheet.getLastRow();
  if (last < 2) return map;
  var col = indexByName_(ORDER_HEADERS);
  var data = sheet.getRange(2, 1, last - 1, ORDER_HEADERS.length).getValues();
  data.forEach(function (r) {
    var id = String(r[col['Kilde-ID'] - 1]).trim();
    if (id) map[id] = r[col['Levert'] - 1] === true;
  });
  return map;
}

// Write optimized Stopp numbers back into Bestillinger (explicit generate only).
function writeStopNumbers_(orderedStops) {
  var sheet = SpreadsheetApp.getActive().getSheetByName(ORDERS_SHEET_NAME);
  if (!sheet) return;
  var last = sheet.getLastRow();
  if (last < 2) return;
  var col = indexByName_(ORDER_HEADERS);
  var ids = sheet.getRange(2, col['Kilde-ID'], last - 1, 1).getValues();
  var rowById = {};
  for (var i = 0; i < ids.length; i++) { var id = String(ids[i][0]).trim(); if (id) rowById[id] = i + 2; }
  orderedStops.forEach(function (s) {
    var r = rowById[s.kildeId];
    if (r) sheet.getRange(r, col['Stopp']).setValue(s.stop);
  });
}

/* ===================== TOKEN RESOLUTION (server-side only) ===================== */

function resolveToken_(token) {
  var routes = allRouteRows_();
  for (var i = 0; i < routes.length; i++) {
    var st = routes[i].obj.stops;
    for (var j = 0; j < st.length; j++) if (st[j].token === token) return st[j].kildeId;
  }
  return null;
}
function tokenDay_(token) {
  var routes = allRouteRows_();
  for (var i = 0; i < routes.length; i++) {
    var st = routes[i].obj.stops;
    for (var j = 0; j < st.length; j++) if (st[j].token === token) return routes[i].day;
  }
  return null;
}

/* ===================== SMALL HELPERS ===================== */

function normalizeDay_(day) {
  var d = String(day || '').toLowerCase();
  if (d.indexOf('lør') === 0 || d.indexOf('lor') === 0) return 'Lørdag';
  return 'Søndag';
}

function hash_(s) {
  var raw = Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, String(s), Utilities.Charset.UTF_8);
  return raw.map(function (b) { return ('0' + (b & 0xff).toString(16)).slice(-2); }).join('');
}

/* ===================== TEST: build a route from interesse.html rows =====================
 * Interest submissions (form_type=interest) only carry a loose "nabolag" (street/area),
 * no time window and no quantities. This builds a throwaway route from them purely to see
 * more pins on the map. It caches under the chosen day (so the app shows it) but does NOT
 * touch Bestillinger, so "Levert" won't persist for these stops. Re-run generateRouteForDay
 * afterwards to restore the real weekend route.
 * Run: bokkaTestInteresseRoute()  (defaults to Søndag; pass 'Lørdag' to switch)
 */

function bokkaTestInteresseRoute(day) {
  var res = generateTestRouteFromInteresse(day || 'Søndag');
  Logger.log('ok=' + res.ok + (res.message ? ('  (' + res.message + ')') : ''));
  if (res.ok) Logger.log('Åpne appen på ' + res.day + ' for å se ' + res.stops.length + ' interesse-stopp på kartet.');
  return res;
}

function generateTestRouteFromInteresse(day) {
  day = normalizeDay_(day);
  var stops = collectInteresseStops_(day);
  if (!stops.length) {
    return { ok: false, day: day, message: 'Fant ingen interesse-rader med nabolag/adresse i regnearket.' };
  }

  var unresolved = geocodeStops_(stops);
  var routable = stops.filter(function (s) { return s.lat != null && s.lng != null; });
  if (!routable.length) {
    return { ok: false, day: day, unresolved: unresolved, message: 'Klarte ikke å geokode noen adresser.' };
  }

  var ordered = greedyOrder_({ lat: BOKKA_BASE.lat, lng: BOKKA_BASE.lng }, routable);
  var overview;
  try {
    overview = finalRoute_(ordered);              // real walking path when few enough points
  } catch (e) {
    overview = straightOverview_(ordered);        // fallback for many points (avoids waypoint cap)
    Logger.log('TEST: for mange punkter for gårute — bruker rett linje.');
  }

  ordered.forEach(function (s, idx) {
    s.stop = idx + 1;
    s.token = 'T' + (idx + 1) + '-' + Utilities.getUuid().slice(0, 8);
  });

  var routeObj = {
    day: day, batch: ACTIVE_WEEKEND, generatedAt: new Date().toISOString(),
    distanceMeters: overview.distanceMeters, durationSec: overview.durationSec, polyline: overview.polyline,
    stops: ordered.map(function (s) {
      return {
        token: s.token, kildeId: s.kildeId, stop: s.stop, adresse: s.adresse,
        bestilling: s.bestilling, leveringstid: s.leveringstid, window: s.window,
        lat: s.lat, lng: s.lng, bread: 0, buns: 0
      };
    })
  };
  routePut_(day, routeObj);
  cachePutStatic_(day, routeObj);

  Logger.log('TEST interesse-rute (' + day + '): ' + ordered.length + ' stopp · ' +
    overview.distanceMeters + ' m · ~' + Math.round(overview.durationSec / 60) + ' min');
  ordered.forEach(function (s) {
    Logger.log('  #' + s.stop + '  ' + s.adresse + '  (' + s.lat.toFixed(5) + ',' + s.lng.toFixed(5) + ')');
  });
  if (unresolved.length) Logger.log('IKKE geokodet: ' + unresolved.join(' | '));

  return buildClientPayload_(routeObj, {}, unresolved);
}

// Scan every tab for interest rows (form_type=interest) that carry a nabolag/address.
function collectInteresseStops_(day) {
  var book = SpreadsheetApp.getActive();
  var sheets = book.getSheets();
  var seen = {}, stops = [];
  for (var si = 0; si < sheets.length; si++) {
    var sh = sheets[si];
    var name = sh.getName();
    if (name === ORDERS_SHEET_NAME || name === KIDS_SHEET_NAME || name === ROUTE_CACHE_SHEET) continue;
    var cols = headerCols_(sh, 1);
    if (!('form_type' in cols) || !('_date' in cols) || !('nabolag' in cols)) continue;

    var lastRow = sh.getLastRow(), lastCol = sh.getLastColumn();
    if (lastRow < 2) continue;
    var values = sh.getRange(2, 1, lastRow - 1, lastCol).getValues();
    for (var i = 0; i < values.length; i++) {
      var row = values[i];
      if (String(cell_(row, cols, 'form_type')).trim() !== 'interest') continue;
      var adr = String(cell_(row, cols, 'nabolag') || '').trim();
      if (!adr) continue;
      var dager = String(cell_(row, cols, 'dager') || '');
      if (dager && dager.indexOf(day) === -1) continue; // respect a chosen day if the row set one
      var id = toId_(cell_(row, cols, '_date'));
      if (!id || seen[id]) continue;
      seen[id] = true;
      var prod = String(cell_(row, cols, 'produkter') || '').trim();
      stops.push({
        kildeId: id, adresse: adr, bestilling: prod || 'Interesse',
        leveringstid: day + ' · ' + FLEX_WINDOW, window: FLEX_WINDOW, rank: 4, bread: 0, buns: 0
      });
    }
  }
  return stops;
}

// Nearest-neighbour ordering from an origin (pure JS, no Directions quota / waypoint cap).
function greedyOrder_(origin, stops) {
  var remaining = stops.slice(), out = [], cur = origin;
  while (remaining.length) {
    var bi = 0, bd = Infinity;
    for (var i = 0; i < remaining.length; i++) {
      var d = haversine_(cur, remaining[i]);
      if (d < bd) { bd = d; bi = i; }
    }
    cur = remaining[bi];
    out.push(cur);
    remaining.splice(bi, 1);
  }
  return out;
}

// Straight-line overview when there are too many points for a Directions request.
function straightOverview_(ordered) {
  var coords = [[BOKKA_BASE.lat, BOKKA_BASE.lng]];
  var dist = 0, prev = { lat: BOKKA_BASE.lat, lng: BOKKA_BASE.lng };
  ordered.forEach(function (s) { coords.push([s.lat, s.lng]); dist += haversine_(prev, s); prev = s; });
  if (RETURN_TO_BASE) { coords.push([BOKKA_BASE.lat, BOKKA_BASE.lng]); dist += haversine_(prev, BOKKA_BASE); }
  return { polyline: encodePolyline_(coords), distanceMeters: Math.round(dist), durationSec: Math.round(dist / 1.35) };
}

function haversine_(a, b) {
  var R = 6371000, toR = Math.PI / 180;
  var dLat = (b.lat - a.lat) * toR, dLng = (b.lng - a.lng) * toR;
  var la1 = a.lat * toR, la2 = b.lat * toR;
  var h = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  return 2 * R * Math.asin(Math.sqrt(h));
}

function encodePolyline_(coords) {
  var out = '', lastLat = 0, lastLng = 0;
  function enc(v) {
    v = Math.round(v * 1e5);
    var val = v < 0 ? ~(v << 1) : (v << 1), s = '';
    while (val >= 0x20) { s += String.fromCharCode((0x20 | (val & 0x1f)) + 63); val >>= 5; }
    return s + String.fromCharCode(val + 63);
  }
  for (var i = 0; i < coords.length; i++) {
    out += enc(coords[i][0] - lastLat) + enc(coords[i][1] - lastLng);
    lastLat = coords[i][0]; lastLng = coords[i][1];
  }
  return out;
}

/* ===================== PHASE-1 TEST (run this, read the log) ===================== */

function bokkaRouteTest() {
  var res = generateRouteForDay('Søndag', true); // force, so testing ignores the delivered guard
  Logger.log('ok=' + res.ok + (res.message ? ('  (' + res.message + ')') : ''));
  if (!res.ok) return res;

  Logger.log('Dag: ' + res.day + '   Stopp: ' + res.stops.length);
  Logger.log('Distanse: ' + res.distanceMeters + ' m   Varighet: ' + res.durationSec +
    ' s (~' + Math.round(res.durationSec / 60) + ' min)');
  Logger.log('Totalt: ' + res.totals.bread + ' brød · ' + res.totals.buns + ' boller');
  res.stops.forEach(function (s) {
    Logger.log('  #' + s.stop + '  ' + s.adresse + '  [' + s.leveringstid + ']  (' +
      s.lat.toFixed(5) + ',' + s.lng.toFixed(5) + ')  token=' + s.stopToken + '  levert=' + s.levert);
  });
  Logger.log('Polyline (encoded, ' + (res.polyline || '').length + ' tegn): ' + (res.polyline || '').slice(0, 64) + '…');
  if (res.unresolved.length) Logger.log('IKKE geokodet: ' + res.unresolved.join(' | '));

  // Confirm the client payload never leaks Kilde-ID / base:
  Logger.log('Klient-felt per stopp: ' + Object.keys(res.stops[0]).join(', '));
  return res;
}
