// Testumgebung: lädt das echte Script in jsdom auf Basis echter TAM-Mitschnitte (test/fixtures/, nur lokal –
// Erzeugung siehe docs/TAM-DEBUG.md Abschnitt 9) und bildet das Verhalten von TAM nach, das im Mitschnitt fehlt:
// Reiterwechsel, Doppelklick → Auftragskarte, 0 km → Warenkorb, Annehmen → Bestätigen.
// Lizenz: Signaturprüfung wird im Test als gültig vorgetäuscht (crypto.subtle), der Inhalt (ID, Ablauf) wird echt geprüft.
'use strict';
const { JSDOM, VirtualConsole } = require('jsdom');
const fs = require('fs');
const path = require('path');
const util = require('util');
const { webcrypto } = require('crypto');

const SCRIPT_PATH = path.join(__dirname, '..', 'tam-auto-annahme.user.js');
const FIXTURES = path.join(__dirname, 'fixtures');
const INSTALL_ID = 'TEST-AAAA-BBBB-CCCC';
const REVOKE_MARK = 'IQBmSNFRkXF5'; // Teil des Freigabelinks der Sperrliste (REVOKE_URL im Script)

const b64u = (o) => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)).toString('base64url');
const licenseKey = (p = {}) => `TAM1.${b64u({ v: 1, id: INSTALL_ID, name: 'Test', exp: '2099-12-31', ...p })}.${b64u('sig')}`;
const revocationList = (ids = [], issued = '2026-10-01') => `TAMR1.${b64u({ v: 1, issued, ids })}.${b64u('sig')}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fixture(name) {
  const f = path.join(FIXTURES, `${name}.html`);
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null;
}
const hasFixtures = (...names) => names.every((n) => fs.existsSync(path.join(FIXTURES, `${n}.html`)));

async function until(fn, timeout = 5000, step = 20) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) { const v = fn(); if (v) return v; await sleep(step); }
  return null;
}

const PUB_COLS = ['slaBeginnAgent', 'slaEndeAgent', 'teilAuftragNr', 'cst_projekt_dienstleistung_name', 'referenz', 'status',
  'termin', 'besichtigungsStrasse', 'besichtigungsPlz', 'besichtigungsOrt', 'preis'];
const btnHtml = (t, cls = '') => `<table class="x-btn x-component x-btn-noicon ${cls}"><tbody><tr><td class="x-btn-mc"><em>` +
  `<button class="x-btn-text" type="button">${t}</button></em></td></tr></tbody></table>`;

// opts: html (Mitschnitt), gm (Tampermonkey-Speicher), local (localStorage der TAM-Seite), sigValid, xhr(o) → Antwort,
//       tab ('published' | 'accepted' – Ausgangsreiter), keepWindows (Fenster aus dem Mitschnitt offen lassen)
function startTam(opts = {}) {
  const html = (opts.html || fixture('angenommen-detail')).replace(/^<!--[^]*?-->\s*/, '');
  // Fehler aus Timern des Scripts nach tam.close() (Fenster schon weg) nicht melden – alle anderen schon
  let closed = false;
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (e) => { if (!closed) console.error(e); });
  const dom = new JSDOM(`<!DOCTYPE html><html><head><script src="de.tomcom.tam.TAM.nocache.js"></script></head>${html}</html>`,
    { url: 'https://tam.tuvsud.com/', runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole });
  const w = dom.window, d = w.document;

  // Sichtbarkeit wie im Browser: x-hide-display oder display:none an einem Vorfahren → unsichtbar
  Object.defineProperty(w.HTMLElement.prototype, 'offsetParent', { configurable: true, get() {
    for (let e = this; e; e = e.parentElement) if (e.classList.contains('x-hide-display') || e.style.display === 'none') return null;
    return this.parentElement;
  } });

  // Fenster aus dem Mitschnitt (z. B. Detailansicht) zunächst schließen und für showWindow() aufheben
  const savedWindows = [...d.querySelectorAll('.x-window')].map((x) => { const h = x.outerHTML; if (!opts.keepWindows) x.remove(); return h; });

  // ---- Tampermonkey / Browser-APIs
  const store = new Map(Object.entries({
    installId: INSTALL_ID, licenseKey: licenseKey(), delayOnV2: false, running: true,
    silentOn: false, // Silent Reload (Standard im Script: an) läuft in der Arbeitszeit mit und würde die Tests von der Tageszeit abhängig machen; silentOn: 'default' = Standard des Scripts
    startTabs: false, // Start-Routine (beide Reiter öffnen) stört die übrigen Tests nicht; eigener Test setzt true
    accSyncAt: Date.now(), // MA-Management gleicht beim Öffnen mit TAM ab – in den übrigen Tests nicht
    places: { v: 2, plz: [], orte: [], block: { plz: [], orte: [] }, loadedAt: new Date().toISOString(), source: 'Test' },
    ...(opts.gm || {}),
  }));
  // wie Tampermonkey: Werte werden als Kopie gespeichert und geliefert (keine geteilten Objekte zwischen Tests/Aufrufen)
  const copy = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));
  store.forEach((v, k) => store.set(k, copy(v)));
  if (store.get('silentOn') === 'default') store.delete('silentOn');
  w.GM_getValue = (k, def) => (store.has(k) ? copy(store.get(k)) : def);
  w.GM_setValue = (k, v) => store.set(k, copy(v));
  w.GM_info = { script: { version: (fs.readFileSync(SCRIPT_PATH, 'utf8').match(/@version\s+(\S+)/) || [])[1] } };
  w.GM_notification = () => {};
  const requests = [];
  w.GM_xmlhttpRequest = (o) => {
    requests.push(o);
    const res = opts.xhr ? opts.xhr(o) : (o.url.includes(REVOKE_MARK) ? { status: 200, responseText: revocationList() } : { error: true });
    if (res) setTimeout(() => (res.error ? o.onerror && o.onerror() : res.timeout ? o.ontimeout && o.ontimeout() : o.onload(res)), 0);
  };
  Object.entries(opts.local || {}).forEach(([k, v]) => w.localStorage.setItem(`tamauto.${k}`, v));
  const sigValid = opts.sigValid !== false;
  // echte Web-Crypto (ECDH, AES, HMAC …); nur die ECDSA-Signaturprüfung der Lizenz/Sperrliste wird vorgetäuscht
  const subtle = {};
  for (const k of ['importKey', 'exportKey', 'generateKey', 'deriveBits', 'deriveKey', 'encrypt', 'decrypt', 'sign', 'digest']) subtle[k] = webcrypto.subtle[k].bind(webcrypto.subtle);
  subtle.verify = async (alg, ...r) => (alg && alg.name === 'ECDSA' ? sigValid : webcrypto.subtle.verify(alg, ...r));
  Object.defineProperty(w, 'crypto', { configurable: true, value: { getRandomValues: (a) => webcrypto.getRandomValues(a), subtle } });
  w.TextEncoder = util.TextEncoder; w.TextDecoder = util.TextDecoder;
  // wie im Browser: echte Excel-Dateien sind komprimiert – das Script entpackt sie mit diesen APIs
  w.Blob = globalThis.Blob; w.Response = globalThis.Response; w.DecompressionStream = globalThis.DecompressionStream;
  w.CSS = { escape: (s) => String(s).replace(/[^\w-]/g, (c) => `\\${c}`) };
  // Gerät (für den Geräte-Fingerabdruck): Prozessorkerne, Plattform, Touch-Punkte, Bildschirm, Pixeldichte
  const dev = { hardwareConcurrency: 8, platform: 'MacIntel', maxTouchPoints: 0, width: 1512, height: 982, dpr: 2, ...(opts.device || {}) };
  ['hardwareConcurrency', 'platform', 'maxTouchPoints'].forEach((k) => Object.defineProperty(w.navigator, k, { configurable: true, get: () => dev[k] }));
  Object.defineProperty(w.screen, 'width', { configurable: true, get: () => dev.width });
  Object.defineProperty(w.screen, 'height', { configurable: true, get: () => dev.height });
  Object.defineProperty(w, 'devicePixelRatio', { configurable: true, get: () => dev.dpr });
  w.HTMLCanvasElement.prototype.getContext = () => null; // kein WebGL in jsdom
  w.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  const fetches = [];
  // fetch: TAM-Abfrage (GWT-RPC, Silent Reload/Push) liefert tam.rpc, alles andere leer
  w.fetch = async (url, o) => {
    fetches.push({ url, o });
    const rpcBody = String((o && o.body) || '');
    if (/saveMerkmal/.test(rpcBody)) tam.saves.push(rpcBody);
    const body = !/\/gwt-rpc\//.test(url) ? '' : /saveMerkmal/.test(rpcBody) ? tam.rpcSave : tam.rpc;
    return { ok: true, status: 200, text: async () => body, json: async () => ({}) };
  };
  w.XMLHttpRequest.prototype.send = function () {}; // kein Netz im Test (das Script schneidet TAMs Anfrage beim Senden mit)
  const sources = [];
  w.EventSource = class {
    constructor(url) { this.url = url; this.readyState = 0; this.ls = {}; sources.push(this); }
    addEventListener(t, fn) { (this.ls[t] = this.ls[t] || []).push(fn); }
    close() { this.readyState = 2; }
  };

  const timers = new Set();
  const { setTimeout: st, setInterval: si } = w;
  w.setTimeout = (...a) => { const id = st.apply(w, a); timers.add(id); return id; };
  w.setInterval = (...a) => { const id = si.apply(w, a); timers.add(id); return id; };

  // ---- TAM-Verhalten
  const tam = { accepted: [], closed: [], dblclicks: [], sources, fetches, requests, store, window: w, document: d, rpc: '//OK[]', rpcSave: '//OK[[],0,7]', saves: [] };

  // Reiterwechsel: Klick auf einen Reiter der Hauptleiste
  const strip = d.querySelector(`li[id$="__AgentVeroeffentlichteAuftraege"]`).parentElement; // Reiterleiste (einmal merken: Tests können Reiter entfernen)
  const panels = () => [...d.querySelectorAll('li[id*="__"]')].filter((li) => d.getElementById(li.id.split('__').pop()) && li.parentElement === strip);
  tam.selectTab = (panelId) => panels().forEach((li) => {
    const id = li.id.split('__').pop(), on = id === panelId;
    li.classList.toggle('x-tab-strip-active', on);
    d.getElementById(id).classList.toggle('x-hide-display', !on);
  });
  d.addEventListener('click', (e) => {
    const li = e.target.closest && e.target.closest('li[id*="__"]');
    if (li && panels().includes(li)) tam.selectTab(li.id.split('__').pop());
  });
  tam.selectTab(opts.tab === 'accepted' ? 'AgentEigeneAuftraege' : 'AgentVeroeffentlichteAuftraege');

  // Refresh-Pfeil (5. Symbol-Button der Blätterleiste) wie TAM: kurz Lade-Maske im Panel, dann neu geladen
  tam.refreshes = 0;
  const pub = d.getElementById('AgentVeroeffentlichteAuftraege');
  const bar = [...pub.querySelectorAll('.x-toolbar')].find((x) => /Einträge pro Seite/.test(x.textContent));
  const refreshBtn = bar && bar.querySelectorAll('.x-btn')[4];
  if (refreshBtn) refreshBtn.addEventListener('click', () => {
    tam.refreshes++;
    // wie TAM: Liste per GWT-RPC laden (das Script übernimmt diese Anfrage für Silent Reload/Push)
    const x = new w.XMLHttpRequest(); x.open('POST', 'https://tam.tuvsud.com/tam/gwt-rpc/auftrag');
    x.send('7|0|9|https://tam.tuvsud.com/tam/|ABC|de.tomcom.tam.client.AuftragService|loadTeilauftraege|1|2|');
    const m = d.createElement('div'); m.className = 'ext-el-mask x-mask-loading'; pub.appendChild(m);
    setTimeout(() => m.remove(), 150);
  });

  // Zeile in "Veröffentlichte Aufträge" (Aufbau wie die echten Zeilen: versteckte id-Spalte vorn, dann die Spalten)
  let rowSeq = 0;
  tam.addOrder = (o) => {
    const body = d.querySelector('#AgentVeroeffentlichteAuftraege .x-grid3-body');
    body.querySelectorAll('.x-grid-empty').forEach((x) => x.remove());
    const val = { teilAuftragNr: o.nr, besichtigungsPlz: o.plz, besichtigungsOrt: o.ort, besichtigungsStrasse: o.strasse || 'Teststr. 1',
      id: o.id || '', cst_projekt_dienstleistung_name: o.dienst || 'Testdienst', preis: o.preis || '50,00 €', status: 'Veröffentlicht', referenz: o.ref || '',
      slaEndeAgent: o.sla || '' };
    const cell = (c, hidden) => `<td role="gridcell" class="x-grid3-col x-grid3-cell x-grid3-td-${c}"${hidden ? ' style="display:none;"' : ''}>` +
      `<div class="x-grid3-cell-inner x-grid3-col-${c}">${val[c] || ''}</div></td>`;
    const row = d.createElement('div');
    row.className = 'x-grid3-row'; row.id = `test-row-${++rowSeq}`;
    row.innerHTML = `<table class="x-grid3-row-table"><tbody><tr>${cell('id', true)}${PUB_COLS.map((c) => cell(c)).join('')}</tr></tbody></table>`;
    row.addEventListener('dblclick', () => { tam.dblclicks.push(o.nr); if (o.onOpen) o.onOpen(tam, o); else tam.openCard(o); });
    body.appendChild(row);
    return row;
  };

  // Auftragskarte nach docs/TAM-DEBUG.md Abschnitt 4/5 (noch kein Live-Mitschnitt)
  tam.openCard = (o) => {
    const c = d.createElement('div');
    c.className = 'x-window x-component'; c.dataset.test = 'card';
    c.innerHTML = `<div class="x-window-header"><span class="x-window-header-text">Auftragskarte zu ${o.nr}</span></div>
      <div class="x-panel-header">Warenkorb <input type="checkbox" class="x-view-item-checkbox" data-all="1"></div>
      <div class="x-view" data-wk="1"><div class="x-view-item x-view-item-check"><input type="checkbox" class="x-view-item-checkbox">${o.nr}</div></div>
      <div class="x-view">${(o.nearby || []).map((n) => `<div class="zusatzteilauftrag" data-nr="${n.nr}"><div class="entfernung">${n.km} km</div>${n.nr} ${n.dienst || 'Dienst'}</div>`).join('')}</div>
      ${btnHtml('Weitere Aufträge finden')}${btnHtml('Annehmen')}${btnHtml('Ablehnen')}${btnHtml('Schließen')}`;
    d.body.appendChild(c);
    c.querySelectorAll('.zusatzteilauftrag').forEach((z) => z.addEventListener('click', () => {
      const it = d.createElement('div'); it.className = 'x-view-item x-view-item-check';
      it.innerHTML = `<input type="checkbox" class="x-view-item-checkbox">${z.dataset.nr}`;
      c.querySelector('[data-wk]').appendChild(it);
    }));
    c.querySelector('[data-all]').addEventListener('click', (e) => { if (e.target.checked) c.querySelectorAll('[data-wk] input').forEach((i) => { i.checked = true; }); });
    c.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
      if (b.textContent === 'Schließen') { tam.closed.push(`Auftragskarte zu ${o.nr}`); c.remove(); }
      if (b.textContent !== 'Annehmen') return;
      const checked = [...c.querySelectorAll('[data-wk] input')].filter((i) => i.checked).map((i) => i.parentNode.textContent.trim());
      if (!checked.length) return;
      const dl = d.createElement('div'); dl.className = 'x-window x-component';
      dl.innerHTML = `<div class="x-window-header"><span class="x-window-header-text">Auftragsannahme bestätigen</span></div>
        <div class="x-form-check-wrap"><input type="checkbox" class="x-form-checkbox"> Ja, hiermit bestätige ich die Bedingungen</div>
        ${btnHtml('Bestätigen', 'x-item-disabled')}${btnHtml('Abbrechen')}`;
      d.body.appendChild(dl);
      const cb = dl.querySelector('input'), ok = dl.querySelector('.x-btn');
      cb.addEventListener('click', () => ok.classList.toggle('x-item-disabled', !cb.checked));
      ok.querySelector('button').addEventListener('click', () => {
        if (ok.classList.contains('x-item-disabled')) return;
        tam.accepted.push(...checked); tam.acceptedAt = Date.now(); dl.remove();
        if (o.afterAccept) o.afterAccept(tam, o);
      });
      dl.querySelectorAll('button')[1].addEventListener('click', () => dl.remove());
    }));
    return c;
  };

  // Fenster aus dem Mitschnitt wieder öffnen (z. B. Detailansicht „Auftrag MW…“); Schließen wird mitgezählt
  tam.savedWindows = savedWindows;
  tam.showWindow = (i = 0) => {
    const tmp = d.createElement('div'); tmp.innerHTML = savedWindows[i];
    const win = tmp.firstElementChild; d.body.appendChild(win);
    const title = (win.querySelector('.x-window-header') || win).textContent.trim();
    [...win.querySelectorAll('.x-btn button')].filter((b) => /^schließen$/i.test(b.textContent.trim()))
      .forEach((b) => b.addEventListener('click', () => { tam.closed.push(title); win.remove(); }));
    return win;
  };

  tam.local = (k) => w.localStorage.getItem(`tamauto.${k}`);
  // TAM-Meldungsfenster (Titel + Text + OK), z. B. „Auftrag bereits vergeben!“
  tam.showMessage = (title, body) => {
    const m = d.createElement('div'); m.className = 'x-window x-component';
    m.innerHTML = `<div class="x-window-header"><span class="x-window-header-text">${title}</span></div>` +
      `<div class="x-window-body">${body}</div>${btnHtml('OK')}`;
    m.querySelector('button').addEventListener('click', () => { tam.closed.push(title); m.remove(); });
    d.body.appendChild(m);
    return m;
  };
  tam.onPublished = () => d.querySelector('li[id$="__AgentVeroeffentlichteAuftraege"]').classList.contains('x-tab-strip-active');
  // ntfy-Nachricht an alle Live-Verbindungen eines Kanals zustellen (wie ntfy per SSE)
  tam.ntfy = (topicPart, obj) => sources.filter((x) => x.url.includes(topicPart) && x.readyState !== 2 && x.onmessage)
    .forEach((x) => x.onmessage({ data: JSON.stringify({ event: 'message', message: JSON.stringify(obj) }) }));
  // Ereignis einer Live-Verbindung auslösen: 'open', 'keepalive' oder 'error' (closed: Verbindung endgültig zu)
  tam.esEmit = (topicPart, type, closed) => sources.filter((x) => x.url.includes(topicPart) && x.readyState !== 2).forEach((x) => {
    if (type === 'open') x.readyState = 1;
    if (type === 'error' && closed) x.readyState = 2;
    const ev = { type, data: JSON.stringify({ event: type }) };
    if (x[`on${type}`]) x[`on${type}`](ev);
    (x.ls[type] || []).forEach((fn) => fn(ev));
  });
  tam.live = (topicPart) => sources.filter((x) => x.url.includes(topicPart) && x.readyState !== 2);
  tam.opened = (topicPart) => sources.filter((x) => x.url.includes(topicPart)).length;
  tam.ntfyRaw = (topicPart, text) => sources.filter((x) => x.url.includes(topicPart) && x.readyState !== 2 && x.onmessage)
    .forEach((x) => x.onmessage({ data: JSON.stringify({ event: 'message', message: text }) }));
  // Zeile in „Angenommene Aufträge“ (Kopie einer echten Zeile aus dem Mitschnitt, AuftragsNr/Endtermin gesetzt)
  tam.addAccepted = (nr, sla, extra = {}) => {
    const body = d.querySelector('#AgentEigeneAuftraege .x-grid3-body');
    const same = [...body.querySelectorAll('.x-grid3-row')].find((r) => r.querySelector('td.x-grid3-td-teilAuftragNr').textContent.trim() === nr);
    const row = same || body.querySelector('.x-grid3-row').cloneNode(true);
    row.querySelector('td.x-grid3-td-teilAuftragNr').textContent = nr;
    row.querySelector('td.x-grid3-td-slaEndeAgent').textContent = sla || '';
    if (extra.id !== undefined) row.querySelector('td.x-grid3-td-id').textContent = extra.id;
    if (extra.zeichen !== undefined) row.querySelector('td.x-grid3-td-zeichenAgent').textContent = extra.zeichen;
    if (extra.preis !== undefined) row.querySelector('td.x-grid3-td-preis').textContent = extra.preis;
    if (extra.reserviert !== undefined) { const c = row.querySelector('td.x-grid3-td-reserviertBis'); if (c) c.textContent = extra.reserviert; }
    if (extra.plz !== undefined) row.querySelector('td.x-grid3-td-besichtigungsPlz').textContent = extra.plz;
    if (extra.ort !== undefined) row.querySelector('td.x-grid3-td-besichtigungsOrt').textContent = extra.ort;
    if (!same) body.appendChild(row);
    return row;
  };
  tam.posts = (topicPart) => fetches.filter((f) => f.url.includes(topicPart) && f.o && f.o.method === 'POST').map((f) => JSON.parse(f.o.body));
  tam.removeOrder = (nr) => [...d.querySelectorAll('#AgentVeroeffentlichteAuftraege .x-grid3-row')]
    .filter((r) => r.textContent.includes(nr)).forEach((r) => r.remove());
  tam.logs = () => [...d.querySelectorAll('#tamauto-log div')].map((x) => x.textContent).reverse();
  tam.licensePanel = () => !!d.getElementById('tamauto-lic-key');
  tam.mainPanel = () => !!d.getElementById('tamauto-log');
  tam.ready = () => until(() => tam.licensePanel() || tam.mainPanel(), 20000);
  // Beenden: alle Timer des Scripts stoppen (statt w.close() – sonst laufen offene await-Ketten ins Leere),
  // Live-Verbindungen schließen
  tam.close = () => { closed = true; timers.forEach((id) => { w.clearTimeout(id); w.clearInterval(id); }); sources.forEach((s) => s.close()); };

  if (opts.fakeHour != null) { const fakeHour = opts.fakeHour; // Uhrzeit festlegen (Arbeitszeit 08:00–18:00 ist im Script fest): lokale Stunde = fakeHour, Uhr läuft weiter
    const RD = w.Date, n = new RD(), off = new RD(n).setHours(fakeHour, opts.fakeMinute != null ? opts.fakeMinute : 30, 0, 0) - n.getTime();
    w.Date = class extends RD { constructor(...a) { if (a.length) super(...a); else super(RD.now() + off); } static now() { return RD.now() + off; } };
  }
  w.eval(fs.readFileSync(SCRIPT_PATH, 'utf8'));
  return tam;
}

// Minimale .xlsx (ZIP ohne Kompression, Inline-Strings) – sheets: { 'Blattname': [[Zelle, …], …] }
function makeXlsx(sheets) {
  const esc = (v) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const colName = (i) => String.fromCharCode(65 + i);
  const names = Object.keys(sheets);
  const files = {
    'xl/workbook.xml': `<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${
      names.map((n, i) => `<sheet name="${esc(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': `<Relationships>${names.map((n, i) => `<Relationship Id="rId${i + 1}" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}</Relationships>`,
  };
  names.forEach((n, i) => {
    files[`xl/worksheets/sheet${i + 1}.xml`] = `<worksheet><sheetData>${sheets[n].map((row, r) => `<row r="${r + 1}">${
      row.map((v, c) => `<c r="${colName(c)}${r + 1}" t="inlineStr"><is><t>${esc(v)}</t></is></c>`).join('')}</row>`).join('')}</sheetData></worksheet>`;
  });
  const parts = [], central = []; let off = 0;
  Object.entries(files).forEach(([name, body]) => {
    const nb = Buffer.from(name), data = Buffer.from(body);
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(nb.length, 26);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(nb.length, 28); ch.writeUInt32LE(off, 42);
    parts.push(lh, nb, data); central.push(ch, nb); off += 30 + nb.length + data.length;
  });
  const cd = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(names.length + 2 + 0, 8); end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
  const buf = Buffer.concat([...parts, cd, end]);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length);
}

module.exports = { makeXlsx,  startTam, fixture, hasFixtures, licenseKey, revocationList, until, sleep, INSTALL_ID };
