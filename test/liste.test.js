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

// Angenommene Aufträge still laden: Anfrage aus der „Veröffentlichte“-Anfrage ableiten, Zeichen aus der Antwort lesen
describe('Angenommene Aufträge still laden', () => {
  const za = src.indexOf('// <zeichen-parser>'), zb = src.indexOf('// </zeichen-parser>'), la = src.indexOf('// <liste-zeichen>'), lb = src.indexOf('// </liste-zeichen>');
  if (la < 0 || lb < 0) throw new Error('Marker <liste-zeichen> fehlt im Script');
  const L = new Function(`${src.slice(za, zb)}\n${src.slice(a, b)}\n${src.slice(la, lb)}; return { acceptedBodyFromPublished, parseListeZeichen, listenTypOf };`)();
  const fx = path.join(__dirname, 'fixtures', 'mitschnitt-angenommen-liste.json');

  it('Anfrage: nur der Listentyp (0 → 1) ändert sich', () => {
    const p = ['7', '0', '5', 'Modul', 'Sum', 'Svc', 'x.ListenTyp/1', 'y', '1', '2', '3', '4', '0', '2', '4', '0'];
    const r = L.acceptedBodyFromPublished(p.join('|'));
    assert.equal(r.split('|').slice(-1)[0], '1'); assert.equal(r.split('|').length, p.length);
    assert.equal(L.acceptedBodyFromPublished('7|0|1|a|1|'), null); // unbekannter Aufbau → null
  });
  it('Anfrage aus dem echten Mitschnitt: veröffentlicht → angenommen (nur Listentyp wie in TAM), unbekannter Aufbau → null', { skip: !fs.existsSync(fx) && 'Mitschnitt fehlt' }, () => {
    const j = JSON.parse(fs.readFileSync(fx, 'utf8')), r = L.acceptedBodyFromPublished(j[0].req).split('|'), pub = j[0].req.split('|'), acc = j[1].req.split('|');
    assert.equal(r[60], acc[60]); // Listentyp
    const diff = r.map((x, i) => (x !== pub[i] ? i : -1)).filter((i) => i >= 0);
    assert.deepEqual(diff, [13, 40, 60]); // Sortfeld (erstelltAm → slaEndeAgent), Sortierrichtung, Listentyp – wie in TAMs Anfrage der angenommenen Liste
    [13, 40, 60].forEach((i) => assert.equal(r[i], acc[i]));
    assert.equal(r[3 + 20 - 0] === undefined, false);
  });
  it('Listentyp einer Anfrage erkennen: 0 = Veröffentlichte, 1 = Angenommene, sonst null', () => {
    const mk = (n) => `7|0|5|M|S|Svc|loadTeilauftraege|x.ListenTyp/1|1|2|3|4|5|${n}|`;
    assert.equal(L.listenTypOf(mk(0)), 0); assert.equal(L.listenTypOf(mk(1)), 1);
    assert.equal(L.listenTypOf('7|0|3|M|S|loadTeilauftraege|1|2|3|'), null); assert.equal(L.listenTypOf('Quatsch'), null);
  });
  it('Listentyp in den echten Anfragen des Mitschnitts', { skip: !fs.existsSync(fx) && 'Mitschnitt fehlt' }, () => {
    const j = JSON.parse(fs.readFileSync(fx, 'utf8'));
    assert.equal(L.listenTypOf(j[0].req), 0); assert.equal(L.listenTypOf(j[1].req), 1);
  });
  it('Zeichen je Auftrag (synthetisch): bekanntes Kürzel, „zurück“, „?“; Ort, Kontakt und Nummern zählen nicht', () => {
    const T2 = 'x.model.auftraege.Teilauftrag/1';
    const table = [T2, 'MW3000001', 'Dortmund', 'LE t', 'A\n0171 1234567\nE-Mail: a@x.de', 'MW3000002', 'zurück LH', 'MW3000003', '?', 'Essen', 'MW3000004'];
    const txt = `//OK[1,2,3,4,5,1,6,7,1,8,9,10,1,11,3,${JSON.stringify(table)},0,7]`;
    const m = L.parseListeZeichen(txt, ['LE', 'LH']);
    assert.equal(m.get('MW3000001'), 'LE t'); assert.equal(m.get('MW3000002'), 'zurück LH'); assert.equal(m.get('MW3000003'), '?');
    assert.equal(m.has('MW3000004'), false); // nur Ort, kein Zeichen
  });
  it('echte Antwort: Zeichen für den größten Teil der Aufträge, „zurück“ erkannt', { skip: !fs.existsSync(fx) && 'Mitschnitt fehlt' }, () => {
    const j = JSON.parse(fs.readFileSync(fx, 'utf8')), t = j.reduce((x, y) => (String(y.res).length > String(x.res).length ? y : x)).res;
    const m = L.parseListeZeichen(t, ['AT', 'CST', 'DA', 'GS', 'JH', 'JHO', 'LE', 'LH', 'LU', 'MB', 'MK', 'MN', 'PM', 'TV', 'TÖ', 'VV']);
    assert.ok(m.size > 150, `nur ${m.size}`);
    assert.ok([...m.values()].some((z) => /zur(ü|ue)ck/i.test(z)));
  });
});

