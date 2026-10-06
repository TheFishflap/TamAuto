// MA-Management: Zuordnung zum Marktgebiet, SLA-Ampel, Kontaktzeile, Kennzeichenversand, Mail-Entwurf (reine Logik).
'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'tam-auto-annahme.user.js'), 'utf8');
const a = src.indexOf('// <ma-logik>'), b = src.indexOf('// </ma-logik>');
if (a < 0 || b < 0) throw new Error('Marker <ma-logik> fehlt im Script');
const L = new Function(`${src.slice(a, b)}; return { maFuerPlz, ampel, kontaktText, gruppiere, baueMail, istKennzeichen };`)();

const NOW = new Date(2026, 9, 6, 15, 0); // 06.10.2026 15:00
const MA = [{ k: 'MK', name: 'Markus Kirschbaum', mail: 'mk@x.de', gebiet: ['44', '45'] }, { k: 'PM', name: 'Petra M.', mail: 'pm@x.de', gebiet: ['45', '46'] }, { k: 'XX', name: 'Ohne', mail: '', gebiet: [] }];
const o = (nr, plz, extra = {}) => ({ nr, plz, ort: 'Ort', strasse: '', dienst: 'Standard', status: '', sla: '', ref: '', kontakt: null, ...extra });

describe('Marktgebiet', () => {
  it('PLZ-Anfang → alle zuständigen MA (geteilte Gebiete)', () => {
    assert.deepEqual(L.maFuerPlz('44141', MA).map((m) => m.k), ['MK']);
    assert.deepEqual(L.maFuerPlz('45127', MA).map((m) => m.k), ['MK', 'PM']);
    assert.deepEqual(L.maFuerPlz('99999', MA), []);
    assert.deepEqual(L.maFuerPlz('', MA), []);
  });
  it('genaue PLZ als Gebiet', () => { assert.equal(L.maFuerPlz('22559', [{ k: 'A', gebiet: ['22559'] }]).length, 1); assert.equal(L.maFuerPlz('22560', [{ k: 'A', gebiet: ['22559'] }]).length, 0); });
});

describe('SLA-Ampel (Endtermin Agent)', () => {
  it('rot ≤ 2 h oder überfällig, gelb ≤ 24 h, sonst nichts', () => {
    assert.equal(L.ampel('06.10.2026 16:30', NOW), 'rot');
    assert.equal(L.ampel('06.10.2026 14:00', NOW), 'rot');
    assert.equal(L.ampel('07.10.2026 09:00', NOW), 'gelb');
    assert.equal(L.ampel('09.10.2026 09:00', NOW), '');
    assert.equal(L.ampel('', NOW), '');
  });
});

describe('Kontaktzeile', () => {
  const k = { name: 'Frau Muster', telefon: '0171 1234567', mail: 'm@x.de' };
  it('Telefon, wenn vorhanden', () => assert.equal(L.kontaktText(o('MW1', '44141', { kontakt: k })), 'Frau Muster, Tel. 0171 1234567'));
  it('Termin ohne Telefon → E-Mail', () => assert.equal(L.kontaktText(o('MW1', '44141', { status: 'Terminvereinbarung', kontakt: { ...k, telefon: '' } })), 'Frau Muster, m@x.de'));
  it('ohne Termin und ohne Telefon → keine Zeile', () => assert.equal(L.kontaktText(o('MW1', '44141', { kontakt: { ...k, telefon: '' } })), ''));
  it('Sixt: Telefonzeile immer, ohne Nummer leer', () => {
    assert.equal(L.kontaktText(o('MW1', '44141', { dienst: 'Sixt Rückgabe', kontakt: { ...k, telefon: '' } })), 'Tel.');
    assert.equal(L.kontaktText(o('MW1', '44141', { dienst: 'Sixt Rückgabe', kontakt: null })), 'Tel.');
    assert.equal(L.kontaktText(o('MW1', '44141', { dienst: 'Sixt Rückgabe', kontakt: k })), 'Frau Muster, Tel. 0171 1234567');
  });
  it('kein Kontakt bekannt → keine Zeile', () => assert.equal(L.kontaktText(o('MW1', '44141')), ''));
});

