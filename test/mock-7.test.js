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

describe('Gesperrte Aufträge in der Tabelle', { skip }, () => {
  it('Schalter „Farbige TAM-Einträge“: Standard an; aus → alle Farben weg, wieder an → zurück', async () => {
    tam = startTam({ gm: { places: KOELN } });
    await tam.ready();
    const cb = tam.document.getElementById('tamauto-colorrows');
    assert.equal(cb.checked, true);
    tam.addOrder({ nr: 'MW3170030', plz: '99999', ort: 'Nirgendwo' });
    const row = () => [...tam.document.querySelectorAll('#AgentVeroeffentlichteAuftraege .x-grid3-row')].find((r) => r.textContent.includes('MW3170030'));
    assert.ok(await until(() => row().classList.contains('tamauto-nomatch'), 3000));
    cb.click();
    assert.equal(tam.store.get('colorRows'), false);
    assert.ok(!row().classList.contains('tamauto-nomatch') && !row().title, 'Markierung nicht entfernt');
    cb.click();
    assert.ok(row().classList.contains('tamauto-nomatch'));
  });

  it('passender Auftrag grün, nicht passender grau', async () => {
    tam = startTam({ gm: { places: KOELN } });
    await tam.ready();
    tam.addOrder({ nr: 'MW3170020', plz: '99999', ort: 'Nirgendwo' });
    tam.addOrder({ nr: 'MW3170021', plz: '50825', ort: 'Köln', onOpen: () => {} });
    const row = (nr) => [...tam.document.querySelectorAll('#AgentVeroeffentlichteAuftraege .x-grid3-row')].find((r) => r.textContent.includes(nr));
    assert.ok(await until(() => row('MW3170020').classList.contains('tamauto-nomatch'), 3000));
    assert.ok(!row('MW3170021').classList.contains('tamauto-nomatch'));
    assert.ok(row('MW3170021').classList.contains('tamauto-match'), 'auf der Annahmeliste → grün');
    assert.ok(!row('MW3170020').classList.contains('tamauto-match'));
    assert.match(row('MW3170020').title, /nicht auf der Annahmeliste/);
  });

  const rowOf = (nr) => [...tam.document.querySelectorAll('#AgentVeroeffentlichteAuftraege .x-grid3-row')].find((r) => r.textContent.includes(nr));

  it('Excel „nicht annehmen“ → rot, Rückgabe → orange, andere Zeilen ohne Markierung', async () => {
    const places = { ...KOELN, plz: ['50825', '51'], block: { plz: ['51'], orte: [] } };
    tam = startTam({ gm: { places, retMinGoneSec: 1 } });
    await tam.ready();
    tam.ntfy('tamret-', { v: 1, t: 'acc', nrs: ['MW3170003'], at: Date.now() });
    tam.ntfy('tamret-', { v: 1, t: 'ret', nrs: ['MW3170003'], at: Date.now() });
    tam.addOrder({ nr: 'MW3170003', plz: '50825', ort: 'Köln', onOpen: () => {} });
    tam.addOrder({ nr: 'MW3170004', plz: '51105', ort: 'Köln', onOpen: () => {} });
    tam.addOrder({ nr: 'MW3170005', plz: '99999', ort: 'Nirgendwo' });
    assert.ok(await until(() => rowOf('MW3170003').classList.contains('tamauto-returned'), 3000));
    assert.ok(!rowOf('MW3170003').classList.contains('tamauto-blocked'));
    assert.ok(rowOf('MW3170004').classList.contains('tamauto-blocked'));
    assert.ok(!rowOf('MW3170004').classList.contains('tamauto-returned'));
    assert.ok(!rowOf('MW3170005').classList.contains('tamauto-blocked') && !rowOf('MW3170005').classList.contains('tamauto-returned'));
    assert.ok(rowOf('MW3170005').classList.contains('tamauto-nomatch'), 'nicht auf der Annahmeliste → grau');
    assert.ok(!rowOf('MW3170004').classList.contains('tamauto-nomatch'), 'gesperrt geht vor grau');
    assert.ok(!rowOf('MW3170004').classList.contains('tamauto-match') && !rowOf('MW3170003').classList.contains('tamauto-match'), 'gesperrt geht vor grün');
    assert.match(rowOf('MW3170003').title, /zurückgegeben/);
    assert.doesNotMatch(rowOf('MW3170003').title, /erkannt von/);
  });

  it('Rückgabe-Meldung enthält nur Auftragsnummern', async () => {
    const NR = 'MW3170006';
    tam = startTam({ gm: { places: KOELN, retMinGoneSec: 1 } });
    await tam.ready();
    tam.ntfy('tamret-', { v: 1, t: 'acc', nrs: [NR], at: Date.now() });
    tam.addOrder({ nr: 'MW3999998', plz: '99999', ort: 'Nirgendwo' });
    await sleep(1500);
    tam.addOrder({ nr: NR, plz: '50825', ort: 'Köln' });
    assert.ok(await until(() => tam.posts('tamret-').some((m) => m.t === 'ret'), 5000));
    tam.posts('tamret-').forEach((m) => assert.deepEqual(Object.keys(m).sort(), ['at', 'nrs', 't', 'v']));
  });
});

