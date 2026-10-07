// Tests gegen das echte Script auf Basis echter TAM-Mitschnitte (test/fixtures/, nur lokal).
// Aufruf: npm test   (bzw. node --test test/)
'use strict';
const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { startTam, hasFixtures, fixture, licenseKey, until, sleep } = require('./harness');

const KOELN = { v: 2, plz: ['50825'], orte: [], block: { plz: [], orte: [] }, loadedAt: new Date().toISOString(), source: 'Test' };
const ORDER = { nr: 'MW3153893', plz: '50825', ort: 'Köln' }; // gleiche Nr wie die Detailansicht im Mitschnitt
const skip = !hasFixtures('veroeffentlicht-leer', 'angenommen', 'angenommen-detail') && 'Mitschnitte fehlen (test/fixtures/)';

let tam;
afterEach(() => { if (tam) tam.close(); tam = null; });

// P1: Lizenz darf nicht per Backup (Tampermonkey-Speicher) auf ein anderes Gerät wandern
describe('Gerätebindung der Lizenz (P1)', { skip }, () => {
  const TABLET_A = { platform: 'Linux armv8l', hardwareConcurrency: 8, maxTouchPoints: 5, width: 800, height: 1280, dpr: 2 };
  const TABLET_B = { platform: 'Linux armv8l', hardwareConcurrency: 6, maxTouchPoints: 10, width: 1200, height: 1920, dpr: 1.5 };
  // Erstinstallation auf Tablet A → Tampermonkey-Speicher (Inhalt eines Backups) und Website-Speicher
  async function installOn(device) {
    const t = startTam({ device });
    await t.ready();
    const keys = ['installId', 'licenseKey', 'devMark', 'devFp'];
    const gm = Object.fromEntries(keys.filter((k) => t.store.has(k)).map((k) => [k, t.store.get(k)]));
    const local = Object.fromEntries(['installId', 'licenseKey', 'devMark'].filter((k) => t.local(k)).map((k) => [k, t.local(k)]));
    t.close();
    return { gm, local };
  }

  it('Backup auf anderem Gerät → neue ID, Lizenz erforderlich', async () => {
    const a = await installOn(TABLET_A);
    assert.ok(a.gm.devMark && a.gm.devFp, 'Gerätedaten nicht gespeichert');
    tam = startTam({ device: TABLET_B, gm: a.gm }); // Tampermonkey-Backup eingespielt, Website-Speicher leer
    await tam.ready();
    assert.ok(tam.licensePanel(), 'Script läuft trotz fremdem Gerät');
    assert.notEqual(tam.store.get('installId'), a.gm.installId);
  });

  it('gleiches Gerät, Website-Daten gelöscht → Lizenz bleibt', async () => {
    const a = await installOn(TABLET_A);
    tam = startTam({ device: TABLET_A, gm: a.gm });
    await tam.ready();
    assert.ok(tam.mainPanel());
    assert.equal(tam.store.get('installId'), a.gm.installId);
    assert.equal(tam.local('devMark'), a.gm.devMark, 'Markierung nicht wieder eingetragen');
  });

  it('gleiches Gerät, Fingerabdruck geändert (z. B. Browser-Update) → Lizenz bleibt', async () => {
    const a = await installOn(TABLET_A);
    tam = startTam({ device: { ...TABLET_A, hardwareConcurrency: 4 }, gm: a.gm, local: a.local });
    await tam.ready();
    assert.ok(tam.mainPanel());
    assert.equal(tam.store.get('installId'), a.gm.installId);
  });

  it('Bestandsinstallation ohne Gerätedaten → läuft weiter und wird gebunden', async () => {
    tam = startTam({ device: TABLET_A });
    await tam.ready();
    assert.ok(tam.mainPanel());
    assert.ok(tam.store.get('devFp') && tam.store.get('devMark') && tam.local('devMark'));
  });
});

