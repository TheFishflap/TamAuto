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
  it('nur Kürzel → Datum fehlt', () => { const r = p('MK'); assert.equal(r.status, 'ohneDatum'); assert.equal(r.kuerzel, 'MK'); });
  it('Kürzel mit Zeit, aber ohne Datum → Datum fehlt', () => { assert.equal(p('MK 10:00').status, 'ohneDatum'); });
  it('Datum ohne Kürzel → Kürzel fehlt', () => { const r = p('12.10 10:00'); assert.equal(r.status, 'ohneKuerzel'); assert.equal(r.kuerzel, ''); });
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
