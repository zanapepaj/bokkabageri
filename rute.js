(function () {
  'use strict';

  /* ======================================================================
     Bokka-rute — adventure delivery map (client), served from bokkabageri.no/rute.html.
     Server: the Bokka Apps Script project (BokkaRoute.gs → doPost). Every call carries the
     app code; customer contacts additionally need the parent PIN.
     Live GPS stays in this browser: never stored, never sent anywhere.
     ====================================================================== */

  var API_URL = 'https://script.google.com/macros/s/AKfycbwY5Z4-fyE2dP9xTBy9VIsn6e_9DRwXBPRKGn6jIkb8q7I6UQwtldSZMZehsJtCgsmw/exec';
  var PIN_KEY = 'bokka-rute-kode';
  var VIPPS = { number: '67713', name: 'Bokka Bageri' };
  var WALK_MPS = 1.0;       // kids + wagon ≈ 3.6 km/h
  var DETOUR = 1.3;         // streets are longer than the straight line
  var STOP_MIN = 2;         // minutes spent at each stop on the way

  var memPin = '';
  function appPin() { try { return localStorage.getItem(PIN_KEY) || memPin; } catch (e) { return memPin; } }
  function savePin(code) { memPin = code; try { localStorage.setItem(PIN_KEY, code); } catch (e) {} }
  function forgetPin() { memPin = ''; try { localStorage.removeItem(PIN_KEY); } catch (e) {} }

  // text/plain body keeps it a "simple" request, so the browser skips the CORS preflight
  // that Apps Script can't answer.
  function apiCall(fn, args) {
    return fetch(API_URL, { method: 'POST', body: JSON.stringify({ fn: fn, args: args || [], pin: appPin() }) })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (res) {
        if (res && res.auth === false) {
          lockApp(res.message);
          var err = new Error(res.message || 'Feil kode.');
          err.auth = true;
          throw err;
        }
        return res;
      });
  }

  // google.script.run look-alike: same function names and success/failure handlers as when the
  // app lived inside Apps Script, so the rest of this file didn't have to change.
  function runner() {
    var ok = function () {}, fail = function () {};
    var r = {
      withSuccessHandler: function (f) { ok = f; return r; },
      withFailureHandler: function (f) { fail = f; return r; }
    };
    ['getRouteForDay', 'generateRouteForDay', 'markDelivered', 'skipStop', 'moveStop', 'getParentContacts'].forEach(function (fn) {
      r[fn] = function () { apiCall(fn, Array.prototype.slice.call(arguments)).then(ok, fail); };
    });
    return r;
  }
  var google = { script: {} };
  Object.defineProperty(google.script, 'run', { get: runner });

  var REDUCE = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  function E(cp) { return String.fromCodePoint(cp); } // emoji from code points (paste-proof source)
  var STAR = E(0x2B50), SPARK = E(0x2728), WHEAT = E(0x1F33E), PARTY = E(0x1F389);

  // ---- state ----
  var STATE = { day: initialDay(), route: null, busy: false, following: false, lastDelivered: null, prevDone: 0, selected: null, contacts: null };

  // ---- Leaflet objects: created once, reused (no churn while walking) ----
  var map = null, glowLine = null, caseLine = null, pathLine = null, trailLine = null;
  var stopMarkers = {};              // token -> { marker: L.Marker, state: 'todo'|'next'|'done' }
  var wagon = null, wagonEl = null, accCircle = null;
  var programmaticMove = false;

  // ---- GPS (client-side only) ----
  var watchId = null;
  var gps = { shown: null, last: null, anchor: null, facing: 'east', moveTimer: null, anim: null, nearNotified: {} };

  // ---- turn guidance: phone heading (compass > GPS course > movement) + rotation continuity ----
  var nav = { heading: null, headingT: 0, src: null, compassOn: false, lastOrient: 0, rotShown: 0, dirShown: 0, legCache: {} };
  var wagonDirEl = null;

  // ---- element refs ----
  var el = {
    days: document.querySelectorAll('.day'),
    hud: document.getElementById('hud'),
    hudProgress: document.getElementById('hudProgress'),
    stars: document.getElementById('stars'),
    countText: document.getElementById('countText'),
    barFill: document.getElementById('barFill'),
    fab: document.getElementById('fab'),
    nav: document.getElementById('nav'),
    navArrow: document.getElementById('navArrow'),
    navDist: document.getElementById('navDist'),
    navHint: document.getElementById('navHint'),
    notice: document.getElementById('notice'),
    sheet: document.getElementById('sheet'),
    sheetToggle: document.getElementById('sheetToggle'),
    nextCard: document.getElementById('nextCard'),
    stopList: document.getElementById('stopList'),
    parentBtn: document.getElementById('parentBtn'),
    parentModal: document.getElementById('parentModal'),
    parentClose: document.getElementById('parentClose'),
    regen: document.getElementById('regenBtn'),
    parentMode: document.getElementById('parentModeBtn'),
    fullscreenBtn: document.getElementById('fullscreenBtn'),
    fullscreenHint: document.getElementById('fullscreenHint'),
    celebrate: document.getElementById('celebrate'),
    celebrateWagon: document.getElementById('celebrateWagon'),
    celebrateStars: document.getElementById('celebrateStars'),
    celebrateText: document.getElementById('celebrateText'),
    cBread: document.getElementById('cBread'),
    cBuns: document.getElementById('cBuns'),
    celebrateClose: document.getElementById('celebrateClose'),
    toast: document.getElementById('toast'),
    fx: document.getElementById('fx'),
    gate: document.getElementById('gate'),
    gateForm: document.getElementById('gateForm'),
    gateCode: document.getElementById('gateCode'),
    gateErr: document.getElementById('gateErr'),
    forgetBtn: document.getElementById('forgetBtn'),
    payModal: document.getElementById('payModal'),
    payAmount: document.getElementById('payAmount'),
    payOrder: document.getElementById('payOrder'),
    payQr: document.getElementById('payQr'),
    payDone: document.getElementById('payDone'),
    payTo: document.getElementById('payTo'),
    payStatus: document.getElementById('payStatus'),
    payRetry: document.getElementById('payRetry'),
    payNote: document.getElementById('payNote'),
    payStatic: document.getElementById('payStatic'),
    payClose: document.getElementById('payClose')
  };

  function initialDay() {
    return new Date().getDay() === 0 ? 'Søndag' : 'Lørdag';
  }

  /* ===================== wiring ===================== */
  el.days.forEach(function (btn) {
    btn.addEventListener('click', function () {
      if (STATE.busy) return;
      STATE.day = btn.getAttribute('data-day');
      syncDayTabs();
      loadRoute();
    });
  });

  // One delegated handler for the whole bottom sheet.
  el.sheet.addEventListener('click', function (e) {
    var btn = e.target.closest('[data-action]');
    if (!btn) return;
    var action = btn.getAttribute('data-action');
    var token = btn.getAttribute('data-token');
    if (action === 'deliver') setDelivered(token, true);
    else if (action === 'undo') setDelivered(token, false);
    else if (action === 'undo-last' && STATE.lastDelivered) setDelivered(STATE.lastDelivered, false);
    else if (action === 'celebrate') showCelebrate();
    else if (action === 'back-to-next') selectStop(null);
    else if (action === 'pay') openPay(token);
    else if (action === 'skip') setSkipped(token, true);
    else if (action === 'unskip') setSkipped(token, false);
    else if (action === 'up') reorderStop(token, -1);
    else if (action === 'down') reorderStop(token, 1);
    else if (action === 'onway') sendOnWay(token);
  });

  el.sheetToggle.addEventListener('click', function () {
    var open = !el.sheet.classList.contains('is-open');
    el.sheet.classList.toggle('is-open', open);
    el.stopList.hidden = !open;
    el.sheetToggle.setAttribute('aria-expanded', String(open));
    afterChromeChange();
  });

  el.fab.addEventListener('click', onFab);
  el.nav.addEventListener('click', onFab);
  el.parentBtn.addEventListener('click', function () { el.parentModal.hidden = false; });
  el.parentClose.addEventListener('click', function () { el.parentModal.hidden = true; });
  el.parentModal.addEventListener('click', function (e) { if (e.target === el.parentModal) el.parentModal.hidden = true; });
  el.regen.addEventListener('click', function () { el.parentModal.hidden = true; regenerate(); });
  el.parentMode.addEventListener('click', toggleParentMode);
  el.celebrateClose.addEventListener('click', function () { el.celebrate.hidden = true; });
  el.payClose.addEventListener('click', closePay);
  el.payModal.addEventListener('click', function (e) { if (e.target === el.payModal) closePay(); });
  el.payRetry.addEventListener('click', function () { var s = findStop(PAY.token); if (s) startVippsPay(s); });
  el.payStatic.addEventListener('click', function () { cancelPending(); showStaticPay(''); });
  el.forgetBtn.addEventListener('click', function () {
    if (!confirm('Glemme koden på denne telefonen? Den må tastes inn igjen neste gang.')) return;
    el.parentModal.hidden = true;
    setContacts(null);
    lockApp('');
  });
  el.gateForm.addEventListener('submit', function (e) {
    e.preventDefault();
    var code = el.gateCode.value.replace(/\D/g, '');
    if (!code) return;
    savePin(code);
    el.gateErr.textContent = 'Sjekker koden ' + E(0x2026);
    apiCall('ping', []).then(function () {
      el.gate.hidden = true;
      el.gateErr.textContent = '';
      loadRoute();
    }, function (err) {
      if (!err.auth) el.gateErr.textContent = 'Fikk ikke kontakt – sjekk nettet og prøv igjen.';
    });
  });

  // Fullscreen: real API where supported (Android Chrome); iPhone Safari relies on Home-Screen mode.
  var isStandalone = !!(navigator.standalone || (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches));
  if (isStandalone) { el.fullscreenHint.hidden = true; }
  else if (document.fullscreenEnabled || document.webkitFullscreenEnabled) {
    el.fullscreenBtn.hidden = false;
    el.fullscreenBtn.addEventListener('click', toggleFullscreen);
  }

  window.addEventListener('resize', onViewportChange);
  window.addEventListener('orientationchange', onViewportChange);
  if (window.ResizeObserver) {
    var ro = new ResizeObserver(function () { measureChrome(); });
    ro.observe(el.hud); ro.observe(el.sheet);
  }

  ensureMap();
  measureChrome();
  syncDayTabs();
  if (appPin()) loadRoute();
  else lockApp('');

  // Show the code screen (first visit, wrong/changed code, or "Glem koden").
  function lockApp(msg) {
    forgetPin();
    STATE.busy = false;
    el.gate.hidden = false;
    el.gateErr.textContent = msg || '';
    el.gateCode.value = '';
    setTimeout(function () { el.gateCode.focus(); }, 60);
  }

  function syncDayTabs() {
    el.days.forEach(function (b) {
      b.classList.toggle('is-active', b.getAttribute('data-day') === STATE.day);
    });
  }

  /* ===================== server calls ===================== */
  function loadRoute() {
    STATE.busy = true;
    resetRouteView();
    showNotice('Laster ruten for ' + STATE.day + ' ' + E(0x2026));
    google.script.run.withSuccessHandler(onRoute).withFailureHandler(onFail).getRouteForDay(STATE.day);
  }

  function onRoute(res) {
    STATE.busy = false;
    if (!res || !res.ok) {
      STATE.route = null;
      showNotice(res && res.message ? res.message : 'Ingen rute ennå. Be en voksen generere ruten (tannhjulet oppe til høyre).');
      return;
    }
    STATE.route = res;
    STATE.prevDone = countDone();
    hideNotice();
    renderAll(true);
    if (STATE.contacts) fetchContacts(STATE.contacts.pin); // day switch: refresh contacts for the new route
  }

  function onFail(err) {
    STATE.busy = false;
    if (err && err.auth) { hideNotice(); return; } // the code screen is already showing
    showNotice('Noe gikk galt. Prøv igjen.');
    toast('Feil: ' + (err && err.message ? err.message : 'ukjent'));
  }

  function setDelivered(token, delivered) {
    var s = findStop(token);
    if (!s || s.levert === delivered) return;
    s.levert = delivered;                                  // optimistic
    if (delivered) STATE.lastDelivered = token;
    else if (STATE.lastDelivered === token) STATE.lastDelivered = lastDoneToken();
    if (delivered && STATE.selected === token) STATE.selected = null; // back to "Neste stopp" after delivering a picked stop

    renderAll(false);
    if (delivered) {
      sparkleAt(s);
      pulseCard();
      toast('Stopp ' + s.stop + ' levert! ' + STAR);
    }

    google.script.run
      .withSuccessHandler(function () {
        if (delivered && allDone()) setTimeout(showCelebrate, 650);
      })
      .withFailureHandler(function () {
        s.levert = !delivered;                             // revert
        STATE.lastDelivered = lastDoneToken();
        renderAll(false);
        toast('Kunne ikke lagre – prøv igjen');
      })
      .markDelivered(token, delivered);
  }

  function regenerate() {
    if (STATE.busy) return;
    STATE.busy = true;
    showNotice('Genererer ruten for ' + STATE.day + ' ' + E(0x2026));
    google.script.run
      .withSuccessHandler(function (res) {
        if (res && res.needsConfirmReset) {
          STATE.busy = false;
          hideNotice();
          if (confirm(res.message + '\n\nVil du stokke om ruten likevel?')) {
            STATE.busy = true;
            showNotice('Stokker om ruten ' + E(0x2026));
            google.script.run.withSuccessHandler(afterRegen).withFailureHandler(onFail)
              .generateRouteForDay(STATE.day, true);
          }
          return;
        }
        afterRegen(res);
      })
      .withFailureHandler(onFail)
      .generateRouteForDay(STATE.day, false);
  }

  function afterRegen(res) {
    STATE.busy = false;
    if (!res || !res.ok) { showNotice(res && res.message ? res.message : 'Kunne ikke generere ruten.'); return; }
    resetRouteView();
    STATE.route = res;
    STATE.prevDone = countDone();
    hideNotice();
    renderAll(true);
    toast('Ny rute klar ' + WHEAT);
    if (STATE.contacts) fetchContacts(STATE.contacts.pin); // tokens changed → re-map contacts
  }

  /* ===================== parent mode (PIN; contacts live in memory only) ===================== */
  function toggleParentMode() {
    if (STATE.contacts) { setContacts(null); toast('Foreldre-modus av'); return; }
    var pin = prompt('PIN for foreldre-modus:');
    if (pin == null || pin === '') return;
    fetchContacts(pin);
  }

  function fetchContacts(pin) {
    google.script.run
      .withSuccessHandler(function (res) {
        if (!res || !res.ok) { setContacts(null); toast(res && res.message ? res.message : 'Kunne ikke hente kontakter'); return; }
        setContacts({ pin: pin, map: res.contacts || {} });
        if (!el.parentModal.hidden) el.parentModal.hidden = true;
        toast('Foreldre-modus på ' + E(0x1F512));
      })
      .withFailureHandler(function () { toast('Kunne ikke hente kontakter'); })
      .getParentContacts(STATE.day, pin);
  }

  function setContacts(c) {
    STATE.contacts = c;
    document.body.classList.toggle('is-parent', !!c);
    el.parentMode.innerHTML = c ? '&#x1F513; Foreldre-modus: på' : '&#x1F512; Foreldre-modus: av';
    if (STATE.route) renderNext();
  }

  function contactHtml(s) {
    var c = STATE.contacts && STATE.contacts.map[s.stopToken];
    if (!c || s.levert) return '';
    var navn = c.navn || '';
    var tel = telHref(c.mobil);
    var hi = 'Hei' + (navn ? ' ' + navn : '') + '! ';
    var soldOut = hi + 'Dessverre ble vi utsolgt for brød i dag, så vi klarer ikke levere hele bestillingen din. Beklager så mye! Hilsen Bokka Bageri ' + WHEAT;
    return '<div class="contact">' +
      '<div class="contact__who">&#x1F464; ' + esc(navn || 'Kunde') + (c.mobil ? ' &middot; ' + esc(c.mobil) : '') + '</div>' +
      (tel ? '<div class="contact__acts">' +
        '<a class="contact__btn" href="tel:' + esc(tel) + '">&#x1F4DE; Ring</a>' +
        '<button class="contact__btn" data-action="onway" data-token="' + esc(s.stopToken) + '">&#x1F6B6; På vei</button>' +
        '<a class="contact__btn contact__btn--warn" href="' + smsHref(tel, soldOut) + '">&#x1F35E; Utsolgt</a>' +
        '</div>' : '<div class="contact__none">Mangler mobilnummer</div>') +
      '</div>';
  }

  // Opens the SMS app with a ready "on our way" text incl. a fresh ETA; the parent taps Send.
  function sendOnWay(token) {
    var s = findStop(token);
    var c = s && STATE.contacts && STATE.contacts.map[token];
    var tel = c && telHref(c.mobil);
    if (!tel) { toast('Mangler mobilnummer'); return; }
    var eta = etaMinutes(s);
    var body = 'Hei' + (c.navn ? ' ' + c.navn : '') + '! Bokka-vogna er på vei til deg med bestillingen ' + WHEAT +
      (eta ? ' Vi er der om ca. ' + eta + ' min.' : ' Vi er der snart.') +
      (s.betale != null ? ' Å betale: ' + s.betale + ' kr med Vipps til #' + VIPPS.number + ' (' + VIPPS.name + ').' : '') +
      ' Hilsen ' + VIPPS.name;
    openExternal('sms:' + tel + '?&body=' + encodeURIComponent(body));
  }

  // Follow a link the way a tap would (sms:/tel: work on both iOS and Android this way).
  function openExternal(url) {
    var a = document.createElement('a');
    a.href = url;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  // Rough walking ETA in whole 5-minute steps: from where we are (GPS) — or from the first open
  // stop when GPS is off — via every open stop before this one, at kids' pace plus time per stop.
  // null when we can't say more than "snart".
  function etaMinutes(target) {
    var st = STATE.route ? STATE.route.stops : [];
    var ti = st.indexOf(target);
    if (ti < 0) return null;
    var path = [];
    for (var i = 0; i <= ti; i++) if (st[i] === target || (!st[i].levert && !st[i].skipped)) path.push(st[i]);
    var from = gps.shown;
    if (!from) { if (path.length < 2) return null; from = path.shift(); }
    var meters = 0, prev = from;
    path.forEach(function (p) { meters += distM(prev, p) * DETOUR; prev = p; });
    var minutes = meters / WALK_MPS / 60 + (path.length - 1) * STOP_MIN;
    return Math.max(5, Math.ceil(minutes / 5) * 5);
  }

  /* ===================== Ikke hjemme / walking order (saved on the server) ===================== */
  function setSkipped(token, skipped) {
    var s = findStop(token);
    if (!s || STATE.busy) return;
    if (skipped && !confirm('Ingen hjemme i ' + s.adresse + '?\n\nStoppet flyttes sist, så prøver dere igjen til slutt.')) return;
    STATE.busy = true;
    if (STATE.selected === token) STATE.selected = null;
    toast(skipped ? 'Flytter stoppet sist ' + E(0x2026) : 'Oppdaterer ' + E(0x2026));
    google.script.run
      .withSuccessHandler(function (res) { applyServerRoute(res, skipped ? 'Flyttet sist – prøv igjen til slutt ' + E(0x1F6AA) : 'Klar for nytt forsøk'); })
      .withFailureHandler(function (err) { STATE.busy = false; if (!err || !err.auth) toast('Kunne ikke lagre – prøv igjen'); })
      .skipStop(token, skipped);
  }

  function reorderStop(token, delta) {
    if (STATE.busy) return;
    STATE.busy = true;
    toast('Lager ny rute ' + E(0x2026));
    google.script.run
      .withSuccessHandler(function (res) { applyServerRoute(res, 'Ny rekkefølge lagret'); })
      .withFailureHandler(function (err) { STATE.busy = false; if (!err || !err.auth) toast('Kunne ikke flytte – prøv igjen'); })
      .moveStop(token, delta);
  }

  // A fresh route from the server after a reorder/skip: stop numbers and legs may all have moved,
  // so markers and the decoded-leg cache are rebuilt; the open list and selection are kept.
  function applyServerRoute(res, msg) {
    STATE.busy = false;
    if (!res || !res.ok) { toast(res && res.message ? res.message : 'Kunne ikke lagre'); return; }
    Object.keys(stopMarkers).forEach(function (t) { map.removeLayer(stopMarkers[t].marker); });
    stopMarkers = {};
    nav.legCache = {};
    STATE.route = res;
    STATE.prevDone = countDone();
    if (STATE.selected && !findStop(STATE.selected)) STATE.selected = null;
    renderAll(false);
    if (msg) toast(msg);
  }

  /* ===================== Betal (Vipps) ===================== */
  // With Vipps keys on the server: a one-time QR for exactly this order (amount + order lines in
  // the customer's app), polled until paid and captured. Without keys / on any error: the
  // printed #67713 QR, where the customer types the amount.
  var STATIC_QR = 'assets/images/vipps/vipps-qr-67713.png';
  var PAY = { token: null, reference: null, timer: null, started: 0 };

  function openPay(token) {
    var s = findStop(token);
    if (!s) return;
    cancelPending();
    PAY.token = token;
    el.payAmount.textContent = s.betale != null ? s.betale + ' kr' : 'Se bestillingen';
    el.payOrder.innerHTML = esc(s.bestilling) +
      (s.levering ? '<br><span class="pay__fee">Levering: ' + esc(s.levering) + '</span>' : '');
    el.payDone.hidden = true;
    el.payRetry.hidden = true;
    el.payQr.classList.remove('is-faded', 'is-loading');
    el.payModal.hidden = false;
    if (s.betalt) showPaid();
    else if (STATE.route && STATE.route.vipps && s.betale > 0) startVippsPay(s);
    else showStaticPay('');
  }

  function showStaticPay(msg) {
    el.payQr.classList.remove('is-faded', 'is-loading');
    el.payQr.src = STATIC_QR;
    el.payTo.innerHTML = 'Skann med Vipps &middot; <b>' + esc(VIPPS.name) + ' #' + VIPPS.number + '</b>';
    el.payNote.textContent = 'Kunden taster inn beløpet selv. Vent til de viser «Betalt» i Vipps før dere går videre.';
    el.payNote.hidden = false;
    el.payStatus.textContent = msg || '';
    el.payRetry.hidden = true;
    el.payStatic.hidden = true;
  }

  function startVippsPay(s) {
    cancelPending();
    el.payQr.classList.remove('is-faded');
    el.payQr.classList.add('is-loading');
    el.payDone.hidden = true;
    el.payRetry.hidden = true;
    el.payStatic.hidden = false;
    el.payTo.textContent = 'Kunden skanner med Vipps-appen';
    el.payNote.textContent = 'Beløpet og bestillingen står ferdig i Vipps – kunden trykker bare «Betal».';
    el.payStatus.textContent = 'Lager Vipps-kode ' + E(0x2026);
    var token = s.stopToken;
    apiCall('vippsCreate', [token]).then(function (res) {
      if (PAY.token !== token || el.payModal.hidden) {      // closed meanwhile: don't leave it payable
        if (res && res.reference) apiCall('vippsCancel', [res.reference]).catch(function () {});
        return;
      }
      if (res && res.alreadyPaid) { markPaid(token); return; }
      if (!res || !res.ok || !res.qrUrl) { showStaticPay((res && res.message) || 'Fikk ikke laget Vipps-kode – bruk vanlig QR.'); return; }
      PAY.reference = res.reference;
      PAY.started = Date.now();
      el.payQr.src = res.qrUrl;
      el.payQr.classList.remove('is-loading');
      el.payStatus.textContent = (res.env === 'test' ? 'TEST · ' : '') + 'Venter på betaling ' + E(0x2026);
      PAY.timer = setTimeout(pollPay, 3000);
    }, function (err) {
      if (err && err.auth) return;
      if (PAY.token === token) showStaticPay('Fikk ikke kontakt med Vipps – bruk vanlig QR.');
    });
  }

  function pollPay() {
    var ref = PAY.reference, token = PAY.token;
    if (!ref) return;
    apiCall('vippsStatus', [ref]).then(function (res) {
      if (PAY.reference !== ref) return;
      var st = res && res.state;
      if (st === 'PAID') { markPaid(token); return; }
      if (st === 'ABORTED' || st === 'EXPIRED') {
        PAY.reference = null;
        el.payQr.classList.add('is-faded');
        el.payStatus.textContent = st === 'ABORTED' ? 'Betalingen ble avbrutt i Vipps.' : 'Koden gikk ut før noen betalte.';
        el.payRetry.hidden = false;
        return;
      }
      if (st === 'FAILED') { PAY.reference = null; el.payStatus.textContent = res.message || 'Noe gikk galt med trekket.'; return; }
      if (!res || !res.ok) { el.payStatus.textContent = (res && res.message) || 'Sjekker igjen ' + E(0x2026); }
      if (Date.now() - PAY.started > 10 * 60 * 1000) { el.payStatus.textContent = 'Ingen betaling ennå.'; el.payRetry.hidden = false; return; }
      PAY.timer = setTimeout(pollPay, 2500);
    }, function () {
      if (PAY.reference === ref) PAY.timer = setTimeout(pollPay, 4000); // flaky mobile data: keep trying
    });
  }

  function markPaid(token) {
    clearTimeout(PAY.timer);
    PAY.reference = null;
    var s = findStop(token);
    if (s) s.betalt = true;
    if (!el.payModal.hidden && PAY.token === token) showPaid();
    toast('Betalt med Vipps! ' + E(0x1F4B0));
    if (STATE.route) { renderNext(); renderList(); }
  }

  function showPaid() {
    el.payQr.classList.add('is-faded');
    el.payDone.hidden = false;
    el.payStatus.textContent = 'Betalt med Vipps ' + E(0x2713);
    el.payNote.hidden = true;
    el.payRetry.hidden = true;
    el.payStatic.hidden = true;
  }

  // Close the window. An unpaid one-time QR is cancelled so it can't be paid later by mistake –
  // unless the customer approved at the very last second, which the server then still captures.
  function closePay() {
    el.payModal.hidden = true;
    el.payNote.hidden = false;
    cancelPending();
    PAY.token = null;
  }

  function cancelPending() {
    clearTimeout(PAY.timer);
    PAY.timer = null;
    if (!PAY.reference) return;
    var ref = PAY.reference, token = PAY.token;
    PAY.reference = null;
    apiCall('vippsCancel', [ref]).then(function (res) {
      if (res && res.state === 'PAID') markPaid(token);
    }, function () {});
  }

  // 8 Norwegian digits → +47…; keeps an existing +country prefix; '' if unusable.
  function telHref(raw) {
    var d = String(raw || '').replace(/[^\d+]/g, '');
    if (d.indexOf('00') === 0) d = '+' + d.slice(2);
    if (/^\d{8}$/.test(d)) d = '+47' + d;
    return /^\+\d{8,15}$/.test(d) ? d : '';
  }
  function smsHref(tel, body) { return 'sms:' + esc(tel) + '?&amp;body=' + encodeURIComponent(body); } // ?& works on iOS + Android

  /* ===================== render orchestration ===================== */
  function renderAll(fit) {
    el.sheet.hidden = false;
    el.hudProgress.hidden = false;
    el.fab.hidden = false;
    renderHud();
    renderNext();
    renderList();
    updateStopMarkers();
    updateRouteLines();
    updateTrail();
    measureChrome();
    if (fit) fitToRoute();
  }

  function resetRouteView() {
    Object.keys(stopMarkers).forEach(function (t) { map.removeLayer(stopMarkers[t].marker); });
    stopMarkers = {};
    STATE.lastDelivered = null;
    STATE.selected = null;
    gps.nearNotified = {};
    nav.legCache = {};
    if (pathLine) { glowLine.setLatLngs([]); caseLine.setLatLngs([]); pathLine.setLatLngs([]); trailLine.setLatLngs([]); }
    el.sheet.hidden = true; el.hudProgress.hidden = true;
    el.sheet.classList.remove('is-open'); el.stopList.hidden = true;
    updateNav();
  }

  /* ===================== HUD: stars + count + bar ===================== */
  function renderHud() {
    var st = STATE.route.stops, total = st.length, done = countDone(), left = total - done;
    var maxStars = Math.max(5, Math.floor((el.stars.clientWidth || 260) / 24));

    if (total <= maxStars) {
      var html = '';
      for (var i = 0; i < total; i++) html += '<span class="star' + (i < done ? ' is-on' : '') + '">&#x2605;</span>';
      el.stars.innerHTML = html;
      el.stars.hidden = false;
      if (done > STATE.prevDone) {
        var justLit = el.stars.children[done - 1];
        if (justLit) { justLit.classList.add('is-pop'); setTimeout(function () { justLit.classList.remove('is-pop'); }, 600); }
      }
    } else {
      el.stars.hidden = true; // too many stops for a phone width → compact count only
    }
    el.countText.innerHTML = '<strong>' + done + '</strong> av ' + total + ' levert' +
      (left > 0 ? ' &middot; ' + left + ' igjen' : ' &middot; alt levert! ' + PARTY);
    el.barFill.style.width = (total ? (done / total * 100) : 0) + '%';
    STATE.prevDone = done;
  }

  /* ===================== bottom sheet: next stop + list ===================== */
  function renderNext() {
    var st = STATE.route.stops;
    var idx = st.findIndex(function (s) { return !s.levert; });
    var undo = STATE.lastDelivered
      ? '<button class="undo-last" data-action="undo-last">Angre siste levering</button>' : '';

    // A stop tapped on the map takes over the card until delivered or dismissed.
    var picked = STATE.selected ? findStop(STATE.selected) : null;
    if (picked && (idx < 0 || picked.stopToken !== st[idx].stopToken)) {
      el.nextCard.innerHTML =
        '<div class="next__eyebrow"><span class="next__label next__label--picked">Stopp ' + picked.stop + '</span>' +
        '<span class="next__count">' + (picked.levert ? 'Levert &#x2713;' : 'av ' + st.length) + '</span></div>' +
        '<div class="next__addr">' + esc(picked.adresse) + '</div>' +
        '<div class="next__meta"><span class="tag tag--time">' + esc(picked.leveringstid) + '</span>' + extraTags(picked) + '</div>' +
        '<div class="next__order">' + esc(picked.bestilling) + '</div>' +
        noteHtml(picked) +
        contactHtml(picked) +
        (picked.levert
          ? '<div class="next__delivered">&#x2B50; Levert! <button class="undo-last" style="margin:0 0 0 6px" data-action="undo" data-token="' + esc(picked.stopToken) + '">angre</button></div>'
          : '<div class="next__actions">' +
            '<button class="btn-deliver" data-action="deliver" data-token="' + esc(picked.stopToken) + '">&#x2713; Levert!</button>' +
            '<a class="btn-map" href="' + mapsUrl(picked) + '" target="_blank" rel="noopener">&#x1F9ED; <span class="btn-map__txt">Naviger</span></a>' +
            '</div>' + moreActions(picked)) +
        (idx >= 0 ? '<button class="next__back" data-action="back-to-next">&larr; Tilbake til neste stopp</button>' : '');
      return;
    }

    if (idx < 0) {
      el.nextCard.innerHTML =
        '<div class="next__done"><h3>Alle stopp levert! ' + PARTY + '</h3>' +
        '<button class="btn btn--primary" data-action="celebrate">Se oppsummeringen</button></div>' + undo;
      return;
    }
    var s = st[idx];
    el.nextCard.innerHTML =
      '<div class="next__eyebrow"><span class="next__label">Neste stopp</span>' +
      '<span class="next__count">Stopp ' + s.stop + ' av ' + st.length + '</span></div>' +
      '<div class="next__addr">' + esc(s.adresse) + '</div>' +
      '<div class="next__meta"><span class="tag tag--time">' + esc(s.leveringstid) + '</span>' + extraTags(s) + '</div>' +
      '<div class="next__order">' + esc(s.bestilling) + '</div>' +
      noteHtml(s) +
      contactHtml(s) +
      '<div class="next__actions">' +
      '<button class="btn-deliver" data-action="deliver" data-token="' + esc(s.stopToken) + '">&#x2713; Levert!</button>' +
      '<a class="btn-map" href="' + mapsUrl(s) + '" target="_blank" rel="noopener">&#x1F9ED; <span class="btn-map__txt">Naviger</span></a>' +
      '</div>' + moreActions(s) + undo;
  }

  // Zone/fee, amount to pay and "nobody home" as small tags under the address.
  function extraTags(s) {
    return (s.skipped ? '<span class="tag tag--skip">&#x1F6AA; Ikke hjemme</span>' : '') +
      (s.betalt ? '<span class="tag tag--paid">&#x2705; Betalt</span>' : '') +
      (s.levering ? '<span class="tag">' + esc(s.levering) + '</span>' : '') +
      (s.betale != null ? '<span class="tag tag--pay">' + esc(s.betale) + ' kr</span>' : '');
  }

  function noteHtml(s) {
    return s.kommentar ? '<div class="next__note">&#x1F4AC; ' + esc(s.kommentar) + '</div>' : '';
  }

  function moreActions(s) {
    var t = esc(s.stopToken);
    return '<div class="next__more">' +
      (s.betalt
        ? '<button class="btn-more btn-more--paid" data-action="pay" data-token="' + t + '">&#x2705; Betalt</button>'
        : '<button class="btn-more btn-more--pay" data-action="pay" data-token="' + t + '">&#x1F4B3; Betal</button>') +
      (s.skipped
        ? '<button class="btn-more" data-action="unskip" data-token="' + t + '">&#x21A9;&#xFE0E; Prøv igjen</button>'
        : '<button class="btn-more" data-action="skip" data-token="' + t + '">&#x1F6AA; Ikke hjemme</button>') +
      '</div>';
  }

  function renderList() {
    var st = STATE.route.stops;
    var nextIdx = st.findIndex(function (s) { return !s.levert; });
    el.stopList.innerHTML = st.map(function (s, i) {
      var cls = 'row' + (s.levert ? ' is-done' : '') + (i === nextIdx ? ' is-next' : '') + (s.skipped ? ' is-skipped' : '');
      var num = s.levert ? '&#x2713;' : s.stop;
      var t = esc(s.stopToken);
      var act = s.levert
        ? '<button class="row__act" data-action="undo" data-token="' + t + '">angre</button>'
        : (i === nextIdx ? '' : '<button class="row__act" data-action="deliver" data-token="' + t + '">levert</button>');
      // Walking order can be changed for stops that are still open.
      var move = s.levert ? '' :
        '<div class="row__move">' +
        '<button data-action="up" data-token="' + t + '" aria-label="Flytt stopp ' + s.stop + ' tidligere"' + (i === 0 ? ' disabled' : '') + '>&#x25B2;</button>' +
        '<button data-action="down" data-token="' + t + '" aria-label="Flytt stopp ' + s.stop + ' senere"' + (i === st.length - 1 ? ' disabled' : '') + '>&#x25BC;</button>' +
        '</div>';
      return '<div class="' + cls + '"><div class="row__num">' + num + '</div>' +
        '<div class="row__body"><div class="row__addr">' + esc(s.adresse) + '</div>' +
        '<div class="row__sub">' + (s.skipped ? '&#x1F6AA; Ikke hjemme &middot; ' : '') + esc(s.leveringstid) + ' &middot; ' + esc(s.bestilling) + '</div></div>' +
        act + move + '</div>';
    }).join('');
  }

  function pulseCard() {
    if (REDUCE) return;
    el.nextCard.classList.remove('is-pop');
    void el.nextCard.offsetWidth; // restart animation
    el.nextCard.classList.add('is-pop');
  }

  /* ===================== map setup ===================== */
  function ensureMap() {
    if (map) return;
    map = L.map('map', { zoomControl: true, attributionControl: true, zoomSnap: .5 });
    map.zoomControl.setPosition('topleft');
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; OpenStreetMap' }).addTo(map);
    map.setView([58.96, 5.73], 13);

    // Route: soft warm glow → dark casing → light-gold walking path (dash "marches" via CSS).
    glowLine = L.polyline([], { color: '#e8c07d', weight: 16, opacity: .3, lineJoin: 'round', lineCap: 'round', className: 'route-glow', interactive: false }).addTo(map);
    caseLine = L.polyline([], { color: '#4a3527', weight: 8, opacity: .55, lineJoin: 'round', lineCap: 'round', interactive: false }).addTo(map);
    pathLine = L.polyline([], { color: '#f3d59a', weight: 4.5, opacity: 1, dashArray: '10 12', lineJoin: 'round', lineCap: 'round', className: 'route-path', interactive: false }).addTo(map);
    // Footprint trail from the wagon to the next stop.
    trailLine = L.polyline([], { color: '#e0968a', weight: 3.5, opacity: .95, dashArray: '2 10', lineCap: 'round', interactive: false }).addTo(map);

    // Any manual pan/zoom pauses follow mode (tracking continues).
    map.on('dragstart', function () { setFollowing(false); });
    map.on('zoomstart', function () { if (!programmaticMove) setFollowing(false); });
  }

  function fitToRoute() {
    var pts = remainingRoutePoints_().slice();
    STATE.route.stops.forEach(function (s) { pts.push([s.lat, s.lng]); });
    if (gps.shown) pts.push([gps.shown.lat, gps.shown.lng]);
    if (!pts.length) return;
    var c = chrome_();
    programmaticMove = true;
    map.once('moveend', function () { programmaticMove = false; });
    map.fitBounds(L.latLngBounds(pts), {
      paddingTopLeft: [24, c.hudBottom + 24], paddingBottomRight: [24, c.sheetH + 24], animate: !REDUCE, maxZoom: 17
    });
  }

  /* ===================== route lines ===================== */
  // Still-to-walk part of the route: legs from the first remaining stop through the last remaining
  // stop (return-to-base leg only if the final stop is still open). Legs INTO an already-delivered
  // stop are dropped too, so delivering out of order never leaves a path pointing at a done stop.
  // Falls back to the overview line for old caches without legs.
  function remainingRoutePoints_() {
    var r = STATE.route, st = r.stops;
    if (r.legs && r.legs.length) {
      var first = -1, last = -1;
      for (var k = 0; k < st.length; k++) if (!st[k].levert) { if (first < 0) first = k; last = k; }
      if (first < 0) return [];
      var upto = (last === st.length - 1) ? (r.legs.length - 1) : last;
      var pts = [];
      for (var i = first; i <= upto && i < r.legs.length; i++) {
        if (i < st.length && st[i].levert) continue;
        var d = legPts_(i);
        if (pts.length && d.length && samePt(pts[pts.length - 1], d[0])) d = d.slice(1);
        pts = pts.concat(d);
      }
      return pts;
    }
    return r.polyline ? decodePolyline(r.polyline) : [];
  }

  function legPts_(i) {
    if (!nav.legCache[i]) nav.legCache[i] = decodePolyline(STATE.route.legs[i]);
    return nav.legCache[i];
  }

  function updateRouteLines() {
    var pts = remainingRoutePoints_();
    glowLine.setLatLngs(pts); caseLine.setLatLngs(pts); pathLine.setLatLngs(pts);
  }

  function updateTrail() { updateNav(); }

  /* ===================== turn guidance ===================== */
  // The stop we are walking to: a tapped (undelivered) stop wins, else the first undelivered.
  function currentTarget() {
    if (!STATE.route) return null;
    var picked = STATE.selected ? findStop(STATE.selected) : null;
    if (picked && !picked.levert) return picked;
    return STATE.route.stops.filter(function (s) { return !s.levert; })[0] || null;
  }

  // Path from where we stand to the target: snapped onto the route leg when we are on it (≤60 m),
  // else a straight line. Returns { pts:[[lat,lng]…], dist (m along path), bearing (deg, to a point ~14 m ahead) }.
  function guidance(p, s) {
    var r = STATE.route, idx = r.stops.indexOf(s), pts = null;
    if (r.legs && idx >= 0 && idx < r.legs.length) {
      var leg = legPts_(idx);
      if (leg.length > 1) {
        var sn = snapToLeg(p, leg);
        if (sn && sn.d <= 60) pts = [[p.lat, p.lng], sn.pt].concat(leg.slice(sn.i + 1));
      }
    }
    if (!pts) pts = [[p.lat, p.lng], [s.lat, s.lng]];
    var dist = pathLen(pts);
    var aim = pointAlong(pts, Math.min(14, Math.max(2, dist * 0.6)));
    return { pts: pts, dist: dist, bearing: bearing(p, { lat: aim[0], lng: aim[1] }) };
  }

  function updateNav() {
    var target = currentTarget();
    if (!target || watchId === null || !gps.shown) {
      el.nav.hidden = true;
      document.body.classList.remove('is-nav');
      if (wagonDirEl) wagonDirEl.hidden = true;
      if (trailLine) trailLine.setLatLngs([]);
      return;
    }
    var g = guidance(gps.shown, target);
    trailLine.setLatLngs(g.pts);

    var here = g.dist <= 25;
    var known = headingKnown();
    var rel = known ? g.bearing - nav.heading : g.bearing; // no heading yet → north-up, same as the map
    nav.rotShown += ((rel - nav.rotShown) % 360 + 540) % 360 - 180; // shortest way round, never spins
    nav.dirShown += ((g.bearing - nav.dirShown) % 360 + 540) % 360 - 180;

    el.nav.hidden = false;
    document.body.classList.add('is-nav');
    el.navArrow.style.transform = 'rotate(' + nav.rotShown.toFixed(1) + 'deg)';
    el.nav.classList.toggle('is-blind', !known && !here);
    el.nav.classList.toggle('is-here', here);
    el.navDist.textContent = here ? 'Her!' : fmtDist(g.dist);
    el.navHint.textContent = here ? 'Dere er framme' : (known ? 'Denne veien' : 'Gå litt, så finner pila veien');

    if (wagonDirEl) {
      wagonDirEl.hidden = here;
      wagonDirEl.style.transform = 'rotate(' + nav.dirShown.toFixed(1) + 'deg)';
    }
  }

  function headingKnown() {
    if (nav.heading == null) return false;
    var age = performance.now() - nav.headingT;
    return age < (nav.src === 'compass' ? 4000 : 25000);
  }
  function compassFresh() { return nav.src === 'compass' && (performance.now() - nav.headingT) < 4000; }

  // Circular low-pass so the arrow does not jitter; a fresh compass reading overrides weaker sources.
  function setHeading(h, src) {
    if (!isFinite(h)) return;
    h = (h % 360 + 360) % 360;
    if (nav.heading == null || (src === 'compass' && nav.src !== 'compass')) nav.heading = h;
    else nav.heading = (nav.heading + (((h - nav.heading) % 360 + 540) % 360 - 180) * (src === 'compass' ? .35 : .6) + 360) % 360;
    nav.src = src; nav.headingT = performance.now();
    updateNav();
  }

  // Compass: iOS needs an explicit permission prompt from a tap; Android Chrome exposes absolute alpha.
  function startCompass() {
    if (nav.compassOn) return;
    var DOE = window.DeviceOrientationEvent;
    if (!DOE) return;
    function listen() {
      nav.compassOn = true;
      window.addEventListener('ondeviceorientationabsolute' in window ? 'deviceorientationabsolute' : 'deviceorientation', onOrient);
    }
    if (typeof DOE.requestPermission === 'function') {
      DOE.requestPermission().then(function (s) { if (s === 'granted') listen(); }).catch(function () {});
    } else {
      listen();
    }
  }

  function onOrient(e) {
    var now = performance.now();
    if (now - nav.lastOrient < 100) return; // ~10 Hz is plenty
    var h = null;
    if (typeof e.webkitCompassHeading === 'number' && isFinite(e.webkitCompassHeading)) h = e.webkitCompassHeading;
    else if (e.absolute && typeof e.alpha === 'number') h = 360 - e.alpha;
    if (h == null) return;
    var so = (screen.orientation && typeof screen.orientation.angle === 'number') ? screen.orientation.angle
      : (typeof window.orientation === 'number' ? window.orientation : 0);
    nav.lastOrient = now;
    setHeading(h + so, 'compass');
  }

  function fmtDist(m) {
    if (m < 1000) return Math.max(5, Math.round(m / 5) * 5) + ' m';
    return (m / 1000).toFixed(1).replace('.', ',') + ' km';
  }

  /* ===================== stop markers (reused; icon swapped only on state change) ===================== */
  function updateStopMarkers() {
    var st = STATE.route.stops;
    var nextIdx = st.findIndex(function (s) { return !s.levert; });
    st.forEach(function (s, i) {
      var state = s.levert ? 'done' : (i === nextIdx ? 'next' : 'todo');
      var rec = stopMarkers[s.stopToken];
      if (!rec) {
        rec = stopMarkers[s.stopToken] = { marker: L.marker([s.lat, s.lng], { icon: stopIcon(state, s.stop, false), title: s.adresse, keyboard: false, riseOnHover: false }), state: state };
        rec.marker.setZIndexOffset(state === 'next' ? 500 : 0).addTo(map);
        rec.marker.on('click', function () { selectStop(s.stopToken); }); // tap a pin → its order in the card
      } else if (rec.state !== state) {
        rec.marker.setIcon(stopIcon(state, s.stop, state === 'done'));
        rec.marker.setZIndexOffset(state === 'next' ? 500 : 0);
        rec.state = state;
      }
      var elm = rec.marker.getElement();
      if (elm) elm.classList.toggle('is-selected', STATE.selected === s.stopToken);
    });
  }

  function selectStop(token) {
    STATE.selected = (token && STATE.selected === token) ? null : token; // tap again to dismiss
    renderNext();
    updateStopMarkers();
    updateNav();
    measureChrome();
    if (STATE.selected) {
      el.sheet.classList.remove('is-open'); el.stopList.hidden = true; el.sheetToggle.setAttribute('aria-expanded', 'false');
      pulseCard();
    }
  }

  function stopIcon(state, num, isNew) {
    if (state === 'done') {
      return L.divIcon({ className: '', iconSize: [34, 34], iconAnchor: [17, 17], html:
        '<div class="trophy' + (isNew && !REDUCE ? ' is-new' : '') + '"><svg viewBox="0 0 40 40" aria-hidden="true">' +
        '<path d="M20 3l5 11 12 1.5-9 8 2.5 12L20 29.5 9.5 35.5 12 23.5l-9-8L15 14z" fill="#5d8a52" stroke="#4a3527" stroke-width="2.5" stroke-linejoin="round"/>' +
        '<path d="M13 21l5 5 9-10" fill="none" stroke="#f6ecd6" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"/></svg></div>' });
    }
    if (state === 'next') {
      return L.divIcon({ className: '', iconSize: [46, 56], iconAnchor: [23, 56], html:
        '<div class="pin pin--next"><div class="pin__ring"></div><div class="pin__wrap">' +
        '<span class="pin__tag">Neste</span><div class="pin__bun">' + num + '</div><div class="pin__tip"></div></div></div>' });
    }
    return L.divIcon({ className: '', iconSize: [34, 40], iconAnchor: [17, 40], html:
      '<div class="pin pin--todo"><div class="pin__bun">' + num + '</div><div class="pin__tip"></div></div>' });
  }

  /* ===================== the Bokka wagon (live marker) ===================== */
  function wagonSvg() {
    return '<svg viewBox="0 0 120 80" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
      // little helper pushing at the back
      '<g class="kid kid--2">' +
        '<path d="M14 44h5" stroke="#4a3527" stroke-width="3" stroke-linecap="round"/>' +
        '<rect x="5" y="44" width="12" height="15" rx="5" fill="#8f9d6a" stroke="#4a3527" stroke-width="2.5"/>' +
        '<circle cx="11" cy="37" r="7" fill="#f3d5b5" stroke="#4a3527" stroke-width="2.5"/>' +
        '<path d="M4.5 35.5q6.5-8 13 0" fill="#cf9a3e"/>' +
        '<circle cx="9.5" cy="37.5" r=".9" fill="#4a3527"/><circle cx="13" cy="37.5" r=".9" fill="#4a3527"/>' +
        '<path d="M8 59l-1 9M14 59l2 9" stroke="#4a3527" stroke-width="3" stroke-linecap="round"/>' +
      '</g>' +
      // wagon
      '<g class="wagon__body">' +
        '<path d="M68 48L88 39" stroke="#4a3527" stroke-width="3" stroke-linecap="round"/>' +
        '<path d="M24 34V17" stroke="#4a3527" stroke-width="2.5" stroke-linecap="round"/>' +
        '<path d="M24 17l15 4-15 5z" fill="#e0968a" stroke="#4a3527" stroke-width="2" stroke-linejoin="round"/>' +
        '<rect x="20" y="34" width="50" height="24" rx="6" fill="#5d8a52" stroke="#4a3527" stroke-width="3"/>' +
        '<path d="M30 39v14M40 39v14M50 39v14M60 39v14" stroke="#3f6b3a" stroke-width="2" stroke-linecap="round" opacity=".85"/>' +
        '<ellipse cx="32" cy="34" rx="9" ry="6" fill="#cf9a3e" stroke="#4a3527" stroke-width="2.5"/>' +
        '<ellipse cx="48" cy="33" rx="9" ry="6" fill="#e8c07d" stroke="#4a3527" stroke-width="2.5"/>' +
        '<ellipse cx="61" cy="35" rx="7" ry="5" fill="#cf9a3e" stroke="#4a3527" stroke-width="2.5"/>' +
        '<path d="M27 33q5-3 10 0M43 32q5-3 10 0" fill="none" stroke="#f6ecd6" stroke-width="1.5" stroke-linecap="round"/>' +
      '</g>' +
      // wheels (spin while moving)
      '<g class="wheel"><circle cx="32" cy="62" r="8" fill="#f6ecd6" stroke="#4a3527" stroke-width="3"/><path d="M32 54v16M24 62h16" stroke="#4a3527" stroke-width="2"/></g>' +
      '<g class="wheel"><circle cx="58" cy="62" r="8" fill="#f6ecd6" stroke="#4a3527" stroke-width="3"/><path d="M58 54v16M50 62h16" stroke="#4a3527" stroke-width="2"/></g>' +
      // kid pulling
      '<g class="kid">' +
        '<path d="M88 39l6 8" stroke="#4a3527" stroke-width="3" stroke-linecap="round"/>' +
        '<rect x="90" y="42" width="14" height="18" rx="6" fill="#e0968a" stroke="#4a3527" stroke-width="2.5"/>' +
        '<circle cx="97" cy="34" r="8.5" fill="#f3d5b5" stroke="#4a3527" stroke-width="2.5"/>' +
        '<path d="M88.5 31.5q8.5-9.5 17 0" fill="#4a3527"/>' +
        '<circle cx="95" cy="34.5" r="1" fill="#4a3527"/><circle cx="100" cy="34.5" r="1" fill="#4a3527"/>' +
        '<path d="M95 38.5q2.2 2 4.4 0" fill="none" stroke="#4a3527" stroke-width="1.2" stroke-linecap="round"/>' +
        '<path d="M93 60l-2 10M101 60l3 10" stroke="#4a3527" stroke-width="3" stroke-linecap="round"/>' +
      '</g>' +
      '</svg>';
  }

  function ensureWagon(latlng) {
    if (wagon) return;
    var icon = L.divIcon({ className: '', iconSize: [96, 72], iconAnchor: [48, 66], html:
      '<div class="wagon"><div class="wagon__pulse"></div><div class="wagon__shadow"></div><div class="wagon__art">' + wagonSvg() + '</div>' +
      '<div class="wagon__dir" hidden><svg viewBox="0 0 40 40" aria-hidden="true"><path d="M20 4 L34 30 L20 23 L6 30 Z" fill="#e0968a" stroke="#4a3527" stroke-width="3" stroke-linejoin="round"/></svg></div></div>' });
    wagon = L.marker(latlng, { icon: icon, interactive: false, keyboard: false, zIndexOffset: 1000 }).addTo(map);
    wagonEl = wagon.getElement().firstElementChild;
    wagonDirEl = wagonEl.querySelector('.wagon__dir');
    accCircle = L.circle(latlng, { radius: 0, color: '#cf9a3e', weight: 1, opacity: .35, fillColor: '#e8c07d', fillOpacity: .12, interactive: false }).addTo(map);
  }

  /* ===================== GPS ===================== */
  function onFab() {
    if (watchId === null) startTracking();
    startCompass(); // must run inside a tap for iOS permission
    setFollowing(true);
    if (gps.shown) centerOnWagon(true);
  }

  function startTracking() {
    if (!navigator.geolocation) { toast('Posisjon ikke tilgjengelig på denne telefonen'); return; }
    toast('Finner dere ' + E(0x2026));
    watchId = navigator.geolocation.watchPosition(onFix, function (err) {
      toast(err && err.code === 1 ? 'Gi appen lov til å bruke posisjon' : 'Fant ikke posisjonen');
    }, { enableHighAccuracy: true, maximumAge: 1500, timeout: 15000 });
  }

  function onFix(pos) {
    var c = pos.coords;
    if (!isFinite(c.latitude) || !isFinite(c.longitude)) return;
    if (c.accuracy && c.accuracy > 120) return;            // ignore hopeless fixes
    var p = { lat: c.latitude, lng: c.longitude };

    if (!wagon) {
      ensureWagon([p.lat, p.lng]);
      gps.shown = p; gps.anchor = p;
      programmaticMove = true;
      map.setView([p.lat, p.lng], Math.max(map.getZoom(), 17), { animate: false });
      programmaticMove = false;
      setFollowing(true);
      centerOnWagon(false);
    } else {
      var moved = gps.last ? distM(gps.last, p) : 0;
      if (moved > 2.5) setMoving();
      updateFacing(p);
      glideTo(p);
    }
    gps.last = p;
    accCircle.setLatLng([p.lat, p.lng]);
    accCircle.setRadius(c.accuracy && c.accuracy <= 60 ? c.accuracy : 0);
    // GPS course is only trustworthy while actually walking; the compass wins when it is live.
    if (!compassFresh() && isFinite(c.heading) && c.heading !== null && c.speed >= 0.6) setHeading(c.heading, 'gps');
    if (STATE.following) centerOnWagon(true);
    nudgeIfArrived(p);
    updateNav();
  }

  // One-time "you're here!" when within 30 m of the next stop.
  function nudgeIfArrived(p) {
    if (!STATE.route) return;
    var next = STATE.route.stops.filter(function (s) { return !s.levert; })[0];
    if (!next || gps.nearNotified[next.stopToken]) return;
    if (distM(p, next) <= 30) {
      gps.nearNotified[next.stopToken] = true;
      toast('Dere er ved stopp ' + next.stop + '! ' + E(0x1F35E) + ' Trykk Levert når brødet er levert');
      pulseCard();
    }
  }

  function toggleFullscreen() {
    var doc = document, root = doc.documentElement;
    var active = doc.fullscreenElement || doc.webkitFullscreenElement;
    try {
      if (active) (doc.exitFullscreen || doc.webkitExitFullscreen).call(doc);
      else (root.requestFullscreen || root.webkitRequestFullscreen).call(root);
      el.parentModal.hidden = true;
    } catch (e) { toast('Fullskjerm støttes ikke her – legg appen på Hjem-skjermen'); }
    setTimeout(onViewportChange, 400);
  }

  // Heading from real movement, not the noisy GPS heading: only re-evaluate after ≥8 m since the
  // last anchor, and only flip when the east/west component is ≥4 m (kills jitter flip-flop).
  function updateFacing(p) {
    if (!gps.anchor) { gps.anchor = p; return; }
    if (distM(gps.anchor, p) < 8) return;
    var dxM = (p.lng - gps.anchor.lng) * 111320 * Math.cos(p.lat * Math.PI / 180);
    if (Math.abs(dxM) >= 4) {
      var f = dxM > 0 ? 'east' : 'west';
      if (f !== gps.facing) { gps.facing = f; wagonEl.classList.toggle('face-west', f === 'west'); }
    }
    var gpsFresh = nav.src === 'gps' && (performance.now() - nav.headingT) < 5000;
    if (!compassFresh() && !gpsFresh) setHeading(bearing(gps.anchor, p), 'move'); // walked direction as last-resort heading
    gps.anchor = p;
  }

  function setMoving() {
    wagonEl.classList.add('is-moving');
    clearTimeout(gps.moveTimer);
    gps.moveTimer = setTimeout(function () { wagonEl.classList.remove('is-moving'); }, 2500);
  }

  // Smooth glide between fixes (rAF lerp) so the wagon never teleports.
  function glideTo(target) {
    if (gps.anim) cancelAnimationFrame(gps.anim);
    if (REDUCE || !gps.shown) { place(target); return; }
    var from = gps.shown, t0 = performance.now(), dur = 700;
    function step(now) {
      var k = Math.min(1, (now - t0) / dur); k = k * (2 - k); // ease-out
      place({ lat: from.lat + (target.lat - from.lat) * k, lng: from.lng + (target.lng - from.lng) * k });
      if (k < 1) gps.anim = requestAnimationFrame(step); else gps.anim = null;
    }
    gps.anim = requestAnimationFrame(step);
  }
  function place(p) { gps.shown = p; wagon.setLatLng([p.lat, p.lng]); updateTrail(); }

  /* ===================== follow mode ===================== */
  function setFollowing(on) {
    STATE.following = on;
    var tracking = watchId !== null;
    el.fab.classList.toggle('is-following', on && tracking);
    el.fab.classList.toggle('is-attention', tracking && !on);
    el.fab.querySelector('.fab__label').textContent = (on && tracking) ? 'Følger' : 'Finn oss';
  }

  // Pan (never zoom) so the wagon sits in the free space between HUD and sheet.
  function centerOnWagon(animate) {
    if (!gps.shown) return;
    var c = chrome_(), size = map.getSize();
    var visibleCenterY = c.hudBottom + (size.y - c.hudBottom - c.sheetH) / 2;
    var p = map.latLngToContainerPoint([gps.shown.lat, gps.shown.lng]);
    var delta = p.subtract(L.point(size.x / 2, visibleCenterY));
    if (Math.abs(delta.x) < 3 && Math.abs(delta.y) < 3) return;
    programmaticMove = true;
    map.once('moveend', function () { programmaticMove = false; });
    map.panBy(delta, { animate: animate && !REDUCE, duration: .5, easeLinearity: .35, noMoveStart: true });
  }

  /* ===================== chrome measurement (HUD / sheet / safe areas) ===================== */
  function chrome_() {
    var hudRect = el.hud.getBoundingClientRect();
    var sheetH = el.sheet.hidden ? 8 : (window.innerHeight - el.sheet.getBoundingClientRect().top);
    return { hudBottom: hudRect.bottom, sheetH: Math.max(8, sheetH) };
  }
  function measureChrome() {
    var c = chrome_();
    document.documentElement.style.setProperty('--hud-h', Math.round(c.hudBottom) + 'px');
    document.documentElement.style.setProperty('--sheet-h', Math.round(c.sheetH) + 'px');
  }
  function afterChromeChange() {
    measureChrome();
    if (STATE.following) centerOnWagon(true);
  }
  function onViewportChange() {
    measureChrome();
    map.invalidateSize({ pan: false });
    if (STATE.following) centerOnWagon(false);
  }

  /* ===================== effects ===================== */
  function sparkleAt(s) {
    if (REDUCE) return;
    var pt = map.latLngToContainerPoint([s.lat, s.lng]);
    var glyphs = [SPARK, STAR, WHEAT, SPARK];
    for (var i = 0; i < 8; i++) {
      var sp = document.createElement('span');
      sp.className = 'spark';
      sp.textContent = glyphs[i % glyphs.length];
      sp.style.left = pt.x + 'px'; sp.style.top = (pt.y - 14) + 'px';
      var ang = (i / 8) * Math.PI * 2, r = 34 + Math.random() * 22;
      sp.style.setProperty('--dx', Math.round(Math.cos(ang) * r) + 'px');
      sp.style.setProperty('--dy', Math.round(Math.sin(ang) * r - 20) + 'px');
      el.fx.appendChild(sp);
      (function (n) { setTimeout(function () { n.remove(); }, 1000); })(sp);
    }
  }

  function showCelebrate() {
    var r = STATE.route; if (!r) return;
    var t = r.totals || { bread: 0, buns: 0 };
    el.celebrateWagon.innerHTML = wagonSvg();
    var stars = ''; for (var i = 0; i < r.stops.length; i++) stars += '&#x2605;';
    el.celebrateStars.innerHTML = stars;
    el.celebrateText.textContent = 'Dere gikk hele ruten og leverte til ' + r.stops.length + ' stopp. Bra jobba, Bokka-bud!';
    el.cBread.textContent = t.bread; el.cBuns.textContent = t.buns;
    el.celebrate.hidden = false;
    burstConfetti();
  }

  function burstConfetti() {
    if (REDUCE) return;
    var glyphs = [WHEAT, E(0x1F35E), E(0x1F950), PARTY, E(0x1F49B)];
    for (var i = 0; i < 18; i++) {
      var c = document.createElement('div');
      c.className = 'confetti';
      c.textContent = glyphs[i % glyphs.length];
      c.style.left = Math.random() * 100 + 'vw';
      c.style.animationDuration = (1.6 + Math.random() * 1.4) + 's';
      c.style.animationDelay = (Math.random() * .4) + 's';
      document.body.appendChild(c);
      (function (n) { setTimeout(function () { n.remove(); }, 3300); })(c);
    }
  }

  /* ===================== small helpers ===================== */
  function findStop(token) {
    if (!STATE.route) return null;
    for (var i = 0; i < STATE.route.stops.length; i++) if (STATE.route.stops[i].stopToken === token) return STATE.route.stops[i];
    return null;
  }
  function countDone() { return STATE.route ? STATE.route.stops.filter(function (s) { return s.levert; }).length : 0; }
  function allDone() { return !!STATE.route && STATE.route.stops.length > 0 && countDone() === STATE.route.stops.length; }
  function lastDoneToken() {
    var d = STATE.route ? STATE.route.stops.filter(function (s) { return s.levert; }) : [];
    return d.length ? d[d.length - 1].stopToken : null;
  }
  // Walking directions straight to the geocoded point (falls back to an address search).
  function mapsUrl(s) {
    if (s && isFinite(s.lat) && isFinite(s.lng)) {
      return 'https://www.google.com/maps/dir/?api=1&destination=' + s.lat + ',' + s.lng + '&travelmode=walking';
    }
    return 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(String(s && s.adresse || '') + ', Stavanger, Norway');
  }
  function showNotice(msg) { el.notice.textContent = msg; el.notice.hidden = false; }
  function hideNotice() { el.notice.hidden = true; }

  var toastTimer = null;
  function toast(msg) {
    el.toast.textContent = msg;
    el.toast.classList.add('is-show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.toast.classList.remove('is-show'); }, 2400);
  }

  function distM(a, b) {
    var R = 6371000, toR = Math.PI / 180;
    var dLat = (b.lat - a.lat) * toR, dLng = (b.lng - a.lng) * toR;
    var h = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(a.lat * toR) * Math.cos(b.lat * toR) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return 2 * R * Math.asin(Math.sqrt(h));
  }
  function samePt(a, b) { return Math.abs(a[0] - b[0]) < 1e-6 && Math.abs(a[1] - b[1]) < 1e-6; }

  // Initial bearing a→b in degrees clockwise from north.
  function bearing(a, b) {
    var toR = Math.PI / 180;
    var f1 = a.lat * toR, f2 = b.lat * toR, dl = (b.lng - a.lng) * toR;
    var y = Math.sin(dl) * Math.cos(f2);
    var x = Math.cos(f1) * Math.sin(f2) - Math.sin(f1) * Math.cos(f2) * Math.cos(dl);
    return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
  }

  // Nearest point on a polyline ([[lat,lng]…]) to p, in a local metre frame.
  // Returns { d: metres off the line, i: segment index, pt: [lat,lng] } or null.
  function snapToLeg(p, pts) {
    var kx = 111320 * Math.cos(p.lat * Math.PI / 180), ky = 110540, best = null;
    for (var i = 0; i < pts.length - 1; i++) {
      var ax = (pts[i][1] - p.lng) * kx, ay = (pts[i][0] - p.lat) * ky;
      var bx = (pts[i + 1][1] - p.lng) * kx, by = (pts[i + 1][0] - p.lat) * ky;
      var dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
      var t = L2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / L2)) : 0;
      var x = ax + dx * t, y = ay + dy * t, d = Math.sqrt(x * x + y * y);
      if (!best || d < best.d) best = { d: d, i: i, pt: [pts[i][0] + (pts[i + 1][0] - pts[i][0]) * t, pts[i][1] + (pts[i + 1][1] - pts[i][1]) * t] };
    }
    return best;
  }

  function pathLen(pts) {
    var m = 0;
    for (var i = 1; i < pts.length; i++) m += distM({ lat: pts[i - 1][0], lng: pts[i - 1][1] }, { lat: pts[i][0], lng: pts[i][1] });
    return m;
  }

  // Point `meters` along the polyline from its start (clamped to the end).
  function pointAlong(pts, meters) {
    for (var i = 1; i < pts.length; i++) {
      var a = { lat: pts[i - 1][0], lng: pts[i - 1][1] }, b = { lat: pts[i][0], lng: pts[i][1] };
      var seg = distM(a, b);
      if (meters <= seg && seg > 0) {
        var k = meters / seg;
        return [a.lat + (b.lat - a.lat) * k, a.lng + (b.lng - a.lng) * k];
      }
      meters -= seg;
    }
    return pts[pts.length - 1];
  }

  function esc(v) {
    return String(v == null ? '' : v)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // Google encoded polyline → [[lat,lng], …]
  function decodePolyline(str) {
    var index = 0, lat = 0, lng = 0, coords = [];
    while (index < str.length) {
      var b, shift = 0, result = 0;
      do { b = str.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
      lat += (result & 1) ? ~(result >> 1) : (result >> 1);
      shift = 0; result = 0;
      do { b = str.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
      lng += (result & 1) ? ~(result >> 1) : (result >> 1);
      coords.push([lat / 1e5, lng / 1e5]);
    }
    return coords;
  }
})();