describe('Silent Reload', { skip }, () => {
  const state = () => tam.document.getElementById('tamauto-silent-state').textContent;

  it('Checkbox schaltet an/aus und wird gespeichert', async () => {
    tam = startTam({ gm: { places: KOELN, silentOn: 'default' } });
    await tam.ready();
    const cb = tam.document.getElementById('tamauto-silent-on');
    assert.equal(cb.checked, true, 'Standard: an (ersetzt den Auto-Refresh)');
    assert.equal(tam.document.getElementById('tamauto-silent').value, '30');
    cb.click();
    assert.equal(tam.store.get('silentOn'), false);
    assert.equal(state(), 'aus');
  });

  it('ausdrücklich ausgeschaltet oder eigener Wert bleibt erhalten; Auto-Refresh gibt es nicht mehr', async () => {
    tam = startTam({ gm: { places: KOELN, silentOn: false, silentSec: 12 } });
    await tam.ready();
    assert.equal(tam.document.getElementById('tamauto-silent-on').checked, false);
    assert.equal(tam.document.getElementById('tamauto-silent').value, '12');
    assert.equal(tam.document.getElementById('tamauto-ar').parentElement.parentElement.style.display, 'none');
  });

  it('pausiert außerhalb der Arbeitszeit', async () => {
    tam = startTam({ fakeHour: 19, gm: { places: KOELN, silentOn: true, silentSec: 5 } });
    await tam.ready();
    assert.ok(await until(() => /außerhalb der Arbeitszeit \(08:00–18:00\)/.test(state()), 2000), state());
  });

  it('Arbeitszeit ist fest 08:00–18:00: keine Eingabefelder, gespeicherte Werte wirken nicht, 10 Uhr = aktiv', async () => {
    tam = startTam({ fakeHour: 10, gm: { places: KOELN, silentOn: true, silentSec: 5, schedOn: false, schedFrom: '03:00', schedTo: '04:00' } });
    await tam.ready();
    assert.equal(tam.document.getElementById('tamauto-sched-from'), null);
    assert.equal(tam.document.getElementById('tamauto-sched'), null);
    assert.match(tam.document.getElementById('tamauto-sched-state').textContent, /jetzt in der Arbeitszeit/);
    assert.doesNotMatch(state(), /außerhalb/);
  });

  it('vor 08:00 pausiert', async () => {
    tam = startTam({ fakeHour: 7, gm: { places: KOELN, silentOn: true, silentSec: 5 } });
    await tam.ready();
    assert.ok(await until(() => /außerhalb der Arbeitszeit/.test(state()), 2000), state());
  });

  it('altes „alle 5 s“ (ohne Checkbox) bleibt an', async () => {
    tam = startTam({ gm: { places: KOELN, silentOn: 'default', silentSec: 5 } });
    await tam.ready();
    assert.equal(tam.document.getElementById('tamauto-silent-on').checked, true);
  });
});

// Auftragsbuch: Preis aus „Angenommene Aufträge“, Bildschirm anlassen
describe('Auftragsbuch und Bildschirm', { skip }, () => {
  const today = new Date().toISOString();
  const BOOK = [{ ts: today, nr: 'MW3190201', plz: '50825', ort: 'Köln', preis: 50 }, { ts: today, nr: 'MW3190202', plz: '50825', ort: 'Köln', preis: 60 }];
  const $ = (id) => tam.document.getElementById(id);
  const bookRow = (nr) => [...tam.document.querySelectorAll('#tamauto-ob-rows tr')].find((r) => r.textContent.includes(nr));
  async function setup(gm = {}) {
    tam = startTam({ gm: { places: KOELN, orderbook: BOOK, ...gm } });
    await tam.ready();
    // TAM-Anfrage übernehmen (für Kopfzeilen/Prüfsumme), Angenommene Aufträge mit IDs und Zeichen
    const bar = [...tam.document.querySelectorAll('#AgentVeroeffentlichteAuftraege .x-toolbar')].find((x) => /Einträge pro Seite/.test(x.textContent));
    bar.querySelectorAll('.x-btn')[4].querySelector('button').click();
    await sleep(1200);
    tam.addAccepted('MW3190201', '', { id: '3705231', zeichen: '' });
    tam.addAccepted('MW3190202', '', { id: '3705232', zeichen: 'PM' });
    tam.selectTab('AgentEigeneAuftraege');
    assert.ok(await until(() => tam.store.get('orderbook').every((e) => e.tid), 3000), 'Abgleich mit „Angenommene Aufträge“ fehlt');
    tam.selectTab('AgentVeroeffentlichteAuftraege');
    await sleep(500);
  }

  it('Bildschirm anlassen ist standardmäßig an (ausdrücklich ausgeschaltet bleibt aus)', async () => {
    tam = startTam({ gm: { places: KOELN } });
    await tam.ready();
    assert.equal(tam.document.getElementById('tamauto-wakelock').checked, true);
    tam.close();
    tam = startTam({ gm: { places: KOELN, wakeLock: false } });
    await tam.ready();
    assert.equal(tam.document.getElementById('tamauto-wakelock').checked, false);
  });

  it('Preis aus „Angenommene Aufträge“ ins Auftragsbuch übernommen', async () => {
    tam = startTam({ gm: { places: KOELN, orderbook: [{ ts: today, nr: 'MW3190203', plz: '50825', ort: 'Köln', preis: null }] } });
    await tam.ready();
    tam.addAccepted('MW3190203', '', { id: '3705233', zeichen: '', preis: '77,50 €' });
    tam.selectTab('AgentEigeneAuftraege');
    assert.ok(await until(() => tam.store.get('orderbook')[0].preis === 77.5, 3000), JSON.stringify(tam.store.get('orderbook')));
  });
});

