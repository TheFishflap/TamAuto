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

// Zuständigkeit: Zeichen aus dem Marktgebiet setzen (eindeutig automatisch gebündelt, Mischgebiet per Dropdown), Mail nur an den Zugewiesenen
describe('Zuständigkeit und Zeichen aus dem Marktgebiet', { skip }, () => {
  const G = (ort, ma, plz) => ({ plz, orte: [ort], nurPlz: '', nurWort: '', sixt: false, ma });
  const GEB = [G('dortmund', ['GS'], '44'), G('duesseldorf', ['MB', 'PM'], '40')];
  const MAS = ['GS', 'MB', 'PM'].map((k) => ({ k, name: `${k} Name`, mail: `${k.toLowerCase()}@example.com`, gebiet: [] }));
  const today = new Date().toISOString();
  const BOOK = () => [
    { ts: today, nr: 'MW3190601', plz: '44141', ort: 'Dortmund', dienst: 'Standard', tid: '3706001', zeichen: '' },
    { ts: today, nr: 'MW3190602', plz: '40213', ort: 'Düsseldorf', dienst: 'Standard', tid: '3706002', zeichen: '' },
  ];
  const $ = (id) => tam.document.getElementById(id);
  const tab = (p) => tam.document.querySelector(`.tamauto-tabbtn[data-page="tamauto-page-${p}"]`).click();
  const bookRow = (nr) => [...tam.document.querySelectorAll('#tamauto-ob-rows tr')].find((r) => r.textContent.includes(nr));
  const book = () => tam.store.get('orderbook') || [];
  async function setup(gm = {}) {
    tam = startTam({ gm: { places: { ...KOELN, plz: ['50825', '44'], gebiete: GEB, ma: MAS, kontakte: [] }, orderbook: BOOK(), ...gm } });
    await tam.ready();
    const bar = [...tam.document.querySelectorAll('#AgentVeroeffentlichteAuftraege .x-toolbar')].find((x) => /Einträge pro Seite/.test(x.textContent));
    bar.querySelectorAll('.x-btn')[4].querySelector('button').click(); // TAM-Anfrage übernehmen (für das stille Speichern)
    await sleep(1200);
    tab('book');
  }
  const openMa = (k) => { tab('ma'); $('tamauto-ma-sel').value = k; $('tamauto-ma-sel').onchange({ target: $('tamauto-ma-sel') }); };

  it('Auftragsbuch: eindeutig = Kürzel, Mischgebiet = Dropdown mit den Kürzeln', async () => {
    await setup();
    assert.match(bookRow('MW3190601').textContent, /GS/);
    assert.equal(bookRow('MW3190601').querySelectorAll('select').length, 0);
    const sel = bookRow('MW3190602').querySelector('select');
    assert.deepEqual([...sel.options].map((o) => o.value), ['', 'MB', 'PM']);
  });

  it('Auftragsbuch zeigt die SLA-Flagge (🔴 überfällig/≤ 2 h, 🟡 ≤ 24 h)', async () => {
    const f = (h) => { const d = new Date(Date.now() + h * 3600e3), z = (n) => String(n).padStart(2, '0'); return `${z(d.getDate())}.${z(d.getMonth() + 1)}.${d.getFullYear()} ${z(d.getHours())}:${z(d.getMinutes())}`; };
    const b = BOOK(); b[0].sla = f(1); b[1].sla = f(10);
    await setup({ orderbook: b });
    assert.match(bookRow('MW3190601').textContent, /🔴/);
    assert.match(bookRow('MW3190602').textContent, /🟡/);
  });

  it('Dropdown wählen schreibt nichts; erst „Kurzzeichen setzen“ schreibt „PM neu“ (ID kodiert wie TAM)', async () => {
    const b = BOOK(); b[1].tid = '3705231';
    await setup({ orderbook: b });
    const sel = bookRow('MW3190602').querySelector('select');
    sel.value = 'PM'; sel.dispatchEvent(new tam.window.Event('change', { bubbles: true }));
    await sleep(600);
    assert.equal(tam.saves.length, 0, 'Dropdown darf nicht schreiben');
    assert.equal(book().find((e) => e.nr === 'MW3190602').zustSel, 'PM');
    assert.equal(bookRow('MW3190602').querySelector('select').value, 'PM');
    const go = $('tamauto-zeichen-go');
    assert.match(go.textContent, /Kurzzeichen setzen \(1\)/); // nur PM: gewählt = angehakt; GS ist nicht angehakt
    bookRow('MW3190601').querySelector('.tamzcb, .tamauto-zcb').click();
    assert.match(go.textContent, /Kurzzeichen setzen \(2\)/);
    go.click();
    assert.ok(await until(() => tam.saves.length === 2, 4000), tam.logs().slice(-4).join('\n'));
    assert.ok(tam.saves.some((x) => /\|PM neu\|1\|2\|3\|4\|2\|5\|6\|5\|OImP\|7\|$/.test(x)), tam.saves.join('\n'));
    assert.ok(tam.saves.some((x) => /\|GS neu\|/.test(x)));
    assert.ok(await until(() => book().find((e) => e.nr === 'MW3190602').zeichen === 'PM neu', 2000));
  });

  it('Kurzzeichen setzen: Mischgebiet ohne Auswahl bleibt unberührt; Fehler von TAM → nichts übernommen', async () => {
    await setup();
    tam.rpcSave = '//EX[1,["com.google.gwt.user.client.rpc.SerializationException"]]';
    assert.match($('tamauto-zeichen-go').textContent, /\(0\)/); // nichts angehakt
    $('tamauto-zeichen-all').click();
    assert.match($('tamauto-zeichen-go').textContent, /\(1\)/); // nur MW3190601 (eindeutig); das Mischgebiet ohne Auswahl bleibt draußen
    $('tamauto-zeichen-go').click();
    assert.ok(await until(() => tam.saves.length, 3000));
    await sleep(300);
    assert.ok(!book().find((e) => e.nr === 'MW3190601').zeichen);
    assert.equal(tam.saves.length, 1);
  });

  it('Zeitraum: Gestern bis Vor 7 Tagen wählen genau diesen Tag', async () => {
    const day = (n) => new Date(new Date().setHours(12, 0, 0, 0) - n * 864e5).toISOString();
    const b = BOOK(); b[0].ts = day(1); b[1].ts = day(3);
    await setup({ orderbook: b });
    const rng = $('tamauto-ob-range');
    assert.deepEqual([...rng.options].map((o) => o.textContent).slice(0, 8), ['Heute', 'Gestern', 'Vorgestern', 'Vor 3 Tagen', 'Vor 4 Tagen', 'Vor 5 Tagen', 'Vor 6 Tagen', 'Vor 7 Tagen']);
    const pick = (v) => { rng.value = v; rng.onchange(); };
    pick('d1'); assert.ok(bookRow('MW3190601')); assert.ok(!bookRow('MW3190602'));
    pick('d3'); assert.ok(!bookRow('MW3190601')); assert.ok(bookRow('MW3190602'));
  });
  it('Automatik (Schalter an): nach dem Schreiben ins Auftragsbuch gebündelt „GS neu“ nur bei eindeutigem Gebiet', async () => {
    await setup({ zeichenAuto: true, zeichenAutoSec: 1 });
    tam.addOrder({ nr: 'MW3190603', plz: '44141', ort: 'Dortmund', id: '3706003' }); // Annahme schreibt ins Auftragsbuch
    assert.ok(await until(() => tam.saves.length >= 2, 20000), `${tam.saves.length} Speicherungen\n` + tam.logs().slice(-6).join('\n'));
    await sleep(500);
    assert.ok(tam.saves.every((s) => /\|GS neu\|/.test(s)), tam.saves.join('\n'));
    assert.equal(book().find((e) => e.nr === 'MW3190602').zeichen, '', 'Mischgebiet darf nicht automatisch gesetzt werden');
    assert.equal(book().find((e) => e.nr === 'MW3190601').zeichen, 'GS neu');
  });

  it('Automatik aus (Standard): nichts wird gesetzt', async () => {
    await setup({ zeichenAutoSec: 1 });
    tam.addOrder({ nr: 'MW3190603', plz: '44141', ort: 'Dortmund', id: '3706003' });
    assert.ok(await until(() => tam.accepted.includes('MW3190603'), 15000));
    await sleep(3000);
    assert.equal(tam.saves.length, 0);
  });

  it('Mail geht nur an den Zugewiesenen: Mischgebiet ohne Zeichen taucht bei niemandem auf', async () => {
    await setup();
    openMa('MB'); assert.doesNotMatch($('tamauto-ma-body').value, /MW3190602/);
    openMa('PM'); assert.doesNotMatch($('tamauto-ma-body').value, /MW3190602/);
    const b = book(); b.find((e) => e.nr === 'MW3190602').zeichen = 'PM neu'; tam.store.set('orderbook', b);
    openMa('PM'); assert.match($('tamauto-ma-body').value, /MW3190602/);
    openMa('MB'); assert.doesNotMatch($('tamauto-ma-body').value, /MW3190602/);
  });

  it('Baustein „Zugewiesen“: Kürzel gesetzt, wieder entfernen oder Termin ausmachen; weitere Aufträge in der Nähe', async () => {
    const b = BOOK(); b[0].zeichen = 'GS neu';
    b.push({ ts: today, nr: 'MW3190604', plz: '44309', ort: 'Dortmund', dienst: 'Standard', tid: '3706004', zeichen: '' });
    await setup({ orderbook: b });
    openMa('GS'); $('tamauto-ma-baustein').value = 'zugewiesen'; $('tamauto-ma-baustein').onchange();
    const t = $('tamauto-ma-body').value;
    assert.match(t, /Kürzel mit „neu“/); assert.match(t, /Kürzel wieder/); assert.match(t, /Termin/);
    assert.match(t, /Weitere Aufträge in der Nähe[\s\S]*MW3190604/);
    assert.match(t.split('Weitere Aufträge in der Nähe')[0], /MW3190601/);
    b[0].zeichen = 'GS 12.10 10:00 T'; tam.store.set('orderbook', b); $('tamauto-ma-baustein').onchange();
    assert.doesNotMatch($('tamauto-ma-body').value.split('Weitere Aufträge in der Nähe')[0], /MW3190601/, 'nur „KÜRZEL neu“ gehört in diese Mail');
  });

  it('Mahnung: Kürzel ohne Datum ist fällig – Zahl am Reiter, Baustein listet nur diese', async () => {
    const b = BOOK(); b[0].zeichen = 'GS neu'; b[1].zeichen = 'PM 12.10 10:00 T';
    await setup({ orderbook: b });
    assert.match(tam.document.querySelector('.tamauto-tabbtn[data-page="tamauto-page-ma"]').textContent, /\(1\)/);
    openMa('GS'); $('tamauto-ma-baustein').value = 'mahnung'; $('tamauto-ma-baustein').onchange();
    assert.match($('tamauto-ma-subject').value, /Erinnerung/); assert.match($('tamauto-ma-body').value, /MW3190601/);
    assert.match($('tamauto-ma-mahn').textContent, /Mahnung fällig: 1/);
    openMa('PM'); $('tamauto-ma-baustein').value = 'mahnung'; $('tamauto-ma-baustein').onchange();
    assert.doesNotMatch($('tamauto-ma-body').value, /MW3190602/); // hat schon eine Tour
  });
});
