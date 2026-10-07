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

// Rückgaben geräteübergreifend: Annahmen per ntfy teilen, Wiederauftauchen = zurückgegeben → Tages-Blacklist
describe('Rückgaben (Tages-Blacklist über ntfy)', { skip }, () => {
  const RET = 'tamret-';
  const OTHER = { nr: 'MW3999999', plz: '99999', ort: 'Nirgendwo' }; // passt nicht, löst nur einen Abgleich aus
  const retChips = () => tam.document.getElementById('tamauto-ret').textContent;

  it('eigene Annahme wird an alle Geräte gemeldet', async () => {
    tam = startTam({ gm: { places: KOELN } });
    await tam.ready();
    tam.addOrder(ORDER);
    assert.ok(await until(() => tam.posts(RET).some((m) => m.t === 'acc' && m.nrs.includes(ORDER.nr)), 8000), JSON.stringify(tam.posts(RET)));
  });

  it('eigene Annahme, Zeile steht noch in der Tabelle → keine Rückgabe', async () => {
    tam = startTam({ gm: { places: KOELN, retMinGoneSec: 1 } });
    await tam.ready();
    tam.addOrder(ORDER);
    await until(() => tam.posts(RET).length, 8000);
    tam.addOrder(OTHER); // neuer Abgleich, Zeile von ORDER ist noch da
    await sleep(2000);
    assert.ok(!tam.logs().some((l) => /zurückgegeben/.test(l)), tam.logs().join('\n'));
  });

  it('von anderem Gerät angenommen, verschwunden, wieder da → zurückgegeben, nicht angenommen, gemeldet', async () => {
    const NR = 'MW3170001';
    tam = startTam({ gm: { places: KOELN, retMinGoneSec: 1 } });
    await tam.ready();
    tam.ntfy(RET, { v: 1, t: 'acc', nrs: [NR], by: 'Handy_T1', at: Date.now() });
    tam.addOrder(OTHER); // Abgleich: NR ist nicht in der Tabelle
    await sleep(1500);
    tam.addOrder({ nr: NR, plz: '50825', ort: 'Köln' });
    assert.ok(await until(() => tam.logs().some((l) => l.includes(NR) && /zurückgegeben/i.test(l)), 5000), tam.logs().join('\n'));
    await sleep(1000);
    assert.deepEqual(tam.dblclicks, []);
    assert.ok(tam.posts(RET).some((m) => m.t === 'ret' && m.nrs.includes(NR)));
    assert.match(retChips(), new RegExp(NR));
  });

  it('Rückgabe-Meldung eines anderen Geräts → gesperrt und angezeigt', async () => {
    const NR = 'MW3170002';
    tam = startTam({ gm: { places: KOELN } });
    await tam.ready();
    tam.ntfy(RET, { v: 1, t: 'acc', nrs: [NR], at: Date.now() });
    tam.ntfy(RET, { v: 1, t: 'ret', nrs: [NR], at: Date.now() });
    assert.match(retChips(), new RegExp(NR));
    tam.addOrder({ nr: NR, plz: '50825', ort: 'Köln' });
    await sleep(1500);
    assert.deepEqual(tam.dblclicks, []);
  });
});

// Update nur über GitHub (OneDrive ist kein Update-Kanal mehr)
describe('Update über GitHub', { skip }, () => {
  const { revocationList } = require('./harness');
  const xhr = (gh) => (o) => {
    if (o.url.includes('IQBmSNFRkXF5')) return { status: 200, responseText: revocationList() };
    if (o.url.includes('raw.githubusercontent.com') && /\.user\.js/.test(o.url)) return gh ? { status: 200, responseText: `// @version ${gh}` } : { status: 404, responseText: '' };
    return { error: true };
  };
  const link = () => tam.document.getElementById('tamauto-update');
  const updLog = () => until(() => tam.logs().find((l) => /Update .* verfügbar/.test(l)), 3000);

  it('GitHub hat ein Update → GitHub-Link', async () => {
    tam = startTam({ gm: { places: KOELN }, xhr: xhr('9.9.9') });
    await tam.ready();
    assert.match(await updLog() || '', /Update 9\.9\.9 verfügbar/);
    assert.match(link().href, /^https:\/\/raw\.githubusercontent\.com\/.*\.user\.js$/);
  });

  it('GitHub nicht erreichbar → kein Update, keine OneDrive-Abfrage', async () => {
    tam = startTam({ gm: { places: KOELN }, xhr: xhr(null) });
    await tam.ready();
    await sleep(1200);
    assert.ok(!tam.logs().some((l) => /Update .* verfügbar/.test(l)));
    assert.ok(!(tam.xhrs || []).some((x) => /IQALfRz3/.test(x.url || '')));
  });

  it('Tampermonkey prüft Updates über GitHub (Kopf @updateURL/@downloadURL)', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'tam-auto-annahme.user.js'), 'utf8');
    assert.match(src, /@updateURL\s+https:\/\/raw\.githubusercontent\.com\/TheFishflap\/TamAuto\/main\/tam-auto-annahme\.user\.js/);
    assert.match(src, /@downloadURL\s+https:\/\/raw\.githubusercontent\.com\/TheFishflap\/TamAuto\/main\/tam-auto-annahme\.user\.js/);
  });
});