// Stille Abfrage bei TAM (gemeinsam für Push-Signal und Nachfragen nach einem Refresh von Hand)
describe('Stille Abfrage (Push-Signal)', { skip }, () => {
  const PUSH = 'tam-zrd6g634b4wej7aqhsycc9qm';
  async function ready(gm = {}) {
    tam = startTam({ gm: { places: KOELN, pushOnV3: true, ...gm } });
    await tam.ready();
    // einmal von TAM aktualisieren lassen → Script übernimmt TAMs Anfrage
    const bar = [...tam.document.querySelectorAll('#AgentVeroeffentlichteAuftraege .x-toolbar')].find((x) => /Einträge pro Seite/.test(x.textContent));
    bar.querySelectorAll('.x-btn')[4].querySelector('button').click();
    await until(() => tam.refreshes === 1, 2000);
    await sleep(1500);
    return tam.refreshes;
  }
  it('TAM lädt im Hintergrund die Liste „Angenommene“ (Listentyp 1) → ersetzt nicht die Anfrage der veröffentlichten Liste (Silent Reload bleibt richtig)', async () => {
    await ready();
    const rpc = () => tam.fetches.filter((f) => /gwt-rpc/.test(f.url) && f.o && f.o.method === 'POST');
    const x = new tam.window.XMLHttpRequest(); x.open('POST', 'https://tam.tuvsud.com/tam/gwt-rpc/auftrag'); // Hintergrund-Aktualisierung der angenommenen Liste, Veröffentlichte aktiv
    x.send('7|0|5|https://tam.tuvsud.com/|ACC|de.tomcom.tam.client.rpc.gwt.IAuftragService|loadTeilauftraege|x.ListenTyp/1|1|2|3|4|5|1|');
    await sleep(200);
    tam.rpc = '//OK["com.extjs.gxt.ui.client.data.BasePagingLoadResult/496878394"]';
    const n = rpc().length;
    tam.ntfy(PUSH, { v: 1, src: 'Test-Tablet', ts: Date.now() });
    assert.ok(await until(() => rpc().length > n, 4000), 'keine stille Abfrage');
    assert.ok(!rpc().slice(n).some((f) => /\|ACC\|/.test(f.o.body)), 'Silent fragt die Liste der angenommenen Aufträge ab');
  });
  it('Kopfzeile (aufgeklappt) zeigt den Countdown „Silent in …“ und nichts zu Auto-Refresh', async () => {
    await ready({ silentOn: true });
    const t = () => tam.document.getElementById('tamauto-sync').textContent;
    assert.ok(await until(() => /Silent in \d+ s/.test(t()), 3000), t());
    assert.doesNotMatch(t(), /Auto-Refresh/);
  });
  it('TAM meldet neuen Auftrag → Tabelle wird aktualisiert', async () => {
    const r0 = await ready();
    tam.rpc = '//OK["com.extjs.gxt.ui.client.data.BasePagingLoadResult/496878394","MW3199999","50825","Köln"]';
    tam.ntfy(PUSH, { v: 1, src: 'Test-Tablet', ts: Date.now() });
    assert.ok(await until(() => tam.refreshes > r0, 4000), tam.logs().slice(-5).join('\n'));
    assert.ok(tam.logs().some((l) => /neue Daten in TAM/.test(l)));
  });
  it('TAM meldet nichts Neues → keine Aktualisierung', async () => {
    const r0 = await ready();
    tam.rpc = '//OK["com.extjs.gxt.ui.client.data.BasePagingLoadResult/496878394"]';
    tam.ntfy(PUSH, { v: 1, src: 'Test-Tablet', ts: Date.now() });
    assert.ok(await until(() => tam.fetches.some((f) => /gwt-rpc/.test(f.url)), 4000), 'keine stille Abfrage');
    await sleep(1000);
    assert.equal(tam.refreshes, r0);
  });
});
