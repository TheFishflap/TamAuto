// ==UserScript==
// @name         TAM Auto-Annahme (IB Thomée GmbH)
// @namespace    ib-thomee
// @version      1.12.4
// @author       IB Thomée GmbH
// @copyright    2026, IB Thomée GmbH
// @license      Proprietär – alle Rechte vorbehalten, siehe LICENSE
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
// @grant        unsafeWindow
// @connect      thomee-my.sharepoint.com
// @connect      raw.githubusercontent.com
// @run-at       document-idle
// ==/UserScript==

// Copyright (c) 2026 IB Thomée GmbH. Alle Rechte vorbehalten.
// Nutzung nur mit gültigem Lizenzschlüssel der IB Thomée GmbH. Veränderung, Bearbeitung,
// Weitergabe und Vervielfältigung des Codes sind nicht gestattet. Siehe LICENSE.

(function () {
  'use strict';

  // Nur im TAM aktiv werden
  if (!document.querySelector('script[src*="de.tomcom.tam.TAM"]')) return;

  // ------------------------------------------------------------------ Konfiguration
  const DEFAULTS = {
    // Ortsliste (Excel in SharePoint, per Link freigegeben – keine Anmeldung nötig), Blatt "annehmen"
    placesUrl: 'https://thomee-my.sharepoint.com/personal/s_thomee_ib-thomee_de/_layouts/15/download.aspx?share=IQDymsXIGo99RJqOxxCvnsbUAfLN02JN2cvzn0qzlg_G4Uk',
    placesSheet: 'annehmen',
    blockSheet: 'nicht annehmen', // Sperrliste im selben Excel
    placesReloadMin: 30,          // Excel alle 30 min neu laden (Sperrliste zeitnah aktuell)
    intervalSec: 60,          // Auto-Refresh-Intervall (Sekunden), Standard 60
    enabled: false,
    maxPerCycle: 3,           // Sicherheitsbremse
    tabName: 'Veröffentlichte Aufträge',
    tabPanelId: 'AgentVeroeffentlichteAuftraege', // feste ID des Tabs im TAM
    acceptedTabId: 'AgentEigeneAuftraege',        // Tab "Angenommene Aufträge"
    orderWindowTitle: /^auftragskarte/i,          // Fenster nach Doppelklick
    acceptButton: /^annehmen$/i,                  // Button unten in der Auftragskarte
    confirmDialogTitle: /auftragsannahme bestätigen/i,
    confirmButton: /^bestätigen$/i,
  };
  const cfg = Object.assign({}, DEFAULTS, {
    intervalSec: GM_getValue('intervalSecV2', DEFAULTS.intervalSec),
    // eigener Schlüssel seit Wegfall des Testmodus: wer im Testmodus lief, startet nicht ungefragt live
    enabled: GM_getValue('running', DEFAULTS.enabled),
    maxPerCycle: GM_getValue('maxPerCycle', DEFAULTS.maxPerCycle),
    autoRefresh: GM_getValue('autoRefreshV2', false), // Standard aus (neuer Schlüssel ab 1.11: gilt einmal für alle)
    // Protokoll im Bedienfeld ("Console Log"), Standard aus. Neuer Schlüssel ab 1.6.1, damit ein früher
    // eingeschaltetes Log nach dem Update bei allen aus ist.
    consoleLog: GM_getValue('consoleLogV2', false),
    sound: GM_getValue('sound', true),   // Benachrichtigungston bei Annahme / fehlgeschlagener Annahme
    popups: GM_getValue('popups', true), // Desktop-Benachrichtigung (Popup) bei Annahme / fehlgeschlagener Annahme
    volume: GM_getValue('volume', 60),   // Lautstärke des Benachrichtigungstons in %
    delayOn: GM_getValue('delayOnV2', true),       // Verzögerung vor jedem Klickschritt der Annahme – Standard an (ab 1.11)
    delaySec: Math.min(1, Math.max(0.01, GM_getValue('delaySec', 0.17))), // 0,01–1,00 s in 0,01-s-Schritten, Standard 0,17
    delayRandom: GM_getValue('delayRandom', true), // + zufällige Streuung
    delayRandomMs: GM_getValue('delayRandomMsV2', 100), // Streuung 0 … x ms (Standard 100 ms)
    burstOn: true, // Burst-Refresh nach manuellem Refresh immer aktiv (ohne Checkbox)
    hideTips: GM_getValue('hideTips', false), // alle ?-Erklärungen ausblenden
    wakeLock: GM_getValue('wakeLock', /android/i.test(navigator.userAgent)), // Bildschirm anlassen – auf Android standardmäßig an
    burstSec: GM_getValue('burstSecV2', 3), // Dauer des Burst-Refresh in s (1 Refresh pro Sekunde), Standard 3
  });

  let places = GM_getValue('places', { plz: [], orte: [], loadedAt: null, source: '' });
  let done = new Set(GM_getValue('doneRefs', [])); // bereits bearbeitete Aufträge
  let timer = null;
  let lastRefreshOk = null;
  let busy = false;
  let recheck = false; // Tabelle hat sich geändert, während busy war

  function releaseBusy() {
    busy = false;
    if (enterPending) { onEnterPublished(); return; } // Tabwechsel während der Annahme → jetzt aktualisieren
    if (recheck && cfg.enabled) { recheck = false; scheduleCheck(); }
  }
  let lastSummary = '';
  const seen = new Set(); // in dieser Sitzung schon protokollierte Aufträge

  // ------------------------------------------------------------------ Hilfsfunktionen
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const norm = (s) => (s || '').toString().trim().toLowerCase()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .replace(/\s+/g, ' ');
  const visible = (el) => !!el && el.offsetParent !== null && getComputedStyle(el).visibility !== 'hidden';
  const text = (el) => (el ? el.textContent.replace(/\u00a0/g, ' ').trim() : '');

  const isAndroid = /android/i.test(navigator.userAgent);

  // Letzte eigene Aktion des Scripts – für die Diagnose, ob ein TAM-Fehler vom Script ausgelöst wurde
  let lastScriptAction = { at: 0, what: '' };

  // Auf Android wie ein echter Fingertipp: erst touchstart/touchend, danach die Maus-Ereignisse
  // (so erzeugt auch der Browser einen Tipp). Ohne Touch-Unterstützung fällt das stillschweigend weg.
  function fireTouch(el, x, y) {
    try {
      const t = new Touch({ identifier: Date.now(), target: el, clientX: x, clientY: y, pageX: x + scrollX, pageY: y + scrollY,
        screenX: x, screenY: y, radiusX: 1, radiusY: 1, force: 1 });
      el.dispatchEvent(new TouchEvent('touchstart', { bubbles: true, cancelable: true, touches: [t], targetTouches: [t], changedTouches: [t] }));
      el.dispatchEvent(new TouchEvent('touchend', { bubbles: true, cancelable: true, touches: [], targetTouches: [], changedTouches: [t] }));
    } catch (e) { /* kein Touch im Browser */ }
  }

  function fire(el, types = ['mouseover', 'mousedown', 'mouseup', 'click']) {
    lastScriptAction = { at: Date.now(), what: (el.textContent || '').trim().slice(0, 30) || String(el.className).split(' ')[0] || el.tagName };
    const r = el.getBoundingClientRect();
    const x = r.left + r.width / 2, y = r.top + r.height / 2;
    if (isAndroid && types.includes('click')) fireTouch(el, x, y);
    const opts = { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y };
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

  // Protokoll im Bedienfeld ("Console Log", ein-/ausblendbar). level 'debug' = Details wie Verzögerungen.
  // Verlauf für "Log kopieren": deutlich länger als die 200 sichtbaren Zeilen, mit Datum, übersteht ein
  // Neuladen der Seite (wird regelmäßig gespeichert). Die Anzeige im Bedienfeld bleibt auf 200 Zeilen begrenzt.
  const LOG_KEEP = 5000;
  let logHistory = (() => { try { return JSON.parse(sessionStorage.getItem('tamauto.logHistory') || '[]'); } catch (e) { return []; } })();
  const saveLogHistory = () => { try { sessionStorage.setItem('tamauto.logHistory', JSON.stringify(logHistory.slice(-LOG_KEEP))); } catch (e) { /* voll */ } };
  setInterval(saveLogHistory, 15000);
  addEventListener('pagehide', saveLogHistory);

  function log(msg, level = 'info') {
    const line = `${new Date().toLocaleTimeString('de-DE')}  ${msg}`;
    logHistory.push(`${new Date().toLocaleDateString('de-DE')} ${line}${level === 'err' ? '  [Fehler]' : ''}`);
    if (logHistory.length > LOG_KEEP + 500) logHistory = logHistory.slice(-LOG_KEEP);
    const box = document.getElementById('tamauto-log');
    if (box) {
      const d = document.createElement('div');
      d.textContent = line;
      if (level === 'err') d.style.color = '#c62828';
      if (level === 'ok') d.style.color = '#2e7d32';
      if (level === 'debug') d.style.color = '#888';
      box.prepend(d);
      while (box.childNodes.length > 200) box.lastChild.remove();
    }
  }

  function notify(title, body) {
    if (cfg.popups) { try { GM_notification({ title, text: body, timeout: 15000, silent: !cfg.sound }); } catch (e) { /* ignore */ } }
    if (cfg.sound) chime();
  }

  // Sanfter Zwei-Ton-Gong (E5 → A5) mit weichem Ein- und Ausklingen statt hartem Piepton
  // Lautstärke 0–100 % (Schieberegler in "Erweiterte Einstellungen"); 60 % entspricht dem bisherigen Pegel
  function chime() {
    const peak = 0.3 * Math.max(0, Math.min(100, cfg.volume)) / 100;
    if (peak <= 0) return;
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const t0 = ctx.currentTime;
      [[659.25, 0], [880, 0.18]].forEach(([freq, delay]) => {
        const o = ctx.createOscillator(); const g = ctx.createGain();
        o.type = 'sine'; o.frequency.value = freq;
        g.gain.setValueAtTime(0.0001, t0 + delay);
        g.gain.exponentialRampToValueAtTime(peak, t0 + delay + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + delay + 0.9);
        o.connect(g).connect(ctx.destination);
        o.start(t0 + delay); o.stop(t0 + delay + 0.95);
      });
      setTimeout(() => ctx.close(), 1500);
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

  // PLZ aus der Liste: 2–5 Ziffern = Anfang der PLZ ("43" → alle 43xxx, "47877" → genau diese).
  // "43***" wird wie "43" behandelt; 1 Ziffer = von Excel verschluckte führende 0 ("1" → "01").
  function normPlz(v) {
    const s = String(v == null ? '' : v).trim().replace(/\*+$/, '');
    if (!/^\d{1,5}$/.test(s)) return '';
    return s.length === 1 ? '0' + s : s;
  }

  // Je Zeile: steht eine PLZ drin, gilt die PLZ-Regel; nur Zeilen ohne PLZ werden über den Ortsnamen abgeglichen.
  function extractPlaces(rows, source) {
    const plz = new Set(); const orte = new Set();
    const cell = (r, i) => String(r[i] == null ? '' : r[i]).trim();
    // Kopfzeile suchen: erste Zeile, die "ort" oder "plz" enthält
    const hIdx = rows.findIndex((r) => r.some((c) => /^(plz|ort|stadt|gemeinde|postleitzahl)$/i.test(String(c).trim())));
    const header = hIdx >= 0 ? rows[hIdx].map((c) => String(c).trim().toLowerCase()) : [];
    const plzCol = header.findIndex((h) => /^(plz|postleitzahl)$/.test(h));
    const ortCol = header.findIndex((h) => /^(ort|stadt|gemeinde)$/.test(h));
    rows.slice(hIdx + 1).forEach((r) => {
      const cells = r.map((c, i) => cell(r, i));
      const p = plzCol >= 0 ? normPlz(cells[plzCol]) : normPlz(cells.find((c) => /^\d{1,5}\**$/.test(c)));
      if (p.length >= 2) { plz.add(p); return; }
      const ort = ortCol >= 0 ? cells[ortCol] : cells.find((c) => c && !/^\d+$/.test(c));
      if (ort) orte.add(norm(ort));
    });
    return { v: 2, plz: [...plz], orte: [...orte], loadedAt: new Date().toISOString(), source };
  }

  // ---- Excel (.xlsx) lesen: ZIP-Container entpacken, Blatt als Zeilen-Array liefern
  async function unzip(buf) {
    const dv = new DataView(buf); const u8 = new Uint8Array(buf); const files = {};
    let eocd = -1;
    for (let i = buf.byteLength - 22; i >= 0; i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    if (eocd < 0) throw new Error('keine gültige Excel-Datei');
    let p = dv.getUint32(eocd + 16, true);
    for (let n = dv.getUint16(eocd + 10, true); n > 0; n--) {
      const method = dv.getUint16(p + 10, true), size = dv.getUint32(p + 20, true);
      const nameLen = dv.getUint16(p + 28, true), extraLen = dv.getUint16(p + 30, true), commLen = dv.getUint16(p + 32, true);
      const local = dv.getUint32(p + 42, true);
      const name = new TextDecoder().decode(u8.subarray(p + 46, p + 46 + nameLen));
      const start = local + 30 + dv.getUint16(local + 26, true) + dv.getUint16(local + 28, true);
      const data = u8.subarray(start, start + size);
      files[name] = method === 0 ? data : new Uint8Array(await new Response(
        new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer());
      p += 46 + nameLen + extraLen + commLen;
    }
    return files;
  }

  // strict: Blatt muss genau so heißen (sonst null) – wichtig für "nicht annehmen", damit nie
  // versehentlich das Blatt "annehmen" als Sperrliste gelesen wird
  async function readXlsxSheet(buf, sheetName, strict = false) {
    const files = await unzip(buf);
    const xml = (n) => (files[n] ? new DOMParser().parseFromString(new TextDecoder().decode(files[n]), 'application/xml') : null);
    const all = (doc, tag) => (doc ? [...doc.getElementsByTagName(tag)] : []);
    const strings = all(xml('xl/sharedStrings.xml'), 'si').map((si) => all(si, 't').map((t) => t.textContent).join(''));
    const sheets = all(xml('xl/workbook.xml'), 'sheet');
    const sheet = sheets.find((s) => norm(s.getAttribute('name')) === norm(sheetName)) || (strict ? null : sheets[0]);
    if (!sheet) { if (strict) return null; throw new Error('kein Tabellenblatt gefunden'); }
    const rel = all(xml('xl/_rels/workbook.xml.rels'), 'Relationship').find((r) => r.getAttribute('Id') === sheet.getAttribute('r:id'));
    const target = rel ? rel.getAttribute('Target').replace(/^\/?(xl\/)?/, 'xl/') : 'xl/worksheets/sheet1.xml';
    const col = (ref) => [...ref.replace(/\d+/g, '')].reduce((a, ch) => a * 26 + ch.charCodeAt(0) - 64, 0) - 1;
    const rows = all(xml(target), 'row').map((row) => {
      const out = [];
      all(row, 'c').forEach((c) => {
        const t = c.getAttribute('t'); const v = all(c, 'v')[0];
        out[col(c.getAttribute('r'))] = t === 's' ? strings[+v.textContent] || ''
          : t === 'inlineStr' ? all(c, 't').map((x) => x.textContent).join('') : (v ? v.textContent : '');
      });
      return Array.from(out, (x) => x || '');
    });
    return { rows, name: sheet.getAttribute('name') };
  }

  // Lädt beide Listen aus dem Excel: "annehmen" (Ortsliste) und "nicht annehmen" (Sperrliste).
  // manual = per Button → Ergebnis immer sichtbar protokollieren
  function loadPlacesFromSheet(manual = false) {
    log('Lade Ortslisten aus SharePoint …', manual ? 'info' : 'debug');
    return new Promise((resolve) => {
      GM_xmlhttpRequest({
        method: 'GET', url: cfg.placesUrl, responseType: 'arraybuffer', anonymous: true, nocache: true,
        headers: { 'Cache-Control': 'no-cache' },
        onload: async (res) => {
          try {
            if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
            const { rows, name } = await readXlsxSheet(res.response, cfg.placesSheet);
            const p = extractPlaces(rows, `SharePoint, Blatt "${name}"`);
            if (!p.plz.length && !p.orte.length) throw new Error(`Blatt "${name}" enthält keine PLZ/Orte`);
            // Sperrliste aus Blatt "nicht annehmen" (gleiche PLZ-/Ort-Logik); fehlt das Blatt → leer
            const bl = await readXlsxSheet(res.response, cfg.blockSheet, true);
            const b = bl ? extractPlaces(bl.rows, '') : { plz: [], orte: [] };
            p.block = { plz: b.plz, orte: b.orte };
            const changed = JSON.stringify([p.plz, p.orte, p.block]) !== JSON.stringify([places.plz, places.orte, places.block]);
            places = p; GM_setValue('places', places);
            const summary = `Ortsliste "${name}": ${places.plz.length} PLZ, ${places.orte.length} Orte · ` +
              `Sperrliste "${cfg.blockSheet}": ${b.plz.length} PLZ, ${b.orte.length} Orte` + (bl ? '' : ' (Blatt nicht gefunden)');
            if (changed) log(`Ortslisten aktualisiert – ${summary}`, 'ok');
            else log(`Ortslisten unverändert – ${summary}`, manual ? 'ok' : 'debug');
            renderStatus(); renderBlacklist(); resolve(true);
          } catch (e) {
            log(`Ortsliste nicht ladbar (${e.message}). Freigabe-Link prüfen oder Liste manuell einfügen.`, 'err');
            resolve(false);
          }
        },
        onerror: () => { log('Netzwerkfehler beim Laden der Ortsliste.', 'err'); resolve(false); },
      });
    });
  }

  // Zusätzliche Liste ("Liste einfügen"): wird ZUSÄTZLICH zur geladenen Ortsliste angenommen
  // und nach 24 h automatisch gelöscht. Die Excel-Listen bleiben unverändert.
  const EXTRA_TTL = 24 * 3600 * 1000;
  function extraPlaces() {
    const e = GM_getValue('extraPlaces', null);
    if (e && Date.now() - e.at < EXTRA_TTL) return e;
    if (e) GM_setValue('extraPlaces', null); // abgelaufen
    return { plz: [], orte: [], at: 0 };
  }

  function loadPlacesFromText(t) {
    const x = extractPlaces(parseCSV(t), 'manuell');
    if (!x.plz.length && !x.orte.length) {
      GM_setValue('extraPlaces', null);
      log('Zusätzliche Liste geleert.', 'ok');
    } else {
      GM_setValue('extraPlaces', { plz: x.plz, orte: x.orte, at: Date.now() });
      log(`Zusätzliche Liste übernommen: ${x.plz.length} PLZ, ${x.orte.length} Orte – gilt 24 h zusätzlich zur Ortsliste.`, 'ok');
    }
    renderStatus();
  }

  function matches(order) {
    // Treffer, wenn die PLZ mit einem Listeneintrag beginnt ODER der Ort (Listenzeile ohne PLZ) passt –
    // in der geladenen Ortsliste oder in der zusätzlichen 24-h-Liste
    const p = (order.plz || '').trim();
    const ex = extraPlaces();
    return places.plz.some((x) => p.startsWith(x)) || places.orte.includes(norm(order.ort)) ||
      ex.plz.some((x) => p.startsWith(x)) || ex.orte.includes(norm(order.ort)) ||
      acceptlist().plz.includes(p); // Tages-Annahmeliste: nur exakte 5-stellige PLZ
  }

  // ---- Tages-Annahmeliste: heute zusätzlich annehmen, NUR vollständige 5-stellige PLZ (kein ganzes Gebiet)
  function acceptlist() {
    let a = GM_getValue('acceptlist', { date: today(), plz: [] });
    if (a.date !== today()) { a = { date: today(), plz: [] }; GM_setValue('acceptlist', a); }
    return a;
  }
  function renderAcceptlist() {
    const list = document.getElementById('tamauto-al-list');
    if (!list) return;
    const a = acceptlist();
    list.innerHTML = '';
    if (!a.plz.length) list.textContent = 'Keine zusätzlichen PLZ für heute.';
    a.plz.forEach((x) => {
      const chip = chipEl(`${x} ✕`, '#2e7d32', '#e8f5e9');
      chip.title = 'Klicken zum Entfernen';
      chip.style.cursor = 'pointer';
      chip.onclick = () => {
        const cur = acceptlist(); cur.plz = cur.plz.filter((y) => y !== x); GM_setValue('acceptlist', cur);
        log(`Tages-Annahmeliste: PLZ ${x} entfernt.`); renderAcceptlist();
      };
      list.appendChild(chip);
    });
  }

  // ------------------------------------------------------------------ Auftragsbuch
  // Alle vom Script angenommenen Aufträge (inkl. 0-km-Aufträge aus der Umgebung), dauerhaft gespeichert
  const parseEuro = (s) => {
    const t = String(s || '').replace(/[^\d,.-]/g, '');
    if (!t) return null;
    const v = parseFloat(t.replace(/\.(?=\d{3}(\D|$))/g, '').replace(',', '.'));
    return Number.isFinite(v) ? v : null;
  };
  const fmtEuro = (v) => v.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';

  // Tabellenzeilen des letzten Abgleichs nach AuftragsNr – um mit angenommene Warenkorb-Aufträge (PLZ, Ort,
  // Preis) nachschlagen zu können, auch wenn sie nach der Annahme aus der Tabelle verschwunden sind
  let rowsByNr = new Map();
  const rememberRows = (rows) => { rowsByNr = new Map(rows.filter((r) => r.nr).map((r) => [r.nr.toUpperCase(), r])); };

  // Mit dem Hauptauftrag gemeinsam angenommen: alle angehakten Warenkorb-Einträge (Fallback: 0-km-Liste)
  const bulkOf = (o) => o.bulk || o.extra || [];
  const bulkLabel = (o) => bulkOf(o).map((x) => `${x} (${(o.extra || []).includes(x) ? '0 km' : 'Warenkorb'})`).join(', ');

  function recordOrder(o) {
    const book = GM_getValue('orderbook', []);
    const ts = new Date().toISOString();
    book.push({ ts, nr: o.nr, plz: o.plz, ort: o.ort, dienst: o.dienst, preis: parseEuro(o.preis) });
    bulkOf(o).forEach((x) => {
      const row = rowsByNr.get(x);
      const art = (o.extra || []).includes(x) ? '0 km' : 'Warenkorb';
      book.push({ ts, nr: x, plz: row ? row.plz : o.plz, ort: row ? row.ort : o.ort, zu: o.nr,
        dienst: `${art} – zusammen mit ${o.nr} angenommen${row && row.dienst ? ` · ${row.dienst}` : ''}`,
        preis: row ? parseEuro(row.preis) : null });
    });
    GM_setValue('orderbook', book.slice(-5000));
    renderOrderbook();
  }

  // Erfolgreiche Annahme verbuchen: Hauptauftrag + alle mit angenommenen Warenkorb-Einträge
  // (als erledigt merken, ins Auftragsbuch, in der Trefferquote als "angenommen")
  function bookAccepted(o) {
    done.add(o.key || o.nr);
    bulkOf(o).forEach((x) => done.add(x));
    GM_setValue('doneRefs', [...done].slice(-2000));
    recordOrder(o);
    const stats = hitStats();
    bulkOf(o).forEach((x) => {
      const row = rowsByNr.get(x);
      if (stats[x] || (row && matches(row))) trackResult(row || { nr: x, plz: o.plz }, 'angenommen');
    });
  }

  // ---- Trefferquote: jeder veröffentlichte Auftrag mit passender PLZ wird einmal erfasst und bekommt ein Ergebnis
  // Status: passend (noch kein Ergebnis) · angenommen · vergeben (war nicht mehr verfügbar) · fehler · gesperrt
  function hitStats() {
    const m = GM_getValue('hitstats', {});
    const limit = Date.now() - 120 * 864e5; // ältere Einträge (> 120 Tage) verwerfen
    Object.keys(m).forEach((k) => { if (new Date(m[k].ts) < limit) delete m[k]; });
    return m;
  }
  function trackHit(o, status) {
    const key = o.nr || o.key;
    if (!key) return;
    const m = hitStats();
    const e = m[key];
    if (e && !(e.s === 'gesperrt' && status === 'passend')) return; // schon erfasst (nur Sperre → passend darf wechseln)
    m[key] = { ts: e ? e.ts : new Date().toISOString(), plz: o.plz, s: status };
    GM_setValue('hitstats', m);
  }
  function trackResult(o, status) {
    const key = o.nr || o.key;
    const m = hitStats();
    m[key] = Object.assign(m[key] || { ts: new Date().toISOString(), plz: o.plz }, { s: status });
    GM_setValue('hitstats', m);
  }
  const pct = (a, b) => (b ? `${Math.round((a / b) * 100)} %` : '–');

  function renderHitRate(from) {
    const el = document.getElementById('tamauto-ob-rate');
    if (!el) return;
    const rows = Object.values(hitStats()).filter((e) => new Date(e.ts) >= from);
    const c = (s) => rows.filter((e) => e.s === s).length;
    const passend = rows.length - c('gesperrt');           // veröffentlicht, PLZ stimmt (ohne gesperrte)
    const angenommen = c('angenommen');
    const vergeben = c('vergeben');                        // war beim Öffnen schon vergeben
    const verfuegbar = passend - vergeben - c('passend');  // tatsächlich verfügbar = versucht und nicht schon vergeben
    el.innerHTML = `<b>Trefferquote</b> · ${passend} passend (PLZ stimmt) · <b style="color:#2e7d32">${angenommen} angenommen</b> · ` +
      `${vergeben} bereits vergeben · ${c('fehler')} Fehler` + (c('gesperrt') ? ` · ${c('gesperrt')} gesperrt` : '') +
      `<br>Angenommen von passenden: <b>${pct(angenommen, passend)}</b> · von tatsächlich verfügbaren: <b>${pct(angenommen, verfuegbar)}</b>`;
  }

  function renderOrderbook() {
    const tbody = document.getElementById('tamauto-ob-rows');
    if (!tbody) return;
    const range = (document.getElementById('tamauto-ob-range') || {}).value || 'today';
    const from = { today: new Date(new Date().setHours(0, 0, 0, 0)), week: new Date(Date.now() - 7 * 864e5),
      month: new Date(new Date().getFullYear(), new Date().getMonth(), 1), all: new Date(0) }[range];
    const rows = GM_getValue('orderbook', []).filter((e) => new Date(e.ts) >= from).reverse();
    tbody.innerHTML = '';
    rows.forEach((e) => {
      const tr = document.createElement('tr');
      const d = new Date(e.ts);
      [`${d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' })} ${d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })}`,
        e.zu ? `↳ ${e.nr}` : e.nr, e.plz, e.ort, e.preis == null ? '–' : fmtEuro(e.preis)].forEach((v, i) => {
        const td = document.createElement('td');
        td.textContent = v;
        Object.assign(td.style, { padding: '1px 4px', borderBottom: '1px solid #eee', whiteSpace: 'nowrap', textAlign: i === 4 ? 'right' : 'left' });
        tr.appendChild(td);
      });
      tr.title = e.dienst || '';
      tbody.appendChild(tr);
    });
    if (!rows.length) tbody.innerHTML = '<tr><td colspan="5" style="color:#555;padding:4px">Keine angenommenen Aufträge im Zeitraum.</td></tr>';
    // Unten: Anzahl Aufträge, Anzahl PLZ (mit Aufträgen je PLZ), Summe Euro
    const perPlz = {};
    rows.forEach((e) => { perPlz[e.plz] = (perPlz[e.plz] || 0) + 1; });
    const sum = rows.reduce((a, e) => a + (e.preis || 0), 0);
    const noPrice = rows.filter((e) => e.preis == null).length;
    document.getElementById('tamauto-ob-sum').innerHTML =
      `<b>${rows.length} Aufträge</b> · <b>${Object.keys(perPlz).length} PLZ</b> · Summe gesamt <b>${fmtEuro(sum)}</b>` +
      (noPrice ? ` <span style="color:#555">(${noPrice} ohne Preis)</span>` : '');
    document.getElementById('tamauto-ob-plz').textContent = Object.entries(perPlz)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([p, c]) => `${p} (${c})`).join(' · ');
    renderHitRate(from);
  }

  // ------------------------------------------------------------------ Tages-Blacklist
  // PLZ (2–5 Ziffern, Anfang der PLZ), die heute nicht angenommen werden – z. B. nach Storno.
  // Gilt nur bis Mitternacht, danach automatisch leer.
  const today = () => new Date().toLocaleDateString('sv-SE'); // JJJJ-MM-TT, lokale Zeit
  function blacklist() {
    let b = GM_getValue('blacklist', { date: today(), plz: [] });
    if (b.date !== today()) { b = { date: today(), plz: [] }; GM_setValue('blacklist', b); }
    return b;
  }
  // Gesperrt? Liefert den Grund als Text (für das Protokoll) oder ''.
  // Quellen: Tages-Blacklist (manuell, bis Mitternacht) und Excel-Blatt "nicht annehmen" (solange dort eingetragen)
  function blocked(order) {
    const p = (order.plz || '').trim();
    const day = blacklist().plz.find((x) => p.startsWith(x));
    if (day) return `PLZ ${day}${day.length < 5 ? '…' : ''} (Tages-Blacklist)`;
    const xb = places.block || { plz: [], orte: [] };
    const xp = xb.plz.find((x) => p.startsWith(x));
    if (xp) return `PLZ ${xp}${xp.length < 5 ? '…' : ''} (Excel „${cfg.blockSheet}“)`;
    if (xb.orte.includes(norm(order.ort))) return `Ort ${order.ort} (Excel „${cfg.blockSheet}“)`;
    return '';
  }

  function chipEl(label, color, bg) {
    const chip = document.createElement('span');
    chip.textContent = label;
    Object.assign(chip.style, { padding: '2px 6px', background: bg, border: `1px solid ${color}`,
      borderRadius: '10px', color });
    return chip;
  }

  function renderBlacklist() {
    // Excel-Sperrliste (nur Anzeige – ändern im Excel, Blatt "nicht annehmen")
    const xl = document.getElementById('tamauto-bl-excel');
    const xb = places.block || { plz: [], orte: [] };
    if (xl) {
      xl.innerHTML = '';
      const entries = [...xb.plz.map((x) => `${x}${x.length < 5 ? '…' : ''}`), ...xb.orte];
      if (!entries.length) xl.textContent = 'Keine Einträge.';
      entries.forEach((x) => xl.appendChild(chipEl(x, '#6d4c41', '#efebe9')));
    }
    const list = document.getElementById('tamauto-bl-list');
    if (!list) return;
    const b = blacklist();
    list.innerHTML = '';
    if (!b.plz.length) list.textContent = 'Keine PLZ gesperrt.';
    b.plz.forEach((x) => {
      const chip = document.createElement('span');
      chip.textContent = `${x}${x.length < 5 ? '…' : ''} ✕`;
      chip.title = 'Klicken zum Freigeben';
      Object.assign(chip.style, { padding: '2px 6px', background: '#fdecea', border: '1px solid #c62828',
        borderRadius: '10px', color: '#c62828', cursor: 'pointer' });
      chip.onclick = () => {
        const cur = blacklist(); cur.plz = cur.plz.filter((y) => y !== x); GM_setValue('blacklist', cur);
        log(`Blacklist: PLZ ${x} wieder freigegeben.`, 'ok'); renderBlacklist();
      };
      list.appendChild(chip);
    });
    // Anzahl auch am Reiter zeigen, damit eine Sperre nicht übersehen wird
    const n = b.plz.length + xb.plz.length + xb.orte.length;
    const tab = document.querySelector('.tamauto-tabbtn[data-page="tamauto-page-main"]');
    if (tab) tab.textContent = `Bedienung${n ? ` (${n} PLZ gesperrt)` : ''}`;
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

  // Ergebnis der manuellen Prüfung direkt am Button "Softwareupdate" zeigen (Log ist meist ausgeblendet)
  function updateButtonFeedback(text, color) {
    const b = document.getElementById('tamauto-upd');
    if (!b) return;
    clearTimeout(b._reset);
    b.textContent = text; b.style.color = color || '';
    b._reset = setTimeout(() => { b.textContent = 'Softwareupdate'; b.style.color = ''; }, 10000);
  }

  function checkUpdate(manual = false) {
    GM_setValue('lastUpdateCheck', Date.now());
    if (manual) updateButtonFeedback('Prüfe …');
    // GitHub/Repo nicht erreichbar (Netzwerk, Timeout, Repo privat/gelöscht, Datei fehlt)
    const unreachable = (why) => {
      log(`Update-Prüfung: GitHub nicht erreichbar (${why}) – aktueller Stand: v${VERSION}.`, manual ? 'err' : 'debug');
      if (manual) updateButtonFeedback(`✗ GitHub nicht erreichbar – aktueller Stand: v${VERSION}`, '#c62828');
    };
    GM_xmlhttpRequest({
      method: 'GET', url: `${UPDATE_URL}?t=${Date.now()}`, nocache: true, timeout: 10000,
      onload: (res) => {
        const m = res.status === 200 && res.responseText.match(/@version\s+(\S+)/);
        if (!m) { unreachable(res.status === 200 ? 'keine Versionsangabe' : `HTTP ${res.status}`); return; }
        const upd = document.getElementById('tamauto-update');
        if (newerVersion(m[1], VERSION)) {
          log(`Update ${m[1]} verfügbar (installiert: ${VERSION}).`, 'ok');
          if (upd) { upd.textContent = `⬆ Update ${m[1]} verfügbar – installieren`; upd.style.display = 'block'; }
          if (manual) updateButtonFeedback(`⬆ Update ${m[1]} verfügbar`, '#1a4d8f');
        } else if (manual) {
          log(`Kein Update – ${VERSION} ist aktuell.`, 'ok');
          updateButtonFeedback(`✓ Alles auf dem neuesten Stand (v${VERSION})`, '#2e7d32');
        }
      },
      onerror: () => unreachable('keine Verbindung'),
      ontimeout: () => unreachable('Zeitüberschreitung'),
    });
  }

  // ------------------------------------------------------------------ TAM-Oberfläche (GXT 2)
  // Ist der aktive Tab wirklich "Veröffentlichte Aufträge"?
  function onPublishedTab() {
    // Reiter des Tabs direkt über seine ID suchen (…__AgentVeroeffentlichteAuftraege)
    const li = document.querySelector(`li[id$="__${cfg.tabPanelId}"]`);
    const panel = document.getElementById(cfg.tabPanelId);
    return !!li && li.classList.contains('x-tab-strip-active') &&
      !!panel && !panel.closest('.x-hide-display');
  }

  // Tab-Status im Bedienfeld: welcher Reiter ist aktiv, ist das Script bereit zum Annehmen?
  let lastTabState = '';
  function updateTabStatus() {
    renderHeadState();
    const el = document.getElementById('tamauto-tab');
    if (!el) return;
    const active = [...document.querySelectorAll('li.x-tab-strip-active[id*="__"]')].filter(visible);
    const onAccepted = active.some((li) => li.id.endsWith('__' + cfg.acceptedTabId));
    const other = text((active[0] || {}).querySelector?.('.x-tab-strip-text')).replace(/^\[.*?\]\s*/, '');
    let state, color;
    if (onPublishedTab()) {
      [state, color] = cfg.enabled ? ['Veröffentlichte Aufträge – ✔ bereit zum Annehmen', '#2e7d32']
        : ['Veröffentlichte Aufträge – gestoppt', '#555'];
    } else if (onAccepted) {
      [state, color] = ['Angenommene Aufträge – ⏸ Annahme pausiert', '#b26a00'];
    } else {
      [state, color] = [`${other || 'anderer Reiter'} – ⏸ Annahme pausiert`, '#b26a00'];
    }
    el.textContent = `Tab: ${state}`;
    el.style.color = color;
    if (state !== lastTabState) { if (lastTabState) log(`Tab: ${state}`); lastTabState = state; }
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
    lastScriptAction.what = 'Refresh-Pfeil';
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
    if (ok) lastAnyRefreshAt = Date.now();
    const stamp = new Date().toLocaleTimeString('de-DE');
    setRefreshStatus(ok ? `Letzter Refresh: ${stamp} ✓ (Auto-Refresh)` : `Letzter Refresh: ${stamp} ✗ keine Wirkung`);
    if (ok !== lastRefreshOk) {
      log(ok ? 'Refresh funktioniert – Tabelle wurde neu geladen.' :
        'Refresh-Klick ohne Wirkung (Tabelle nicht neu geladen). Bitte melden.', ok ? 'ok' : 'err');
      lastRefreshOk = ok;
    }
    await sleep(300);
    return ok;
  }

  function setRefreshStatus(t) { const el = document.getElementById('tamauto-refresh'); if (el) el.textContent = t; }

  // Refresh von außen (Klick auf den Refresh-Pfeil der Website oder TAM-Autoaktualisierung) anzeigen
  let ownRefresh = false;   // true, solange das Script selbst refresht
  let manualClickAt = 0;    // Zeitpunkt des letzten echten Klicks auf den Refresh-Pfeil
  let refreshNoteTimer = null;

  // ---- TAM-Takt (Ist-Werte statt Schätzung)
  // 1) Mitlesen: TAM schreibt nach jedem Laden "scheduling autorefreshing timer in X seconds" in die Konsole →
  //    daraus ergibt sich der nächste TAM-Refresh auf die Sekunde.
  // 2) Rückfall: Einstellung aus der Blätterleiste ("☑ Automatisch alle [2] Minuten aktualisieren");
  //    TAM startet seinen Timer nach jedem Laden neu → nächster TAM-Refresh = letzter Refresh + Intervall.
  let lastAnyRefreshAt = 0;   // letzter Refresh gleich welcher Quelle (Script, TAM, manuell)
  let lastTamRefreshAt = 0;   // letzte TAM-Aktualisierung
  let tamNextAt = 0;          // nächster TAM-Refresh laut TAM-Meldung (0 = unbekannt)
  let tamNextSeenAt = 0;      // wann die Meldung kam
  function noteTamRefresh(now) { lastTamRefreshAt = now; }

  // TAM-Konsolenmeldungen mitlesen (Seite und gleiche-Herkunft-iframes, da GWT oft in einem iframe läuft)
  const TAM_TIMER_RE = /autorefresh\w*\s+timer\s+in\s+([\d.,]+)\s*s/i;
  function hookConsole(win) {
    try {
      const c = win && win.console;
      if (!c || c.__tamautoHooked) return;
      ['log', 'info', 'debug', 'warn'].forEach((m) => {
        const orig = c[m];
        if (typeof orig !== 'function') return;
        c[m] = function (...args) {
          try {
            const mt = args.map(String).join(' ').match(TAM_TIMER_RE);
            if (mt) {
              const sec = parseFloat(mt[1].replace(',', '.'));
              if (sec >= 0 && sec < 3600) { tamNextSeenAt = Date.now(); tamNextAt = tamNextSeenAt + sec * 1000; }
              return undefined; // nur mitlesen – TAM-Meldung nicht mehr in der Browser-Konsole ausgeben
            }
          } catch (e) { /* ignore */ }
          return orig.apply(this, args);
        };
      });
      c.__tamautoHooked = true;
    } catch (e) { /* fremde Herkunft – nicht lesbar */ }
  }
  function hookAllConsoles() {
    hookConsole(typeof unsafeWindow !== 'undefined' ? unsafeWindow : window);
    document.querySelectorAll('iframe').forEach((f) => { try { hookConsole(f.contentWindow); } catch (e) { /* ignore */ } });
  }
  hookAllConsoles();

  // Einstellung aus der Blätterleiste: Checkbox + Minutenfeld direkt dahinter (IDs sind dynamisch → über Position)
  function tamSetting() {
    const tb = [...document.querySelectorAll('.x-toolbar')].filter(visible).find((t) => /minuten aktualisieren/i.test(text(t)));
    if (!tb) return null;
    const inputs = [...tb.querySelectorAll('input')];
    const cb = inputs.find((i) => i.type === 'checkbox');
    if (!cb) return null;
    const min = inputs.slice(inputs.indexOf(cb) + 1).find((i) => i.type === 'text' && /^\d+([.,]\d+)?$/.test(i.value.trim()));
    const minutes = min ? parseFloat(min.value.replace(',', '.')) : 1;
    return { enabled: cb.checked, periodMs: Math.max(0.1, minutes) * 60000 };
  }

  // Nächster TAM-Refresh: Meldung (Ist-Wert) hat Vorrang, sonst letzter Refresh + eingestelltes Intervall
  function tamNext() {
    const s = tamSetting();
    if (s && !s.enabled) return { at: 0, enabled: false, periodMs: s.periodMs, src: 'aus' };
    if (tamNextAt && tamNextSeenAt >= lastAnyRefreshAt - 3000) return { at: tamNextAt, enabled: true, periodMs: s ? s.periodMs : 0, src: 'laut TAM' };
    const periodMs = s ? s.periodMs : 60000;
    return { at: lastAnyRefreshAt ? lastAnyRefreshAt + periodMs : 0, enabled: true, periodMs, src: 'berechnet' };
  }

  function noteExternalRefresh() {
    const src = Date.now() - manualClickAt < 15000 ? 'manuell' : 'TAM';
    clearTimeout(refreshNoteTimer); // eine Aktualisierung erzeugt viele DOM-Änderungen → einmal melden
    refreshNoteTimer = setTimeout(() => {
      const now = Date.now();
      lastAnyRefreshAt = now;
      if (src === 'TAM') noteTamRefresh(now);
      setRefreshStatus(`Letzter Refresh: ${new Date().toLocaleTimeString('de-DE')} ✓ (${src})`);
      if (!cfg.enabled) log(`Refresh (${src}) – Tabelle neu geladen; Script gestoppt, kein Abgleich.`);
    }, 500);
    return src;
  }
  document.addEventListener('click', (e) => {
    if (!e.isTrusted) return; // nur echte Klicks, nicht die des Scripts
    const panel = activeTabPanel();
    const btn = panel && findRefreshButton(panel);
    if (btn && btn.contains(e.target)) { manualClickAt = Date.now(); startBurst('manueller Refresh'); }
  }, true);


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

  // TAM-Meldungsfenster (Titel + "OK"), z. B. "Auftrag bereits vergeben!" – blockieren sonst die Oberfläche
  const MSG_TITLE = /bereits vergeben|nicht mehr verfügbar|nicht verfügbar|fehler|hinweis|achtung|information/i;

  // "Auftrag nicht (mehr) verfügbar" / "bereits vergeben": SOFORT wegklicken, ohne Verzögerung – auch wenn sie
  // nach einer (erfolgreichen) Annahme oder unabhängig vom Script auftauchen. Die Meldung wird gemerkt, damit die
  // Annahme-Logik sie trotzdem auswerten kann (Trefferquote, Log).
  const UNAVAILABLE = /nicht (mehr )?verfügbar|bereits vergeben/i;
  let lastUnavailable = { at: 0, text: '' };
  // Neben TAM-Fenstern (.x-window) auch Info-Einblendungen, Tooltips und Dialoge prüfen – TAM zeigt Hinweise
  // teils als kurze Einblendung, die sonst erst nach Sekunden von selbst verschwindet.
  const MSG_SELECTOR = '.x-window, .x-window-dlg, .x-info, .x-tip, .x-form-invalid-tip, [role="dialog"], [role="alertdialog"]';
  const msgTries = new WeakMap(); // wie oft schon versucht (für Ausweich-Wege)
  function dismissUnavailable() {
    [...document.querySelectorAll(MSG_SELECTOR)].filter((w) => visible(w) && !w.closest('#tamauto')).forEach((w) => {
      if (w.parentElement && w.parentElement.closest(MSG_SELECTOR)) return; // nur das äußerste Element
      const t = winTitle(w);
      if (cfg.orderWindowTitle.test(t) || cfg.confirmDialogTitle.test(t)) return;
      const all = text(w);
      if (!UNAVAILABLE.test(`${t} ${all}`)) return;
      const tries = (msgTries.get(w) || 0) + 1;
      msgTries.set(w, tries);
      if (tries === 1) {
        const body = text(w.querySelector('.x-window-body, .ext-mb-text, .x-info-body')) || all.replace(t, '');
        lastUnavailable = { at: Date.now(), text: `${t ? `„${t}“ – ` : ''}${body.replace(/(OK|Abbrechen|Schließen)\s*$/i, '').trim()}`.slice(0, 160) };
        log(`TAM-Meldung sofort geschlossen: ${lastUnavailable.text} · Aufbau: ${String(w.className).trim().slice(0, 60) || w.tagName}`, 'debug');
      }
      // Erst regulär schließen (Button bzw. Schließen-Symbol); reagiert die Meldung nicht oder hat keinen
      // Button (Info-Einblendung), wird sie sofort bzw. beim nächsten Durchlauf direkt ausgeblendet
      const btn = findButton(/^(ok|schließen|abbrechen)$/i, w) || [...w.querySelectorAll('button')].find(visible);
      const x = w.querySelector('.x-tool-close');
      if (tries === 1 && btn) clickBtn(btn);
      else if (tries === 1 && x && visible(x)) fire(x);
      else {
        w.style.display = 'none'; // letzter Ausweg: Meldung und ggf. graue Sperrfläche ausblenden
        document.querySelectorAll('.ext-el-mask, .x-modal-mask').forEach((m) => { if (visible(m) && !m.closest('#tamauto')) m.style.display = 'none'; });
        if (tries > 1) log(`TAM-Meldung reagierte nicht auf Klick – ausgeblendet (Aufbau: ${String(w.className).slice(0, 60)}).`, 'debug');
      }
    });
  }
  function dismissMessage(win) {
    if (!win || !visible(win)) return;
    const ok = findButton(/^(ok|schließen)$/i, win);
    if (ok) clickBtn(ok); else closeWindow(win);
  }
  // Fenster zur Terminvergabe, das TAM nach einer Annahme öffnet: sofort (ohne Verzögerung) wegklicken und
  // zurück in "Veröffentlichte Aufträge". Nur in den ersten 30 s nach einer Annahme durch das Script –
  // öffnet man die Terminvergabe selbst, bleibt sie unangetastet.
  let lastAcceptAt = 0;
  function dismissTerminDialog() {
    if (Date.now() - lastAcceptAt > 30000) return;
    const wins = visibleWindows().filter((w) => {
      const t = winTitle(w);
      if (cfg.orderWindowTitle.test(t) || cfg.confirmDialogTitle.test(t)) return false;
      return /termin/i.test(t) || (/termin/i.test(text(w)) && w.querySelector('input[type=checkbox]'));
    });
    wins.forEach((w) => {
      // bevorzugt schließen/abbrechen – nichts bestätigen
      const x = w.querySelector('.x-tool-close');
      const btn = findButton(/^(abbrechen|schließen|später|nein)$/i, w) || findButton(/^(ok|weiter)$/i, w);
      if (x && visible(x)) fire(x); else if (btn) clickBtn(btn);
      log(`Fenster „${winTitle(w) || 'Terminvergabe'}“ weggeklickt.`, 'debug');
    });
    if (wins.length && !onPublishedTab()) setTimeout(() => switchToPublishedTab(), 200);
  }

  // Technische TAM-Fehlerfenster ("Fehler!" mit JavaScript-Fehler wie "TypeError … undefined", tritt v. a. auf
  // Android auf) automatisch mit "Abbrechen" schließen. Im Log steht, was das Script zuletzt getan hat – so ist
  // erkennbar, ob der Fehler vom Script ausgelöst wurde oder von TAM allein kommt.
  const TAM_JS_ERROR = /TypeError|ReferenceError|RangeError|is undefined|is null|is not a function|can't access|cannot read/i;
  let tamErrorCount = 0;
  function dismissTamErrors() {
    visibleWindows().filter((w) => /fehler/i.test(winTitle(w)) && TAM_JS_ERROR.test(text(w))).forEach((w) => {
      const msg = text(w).replace(winTitle(w), '').replace(/abbrechen|ok/gi, '').trim().slice(0, 100);
      const ago = lastScriptAction.at ? ((Date.now() - lastScriptAction.at) / 1000).toFixed(1) : null;
      tamErrorCount++;
      log(`TAM-Fehlerfenster geschlossen (#${tamErrorCount}): ${msg} · letzte Script-Aktion: ` +
        (ago === null ? 'keine' : `„${lastScriptAction.what}“ vor ${ago} s`) + (isAndroid ? ' · Android' : ''), 'err');
      const btn = findButton(/^(abbrechen|ok|schließen)$/i, w);
      if (btn) clickBtn(btn); else closeWindow(w);
      lastScriptAction = { at: 0, what: '' }; // das Schließen selbst nicht als Auslöser werten
    });
  }

  // Alle offenen Meldungen mit OK-Button schließen (nicht Auftragskarte / Bestätigungsdialog)
  function dismissMessages() {
    visibleWindows().filter((w) => MSG_TITLE.test(winTitle(w)) && !cfg.orderWindowTitle.test(winTitle(w)) &&
      !cfg.confirmDialogTitle.test(winTitle(w)) && findButton(/^ok$/i, w)).forEach((w) => {
      log(`TAM-Meldung „${winTitle(w)}“ geschlossen.`, 'debug');
      dismissMessage(w);
    });
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

  // Verzögerung vor jedem Klickschritt der Annahme (Erweiterte Einstellungen):
  // eingestellte Sekunden (0,01–1,00) + optional Randomizer (zufällig 0 … x ms), bei jedem Schritt neu gewürfelt.
  async function humanDelay(step) {
    if (!cfg.delayOn) return;
    const spread = cfg.delayRandom ? Math.random() * cfg.delayRandomMs / 1000 : 0;
    const s = cfg.delaySec + spread;
    if (s <= 0) return;
    log(`Verzögerung vor: ${step}`, 'debug');
    await sleep(s * 1000);
  }

  async function acceptOrder(order) {
    if (!onPublishedTab()) { log('Abbruch: nicht im Tab "Veröffentlichte Aufträge".', 'err'); return false; }
    const nr = (order.nr || '').trim();
    if (!/^(MW)?\d{6,}$/i.test(nr)) { log(`Keine gültige AuftragsNr in der Zeile (${nr || 'leer'}).`, 'err'); return false; }

    // 1) Doppelklick -> "Auftragskarte zu MW…"
    const before = new Set(visibleWindows());
    // sichtbare Zelle anklicken (die ersten Zellen sind im TAM ausgeblendete Spalten)
    const cell = [...order.row.querySelectorAll('td.x-grid3-cell')].find(visible) || order.row;
    await humanDelay('Doppelklick auf Auftrag');
    if (!order.row.isConnected) { log(`Abbruch: Zeile ${nr} während der Verzögerung verschwunden.`, 'err'); return false; }
    fire(cell, ['mousedown', 'mouseup', 'click']);
    await sleep(200);
    const clickedAt = Date.now();
    fire(cell, ['mousedown', 'mouseup', 'click', 'dblclick']);
    // Warten auf die Auftragskarte – oder auf eine TAM-Meldung statt der Karte
    // (z. B. "Auftrag bereits vergeben!": ein anderer Anbieter war schneller). Die Meldung wird ggf. schon vom
    // Sofort-Wächter geschlossen → dann über lastUnavailable erkennen.
    const opened = await waitFor(() => visibleWindows().find((w) => !before.has(w) &&
      (cfg.orderWindowTitle.test(winTitle(w)) || MSG_TITLE.test(winTitle(w)))) ||
      (lastUnavailable.at >= clickedAt ? 'unavailable' : null), 8000);
    if (opened === 'unavailable') {
      log(`${nr}: TAM meldet – ${lastUnavailable.text}`, 'err');
      order.failReason = 'vergeben';
      return false;
    }
    if (opened && !cfg.orderWindowTitle.test(winTitle(opened))) {
      const msg = text(opened.querySelector('.x-window-body, .ext-mb-text') || opened).replace(winTitle(opened), '').trim();
      log(`${nr}: TAM meldet „${winTitle(opened)}“${msg ? ` – ${msg.slice(0, 120)}` : ''}`, 'err');
      if (/bereits vergeben|nicht mehr verfügbar/i.test(`${winTitle(opened)} ${msg}`)) order.failReason = 'vergeben';
      dismissMessage(opened);
      return false;
    }
    const card = opened;
    if (!card) { log(`Auftragskarte für ${nr} öffnete sich nicht.`, 'err'); dismissMessages(); return false; }

    // Sicherheitscheck: richtige Auftragskarte?
    if (!winTitle(card).includes(nr)) {
      log(`Falsche Auftragskarte ("${winTitle(card)}") – erwartet ${nr}. Abbruch.`, 'err');
      closeWindow(card); return false;
    }
    await sleep(1000);

    // 2) Erst "Aufträge in der Umgebung" mit 0 km je 1× anklicken (landen im Warenkorb) …
    const extra = [];
    for (const item of nearbyItems(card).filter((n) => n.kmNum === 0 && n.nr && n.nr !== nr.toUpperCase())) {
      await humanDelay(`0-km-Auftrag ${item.nr}`);
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
    await humanDelay('Warenkorb – alle auswählen');
    await setChecked(selectAll, true);
    const items = warenkorbItems(card);
    const unchecked = items.filter((w) => !w.cb.checked).map((w) => w.nr);
    if (!items.some((w) => w.nr === nr.toUpperCase())) { log(`${nr} nicht im Warenkorb.`, 'err'); closeWindow(card); return false; }
    if (unchecked.length) { log(`Nicht angehakt trotz "alle auswählen": ${unchecked.join(', ')}`, 'err'); closeWindow(card); return false; }
    // Alles, was jetzt im Warenkorb angehakt ist, wird mit "Annehmen" GEMEINSAM angenommen (Bulk) – nicht nur
    // die selbst angeklickten 0-km-Aufträge, sondern auch Einträge, die schon vorher im Warenkorb lagen.
    const nrOf = (s) => ((String(s).match(/(MW)?\d{6,}/i) || [s])[0]).toUpperCase();
    order.bulk = [...new Set(items.filter((w) => w.cb.checked).map((w) => nrOf(w.nr)))].filter((x) => x !== nr.toUpperCase());

    // 3) "Annehmen" unten in der Auftragskarte
    const acceptBtn = findButton(cfg.acceptButton, card);
    if (!acceptBtn) { log('Button "Annehmen" nicht gefunden.', 'err'); closeWindow(card); return false; }
    await humanDelay('Annehmen');
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
    if (termsCb) await humanDelay('Haken „Bedingungen bestätigen“');
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
    await humanDelay('Bestätigen');
    clickBtn(okBtn);
    lastAcceptAt = Date.now(); // ab jetzt darf ein Terminvergabe-Fenster sofort weggeklickt werden
    // auf TAMs Reaktion warten (Meldung, Terminvergabe, Karte zu oder Reiterwechsel) – höchstens 2,5 s statt starr
    await sleep(300);
    await waitFor(() => !visible(card) || !onPublishedTab() ||
      visibleWindows().some((w) => w !== card && w !== dlg && !before.has(w)), 2200, 100);
    await sleep(200);

    // 5) Fehlermeldung erkennen
    const errWin = visibleWindows().find((w) => w !== card && !before.has(w) &&
      /fehler|error|nicht möglich|bereits|vergeben/i.test(text(w)));
    if (errWin) {
      log(`TAM meldet: ${text(errWin).slice(0, 160)}`, 'err');
      if (/bereits|vergeben|nicht mehr verfügbar/i.test(text(errWin))) order.failReason = 'vergeben';
      closeWindow(errWin); await sleep(300); closeWindow(card);
      return false;
    }
    // Vom Sofort-Wächter bereits geschlossene Meldung nach "Bestätigen":
    // "bereits vergeben" = nicht angenommen; "nicht verfügbar" kommt teils trotz erfolgreicher Annahme → nur vermerken
    if (lastUnavailable.at >= lastAcceptAt) {
      if (/bereits vergeben/i.test(lastUnavailable.text)) {
        log(`TAM meldet: ${lastUnavailable.text}`, 'err');
        order.failReason = 'vergeben'; closeWindow(card);
        return false;
      }
      log(`${nr}: TAM meldete nach der Annahme „nicht verfügbar“ – Meldung geschlossen, Annahme gilt als erfolgt.`, 'debug');
    }
    // Hinweis-/Erfolgsfenster wegklicken, Auftragskarte schließen
    visibleWindows().filter((w) => w !== card && !before.has(w)).forEach((w) => {
      const b = findButton(/^(ok|schließen)$/i, w); if (b) clickBtn(b);
    });
    await sleep(300);
    closeWindow(card);
    await sleep(500);
    order.auftragsNr = nr;
    // Terminvergabe-Fenster (falls schon offen) wegklicken; TAM springt ggf. in einen anderen Reiter → sofort zurück
    dismissTerminDialog();
    await switchToPublishedTab();
    return true;
  }

  // Wechselt in den Reiter "Veröffentlichte Aufträge" (falls nicht schon aktiv)
  async function switchToPublishedTab() {
    if (onPublishedTab()) return true;
    const li = document.querySelector(`li[id$="__${cfg.tabPanelId}"]`);
    if (!li) { log(`Reiter "${cfg.tabName}" nicht gefunden.`, 'err'); return false; }
    fire(li.querySelector('.x-tab-strip-text') || li, ['mouseover', 'mousedown', 'mouseup', 'click']);
    const ok = await waitFor(onPublishedTab, 3000);
    log(ok ? `Zurück im Reiter "${cfg.tabName}".` : `Wechsel in den Reiter "${cfg.tabName}" fehlgeschlagen.`, ok ? 'info' : 'err');
    return !!ok;
  }

  // ------------------------------------------------------------------ Hauptzyklus
  // reason: Anlass für das Protokoll (Refresh, Tabelle aktualisiert, Reiterwechsel, Start …)
  async function cycle(reason = 'Prüfung') {
    if (!cfg.enabled) return;
    if (busy) { recheck = true; return; } // läuft gerade etwas → danach erneut prüfen
    busy = true;
    recheck = false; // Tabelle wird jetzt frisch gelesen
    lastCycleAt = Date.now();
    try {
      if (!places.plz.length && !places.orte.length) { log('Keine Ortsliste geladen – übersprungen.', 'err'); return; }
      if (!onPublishedTab()) {
        setStatus(`Pausiert – Tab "${cfg.tabName}" ist nicht aktiv`); updateTabStatus(); return;
      }
      const grid = visibleGrid();
      if (!grid) { log('Keine Auftragstabelle im Tab "Veröffentlichte Aufträge" gefunden.', 'err'); return; }
      const all = readOrders(grid).map((o) => Object.assign(o, { key: o.nr || o.ref }));
      rememberRows(all);
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
      // Gesperrte (Tages-Blacklist) nicht annehmen, aber auch nicht als erledigt merken → morgen wieder möglich
      const hits = orders.filter((o) => matches(o) && !blocked(o));
      const blockedHits = orders.filter((o) => matches(o) && blocked(o));
      hits.forEach((o) => trackHit(o, 'passend'));        // Trefferquote: jeder passende Auftrag einmal
      blockedHits.forEach((o) => trackHit(o, 'gesperrt'));
      setStatus(`${new Date().toLocaleTimeString('de-DE')}: ${all.length} in Tabelle · ${orders.length} offen · ` +
        `${hits.length} passend · ${blockedHits.length} gesperrt · ${old.length} bereits bearbeitet`);

      // Protokoll: jeder Abgleich eine Zeile, jeden Auftrag einmalig mit Entscheidung
      log(`${reason} → Abgleich: ${all.length} Aufträge in Tabelle, ${orders.length} offen, ${hits.length} passend, ` +
        (blockedHits.length ? `${blockedHits.length} gesperrt, ` : '') +
        `${old.length} bereits bearbeitet` + (noKey.length ? `, ${noKey.length} ohne AuftragsNr` : ''), hits.length ? 'ok' : 'info');
      if (noKey.length && lastSummary !== 'NOKEY') log(lastColInfo, 'err');
      lastSummary = noKey.length ? 'NOKEY' : '';
      orders.forEach((o) => {
        const bl = matches(o) && blocked(o);
        const key = bl ? `${o.key}|bl` : o.key; // Sperre separat protokollieren (z. B. nach Entsperren erneut)
        if (seen.has(key)) return;
        seen.add(key);
        const why = bl ? `Treffer, aber gesperrt: ${bl} → nicht angenommen`
          : matches(o) ? 'TREFFER → wird angenommen'
            : `kein Treffer (PLZ ${o.plz || '?'} und Ort "${o.ort || '?'}" nicht in Ortsliste)`;
        log(`${o.key} · ${o.plz} ${o.ort} · ${o.dienst.slice(0, 40)} → ${why}`, bl ? 'err' : matches(o) ? 'ok' : 'info');
      });
      let n = 0;
      for (const o of hits) {
        if (n >= cfg.maxPerCycle) { log(`Limit ${cfg.maxPerCycle}/Zyklus erreicht.`); break; }
        const desc = `${o.nr || o.ref} · ${o.plz} ${o.ort} · ${o.dienst}${o.preis ? ' · ' + o.preis : ''}`;
        // Schon mit einem anderen Auftrag im Warenkorb (Bulk) angenommen → nicht erneut versuchen
        if (done.has(o.key) || done.has((o.nr || '').toUpperCase())) { log(`${o.key}: bereits zusammen mit einem anderen Auftrag angenommen.`, 'ok'); continue; }
        // Vor jeder Annahme erneut prüfen: richtiger Tab, Zeile noch in dieser Tabelle
        if (!onPublishedTab() || visibleGrid() !== grid || !grid.contains(o.row)) {
          log('Abbruch: Tab gewechselt oder Tabelle neu geladen – keine Annahme.', 'err'); recheck = true; break;
        }
        log(`Nehme an: ${desc}`);
        const ok = await acceptOrder(o);
        trackResult(o, ok ? 'angenommen' : o.failReason === 'vergeben' ? 'vergeben' : 'fehler');
        if (ok) {
          const plus = bulkOf(o).length ? ` + ${bulkLabel(o)}` : '';
          log(`Angenommen: ${desc}${plus}`, 'ok'); notify('TAM: Auftrag angenommen', desc + plus);
          bookAccepted(o); n++;
        } else {
          log(`Annahme fehlgeschlagen: ${desc}`, 'err');
          notify('TAM: Annahme fehlgeschlagen', desc); done.add(o.key); // nicht endlos erneut versuchen
        }
        await sleep(1500);
      }
      GM_setValue('doneRefs', [...done].slice(-2000));
    } catch (e) {
      log(`Fehler: ${e.message}`, 'err');
    } finally { releaseBusy(); }
  }

  // ---- Takt: läuft jede Sekunde, entscheidet aber anhand der TAM-Zeitbasis, ob ein eigener Refresh nötig ist
  let lastHousekeepAt = 0;
  let lastCycleAt = 0;
  const arActive = () => cfg.autoRefresh && cfg.intervalSec <= 60;

  // Muss das Script jetzt selbst refreshen? Nein, wenn seit dem letzten Refresh (egal welcher Quelle) noch
  // kein Intervall vergangen ist oder die nächste TAM-Aktualisierung unmittelbar bevorsteht.
  function ownRefreshDue(now) {
    const iv = cfg.intervalSec * 1000;
    if (now - lastAnyRefreshAt < iv - 700) return false; // Toleranz für den Sekundentakt
    const t = tamNext();
    if (t.enabled && t.at) {
      const untilTam = t.at - now;                               // < 0 = TAM ist überfällig
      const margin = Math.min(5000, iv / 3);
      if (untilTam > -10000 && untilTam < margin) return false;  // TAM lädt gleich selbst (bis 10 s Verspätung abwarten)
    }
    return true;
  }

  const fmtDur = (ms) => { const s = Math.max(0, Math.round(ms / 1000)); return s >= 60 ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')} min` : `${s} s`; };
  // Kompakter Überblick im minimierten Zustand: Status groß, nächster Refresh, letzter Auftrag, Trefferquote heute
  function renderMini(now) {
    const box = document.getElementById('tamauto-mini');
    if (!box || box.style.display === 'none') return;
    const [st, col] = !cfg.enabled ? ['■ GESTOPPT', '#c62828'] : onPublishedTab() ? ['● AKTIV', '#2e7d32'] : ['⏸ PAUSIERT', '#b26a00'];
    const s = document.getElementById('tamauto-mini-state'); s.textContent = st; s.style.color = col;
    // nächster Refresh: laufender Burst, sonst der frühere von eigenem Auto-Refresh und TAM-Aktualisierung
    const t = tamNext();
    let next = !t.enabled ? 'TAM-Aktualisierung aus' : 'nach der nächsten TAM-Aktualisierung';
    if (burstUntil > now) next = `⚡ Burst läuft – noch ${fmtDur(burstUntil - now)}`;
    else {
      const cands = [];
      if (t.enabled && t.at) cands.push(['TAM', t.at - now]);
      if (arActive()) cands.push(['Auto-Refresh', lastAnyRefreshAt + cfg.intervalSec * 1000 - now]);
      if (cands.length) { const [w, ms] = cands.sort((a, b) => a[1] - b[1])[0]; next = `in ${fmtDur(ms)} (${w})`; }
    }
    document.getElementById('tamauto-mini-next').textContent = next;
    const book = GM_getValue('orderbook', []);
    const last = [...book].reverse().find((e) => !e.zu) || book[book.length - 1];
    document.getElementById('tamauto-mini-last').textContent = last
      ? `${last.nr} · ${last.plz} ${last.ort} · ${new Date(last.ts).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}`
      : 'noch keiner';
    const from = new Date(new Date().setHours(0, 0, 0, 0));
    const rows = Object.values(hitStats()).filter((e) => new Date(e.ts) >= from && e.s !== 'gesperrt');
    const ang = rows.filter((e) => e.s === 'angenommen').length;
    document.getElementById('tamauto-mini-rate').textContent = rows.length ? `${ang} von ${rows.length} passenden (${pct(ang, rows.length)})` : 'heute noch keine passenden';
  }

  function renderSync(now) {
    renderMini(now);
    const el = document.getElementById('tamauto-sync');
    if (!el) return;
    const t = tamNext();
    if (!t.enabled) { el.textContent = 'TAM-Aktualisierung ist aus (Checkbox „Automatisch alle … Minuten“)'; return; }
    const per = t.periodMs ? ` (alle ${fmtDur(t.periodMs)})` : '';
    let txt = t.at ? `Nächste TAM-Aktualisierung in ${fmtDur(t.at - now)}${per} – ${t.src}` : `TAM-Aktualisierung${per}: wartet auf ersten Refresh`;
    if (arActive()) {
      const nextOwn = lastAnyRefreshAt + cfg.intervalSec * 1000 - now;
      txt += t.at && nextOwn >= t.at - now ? ' · Auto-Refresh wartet auf TAM' : ` · Auto-Refresh in ${fmtDur(nextOwn)}`;
    }
    if (burstUntil > now) txt = `⚡ Burst-Refresh läuft – noch ${fmtDur(burstUntil - now)} · ${txt}`;
    el.textContent = txt;
    const bs = document.getElementById("tamauto-burst-state");
    if (bs) bs.textContent = burstUntil > now ? `⚡ läuft – noch ${fmtDur(burstUntil - now)}` : "";
  }

  // Einmal refreshen (Refresh-Pfeil) und danach abgleichen – gemeinsam genutzt von Auto-Refresh,
  // Tabwechsel und Burst-Refresh
  async function refreshAndCheck(reason) {
    if (busy || !onPublishedTab()) return false;
    busy = true; // eigene Tabellenänderungen beim Refresh nicht doppelt auswerten
    ownRefresh = true;
    let refreshed = false;
    try { refreshed = await refreshGrid(); } finally { busy = false; recheck = false; ownRefresh = false; }
    if (!refreshed) lastAnyRefreshAt = Date.now(); // nicht im Sekundentakt erneut versuchen
    await cycle(refreshed ? reason : 'Intervall');
    return refreshed;
  }

  // ---- Burst-Refresh: gezielt für kurze Zeit jede Sekunde aktualisieren (Auftragswellen), statt dauerhaft
  // Last zu erzeugen. Auslöser: NUR ein manueller Klick auf den Refresh-Pfeil der Website (falls an) oder der
  // Button „⚡ Burst“ im Reiter Bedienung (Erweiterte Einstellungen: an/aus + Dauer in s, Standard 3 s).
  let burstUntil = 0;
  let burstRunning = false;
  async function startBurst(reason) {
    if (!license) return;
    burstUntil = Date.now() + cfg.burstSec * 1000;
    log(`Burst-Refresh (${reason}): ${cfg.burstSec} s lang jede Sekunde aktualisieren.`, 'ok');
    if (burstRunning) return; // läuft schon → nur verlängert
    burstRunning = true;
    try {
      if (reason === 'manueller Refresh') await sleep(1000); // der Klick hat gerade selbst aktualisiert
      while (Date.now() < burstUntil && onPublishedTab()) {
        const t0 = Date.now();
        if (!busy) await refreshAndCheck('Burst-Refresh');
        await sleep(Math.max(100, 1000 - (Date.now() - t0))); // höchstens 1 Refresh pro Sekunde
      }
    } finally { burstRunning = false; burstUntil = 0; }
  }

  // Wechsel zurück in "Veröffentlichte Aufträge": immer genau EINMAL aktualisieren (kein Burst),
  // damit bei Auftragswellen sofort der aktuelle Stand da ist. Einmal pro Wechsel genügt.
  let wasOnPublished = false;
  let enterPending = false;
  function checkTabEnter() {
    const on = onPublishedTab();
    if (on && !wasOnPublished) {
      if (busy) enterPending = true; // z. B. während einer Annahme → direkt danach
      else onEnterPublished();
    }
    wasOnPublished = on;
  }
  function onEnterPublished() {
    enterPending = false;
    if (!license) return;
    setTimeout(() => refreshAndCheck('Tabwechsel-Refresh'), 300); // Tabwechsel: immer genau EIN Refresh (kein Burst)
  }

  async function tick() {
    const now = Date.now();
    if (now - lastHousekeepAt >= 5000) {
      lastHousekeepAt = now;
      if (license && license.exp < today()) { location.reload(); return; } // Lizenz abgelaufen → Aktivierungsfeld
      renderBlacklist(); renderAcceptlist(); // nach Mitternacht Anzeige leeren
      renderStatus();    // abgelaufene Zusatzliste ausblenden
      if (!busy && cfg.enabled) dismissMessages();
      dismissTamErrors(); // technische TAM-Fehlerfenster (z. B. TypeError auf Android) schließen // liegengebliebene TAM-Meldungen (z. B. "bereits vergeben") wegklicken
      hookAllConsoles(); // später geladene TAM-iframes ebenfalls mitlesen
    }
    renderSync(now);
    if (busy || !onPublishedTab() || burstUntil > now) return; // während Burst-Refresh übernimmt dieser
    if (arActive()) {
      if (!ownRefreshDue(now)) return;
      await refreshAndCheck('Refresh');
    } else if (cfg.enabled && now - lastCycleAt > 60000) {
      // Ohne Auto-Refresh gleicht die TAM-Aktualisierung ab; das hier ist nur ein Sicherheitsnetz
      await cycle('Intervall');
    }
  }

  function updateRefreshStatus() {
    setRefreshStatus(cfg.intervalSec > 60 ? 'Auto-Refresh aus – Abgleich synchron mit TAM-Aktualisierung'
      : cfg.autoRefresh ? `Auto-Refresh alle ${cfg.intervalSec} s, ausgerichtet am TAM-Takt` : 'Auto-Refresh aus');
  }

  function restartTimer() {
    clearInterval(timer);
    timer = setInterval(tick, 1000); // Sekundentakt; ob refresht wird, entscheidet ownRefreshDue()
    updateRefreshStatus();
  }

  // ------------------------------------------------------------------ Bedienfeld
  function setStatus(s) { const el = document.getElementById('tamauto-status'); if (el) el.textContent = s; }
  // Kurzstatus in der Titelzeile (sichtbar im minimierten Zustand)
  function renderHeadState() {
    const hs = document.getElementById('tamauto-head-state');
    if (!hs) return;
    const [txt, col] = !cfg.enabled ? ['■ gestoppt', '#c62828'] : onPublishedTab() ? ['● bereit', '#2e7d32'] : ['⏸ pausiert', '#b26a00'];
    hs.textContent = txt; hs.style.color = col;
  }
  function renderStatus() {
    renderHeadState();
    const el = document.getElementById('tamauto-places');
    const xb = places.block || { plz: [], orte: [] };
    if (el) el.textContent = `Ortsliste: ${places.plz.length} PLZ / ${places.orte.length} Orte · ` +
      `Sperrliste: ${xb.plz.length + xb.orte.length}` +
      (places.loadedAt ? ` (geladen ${new Date(places.loadedAt).toLocaleString('de-DE')})` : ' – nicht geladen');
    const ex = extraPlaces();
    const exEl = document.getElementById('tamauto-extra');
    if (exEl) {
      const n = ex.plz.length + ex.orte.length;
      exEl.textContent = n ? `+ Zusätzlich: ${[...ex.plz, ...ex.orte].join(', ')} (bis ${new Date(ex.at + EXTRA_TTL)
        .toLocaleString('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })})` : '';
      exEl.style.display = n ? '' : 'none';
    }
    const btn = document.getElementById('tamauto-toggle');
    if (btn) { btn.textContent = cfg.enabled ? '■ Stop' : '▶ Start'; btn.style.background = cfg.enabled ? '#c62828' : '#2e7d32'; }
    updateTabStatus();
  }

  function buildPanel() {
    const p = document.createElement('div');
    p.id = 'tamauto';
    p.innerHTML = `
      <div id="tamauto-head" style="display:flex;justify-content:space-between;align-items:center;gap:8px;cursor:move;white-space:nowrap">
        <b>TAM Auto-Annahme v${VERSION}</b><span id="tamauto-head-state" style="display:none;font-weight:bold"></span><span id="tamauto-min" style="cursor:pointer;padding:0 6px;font-weight:bold">–</span></div>
      <div id="tamauto-mini" style="display:none;margin-top:4px;line-height:1.5">
        <div id="tamauto-mini-state" style="font-size:18px;font-weight:bold"></div>
        <table style="border-collapse:collapse">
          <tr><td style="color:#555;padding-right:8px">Nächster Refresh</td><td id="tamauto-mini-next" style="font-weight:bold"></td></tr>
          <tr><td style="color:#555;padding-right:8px">Letzter Auftrag</td><td id="tamauto-mini-last"></td></tr>
          <tr><td style="color:#555;padding-right:8px">Trefferquote heute</td><td id="tamauto-mini-rate"></td></tr>
        </table>
      </div>
      <div id="tamauto-body">
        <a id="tamauto-update" href="${UPDATE_URL}" target="_blank" style="display:none;font-weight:bold;color:#1a4d8f;margin:4px 0"></a>
        <div id="tamauto-tab" style="font-weight:bold;margin:4px 0"></div>
        <div id="tamauto-places"></div>
        <div id="tamauto-extra" style="color:#1a4d8f;display:none"></div>
        <div id="tamauto-status" style="color:#555">bereit</div>
        <div id="tamauto-refresh" style="color:#555"></div>
        <div id="tamauto-sync" style="color:#555"></div>
        <div id="tamauto-tabbar" style="display:flex;flex-wrap:wrap;gap:0 2px;margin-top:6px">
          <button class="tamauto-tabbtn" data-page="tamauto-page-main">Bedienung</button>
          <button class="tamauto-tabbtn" data-page="tamauto-page-adv">Erweiterte Einstellungen</button>
          <button class="tamauto-tabbtn" data-page="tamauto-page-book">Auftragsbuch</button>
          <button class="tamauto-tabbtn" data-page="tamauto-page-info">Info</button>
        </div>
        <div id="tamauto-page-adv" style="display:none;margin:6px 0">
          <div style="margin-bottom:10px;padding-bottom:6px;border-bottom:1px solid #ddd">
            <span class="tamauto-chk">
              <label class="tamauto-chk"><input type="checkbox" id="tamauto-hidetips"> <b>Tipps ausblenden</b></label>
              <span class="tamauto-help" title="Blendet alle ?-Erklärungen im Bedienfeld aus (auch dieses), für eine aufgeräumte Ansicht. Wieder einblenden: Haken entfernen.">?</span>
            </span>
          </div>
          <div style="margin-bottom:10px;padding-bottom:6px;border-bottom:1px solid #ddd">
            <span class="tamauto-chk">
              <label class="tamauto-chk"><input type="checkbox" id="tamauto-wakelock"> <b>Bildschirm anlassen</b></label>
              <span class="tamauto-help" title="Verhindert, dass der Bildschirm ausgeht, solange TAM im Vordergrund offen ist (Wake Lock). Wichtig auf Android/Handy: Geht der Bildschirm aus oder wird der Browser in den Hintergrund gelegt, friert das System die Seite ein – das Script kann dann nicht mehr prüfen und annehmen. Tipp: Gerät ans Ladegerät, Helligkeit herunterdrehen. Wird automatisch neu angefordert, sobald TAM wieder sichtbar ist.">?</span>
            </span>
            <div id="tamauto-wakelock-state" style="color:#555;margin-top:2px"></div>
          </div>
          <div>
            <label class="tamauto-chk" title="Wartet vor jedem Klickschritt der Annahme">
              <input type="checkbox" id="tamauto-delay-on"> <b>Verzögerung</b></label>
            <span style="color:#555"> – vor jedem Klickschritt der Annahme</span>
            <div class="tamauto-chk" style="margin-top:4px">
              <input type="range" id="tamauto-delay" min="0.01" max="1" step="0.01" style="width:140px;margin:0">
              <b id="tamauto-delay-val"></b>
            </div>
            <div class="tamauto-chk" style="margin-top:4px">
              <label class="tamauto-chk"><input type="checkbox" id="tamauto-delay-rnd"> Randomizer</label>
              + zufällig bis <input id="tamauto-delay-ms" type="number" min="0" max="2000" step="10" style="width:56px;margin:0"> ms
            </div>
          </div>
          <div style="margin-top:10px;padding-top:6px;border-top:1px solid #ddd">
            <label class="tamauto-chk" title="Zeigt das Protokoll des Scripts unten im Bedienfeld">
              <input type="checkbox" id="tamauto-consolelog"> <b>Console Log</b></label>
            <button id="tamauto-copylog" title="Verlauf der letzten bis zu 5000 Zeilen (mit Datum, chronologisch) in die Zwischenablage kopieren – auch über ein Neuladen der Seite hinweg. Z. B. zum Weiterschicken." style="margin-left:6px">📋 Log kopieren</button>
            <div style="color:#555;margin-top:2px">Protokoll des Scripts unten im Bedienfeld anzeigen</div>
          </div>
          <div style="margin-top:10px;padding-top:6px;border-top:1px solid #ddd">
            <span class="tamauto-chk">
              <label class="tamauto-chk" title="Gong bei angenommenem oder fehlgeschlagenem Auftrag">
                <input type="checkbox" id="tamauto-sound"> <b>Benachrichtigungston</b></label>
              <input type="range" id="tamauto-vol" min="0" max="100" step="5" title="Lautstärke · Doppelklick = 60 %"
                style="width:100px;margin:0 0 0 6px;cursor:pointer">
              <b id="tamauto-vol-val" style="min-width:34px"></b>
              <button id="tamauto-sound-test" title="Ton einmal abspielen">▶ Test</button>
            </span>
            <div style="margin-top:6px">
              <label class="tamauto-chk" title="Desktop-Benachrichtigung bei angenommenem oder fehlgeschlagenem Auftrag">
                <input type="checkbox" id="tamauto-popups"> <b>Popups</b></label>
              <span style="color:#555"> – Desktop-Benachrichtigung</span>
              <button id="tamauto-popup-test" title="Test-Benachrichtigung anzeigen" style="margin-left:4px">▶ Test</button>
              <span class="tamauto-help" id="tamauto-popup-help" style="margin-left:4px"
                title="Kein Popup beim Test? Klicken für die Anleitung zum Einschalten der Benachrichtigungen.">?</span>
            </div>
            <!-- Anleitung liegt im Script selbst: funktioniert auch, wenn GitHub nicht erreichbar oder das Projekt privat ist -->
            <div id="tamauto-popup-helpbox" style="display:none;margin-top:6px;padding:6px 8px;background:#f3f7fc;border:1px solid #c9d8ee;border-radius:3px;font-size:11px;line-height:1.45">
              <b>Popups einschalten</b> – die Popups kommen als Windows-Benachrichtigung vom Browser:<br>
              <b>1.</b> Windows-Taste → <i>Einstellungen</i> → <i>System</i> → <i>Benachrichtigungen</i>: „Benachrichtigungen“
              <b>ein</b> und darunter den eigenen Browser (Chrome, Edge oder Firefox) <b>ein</b>.<br>
              <b>2.</b> „Nicht stören“ bzw. Fokus-Assistent <b>aus</b> (ebenfalls unter <i>System</i> → <i>Benachrichtigungen</i> / <i>Fokus</i>).<br>
              <b>3.</b> Nur falls nötig, im Browser Benachrichtigungen nicht komplett blockieren:
              Chrome <code>chrome://settings/content/notifications</code>, Edge <code>edge://settings/content/notifications</code>,
              Firefox <i>Einstellungen → Datenschutz &amp; Sicherheit → Berechtigungen → Benachrichtigungen</i>.<br>
              <b>4.</b> Browser neu starten, TAM neu laden, <b>▶ Test</b> erneut klicken.<br>
              <span style="color:#555">Der Benachrichtigungston funktioniert auch ohne Popups.</span>
            </div>
          </div>
        </div>
        <div id="tamauto-page-info" style="display:none;margin:6px 0;line-height:1.5">
          <div style="font-size:14px;font-weight:bold;color:#1a4d8f">TAM Auto-Annahme</div>
          <div style="color:#555">Version ${VERSION} · automatische Auftragsannahme im TÜV SÜD TAM</div>
          <div style="margin-top:4px"><button id="tamauto-upd" title="Sucht auf GitHub nach einer neuen Version">Softwareupdate</button></div>
          <table style="border-collapse:collapse;margin-top:6px">
            <tr><td style="padding:1px 8px 1px 0;color:#555">Lizenziert für</td><td id="tamauto-info-name"></td></tr>
            <tr><td style="padding:1px 8px 1px 0;color:#555">Gültig bis</td><td id="tamauto-info-exp"></td></tr>
            <tr><td style="padding:1px 8px 1px 0;color:#555">Installations-ID</td><td id="tamauto-info-id" style="font-family:monospace"></td></tr>
            <tr id="tamauto-info-android" style="display:none"><td style="padding:1px 8px 1px 0;color:#555">Gerät</td>
              <td>Android – TAM ist für den Desktop gebaut. Technische TAM-Fehlerfenster (z. B. „TypeError“) werden
                automatisch geschlossen und im Log vermerkt.</td></tr>
            <tr><td style="padding:1px 8px 1px 0;color:#555">Hersteller</td><td>IB Thomée GmbH</td></tr>
          </table>
          <div style="margin-top:6px;padding:3px 6px;background:#fff8e1;border:1px solid #f0c36d;border-radius:3px;font-size:10.5px;line-height:1.35">
            ⚠ Die Lizenz ist in diesem Browser gespeichert und bleibt bei Updates erhalten. <b>Beim Löschen von
            Cookies/Website-Daten oder Deinstallieren von Tampermonkey kann sie verloren gehen</b> – dann neue ID
            an IB Thomée schicken. Tipp: tam.tuvsud.com beim Löschen ausnehmen.
          </div>
          <div style="margin-top:8px;padding-top:6px;border-top:1px solid #ddd">
            <b>© 2026 IB Thomée GmbH. Alle Rechte vorbehalten.</b><br>
            Die Nutzung ist nur mit einem gültigen Lizenzschlüssel der IB Thomée GmbH gestattet. Der Schlüssel gilt
            ausschließlich für diese Installation und ist zeitlich befristet (1, 3 oder 6 Monate bzw. bis Jahresende – siehe „Gültig bis“).<br>
            <b>Nicht gestattet:</b> Veränderung oder Bearbeitung des Codes, Weitergabe der Software oder des
            Lizenzschlüssels, Vervielfältigung sowie das Umgehen der Lizenzprüfung.
            <a href="https://github.com/TheFishflap/TamAuto/blob/main/LICENSE" target="_blank" style="color:#1a4d8f">Lizenzbedingungen</a>
          </div>
          <div style="margin-top:10px;text-align:center;color:#555">Made with <span style="color:#c62828">♥</span> and Claude</div>
        </div>
        <div id="tamauto-page-book" style="display:none;margin:6px 0">
          <div class="tamauto-chk" style="justify-content:space-between;width:100%">
            <span>Zeitraum <select id="tamauto-ob-range">
              <option value="today">Heute</option><option value="week">Letzte 7 Tage</option>
              <option value="month">Dieser Monat</option><option value="all">Alle</option></select></span>
            <button id="tamauto-ob-clear" title="Auftragsbuch vollständig löschen">Liste leeren</button>
          </div>
          <div style="max-height:180px;overflow:auto;margin-top:4px;border:1px solid #ddd">
            <table style="border-collapse:collapse;width:100%;font-size:11px">
              <thead><tr style="background:#e8f0fb;position:sticky;top:0">
                <th style="text-align:left;padding:2px 4px">Datum</th><th style="text-align:left;padding:2px 4px">AuftragsNr</th>
                <th style="text-align:left;padding:2px 4px">PLZ</th><th style="text-align:left;padding:2px 4px">Ort</th>
                <th style="text-align:right;padding:2px 4px">Euro</th></tr></thead>
              <tbody id="tamauto-ob-rows"></tbody>
            </table>
          </div>
          <div id="tamauto-ob-sum" style="margin-top:4px;padding-top:4px;border-top:2px solid #1a4d8f"></div>
          <div id="tamauto-ob-plz" style="color:#555;margin-top:2px"></div>
          <div id="tamauto-ob-rate" style="margin-top:6px;padding:4px 6px;background:#f3f7fc;border:1px solid #c9d8ee;border-radius:3px"
            title="Passend = veröffentlichte Aufträge, deren PLZ in der Ortsliste steht. Tatsächlich verfügbar = davon versucht und beim Öffnen nicht schon an einen anderen Anbieter vergeben."></div>
        </div>
        <div id="tamauto-page-main" style="margin:6px 0;display:flex;gap:6px;flex-wrap:wrap;align-items:center">
          <button id="tamauto-toggle"></button>
          <button id="tamauto-load" title="Lädt Ortsliste (Blatt „annehmen“) und Sperrliste (Blatt „nicht annehmen“) neu">Ortslisten laden</button>
          <span class="tamauto-chk">
            <button id="tamauto-paste">Liste einfügen</button>
            <span class="tamauto-help" title="BULK-Einfügen: viele PLZ (bzw. Orte) auf einmal – z. B. aus Excel kopiert – ZUSÄTZLICH zur geladenen Ortsliste annehmen. Gleiche Logik: „43“ = alle 43xxx, „47877“ = nur diese PLZ. Eine PLZ oder „PLZ;Ort“ je Zeile. Wird nach 24 Stunden automatisch gelöscht. Leer übernehmen = sofort löschen.

Hinweis: Für EINZELNE PLZ ist die „Tages-Annahmeliste“ weiter unten besser gedacht – sie nimmt nur vollständige 5-stellige PLZ an, so wird nicht versehentlich ein ganzes Gebiet angenommen.">?</span>
          </span>
          <span class="tamauto-chk">
            <label class="tamauto-chk"><input type="checkbox" id="tamauto-ar"> Auto-Refresh</label>
            alle <input id="tamauto-int" type="number" min="10" style="width:48px;margin:0" value="${cfg.intervalSec}"> s
            <span class="tamauto-help" title="Auto-Refresh lädt die Tabelle schneller neu, um neue Aufträge früher zu finden. Ein niedrigerer Wert bedeutet eine höhere Auslastung und sollte mit Bedacht gewählt werden, um Auffälligkeiten zu vermeiden. Standard: 60 s (aus), Minimum: 10 s. Am TAM-Takt ausgerichtet: Das Script liest mit, wann TAM selbst neu lädt (Einstellung „Automatisch alle … Minuten“), und lässt den eigenen Refresh aus, wenn TAM gleich ohnehin aktualisiert. Über 60 s schaltet sich der Auto-Refresh ab – der Abgleich läuft dann nur mit der TAM-eigenen Aktualisierung.">?</span>
          </span>
          <button id="tamauto-once" title="Nimmt den obersten Auftrag der Tabelle EINMAL verbindlich an – ohne Ortsliste">Auftrag 1. Zeile annehmen</button>
          <span class="tamauto-chk">
            <button id="tamauto-burst-go" title="Burst-Refresh jetzt starten: für die eingestellte Zeit jede Sekunde aktualisieren – z. B. wenn eine Auftragswelle erwartet wird. Erneut klicken = wieder volle Zeit.">⚡ Burst</button>
            <input id="tamauto-burst-sec" type="number" min="3" max="120" title="Dauer des Burst-Refresh in Sekunden" style="width:44px;margin:0"> s
            <span class="tamauto-help" title="Burst-Refresh: für die eingestellte Zeit (Standard 3 s) jede Sekunde aktualisieren – ideal bei Auftragswellen, ohne dauerhaft Last zu erzeugen. Auslösen: über diesen Button ODER direkt auf der TAM-Website über den Refresh-Pfeil ⟳ unten in der Blätterleiste der Tabelle. Beim Tabwechsel zurück in „Veröffentlichte Aufträge“ wird dagegen immer nur EINMAL aktualisiert.">?</span>
            <span id="tamauto-burst-state" style="color:#555"></span>
          </span>
          <div style="flex-basis:100%;margin-top:2px;padding-top:6px;border-top:1px solid #ddd">
            <b>Tages-Blacklist</b>
            <span class="tamauto-help" title="PLZ, die heute NICHT angenommen werden, z. B. nach einem Storno (sonst würde der Auftrag erneut angenommen). 2–5 Ziffern: „43“ sperrt alle 43xxx, „47877“ nur diese PLZ. Die Liste leert sich um Mitternacht automatisch. Freigeben: auf den roten Eintrag klicken.">?</span>
            <div style="display:flex;gap:6px;align-items:center;margin-top:4px">
              <input id="tamauto-bl-in" placeholder="PLZ, z. B. 47877" maxlength="5" style="width:110px">
              <button id="tamauto-bl-add">Sperren</button>
              <button id="tamauto-bl-clear">Alle freigeben</button>
            </div>
            <div id="tamauto-bl-list" style="margin-top:4px;display:flex;gap:4px;flex-wrap:wrap"></div>
            <div style="margin-top:6px"><b>Sperrliste aus Excel</b>
              <span class="tamauto-help" title="PLZ aus dem Excel-Blatt „nicht annehmen“. Diese PLZ werden NIE angenommen – dauerhaft, solange sie im Excel stehen (nicht nur heute). Sie sind vom Button „Alle freigeben“ NICHT betroffen und lassen sich hier nicht entfernen – ändern nur im Excel, danach „Neu laden“.">?</span>
              <span style="color:#555">– Blatt „nicht annehmen“</span>
              <button id="tamauto-bl-reload" style="margin-left:4px">Neu laden</button></div>
            <div id="tamauto-bl-excel" style="margin-top:4px;display:flex;gap:4px;flex-wrap:wrap"></div>
          </div>
          <div style="flex-basis:100%;margin-top:2px;padding-top:6px;border-top:1px solid #ddd">
            <b>Tages-Annahmeliste</b>
            <span class="tamauto-help" title="PLZ, die heute ZUSÄTZLICH zur Ortsliste angenommen werden. Nur vollständige 5-stellige PLZ (z. B. 47877) – damit nicht versehentlich ganze Gebiete angenommen werden. Die Liste leert sich um Mitternacht automatisch. Entfernen: auf den grünen Eintrag klicken. Steht eine PLZ auch auf einer Sperrliste, gilt die Sperre.">?</span>
            <div style="display:flex;gap:6px;align-items:center;margin-top:4px">
              <input id="tamauto-al-in" placeholder="5-stellige PLZ" maxlength="5" inputmode="numeric" style="width:110px">
              <button id="tamauto-al-add">Annehmen</button>
              <button id="tamauto-al-clear">Alle entfernen</button>
              <span id="tamauto-al-msg" style="color:#c62828"></span>
            </div>
            <div id="tamauto-al-list" style="margin-top:4px;display:flex;gap:4px;flex-wrap:wrap"></div>
          </div>
        </div>
        <textarea id="tamauto-ta" placeholder="Bulk: zusätzliche PLZ für 24 h – eine je Zeile, z. B.&#10;43        (= alle 43xxx!)&#10;47877&#10;&#10;Für einzelne PLZ besser die Tages-Annahmeliste nutzen (nur 5-stellig)." style="display:none;width:100%;height:96px"></textarea>
        <div id="tamauto-log" style="max-height:220px;overflow:auto;font:11px monospace;border-top:1px solid #ddd;padding-top:4px"></div>
      </div>`;
    // Bedienfeld: verschiebbar (Titelzeile) und in der Größe änderbar (Ecke unten rechts); beides wird gespeichert
    Object.assign(p.style, { position: 'fixed', right: '12px', bottom: '12px', width: '420px', zIndex: 99999,
      background: '#fff', border: '2px solid #1a4d8f', borderRadius: '6px', padding: '8px',
      font: '12px Arial, sans-serif', boxShadow: '0 4px 14px rgba(0,0,0,.25)',
      resize: 'both', overflow: 'hidden', minWidth: '340px', minHeight: '120px', maxWidth: '95vw', maxHeight: '95vh',
      display: 'flex', flexDirection: 'column', boxSizing: 'border-box' });
    const body = p.querySelector('#tamauto-body');
    Object.assign(body.style, { flex: '1 1 auto', minHeight: '0', display: 'flex', flexDirection: 'column', overflowY: 'auto' });
    Object.assign(p.querySelector('#tamauto-log').style, { flex: '1 1 auto', minHeight: '40px' });
    p.querySelectorAll('button').forEach((b) => Object.assign(b.style,
      { padding: '3px 8px', border: '1px solid #1a4d8f', borderRadius: '3px', background: '#e8f0fb', cursor: 'pointer' }));
    // Checkbox und Text auf einer Linie (TAM-CSS verschiebt Checkboxen sonst nach oben)
    p.querySelectorAll('.tamauto-chk').forEach((el) => Object.assign(el.style,
      { display: 'inline-flex', alignItems: 'center', gap: '4px', whiteSpace: 'nowrap', margin: '0', cursor: 'pointer' }));
    p.querySelectorAll('input[type=checkbox]').forEach((cb) => Object.assign(cb.style,
      { margin: '0', verticalAlign: 'middle', position: 'static', top: '0' }));
    // "?"-Hilfen: kleiner Kreis, Erklärung beim Darüberfahren (title)
    p.querySelectorAll('.tamauto-help').forEach((h) => Object.assign(h.style, {
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: '16px', height: '16px',
      borderRadius: '50%', background: '#1a4d8f', color: '#fff', fontSize: '11px', fontWeight: 'bold', cursor: 'help' }));
    document.body.appendChild(p);
    document.getElementById('tamauto-toggle').style.color = '#fff';

    const $ = (id) => document.getElementById(id);
    $('tamauto-toggle').onclick = () => {
      cfg.enabled = !cfg.enabled; GM_setValue('running', cfg.enabled);
      log(cfg.enabled ? 'Gestartet' : 'Gestoppt'); renderStatus();
      if (cfg.enabled) cycle('Start');
    };
    // Auto-Refresh: über 60 s aus (TAM aktualisiert selbst jede Minute → Abgleich synchron damit)
    const renderAr = () => {
      const over = cfg.intervalSec > 60;
      $('tamauto-ar').checked = cfg.autoRefresh && !over;
      $('tamauto-ar').disabled = over;
      $('tamauto-int').value = cfg.intervalSec;
    };
    $('tamauto-ar').onchange = (e) => {
      cfg.autoRefresh = e.target.checked; GM_setValue('autoRefreshV2', cfg.autoRefresh); lastRefreshOk = null; updateRefreshStatus();
    };
    $('tamauto-int').onchange = (e) => {
      cfg.intervalSec = Math.max(10, parseInt(e.target.value, 10) || 60); GM_setValue('intervalSecV2', cfg.intervalSec);
      if (cfg.intervalSec > 60 && cfg.autoRefresh) {
        cfg.autoRefresh = false; GM_setValue('autoRefreshV2', false);
        log('Intervall über 60 s: Auto-Refresh aus – Abgleich läuft synchron mit der TAM-Aktualisierung.', 'ok');
      }
      renderAr(); restartTimer();
    };
    renderAr();
    $('tamauto-load').onclick = () => loadPlacesFromSheet(true);
    // Zusätzliche Liste: Feld zeigt die aktuelle Zusatzliste zum Bearbeiten; leer übernehmen = löschen
    $('tamauto-paste').onclick = () => {
      const ta = $('tamauto-ta');
      if (ta.style.display === 'none') {
        const ex = extraPlaces();
        ta.value = [...ex.plz, ...ex.orte].join('\n');
        ta.style.display = 'block'; $('tamauto-paste').textContent = 'Übernehmen'; ta.focus();
      } else {
        loadPlacesFromText(ta.value); ta.style.display = 'none'; $('tamauto-paste').textContent = 'Liste einfügen';
      }
    };
    $('tamauto-once').onclick = async () => {
      if (busy) { log('Script ist gerade beschäftigt – kurz warten.', 'err'); return; }
      if (!onPublishedTab()) { log('Bitte Tab "Veröffentlichte Aufträge" öffnen.', 'err'); return; }
      const grid = visibleGrid();
      const rows = grid ? readOrders(grid) : [];
      rememberRows(rows);
      const o = rows.find((x) => x.valid && x.nr);
      if (!o) { log('Kein Auftrag in der Tabelle.', 'err'); return; }
      if (!confirm(`Auftrag ${o.nr} (${o.plz} ${o.ort}) jetzt VERBINDLICH annehmen – unabhängig von der Ortsliste?`)) return;
      busy = true;
      try {
        log(`Annahme 1. Zeile gestartet: ${o.nr} · ${o.plz} ${o.ort}`);
        const ok = await acceptOrder(o);
        const plus = bulkOf(o).length ? ` + ${bulkLabel(o)}` : '';
        log(ok ? `Annahme 1. Zeile erfolgreich: ${o.nr}${plus}` : `Annahme 1. Zeile fehlgeschlagen: ${o.nr}`, ok ? 'ok' : 'err');
        if (ok) bookAccepted(o);
      } finally { releaseBusy(); }
    };
    $('tamauto-upd').onclick = () => checkUpdate(true);

    // Reiter im Bedienfeld
    const showPage = (id) => {
      p.querySelectorAll('.tamauto-tabbtn').forEach((b) => {
        const on = b.dataset.page === id;
        $(b.dataset.page).style.display = on ? (id === 'tamauto-page-main' ? 'flex' : 'block') : 'none';
        // Reiter füllen ihre Zeile; jede Zeile steht auf einer durchgehenden Linie (auch wenn umgebrochen wird)
        Object.assign(b.style, { background: on ? '#1a4d8f' : '#e8f0fb', color: on ? '#fff' : '#000',
          borderRadius: '3px 3px 0 0', borderBottom: '2px solid #1a4d8f', flex: '1 1 auto', whiteSpace: 'nowrap',
          marginTop: '2px' });
      });
      if (id === 'tamauto-page-main') $('tamauto-ta').style.display = 'none';
      if (id === 'tamauto-page-main') renderBlacklist();
      if (id === 'tamauto-page-book') renderOrderbook();
    };
    p.querySelectorAll('.tamauto-tabbtn').forEach((b) => { b.onclick = () => showPage(b.dataset.page); });
    showPage('tamauto-page-main');
    renderBlacklist();

    // Tages-Blacklist
    const addBl = () => {
      const v = normPlz($('tamauto-bl-in').value);
      if (v.length < 2) { log('Blacklist: bitte 2–5 Ziffern eingeben.', 'err'); return; }
      const b = blacklist();
      if (!b.plz.includes(v)) { b.plz.push(v); b.plz.sort(); GM_setValue('blacklist', b); }
      log(`Blacklist: PLZ ${v}… heute gesperrt.`, 'err');
      $('tamauto-bl-in').value = ''; renderBlacklist();
    };
    $('tamauto-bl-add').onclick = addBl;
    $('tamauto-bl-in').onkeydown = (e) => { if (e.key === 'Enter') addBl(); };
    // Verzögerung: Checkbox + Slider 1,0–5,0 s (0,1-s-Schritte) + Randomizer (Streuung nicht angezeigt)
    const fmtSec = (v) => `${v.toFixed(2).replace('.', ',')} s`;
    const renderDelay = () => {
      $('tamauto-delay-on').checked = cfg.delayOn;
      $('tamauto-delay').value = cfg.delaySec;
      $('tamauto-delay').disabled = !cfg.delayOn;
      $('tamauto-delay-rnd').checked = cfg.delayRandom;
      $('tamauto-delay-rnd').disabled = !cfg.delayOn;
      $('tamauto-delay-ms').value = cfg.delayRandomMs;
      $('tamauto-delay-ms').disabled = !cfg.delayOn || !cfg.delayRandom;
      $('tamauto-delay-val').textContent = cfg.delayOn ? fmtSec(cfg.delaySec) : 'aus';
    };
    const delayInfo = () => `Verzögerung ${fmtSec(cfg.delaySec)} je Klickschritt${cfg.delayRandom ? ` + zufällig bis ${cfg.delayRandomMs} ms` : ''}.`;
    $('tamauto-delay-on').onchange = (e) => {
      cfg.delayOn = e.target.checked; GM_setValue('delayOnV2', cfg.delayOn); renderDelay();
      log(cfg.delayOn ? `An: ${delayInfo()}` : 'Verzögerung aus.');
    };
    $('tamauto-delay').oninput = (e) => {
      cfg.delaySec = Math.round(Math.min(1, Math.max(0.01, +e.target.value || 0.01)) * 100) / 100; renderDelay();
    };
    $('tamauto-delay').onchange = () => { GM_setValue('delaySec', cfg.delaySec); log(delayInfo()); };
    $('tamauto-delay-rnd').onchange = (e) => {
      cfg.delayRandom = e.target.checked; GM_setValue('delayRandom', cfg.delayRandom); renderDelay(); log(delayInfo());
    };
    $('tamauto-delay-ms').onchange = (e) => {
      cfg.delayRandomMs = Math.round(Math.min(2000, Math.max(0, +e.target.value || 0)));
      GM_setValue('delayRandomMsV2', cfg.delayRandomMs); renderDelay(); log(delayInfo());
    };
    renderDelay();

    // Lizenzinfo. Laufzeit: 1 / 3 / 6 Monate oder bis Jahresende. Hinweis vor Ablauf: 30 Tage, bei kurzen
    // Lizenzen früher nur das letzte Viertel der Laufzeit (1 Monat → ca. 8 Tage vorher)
    const daysLeft = Math.ceil((new Date(`${license.exp}T23:59:59`) - Date.now()) / 864e5);
    const totalDays = license.iat ? Math.ceil((new Date(license.exp) - new Date(license.iat)) / 864e5) : 365;
    const warnDays = Math.min(30, Math.max(3, Math.ceil(totalDays / 4)));
    const durLabel = { '1M': '1 Monat', '3M': '3 Monate', '6M': '6 Monate', Jahr: 'bis Jahresende' }[license.dur] || '';
    // Reiter "Info" (textContent: Name aus dem Schlüssel nie als HTML einsetzen)
    $('tamauto-info-name').textContent = license.name;
    $('tamauto-info-exp').textContent = `${fmtDate(license.exp)}${durLabel ? ` (Lizenzdauer: ${durLabel})` : ''}` +
      `${daysLeft <= warnDays ? ` – noch ${daysLeft} Tage, neue Lizenz anfordern` : ''}`;
    if (daysLeft <= warnDays) $('tamauto-info-exp').style.color = '#c62828';
    $('tamauto-info-id').textContent = installId();
    if (isAndroid) $('tamauto-info-android').style.display = '';
    if (daysLeft <= warnDays) {
      const w = document.createElement('div');
      Object.assign(w.style, { color: '#c62828', fontWeight: 'bold', margin: '4px 0' });
      w.textContent = `Lizenz läuft am ${fmtDate(license.exp)} ab (noch ${daysLeft} Tage) – neue Lizenz bei IB Thomée anfordern.`;
      $('tamauto-body').prepend(w);
    }

    // Button "⚡ Burst" (Reiter Bedienung): Burst sofort starten – funktioniert auch bei ausgeschalteter Checkbox
    $('tamauto-burst-go').onclick = () => {
      if (!onPublishedTab()) { log('Burst-Refresh: bitte zuerst den Reiter „Veröffentlichte Aufträge“ öffnen.', 'err'); return; }
      startBurst('Button');
    };

    // Bildschirm anlassen (Screen Wake Lock): hält den Bildschirm an, solange TAM sichtbar ist.
    // Der Browser gibt die Sperre frei, sobald die Seite unsichtbar wird → beim Zurückkehren neu anfordern.
    const nav = (typeof unsafeWindow !== 'undefined' ? unsafeWindow : window).navigator;
    let wakeSentinel = null;
    const renderWake = (msg) => {
      $('tamauto-wakelock').checked = cfg.wakeLock;
      $('tamauto-wakelock-state').textContent = msg || (!cfg.wakeLock ? 'aus – Bildschirm darf ausgehen'
        : !('wakeLock' in nav) ? '⚠ vom Browser nicht unterstützt – Bildschirm-Timeout in den Geräteeinstellungen erhöhen'
          : wakeSentinel ? '✔ aktiv – Bildschirm bleibt an' : 'wartet (wird aktiv, sobald TAM sichtbar ist / nach einem Tipp ins Bedienfeld)');
    };
    const applyWakeLock = async () => {
      if (!cfg.wakeLock) { if (wakeSentinel) { try { await wakeSentinel.release(); } catch (e) { /* ignore */ } } wakeSentinel = null; renderWake(); return; }
      if (!('wakeLock' in nav) || wakeSentinel || document.visibilityState !== 'visible') { renderWake(); return; }
      try {
        wakeSentinel = await nav.wakeLock.request('screen');
        wakeSentinel.addEventListener('release', () => { wakeSentinel = null; renderWake(); });
        renderWake();
      } catch (e) { wakeSentinel = null; renderWake(); } // z. B. Energiesparmodus – beim nächsten Tipp erneut
    };
    $('tamauto-wakelock').onchange = (e) => { cfg.wakeLock = e.target.checked; GM_setValue('wakeLock', cfg.wakeLock); applyWakeLock(); };
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') applyWakeLock(); });
    p.addEventListener('pointerdown', () => { if (cfg.wakeLock && !wakeSentinel) applyWakeLock(); }); // manche Browser brauchen eine Berührung
    applyWakeLock();

    // Tipps ausblenden: alle "?"-Erklärungen weg – außer dem "?" direkt an dieser Checkbox
    const applyTips = () => {
      $('tamauto-hidetips').checked = cfg.hideTips;
      p.querySelectorAll('.tamauto-help').forEach((h) => { h.style.display = cfg.hideTips ? 'none' : 'inline-flex'; });
      if (cfg.hideTips) $('tamauto-popup-helpbox').style.display = 'none';
    };
    $('tamauto-hidetips').onchange = (e) => { cfg.hideTips = e.target.checked; GM_setValue('hideTips', cfg.hideTips); applyTips(); };
    applyTips();

    // Burst-Refresh: nur die Dauer ist einstellbar (Auslöser: Button "⚡ Burst" oder manueller Refresh auf der Website)
    $('tamauto-burst-sec').value = cfg.burstSec;
    $('tamauto-burst-sec').onchange = (e) => {
      cfg.burstSec = Math.round(Math.min(120, Math.max(3, +e.target.value || 3)));
      e.target.value = cfg.burstSec; GM_setValue('burstSecV2', cfg.burstSec);
    };

    // Console Log: Protokoll des Scripts ein-/ausblenden (keine Ausgaben in die Browser-Konsole)
    const renderConsole = () => { $('tamauto-consolelog').checked = cfg.consoleLog; $('tamauto-log').style.display = cfg.consoleLog ? '' : 'none'; };
    $('tamauto-consolelog').onchange = (e) => { cfg.consoleLog = e.target.checked; GM_setValue('consoleLogV2', cfg.consoleLog); renderConsole(); };
    renderConsole();

    // Log kopieren (auch wenn das Log gerade ausgeblendet ist – es wird immer mitgeschrieben)
    $('tamauto-copylog').onclick = async () => {
      const b = $('tamauto-copylog');
      const lines = logHistory.slice(-LOG_KEEP); // kompletter Verlauf (bis 5000 Zeilen, älteste zuerst)
      const txt = `TAM Auto-Annahme v${VERSION} · Log vom ${new Date().toLocaleString('de-DE')} · ${navigator.userAgent}\n\n${lines.join('\n')}`;
      let ok = false;
      try { await navigator.clipboard.writeText(txt); ok = true; } catch (e) {
        const ta = document.createElement('textarea'); ta.value = txt; document.body.appendChild(ta); ta.select();
        try { ok = document.execCommand('copy'); } catch (e2) { ok = false; } ta.remove();
      }
      b.textContent = ok ? `✓ ${lines.length} Zeilen kopiert` : '✗ Kopieren nicht möglich';
      setTimeout(() => { b.textContent = '📋 Log kopieren'; }, 3000);
    };

    // Benachrichtigungston an/aus (+ Test)
    $('tamauto-sound').checked = cfg.sound;
    $('tamauto-sound').onchange = (e) => {
      cfg.sound = e.target.checked; GM_setValue('sound', cfg.sound); renderVol();
      log(cfg.sound ? 'Benachrichtigungston an.' : 'Benachrichtigungston aus.');
    };
    $('tamauto-sound-test').onclick = () => chime();

    // Lautstärke-Schieberegler (0–100 %, 5-%-Schritte); beim Loslassen speichern und einmal vorspielen
    const vol = $('tamauto-vol');
    const renderVol = () => {
      vol.value = cfg.volume;
      $('tamauto-vol-val').textContent = `${cfg.volume} %`;
      vol.disabled = !cfg.sound;
      vol.style.opacity = cfg.sound ? '1' : '.4';
    };
    const setVol = (v) => { cfg.volume = Math.round(Math.max(0, Math.min(100, +v))); renderVol(); };
    vol.addEventListener('mousedown', (e) => e.stopPropagation()); // nicht das Bedienfeld verschieben
    vol.oninput = (e) => setVol(e.target.value);
    vol.onchange = () => { GM_setValue('volume', cfg.volume); if (cfg.sound) chime(); };
    vol.ondblclick = () => { setVol(60); GM_setValue('volume', 60); if (cfg.sound) chime(); };
    renderVol();

    // "?" bei Popups: eingebaute Anleitung auf-/zuklappen
    $('tamauto-popup-help').onclick = () => {
      const box = $('tamauto-popup-helpbox');
      box.style.display = box.style.display === 'none' ? 'block' : 'none';
    };

    // Popup testen (unabhängig von der Checkbox, damit man die Browser-Berechtigung prüfen kann)
    $('tamauto-popup-test').onclick = () => {
      try {
        GM_notification({ title: 'TAM Auto-Annahme – Test', text: 'So sieht eine Benachrichtigung bei einer Annahme aus.', timeout: 8000, silent: true });
        log('Test-Popup gesendet. Erscheint nichts: Benachrichtigungen für den Browser/Tampermonkey in Windows erlauben.', 'ok');
      } catch (e) { log(`Popup nicht möglich: ${e.message}`, 'err'); }
    };
    $('tamauto-popups').checked = cfg.popups;
    $('tamauto-popups').onchange = (e) => {
      cfg.popups = e.target.checked; GM_setValue('popups', cfg.popups); log(cfg.popups ? 'Popups an.' : 'Popups aus.');
    };

    // Excel-Sperrliste sofort neu laden (z. B. direkt nach einem Storno)
    $('tamauto-bl-reload').onclick = () => loadPlacesFromSheet(true);

    // Auftragsbuch
    $('tamauto-ob-range').onchange = renderOrderbook;
    $('tamauto-ob-clear').onclick = () => {
      if (!confirm('Auftragsbuch vollständig löschen?')) return;
      GM_setValue('orderbook', []); log('Auftragsbuch geleert.'); renderOrderbook();
    };
    $('tamauto-bl-clear').onclick = () => {
      GM_setValue('blacklist', { date: today(), plz: [] }); log('Blacklist: alle PLZ freigegeben.', 'ok'); renderBlacklist();
    };

    // Tages-Annahmeliste (nur exakt 5 Ziffern)
    const addAl = () => {
      const v = $('tamauto-al-in').value.trim();
      if (!/^\d{5}$/.test(v)) {
        $('tamauto-al-msg').textContent = 'Bitte vollständige 5-stellige PLZ eingeben.';
        $('tamauto-al-in').style.borderColor = '#c62828';
        return;
      }
      $('tamauto-al-msg').textContent = ''; $('tamauto-al-in').style.borderColor = '';
      const a = acceptlist();
      if (!a.plz.includes(v)) { a.plz.push(v); a.plz.sort(); GM_setValue('acceptlist', a); }
      log(`Tages-Annahmeliste: PLZ ${v} wird heute zusätzlich angenommen.`, 'ok');
      $('tamauto-al-in').value = ''; renderAcceptlist();
      scheduleCheck('Tages-Annahmeliste'); // sofort gegen die aktuelle Tabelle prüfen
    };
    $('tamauto-al-add').onclick = addAl;
    $('tamauto-al-in').onkeydown = (e) => { if (e.key === 'Enter') addAl(); };
    $('tamauto-al-in').oninput = () => { $('tamauto-al-msg').textContent = ''; $('tamauto-al-in').style.borderColor = ''; };
    $('tamauto-al-clear').onclick = () => {
      GM_setValue('acceptlist', { date: today(), plz: [] }); log('Tages-Annahmeliste geleert.'); renderAcceptlist();
    };
    renderAcceptlist();
    // Minimieren: nur noch eine schmale Titelzeile mit Status (wird gespeichert)
    const setMinimized = (min) => {
      const b = $('tamauto-body');
      if (min) {
        if (b.style.display !== 'none') p.dataset.prev = JSON.stringify({ h: p.style.height, w: p.style.width });
        b.style.display = 'none';
        Object.assign(p.style, { height: 'auto', width: 'max-content', minWidth: '0', minHeight: '0', resize: 'none', padding: '4px 8px', display: 'block' });
        $('tamauto-min').textContent = '+'; $('tamauto-min').title = 'Bedienfeld öffnen';
      } else {
        const prev = JSON.parse(p.dataset.prev || '{}');
        b.style.display = 'flex';
        Object.assign(p.style, { height: prev.h || '', width: prev.w && prev.w !== 'max-content' ? prev.w : '420px', minWidth: '340px', minHeight: '120px', resize: 'both', padding: '8px', display: 'flex' });
        $('tamauto-min').textContent = '–'; $('tamauto-min').title = 'Minimieren';
      }
      $('tamauto-mini').style.display = min ? '' : 'none'; // kompakter Überblick statt Kurzstatus
      if (min) renderMini(Date.now());
      const g = $('tamauto-grip'); if (g) g.style.display = min || !(matchMedia('(pointer: coarse)').matches || isAndroid) ? 'none' : '';
      GM_setValue('minimized', min);
      // Titelzeile im Fenster halten, wenn das Bedienfeld oben/links verankert ist
      if (p.style.left) { const r = p.getBoundingClientRect(); p.style.left = `${Math.max(0, Math.min(r.left, innerWidth - r.width))}px`; }
    };
    $('tamauto-min').onclick = () => setMinimized($('tamauto-body').style.display !== 'none');
    $('tamauto-min').title = 'Minimieren';

    // Position/Größe: oben links verankern (damit Ziehen und Größe ändern natürlich wirken) und speichern
    const anchorTopLeft = () => {
      const r = p.getBoundingClientRect();
      Object.assign(p.style, { left: `${r.left}px`, top: `${r.top}px`, right: 'auto', bottom: 'auto' });
    };
    const saveRect = () => {
      const r = p.getBoundingClientRect();
      GM_setValue('panelRect', { left: r.left, top: r.top, width: r.width, height: p.style.height && p.style.height !== 'auto' ? r.height : null });
    };
    const saved = GM_getValue('panelRect', null);
    if (saved) {
      p.style.width = `${Math.max(340, Math.min(saved.width, innerWidth * 0.95))}px`;
      if (saved.height) {
        p.style.height = `${Math.max(120, Math.min(saved.height, innerHeight * 0.95))}px`;
        $('tamauto-log').style.maxHeight = 'none'; // Log füllt die gewählte Höhe
      }
      // Position so begrenzen, dass das ganze Bedienfeld im Fenster liegt
      const r = p.getBoundingClientRect();
      Object.assign(p.style, { right: 'auto', bottom: 'auto',
        left: `${Math.max(0, Math.min(saved.left, innerWidth - r.width))}px`,
        top: `${Math.max(0, Math.min(saved.top, innerHeight - r.height))}px` });
    }

    // Position begrenzen: Das Bedienfeld darf teilweise aus dem Fenster geschoben werden, aber immer bleiben
    // mind. 80 px Breite und die ganze Titelzeile sichtbar – so lässt es sich jederzeit wieder zurückziehen.
    const KEEP = 80;
    const clampPos = (left, top) => {
      const r = p.getBoundingClientRect();
      const headH = $('tamauto-head').getBoundingClientRect().height + 24; // Titelzeile + Rand bequem greifbar
      return {
        left: Math.max(KEEP - r.width, Math.min(left, innerWidth - KEEP)),
        top: Math.max(0, Math.min(top, innerHeight - headH)),
      };
    };
    const applyPos = (left, top) => {
      const c = clampPos(left, top);
      Object.assign(p.style, { left: `${c.left}px`, top: `${c.top}px`, right: 'auto', bottom: 'auto' });
    };
    // Ziehen mit Pointer-Ereignissen: funktioniert mit Maus, Finger (Android) und Stift gleichermaßen
    const startDrag = (e) => {
      e.preventDefault();
      anchorTopLeft();
      const dx = e.clientX - p.offsetLeft, dy = e.clientY - p.offsetTop;
      const mv = (ev) => { ev.preventDefault(); applyPos(ev.clientX - dx, ev.clientY - dy); };
      const up = () => {
        document.removeEventListener('pointermove', mv); document.removeEventListener('pointerup', up);
        document.removeEventListener('pointercancel', up); saveRect();
      };
      document.addEventListener('pointermove', mv, { passive: false });
      document.addEventListener('pointerup', up); document.addEventListener('pointercancel', up);
    };
    // Randzone (6 px links/rechts/oben) ist ebenfalls ein Griff – falls die Titelzeile schlecht erreichbar ist
    const EDGE = 6;
    const edgeHit = (e) => {
      const r = p.getBoundingClientRect();
      if (e.clientX >= r.right - 18 && e.clientY >= r.bottom - 18) return false; // Ecke unten rechts = Größe ändern
      return e.clientX - r.left < EDGE || r.right - e.clientX < EDGE || e.clientY - r.top < EDGE;
    };

    // verschiebbar über die Titelzeile … (touch-action: none, damit der Finger nicht die Seite scrollt)
    $('tamauto-head').style.touchAction = 'none';
    $('tamauto-head').addEventListener('pointerdown', (e) => { if (e.target.id !== 'tamauto-min') { e.stopPropagation(); startDrag(e); } });
    // … oder über den äußeren Rand; Mauszeiger zeigt das an
    p.addEventListener('pointermove', (e) => { if (e.pointerType === 'mouse') p.style.cursor = edgeHit(e) ? 'move' : ''; });
    p.addEventListener('pointerdown', (e) => { if (e.pointerType === 'mouse' && edgeHit(e)) startDrag(e); });

    // Griff unten rechts zum Größe-Ändern per Finger (die Browser-Ecke funktioniert auf Touch-Geräten nicht)
    const grip = document.createElement('div');
    grip.id = 'tamauto-grip'; grip.title = 'Größe ändern';
    Object.assign(grip.style, { position: 'absolute', right: '0', bottom: '0', width: '22px', height: '22px', cursor: 'nwse-resize',
      touchAction: 'none', zIndex: '1', background: 'linear-gradient(135deg, transparent 55%, #1a4d8f 55%, #1a4d8f 62%, transparent 62%, transparent 72%, #1a4d8f 72%, #1a4d8f 79%, transparent 79%)' });
    grip.style.display = matchMedia('(pointer: coarse)').matches || isAndroid ? '' : 'none'; // nur auf Touch-Geräten
    p.style.position = 'fixed';
    p.appendChild(grip);
    grip.addEventListener('pointerdown', (e) => {
      e.preventDefault(); e.stopPropagation();
      anchorTopLeft();
      const r0 = p.getBoundingClientRect(), x0 = e.clientX, y0 = e.clientY;
      const mv = (ev) => {
        ev.preventDefault();
        p.style.width = `${Math.max(340, Math.min(innerWidth * 0.95, r0.width + ev.clientX - x0))}px`;
        p.style.height = `${Math.max(120, Math.min(innerHeight * 0.95, r0.height + ev.clientY - y0))}px`;
      };
      const up = () => {
        document.removeEventListener('pointermove', mv); document.removeEventListener('pointerup', up); document.removeEventListener('pointercancel', up);
        $('tamauto-log').style.maxHeight = 'none'; saveRect();
      };
      document.addEventListener('pointermove', mv, { passive: false });
      document.addEventListener('pointerup', up); document.addEventListener('pointercancel', up);
    });
    // Fenstergröße geändert → Bedienfeld wieder in den sichtbaren Bereich holen
    addEventListener('resize', () => { if (p.style.left) { const r = p.getBoundingClientRect(); applyPos(r.left, r.top); } });

    // Größe ändern über die Ecke unten rechts
    p.addEventListener('mousedown', (e) => {
      const r = p.getBoundingClientRect();
      if (e.clientX < r.right - 18 || e.clientY < r.bottom - 18) return;
      anchorTopLeft();
      document.addEventListener('mouseup', () => {
        if (p.style.height && p.style.height !== 'auto') $('tamauto-log').style.maxHeight = 'none';
        saveRect();
      }, { once: true });
    });
    if (GM_getValue('minimized', false)) setMinimized(true); // zuletzt minimiert → wieder minimiert starten
    renderStatus();
  }

  // Sofort prüfen, sobald sich die Tabelle ändert (Auto-Refresh, TAM-Autoaktualisierung, manueller Refresh, Tabwechsel)
  let obsTimer = null;
  function scheduleCheck(reason = 'Nachprüfung') {
    clearTimeout(obsTimer);
    obsTimer = setTimeout(() => cycle(reason), 800);
  }
  function watchGrid() {
    new MutationObserver((muts) => {
      if (muts.some((m) => m.type === 'attributes' && m.target.tagName === 'LI' && (m.target.id || '').includes('__'))) {
        updateTabStatus();
        checkTabEnter(); // zurück in "Veröffentlichte Aufträge" → einmal aktualisieren / Burst-Refresh
      }
      // TAM-Fenster zur Terminvergabe nach einer Annahme sofort wegklicken (ohne Verzögerung)
      if (muts.some((m) => m.type === 'childList' && [...m.addedNodes].some((n) => n.nodeType === 1 &&
        (n.matches('.x-window') || n.querySelector?.('.x-window'))))) { dismissUnavailable(); setTimeout(() => { dismissUnavailable(); dismissTerminDialog(); dismissTamErrors(); }, 50); }
      const panel = document.getElementById(cfg.tabPanelId);
      if (!panel) return;
      const relevant = muts.some((m) => m.type === 'childList' && panel.contains(m.target) && m.target.closest &&
        m.target.closest('.x-grid3-body, .x-grid3-scroller'));
      const tabSwitch = muts.some((m) => m.type === 'attributes' && m.target.tagName === 'LI' &&
        m.target.id && m.target.id.endsWith('__' + cfg.tabPanelId));
      // Anzeige "Letzter Refresh" auch bei Refresh von außen – unabhängig von Start/Stop
      // (nicht während einer Annahme: Änderungen durch die Annahme selbst sind kein TAM-Takt)
      const src = relevant && !ownRefresh && !busy ? noteExternalRefresh() : '';
      if (!cfg.enabled) return;
      if (!relevant && !tabSwitch) return;
      // Während einer Prüfung/Annahme nicht verwerfen, sondern direkt danach erneut prüfen
      if (busy) { recheck = true; return; }
      scheduleCheck(tabSwitch ? 'Reiterwechsel' : src ? `Refresh (${src})` : 'Tabelle aktualisiert');
    }).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
  }

  // ------------------------------------------------------------------ Lizenz
  // Lizenzschlüssel "TAM1.<daten>.<signatur>": Daten (ID, Name, gültig bis) mit ECDSA P-256 signiert.
  // Hier steht nur der öffentliche Schlüssel – Lizenzen erstellen kann nur, wer den privaten hat.
  // Jede Installation hat eine eigene ID → ein Schlüssel funktioniert nur in dieser einen Installation.
  const LICENSE_PUBKEY = { kty: 'EC', crv: 'P-256',
    x: '4MkRZl6c7clzD5iIL8m0nwsN0Y6IJRnpJ_C6bcHE64Q', y: '9ymeLeXvTLNSUCWqYVZzLrbSTSEkQFHdbV7WKnIhxlc' };
  let license = null; // gültige Lizenzdaten nach der Prüfung

  // ID und Schlüssel liegen doppelt: im Tampermonkey-Speicher und als Sicherung im Browser-Speicher der
  // TAM-Seite. So bleibt die Aktivierung auch erhalten, wenn das Script neu installiert wird (z. B. über den
  // Installationslink statt per Update). Nur ein Löschen der Browserdaten erfordert eine neue Aktivierung.
  const backupGet = (k) => { try { return localStorage.getItem(`tamauto.${k}`) || ''; } catch (e) { return ''; } };
  const backupSet = (k, v) => { try { localStorage.setItem(`tamauto.${k}`, v); } catch (e) { /* ignore */ } };
  const ID_RE = /^[A-Z2-7]{4}(-[A-Z2-7]{4}){3}$/;

  function installId() {
    let id = GM_getValue('installId', '');
    if (!ID_RE.test(id)) id = backupGet('installId');
    if (!ID_RE.test(id)) {
      const abc = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
      const r = crypto.getRandomValues(new Uint8Array(16));
      id = [...r].map((b) => abc[b % 32]).join('').replace(/(.{4})(?!$)/g, '$1-');
    }
    if (GM_getValue('installId', '') !== id) GM_setValue('installId', id);
    if (backupGet('installId') !== id) backupSet('installId', id);
    return id;
  }
  const getLicenseKey = () => GM_getValue('licenseKey', '') || backupGet('licenseKey');
  const setLicenseKey = (k) => { GM_setValue('licenseKey', k); backupSet('licenseKey', k); };

  const fromB64Url = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));
  const fmtDate = (iso) => iso.split('-').reverse().join('.');

  async function checkLicense(key) {
    const m = String(key || '').trim().match(/^TAM1\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/);
    if (!m) return { ok: false, reason: key ? 'Lizenzschlüssel hat ein ungültiges Format.' : 'Keine Lizenz aktiviert.' };
    try {
      const pub = await crypto.subtle.importKey('jwk', LICENSE_PUBKEY, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
      const valid = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pub, fromB64Url(m[2]), new TextEncoder().encode(m[1]));
      if (!valid) return { ok: false, reason: 'Lizenzschlüssel ist ungültig.' };
      const lic = JSON.parse(new TextDecoder().decode(fromB64Url(m[1])));
      if (lic.v !== 1) return { ok: false, reason: 'Lizenzschlüssel ist ungültig.' };
      if (lic.id !== installId()) return { ok: false, reason: 'Lizenzschlüssel gehört zu einer anderen Installation.' };
      if (!/^\d{4}-\d{2}-\d{2}$/.test(lic.exp || '')) return { ok: false, reason: 'Lizenzschlüssel ist nicht befristet und daher ungültig.' };
      if (lic.exp < today()) return { ok: false, reason: `Lizenz ist am ${fmtDate(lic.exp)} abgelaufen.` };
      return { ok: true, lic };
    } catch (e) {
      return { ok: false, reason: 'Lizenzschlüssel ist ungültig.' };
    }
  }

  // Bedienfeld ohne gültige Lizenz: nur Installations-ID und Schlüsseleingabe – das Script tut sonst nichts
  function buildLicensePanel(reason) {
    const p = document.createElement('div');
    p.id = 'tamauto';
    p.innerHTML = `
      <b>TAM Auto-Annahme v${VERSION}</b> <span style="color:#555">– © IB Thomée GmbH</span>
      <div style="margin:6px 0;color:#c62828;font-weight:bold">Lizenz erforderlich: ${reason}</div>
      <div>Diese Installations-ID an IB Thomée schicken, um einen Lizenzschlüssel zu erhalten:</div>
      <div style="display:flex;gap:6px;align-items:center;margin:4px 0">
        <code id="tamauto-lic-id" style="font-size:14px;font-weight:bold;letter-spacing:1px">${installId()}</code>
        <button id="tamauto-lic-copy">Kopieren</button></div>
      <textarea id="tamauto-lic-key" placeholder="Lizenzschlüssel (beginnt mit TAM1.)" style="width:100%;height:60px;font:11px monospace"></textarea>
      <div style="display:flex;gap:6px;align-items:center;margin-top:4px">
        <button id="tamauto-lic-ok">Aktivieren</button><span id="tamauto-lic-msg" style="color:#c62828"></span></div>
      <a id="tamauto-update" href="${UPDATE_URL}" target="_blank" style="display:none;font-weight:bold;color:#1a4d8f;margin-top:4px"></a>`;
    Object.assign(p.style, { position: 'fixed', right: '12px', bottom: '12px', width: '420px', zIndex: 99999,
      background: '#fff', border: '2px solid #c62828', borderRadius: '6px', padding: '8px',
      font: '12px Arial, sans-serif', boxShadow: '0 4px 14px rgba(0,0,0,.25)' });
    p.querySelectorAll('button').forEach((b) => Object.assign(b.style,
      { padding: '3px 8px', border: '1px solid #1a4d8f', borderRadius: '3px', background: '#e8f0fb', cursor: 'pointer' }));
    document.body.appendChild(p);
    const $ = (id) => document.getElementById(id);
    $('tamauto-lic-copy').onclick = () => { navigator.clipboard.writeText(installId()).then(() => { $('tamauto-lic-copy').textContent = 'Kopiert ✓'; }); };
    $('tamauto-lic-ok').onclick = async () => {
      const key = $('tamauto-lic-key').value.trim();
      const res = await checkLicense(key);
      if (!res.ok) { $('tamauto-lic-msg').textContent = res.reason; return; }
      setLicenseKey(key);
      $('tamauto-lic-msg').style.color = '#2e7d32';
      $('tamauto-lic-msg').textContent = `Aktiviert für ${res.lic.name}, gültig bis ${fmtDate(res.lic.exp)} – lade neu …`;
      setTimeout(() => location.reload(), 1200);
    };
  }

  // ------------------------------------------------------------------ Start
  waitFor(() => document.querySelector('.x-viewport'), 30000).then(async () => {
    const storedKey = getLicenseKey();
    const lc = await checkLicense(storedKey);
    if (lc.ok) setLicenseKey(storedKey); // Sicherung/Tampermonkey-Speicher gegenseitig auffüllen
    if (!lc.ok) {
      buildLicensePanel(lc.reason);
      checkUpdate(); // Updates auch ohne Lizenz
      return;
    }
    license = lc.lic;
    buildPanel();
    watchGrid();
    wasOnPublished = onPublishedTab(); // Ausgangszustand für die Tabwechsel-Erkennung
    setInterval(dismissUnavailable, 250); // Sofort-Wächter für "nicht verfügbar" / "bereits vergeben" (auch wiederverwendete Fenster)
    const age = places.loadedAt ? Date.now() - new Date(places.loadedAt).getTime() : Infinity;
    // Excel (Ortsliste + Sperrliste) beim Start laden, wenn älter als 30 min oder altes Format, danach alle 30 min
    const reloadMs = cfg.placesReloadMin * 60 * 1000;
    if (age > reloadMs || places.v !== 2 || !places.block) loadPlacesFromSheet();
    setInterval(loadPlacesFromSheet, reloadMs);
    restartTimer();
    if (cfg.enabled) cycle('Start');
    // Update-Prüfung beim Start (max. alle 6 h) und danach alle 6 h
    if (Date.now() - GM_getValue('lastUpdateCheck', 0) > 6 * 3600 * 1000) checkUpdate();
    setInterval(checkUpdate, 6 * 3600 * 1000);
  });
})();