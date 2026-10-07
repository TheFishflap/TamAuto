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

describe('Rückgabe-Kanal: gefälschte Meldungen (Sicherheit)', { skip }, () => {
  it('Rückgabe ohne vorher gemeldete Annahme → ignoriert', async () => {
    tam = startTam({ gm: { places: KOELN } });
    await tam.ready();
    tam.ntfy('tamret-', { v: 1, t: 'ret', nrs: ['MW3170010'], at: Date.now() });
    tam.addOrder({ nr: 'MW3170010', plz: '50825', ort: 'Köln' });
    assert.ok(await until(() => tam.accepted.includes('MW3170010'), 15000), tam.logs().join('\n'));
  });

  it('ungültige Nummern und zu lange Listen → ignoriert', async () => {
    tam = startTam({ gm: { places: KOELN } });
    await tam.ready();
    tam.ntfy('tamret-', { v: 1, t: 'acc', nrs: ['<img src=x onerror=alert(1)>', 'x'.repeat(50)], at: Date.now() });
    tam.ntfy('tamret-', { v: 1, t: 'acc', nrs: Array.from({ length: 21 }, (_, i) => `MW31700${10 + i}`), at: Date.now() });
    assert.deepEqual(Object.keys((tam.store.get('accToday') || { items: {} }).items), []);
  });
});

describe('Log', { skip }, () => {
  it('Millisekunden nur als ganze Zahl', async () => {
    tam = startTam({ gm: { places: KOELN, pushOnV3: true } });
    await tam.ready();
    tam.ntfy('tam-zrd6g634b4wej7aqhsycc9qm', { v: 1, src: 'Test', ts: Date.now() - 123.456, test: true });
    assert.ok(await until(() => tam.logs().some((l) => /Push-Signal empfangen/.test(l)), 2000), tam.logs().join('\n'));
    assert.ok(!tam.logs().some((l) => /\d[.,]\d+ ?ms\b/.test(l)), tam.logs().filter((l) => /ms\b/.test(l)).join('\n'));
  });
});

// Eigener ntfy-Kanal für Updates: Meldung → sofort Update prüfen (Version wird bei GitHub/OneDrive bestätigt)
describe('Update-Meldung über ntfy', { skip }, () => {
  it('Meldung einer neuen Version → Update-Prüfung startet sofort', async () => {
    tam = startTam({ gm: { places: KOELN, lastUpdateCheck: Date.now() } });
    await tam.ready();
    const checks = () => tam.requests.filter((o) => /raw\.githubusercontent\.com.*\.user\.js|IQALfRz3/.test(o.url)).length;
    const before = checks();
    tam.ntfy('tamnotify-', { v: 1, t: 'update', ver: '99.0.0' });
    assert.ok(await until(() => checks() > before, 2000), 'keine Update-Prüfung');
  });

  it('Meldung einer älteren/gleichen Version → nichts', async () => {
    tam = startTam({ gm: { places: KOELN, lastUpdateCheck: Date.now() } });
    await tam.ready();
    const before = tam.requests.length;
    tam.ntfy('tamnotify-', { v: 1, t: 'update', ver: '1.0.0' });
    await sleep(500);
    assert.equal(tam.requests.filter((o) => /\.user\.js|IQALfRz3/.test(o.url)).length, tam.requests.slice(0, before).filter((o) => /\.user\.js|IQALfRz3/.test(o.url)).length);
  });
});