// Annahmen anderer Geräte im Auftragsbuch (Spalte „Von“ = Lizenzname), nicht selbst annehmen
describe('Geräteübergreifendes Auftragsbuch', { skip }, () => {
  const RET = 'tamret-';
  const book = () => tam.store.get('orderbook') || [];
  const bookRow = (nr) => [...tam.document.querySelectorAll('#tamauto-ob-rows tr')].find((r) => r.textContent.includes(nr));

  it('Annahme von „Handy_T1“ → im Auftragsbuch mit Name, Auftrag wird hier nicht angenommen', async () => {
    tam = startTam({ gm: { places: KOELN } });
    await tam.ready();
    tam.ntfy(RET, { v: 1, t: 'acc', nrs: ['MW3190301'], by: 'Handy_T1', at: Date.now() });
    assert.ok(await until(() => book().some((e) => e.nr === 'MW3190301' && e.by === 'Handy_T1'), 2000), JSON.stringify(book()));
    assert.ok(await until(() => bookRow('MW3190301') && bookRow('MW3190301').textContent.includes('Handy_T1'), 2000));
    tam.addOrder({ nr: 'MW3190301', plz: '50825', ort: 'Köln' });
    await sleep(1500);
    assert.deepEqual(tam.dblclicks, []);
  });

  it('eigene Annahme: Meldung mit Lizenzname, Echo erzeugt keinen doppelten Eintrag', async () => {
    tam = startTam({ gm: { places: KOELN } });
    await tam.ready();
    tam.addOrder(ORDER);
    assert.ok(await until(() => tam.posts(RET).some((m) => m.t === 'acc'), 8000));
    const msg = tam.posts(RET).find((m) => m.t === 'acc');
    assert.equal(msg.by, 'Test');
    tam.ntfy(RET, msg); // eigene Meldung kommt zurück
    await sleep(300);
    assert.equal(book().filter((e) => e.nr === ORDER.nr).length, 1);
  });

  it('PLZ, Ort und Preis aus „Angenommene Aufträge“ ergänzt', async () => {
    tam = startTam({ gm: { places: KOELN } });
    await tam.ready();
    tam.ntfy(RET, { v: 1, t: 'acc', nrs: ['MW3190302'], by: 'Handy_T1', at: Date.now() });
    await until(() => book().some((e) => e.nr === 'MW3190302'), 2000);
    tam.addAccepted('MW3190302', '', { id: '3705302', zeichen: '', preis: '62,05 €', plz: '35579', ort: 'Wetzlar' });
    tam.selectTab('AgentEigeneAuftraege');
    assert.ok(await until(() => { const e = book().find((x) => x.nr === 'MW3190302'); return e && e.plz === '35579' && e.ort === 'Wetzlar' && e.preis === 62.05; }, 3000), JSON.stringify(book()));
  });
});

describe('Lizenz anfragen auf der Anmeldeseite', { skip }, () => {
  it('TAM zeigt die Anmeldeseite → Anfrage ohne Kontonamen (kein „FREMDES KONTO“)', async () => {
    tam = startTam({ gm: { licenseKey: licenseKey({ id: 'ZZZZ-ZZZZ-ZZZZ-ZZZZ' }) } }); // keine gültige Lizenz → Lizenzfeld
    await tam.ready();
    const d = tam.document;
    [...d.querySelectorAll('body *')].filter((e) => [...e.childNodes].some((n) => n.nodeType === 3 && /thom/i.test(n.nodeValue))).forEach((e) => e.remove());
    const h = d.createElement('div'); h.textContent = 'TAM - TÜV SÜD Auftragsmanagement | Anmeldung mit Single-Sign-On'; d.getElementById('mainview').prepend(h);
    d.getElementById('tamauto-lic-name').value = 'Test Nutzer';
    d.getElementById('tamauto-lic-req').click();
    assert.ok(await until(() => tam.posts('-anfrage').length, 3000), 'keine Anfrage gesendet');
    assert.equal(tam.posts('-anfrage')[0].acct, '');
  });
});
