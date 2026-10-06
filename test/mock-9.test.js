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

// Auftragsbuch: ✓ statt Zeichentext, keine Spalte „Zuständig“, nichts mehr zum Schreiben
describe('Auftragsbuch: Zeichen als Haken', { skip }, () => {
  const today = new Date().toISOString();
  const BOOK = () => [
    { ts: today, nr: 'MW3190601', plz: '44141', ort: 'Dortmund', dienst: 'Standard', preis: 200, zeichen: '' },
    { ts: today, nr: 'MW3190602', plz: '40213', ort: 'Düsseldorf', dienst: 'Sixt Rückgabe', preis: 180, zeichen: 'PM 12.10 10:00 T' },
  ];
  const bookRow = (nr) => [...tam.document.querySelectorAll('#tamauto-ob-rows tr')].find((r) => r.textContent.includes(nr));

  it('„Ihr Zeichen“ nur als ✓ (Text im Tooltip); sechs Spalten; kein Schreiben (kein Knopf, Dropdown, Haken, Automatik)', async () => {
    tam = startTam({ gm: { places: KOELN, orderbook: BOOK() } });
    await tam.ready();
    tam.document.querySelector('.tamauto-tabbtn[data-page="tamauto-page-book"]').click();
    assert.equal(bookRow('MW3190601').children[5].textContent, '');
    assert.equal(bookRow('MW3190602').children[5].textContent, '✓');
    assert.equal(bookRow('MW3190602').children[5].title, 'PM 12.10 10:00 T');
    assert.equal(bookRow('MW3190602').children.length, 6);
    assert.equal(tam.document.querySelectorAll('#tamauto-ob-rows select, #tamauto-ob-rows input, #tamauto-zeichen-go').length, 0);
    assert.equal(tam.document.getElementById('tamauto-zeichenauto'), null);
    assert.ok(![...tam.document.querySelectorAll('#tamauto-page-book th')].some((th) => /Zuständig|PLZ/.test(th.textContent)));
    assert.deepEqual([...tam.document.querySelectorAll('#tamauto-page-book thead th')].map((th) => th.textContent), ['Datum', 'Von', 'AuftragsNr', 'Ort', 'Euro', 'Z.']);
  });

  it('Datum: bei einem einzelnen Tag nur die Uhrzeit, sonst Datum und Uhrzeit', async () => {
    tam = startTam({ gm: { places: KOELN, orderbook: BOOK() } });
    await tam.ready();
    tam.document.querySelector('.tamauto-tabbtn[data-page="tamauto-page-book"]').click();
    const cell = () => bookRow('MW3190601').children[0].textContent;
    const rng = tam.document.getElementById('tamauto-ob-range');
    assert.match(cell(), /^\d{2}:\d{2}$/); // Heute
    rng.value = 'week'; rng.onchange();
    assert.match(cell(), /^\d{2}\.\d{2}\. \d{2}:\d{2}$/);
  });
});

