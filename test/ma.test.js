// MA-Management: Zuordnung zum Marktgebiet, SLA-Ampel, Kontaktzeile, Kennzeichenversand, Mail-Entwurf (reine Logik).
'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'tam-auto-annahme.user.js'), 'utf8');
const a = src.indexOf('// <ma-logik>'), b = src.indexOf('// </ma-logik>');
if (a < 0 || b < 0) throw new Error('Marker <ma-logik> fehlt im Script');
const L = new Function(`${src.slice(a, b)}; return { maFuerPlz, ampel, kontaktText, gruppiere, baueMail, istKennzeichen, parseGebiet, maFuerAuftrag };`)();

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
  it('ab 150 € ist eine Terminvereinbarung Pflicht: Telefon, sonst E-Mail', () => {
    assert.equal(L.kontaktText(o('MW1', '44141', { preis: 150, kontakt: { ...k, telefon: '' } })), 'Frau Muster, m@x.de');
    assert.equal(L.kontaktText(o('MW1', '44141', { preis: 199.9, kontakt: k })), 'Frau Muster, Tel. 0171 1234567');
    assert.equal(L.kontaktText(o('MW1', '44141', { preis: 149.99, kontakt: { ...k, telefon: '' } })), '');
    assert.equal(L.kontaktText(o('MW1', '44141', { preis: null, kontakt: { ...k, telefon: '' } })), '');
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
  it('Aufträge als Tabelle: Kopfzeile, Trennlinie, eine Zeile je Auftrag mit Kontakt', () => {
    const lines = mail.body.split('\n'), hi = lines.findIndex((l) => /^Auftrag\s+\| PLZ \/ Ort\s+\| SLA bis\s+\| Kontakt\s+\| Hinweis$/.test(l));
    assert.ok(hi >= 0, mail.body);
    assert.match(lines[hi + 1], /^-+(-\+-)-*/);
    assert.equal(lines[hi + 5], ''); // Kopf + Trennlinie + 3 Aufträge (Kennzeichenversand liegt unter MW1), danach Leerzeile
    const r1 = lines.slice(hi + 2, hi + 5).find((l) => l.startsWith('MW1'));
    assert.match(r1, /44141 Dortmund, Hauptstr\. 5\s+\| 🔴 06\.10\.2026 16:00\s+\| Frau Muster, Tel\. 0171 1234567\s+\| \+ Kennzeichenversand MW2$/);
  });
  it('rot vor gelb vor Rest; Kennzeichenversand nur benannt', () => {
    const b = mail.body; assert.ok(b.indexOf('MW1') < b.indexOf('MW4') && b.indexOf('MW4') < b.indexOf('MW3'), b);
    assert.match(b, /\+ Kennzeichenversand MW2/); assert.equal((b.match(/MW2/g) || []).length, 1);
    assert.match(b, /🔴 06\.10\.2026 16:00/); assert.match(b, /🟡/);
  });
  it('Terminpflicht (Status oder ≥ 150 €) steht in der Mail', () => {
    const m = L.baueMail({ ma: MA[0], orders: [o('MW7', '44141', { preis: 150 }), o('MW8', '44141', { status: 'Terminvereinbarung' }), o('MW9', '44141', { preis: 69.35 })], baustein: 'neu', absender: '', cc: [], now: NOW });
    assert.equal((m.body.match(/Termin erforderlich/g) || []).length, 2);
  });
  it('Telefon bzw. leere Sixt-Zeile', () => { assert.match(mail.body, /Frau Muster, Tel\. 0171 1234567/); assert.match(mail.body, /^MW4[^\n]*\| Tel\.\s*(\|[^\n]*)?$/m); });
  it('Tabelle zusätzlich als HTML (zum Einfügen in die Mail), Inhalt maskiert', () => {
    const m2 = L.baueMail({ ma: MA[0], orders: [o('MW5', '44141', { ort: 'A<b>&Co', kontakt: { name: 'X', telefon: '0171 1', mail: '' } })], baustein: 'neu', absender: '', cc: [], now: NOW });
    assert.match(m2.html, /<table/); assert.match(m2.html, /<th[^>]*>Auftrag<\/th>/); assert.match(m2.html, /MW5/);
    assert.match(m2.html, /A&lt;b&gt;&amp;Co/); assert.doesNotMatch(m2.html, /<b>&Co/);
    assert.match(m2.html, /Hallo Markus/);
  });
  it('Anrede, Tourhinweis mit Beispiel und Signatur', () => {
    assert.match(mail.body, /^Hallo Markus,/); assert.match(mail.body, /MK 07\.10 10:00/);
    assert.match(mail.body, /Liebe Grüße\nLeonie Struve$/);
  });
  it('Baustein „Termin vereinbaren und Kurzzeichen hinzufügen“ verbindet beides', () => {
    const m = L.baueMail({ ma: MA[0], orders, baustein: 'termin', absender: '', cc: [], now: NOW });
    assert.match(m.subject, /Termin vereinbaren und Kurzzeichen/);
    assert.match(m.body, /vereinbare.*Termin/i); assert.match(m.body, /Kurzzeichen|Ihr Zeichen/); assert.match(m.body, /MK 07\.10 10:00/);
    assert.match(m.body, /Frau Muster, Tel\. 0171 1234567/); // Kontakt wie bei den anderen Bausteinen
  });
  it('Bausteine Tour/Mahnung/PMA', () => {
    for (const [bs, re] of [['tour', /Tour/], ['mahnung', /Erinnerung/], ['pma', /Problem mit Auftrag/]]) assert.match(L.baueMail({ ma: MA[0], orders, baustein: bs, absender: '', cc: [], now: NOW }).subject + L.baueMail({ ma: MA[0], orders, baustein: bs, absender: '', cc: [], now: NOW }).body, re, bs);
  });
  it('ohne Absender keine Signaturzeile mit Namen', () => assert.doesNotMatch(L.baueMail({ ma: MA[0], orders, baustein: 'neu', absender: '', cc: [], now: NOW }).body, /Liebe Grüße\n\S/));
});

