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

// Autohaus-Regeln: Blatt „nicht annehmen Adresse“ sperrt nur eine Adresse, nicht die ganze PLZ
describe('Excel „nicht annehmen Adresse“', { skip }, () => {
  const { makeXlsx, revocationList } = require('./harness');
  const xlsx = makeXlsx({
    annehmen: [['PLZ', 'Ort'], ['50825', 'Köln']],
    'nicht annehmen': [['PLZ', 'Ort']],
    'nicht annehmen Adresse': [['PLZ', 'Straße'], ['50825', 'Maarweg 241'], ['50825', 'Venloer Str.']],
  });
  const xhr = (o) => o.url.includes('IQBmSNFRkXF5') ? { status: 200, responseText: revocationList() }
    : o.url.includes('IQDymsXIGo99') ? { status: 200, response: xlsx } : { error: true };
  const rowOf = (nr) => [...tam.document.querySelectorAll('#AgentVeroeffentlichteAuftraege .x-grid3-row')].find((r) => r.textContent.includes(nr));

  it('gesperrte Adresse rot und nicht angenommen, andere Adresse in derselben PLZ angenommen', async () => {
    tam = startTam({ gm: { places: { plz: [], orte: [] } }, xhr });
    await tam.ready();
    assert.ok(await until(() => (tam.store.get('places').blockAddr || []).length === 2, 5000), JSON.stringify(tam.store.get('places')));
    tam.addOrder({ nr: 'MW3180001', plz: '50825', ort: 'Köln', strasse: 'Maarweg 241-251', onOpen: () => {} });
    tam.addOrder({ nr: 'MW3180002', plz: '50825', ort: 'Köln', strasse: 'Venloer Straße 12', onOpen: () => {} });
    tam.addOrder({ nr: 'MW3180003', plz: '50825', ort: 'Köln', strasse: 'Maarweg 24' });
    assert.ok(await until(() => tam.accepted.includes('MW3180003'), 15000), tam.logs().join('\n'));
    assert.ok(!tam.dblclicks.includes('MW3180001') && !tam.dblclicks.includes('MW3180002'), tam.dblclicks.join());
    assert.ok(rowOf('MW3180001').classList.contains('tamauto-blocked'));
    assert.match(rowOf('MW3180001').title, /Maarweg 241/);
    assert.ok(!rowOf('MW3180003').classList.contains('tamauto-blocked'));
  });
});

describe('Angenommene Zeile lokal ausblenden', { skip }, () => {
  const rowOf = (nr) => [...tam.document.querySelectorAll('#AgentVeroeffentlichteAuftraege .x-grid3-row')].find((r) => r.textContent.includes(nr));
  const terminLess = (t, title, body) => setTimeout(() => t.showMessage(title, body), 300);

  it('nach erfolgreicher Annahme: Auftrag und Warenkorb-Auftrag ausgeblendet', async () => {
    tam = startTam({ gm: { places: KOELN } });
    await tam.ready();
    tam.addOrder({ nr: 'MW3000001', plz: '99999', ort: 'Nirgendwo' }); // 0-km-Auftrag steht auch in der Tabelle
    tam.addOrder({ ...ORDER, nearby: [{ nr: 'MW3000001', km: 0 }] });
    assert.ok(await until(() => rowOf(ORDER.nr).classList.contains('tamauto-gone'), 15000), tam.logs().slice(-5).join('\n'));
    assert.ok(rowOf('MW3000001').classList.contains('tamauto-gone'));
  });

  it('TAM meldet danach „bereits vergeben“ → wieder eingeblendet', async () => {
    tam = startTam({ gm: { places: KOELN } });
    await tam.ready();
    tam.addOrder({ ...ORDER, afterAccept: (t) => terminLess(t, 'Auftrag bereits vergeben!', 'Der Auftrag MW3153893 wurde bereits vergeben.') });
    assert.ok(await until(() => tam.logs().some((l) => /nachträglich/.test(l)), 15000), tam.logs().join('\n'));
    assert.ok(!rowOf(ORDER.nr).classList.contains('tamauto-gone'));
  });

  it('Schalter „Farbige TAM-Einträge“ aus → nichts ausgeblendet', async () => {
    tam = startTam({ gm: { places: KOELN, colorRows: false } });
    await tam.ready();
    tam.addOrder(ORDER);
    assert.ok(await until(() => tam.accepted.length, 15000));
    await sleep(1000);
    assert.ok(!rowOf(ORDER.nr).classList.contains('tamauto-gone'));
  });
});

describe('Kontoprüfung beim Start auf der Anmeldeseite', { skip }, () => {
  it('Kopfzeile zeigt die Anmeldeseite → nicht als fremdes Konto sperren', async () => {
    const html = fixture('veroeffentlicht-leer').replace(/IB Thomée GmbH/g, 'TAM - TÜV SÜD Auftragsmanagement | Anmeldung mit Single-Sign-On');
    tam = startTam({ html, gm: { places: KOELN } });
    await tam.ready();
    assert.ok(tam.mainPanel(), 'Script hat sich als fremdes Konto gesperrt');
    assert.equal(tam.posts('-status').filter((m) => m.t === 'fremdkonto').length, 0);
  });
});