// Kanal-Schlüssel: geheime, verschlüsselte ntfy-Kanäle; Geheimnis wird je Gerät verschlüsselt in der Lizenz zugestellt
describe('Kanal-Schlüssel (geheime Kanäle)', { skip }, () => {
  const K = require('./kanal');
  const STATUS = 'tamlic-hnzqxgvxtcc49z6z-status';
  const pkOf = (t) => (t.posts(STATUS).find((m) => m.pk) || {}).pk;
  // Installation starten, öffentlichen Geräteschlüssel und Speicher abgreifen
  async function install() {
    const t = startTam({ gm: { places: KOELN } });
    await t.ready();
    await until(() => pkOf(t), 3000);
    const pk = pkOf(t), gm = Object.fromEntries(t.store);
    t.close();
    return { pk, gm };
  }
  async function withChannelKey(opts = {}) {
    const { pk, gm } = await install();
    const ck = K.newChannelKey();
    const cke = opts.badCke ? { e: 'x', i: 'y', c: 'z' } : await K.sealChannelKey(pk, ck);
    tam = startTam({ gm: { ...gm, licenseKey: licenseKey({ cke }), places: KOELN } });
    await tam.ready();
    return { ck, ret: await K.channelTopic(ck, 'ret') };
  }

  it('Status-Meldung enthält den öffentlichen Geräteschlüssel', async () => {
    const { pk } = await install();
    assert.match(pk || '', /^[A-Za-z0-9_-]{87}$/);
  });

  it('mit Kanal-Schlüssel: Annahme geht verschlüsselt an den geheimen Kanal, nicht an den öffentlichen', async () => {
    const { ck, ret } = await withChannelKey();
    tam.addOrder(ORDER);
    assert.ok(await until(() => tam.posts(ret).length, 8000), 'nichts auf dem geheimen Kanal');
    const body = tam.posts(ret)[0];
    assert.ok(!JSON.stringify(body).includes(ORDER.nr), 'Klartext auf dem Kanal');
    assert.deepEqual((await K.decryptMsg(ck, body)).nrs, [ORDER.nr]);
    assert.equal(tam.posts('tamret-').length, 0);
  });

  it('mit Kanal-Schlüssel: verschlüsselte Rückgabe wird übernommen, gefälschte ignoriert', async () => {
    const { ck, ret } = await withChannelKey();
    await until(() => tam.live(ret).length, 2000);
    tam.ntfy(ret, await K.encryptMsg(ck, { v: 1, t: 'acc', nrs: ['MW3190001'], at: Date.now() }));
    tam.ntfy(ret, await K.encryptMsg(ck, { v: 1, t: 'ret', nrs: ['MW3190001'], at: Date.now() }));
    tam.ntfy(ret, await K.encryptMsg(K.newChannelKey(), { v: 1, t: 'ret', nrs: ['MW3190002'], at: Date.now() })); // falscher Schlüssel
    tam.ntfy(ret, { v: 1, t: 'ret', nrs: ['MW3190003'], at: Date.now() });                                       // unverschlüsselt
    const chips = () => tam.document.getElementById('tamauto-ret').textContent;
    assert.ok(await until(() => /MW3190001/.test(chips()), 2000), chips());
    assert.doesNotMatch(chips(), /MW3190002|MW3190003/);
  });

  it('Tages-Auftragsbuch: Annahme enthält Auftragsdaten (nur geheimer Kanal); später eingeloggtes Gerät baut daraus das Buch, chronologisch', async () => {
    const { ck, ret } = await withChannelKey();
    tam.addOrder(ORDER);
    assert.ok(await until(() => tam.posts(ret).length, 8000));
    const msg = await K.decryptMsg(ck, tam.posts(ret)[0]);
    assert.equal(msg.det[ORDER.nr].p, ORDER.plz); assert.equal(msg.det[ORDER.nr].o, ORDER.ort);
    // zweites Gerät loggt sich später ein: Meldungen kommen in falscher Reihenfolge, eine mit manipulierten Feldern
    const t = Date.now();
    tam.ntfy(ret, await K.encryptMsg(ck, { v: 1, t: 'acc', nrs: ['MW3190901'], by: 'Handy', at: t - 1000, det: { MW3190901: { p: '44141', o: 'Dortmund', s: 'Hauptstr. 1', d: 'Standard', e: 55.5, r: 'R1' } } }));
    tam.ntfy(ret, await K.encryptMsg(ck, { v: 1, t: 'acc', nrs: ['MW3190900'], by: 'Handy', at: t - 5000, det: { MW3190900: { p: '<b>', o: 'x'.repeat(500), s: 5, d: 'Sixt', e: -3 } } }));
    const book = () => tam.store.get('orderbook') || [];
    assert.ok(await until(() => book().some((e) => e.nr === 'MW3190900') && book().some((e) => e.nr === 'MW3190901'), 3000));
    const a = book().find((e) => e.nr === 'MW3190901'), b = book().find((e) => e.nr === 'MW3190900');
    assert.deepEqual([a.plz, a.ort, a.strasse, a.dienst, a.preis, a.by], ['44141', 'Dortmund', 'Hauptstr. 1', 'Standard', 55.5, 'Handy']);
    assert.equal(b.plz, ''); assert.ok(b.ort.length <= 60); assert.equal(b.strasse, ''); assert.equal(b.preis, null); assert.equal(b.dienst, 'Sixt');
    tam.document.querySelector('.tamauto-tabbtn[data-page="tamauto-page-book"]').click();
    const nrs = [...tam.document.querySelectorAll('#tamauto-ob-rows tr')].map((r) => r.dataset.nr);
    assert.ok(nrs.indexOf('MW3190901') < nrs.indexOf('MW3190900'), `neueste oben: ${nrs}`);
  });

  it('Auftragsbuch-Abgleich: neues Gerät meldet sich mit „hi“; andere Geräte antworten mit ihrem Auftragsbuch (nur geheimer Kanal, Auftragsdaten)', async () => {
    const { ck, ret } = await withChannelKey();
    const t = Date.now();
    tam.store.set('orderbook', [{ ts: new Date(t - 2 * 864e5).toISOString(), nr: 'MW3191001', plz: '44141', ort: 'Dortmund', strasse: 'Hauptstr. 1', dienst: 'Sixt Rückgabe', preis: 180, ref: 'WVWZ1' }]);
    const untilA = async (fn, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await sleep(50); } return null; };
    const posted = async () => Promise.all(tam.posts(ret).map((m) => K.decryptMsg(ck, m)));
    assert.ok(await untilA(async () => (await posted()).some((m) => m.t === 'hi'), 9000), 'kein „hi“ nach dem Start');
    tam.ntfy(ret, await K.encryptMsg(ck, { v: 1, t: 'hi', nrs: [], at: Date.now(), src: 'anderes-gerät' }));
    let bk;
    assert.ok(await untilA(async () => { bk = (await posted()).find((m) => m.t === 'bk'); return bk; }, 16000), 'keine Antwort mit dem Auftragsbuch');
    assert.deepEqual(bk.items[0], { n: 'MW3191001', t: t - 2 * 864e5, b: 'Test', p: '44141', o: 'Dortmund', s: 'Hauptstr. 1', d: 'Sixt Rückgabe', e: 180, r: 'WVWZ1' });
    assert.deepEqual(bk.nrs, ['MW3191001']);
  });

  it('Auftragsbuch-Abgleich: empfangene Aufträge werden geprüft und ergänzt; ältere als 7 Tage und Fremdes auf dem öffentlichen Kanal ignoriert', async () => {
    const { ck, ret } = await withChannelKey();
    const t = Date.now(), book = () => tam.store.get('orderbook') || [];
    await until(() => tam.live(ret).length, 2000);
    tam.ntfy(ret, await K.encryptMsg(ck, { v: 1, t: 'bk', nrs: ['MW3191101', 'MW3191102', 'MW3191103'], at: t, items: [
      { n: 'MW3191101', t: t - 3 * 864e5, b: 'Handy', p: '44141', o: 'Dortmund', s: 'Weg 1', d: 'Standard', e: 99.5, r: 'FIN1' },
      { n: 'MW3191102', t: t - 9 * 864e5, b: 'Handy', p: '44141', o: 'Alt' },                      // älter als 7 Tage
      { n: 'MW3191103', t: t - 1000, b: 'x'.repeat(200), p: '<b>', o: 'y'.repeat(300), e: -5 }] }));  // manipulierte Felder
    assert.ok(await until(() => book().some((e) => e.nr === 'MW3191101') && book().some((e) => e.nr === 'MW3191103'), 4000));
    const a = book().find((e) => e.nr === 'MW3191101'), c = book().find((e) => e.nr === 'MW3191103');
    assert.deepEqual([a.plz, a.ort, a.strasse, a.dienst, a.preis, a.ref, a.by], ['44141', 'Dortmund', 'Weg 1', 'Standard', 99.5, 'FIN1', 'Handy']);
    assert.ok(!book().some((e) => e.nr === 'MW3191102'));
    assert.equal(c.plz, ''); assert.ok(c.ort.length <= 60); assert.equal(c.preis, null); assert.ok(c.by.length <= 40);
    tam.ntfy('tamret-', { v: 1, t: 'bk', nrs: ['MW3191199'], at: t, items: [{ n: 'MW3191199', t: t - 1000, p: '44141', o: 'Dortmund' }] }); // öffentlicher Kanal
    await sleep(500);
    assert.ok(!book().some((e) => e.nr === 'MW3191199'));
  });

  it('Rückgabe über den geheimen Kanal: Auftrag im Auftragsbuch rausgestrichen und nicht in der Summe; Knopf „Abgleichen“ sendet „hi“ und das eigene Buch', async () => {
    const { ck, ret } = await withChannelKey();
    const t = Date.now(), book = () => tam.store.get('orderbook') || [];
    tam.store.set('orderbook', [{ ts: new Date(t).toISOString(), nr: 'MW3191201', plz: '44141', ort: 'Dortmund', preis: 100 }, { ts: new Date(t).toISOString(), nr: 'MW3191202', plz: '44141', ort: 'Dortmund', preis: 50 }]);
    await until(() => tam.live(ret).length, 2000);
    tam.ntfy(ret, await K.encryptMsg(ck, { v: 1, t: 'ret', nrs: ['MW3191201'], at: Date.now() }));
    assert.ok(await until(() => (book().find((e) => e.nr === 'MW3191201') || {}).rueck === 1, 3000), JSON.stringify(book()));
    tam.document.querySelector('.tamauto-tabbtn[data-page="tamauto-page-book"]').click();
    const row = (nr) => [...tam.document.querySelectorAll('#tamauto-ob-rows tr')].find((r) => r.textContent.includes(nr));
    assert.equal(row('MW3191201').style.textDecoration, 'line-through'); assert.notEqual(row('MW3191202').style.textDecoration, 'line-through');
    assert.match(tam.document.getElementById('tamauto-ob-sum').textContent, /1 Aufträge .*50[,.]00.*1 zurückgegeben/);
    const untilA = async (fn, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await sleep(50); } return null; };
    const n0 = tam.posts(ret).length;
    tam.document.getElementById('tamauto-ob-sync').click();
    assert.ok(await untilA(async () => { const ms = await Promise.all(tam.posts(ret).slice(n0).map((m) => K.decryptMsg(ck, m))); return ms.some((m) => m.t === 'hi') && ms.some((m) => m.t === 'bk'); }, 6000), 'Abgleich-Knopf sendete nicht');
  });

  it('Details auf dem öffentlichen Kanal werden ignoriert (nur Nummern)', async () => {
    tam = startTam({ gm: { places: KOELN } });
    await tam.ready();
    tam.ntfy('tamret-', { v: 1, t: 'acc', nrs: ['MW3190902'], by: 'Alt', at: Date.now(), det: { MW3190902: { p: '44141', o: 'Dortmund' } } });
    const book = () => tam.store.get('orderbook') || [];
    assert.ok(await until(() => book().some((e) => e.nr === 'MW3190902'), 2000));
    assert.equal(book().find((e) => e.nr === 'MW3190902').ort, '');
  });

  it('Auftragsbuch: 31 Tage Datenspeicherung', async () => {
    const old = new Date(Date.now() - 32 * 864e5).toISOString(), ok = new Date(Date.now() - 30 * 864e5).toISOString();
    tam = startTam({ gm: { places: KOELN, orderbook: [{ ts: old, nr: 'MW3190001', plz: '50825', ort: 'Köln' }, { ts: ok, nr: 'MW3190002', plz: '50825', ort: 'Köln' }] } });
    await tam.ready();
    tam.addOrder(ORDER);
    assert.ok(await until(() => (tam.store.get('orderbook') || []).some((e) => e.nr === ORDER.nr), 15000));
    const nrs = tam.store.get('orderbook').map((e) => e.nr);
    assert.ok(nrs.includes('MW3190002') && !nrs.includes('MW3190001'), nrs.join());
  });

  it('kaputter Kanal-Schlüssel in der Lizenz → läuft weiter wie bisher (öffentlicher Kanal)', async () => {
    await withChannelKey({ badCke: true });
    assert.ok(tam.mainPanel());
    tam.addOrder(ORDER);
    assert.ok(await until(() => tam.posts('tamret-').length, 8000));
  });

  it('Lizenz mit Kanal-Schlüssel per Fernfreischaltung → sofort geheimer Kanal (ohne Neuladen)', async () => {
    const { pk, gm } = await install();
    tam = startTam({ gm: { ...gm, places: KOELN } }); // läuft noch mit Lizenz ohne Kanal-Schlüssel
    await tam.ready();
    const ck = K.newChannelKey(), ret = await K.channelTopic(ck, 'ret');
    const key = licenseKey({ exp: '2099-12-31', cke: await K.sealChannelKey(pk, ck) });
    tam.ntfyRaw('tamlic-hnzqxgvxtcc49z6z-key-', key);
    assert.ok(await until(() => tam.store.get('licenseKey') === key, 2000), 'Schlüssel nicht übernommen');
    await until(() => tam.live(ret).length, 2000);
    tam.addOrder(ORDER);
    assert.ok(await until(() => tam.posts(ret).length, 8000), 'nicht auf dem geheimen Kanal');
    assert.equal(tam.posts('tamret-').length, 0);
  });

  it('alte Lizenz (wie von der PowerShell-GUI, ohne Kanal-Schlüssel) → läuft, Rückgaben öffentlich wie bisher', async () => {
    tam = startTam({ gm: { places: KOELN, licenseKey: licenseKey({ name: 'Alt', exp: '2026-12-31', iat: '2026-09-24', dur: 'Jahr' }) } });
    await tam.ready();
    assert.ok(tam.mainPanel());
    tam.addOrder(ORDER);
    assert.ok(await until(() => tam.accepted.includes(ORDER.nr), 15000), tam.logs().join('\n'));
    assert.ok(await until(() => tam.posts('tamret-').length, 8000));
    assert.equal(tam.posts('tamk-').length, 0);
  });

  it('neues Gerät (Backup) → neuer Geräteschlüssel', async () => {
    const a = await install();
    const t = startTam({ gm: a.gm, device: { platform: 'Linux armv8l', hardwareConcurrency: 2, maxTouchPoints: 10, width: 700, height: 1100, dpr: 3 } });
    tam = t;
    await t.ready();
    assert.ok(t.licensePanel());
    await sleep(300);
    const pk2 = (t.posts('tamlic-hnzqxgvxtcc49z6z-').find((m) => m.pk) || {}).pk || (t.store.get('devKey') || {}).pub;
    assert.ok(pk2 && pk2 !== a.pk, 'Geräteschlüssel nicht erneuert');
  });
});

