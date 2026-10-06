// Tourzeichen-Erkennung („Ihr Zeichen“): Kürzel, Datum und Uhrzeit in beliebiger Reihenfolge.
// Die Funktion steckt im Userscript (zwischen den Markern <zeichen-parser>) und wird hier ohne Browser ausgeführt.
'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'tam-auto-annahme.user.js'), 'utf8');
const block = src.slice(src.indexOf('// <zeichen-parser>'), src.indexOf('// </zeichen-parser>'));
if (!block) throw new Error('Marker <zeichen-parser> fehlt im Script');
const parse = new Function(`${block}; return parseTourzeichen;`)();

const KUERZEL = ['MK', 'PM', 'MB', 'AB'];
const p = (s, now = new Date(2026, 9, 6)) => parse(s, KUERZEL, now); // „heute“ = 06.10.2026
const ok = (r, k, d, m, h, mi) => {
  assert.equal(r.kuerzel, k, JSON.stringify(r));
  assert.deepEqual(r.datum && [r.datum.d, r.datum.m], [d, m], JSON.stringify(r));
  assert.deepEqual(r.zeit && [r.zeit.h, r.zeit.m], h === null ? null : [h, mi], JSON.stringify(r));
};

describe('Tourzeichen', () => {
  it('Normalfall: Kürzel Datum Uhrzeit', () => { const r = p('MK 12.10 10:00'); ok(r, 'MK', 12, 10, 10, 0); assert.equal(r.status, 'tour'); });
  it('beliebige Reihenfolge', () => {
    for (const s of ['12.10 MK 10:00', '10:00 12.10 MK', '10:00 MK 12.10', '12.10 10:00 MK', 'MK 10:00 12.10']) ok(p(s), 'MK', 12, 10, 10, 0);
  });
  it('Schreibweisen: Punkt am Ende, Jahr, Schrägstrich, Groß-/Kleinschreibung', () => {
    ok(p('mk 12.10. 10:00'), 'MK', 12, 10, 10, 0);
    ok(p('MK 12.10.26 10:00'), 'MK', 12, 10, 10, 0);
    ok(p('MK 12/10 10:00'), 'MK', 12, 10, 10, 0);
    ok(p('Mk 12-10 10:00'), 'MK', 12, 10, 10, 0);
  });
  it('Uhrzeit-Varianten', () => {
    ok(p('MK 12.10 10 Uhr'), 'MK', 12, 10, 10, 0);
    ok(p('MK 12.10 10h'), 'MK', 12, 10, 10, 0);
    ok(p('MK 12.10 9.30'), 'MK', 12, 10, 9, 30);   // 9.30 kann kein Datum sein (Monat 30)
    ok(p('MK 12.10 10.00'), 'MK', 12, 10, 10, 0);  // 10.00 kann kein Datum sein (Monat 00)
    ok(p('MK 12.10 8:5'), 'MK', 12, 10, null);     // unvollständige Uhrzeit → keine Zeit
  });
  it('Monatsnamen wie im bisherigen Zeichen („PM Okt 07 10 T“)', () => {
    const r = p('PM Okt 07 10 T'); assert.equal(r.kuerzel, 'PM'); assert.deepEqual([r.datum.d, r.datum.m], [7, 10]);
    const q = p('PM Sep 02 -> MB erl'); assert.equal(q.kuerzel, 'PM'); assert.deepEqual([q.datum.d, q.datum.m], [2, 9]);
    ok(p('MK 12. Okt 10:00'), 'MK', 12, 10, 10, 0);
    ok(p('MK 12 Oktober 10:00'), 'MK', 12, 10, 10, 0);
  });
  it('Kontaktstatus am Ende: T/M = bestätigt, t/m = nur Versuch (Groß-/Kleinschreibung zählt)', () => {
    const r = p('PM Okt 07 10 T');
    assert.equal(r.kuerzel, 'PM'); assert.deepEqual([r.datum.d, r.datum.m], [7, 10]); assert.deepEqual([r.zeit.h, r.zeit.m], [10, 0]);
    assert.equal(r.kontakt, 'T'); assert.equal(r.bestaetigt, true); assert.equal(r.versuch, false);
    for (const [s, k, b] of [['MK 12.10 10:00 T', 'T', true], ['MK 12.10 10:00 t', 't', false], ['MK 12.10 10:00 M', 'M', true], ['MK 12.10 10:00 m', 'm', false], ['T MK 12.10 10:00', 'T', true]]) {
      const x = p(s); assert.equal(x.kuerzel, 'MK', s); assert.equal(x.kontakt, k, s); assert.equal(x.bestaetigt, b, s); assert.equal(x.versuch, !b, s);
    }
    const o = p('MK 12.10 10:00'); assert.equal(o.kontakt, ''); assert.equal(o.bestaetigt, false); assert.equal(o.versuch, false);
  });
  it('Kombinationen aus T/t/M/m (z. B. „tm“ = Telefon- und Mailversuch)', () => {
    const r = p('LE tm'); assert.equal(r.kuerzel, 'LE'); assert.equal(r.kontakt, 'tm'); assert.equal(r.versuch, true); assert.equal(r.bestaetigt, false);
    const s = p('MK 12.10 10:00 Tm'); assert.equal(s.kontakt, 'Tm'); assert.equal(s.bestaetigt, true); assert.equal(s.versuch, false); // T bestätigt, m nur Versuch
    assert.equal(p('MK 12.10 10:00 tmt').kontakt, 'tmt');
    assert.equal(p('MK 12.10 10:00 ttmm').kontakt, ''); // zu lang → kein Kontaktstatus
  });
  it('bekanntes Kürzel hat Vorrang vor Kontaktbuchstaben (MM, TM)', () => {
    const r = parse('MM 12.10 10:00', ['MM', 'MK'], new Date(2026, 9, 6)); assert.equal(r.kuerzel, 'MM'); assert.equal(r.kontakt, '');
    assert.equal(parse('tm 12.10', ['TM'], new Date(2026, 9, 6)).kuerzel, 'TM');
  });
  it('einzelne Zahl neben dem Datum ist die volle Stunde (10 → 10:00)', () => {
    ok(p('MK 12.10 10'), 'MK', 12, 10, 10, 0);
    ok(p('MK 12.10 8 T'), 'MK', 12, 10, 8, 0);
    assert.equal(p('MK 12.10 25').zeit, null);   // keine gültige Stunde
    assert.equal(p('MK 31.02 10').zeit, null);   // ohne gültiges Datum keine Stunde aus losen Zahlen
  });
  it('Kontaktbuchstabe wird nie als Kürzel genommen', () => { const r = p('T'); assert.equal(r.kuerzel, ''); assert.equal(r.kontakt, 'T'); assert.equal(r.status, 'unklar'); });
  it('nur Kürzel → Datum fehlt', () => { const r = p('MK'); assert.equal(r.status, 'ohneDatum'); assert.equal(r.kuerzel, 'MK'); });
  it('Kürzel mit Zeit, aber ohne Datum → Datum fehlt', () => { assert.equal(p('MK 10:00').status, 'ohneDatum'); });
  it('Datum ohne Kürzel → Kürzel fehlt', () => { const r = p('12.10 10:00'); assert.equal(r.status, 'ohneKuerzel'); assert.equal(r.kuerzel, ''); });
  it('„?“ = Zeichen ungeklärt (eigener Status)', () => { for (const s of ['?', ' ? ', '??']) assert.equal(p(s).status, 'ungeklaert', s); assert.equal(p('MK ?').status, 'ohneDatum'); });
  it('„zurück LH“ = Rückgabe an LH', () => {
    for (const s of ['zurück LH', 'Zurueck LH', 'LH zurück', 'ZURÜCK an LH']) { const r = p(s); assert.equal(r.status, 'rueckgabe', s); assert.equal(r.rueckgabe, true, s); }
    assert.equal(parse('zurück LH', ['LH', 'MK'], new Date(2026, 9, 6)).kuerzel, 'LH');
    assert.equal(p('MK 12.10 10:00').rueckgabe, false);
  });
  it('neu bekannte Kürzel LE, VV, TV', () => {
    const r = parse('VV TV', ['LE', 'VV', 'TV'], new Date(2026, 9, 6)); assert.equal(r.kuerzel, 'VV'); assert.equal(r.bekannt, true); assert.equal(r.status, 'ohneDatum');
    assert.equal(parse('LE tm', ['LE'], new Date(2026, 9, 6)).kuerzel, 'LE');
  });
  it('leer', () => { assert.equal(p('').status, 'leer'); assert.equal(p('   ').status, 'leer'); assert.equal(p(null).status, 'leer'); });
  it('unbekanntes Kürzel wird als solches erkannt, aber markiert', () => { const r = p('XY 12.10 10:00'); assert.equal(r.kuerzel, 'XY'); assert.equal(r.bekannt, false); assert.equal(p('MK 12.10').bekannt, true); });
  it('ohne Kürzelliste wird jedes 2–4-stellige Wort als Kürzel genommen', () => { assert.equal(parse('ZZ 12.10 10:00', [], new Date(2026, 9, 6)).kuerzel, 'ZZ'); });
  it('Datum in der Vergangenheit → „vergangen“, heute und Zukunft nicht', () => {
    assert.equal(p('MK 05.10 10:00').vergangen, true);
    assert.equal(p('MK 06.10 10:00').vergangen, false);
    assert.equal(p('MK 07.10 10:00').vergangen, false);
  });
  it('Jahreswechsel: 02.01. im Dezember gilt für das nächste Jahr', () => {
    const r = p('MK 02.01 10:00', new Date(2026, 11, 28)); assert.equal(r.vergangen, false); assert.equal(r.datum.y, 2027);
  });
  it('ungültiges Datum (31.02, 32.01) wird nicht als Datum gewertet', () => { assert.equal(p('MK 31.02 10:00').datum, null); assert.equal(p('MK 32.01').datum, null); });
});
