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

// Stille Abfrage hält die Tabelle aktuell: nicht mehr veröffentlichte Aufträge lokal ausblenden
describe('Tabelle über stille Abfrage aktuell halten', { skip }, () => {
  const PUSH = 'tam-zrd6g634b4wej7aqhsycc9qm';
  const RPC = (...nrs) => `//OK["com.extjs.gxt.ui.client.data.BasePagingLoadResult/496878394",${nrs.map((n) => `"${n}"`).join(',')}]`;
  const row = (nr) => [...tam.document.querySelectorAll('#AgentVeroeffentlichteAuftraege .x-grid3-row')].find((r) => r.textContent.includes(nr));
  async function setup(gm = {}) {
    tam = startTam({ gm: { places: KOELN, pushOnV3: true, ...gm } });
    await tam.ready();
    tam.addOrder({ nr: 'MW3180101', plz: '99999', ort: 'Nirgendwo' });
    tam.addOrder({ nr: 'MW3180102', plz: '99998', ort: 'Irgendwo' });
    const bar = [...tam.document.querySelectorAll('#AgentVeroeffentlichteAuftraege .x-toolbar')].find((x) => /Einträge pro Seite/.test(x.textContent));
    bar.querySelectorAll('.x-btn')[4].querySelector('button').click(); // TAM-Anfrage übernehmen
    await sleep(1500);
  }
  const push = () => tam.ntfy(PUSH, { v: 1, src: 'Test-Tablet', ts: Date.now() });

  it('Auftrag fehlt in TAMs Antwort → ausgeblendet; taucht wieder auf → eingeblendet', async () => {
    await setup();
    tam.rpc = RPC('MW3180101');
    push();
    assert.ok(await until(() => row('MW3180102').classList.contains('tamauto-vanished'), 4000), tam.logs().slice(-5).join('\n'));
    assert.ok(!row('MW3180101').classList.contains('tamauto-vanished'));
    await sleep(10500); // Push-Signale innerhalb von 10 s werden zusammengefasst
    tam.rpc = RPC('MW3180101', 'MW3180102');
    push();
    assert.ok(await until(() => !row('MW3180102').classList.contains('tamauto-vanished'), 4000));
  });

  it('fehlerhafte TAM-Antwort → nichts ausgeblendet', async () => {
    await setup();
    tam.rpc = '//EX[Sitzung abgelaufen]';
    push();
    assert.ok(await until(() => tam.fetches.some((f) => /gwt-rpc/.test(f.url)), 4000));
    await sleep(800);
    assert.ok(!row('MW3180101').classList.contains('tamauto-vanished') && !row('MW3180102').classList.contains('tamauto-vanished'));
  });

  it('Schalter „Farbige TAM-Einträge“ aus → nichts ausgeblendet', async () => {
    await setup({ colorRows: false });
    tam.rpc = RPC('MW3180101');
    push();
    assert.ok(await until(() => tam.fetches.some((f) => /gwt-rpc/.test(f.url)), 4000));
    await sleep(800);
    assert.ok(!row('MW3180102').classList.contains('tamauto-vanished'));
  });
});

// Einfärben direkt beim Einfügen der Zeile (vor dem Zeichnen) – kein Aufblitzen
describe('Zeilen sofort einfärben', { skip }, () => {
  it('neue Zeile hat ihre Farbe schon im nächsten Mikrotask (vor dem Zeichnen), nicht erst nach dem Abgleich', async () => {
    tam = startTam({ gm: { places: { ...KOELN, block: { plz: ['44141'], orte: [] } } } });
    await tam.ready();
    const row = (nr) => [...tam.document.querySelectorAll('#AgentVeroeffentlichteAuftraege .x-grid3-row')].find((r) => r.textContent.includes(nr));
    tam.addOrder({ nr: 'MW3189001', plz: '50825', ort: 'Köln' });
    tam.addOrder({ nr: 'MW3189002', plz: '99999', ort: 'Nirgendwo' });
    tam.addOrder({ nr: 'MW3189003', plz: '44141', ort: 'Dortmund' });
    await Promise.resolve(); await Promise.resolve(); // MutationObserver-Rückruf (Mikrotask) – noch vor jedem Zeichnen / Timer
    assert.ok(row('MW3189001').classList.contains('tamauto-match'), 'grün fehlt');
    assert.ok(row('MW3189002').classList.contains('tamauto-nomatch'), 'grau fehlt');
    assert.ok(row('MW3189003').classList.contains('tamauto-blocked'), 'braun fehlt');
    // TAM zeichnet die Tabelle beim Aktualisieren neu (gleiche Aufträge, neue Zeilen ohne Farbe) → ebenfalls sofort eingefärbt
    await sleep(1500);
    const alt = row('MW3189001'), neu = alt.cloneNode(true);
    neu.className = 'x-grid3-row'; alt.replaceWith(neu);
    await Promise.resolve(); await Promise.resolve();
    assert.ok(neu.classList.contains('tamauto-match'), 'neu gezeichnete Zeile nicht sofort eingefärbt');
  });
});
