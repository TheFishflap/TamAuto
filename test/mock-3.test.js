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

// MA-Management: Reiter mit Mitarbeiter-Auswahl, Aufträgen nach Marktgebiet, „nicht zugeordnet“ und Mail-Entwurf
describe('MA-Management (Reiter)', { skip }, () => {
  const today = new Date().toISOString();
  const inH = (h) => { const d = new Date(Date.now() + h * 3600000), p = (n) => String(n).padStart(2, '0'); return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`; };
  const MAS = [{ k: 'MK', name: 'Markus Kirschbaum', mail: 'mk@example.com', gebiet: ['44', '45'] }, { k: 'PM', name: 'Petra M.', mail: 'pm@example.com', gebiet: ['45'] }];
  const KON = [{ name: 'Backoffice (Postfach)', mail: 'auftrag@example.com', cc: 'an', rolle: 'Postfach' }, { name: 'Silke', mail: 'silke@example.com', cc: 'an', rolle: 'Backoffice-Kraft' },
    { name: 'Louis', mail: 'louis@example.com', cc: 'aus', rolle: 'Backoffice-Kraft' }, { name: 'Leonie Struve', mail: '', cc: 'aus', rolle: 'Backoffice-Kraft' }];
  const BOOK = () => [
    { ts: today, nr: 'MW3190401', plz: '44141', ort: 'Dortmund', dienst: 'Standard', strasse: 'Hauptstr. 5', sla: inH(1), zeichen: '' },
    { ts: today, nr: 'MW3190402', plz: '45127', ort: 'Essen', dienst: 'Sixt Rückgabe', zeichen: 'MK 12.10 10:00 T' },
    { ts: today, nr: 'MW3190403', plz: '99999', ort: 'Nirgendwo', dienst: 'Standard', zeichen: '' },
    { ts: today, nr: 'MW3190404', plz: '44141', ort: 'Dortmund', dienst: 'Kennzeichenversand', zeichen: '' },
  ];
  const $ = (id) => tam.document.getElementById(id);
  const open = () => { tam.document.querySelector('.tamauto-tabbtn[data-page="tamauto-page-ma"]').click(); $('tamauto-ma-sel').value = 'MK'; $('tamauto-ma-sel').onchange({ target: $('tamauto-ma-sel') }); };
  const mailto = () => decodeURIComponent($('tamauto-ma-open').getAttribute('href'));
  async function setup() {
    tam = startTam({ gm: { places: { ...KOELN, ma: MAS, kontakte: KON }, orderbook: BOOK() } });
    await tam.ready(); open();
  }

  it('mit Blatt „Marktgebiete“: Zuordnung nach Ort; nicht zugeordnet = „PLZ Ort“', async () => {
    const G = [{ plz: '44', orte: ['dortmund'], nurPlz: '', nurWort: '', sixt: false, ma: ['MK'] }, { plz: '45', orte: ['essen'], nurPlz: '', nurWort: '', sixt: false, ma: ['PM'] }];
    tam = startTam({ gm: { places: { ...KOELN, ma: MAS, kontakte: KON, gebiete: G }, orderbook: BOOK() } });
    await tam.ready(); open();
    assert.match($('tamauto-ma-rows').textContent, /MW3190401/);
    $('tamauto-ma-nurohne').click();
    assert.doesNotMatch($('tamauto-ma-rows').textContent, /MW3190402/, 'Essen gehört PM, nicht MK');
    assert.match($('tamauto-ma-unz').textContent, /99999 Nirgendwo/);
  });

  it('Reiter zeigt die Aufträge des Marktgebiets (ohne Tour), nicht zugeordnete PLZ extra', async () => {
    await setup();
    const rows = $('tamauto-ma-rows').textContent;
    assert.match(rows, /MW3190401/); assert.match(rows, /MW3190404/);
    assert.doesNotMatch(rows, /MW3190402/, 'hat schon eine bestätigte Tour');
    assert.doesNotMatch(rows, /MW3190403/, 'anderes Gebiet');
    assert.match($('tamauto-ma-unz').textContent, /99999/);
    assert.match($('tamauto-ma-rows').textContent, /🔴/); // SLA in 1 h
  });

  it('„nur ohne Tour“ aus → auch Aufträge mit Tour, Tour lesbar angezeigt', async () => {
    await setup();
    $('tamauto-ma-nurohne').click();
    assert.match($('tamauto-ma-rows').textContent, /MK 12\.10\. 10:00 T ✓/);
  });

  it('Mail: Empfänger, Cc nach „an/aus“, Kennzeichenversand nur benannt', async () => {
    await setup();
    const m = mailto();
    assert.match(m, /^mailto:mk@example\.com\?cc=auftrag@example\.com,silke@example\.com&subject=/);
    assert.doesNotMatch(m, /louis@example\.com/);
    assert.match($('tamauto-ma-body').value, /\+ Kennzeichenversand MW3190404/);
    assert.equal(($('tamauto-ma-body').value.match(/MW3190404/g) || []).length, 1);
    assert.match($('tamauto-ma-subject').value, /Neue Aufträge .* \(1\)/);
  });

  it('Cc abwählbar, Absender wählbar und gemerkt (Signatur „Liebe Grüße“)', async () => {
    await setup();
    const box = [...tam.document.querySelectorAll('#tamauto-ma-cc input')].find((i) => i.dataset.mail === 'silke@example.com');
    box.click();
    assert.doesNotMatch(mailto(), /silke@example\.com/);
    $('tamauto-ma-absender').value = 'Leonie Struve'; $('tamauto-ma-absender').onchange({ target: $('tamauto-ma-absender') });
    assert.match($('tamauto-ma-body').value, /Liebe Grüße\nLeonie Struve$/);
    assert.equal(tam.store.get('maSender'), 'Leonie Struve');
  });

  it('Hinweis „keine E-Mail-Adresse“ steht in der Überschriftszeile der Mail und nennt das Kürzel', async () => {
    tam = startTam({ gm: { places: { ...KOELN, ma: [{ k: 'MK', name: 'Markus', mail: '', gebiet: ['44'] }], kontakte: KON }, orderbook: BOOK() } });
    await tam.ready(); open();
    const st = $('tamauto-ma-mailstate');
    assert.match(st.textContent, /Keine E-Mail-Adresse für MK/);
    assert.ok(st.previousElementSibling && /Mail an den Mitarbeiter/.test(st.previousElementSibling.textContent) || /Mail an den Mitarbeiter/.test(st.parentElement.firstElementChild.textContent), 'Hinweis nicht neben der Überschrift');
  });

  it('Baustein wechseln ändert Betreff und Text', async () => {
    await setup();
    $('tamauto-ma-baustein').value = 'mahnung'; $('tamauto-ma-baustein').onchange();
    assert.match($('tamauto-ma-subject').value, /Erinnerung/);
  });

  it('Kontakte laden: Telefon in Liste und Mail; Sixt ohne Nummer → leere Zeile', async () => {
    await setup();
    tam.selectTab('AgentEigeneAuftraege');
    const x = new tam.window.XMLHttpRequest(); x.open('POST', 'https://tam.tuvsud.com/tam/gwt-rpc/auftrag'); x.send('7|0|3|u|a|loadTeilauftraege|1|2|3|');
    tam.selectTab('AgentVeroeffentlichteAuftraege');
    tam.rpc = '//OK[1,2,3,1,4,5,' + JSON.stringify(['x.model.auftraege.Teilauftrag/1', 'MW3190401', 'Frau Muster\n0171 1234567\nE-Mail: m@x.de', 'MW3190402', 'Herr Sixt\nE-Mail: s@x.de']) + ',0,7]';
    $('tamauto-ma-nurohne').click(); // auch MW3190402 (Sixt, mit Tour)
    $('tamauto-ma-load').click();
    assert.ok(await until(() => /Kontakte: 2/.test($('tamauto-ma-loadstate').textContent), 3000), $('tamauto-ma-hint').textContent);
    assert.match($('tamauto-ma-body').value, /Frau Muster, Tel\. 0171 1234567/);
    assert.match($('tamauto-ma-body').value, /^MW3190402[^\n]*\| Tel\.\s*(\|[^\n]*)?$/m);
    assert.match($('tamauto-ma-rows').textContent, /0171 1234567/);
  });

  it('„Nicht zugeordnet“ ist klappbar (zu Beginn offen) und merkt den Zustand', async () => {
    await setup();
    const box = () => $('tamauto-ma-unz').style.display;
    assert.equal(box(), 'flex');
    $('tamauto-ma-unzhead').click();
    assert.equal(box(), 'none'); assert.equal(tam.store.get('maUnzOpen'), false);
    assert.match($('tamauto-ma-unzcount').textContent, /\(1\)/); // Anzahl bleibt sichtbar
    $('tamauto-ma-unzhead').click();
    assert.equal(box(), 'flex');
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

  it('Backoffice-Kräfte sind automatisch Mitarbeiter (Kürzel aus den Initialen oder aus „Kürzel“)', async () => {
    await setup();
    const opts = [...$('tamauto-ma-sel').options].map((o) => o.textContent);
    assert.ok(opts.some((o) => /^LS – Leonie Struve \(Backoffice\)$/.test(o)), opts.join('|'));
    assert.ok(opts.some((o) => /^SI – Silke \(Backoffice\)$/.test(o)) || opts.some((o) => /Silke \(Backoffice\)/.test(o)), opts.join('|'));
  });

  it('„Kontakte laden“ lädt auch die Excel einmal neu', async () => {
    await setup();
    const n = () => tam.requests.filter((o) => o.url.includes('IQDymsXIGo99')).length;
    const before = n();
    $('tamauto-ma-load').click();
    assert.ok(await until(() => n() > before, 3000), 'Excel nicht neu geladen');
  });

  it('„zurück LH“ im Zeichen → Rückgabe: bei den Rückgaben, nicht mehr unter „neue Aufträge“', async () => {
    await setup();
    tam.addAccepted('MW3190401', '', { id: '3705401', zeichen: 'zurück LH' });
    tam.selectTab('AgentEigeneAuftraege');
    assert.ok(await until(() => ((tam.store.get('returnsToday') || { items: {} }).items || {}).MW3190401, 3000), JSON.stringify(tam.store.get('returnsToday')));
    tam.selectTab('AgentVeroeffentlichteAuftraege');
    await sleep(300);
    assert.doesNotMatch($('tamauto-ma-rows').textContent, /MW3190401/);
  });

  it('Zeichen „?“ wird als „ungeklärt“ angezeigt', async () => {
    await setup();
    $('tamauto-ma-nurohne').click(); $('tamauto-ma-nurohne').click();
    tam.addAccepted('MW3190403', '', { id: '3705403', zeichen: '?' });
    tam.addAccepted('MW3190404', '', { id: '3705404', zeichen: '?' });
    tam.selectTab('AgentEigeneAuftraege'); await sleep(500); tam.selectTab('AgentVeroeffentlichteAuftraege'); await sleep(300);
    $('tamauto-ma-sel').value = 'MK'; $('tamauto-ma-sel').onchange({ target: $('tamauto-ma-sel') });
    assert.match($('tamauto-ma-rows').textContent, /ungeklärt/);
  });

  it('Kontakte laden ohne bekannte TAM-Anfrage → Hinweis statt Fehler', async () => {
    await setup();
    $('tamauto-ma-load').click();
    assert.ok(await until(() => /Angenommene Aufträge/.test($('tamauto-ma-hint').textContent), 2000));
  });

  it('ohne Blatt „MA“ → Hinweis', async () => {
    tam = startTam({ gm: { places: { ...KOELN }, orderbook: BOOK() } });
    await tam.ready();
    tam.document.querySelector('.tamauto-tabbtn[data-page="tamauto-page-ma"]').click();
    assert.match($('tamauto-ma-hint').textContent, /Blatt „MA“ fehlt/);
  });
});
