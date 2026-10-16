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

// P1 Sixt: Auftrag passt, wird aber als „bereits bearbeitet“ übersprungen (done dauerhaft verunreinigt)
describe('Bereits bearbeitet / done (P1 Sixt)', { skip }, () => {
  const SIXT = { nr: 'MW3160001', plz: '50825', ort: 'Köln', dienst: 'Sixt Rückgabe' };
  const MIN = 60000;

  it('alter Eintrag aus früherer Version, nie angenommen → wird wieder angenommen', async () => {
    tam = startTam({ gm: { places: KOELN, doneRefs: [SIXT.nr] } });
    await tam.ready();
    tam.addOrder(SIXT);
    assert.ok(await until(() => tam.accepted.includes(SIXT.nr), 15000), tam.logs().join('\n'));
  });

  it('früher (anderer Tag) angenommen, jetzt wieder veröffentlicht (zurückgegeben) → wird direkt wieder angenommen', async () => {
    tam = startTam({ gm: { places: KOELN, doneRefs: [SIXT.nr], doneInfo: { [SIXT.nr]: { at: Date.now() - 26 * 3600e3, why: 'angenommen' } }, orderbook: [{ ts: '2026-10-01T10:00:00Z', nr: SIXT.nr }] } });
    await tam.ready();
    tam.addOrder(SIXT);
    assert.ok(await until(() => tam.accepted.includes(SIXT.nr), 15000), tam.logs().join('\n'));
  });

  // Uhr auf 12:30 festgelegt: „gestern 23:00“ ist dann 13,5 h her (Reservierung noch nicht abgelaufen)
  const gestern23 = () => new Date().setHours(0, 0, 0, 0) - 3600e3;
  it('gestern angenommen, nach 13 h wieder da (Reservierung läuft noch) = aktiv zurückgegeben → 2 Wochen gesperrt, den anderen Geräten gemeldet', async () => {
    tam = startTam({ fakeHour: 12, gm: { places: KOELN, doneRefs: [SIXT.nr], doneInfo: { [SIXT.nr]: { at: gestern23(), why: 'angenommen' } } } });
    await tam.ready();
    tam.addOrder(SIXT);
    assert.ok(await until(() => tam.logs().some((l) => /aktiv zurückgegeben → 2 Wochen gesperrt/.test(l)), 6000), tam.logs().slice(-4).join('\n'));
    assert.ok((tam.store.get('returnsToday').items || {})[SIXT.nr]);
    await sleep(1500);
    assert.deepEqual(tam.dblclicks, []);
    assert.ok(tam.posts('tamret-').some((m) => m.t === 'ret' && m.nrs.includes(SIXT.nr)), 'Rückgabe nicht gemeldet');
  });
  it('Reservierungsende (aus dem Terminfenster) schon vorbei → abgelaufen → wieder annehmen; noch nicht vorbei → gesperrt', async () => {
    const fmt = (d) => { const p = (n) => String(n).padStart(2, '0'); return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`; };
    tam = startTam({ fakeHour: 12, gm: { places: KOELN, doneRefs: [SIXT.nr], doneInfo: { [SIXT.nr]: { at: gestern23(), why: 'angenommen' } },
      orderbook: [{ ts: new Date(gestern23()).toISOString(), nr: SIXT.nr, resEnde: '01.01.2020 00:00' }] } });
    await tam.ready();
    tam.addOrder(SIXT);
    assert.ok(await until(() => tam.accepted.includes(SIXT.nr), 15000), tam.logs().join('\n'));
    tam.close();
    tam = startTam({ fakeHour: 12, gm: { places: KOELN, doneRefs: [SIXT.nr], doneInfo: { [SIXT.nr]: { at: gestern23() - 20 * 3600e3, why: 'angenommen' } },
      orderbook: [{ ts: new Date(gestern23()).toISOString(), nr: SIXT.nr, resEnde: '01.01.2099 00:00' }] } });
    await tam.ready();
    tam.addOrder(SIXT);
    await sleep(2500);
    assert.deepEqual(tam.dblclicks, []);
  });
  it('früher angenommen, aber auf der Rückgabe-Liste („XX zurück“) → nicht wieder annehmen', async () => {
    tam = startTam({ gm: { places: KOELN, doneRefs: [SIXT.nr], doneInfo: { [SIXT.nr]: { at: Date.now() - 26 * 3600e3, why: 'angenommen' } },
      returnsToday: { date: '2026-10-07', items: { [SIXT.nr]: { at: Date.now() - 3600e3 } } } } });
    await tam.ready();
    tam.addOrder(SIXT);
    await sleep(2500);
    assert.deepEqual(tam.dblclicks, []);
  });

  it('heute angenommen, Zeile steht noch → bleibt gesperrt, Herkunft im Log', async () => {
    tam = startTam({ gm: { places: KOELN, doneRefs: [SIXT.nr], doneInfo: { [SIXT.nr]: { at: Date.now() - 2 * MIN, why: 'angenommen' } }, orderbook: [{ ts: new Date().toISOString(), nr: SIXT.nr }] } });
    await tam.ready();
    tam.addOrder(SIXT);
    assert.ok(await until(() => tam.logs().some((l) => l.includes(SIXT.nr) && /bereits bearbeitet/.test(l) && /angenommen/.test(l)), 5000), tam.logs().join('\n'));
    assert.deepEqual(tam.dblclicks, []);
  });
  it('fehlgeschlagene Annahme sperrt nur befristet', async () => {
    tam = startTam({ gm: { places: KOELN, doneRefs: [SIXT.nr],
      doneInfo: { [SIXT.nr]: { at: Date.now() - 20 * MIN, why: 'Annahme fehlgeschlagen (vergeben)', exp: Date.now() - 5 * MIN } } } });
    await tam.ready();
    tam.addOrder(SIXT);
    assert.ok(await until(() => tam.accepted.includes(SIXT.nr), 15000), tam.logs().join('\n'));
  });

  it('Fehlschlag wird mit Herkunft und Ablauf gemerkt', async () => {
    tam = startTam({ gm: { places: KOELN } });
    await tam.ready();
    tam.addOrder({ ...SIXT, onOpen: () => {} }); // Karte öffnet sich nicht
    assert.ok(await until(() => (tam.store.get('doneInfo') || {})[SIXT.nr], 30000), 'kein done-Eintrag');
    const info = tam.store.get('doneInfo')[SIXT.nr];
    assert.match(info.why, /fehlgeschlagen/);
    assert.ok(info.exp > Date.now() && info.exp - Date.now() <= 15 * MIN);
  });
});

// Sperr-Stichworte: Fahrzeuge über 3,5 t / Arbeitsmaschinen nicht annehmen (Dienstleistung)
describe('Sperr-Stichworte (über 3,5 t)', { skip }, () => {
  it('LKW ab 3,5t und Arbeitsmaschine werden nicht angenommen (braun im Log), PKW bis 3,49t schon', async () => {
    tam = startTam({ gm: { places: KOELN } });
    await tam.ready();
    tam.addOrder({ nr: 'MW3216949', plz: '50825', ort: 'Köln', dienst: 'Volvo - Rücknahme LKW ab 3,5t dezentral' });
    tam.addOrder({ nr: 'MW3209605', plz: '50825', ort: 'Köln', dienst: 'Raiffeisen-IMPULS Finance & Lease GmbH - Rücknahme allg. Arbeitsmaschine' });
    tam.addOrder({ nr: 'MW3214331', plz: '50825', ort: 'Köln', dienst: 'CA Auto Bank - Verwertung - Wertgutachten PKW bis 3,49t' });
    assert.ok(await until(() => tam.accepted.includes('MW3214331'), 15000), tam.logs().slice(-6).join('\n'));
    await sleep(1500);
    assert.ok(!tam.accepted.includes('MW3216949') && !tam.accepted.includes('MW3209605'), 'Sperr-Stichwort angenommen');
    const line = (nr) => [...tam.document.querySelectorAll('#tamauto-log div')].find((d) => d.textContent.includes(nr) && /Treffer, aber gesperrt: Stichwort/.test(d.textContent));
    assert.match(line('MW3216949').textContent, /Stichwort „LKW“/);
    assert.match(line('MW3209605').textContent, /Stichwort „Arbeitsmaschine“/);
    assert.equal(line('MW3216949').style.color, 'rgb(109, 76, 65)'); // Sperrlisten-Farbe
  });
  it('Excel-Blatt ist maßgeblich: nur die Stichworte dort gelten (LKW nicht mehr drin → angenommen, Kehrmaschine drin → gesperrt)', async () => {
    tam = startTam({ gm: { places: { ...KOELN, stichworte: ['Kehrmaschine', 'Arbeitsmaschine'] } } });
    await tam.ready();
    tam.addOrder({ nr: 'MW3189101', plz: '50825', ort: 'Köln', dienst: 'Rücknahme Kehrmaschine' });
    tam.addOrder({ nr: 'MW3189102', plz: '50825', ort: 'Köln', dienst: 'Rücknahme LKW' });
    assert.ok(await until(() => tam.accepted.includes('MW3189102'), 15000), tam.logs().slice(-6).join('\n'));
    await sleep(1500);
    assert.ok(!tam.accepted.includes('MW3189101'), 'Stichwort aus Excel nicht gesperrt');
    assert.match(tam.document.getElementById('tamauto-sw-list').textContent, /^KehrmaschineArbeitsmaschine$/);
  });

});