// Terminfenster nach der Annahme weggeklickt (z. B. Sixt, „Ende: 02.10.2026 15:13“) → Auftrag im Auftragsbuch markiert, rote 1 (bleibt stehen)
describe('Auftragsbuch: rote 1 (Terminfenster weggeklickt, Reservierungsende aus dem Fenster)', { skip }, () => {
  const ENDE = '02.10.2099 15:13';
  const terminWin = (t, ende = ENDE) => {
    const m = t.document.createElement('div'); m.className = 'x-window x-component';
    m.innerHTML = '<div class="x-window-header"><span class="x-window-header-text">Terminvereinbarung</span></div>' +
      `<div class="x-window-body">Termin mit dem Kunden vereinbaren${ende ? ` Ende: ${ende}` : ''} <input type="checkbox"></div>` +
      '<table class="x-btn"><tbody><tr><td><button>Speichern</button></td></tr></tbody></table>' +
      '<table class="x-btn"><tbody><tr><td><button>Abbrechen</button></td></tr></tbody></table>';
    m.querySelectorAll('button')[1].addEventListener('click', () => { t.closed.push('Terminvereinbarung'); m.remove(); });
    t.document.body.appendChild(m);
  };
  const inH = (h) => { const d = new Date(Date.now() + h * 3600000), p = (n) => String(n).padStart(2, '0');
    return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`; };
  const red = () => [...tam.document.querySelectorAll('#tamauto-ob-rows td span.tamauto-termin')];
  async function acceptWithTermin({ ende = ENDE, ...extra } = {}) {
    tam = startTam({ gm: { places: KOELN } });
    await tam.ready();
    tam.addOrder({ ...ORDER, ...extra, afterAccept: (t) => setTimeout(() => terminWin(t, ende), 200) });
    assert.ok(await until(() => tam.closed.includes('Terminvereinbarung'), 5000), 'nicht weggeklickt');
    assert.ok(await until(() => (tam.store.get('orderbook') || []).length, 5000));
    await sleep(3000); // Nachkontrolle vorbei
  }

  it('Fenster mit „Ende“ in ≤ 2 h → rote 1 (auch beim Warenkorb-Auftrag), Zeile markiert, Reservierungsende gemerkt', async () => {
    const ende = inH(1);
    await acceptWithTermin({ nearby: [{ nr: 'MW3000001', km: 0 }], ende });
    assert.equal(red().length, 2, JSON.stringify(tam.store.get('orderbook')));
    assert.equal(red()[0].textContent, '1');
    assert.ok(tam.store.get('orderbook').every((e) => e.resEnde === ende));
    const row = [...tam.document.querySelectorAll('#tamauto-ob-rows tr')].find((r) => r.textContent.includes(ORDER.nr));
    assert.equal(row.style.background, 'rgb(255, 235, 238)');
  });

  it('Ende erst in 5 h → noch keine rote 1', async () => {
    await acceptWithTermin({ ende: inH(5) });
    assert.equal(red().length, 0);
  });

  it('Ende schon überschritten → rote 1; Fenster ohne lesbares Ende → keine rote 1', async () => {
    await acceptWithTermin({ ende: inH(-3) });
    assert.equal(red().length, 1);
    tam.close();
    await acceptWithTermin({ ende: '' });
    assert.equal(red().length, 0);
  });

  it('ohne weggeklickte Terminvereinbarung → keine rote 1, auch bei knapper SLA', async () => {
    tam = startTam({ gm: { places: KOELN } });
    await tam.ready();
    tam.addOrder(ORDER);
    assert.ok(await until(() => (tam.store.get('orderbook') || []).length, 8000));
    tam.addAccepted(ORDER.nr, inH(1));
    tam.selectTab('AgentEigeneAuftraege');
    await sleep(1500);
    assert.equal(red().length, 0);
  });
});

// Excel: Blatt „MA“ (Kürzel | Name | E-Mail | Backoffice) – Mitarbeiter und Backoffice (Absender/Cc der Mails) in einem Blatt
describe('Excel „MA“ mit Backoffice-Haken', { skip }, () => {
  const { makeXlsx, revocationList } = require('./harness');
  const xlsx = makeXlsx({
    annehmen: [['PLZ', 'Ort'], ['50825', 'Köln']],
    'nicht annehmen': [['PLZ', 'Ort']],
    MA: [['Kürzel', 'Name', 'E-Mail', 'Backoffice'], ['mk', 'Markus Kirschbaum', 'mk@example.com', ''], ['LS', 'Leonie Struve', 'ls@example.com', 'x'], ['SI', 'Silke', 'silke@example.com', 'ja'], ['XX', 'Ohne', '', 'nein'], ['BO', 'Postfach', 'auftrag@example.com', '✓']],
    Marktgebiete: [['PLZ', 'Ort', 'MA'], ['40', 'Düsseldorf', 'MB PM']], // wird nicht mehr gelesen
  });
  const xhr = (o) => o.url.includes('IQBmSNFRkXF5') ? { status: 200, responseText: revocationList() } : o.url.includes('IQDymsXIGo99') ? { status: 200, response: xlsx } : { error: true };

  it('Kürzel groß, Backoffice per Haken (x, ja, ✓; leer/nein = nein); Blatt Marktgebiete wird ignoriert', async () => {
    tam = startTam({ gm: { places: { plz: [], orte: [] } }, xhr });
    await tam.ready();
    assert.ok(await until(() => (tam.store.get('places').ma || []).length, 5000), JSON.stringify(tam.store.get('places')));
    const p = tam.store.get('places');
    assert.deepEqual(p.ma.map((x) => [x.k, x.backoffice]), [['MK', false], ['LS', true], ['SI', true], ['XX', false], ['BO', true]]);
    assert.deepEqual(p.ma[0], { k: 'MK', name: 'Markus Kirschbaum', mail: 'mk@example.com', backoffice: false });
    assert.equal(p.gebiete, undefined); assert.equal(p.kontakte, undefined);
  });
  it('ohne Blatt MA (alte Excel) → leer, nichts kaputt', async () => {
    const alt = makeXlsx({ annehmen: [['PLZ', 'Ort'], ['50825', 'Köln']], 'nicht annehmen': [['PLZ', 'Ort']] });
    tam = startTam({ gm: { places: { plz: [], orte: [] } }, xhr: (o) => o.url.includes('IQDymsXIGo99') ? { status: 200, response: alt } : o.url.includes('IQBmSNFRkXF5') ? { status: 200, responseText: revocationList() } : { error: true } });
    await tam.ready();
    assert.ok(await until(() => (tam.store.get('places').plz || []).length, 5000));
    assert.deepEqual(tam.store.get('places').ma, []);
  });
});

// Nach einem Update fehlen im gespeicherten Stand die neuen Excel-Blätter (MA) → sofort neu laden
describe('Excel nach Update sofort neu laden', { skip }, () => {
  const { makeXlsx, revocationList } = require('./harness');
  const xlsx = makeXlsx({ annehmen: [['PLZ', 'Ort'], ['50825', 'Köln']], 'nicht annehmen': [['PLZ', 'Ort']], MA: [['Kürzel', 'Name', 'E-Mail'], ['MK', 'Markus', 'mk@example.com']] });
  const xhr = (o) => o.url.includes('IQBmSNFRkXF5') ? { status: 200, responseText: revocationList() } : o.url.includes('IQDymsXIGo99') ? { status: 200, response: xlsx } : { error: true };
  it('gespeicherter Stand ohne MA-Daten, frisch geladen → trotzdem sofort neu laden', async () => {
    const places = { v: 2, plz: ['50825'], orte: [], block: { plz: [], orte: [] }, loadedAt: new Date().toISOString(), source: 'alt' };
    tam = startTam({ gm: { places }, xhr });
    await tam.ready();
    assert.ok(await until(() => (tam.store.get('places').ma || []).length === 1, 5000), JSON.stringify(Object.keys(tam.store.get('places'))));
  });
  it('Stand mit MA-Daten, frisch geladen → kein erneutes Laden', async () => {
    const places = { v: 2, plz: ['50825'], orte: [], block: { plz: [], orte: [] }, ma: [], blockAddr: [], loadedAt: new Date().toISOString(), source: 'neu' };
    tam = startTam({ gm: { places }, xhr });
    await tam.ready();
    await sleep(800);
    assert.ok(!tam.requests.some((o) => o.url.includes('IQDymsXIGo99')), 'lud unnötig neu');
  });
});