describe('„XX zurück“ und Morgenroutine', { skip }, () => {
  const old = new Date(Date.now() - 3 * 864e5).toISOString();
  const book = () => tam.store.get('orderbook') || [];
  const ret = () => (tam.store.get('returnsToday') || {}).items || {};

  it('„GS zurück“ bei einem Auftrag von einem früheren Tag → heute auf der Tagesblacklist', async () => {
    tam = startTam({ gm: { places: KOELN, orderbook: [{ ts: old, nr: 'MW3190801', plz: '44141', ort: 'Dortmund', tid: '3706801', zeichen: '' }] } });
    await tam.ready();
    tam.addAccepted('MW3190801', '', { id: '3706801', zeichen: 'GS zurück' });
    tam.selectTab('AgentEigeneAuftraege');
    assert.ok(await until(() => Object.keys(ret()).length, 3000), JSON.stringify(tam.store.get('returnsToday')));
    assert.ok(ret().MW3190801, JSON.stringify(ret()));
  });

  it('Morgenroutine: ab 07:58 einmal „Angenommene Aufträge“ lesen und zurück zu „Veröffentlichte Aufträge“', async () => {
    tam = startTam({ fakeHour: 7, fakeMinute: 58, gm: { morgenScan: '', places: KOELN, orderbook: [{ ts: old, nr: 'MW3190802', plz: '44141', ort: 'Dortmund', tid: '3706802', zeichen: '' }] } });
    tam.addAccepted('MW3190802', '', { id: '3706802', zeichen: 'LE zurück' });
    tam.selectTab('AgentVeroeffentlichteAuftraege');
    await tam.ready();
    assert.ok(await until(() => ret().MW3190802, 15000), tam.logs().slice(-6).join('\n'));
    assert.ok(await until(() => tam.store.get('morgenScan') === new Date().toLocaleDateString('sv-SE'), 3000), 'Tagesmarke fehlt');
    assert.ok(await until(() => tam.document.querySelector('li[id$="__AgentVeroeffentlichteAuftraege"]').classList.contains('x-tab-strip-active'), 5000), 'nicht zurück im Reiter');
    assert.equal(book().find((e) => e.nr === 'MW3190802').zeichen, 'LE zurück');
  });

  it('Morgenroutine läuft vor 07:58 nicht', async () => {
    tam = startTam({ fakeHour: 7, fakeMinute: 30, gm: { morgenScan: '', places: KOELN } });
    await tam.ready();
    await sleep(6500);
    assert.equal(tam.store.get('morgenScan'), '');
  });

  it('hat ein anderes Gerät die Routine gemeldet, entfällt sie hier', async () => {
    tam = startTam({ fakeHour: 7, fakeMinute: 58, gm: { morgenScan: '', places: KOELN } });
    await tam.ready();
    tam.ntfy('tamret-', { v: 1, t: 'scan', nrs: [], at: Date.now() });
    assert.ok(await until(() => tam.store.get('morgenScan') === new Date().toLocaleDateString('sv-SE'), 2000));
    await sleep(6500);
    assert.ok(!tam.logs().some((l) => /Morgenroutine: \d+ Zeilen/.test(l)), 'Routine lief trotz Meldung');
  });

  it('Routine gemeldet: nach dem Lauf geht eine „scan“-Meldung an die anderen Geräte', async () => {
    tam = startTam({ fakeHour: 7, fakeMinute: 58, gm: { morgenScan: '', places: KOELN } });
    await tam.ready();
    assert.ok(await until(() => tam.posts('tamret-').some((m) => m.t === 'scan'), 15000), tam.logs().slice(-5).join('\n'));
  });

  it('MA-Management gleicht beim Öffnen mit „Angenommene Aufträge“ (TAM) ab', async () => {
    tam = startTam({ gm: { accSyncAt: 0, places: KOELN, orderbook: [{ ts: new Date().toISOString(), nr: 'MW3190803', plz: '44141', ort: 'Dortmund', tid: '3706803', zeichen: '' }] } });
    tam.addAccepted('MW3190803', '', { id: '3706803', zeichen: 'GS 12.10 10:00 T' });
    tam.selectTab('AgentVeroeffentlichteAuftraege');
    await tam.ready();
    tam.document.querySelector('.tamauto-tabbtn[data-page="tamauto-page-ma"]').click();
    assert.ok(await until(() => (tam.store.get('orderbook').find((e) => e.nr === 'MW3190803') || {}).zeichen === 'GS 12.10 10:00 T', 15000), tam.logs().slice(-5).join('\n'));
  });

  it('Tages-Blacklist gilt 48 Stunden rollierend (über Mitternacht), danach fällt der Eintrag weg', async () => {
    const h = (n) => Date.now() - n * 3600e3, yesterday = new Date(Date.now() - 864e5).toLocaleDateString('sv-SE');
    tam = startTam({ gm: { places: KOELN, returnsToday: { date: yesterday, items: { MW3190810: { at: h(30) }, MW3190811: { at: h(50) } } } } });
    await tam.ready();
    const chips = () => tam.document.getElementById('tamauto-ret').textContent;
    assert.match(chips(), /MW3190810/); assert.doesNotMatch(chips(), /MW3190811/);
  });

  it('Start: „Angenommene Aufträge“ wird geöffnet (Zeichen abgleichen), danach wieder „Veröffentlichte Aufträge“', async () => {
    tam = startTam({ gm: { startTabs: true, places: KOELN, orderbook: [{ ts: new Date().toISOString(), nr: 'MW3190820', plz: '44141', ort: 'Dortmund', tid: '3706820', zeichen: '' }] } });
    tam.addAccepted('MW3190820', '', { id: '3706820', zeichen: 'GS 12.10 10:00 T' });
    tam.selectTab('AgentVeroeffentlichteAuftraege');
    await tam.ready();
    assert.ok(await until(() => (book().find((e) => e.nr === 'MW3190820') || {}).zeichen === 'GS 12.10 10:00 T', 15000), tam.logs().slice(-5).join('\n'));
    assert.ok(await until(() => tam.document.querySelector('li[id$="__AgentVeroeffentlichteAuftraege"]').classList.contains('x-tab-strip-active'), 5000));
  });
});

