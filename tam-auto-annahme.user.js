// ==UserScript==
// @name         TAM Auto-Annahme (IB Thomée)
// @namespace    ib-thomee
// @version      1.0.0
// @description  Prüft "Veröffentlichte Aufträge" im TÜV SÜD TAM regelmäßig und nimmt Aufträge an, deren PLZ/Ort in der Ortsliste steht.
// @match        https://tam.tuvsud.com/*
// @homepageURL  https://github.com/TheFishflap/TamAuto
// @updateURL    https://raw.githubusercontent.com/TheFishflap/TamAuto/main/tam-auto-annahme.user.js
// @downloadURL  https://raw.githubusercontent.com/TheFishflap/TamAuto/main/tam-auto-annahme.user.js
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_notification
// @grant        GM_info
// @connect      docs.google.com
// @connect      googleusercontent.com
// @connect      raw.githubusercontent.com
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  // Nur im TAM aktiv werden
  if (!document.querySelector('script[src*="de.tomcom.tam.TAM"]')) return;

  // ------------------------------------------------------------------ Konfiguration
  const DEFAULTS = {
    sheetId: '1VTkQpt7AFA_mzrG6Bpw0yrzoVcJhrSzh',
    sheetGid: '1524429178',
    intervalSec: 30,          // Prüf-/Refresh-Intervall (Sekunden)
    dryRun: true,             // true = nur melden, NICHT annehmen
    enabled: false,
    maxPerCycle: 3,           // Sicherheitsbremse
    tabName: 'Veröffentlichte Aufträge',
    tabPanelId: 'AgentVeroeffentlichteAuftraege', // feste ID des Tabs im TAM
    orderWindowTitle: /^auftragskarte/i,          // Fenster nach Doppelklick
    acceptButton: /^annehmen$/i,                  // Button unten in der Auftragskarte
    confirmDialogTitle: /auftragsannahme bestätigen/i,
    confirmButton: /^bestätigen$/i,
  };
  const cfg = Object.assign({}, DEFAULTS, {
    intervalSec: GM_getValue('intervalSec', DEFAULTS.intervalSec),
    dryRun: GM_getValue('dryRun', DEFAULTS.dryRun),
    enabled: GM_getValue('enabled', DEFAULTS.enabled),
    maxPerCycle: GM_getValue('maxPerCycle', DEFAULTS.maxPerCycle),
    autoRefresh: GM_getValue('autoRefresh', true),
  });

  let places = GM_getValue('places', { plz: [], orte: [], loadedAt: null, source: '' });
  let done = new Set(GM_getValue('doneRefs', [])); // bereits bearbeitete Aufträge
  let timer = null;
  let refreshTimer = null;
  let lastRefreshOk = null;
  let busy = false;
  let lastSummary = '';
  const seen = new Set(); // in dieser Sitzung schon protokollierte Aufträge

  // ------------------------------------------------------------------ Hilfsfunktionen
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const norm = (s) => (s || '').toString().trim().toLowerCase()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .replace(/\s+/g, ' ');
  const visible = (el) => !!el && el.offsetParent !== null && getComputedStyle(el).visibility !== 'hidden';
  const text = (el) => (el ? el.textContent.replace(/\u00a0/g, ' ').trim() : '');

  function fire(el, types = ['mouseover', 'mousedown', 'mouseup', 'click']) {
    const r = el.getBoundingClientRect();
    const opts = { bubbles: true, cancelable: true, button: 0,
      clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
    types.forEach((t) => el.dispatchEvent(new MouseEvent(t, opts)));
  }

  async function waitFor(fn, timeout = 5000, step = 150) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      const v = fn();
      if (v) return v;
      await sleep(step);
    }
    return null;
  }

  function log(msg, level = 'info') {
    const line = `${new Date().toLocaleTimeString('de-DE')}  ${msg}`;
    console[level === 'err' ? 'error' : 'log']('[TAM-Auto]', msg);
    const box = document.getElementById('tamauto-log');
    if (box) {
      const d = document.createElement('div');
      d.textContent = line;
      if (level === 'err') d.style.color = '#c62828';
      if (level === 'ok') d.style.color = '#2e7d32';
      box.prepend(d);
      while (box.childNodes.length > 200) box.lastChild.remove();
    }
  }

  function notify(title, body) {
    try { GM_notification({ title, text: body, timeout: 15000 }); } catch (e) { /* ignore */ }
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const o = ctx.createOscillator(); o.frequency.value = 880; o.connect(ctx.destination);
      o.start(); o.stop(ctx.currentTime + 0.25);
    } catch (e) { /* ignore */ }
  }

  // ------------------------------------------------------------------ Ortsliste laden
  function parseCSV(str) {
    const rows = []; let row = []; let cur = ''; let q = false;
    for (let i = 0; i < str.length; i++) {
      const c = str[i];
      if (q) {
        if (c === '"' && str[i + 1] === '"') { cur += '"'; i++; }
        else if (c === '"') q = false;
        else cur += c;
      } else if (c === '"') q = true;
      else if (c === ',' || c === ';') { row.push(cur); cur = ''; }
      else if (c === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; }
      else if (c !== '\r') cur += c;
    }
    if (cur || row.length) { row.push(cur); rows.push(row); }
    return rows;
  }

  function extractPlaces(rows, source) {
    const plz = new Set(); const orte = new Set();
    if (!rows.length) return { plz: [], orte: [], loadedAt: new Date().toISOString(), source };
    // Kopfzeile suchen: erste Zeile, die "ort" oder "plz" enthält
    let hIdx = rows.findIndex((r) => r.some((c) => /^(plz|ort|stadt|gemeinde|postleitzahl)/i.test(c.trim())));
    const header = hIdx >= 0 ? rows[hIdx].map((c) => c.trim().toLowerCase()) : [];
    const ortCols = header.map((h, i) => (/^(ort|stadt|gemeinde)/.test(h) ? i : -1)).filter((i) => i >= 0);
    rows.slice(hIdx + 1).forEach((r) => {
      r.forEach((c, i) => {
        const v = c.trim();
        const m = v.match(/\b\d{5}\b/g);
        if (m) m.forEach((p) => plz.add(p));
        if (ortCols.includes(i) && v && !/^\d+$/.test(v)) orte.add(norm(v.replace(/^\d{5}\s*/, '')));
      });
    });
    return { plz: [...plz], orte: [...orte], loadedAt: new Date().toISOString(), source };
  }

  function loadPlacesFromSheet() {
    const url = `https://docs.google.com/spreadsheets/d/${cfg.sheetId}/export?format=csv&gid=${cfg.sheetGid}`;
    log('Lade Ortsliste aus Google Sheets …');
    return new Promise((resolve) => {
      GM_xmlhttpRequest({
        method: 'GET', url, anonymous: false,
        onload: (res) => {
          if (res.status !== 200 || /<html/i.test(res.responseText.slice(0, 200))) {
            log(`Ortsliste nicht ladbar (HTTP ${res.status}). Freigabe prüfen oder Liste manuell einfügen.`, 'err');
            return resolve(false);
          }
          places = extractPlaces(parseCSV(res.responseText), 'Google Sheets');
          GM_setValue('places', places);
          log(`Ortsliste geladen: ${places.plz.length} PLZ, ${places.orte.length} Orte`, 'ok');
          renderStatus(); resolve(true);
        },
        onerror: () => { log('Netzwerkfehler beim Laden der Ortsliste.', 'err'); resolve(false); },
      });
    });
  }

  function loadPlacesFromText(t) {
    places = extractPlaces(parseCSV(t), 'manuell');
    // Falls keine Kopfzeile: jede Zeile ohne PLZ als Ort übernehmen
    if (!places.orte.length) {
      t.split(/\r?\n/).map((l) => l.replace(/\b\d{5}\b/g, '').replace(/[;,]/g, ' ').trim())
        .filter(Boolean).forEach((o) => places.orte.push(norm(o)));
    }
    GM_setValue('places', places);
    log(`Manuelle Liste übernommen: ${places.plz.length} PLZ, ${places.orte.length} Orte`, 'ok');
    renderStatus();
  }

  function matches(order) {
    // Treffer, wenn PLZ ODER Ortsname in der Ortsliste steht
    return places.plz.includes((order.plz || '').trim()) || places.orte.includes(norm(order.ort));
  }

  // ------------------------------------------------------------------ Updates (GitHub)
  const UPDATE_URL = 'https://raw.githubusercontent.com/TheFishflap/TamAuto/main/tam-auto-annahme.user.js';
  const VERSION = (typeof GM_info !== 'undefined' && GM_info.script && GM_info.script.version) || '0';

  function newerVersion(a, b) { // true, wenn a > b
    const pa = a.split('.').map((n) => parseInt(n, 10) || 0);
    const pb = b.split('.').map((n) => parseInt(n, 10) || 0);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
    }
    return false;
  }

  function checkUpdate(manual = false) {
    GM_setValue('lastUpdateCheck', Date.now());
    GM_xmlhttpRequest({
      method: 'GET', url: `${UPDATE_URL}?t=${Date.now()}`,
      onload: (res) => {
        const m = res.status === 200 && res.responseText.match(/@version\s+(\S+)/);
        if (!m) { if (manual) log(`Update-Prüfung fehlgeschlagen (HTTP ${res.status}).`, 'err'); return; }
        const upd = document.getElementById('tamauto-update');
        if (newerVersion(m[1], VERSION)) {
          log(`Update ${m[1]} verfügbar (installiert: ${VERSION}).`, 'ok');
          if (upd) { upd.textContent = `⬆ Update ${m[1]} verfügbar – installieren`; upd.style.display = 'block'; }
        } else if (manual) log(`Kein Update – ${VERSION} ist aktuell.`, 'ok');
      },
      onerror: () => { if (manual) log('Netzwerkfehler bei der Update-Prüfung.', 'err'); },
    });
  }

  // ------------------------------------------------------------------ TAM-Oberfläche (GXT 2)
  function activeTabName() {
    const t = [...document.querySelectorAll('.x-tab-strip-active .x-tab-strip-text')].find(visible);
    return text(t);
  }

  // Ist der aktive Tab wirklich "Veröffentlichte Aufträge"?
  function onPublishedTab() {
    // Reiter des Tabs direkt über seine ID suchen (…__AgentVeroeffentlichteAuftraege)
    const li = document.querySelector(`li[id$="__${cfg.tabPanelId}"]`);
    const panel = document.getElementById(cfg.tabPanelId);
    return !!li && li.classList.contains('x-tab-strip-active') &&
      !!panel && !panel.closest('.x-hide-display');
  }

  function activeTabPanel() {
    return onPublishedTab() ? document.getElementById(cfg.tabPanelId) : null;
  }

  // Nur die Tabelle innerhalb des Tabs "Veröffentlichte Aufträge"
  function visibleGrid() {
    const panel = activeTabPanel();
    if (!panel) return null;
    return [...panel.querySelectorAll('.x-grid3')].find(visible) || null;
  }

  let lastColInfo = '';
  let lastColsOk = false;
  // Spalten werden über ihre GXT-Spalten-ID zugeordnet (Klasse x-grid3-td-<id>),
  // nicht über die Position – Reihenfolge und ausgeblendete Spalten spielen so keine Rolle.
  function readOrders(grid) {
    const colIdOf = (td) => ((td.className.match(/x-grid3-td-(\S+)/) || [])[1] || null);
    const heads = [...grid.querySelectorAll('.x-grid3-hd-row td')]
      .map((td) => ({ name: norm(text(td)), id: colIdOf(td) }))
      .filter((h) => h.name);
    const find = (re) => heads.find((h) => re.test(h.name)) || null;
    const col = {
      nr: find(/^auftragsnr/), preis: find(/^preis/), dienst: find(/^dienstleistung/),
      ref: find(/^referenz$/), plz: find(/^plz$/), ort: find(/^ort$/), strasse: find(/^strasse/),
      status: find(/^status$/),
    };
    lastColsOk = !!(col.plz && col.plz.id && col.ort && col.ort.id);
    lastColInfo = `Spalten erkannt: ${Object.entries(col).filter(([, v]) => v).map(([k, v]) => `${k}→${v.id}`).join(', ')}` +
      (lastColsOk ? '' : '  ⚠ PLZ/Ort-Spalte NICHT erkannt');

    let rows = [...grid.querySelectorAll('.x-grid3-row')];
    if (!rows.length) rows = [...grid.querySelectorAll('.x-grid3-body > div')].filter((r) => r.querySelector('td'));
    return rows.map((row) => {
      const g = (k) => {
        if (!col[k] || !col[k].id) return '';
        return text(row.querySelector(`td.x-grid3-td-${CSS.escape(col[k].id)}`));
      };
      const o = { row, nr: g('nr'), preis: g('preis'), dienst: g('dienst'), ref: g('ref'),
        plz: g('plz'), ort: g('ort'), strasse: g('strasse'), status: g('status') };
      // Plausibilität: PLZ muss 5-stellig sein, sonst Zeile nicht verwenden
      o.valid = lastColsOk && /^\d{5}$/.test(o.plz) && !!o.ort;
      return o;
    });
  }

  function findButton(re, root = document) {
    return [...root.querySelectorAll('.x-btn, .x-toolbar .x-component')]
      .filter(visible)
      .find((b) => re.test(text(b)) || re.test(b.getAttribute('title') || '') ||
        re.test((b.querySelector('[qtip]') || {}).getAttribute?.('qtip') || ''));
  }

  // Refresh-Pfeil in der Blätterleiste unten (|< < Seite > >| ⟳). Reihenfolge der Symbol-Buttons:
  // Erste, Zurück, Weiter, Letzte, Aktualisieren → der 5. Symbol-Button.
  let refreshInfoLogged = false;
  function findRefreshButton(panel) {
    const bar = [...panel.querySelectorAll('.x-toolbar')].filter(visible)
      .find((tb) => /einträge pro seite/i.test(text(tb)));
    if (!bar) return null;
    const iconBtns = [...bar.querySelectorAll('.x-btn')].filter((b) => visible(b) && !text(b));
    const btn = iconBtns[4] || null;
    if (!refreshInfoLogged) {
      log(btn ? `Refresh-Button gefunden (Symbol 5 von ${iconBtns.length})`
        : `Refresh-Button nicht gefunden (${iconBtns.length} Symbol-Buttons) – nutze TAM-Autoaktualisierung`, btn ? 'info' : 'err');
      refreshInfoLogged = true;
    }
    return btn;
  }

  // Klickt den Refresh-Pfeil und prüft, ob die Tabelle wirklich neu geladen wurde.
  async function refreshGrid() {
    const panel = activeTabPanel();
    if (!panel) return false;
    const btn = findRefreshButton(panel);
    if (!btn) return false;
    const grid = visibleGrid();
    const body = grid && grid.querySelector('.x-grid3-body');
    const firstRow = grid && grid.querySelector('.x-grid3-row');
    if (firstRow) firstRow.dataset.tamautoMark = '1';
    let maskSeen = false;
    clickBtn(btn);
    const t0 = Date.now();
    // bis zu 10 s: Lade-Maske gesehen und wieder weg, oder Zeilen neu gerendert
    await waitFor(() => {
      const mask = [...panel.querySelectorAll('.x-mask-loading, .ext-el-mask')].some(visible);
      if (mask) { maskSeen = true; return false; }
      const g = visibleGrid();
      const rowNow = g && g.querySelector('.x-grid3-row');
      const rerendered = (firstRow && (!firstRow.isConnected || !rowNow || !rowNow.dataset.tamautoMark)) ||
        (!firstRow && rowNow) || (g && g.querySelector('.x-grid3-body') !== body);
      return maskSeen || rerendered;
    }, 10000, 100);
    const ok = maskSeen || Date.now() - t0 < 10000;
    const stamp = new Date().toLocaleTimeString('de-DE');
    setRefreshStatus(ok ? `Letzter Refresh: ${stamp} ✓` : `Letzter Refresh: ${stamp} ✗ keine Wirkung`);
    if (ok !== lastRefreshOk) {
      log(ok ? 'Refresh funktioniert – Tabelle wurde neu geladen.' :
        'Refresh-Klick ohne Wirkung (Tabelle nicht neu geladen). Bitte melden.', ok ? 'ok' : 'err');
      lastRefreshOk = ok;
    }
    await sleep(300);
    return ok;
  }

  function setRefreshStatus(t) { const el = document.getElementById('tamauto-refresh'); if (el) el.textContent = t; }

  function startRefreshTimer() {
    clearInterval(refreshTimer);
    if (!cfg.autoRefresh) { setRefreshStatus('Auto-Refresh aus'); return; }
    setRefreshStatus(`Auto-Refresh alle ${cfg.intervalSec} s`);
    refreshTimer = setInterval(() => { if (!busy && onPublishedTab()) refreshGrid(); }, cfg.intervalSec * 1000);
  }

  function clickBtn(b) {
    const inner = b.querySelector('button') || b;
    fire(inner, ['mouseover', 'mousedown', 'mouseup', 'click']);
  }

  const visibleWindows = () => [...document.querySelectorAll('.x-window')].filter(visible);
  const winTitle = (w) => text(w.querySelector('.x-window-header-text, .x-window-header'));

  function closeWindow(win) {
    if (!win || !visible(win)) return;
    const btn = findButton(/^schließen$/i, win);
    if (btn) clickBtn(btn); else { const x = win.querySelector('.x-tool-close'); if (x) fire(x); }
  }

  // ---- Auftragskarte (Aufbau laut TAM):
  // Warenkorb: .x-view-item mit <input class="x-view-item-checkbox"> + AuftragsNr als Text
  //            Kopf-Checkbox im Panel-Header "Warenkorb" = alle auswählen
  // Umgebung:  .zusatzteilauftrag mit .entfernung ("5 km") + AuftragsNr + Dienstleistung
  function warenkorbItems(card) {
    return [...card.querySelectorAll('.x-view-item')]
      .filter((it) => visible(it) && it.querySelector('input.x-view-item-checkbox') && !it.closest('.zusatzteilauftrag'))
      .map((it) => ({ el: it, cb: it.querySelector('input.x-view-item-checkbox'), nr: text(it).toUpperCase() }));
  }
  function nearbyItems(card) {
    return [...card.querySelectorAll('.zusatzteilauftrag')].filter(visible).map((el) => {
      const km = text(el.querySelector('.entfernung'));
      const rest = text(el).replace(km, '').trim();
      const nr = ((rest.match(/^((MW)?\d{6,})/i) || [])[1] || '').toUpperCase();
      return { el, km, kmNum: parseFloat(km.replace(',', '.')), nr };
    });
  }
  async function setChecked(cb, want) {
    if (cb.checked === want) return true;
    cb.click();
    await sleep(400);
    return cb.checked === want;
  }

  async function acceptOrder(order) {
    if (!onPublishedTab()) { log('Abbruch: nicht im Tab "Veröffentlichte Aufträge".', 'err'); return false; }
    const nr = (order.nr || '').trim();
    if (!/^(MW)?\d{6,}$/i.test(nr)) { log(`Keine gültige AuftragsNr in der Zeile (${nr || 'leer'}).`, 'err'); return false; }

    // 1) Doppelklick -> "Auftragskarte zu MW…"
    const before = new Set(visibleWindows());
    // sichtbare Zelle anklicken (die ersten Zellen sind im TAM ausgeblendete Spalten)
    const cell = [...order.row.querySelectorAll('td.x-grid3-cell')].find(visible) || order.row;
    fire(cell, ['mousedown', 'mouseup', 'click']);
    await sleep(200);
    fire(cell, ['mousedown', 'mouseup', 'click', 'dblclick']);
    const card = await waitFor(() => visibleWindows()
      .find((w) => !before.has(w) && cfg.orderWindowTitle.test(winTitle(w))), 8000);
    if (!card) { log(`Auftragskarte für ${nr} öffnete sich nicht.`, 'err'); return false; }

    // Sicherheitscheck: richtige Auftragskarte?
    if (!winTitle(card).includes(nr)) {
      log(`Falsche Auftragskarte ("${winTitle(card)}") – erwartet ${nr}. Abbruch.`, 'err');
      closeWindow(card); return false;
    }
    await sleep(1000);

    // 2) Erst "Aufträge in der Umgebung" mit 0 km je 1× anklicken (landen im Warenkorb) …
    const extra = [];
    for (const item of nearbyItems(card).filter((n) => n.kmNum === 0 && n.nr && n.nr !== nr.toUpperCase())) {
      fire(item.el, ['mouseover', 'mousedown', 'mouseup', 'click']);
      const w = await waitFor(() => warenkorbItems(card).find((x) => x.nr === item.nr), 4000);
      if (w) { extra.push(item.nr); log(`+ ${item.nr} (0 km) in den Warenkorb`); }
      else log(`${item.nr} (0 km) erschien nicht im Warenkorb – übersprungen.`, 'err');
    }
    order.extra = extra;

    // … dann ganz am Ende "Warenkorb – alle auswählen" anhaken
    const selectAll = [...card.querySelectorAll('input.x-view-item-checkbox')]
      .find((cb) => !cb.closest('.x-view-item') && /warenkorb/i.test(text(cb.closest('.x-panel-header') || cb.parentElement)));
    if (!selectAll) { log('Checkbox "Warenkorb – alle auswählen" nicht gefunden.', 'err'); closeWindow(card); return false; }
    await setChecked(selectAll, true);
    const items = warenkorbItems(card);
    const unchecked = items.filter((w) => !w.cb.checked).map((w) => w.nr);
    if (!items.some((w) => w.nr === nr.toUpperCase())) { log(`${nr} nicht im Warenkorb.`, 'err'); closeWindow(card); return false; }
    if (unchecked.length) { log(`Nicht angehakt trotz "alle auswählen": ${unchecked.join(', ')}`, 'err'); closeWindow(card); return false; }

    // 3) "Annehmen" unten in der Auftragskarte
    const acceptBtn = findButton(cfg.acceptButton, card);
    if (!acceptBtn) { log('Button "Annehmen" nicht gefunden.', 'err'); closeWindow(card); return false; }
    clickBtn(acceptBtn);

    // 4) Dialog "Auftragsannahme bestätigen" (einmalig für alle): Haken setzen -> "Bestätigen"
    const dlg = await waitFor(() => visibleWindows()
      .find((w) => w !== card && cfg.confirmDialogTitle.test(winTitle(w))), 6000);
    if (!dlg) {
      const hint = [...document.querySelectorAll('div, span')].filter((e) => visible(e) && e.children.length === 0 &&
        /sie müssen/i.test(text(e))).map(text)[0];
      log(`Dialog "Auftragsannahme bestätigen" erschien nicht${hint ? ` – TAM: "${hint}"` : ''}.`, 'err');
      closeWindow(card); return false;
    }
    const termsCb = dlg.querySelector('input.x-form-checkbox, input[type=checkbox]');
    if (!termsCb || !(await setChecked(termsCb, true))) {
      log('Bedingungs-Haken ließ sich nicht setzen.', 'err');
      const cancel = findButton(/^abbrechen$/i, dlg); if (cancel) clickBtn(cancel);
      await sleep(300); closeWindow(card); return false;
    }
    const okBtn = await waitFor(() => {
      const b = findButton(cfg.confirmButton, dlg);
      return b && !b.classList.contains('x-item-disabled') ? b : null;
    }, 3000);
    if (!okBtn) {
      log('"Bestätigen" bleibt gesperrt – Abbruch.', 'err');
      const cancel = findButton(/^abbrechen$/i, dlg); if (cancel) clickBtn(cancel);
      await sleep(300); closeWindow(card); return false;
    }
    clickBtn(okBtn);
    await sleep(2500);

    // 5) Fehlermeldung erkennen
    const errWin = visibleWindows().find((w) => w !== card && !before.has(w) &&
      /fehler|error|nicht möglich|bereits|vergeben/i.test(text(w)));
    if (errWin) {
      log(`TAM meldet: ${text(errWin).slice(0, 160)}`, 'err');
      closeWindow(errWin); await sleep(300); closeWindow(card);
      return false;
    }
    // Hinweis-/Erfolgsfenster wegklicken, Auftragskarte schließen
    visibleWindows().filter((w) => w !== card && !before.has(w)).forEach((w) => {
      const b = findButton(/^(ok|schließen)$/i, w); if (b) clickBtn(b);
    });
    await sleep(300);
    closeWindow(card);
    await sleep(500);
    order.auftragsNr = nr;
    return true;
  }

  // ------------------------------------------------------------------ Hauptzyklus
  async function cycle(fromObserver = false) {
    if (busy || !cfg.enabled) return;
    busy = true;
    try {
      if (!places.plz.length && !places.orte.length) { log('Keine Ortsliste geladen – übersprungen.', 'err'); return; }
      if (!onPublishedTab()) {
        setStatus(`Pausiert – Tab "${cfg.tabName}" ist nicht aktiv`); return;
      }
      const grid = visibleGrid();
      if (!grid) { log('Keine Auftragstabelle im Tab "Veröffentlichte Aufträge" gefunden.', 'err'); return; }
      const all = readOrders(grid).map((o) => Object.assign(o, { key: o.nr || o.ref }));
      if (!lastColsOk) {
        if (lastSummary !== 'NOCOLS') log(`Abbruch: PLZ/Ort-Spalte nicht gefunden. ${lastColInfo}`, 'err');
        lastSummary = 'NOCOLS'; setStatus('Fehler: PLZ/Ort-Spalte nicht gefunden'); return;
      }
      all.filter((o) => !o.valid && o.key && !seen.has(o.key)).forEach((o) => {
        seen.add(o.key); log(`${o.key}: PLZ "${o.plz}" / Ort "${o.ort}" unplausibel – übersprungen`, 'err');
      });
      const noKey = all.filter((o) => !o.key);
      const old = all.filter((o) => o.key && done.has(o.key));
      const orders = all.filter((o) => o.valid && o.key && !done.has(o.key));
      const hits = orders.filter(matches);
      setStatus(`${new Date().toLocaleTimeString('de-DE')}: ${all.length} in Tabelle · ${orders.length} offen · ` +
        `${hits.length} passend · ${old.length} bereits bearbeitet`);

      // Protokoll: Zusammenfassung nur bei Änderung, jeden Auftrag einmalig mit Entscheidung
      const summary = `Prüfung: ${all.length} Aufträge in Tabelle, ${orders.length} offen, ${hits.length} passend, ` +
        `${old.length} bereits bearbeitet` + (noKey.length ? `, ${noKey.length} ohne AuftragsNr` : '');
      if (summary !== lastSummary) {
        log(summary);
        if (noKey.length) log(lastColInfo, 'err');
        lastSummary = summary;
      }
      orders.forEach((o) => {
        if (seen.has(o.key)) return;
        seen.add(o.key);
        const why = matches(o) ? 'TREFFER → wird angenommen'
          : `kein Treffer (PLZ ${o.plz || '?'} und Ort "${o.ort || '?'}" nicht in Ortsliste)`;
        log(`${o.key} · ${o.plz} ${o.ort} · ${o.dienst.slice(0, 40)} → ${why}`, matches(o) ? 'ok' : 'info');
      });
      let n = 0;
      for (const o of hits) {
        if (n >= cfg.maxPerCycle) { log(`Limit ${cfg.maxPerCycle}/Zyklus erreicht.`); break; }
        const desc = `${o.nr || o.ref} · ${o.plz} ${o.ort} · ${o.dienst}${o.preis ? ' · ' + o.preis : ''}`;
        if (cfg.dryRun) {
          log(`[TEST] würde annehmen: ${desc}`, 'ok');
          notify('TAM: passender Auftrag', desc);
          done.add(o.key);
        } else {
          // Vor jeder Annahme erneut prüfen: richtiger Tab, Zeile noch in dieser Tabelle
          if (!onPublishedTab() || visibleGrid() !== grid || !grid.contains(o.row)) {
            log('Abbruch: Tab gewechselt oder Tabelle neu geladen – keine Annahme.', 'err'); break;
          }
          log(`Nehme an: ${desc}`);
          const ok = await acceptOrder(o);
          if (ok) {
            const plus = (o.extra || []).length ? ` + ${o.extra.join(', ')} (0 km)` : '';
            log(`Angenommen: ${desc}${plus}`, 'ok'); notify('TAM: Auftrag angenommen', desc + plus);
            done.add(o.key); (o.extra || []).forEach((x) => done.add(x)); n++;
          }
          else { notify('TAM: Annahme fehlgeschlagen', desc); done.add(o.key); } // nicht endlos erneut versuchen
          await sleep(1500);
        }
      }
      GM_setValue('doneRefs', [...done].slice(-2000));
    } catch (e) {
      log(`Fehler: ${e.message}`, 'err');
    } finally { busy = false; }
  }

  function restartTimer() {
    clearInterval(timer);
    if (cfg.enabled) { timer = setInterval(cycle, cfg.intervalSec * 1000); cycle(); }
  }

  // ------------------------------------------------------------------ Bedienfeld
  function setStatus(s) { const el = document.getElementById('tamauto-status'); if (el) el.textContent = s; }
  function renderStatus() {
    const el = document.getElementById('tamauto-places');
    if (el) el.textContent = `Ortsliste: ${places.plz.length} PLZ / ${places.orte.length} Orte` +
      (places.loadedAt ? ` (${places.source}, ${new Date(places.loadedAt).toLocaleString('de-DE')})` : ' – nicht geladen');
    const btn = document.getElementById('tamauto-toggle');
    if (btn) { btn.textContent = cfg.enabled ? '■ Stop' : '▶ Start'; btn.style.background = cfg.enabled ? '#c62828' : '#2e7d32'; }
    const dr = document.getElementById('tamauto-dry'); if (dr) dr.checked = cfg.dryRun;
    const mode = document.getElementById('tamauto-mode');
    if (mode) { mode.textContent = cfg.dryRun ? 'TESTMODUS – nimmt nichts an' : 'LIVE – nimmt Aufträge an';
      mode.style.color = cfg.dryRun ? '#b26a00' : '#c62828'; }
  }

  function buildPanel() {
    const p = document.createElement('div');
    p.id = 'tamauto';
    p.innerHTML = `
      <div id="tamauto-head" style="display:flex;justify-content:space-between;align-items:center;cursor:move">
        <b>TAM Auto-Annahme v${VERSION}</b><span id="tamauto-min" style="cursor:pointer;padding:0 4px">–</span></div>
      <div id="tamauto-body">
        <a id="tamauto-update" href="${UPDATE_URL}" target="_blank" style="display:none;font-weight:bold;color:#1a4d8f;margin:4px 0"></a>
        <div id="tamauto-mode" style="font-weight:bold;margin:4px 0"></div>
        <div id="tamauto-places"></div>
        <div id="tamauto-status" style="color:#555">bereit</div>
        <div id="tamauto-refresh" style="color:#555"></div>
        <div style="margin:6px 0;display:flex;gap:6px;flex-wrap:wrap;align-items:center">
          <button id="tamauto-toggle"></button>
          <button id="tamauto-load">Ortsliste laden</button>
          <button id="tamauto-paste">Liste einfügen</button>
          <label><input type="checkbox" id="tamauto-dry"> Testmodus</label>
          <label title="Klickt alle x Sekunden den Refresh-Pfeil der Tabelle – unabhängig von Start/Stop"><input type="checkbox" id="tamauto-ar"> Auto-Refresh</label>
          <label>alle <input id="tamauto-int" type="number" min="15" style="width:48px" value="${cfg.intervalSec}"> s</label>
          <button id="tamauto-reset" title="Liste bereits bearbeiteter Aufträge leeren">Verlauf leeren</button>
          <button id="tamauto-diag" title="Zeigt Tab, Tabelle, Spalten und Ortsliste im Protokoll">Diagnose</button>
          <button id="tamauto-once" title="Nimmt den obersten Auftrag der Tabelle EINMAL verbindlich an – ohne Ortsliste">1 Auftrag testen</button>
          <button id="tamauto-upd" title="Sucht auf GitHub nach einer neuen Version">Update prüfen</button>
        </div>
        <textarea id="tamauto-ta" placeholder="PLZ;Ort je Zeile (oder CSV mit Kopfzeile PLZ/Ort)" style="display:none;width:100%;height:80px"></textarea>
        <div id="tamauto-log" style="max-height:220px;overflow:auto;font:11px monospace;border-top:1px solid #ddd;padding-top:4px"></div>
      </div>`;
    Object.assign(p.style, { position: 'fixed', right: '12px', bottom: '12px', width: '420px', zIndex: 99999,
      background: '#fff', border: '2px solid #1a4d8f', borderRadius: '6px', padding: '8px',
      font: '12px Arial, sans-serif', boxShadow: '0 4px 14px rgba(0,0,0,.25)' });
    p.querySelectorAll('button').forEach((b) => Object.assign(b.style,
      { padding: '3px 8px', border: '1px solid #1a4d8f', borderRadius: '3px', background: '#e8f0fb', cursor: 'pointer' }));
    document.body.appendChild(p);
    document.getElementById('tamauto-toggle').style.color = '#fff';

    const $ = (id) => document.getElementById(id);
    $('tamauto-toggle').onclick = () => {
      if (!cfg.enabled && !cfg.dryRun && !confirm('LIVE-Modus: Passende Aufträge werden verbindlich angenommen. Starten?')) return;
      cfg.enabled = !cfg.enabled; GM_setValue('enabled', cfg.enabled);
      log(cfg.enabled ? 'Gestartet' : 'Gestoppt'); renderStatus(); restartTimer();
    };
    $('tamauto-ar').checked = cfg.autoRefresh;
    $('tamauto-ar').onchange = (e) => { cfg.autoRefresh = e.target.checked; GM_setValue('autoRefresh', cfg.autoRefresh); lastRefreshOk = null; startRefreshTimer(); };
    $('tamauto-dry').onchange = (e) => { cfg.dryRun = e.target.checked; GM_setValue('dryRun', cfg.dryRun); renderStatus(); };
    $('tamauto-int').onchange = (e) => {
      cfg.intervalSec = Math.max(15, parseInt(e.target.value, 10) || 30); GM_setValue('intervalSec', cfg.intervalSec); restartTimer(); startRefreshTimer();
    };
    $('tamauto-load').onclick = loadPlacesFromSheet;
    $('tamauto-paste').onclick = () => {
      const ta = $('tamauto-ta');
      if (ta.style.display === 'none') { ta.style.display = 'block'; $('tamauto-paste').textContent = 'Übernehmen'; }
      else { if (ta.value.trim()) loadPlacesFromText(ta.value); ta.style.display = 'none'; $('tamauto-paste').textContent = 'Liste einfügen'; }
    };
    $('tamauto-reset').onclick = () => {
      done = new Set(); seen.clear(); lastSummary = ''; GM_setValue('doneRefs', []); log('Verlauf geleert');
    };
    $('tamauto-diag').onclick = () => {
      log('--- Diagnose ---');
      log(`Aktiver Tab: "${activeTabName()}" → ${onPublishedTab() ? 'OK' : 'NICHT "Veröffentlichte Aufträge" – Script pausiert'}`);
      const grid = visibleGrid();
      if (!grid) { log('Keine Tabelle im aktiven Tab gefunden.', 'err'); return; }
      const all = readOrders(grid);
      log(`${all.length} Zeilen gelesen. ${lastColInfo}`);
      all.forEach((o) => log(`  ${o.nr || '(keine Nr)'} · PLZ ${o.plz || '?'} · Ort "${o.ort || '?'}" → ` +
        `${!o.valid ? 'UNPLAUSIBEL' : done.has(o.nr || o.ref) ? 'bereits bearbeitet' : matches(o) ? 'TREFFER' : 'kein Treffer'}`));
      log(`Ortsliste: PLZ [${places.plz.slice(0, 10).join(', ')}${places.plz.length > 10 ? ', …' : ''}]`);
      log(`Ortsliste: Orte [${places.orte.slice(0, 15).join(', ')}${places.orte.length > 15 ? ', …' : ''}]`);
      log(`Modus: ${cfg.dryRun ? 'TEST' : 'LIVE'}, ${cfg.enabled ? 'läuft' : 'gestoppt'}, bereits bearbeitet: ${done.size}`);
    };
          $('tamauto-once').onclick = async () => {
      if (busy) { log('Script ist gerade beschäftigt – kurz warten.', 'err'); return; }
      if (!onPublishedTab()) { log('Bitte Tab "Veröffentlichte Aufträge" öffnen.', 'err'); return; }
      const grid = visibleGrid();
      const o = grid && readOrders(grid).find((x) => x.valid && x.nr);
      if (!o) { log('Kein Auftrag in der Tabelle.', 'err'); return; }
      if (!confirm(`Auftrag ${o.nr} (${o.plz} ${o.ort}) jetzt VERBINDLICH annehmen – unabhängig von der Ortsliste?`)) return;
      busy = true;
      try {
        log(`TEST-Annahme gestartet: ${o.nr} · ${o.plz} ${o.ort}`);
        const ok = await acceptOrder(o);
        const plus = (o.extra || []).length ? ` + ${o.extra.join(', ')} (0 km)` : '';
        log(ok ? `TEST-Annahme erfolgreich: ${o.nr}${plus}` : `TEST-Annahme fehlgeschlagen: ${o.nr}`, ok ? 'ok' : 'err');
        if (ok) { done.add(o.nr); (o.extra || []).forEach((x) => done.add(x)); GM_setValue('doneRefs', [...done].slice(-2000)); }
      } finally { busy = false; }
    };
    $('tamauto-upd').onclick = () => checkUpdate(true);
    $('tamauto-min').onclick =() => { const b = $('tamauto-body'); b.style.display = b.style.display === 'none' ? '' : 'none'; };

    // verschiebbar
    const head = $('tamauto-head'); let dx, dy;
    head.onmousedown = (e) => {
      dx = e.clientX - p.offsetLeft; dy = e.clientY - p.offsetTop;
      const mv = (ev) => Object.assign(p.style, { left: `${ev.clientX - dx}px`, top: `${ev.clientY - dy}px`, right: 'auto', bottom: 'auto' });
      document.addEventListener('mousemove', mv);
      document.addEventListener('mouseup', () => document.removeEventListener('mousemove', mv), { once: true });
    };
    renderStatus();
  }

  // Sofort prüfen, sobald sich die Tabelle ändert (Auto-Refresh, TAM-Autoaktualisierung, manueller Refresh, Tabwechsel)
  let obsTimer = null;
  function watchGrid() {
    new MutationObserver((muts) => {
      if (busy || !cfg.enabled) return;
      const panel = document.getElementById(cfg.tabPanelId);
      if (!panel) return;
      const relevant = muts.some((m) => m.type === 'childList' && panel.contains(m.target) && m.target.closest &&
        m.target.closest('.x-grid3-body, .x-grid3-scroller'));
      const tabSwitch = muts.some((m) => m.type === 'attributes' && m.target.tagName === 'LI' &&
        m.target.id && m.target.id.endsWith('__' + cfg.tabPanelId));
      if (!relevant && !tabSwitch) return;
      clearTimeout(obsTimer);
      obsTimer = setTimeout(() => cycle(true), 800);
    }).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
  }

  // ------------------------------------------------------------------ Start
  waitFor(() => document.querySelector('.x-viewport'), 30000).then(() => {
    buildPanel();
    watchGrid();
    const age = places.loadedAt ? Date.now() - new Date(places.loadedAt).getTime() : Infinity;
    if (age > 6 * 3600 * 1000) loadPlacesFromSheet(); // Liste max. 6 h alt
    restartTimer();
    startRefreshTimer();
    // Update-Prüfung beim Start (max. alle 6 h) und danach alle 6 h
    if (Date.now() - GM_getValue('lastUpdateCheck', 0) > 6 * 3600 * 1000) checkUpdate();
    setInterval(checkUpdate, 6 * 3600 * 1000);
  });
})();