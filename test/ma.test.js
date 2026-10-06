// MA-Management: SLA-Ampel, Kontaktzeile, Kennzeichenversand, Mail-Entwurf (reine Logik).
'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'tam-auto-annahme.user.js'), 'utf8');
const a = src.indexOf('// <ma-logik>'), b = src.indexOf('// </ma-logik>');
if (a < 0 || b < 0) throw new Error('Marker <ma-logik> fehlt im Script');
const L = new Function(`${src.slice(a, b)}; return { ampel, kontaktText, gruppiere, baueMail, istKennzeichen };`)();

const NOW = new Date(2026, 9, 6, 15, 0); // 06.10.2026 15:00
const MA = [{ k: 'MK', name: 'Markus Kirschbaum', mail: 'mk@x.de', gebiet: ['44', '45'] }, { k: 'PM', name: 'Petra M.', mail: 'pm@x.de', gebiet: ['45', '46'] }, { k: 'XX', name: 'Ohne', mail: '', gebiet: [] }];
const o = (nr, plz, extra = {}) => ({ nr, plz, ort: 'Ort', strasse: '', dienst: 'Standard', status: '', sla: '', ref: '', kontakt: null, ...extra });

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

describe('Mail „neue Terminvereinbarung“', () => {
  const orders = [
    o('MW3', '45127', { ort: 'Essen', sla: '09.10.2026 09:00', preis: 200 }),
    o('MW1', '44141', { ort: 'Dortmund', strasse: 'Hauptstr. 5', dienst: 'Sixt Rückgabe', resEnde: '06.10.2026 16:00', preis: 180, kontakt: { name: 'Frau Muster', telefon: '0171 1234567', mail: '' } }),
    o('MW2', '44141', { ort: 'Dortmund', dienst: 'Kennzeichenversand', sla: '06.10.2026 16:00' }),
    o('MW4', '44309', { ort: 'Dortmund', sla: '07.10.2026 09:00', dienst: 'Sixt Rückgabe' }),
  ];
  const mail = L.baueMail({ ma: MA[0], orders, absender: 'Leonie Struve', cc: ['auftrag@x.de', 'silke@x.de'], now: NOW });
  it('Empfänger, Cc und Betreff', () => {
    assert.equal(mail.to, 'mk@x.de'); assert.deepEqual(mail.cc, ['auftrag@x.de', 'silke@x.de']);
    assert.match(mail.subject, /^Neue Terminvereinbarung .* in .* \(3\)$/); assert.match(mail.subject, /Sixt Rückgabe/); assert.match(mail.subject, /Dortmund/); // MW2 ist Kennzeichenversand unter MW1
  });
  it('Tabelle: Auftrag · PLZ/Ort · Auftragsart · Reservierung bis · Kontakt; Reservierungsende (Fenster vor Endtermin) mit Flagge und Stunden', () => {
    const lines = mail.body.split('\n'), hi = lines.findIndex((l) => /^Auftrag\s+\| FIN\s+\| PLZ \/ Ort\s+\| Auftragsart\s+\| Reservierung bis\s+\| Kontakt$/.test(l));
    assert.ok(hi >= 0, mail.body);
    assert.match(lines[hi + 1], /^-+(-\+-)-*/);
    assert.equal(lines[hi + 5], '');
    const r1 = lines.slice(hi + 2, hi + 5).find((l) => l.startsWith('MW1'));
    assert.match(r1, /MW1 \+ Kennzeichenversand MW2\s+\|\s*\| 44141 Dortmund, Hauptstr\. 5\s+\| Sixt Rückgabe\s+\| 🔴 06\.10\.2026 16:00 \(in 1 h\)\s+\| Frau Muster, Tel\. 0171 1234567$/);
  });
  it('nach FIN sortiert (dann Reservierungsende); Kennzeichenversand nur benannt', () => {
    const ms = L.baueMail({ ma: MA[0], orders: [o('MWB', '44141', { ref: 'FIN2', sla: '06.10.2026 16:00' }), o('MWA', '45127', { ref: 'FIN1', sla: '09.10.2026 09:00' }), o('MWC', '44309', { sla: '07.10.2026 09:00' })], absender: '', cc: [], now: NOW }).body;
    assert.ok(ms.indexOf('MWA') < ms.indexOf('MWB') && ms.indexOf('MWB') < ms.indexOf('MWC'), ms); // ohne FIN zuletzt
    const b = mail.body; assert.equal((b.match(/MW2/g) || []).length, 1); assert.match(b, /🟡/);
  });
  it('ein Auftrag: Satz mit Auftragsart und „Die Reservierung läuft in x Stunden aus …“', () => {
    const m = L.baueMail({ ma: MA[0], orders: [orders[1]], absender: '', cc: [], now: NOW });
    assert.match(m.body, /für dich ist ein Sixt Rückgabe Auftrag angenommen worden/);
    assert.match(m.body, /Die Reservierung läuft in 1 Stunden aus, bitte kümmere dich zeitig um eine Terminvereinbarung\./);
  });
  it('mehrere Aufträge: Mehrzahl-Text', () => {
    assert.match(mail.body, /für dich sind Aufträge angenommen worden/); assert.match(mail.body, /Die Reservierung läuft zu den angegebenen Zeiten aus/);
  });
  it('Telefon bzw. leere Sixt-Zeile', () => { assert.match(mail.body, /Frau Muster, Tel\. 0171 1234567/); assert.match(mail.body, /^MW4[^\n]*\| Tel\.\s*$/m); });
  it('Tabelle zusätzlich als HTML (zum Einfügen in die Mail), Inhalt maskiert', () => {
    const m2 = L.baueMail({ ma: MA[0], orders: [o('MW5', '44141', { ort: 'A<b>&Co', kontakt: { name: 'X', telefon: '0171 1', mail: '' } })], absender: '', cc: [], now: NOW });
    assert.match(m2.html, /<table/); assert.match(m2.html, /<th[^>]*>Auftrag<\/th>/); assert.match(m2.html, /MW5/);
    assert.match(m2.html, /A&lt;b&gt;&amp;Co/); assert.doesNotMatch(m2.html, /<b>&Co/);
    assert.match(m2.html, /Hallo Markus/);
  });
  it('Anrede und Signatur; ohne Absender keine Namenszeile', () => {
    assert.match(mail.body, /^Hallo Markus,/); assert.match(mail.body, /Liebe Grüße\nLeonie Struve$/);
    assert.doesNotMatch(L.baueMail({ ma: MA[0], orders, absender: '', cc: [], now: NOW }).body, /Liebe Grüße\n\S/);
  });
});