// MA-Management (ausgedünnt): Mitarbeiter-Auswahl, offene Terminvereinbarungen (ab 150 €, Kürzel im Zeichen, ohne Tour), eine Mail
describe('MA-Management (Reiter)', { skip }, () => {
  const today = new Date().toISOString();
  const inH = (h) => { const d = new Date(Date.now() + h * 3600000), p = (n) => String(n).padStart(2, '0'); return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`; };
  const MAS = [{ k: 'MK', name: 'Markus Kirschbaum', mail: 'mk@example.com', backoffice: false }, { k: 'PM', name: 'Petra M.', mail: 'pm@example.com', backoffice: false },
    { k: 'BO', name: 'Backoffice Postfach', mail: 'auftrag@example.com', backoffice: true }, { k: 'SI', name: 'Silke', mail: 'silke@example.com', backoffice: true },
    { k: 'LS', name: 'Leonie Struve', mail: '', backoffice: true }, { k: 'LU', name: 'Louis Thomee', mail: 'louis@example.com', backoffice: true }];
  const BOOK = () => [
    { ts: today, nr: 'MW3190401', plz: '44141', ort: 'Dortmund', dienst: 'Sixt Rückgabe', ref: 'WVWZZZ000B', strasse: 'Hauptstr. 5', sla: inH(1), resEnde: inH(1), preis: 200, zeichen: 'MK' },
    { ts: today, nr: 'MW3190402', plz: '45127', ort: 'Essen', dienst: 'Standard', ref: 'WVWZZZ000A', preis: 180, zeichen: 'MK 12.10 10:00 T' }, // hat schon eine Tour
    { ts: today, nr: 'MW3190403', plz: '99999', ort: 'Nirgendwo', dienst: 'Standard', preis: 200, zeichen: '' },                          // noch kein Kürzel
    { ts: today, nr: 'MW3190404', plz: '44141', ort: 'Dortmund', dienst: 'Kennzeichenversand', ref: 'WVWZZZ000B', preis: 20, zeichen: '' }, // gehört zu 401 (gleiche FIN)
    { ts: today, nr: 'MW3190405', plz: '50667', ort: 'Köln', dienst: 'Standard', ref: 'WVWZZZ000A', preis: 150, zeichen: 'MK neu' },          // ab 150 €, Kürzel MK
    { ts: today, nr: 'MW3190406', plz: '50667', ort: 'Köln', dienst: 'Standard', preis: 69, zeichen: 'MK' },                                     // unter 150 €
    { ts: today, nr: 'MW3190407', plz: '50667', ort: 'Köln', dienst: 'Standard', preis: 300, zeichen: 'PM' },                                    // anderer MA
  ];
  const $ = (id) => tam.document.getElementById(id);
  const open = () => { tam.document.querySelector('.tamauto-tabbtn[data-page="tamauto-page-ma"]').click(); $('tamauto-ma-sel').value = 'MK'; $('tamauto-ma-sel').onchange({ target: $('tamauto-ma-sel') }); };
  const mailto = () => decodeURIComponent($('tamauto-ma-open').getAttribute('href'));
  async function setup(gm = {}) {
    tam = startTam({ gm: { places: { ...KOELN, ma: MAS }, orderbook: BOOK(), ...gm } });
    await tam.ready(); open();
  }

  it('Liste: nur Terminpflicht (ab 150 €), Kürzel des MA im Zeichen, noch ohne Tour; nach FIN sortiert; Kennzeichenversand unter dem Hauptauftrag', async () => {
    await setup();
    const rows = $('tamauto-ma-rows').textContent;
    assert.match(rows, /MW3190401/); assert.match(rows, /MW3190405/); assert.match(rows, /MW3190404/);
    assert.doesNotMatch(rows, /MW3190402/, 'hat schon eine Tour'); assert.doesNotMatch(rows, /MW3190403/, 'kein Kürzel');
    assert.doesNotMatch(rows, /MW3190406/, 'unter 150 €'); assert.doesNotMatch(rows, /MW3190407/, 'anderer MA');
    assert.ok(rows.indexOf('MW3190405') < rows.indexOf('MW3190401'), 'FIN WVWZZZ000A vor WVWZZZ000B');
    assert.match($('tamauto-ma-rows').textContent, /🔴/); // Reservierung in 1 h
    assert.ok([...tam.document.querySelectorAll('#tamauto-ma-rows b')].some((b) => b.textContent === '1'), 'rote 1 fehlt in der Liste'); // Terminfenster weggeklickt + Reservierung in 1 h
    assert.match($('tamauto-ma-hint').textContent, /1 Aufträge mit Terminpflicht haben noch kein Kürzel/);
  });

  it('Mail: Titel „Neue Terminvereinbarung <Auftragsart> in <Ort> (x)“, Empfänger, Cc = Backoffice mit E-Mail, FIN-Spalte, Kennzeichenversand nur benannt', async () => {
    await setup();
    const m = mailto();
    assert.match(m, /^mailto:mk@example\.com\?cc=auftrag@example\.com,silke@example\.com&subject=/);
    assert.equal($('tamauto-ma-subject').value, 'Neue Terminvereinbarung Standard, Sixt Rückgabe in Köln, Dortmund (2)');
    const b = $('tamauto-ma-body').value;
    assert.match(b, /^Auftrag\s+\| FIN\s+\| PLZ \/ Ort\s+\| Auftragsart\s+\| Reservierung bis\s+\| Kontakt$/m);
    assert.match(b, /\+ Kennzeichenversand MW3190404/); assert.equal((b.match(/MW3190404/g) || []).length, 1);
    assert.match(b, /Die Reservierung läuft zu den angegebenen Zeiten aus/);
    assert.match(b, /🔴 1 \d{2}\.\d{2}\.\d{4} \d{2}:\d{2} \(in 1 h\)/); assert.match(b, /🔴 = Reservierung läuft in ≤ 2 h aus.*1 = Terminfenster/);
  });

  it('Cc abwählbar, Absender = Backoffice-Zeilen, gemerkt (Signatur „Liebe Grüße“)', async () => {
    await setup();
    assert.deepEqual([...$('tamauto-ma-absender').options].map((o) => o.value), ['', 'Backoffice Postfach', 'Silke', 'Leonie Struve', 'Louis Thomee']);
    [...tam.document.querySelectorAll('#tamauto-ma-cc input')].find((i) => i.dataset.mail === 'silke@example.com').click();
    assert.doesNotMatch(mailto(), /silke@example\.com/);
    $('tamauto-ma-absender').value = 'Leonie Struve'; $('tamauto-ma-absender').onchange({ target: $('tamauto-ma-absender') });
    assert.match($('tamauto-ma-body').value, /Liebe Grüße\nLeonie Struve$/);
    assert.equal(tam.store.get('maSender'), 'Leonie Struve');
  });

  it('Louis Thomee ist in Cc gar nicht auswählbar (bleibt aber Absender)', async () => {
    await setup();
    assert.doesNotMatch(mailto(), /louis@example\.com/);
    assert.ok(![...tam.document.querySelectorAll('#tamauto-ma-cc input')].some((i) => i.dataset.mail === 'louis@example.com'));
    assert.ok([...$('tamauto-ma-absender').options].some((o) => o.value === 'Louis Thomee'));
  });
  it('Zahl in Klammern beim MA = offene Terminvereinbarungen (Summe = Reiter)', async () => {
    await setup();
    const lab = (k) => [...$('tamauto-ma-sel').options].find((o) => o.value === k).textContent;
    assert.match(lab('MK'), /\(3\)$/); assert.match(lab('PM'), /\(1\)$/); assert.doesNotMatch(lab('SI'), /\(\d+\)$/);
    assert.match(tam.document.querySelector('.tamauto-tabbtn[data-page="tamauto-page-ma"]').textContent, /\(4\)/);
  });

  it('keine Marktgebiete, kein „nicht zugeordnet“, keine Baustein-Auswahl', async () => {
    await setup();
    assert.equal($('tamauto-ma-unz'), null); assert.equal($('tamauto-ma-baustein'), null);
  });

  it('Hinweis „keine E-Mail-Adresse“ steht in der Überschriftszeile der Mail und nennt das Kürzel', async () => {
    tam = startTam({ gm: { places: { ...KOELN, ma: [{ k: 'MK', name: 'Markus', mail: '', backoffice: false }] }, orderbook: BOOK() } });
    await tam.ready(); open();
    const st = $('tamauto-ma-mailstate');
    assert.match(st.textContent, /Keine E-Mail-Adresse für MK/);
    assert.ok(st.previousElementSibling && /Mail an den Mitarbeiter/.test(st.previousElementSibling.textContent) || /Mail an den Mitarbeiter/.test(st.parentElement.firstElementChild.textContent), 'Hinweis nicht neben der Überschrift');
  });

  it('Kontakte laden: Telefon in Liste und Mail; Sixt ohne Nummer → leere Zeile', async () => {
    await setup();
    tam.selectTab('AgentEigeneAuftraege');
    const x = new tam.window.XMLHttpRequest(); x.open('POST', 'https://tam.tuvsud.com/tam/gwt-rpc/auftrag'); x.send('7|0|3|u|a|loadTeilauftraege|1|2|3|');
    tam.selectTab('AgentVeroeffentlichteAuftraege');
    tam.rpc = '//OK[1,2,3,1,4,5,' + JSON.stringify(['x.model.auftraege.Teilauftrag/1', 'MW3190405', 'Frau Muster\n0171 1234567\nE-Mail: m@x.de', 'MW3190401', 'Herr Sixt\nE-Mail: s@x.de']) + ',0,7]';
    $('tamauto-ma-load').click();
    assert.ok(await until(() => /Kontakte: 2/.test($('tamauto-ma-loadstate').textContent), 3000), $('tamauto-ma-hint').textContent);
    assert.match($('tamauto-ma-body').value, /Frau Muster, Tel\. 0171 1234567/);
    assert.match($('tamauto-ma-body').value, /^MW3190401[^\n]*\| Tel\.\s*$/m);
    assert.match($('tamauto-ma-rows').textContent, /0171 1234567/);
  });

  it('„Mail öffnen“ öffnet als Popup, TAM bleibt im selben Tab', async () => {
    await setup();
    const calls = []; tam.window.open = (...x) => { calls.push(x); return null; };
    const ev = new tam.window.MouseEvent('click', { bubbles: true, cancelable: true });
    $('tamauto-ma-open').dispatchEvent(ev);
    assert.equal(ev.defaultPrevented, true, 'Link würde den Tab verlassen');
    assert.equal(calls.length, 1);
    assert.match(calls[0][0], /^mailto:mk@example\.com\?/); assert.equal(calls[0][1], '_blank'); assert.match(calls[0][2], /popup=yes/);
  });

  it('Mail: Tabelle mit SLA-Flagge; im Mailtext steht an ihrer Stelle ein Platzhalter (Tabelle liegt in der Zwischenablage); Erklärung am Knopf', async () => {
    await setup();
    const a = $('tamauto-ma-open');
    assert.ok(a.dataset.tabelle.startsWith('<table'), 'HTML-Tabelle fehlt');
    const href = decodeURIComponent(a.getAttribute('href'));
    assert.match(href, /Tabelle hier einfügen/); assert.doesNotMatch(href, /PLZ \/ Ort/);
    const help = $('tamauto-ma-copyhtml').nextElementSibling;
    assert.ok(help.classList.contains('tamauto-help')); assert.match(help.title, /zuerst „Mail öffnen“/);
  });

  it('„Kontakte laden“ lädt auch die Excel einmal neu', async () => {
    await setup();
    const n = () => tam.requests.filter((o) => o.url.includes('IQDymsXIGo99')).length;
    const before = n();
    $('tamauto-ma-load').click();
    assert.ok(await until(() => n() > before, 3000), 'Excel nicht neu geladen');
  });

  it('„zurück LH“ im Zeichen → Rückgabe: bei den Rückgaben, nicht mehr in der Liste', async () => {
    await setup();
    tam.addAccepted('MW3190401', '', { id: '3705401', zeichen: 'MK zurück', preis: '200,00 €' });
    tam.selectTab('AgentEigeneAuftraege');
    assert.ok(await until(() => ((tam.store.get('returnsToday') || { items: {} }).items || {}).MW3190401, 3000), JSON.stringify(tam.store.get('returnsToday')));
    tam.selectTab('AgentVeroeffentlichteAuftraege');
    await sleep(300);
    assert.doesNotMatch($('tamauto-ma-rows').textContent, /MW3190401/);
  });
});