describe('Kennzeichenversand', () => {
  it('erkennt Versand/Handling, nicht „ohne Kennzeichenversand“', () => {
    assert.ok(L.istKennzeichen('VWFS ZB I - und/oder Kennzeichenversand durchgeführt*'));
    assert.ok(L.istKennzeichen('Kennzeichenhandling NEU'));
    assert.ok(!L.istKennzeichen('VTI EASI LRO ohne Kennzeichenversand (P)'));
    assert.ok(!L.istKennzeichen('Zustandsbericht'));
  });
  it('wird unter den Hauptauftrag (gleiche PLZ/Ort) gelegt, kein Duplikat', () => {
    const g = L.gruppiere([o('MW1', '44141'), o('MW2', '44141', { dienst: 'Kennzeichenversand' }), o('MW3', '45127')]);
    assert.deepEqual(g.haupt.map((x) => x.nr), ['MW1', 'MW3']);
    assert.deepEqual(g.haupt[0].extra.map((x) => x.nr), ['MW2']);
    assert.equal(g.solo.length, 0);
  });
  it('mehrere Kandidaten: gleiche Referenz entscheidet; sonst einzeln', () => {
    const g = L.gruppiere([o('MW1', '44141', { ref: 'AAA' }), o('MW3', '44141', { ref: 'BBB' }), o('MW2', '44141', { dienst: 'Kennzeichenversand', ref: 'BBB' })]);
    assert.deepEqual(g.haupt.find((x) => x.nr === 'MW3').extra.map((x) => x.nr), ['MW2']);
    const h = L.gruppiere([o('MW1', '44141'), o('MW3', '44141'), o('MW2', '44141', { dienst: 'Kennzeichenversand' })]);
    assert.deepEqual(h.solo.map((x) => x.nr), ['MW2']);
  });
  it('ohne Hauptauftrag → einzeln', () => assert.deepEqual(L.gruppiere([o('MW2', '44141', { dienst: 'Kennzeichenhandling NEU' })]).solo.map((x) => x.nr), ['MW2']));
});

describe('Mail-Entwurf', () => {
  const orders = [
    o('MW3', '45127', { ort: 'Essen', sla: '09.10.2026 09:00' }),
    o('MW1', '44141', { ort: 'Dortmund', strasse: 'Hauptstr. 5', sla: '06.10.2026 16:00', kontakt: { name: 'Frau Muster', telefon: '0171 1234567', mail: '' } }),
    o('MW2', '44141', { ort: 'Dortmund', dienst: 'Kennzeichenversand', sla: '06.10.2026 16:00' }),
    o('MW4', '44309', { ort: 'Dortmund', sla: '07.10.2026 09:00', dienst: 'Sixt Rückgabe' }),
  ];
  const mail = L.baueMail({ ma: MA[0], orders, baustein: 'neu', absender: 'Leonie Struve', cc: ['auftrag@x.de', 'silke@x.de'], now: NOW });
  it('Empfänger, Cc und Betreff', () => {
    assert.equal(mail.to, 'mk@x.de'); assert.deepEqual(mail.cc, ['auftrag@x.de', 'silke@x.de']);
    assert.match(mail.subject, /Neue Aufträge/); assert.match(mail.subject, /\(3\)/); // MW2 ist Kennzeichenversand unter MW1
  });
  it('rot vor gelb vor Rest; Kennzeichenversand nur benannt', () => {
    const b = mail.body; assert.ok(b.indexOf('MW1') < b.indexOf('MW4') && b.indexOf('MW4') < b.indexOf('MW3'), b);
    assert.match(b, /\+ Kennzeichenversand MW2/); assert.equal((b.match(/MW2/g) || []).length, 1);
    assert.match(b, /SLA bis 06\.10\.2026 16:00 \(rot\)/); assert.match(b, /\(gelb\)/);
  });
  it('Telefon bzw. leere Sixt-Zeile', () => { assert.match(mail.body, /Frau Muster, Tel\. 0171 1234567/); assert.match(mail.body, /MW4[^\n]*\n\s+Tel\.\s*\n/); });
  it('Anrede, Tourhinweis mit Beispiel und Signatur', () => {
    assert.match(mail.body, /^Hallo Markus,/); assert.match(mail.body, /MK 07\.10 10:00/);
    assert.match(mail.body, /Liebe Grüße\nLeonie Struve$/);
  });
  it('Bausteine Tour/Mahnung/PMA', () => {
    for (const [bs, re] of [['tour', /Tour/], ['mahnung', /Erinnerung/], ['pma', /Problem mit Auftrag/]]) assert.match(L.baueMail({ ma: MA[0], orders, baustein: bs, absender: '', cc: [], now: NOW }).subject + L.baueMail({ ma: MA[0], orders, baustein: bs, absender: '', cc: [], now: NOW }).body, re, bs);
  });
  it('ohne Absender keine Signaturzeile mit Namen', () => assert.doesNotMatch(L.baueMail({ ma: MA[0], orders, baustein: 'neu', absender: '', cc: [], now: NOW }).body, /Liebe Grüße\n\S/));
});