// Marktgebiete nach Ort (Blatt „Marktgebiete“: PLZ-Anfang | Ort mit Hinweisen | MA-Kürzel) – echte Zeilen aus der Ortsliste
describe('Marktgebiete nach Ort', () => {
  const rows = [['40', 'Düsseldorf', 'MB PM'], ['40', 'Gladbeck', 'MK'], ['41', 'Neuss', 'MB MN PM'], ['42', 'SIXT Wupper, Soling, Leverkusen', 'LU'],
    ['42', 'Wuppertal - nur 42106', 'MK'], ['44', 'Dortmund, Preußische Straße', 'GS'], ['45', 'Mülheim', 'MK'], ['45', 'Hattingen mit 40€ nicht', 'MK'],
    ['50', 'Köln', 'PM'], ['51', 'Köln, Taunusstraße', 'LU'], ['58', 'Hagen nur Choice', 'GS'], ['50', 'Erftstadt, Theodor-Heuss-Str', 'MB'], ['67', 'Rodenbach, Gartenstraße', 'JHO']]
    .map(([plz, ort, ma]) => L.parseGebiet({ plz, ort, ma }));
  const z = (plz, ort, dienst = 'Standard') => L.maFuerAuftrag({ plz, ort, dienst }, rows);
  it('Ort und PLZ-Anfang zusammen; geteilte Gebiete → mehrere Kürzel', () => {
    assert.deepEqual(z('40213', 'Düsseldorf'), ['MB', 'PM']);
    assert.deepEqual(z('41460', 'Neuss'), ['MB', 'MN', 'PM']);
    assert.deepEqual(z('40764', 'Mettmann'), []); // Ort nicht in der Liste
  });
  it('gleicher PLZ-Anfang, verschiedene Orte → verschiedene MA', () => {
    assert.deepEqual(z('40213', 'Düsseldorf'), ['MB', 'PM']);
    assert.deepEqual(z('45966', 'Gladbeck'), []); // echte PLZ 45966, in der Excel steht 40 → „nicht zugeordnet“ (Excel korrigieren)
    assert.deepEqual(z('40999', 'Gladbeck'), ['MK']);
  });
  it('Straßen- und Hinweisteile werden ignoriert (Dortmund, Preußische Straße → Dortmund)', () => {
    assert.deepEqual(z('44141', 'Dortmund'), ['GS']);
    assert.deepEqual(z('50321', 'Erftstadt'), ['MB']);
    assert.deepEqual(z('67688', 'Rodenbach'), ['JHO']);
    assert.deepEqual(z('45525', 'Hattingen'), ['MK']); // „mit 40€ nicht“ ist nur ein Hinweis
  });
  it('„nur 42106“: nur diese PLZ', () => { assert.deepEqual(z('42106', 'Wuppertal'), ['MK']); assert.deepEqual(z('42289', 'Wuppertal'), []); });
  it('„nur Choice“: nur für Aufträge dieser Dienstleistung', () => {
    assert.deepEqual(z('58095', 'Hagen', 'Choice - Minderwertgutachten'), ['GS']);
    assert.deepEqual(z('58095', 'Hagen', 'Standard'), []);
  });
  it('Zeile mit SIXT: nur für Sixt-Aufträge, mehrere Orte, PLZ egal', () => {
    assert.deepEqual(z('51379', 'Leverkusen', 'Sixt Rückgabe'), ['LU']);
    assert.deepEqual(z('51379', 'Leverkusen', 'Standard'), []);
    assert.deepEqual(z('42651', 'Solingen', 'Sixt Rückgabe'), ['LU']);
    assert.deepEqual(z('42106', 'Wuppertal', 'Sixt Rückgabe'), ['LU', 'MK']);
  });
  it('Ortsnamen mit Zusatz zählen, andere Orte mit gleichem Anfang nicht', () => {
    assert.deepEqual(z('45468', 'Mülheim an der Ruhr'), ['MK']);
    assert.deepEqual(z('56218', 'Mülheim-Kärlich'), []);
    assert.deepEqual(z('50667', 'Köln'), ['PM']);
    assert.deepEqual(z('51063', 'Köln'), ['LU']);
  });
});
