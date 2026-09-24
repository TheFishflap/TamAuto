// ==UserScript==
// @name         TAM Auto-Annahme (IB Thomée GmbH)
// @namespace    ib-thomee
// @version      1.6.1
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
    intervalSec: 30,          // Prüf-/Refresh-Intervall (Sekunden)
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
    intervalSec: GM_getValue('intervalSec', DEFAULTS.intervalSec),
    // eigener Schlüssel seit Wegfall des Testmodus: wer im Testmodus lief, startet nicht ungefragt live
    enabled: GM_getValue('running', DEFAULTS.enabled),
    maxPerCycle: GM_getValue('maxPerCycle', DEFAULTS.maxPerCycle),
    autoRefresh: GM_getValue('autoRefresh', true),
    // Protokoll im Bedienfeld ("Console Log"), Standard aus. Neuer Schlüssel ab 1.6.1, damit ein früher
    // eingeschaltetes Log nach dem Update bei allen aus ist.
    consoleLog: GM_getValue('consoleLogV2', false),
    delayOn: GM_getValue('delayOn', false),       // Verzögerung vor jedem Klickschritt der Annahme
    delaySec: Math.min(2, GM_getValue('delaySec', 0.5)), // 0,0–2,0 s in 0,1-s-Schritten
    delayRandom: GM_getValue('delayRandom', true), // + zufällige Streuung
    delayRandomMs: GM_getValue('delayRandomMs', 180), // Streuung 0 … x ms
  });

  let places = GM_getValue('places', { plz: [], orte: [], loadedAt: null, source: '' });
  let done = new Set(GM_getValue('doneRefs', [])); // bereits bearbeitete Aufträge
  let timer = null;
  let lastRefreshOk = null;
  let busy = false;
  let recheck = false; // Tabelle hat sich geändert, während busy war

  function releaseBusy() {
    busy = false;
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

  // Protokoll im Bedienfeld ("Console Log", ein-/ausblendbar). level 'debug' = Details wie Verzögerungen.
  function log(msg, level = 'info') {
    const line = `${new Date().toLocaleTimeString('de-DE')}  ${msg}`;
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
    try { GM_notification({ title, text: body, timeout: 15000 }); } catch (e) { /* ignore */ }
    chime();
  }

  // Sanfter Zwei-Ton-Gong (E5 → A5) mit weichem Ein- und Ausklingen statt hartem Piepton
  function chime() {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const t0 = ctx.currentTime;
      [[659.25, 0], [880, 0.18]].forEach(([freq, delay]) => {
        const o = ctx.createOscillator(); const g = ctx.createGain();
        o.type = 'sine'; o.frequency.value = freq;
        g.gain.setValueAtTime(0.0001, t0 + delay);
        g.gain.exponentialRampToValueAtTime(0.18, t0 + delay + 0.02);
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

  function loadPlacesFromText(t) {
    places = Object.assign(extractPlaces(parseCSV(t), 'manuell'), { block: places.block }); // Excel-Sperrliste behalten
    GM_setValue('places', places);
    log(`Manuelle Liste übernommen: ${places.plz.length} PLZ, ${places.orte.length} Orte`, 'ok');
    renderStatus();
  }

  function matches(order) {
    // Treffer, wenn die PLZ mit einem Listeneintrag beginnt ODER der Ort (Listenzeile ohne PLZ) passt
    const p = (order.plz || '').trim();
    return places.plz.some((x) => p.startsWith(x)) || places.orte.includes(norm(order.ort));
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

  function recordOrder(o) {
    const book = GM_getValue('orderbook', []);
    const ts = new Date().toISOString();
    book.push({ ts, nr: o.nr, plz: o.plz, ort: o.ort, dienst: o.dienst, preis: parseEuro(o.preis) });
    // 0-km-Aufträge: gleicher Ort, Preis steht in der Tabelle nicht zur Verfügung
    (o.extra || []).forEach((x) => book.push({ ts, nr: x, plz: o.plz, ort: o.ort, dienst: `0 km zu ${o.nr}`, preis: null }));
    GM_setValue('orderbook', book.slice(-5000));
    renderOrderbook();
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
        e.nr, e.plz, e.ort, e.preis == null ? '–' : fmtEuro(e.preis)].forEach((v, i) => {
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
    const tab = document.querySelector('.tamauto-tabbtn[data-page="tamauto-page-adv"]');
    if (tab) tab.textContent = `Erweiterte Einstellungen${n ? ` (${n} gesperrt)` : ''}`;
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
  function noteExternalRefresh() {
    const src = Date.now() - manualClickAt < 15000 ? 'manuell' : 'TAM';
    clearTimeout(refreshNoteTimer); // eine Aktualisierung erzeugt viele DOM-Änderungen → einmal melden
    refreshNoteTimer = setTimeout(() => {
      setRefreshStatus(`Letzter Refresh: ${new Date().toLocaleTimeString('de-DE')} ✓ (${src})`);
      if (!cfg.enabled) log(`Refresh (${src}) – Tabelle neu geladen; Script gestoppt, kein Abgleich.`);
    }, 500);
    return src;
  }
  document.addEventListener('click', (e) => {
    if (!e.isTrusted) return; // nur echte Klicks, nicht die des Scripts
    const panel = activeTabPanel();
    const btn = panel && findRefreshButton(panel);
    if (btn && btn.contains(e.target)) manualClickAt = Date.now();
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
  // eingestellte Sekunden (0,0–2,0) + optional Randomizer (zufällig 0 … x ms), bei jedem Schritt neu gewürfelt.
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
    // TAM springt nach der Annahme ggf. in einen anderen Reiter → sofort zurück
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
    try {
      if (!places.plz.length && !places.orte.length) { log('Keine Ortsliste geladen – übersprungen.', 'err'); return; }
      if (!onPublishedTab()) {
        setStatus(`Pausiert – Tab "${cfg.tabName}" ist nicht aktiv`); updateTabStatus(); return;
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
      // Gesperrte (Tages-Blacklist) nicht annehmen, aber auch nicht als erledigt merken → morgen wieder möglich
      const hits = orders.filter((o) => matches(o) && !blocked(o));
      const blockedHits = orders.filter((o) => matches(o) && blocked(o));
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
        // Vor jeder Annahme erneut prüfen: richtiger Tab, Zeile noch in dieser Tabelle
        if (!onPublishedTab() || visibleGrid() !== grid || !grid.contains(o.row)) {
          log('Abbruch: Tab gewechselt oder Tabelle neu geladen – keine Annahme.', 'err'); recheck = true; break;
        }
        log(`Nehme an: ${desc}`);
        const ok = await acceptOrder(o);
        if (ok) {
          const plus = (o.extra || []).length ? ` + ${o.extra.join(', ')} (0 km)` : '';
          log(`Angenommen: ${desc}${plus}`, 'ok'); notify('TAM: Auftrag angenommen', desc + plus);
          done.add(o.key); (o.extra || []).forEach((x) => done.add(x)); n++;
          recordOrder(o);
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

  // Ein Takt: erst Refresh der Website (falls Auto-Refresh an), danach Abgleich mit der Ortsliste
  async function tick() {
    if (license && license.exp < today()) { location.reload(); return; } // Lizenz abgelaufen → Aktivierungsfeld
    renderBlacklist(); // nach Mitternacht Anzeige leeren
    if (busy || !onPublishedTab()) return;
    let refreshed = false;
    if (cfg.autoRefresh) {
      busy = true; // eigene Tabellenänderungen beim Refresh nicht doppelt auswerten
      ownRefresh = true;
      try { refreshed = await refreshGrid(); } finally { busy = false; recheck = false; ownRefresh = false; }
    }
    await cycle(refreshed ? 'Refresh' : 'Intervall');
  }

  function updateRefreshStatus() {
    setRefreshStatus(cfg.autoRefresh ? `Auto-Refresh alle ${cfg.intervalSec} s` : 'Auto-Refresh aus');
  }

  function restartTimer() {
    clearInterval(timer);
    timer = setInterval(tick, cfg.intervalSec * 1000); // läuft immer: Auto-Refresh ist unabhängig von Start/Stop
    updateRefreshStatus();
  }

  // ------------------------------------------------------------------ Bedienfeld
  function setStatus(s) { const el = document.getElementById('tamauto-status'); if (el) el.textContent = s; }
  function renderStatus() {
    const el = document.getElementById('tamauto-places');
    const xb = places.block || { plz: [], orte: [] };
    if (el) el.textContent = `Ortsliste: ${places.plz.length} PLZ / ${places.orte.length} Orte · ` +
      `Sperrliste: ${xb.plz.length + xb.orte.length}` +
      (places.loadedAt ? ` (geladen ${new Date(places.loadedAt).toLocaleString('de-DE')})` : ' – nicht geladen');
    const btn = document.getElementById('tamauto-toggle');
    if (btn) { btn.textContent = cfg.enabled ? '■ Stop' : '▶ Start'; btn.style.background = cfg.enabled ? '#c62828' : '#2e7d32'; }
    updateTabStatus();
  }

  function buildPanel() {
    const p = document.createElement('div');
    p.id = 'tamauto';
    p.innerHTML = `
      <div id="tamauto-head" style="display:flex;justify-content:space-between;align-items:center;cursor:move">
        <b>TAM Auto-Annahme v${VERSION}</b><span id="tamauto-min" style="cursor:pointer;padding:0 4px">–</span></div>
      <div id="tamauto-body">
        <a id="tamauto-update" href="${UPDATE_URL}" target="_blank" style="display:none;font-weight:bold;color:#1a4d8f;margin:4px 0"></a>
        <div id="tamauto-tab" style="font-weight:bold;margin:4px 0"></div>
        <div id="tamauto-places"></div>
        <div id="tamauto-status" style="color:#555">bereit</div>
        <div id="tamauto-refresh" style="color:#555"></div>
        <div style="display:flex;flex-wrap:wrap;gap:2px;margin-top:6px;border-bottom:2px solid #1a4d8f">
          <button class="tamauto-tabbtn" data-page="tamauto-page-main">Bedienung</button>
          <button class="tamauto-tabbtn" data-page="tamauto-page-adv">Erweiterte Einstellungen</button>
          <button class="tamauto-tabbtn" data-page="tamauto-page-book">Auftragsbuch</button>
        </div>
        <div id="tamauto-page-adv" style="display:none;margin:6px 0">
          <b>Tages-Blacklist</b> <span style="color:#555">– gilt nur heute, um Mitternacht automatisch leer</span>
          <div style="color:#555;margin:2px 0 4px">PLZ, die heute <b>nicht</b> angenommen werden, z. B. nach Storno
            (sonst würde der Auftrag erneut angenommen). 2–5 Ziffern: „43“ sperrt alle 43xxx, „47877“ nur diese PLZ.</div>
          <div style="display:flex;gap:6px;align-items:center">
            <input id="tamauto-bl-in" placeholder="PLZ, z. B. 47877" maxlength="5" style="width:110px">
            <button id="tamauto-bl-add">Sperren</button>
            <button id="tamauto-bl-clear">Alle freigeben</button>
          </div>
          <div id="tamauto-bl-list" style="margin-top:6px;display:flex;gap:4px;flex-wrap:wrap"></div>
          <div style="margin-top:8px"><b>Aus Excel</b> <span style="color:#555">– Blatt „nicht annehmen“, ändern nur im Excel</span>
            <button id="tamauto-bl-reload" style="margin-left:4px">Neu laden</button></div>
          <div id="tamauto-bl-excel" style="margin-top:4px;display:flex;gap:4px;flex-wrap:wrap"></div>
          <div style="margin-top:10px;padding-top:6px;border-top:1px solid #ddd">
            <label class="tamauto-chk" title="Wartet vor jedem Klickschritt der Annahme">
              <input type="checkbox" id="tamauto-delay-on"> <b>Verzögerung</b></label>
            <span style="color:#555"> – vor jedem Klickschritt der Annahme</span>
            <div class="tamauto-chk" style="margin-top:4px">
              <input type="range" id="tamauto-delay" min="0" max="2" step="0.1" style="width:140px;margin:0">
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
            <span style="color:#555"> – Protokoll des Scripts unten im Bedienfeld anzeigen</span>
          </div>
          <div id="tamauto-lic-info" style="margin-top:10px;padding-top:6px;border-top:1px solid #ddd;color:#555"></div>
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
        </div>
        <div id="tamauto-page-main" style="margin:6px 0;display:flex;gap:6px;flex-wrap:wrap;align-items:center">
          <button id="tamauto-toggle"></button>
          <button id="tamauto-load" title="Lädt Ortsliste (Blatt „annehmen“) und Sperrliste (Blatt „nicht annehmen“) neu">Ortslisten laden</button>
          <button id="tamauto-paste">Liste einfügen</button>
          <span class="tamauto-chk" title="Klickt alle x Sekunden den Refresh-Pfeil der Tabelle – unabhängig von Start/Stop">
            <label class="tamauto-chk"><input type="checkbox" id="tamauto-ar"> Auto-Refresh</label>
            alle <input id="tamauto-int" type="number" min="15" style="width:48px;margin:0" value="${cfg.intervalSec}"> s</span>
          <button id="tamauto-once" title="Nimmt den obersten Auftrag der Tabelle EINMAL verbindlich an – ohne Ortsliste">Auftrag 1. Zeile annehmen</button>
          <button id="tamauto-upd" title="Sucht auf GitHub nach einer neuen Version">Softwareupdate</button>
        </div>
        <textarea id="tamauto-ta" placeholder="PLZ;Ort je Zeile (oder CSV mit Kopfzeile PLZ/Ort)" style="display:none;width:100%;height:80px"></textarea>
        <div id="tamauto-log" style="max-height:220px;overflow:auto;font:11px monospace;border-top:1px solid #ddd;padding-top:4px"></div>
      </div>`;
    Object.assign(p.style, { position: 'fixed', right: '12px', bottom: '12px', width: '420px', zIndex: 99999,
      background: '#fff', border: '2px solid #1a4d8f', borderRadius: '6px', padding: '8px',
      font: '12px Arial, sans-serif', boxShadow: '0 4px 14px rgba(0,0,0,.25)' });
    p.querySelectorAll('button').forEach((b) => Object.assign(b.style,
      { padding: '3px 8px', border: '1px solid #1a4d8f', borderRadius: '3px', background: '#e8f0fb', cursor: 'pointer' }));
    // Checkbox und Text auf einer Linie (TAM-CSS verschiebt Checkboxen sonst nach oben)
    p.querySelectorAll('.tamauto-chk').forEach((el) => Object.assign(el.style,
      { display: 'inline-flex', alignItems: 'center', gap: '4px', whiteSpace: 'nowrap', margin: '0', cursor: 'pointer' }));
    p.querySelectorAll('input[type=checkbox]').forEach((cb) => Object.assign(cb.style,
      { margin: '0', verticalAlign: 'middle', position: 'static', top: '0' }));
    document.body.appendChild(p);
    document.getElementById('tamauto-toggle').style.color = '#fff';

    const $ = (id) => document.getElementById(id);
    $('tamauto-toggle').onclick = () => {
      cfg.enabled = !cfg.enabled; GM_setValue('running', cfg.enabled);
      log(cfg.enabled ? 'Gestartet' : 'Gestoppt'); renderStatus();
      if (cfg.enabled) cycle('Start');
    };
    $('tamauto-ar').checked = cfg.autoRefresh;
    $('tamauto-ar').onchange = (e) => { cfg.autoRefresh = e.target.checked; GM_setValue('autoRefresh', cfg.autoRefresh); lastRefreshOk = null; updateRefreshStatus(); };
    $('tamauto-int').onchange = (e) => {
      cfg.intervalSec = Math.max(15, parseInt(e.target.value, 10) || 30); GM_setValue('intervalSec', cfg.intervalSec); restartTimer();
    };
    $('tamauto-load').onclick = () => loadPlacesFromSheet(true);
    $('tamauto-paste').onclick = () => {
      const ta = $('tamauto-ta');
      if (ta.style.display === 'none') { ta.style.display = 'block'; $('tamauto-paste').textContent = 'Übernehmen'; }
      else { if (ta.value.trim()) loadPlacesFromText(ta.value); ta.style.display = 'none'; $('tamauto-paste').textContent = 'Liste einfügen'; }
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
        log(`Annahme 1. Zeile gestartet: ${o.nr} · ${o.plz} ${o.ort}`);
        const ok = await acceptOrder(o);
        const plus = (o.extra || []).length ? ` + ${o.extra.join(', ')} (0 km)` : '';
        log(ok ? `Annahme 1. Zeile erfolgreich: ${o.nr}${plus}` : `Annahme 1. Zeile fehlgeschlagen: ${o.nr}`, ok ? 'ok' : 'err');
        if (ok) { done.add(o.nr); (o.extra || []).forEach((x) => done.add(x)); GM_setValue('doneRefs', [...done].slice(-2000)); recordOrder(o); }
      } finally { releaseBusy(); }
    };
    $('tamauto-upd').onclick = () => checkUpdate(true);

    // Reiter im Bedienfeld
    const showPage = (id) => {
      p.querySelectorAll('.tamauto-tabbtn').forEach((b) => {
        const on = b.dataset.page === id;
        $(b.dataset.page).style.display = on ? (id === 'tamauto-page-main' ? 'flex' : 'block') : 'none';
        Object.assign(b.style, { background: on ? '#1a4d8f' : '#e8f0fb', color: on ? '#fff' : '#000',
          borderRadius: '3px 3px 0 0', borderBottom: 'none' });
      });
      if (id === 'tamauto-page-main') $('tamauto-ta').style.display = 'none';
      if (id === 'tamauto-page-adv') renderBlacklist();
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
    const fmtSec = (v) => `${v.toFixed(1).replace('.', ',')} s`;
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
      cfg.delayOn = e.target.checked; GM_setValue('delayOn', cfg.delayOn); renderDelay();
      log(cfg.delayOn ? `An: ${delayInfo()}` : 'Verzögerung aus.');
    };
    $('tamauto-delay').oninput = (e) => {
      cfg.delaySec = Math.round(Math.min(2, Math.max(0, +e.target.value || 0)) * 10) / 10; renderDelay();
    };
    $('tamauto-delay').onchange = () => { GM_setValue('delaySec', cfg.delaySec); log(delayInfo()); };
    $('tamauto-delay-rnd').onchange = (e) => {
      cfg.delayRandom = e.target.checked; GM_setValue('delayRandom', cfg.delayRandom); renderDelay(); log(delayInfo());
    };
    $('tamauto-delay-ms').onchange = (e) => {
      cfg.delayRandomMs = Math.round(Math.min(2000, Math.max(0, +e.target.value || 0)));
      GM_setValue('delayRandomMs', cfg.delayRandomMs); renderDelay(); log(delayInfo());
    };
    renderDelay();

    // Lizenzinfo; ab 30 Tagen vor Ablauf deutlicher Hinweis
    const daysLeft = Math.ceil((new Date(`${license.exp}T23:59:59`) - Date.now()) / 864e5);
    $('tamauto-lic-info').innerHTML = `<b>Lizenz:</b> ${license.name} · gültig bis ${fmtDate(license.exp)}` +
      (daysLeft <= 30 ? ` <b style="color:#c62828">(noch ${daysLeft} Tage – neue Lizenz anfordern)</b>` : '') +
      `<br>Installations-ID: ${installId()} · © IB Thomée GmbH – Veränderung und Weitergabe nicht gestattet`;
    if (daysLeft <= 30) {
      const w = document.createElement('div');
      Object.assign(w.style, { color: '#c62828', fontWeight: 'bold', margin: '4px 0' });
      w.textContent = `Lizenz läuft am ${fmtDate(license.exp)} ab (noch ${daysLeft} Tage) – neue Lizenz bei IB Thomée anfordern.`;
      $('tamauto-body').prepend(w);
    }

    // Console Log: Protokoll des Scripts ein-/ausblenden (keine Ausgaben in die Browser-Konsole)
    const renderConsole = () => { $('tamauto-consolelog').checked = cfg.consoleLog; $('tamauto-log').style.display = cfg.consoleLog ? '' : 'none'; };
    $('tamauto-consolelog').onchange = (e) => { cfg.consoleLog = e.target.checked; GM_setValue('consoleLogV2', cfg.consoleLog); renderConsole(); };
    renderConsole();

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
  function scheduleCheck(reason = 'Nachprüfung') {
    clearTimeout(obsTimer);
    obsTimer = setTimeout(() => cycle(reason), 800);
  }
  function watchGrid() {
    new MutationObserver((muts) => {
      if (muts.some((m) => m.type === 'attributes' && m.target.tagName === 'LI' && (m.target.id || '').includes('__'))) {
        updateTabStatus();
      }
      const panel = document.getElementById(cfg.tabPanelId);
      if (!panel) return;
      const relevant = muts.some((m) => m.type === 'childList' && panel.contains(m.target) && m.target.closest &&
        m.target.closest('.x-grid3-body, .x-grid3-scroller'));
      const tabSwitch = muts.some((m) => m.type === 'attributes' && m.target.tagName === 'LI' &&
        m.target.id && m.target.id.endsWith('__' + cfg.tabPanelId));
      // Anzeige "Letzter Refresh" auch bei Refresh von außen – unabhängig von Start/Stop
      const src = relevant && !ownRefresh ? noteExternalRefresh() : '';
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

  function installId() {
    let id = GM_getValue('installId', '');
    if (!/^[A-Z2-7]{4}(-[A-Z2-7]{4}){3}$/.test(id)) {
      const abc = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
      const r = crypto.getRandomValues(new Uint8Array(16));
      id = [...r].map((b) => abc[b % 32]).join('').replace(/(.{4})(?!$)/g, '$1-');
      GM_setValue('installId', id);
    }
    return id;
  }

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
      GM_setValue('licenseKey', key);
      $('tamauto-lic-msg').style.color = '#2e7d32';
      $('tamauto-lic-msg').textContent = `Aktiviert für ${res.lic.name}, gültig bis ${fmtDate(res.lic.exp)} – lade neu …`;
      setTimeout(() => location.reload(), 1200);
    };
  }

  // ------------------------------------------------------------------ Start
  waitFor(() => document.querySelector('.x-viewport'), 30000).then(async () => {
    const lc = await checkLicense(GM_getValue('licenseKey', ''));
    if (!lc.ok) {
      buildLicensePanel(lc.reason);
      checkUpdate(); // Updates auch ohne Lizenz
      return;
    }
    license = lc.lic;
    buildPanel();
    watchGrid();
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