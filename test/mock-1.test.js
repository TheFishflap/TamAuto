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
