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

describe('Start und Lizenz', { skip }, () => {
  it('startet mit gültiger Lizenz auf dem leeren Reiter „Veröffentlichte Aufträge“', async () => {
    tam = startTam({ html: fixture('veroeffentlicht-leer'), gm: { places: KOELN } });
    await tam.ready();
    assert.ok(tam.mainPanel(), 'Bedienfeld fehlt');
    await until(() => tam.logs().some((l) => /Abgleich/.test(l)), 5000);
    assert.ok(!tam.logs().some((l) => /PLZ\/Ort-Spalte nicht gefunden/.test(l)), tam.logs().join('\n'));
  });

  it('Schlüssel einer anderen Installation → nur Lizenzfeld', async () => {
    tam = startTam({ gm: { licenseKey: licenseKey({ id: 'ZZZZ-ZZZZ-ZZZZ-ZZZZ' }) } });
    await tam.ready();
    assert.ok(tam.licensePanel());
  });
});

describe('Annahme', { skip }, () => {
  it('nimmt passenden Auftrag mit 0-km-Auftrag an, 5 km bleibt draußen', async () => {
    tam = startTam({ gm: { places: KOELN } });
    await tam.ready();
    tam.addOrder({ ...ORDER, nearby: [{ nr: 'MW3000001', km: 0 }, { nr: 'MW3054003', km: 5 }] });
    assert.ok(await until(() => tam.accepted.length, 15000), tam.logs().join('\n'));
    assert.deepEqual(tam.accepted.sort(), ['MW3000001', 'MW3153893']);
  });

  it('nimmt im Reiter „Angenommene Aufträge“ nichts an', async () => {
    tam = startTam({ tab: 'accepted', gm: { places: KOELN } });
    await tam.ready();
    tam.addOrder(ORDER);
    await sleep(1500);
    assert.deepEqual(tam.dblclicks, []);
  });
});

describe('Wächter (P2)', { skip, todo: 'P2: Wächter ohne Reiter-Gate – Fix folgt' }, () => {
  it('schließt im Reiter „Angenommene Aufträge“ keine selbst geöffnete Detailansicht', async () => {
    tam = startTam({ gm: { places: KOELN } });
    await tam.ready();
    tam.addOrder(ORDER);
    assert.ok(await until(() => tam.accepted.length, 15000), tam.logs().join('\n'));
    await sleep(1500); // Annahme abgeschlossen, Script wieder im Leerlauf
    tam.selectTab('AgentEigeneAuftraege');
    tam.showWindow(0); // Nutzer öffnet „Auftrag MW3153893“ per Doppelklick
    await sleep(1000);
    assert.deepEqual(tam.closed.filter((t) => /^Auftrag MW/.test(t)), [], tam.logs().slice(-5).join('\n'));
  });
});

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
  // Arbeitszeit so legen, dass „jetzt“ sicher außerhalb liegt
  const now = new Date(), hh = (h) => `${String((now.getHours() + h + 24) % 24).padStart(2, '0')}:00`;
  const OUTSIDE = { schedOn: true, schedFrom: hh(2), schedTo: hh(3) };
  const state = () => tam.document.getElementById('tamauto-silent-state').textContent;

  it('Checkbox schaltet an/aus und wird gespeichert', async () => {
    tam = startTam({ gm: { places: KOELN } });
    await tam.ready();
    const cb = tam.document.getElementById('tamauto-silent-on');
    assert.equal(cb.checked, false);
    assert.equal(state(), 'aus');
    cb.click();
    assert.equal(tam.store.get('silentOn'), true);
  });

  it('pausiert außerhalb der Arbeitszeit', async () => {
    tam = startTam({ gm: { places: KOELN, silentOn: true, silentSec: 5, ...OUTSIDE } });
    await tam.ready();
    assert.ok(await until(() => /außerhalb der Arbeitszeit/.test(state()), 2000), state());
  });

  it('altes „alle 5 s“ (ohne Checkbox) bleibt an', async () => {
    tam = startTam({ gm: { places: KOELN, silentSec: 5 } });
    await tam.ready();
    assert.equal(tam.document.getElementById('tamauto-silent-on').checked, true);
  });
});
