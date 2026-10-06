// Leser für TAMs Listenantwort (GWT-RPC loadTeilauftraege): Kontakt/Telefon je Auftragsnummer.
// Die Funktion steckt im Userscript (zwischen den Markern <liste-parser>) und wird hier ohne Browser ausgeführt.
'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'tam-auto-annahme.user.js'), 'utf8');
const a = src.indexOf('// <liste-parser>'), b = src.indexOf('// </liste-parser>');
if (a < 0 || b < 0) throw new Error('Marker <liste-parser> fehlt im Script');
const parse = new Function(`${src.slice(a, b)}; return parseListeKontakte;`)();

const T = 'x.model.auftraege.Teilauftrag/1';
const resp = (nums, table) => `//OK[${nums.join(',')},${JSON.stringify(table)},0,7]`;

describe('Listenantwort lesen (synthetisch)', () => {
  it('Kontakt, Telefon und E-Mail je Auftragsnummer', () => {
    const m = parse(resp([1, 2, 3, 1, 4, 5], [T, 'MW3000001', 'Max Muster\nTel. unbekannt\n0171 1234567\nE-Mail: m@x.de', 'MW3000002', 'Anna Beispiel\nE-Mail: a@x.de']));
    assert.equal(m.size, 2);
    assert.deepEqual(m.get('MW3000001'), { name: 'Max Muster', telefon: '0171 1234567', mail: 'm@x.de', eindeutig: true });
    assert.deepEqual(m.get('MW3000002'), { name: 'Anna Beispiel', telefon: '', mail: 'a@x.de', eindeutig: true }); // ohne Telefon
  });
  it('Auftragsnummer in zwei Datensätzen → nicht eindeutig', () => {
    const m = parse(resp([1, 2, 3, 1, 2, 4], [T, 'MW3000001', 'A\n0111 111111\nE-Mail: a@x.de', 'B\n0222 222222\nE-Mail: b@x.de']));
    assert.equal(m.get('MW3000001').eindeutig, false);
  });
  it('GWT-Escapes in Texten (\\x26, \\u00e4)', () => {
    const txt = '//OK[1,2,3,["' + T + '","MW3000009","M\\u00fcller \\x26 Co\\n0171 5555555\\nE-Mail: m@x.de"],0,7]';
    assert.equal(parse(txt).get('MW3000009').name, 'Müller & Co');
  });
  it('Auftragsnummern-Formate: MW…, SA…, 8–10 Ziffern, mit Anhang; Vertragsnummer (12 Ziffern) ist keine', () => {
    const m = parse(resp([1, 2, 3, 4, 5, 6, 7], [T, 'MW3211395', 'SA040647', '1002669965', '9601182381-10', '100001038741', 'K\n0171 1111111\nE-Mail: k@x.de']));
    for (const n of ['MW3211395', 'SA040647', '1002669965', '9601182381-10']) assert.ok(m.has(n), n);
    assert.ok(!m.has('100001038741'));
  });
  it('keine gültige Antwort → Fehler; Antwort ohne Tabelle → leer', () => {
    assert.throws(() => parse('//EX[1,["x"],0,7]'));
    assert.equal(parse('//OK[1,2,3]').size, 0);
  });
});

const fx = path.join(__dirname, 'fixtures', 'mitschnitt-angenommen-liste.json');
describe('Listenantwort lesen (echter Mitschnitt „Angenommene Aufträge“)', { skip: !fs.existsSync(fx) && 'Mitschnitt fehlt (test/fixtures/)' }, () => {
  const res = fs.existsSync(fx) ? JSON.parse(fs.readFileSync(fx, 'utf8')).map((x) => x.res).sort((p, q) => q.length - p.length)[0] : '';
  const m = fs.existsSync(fx) ? parse(res) : new Map();
  it('liest die meisten Aufträge mit Kontakt und Telefon', () => {
    assert.ok(m.size > 300, `nur ${m.size}`);
    const mit = [...m.values()].filter((v) => v.telefon);
    assert.ok(mit.length > m.size * 0.9, `${mit.length} von ${m.size} mit Telefon`);
    assert.ok([...m.values()].every((v) => !v.telefon || /^\+?\d[\d\s/\-().]{5,}\d$/.test(v.telefon)));
  });
  it('fast alle Auftragsnummern gehören eindeutig zu einem Datensatz', () => {
    const e = [...m.values()].filter((v) => v.eindeutig).length;
    assert.ok(e > m.size * 0.97, `${e} von ${m.size} eindeutig`);
  });
});

// Seitengröße der mitgeschnittenen TAM-Anfrage erhöhen (TAM zeigt 500 je Seite; es gibt über 700 Aufträge)
describe('Limit der Listenanfrage', () => {
  const lim = new Function(`${src.slice(a, b)}; return mitLimit;`)();
  const req = (n) => `7|0|8|https://x/|ABC|svc|loadTeilauftraege|offset|limit|java.lang.Integer/1|java.util.Date/2|1|2|3|4|2|5|7|0|6|7|${n}|8|`;
  it('ersetzt die Zahl hinter „limit“, nichts sonst', () => {
    assert.equal(lim(req(500), 1500), req(1500));
  });
  it('ohne „limit“ oder bei unerwartetem Aufbau: unverändert', () => {
    assert.equal(lim('7|0|2|a|b|1|2|', 1500), '7|0|2|a|b|1|2|');
    assert.equal(lim('Quatsch', 1500), 'Quatsch');
  });
  const fx2 = path.join(__dirname, 'fixtures', 'mitschnitt-angenommen-liste.json');
  it('echte Anfrage von TAM: 500 → 1500', { skip: !fs.existsSync(fx2) && 'Mitschnitt fehlt' }, () => {
    const r = JSON.parse(fs.readFileSync(fx2, 'utf8')).find((x) => /loadTeilauftraege/.test(x.req) && x.res.length > 1000).req;
    const n = lim(r, 1500);
    assert.notEqual(n, r);
    assert.equal(n.split('|').length, r.split('|').length);
    assert.deepEqual(r.split('|').filter((x, i) => x !== n.split('|')[i]), ['500']);
  });
});
