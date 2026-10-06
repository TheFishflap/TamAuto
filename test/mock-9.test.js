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

  it('Dropdown wählen → Zeichen „PM neu“ wird still gesetzt', async () => {
    await setup();
    const sel = bookRow('MW3190602').querySelector('select');
    sel.value = 'PM'; sel.dispatchEvent(new tam.window.Event('change', { bubbles: true }));
    assert.ok(await until(() => tam.saves.length === 1, 3000), tam.logs().slice(-4).join('\n'));
    assert.match(tam.saves[0], /\|PM neu\|/);
    assert.ok(await until(() => book().find((e) => e.nr === 'MW3190602').zeichen === 'PM neu', 2000));
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
    assert.match(t, /Kürzel gesetzt/); assert.match(t, /Kürzel wieder/); assert.match(t, /Termin/);
    assert.match(t, /Weitere Aufträge in der Nähe[\s\S]*MW3190604/);
    assert.match(t.split('Weitere Aufträge in der Nähe')[0], /MW3190601/);
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
