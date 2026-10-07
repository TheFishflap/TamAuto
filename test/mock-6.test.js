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

describe('Start und Lizenz', { skip }, () => {
  it('startet mit gültiger Lizenz auf dem leeren Reiter „Veröffentlichte Aufträge“', async () => {
    tam = startTam({ html: fixture('veroeffentlicht-leer'), gm: { places: KOELN } });
    await tam.ready();
    assert.ok(tam.mainPanel(), 'Bedienfeld fehlt');
    await until(() => tam.logs().some((l) => /Abgleich/.test(l)), 5000);
    assert.ok(!tam.logs().some((l) => /PLZ\/Ort-Spalte nicht gefunden/.test(l)), tam.logs().join('\n'));
  });

  it('Schlüssel einer anderen Installation → nur Lizenzfeld', async () => {
    tam = startTam({ gm: { licenseKey: licenseKey({ id: 'ZZZZ-ZZZZ-ZZZZ-ZZZZ' }) } });
    await tam.ready();
    assert.ok(tam.licensePanel());
  });
});

describe('Wächter (P2)', { skip }, () => {
  it('schließt im Reiter „Angenommene Aufträge“ keine selbst geöffnete Detailansicht', async () => {
    tam = startTam({ gm: { places: KOELN } });
    await tam.ready();
    tam.addOrder(ORDER);
    // Annahme vollständig abgeschlossen (inkl. Warten auf TAMs Reaktion und Aufräumen)
    assert.ok(await until(() => tam.logs().some((l) => /Angenommen: MW3153893/.test(l)), 15000), tam.logs().join('\n'));
    await sleep(3000); // Nachkontrolle nach „Bestätigen“ (2,5 s) vorbei – jsdom kann keinen echten Nutzerklick erzeugen
    tam.selectTab('AgentEigeneAuftraege');
    tam.showWindow(0); // Nutzer öffnet „Auftrag MW3153893“ per Doppelklick
    await sleep(1000);
    assert.deepEqual(tam.closed.filter((t) => /^Auftrag MW/.test(t)), [], tam.logs().slice(-5).join('\n'));
  });

  it('schließt im Reiter „Veröffentlichte Aufträge“ eine verspätete Karte weiterhin', async () => {
    tam = startTam({ gm: { places: KOELN } });
    await tam.ready();
    tam.addOrder(ORDER);
    assert.ok(await until(() => tam.accepted.length, 15000), tam.logs().join('\n'));
    await sleep(1500);
    tam.showWindow(0); // „Auftrag MW3153893“ taucht verspätet auf
    assert.ok(await until(() => tam.closed.some((t) => /^Auftrag MW/.test(t)), 2000), tam.logs().slice(-5).join('\n'));
  });
});

// Nach „Bestätigen“ nicht warten: sofort weiter, TAM-Reaktion im Hintergrund auswerten
describe('Nach der Annahme sofort zurück (P2 Tabwechsel)', { skip }, () => {
  const logAt = (re) => until(() => tam.logs().some((l) => re.test(l)), 15000);

  it('„Angenommen“ direkt nach „Bestätigen“ (kein Warten auf TAM)', async () => {
    tam = startTam({ gm: { places: KOELN } });
    await tam.ready();
    tam.addOrder(ORDER);
    assert.ok(await logAt(/Angenommen: MW3153893/), tam.logs().join('\n'));
    const ms = Date.now() - tam.acceptedAt;
    assert.ok(ms < 600, `erst nach ${ms} ms fertig`);
  });

  it('TAM springt nach der Annahme in „Angenommene Aufträge“ → sofort zurück', async () => {
    tam = startTam({ gm: { places: KOELN } });
    await tam.ready();
    let jumpedAt = 0;
    tam.addOrder({ ...ORDER, afterAccept: (t) => setTimeout(() => { t.selectTab('AgentEigeneAuftraege'); jumpedAt = Date.now(); }, 400) });
    assert.ok(await until(() => jumpedAt, 15000));
    assert.ok(await until(() => tam.onPublished(), 1000), 'nicht zurückgewechselt');
    assert.ok(Date.now() - jumpedAt < 500, `Rückkehr nach ${Date.now() - jumpedAt} ms`);
  });

  it('TAM meldet nach „Bestätigen“ „bereits vergeben“ → Buchung wird korrigiert', async () => {
    tam = startTam({ gm: { places: KOELN } });
    await tam.ready();
    tam.addOrder({ ...ORDER, afterAccept: (t) => setTimeout(() => t.showMessage('Auftrag bereits vergeben!', 'Der Auftrag MW3153893 wurde bereits vergeben.'), 500) });
    assert.ok(await logAt(/nachträglich/), tam.logs().join('\n'));
    const info = tam.store.get('doneInfo')[ORDER.nr];
    assert.match(info.why, /fehlgeschlagen/);
    assert.ok(!(tam.store.get('orderbook') || []).some((e) => e.nr === ORDER.nr), 'steht noch im Auftragsbuch');
    assert.equal(tam.store.get('hitstats')[ORDER.nr].s, 'vergeben');
  });
});

describe('Tempo der Annahme (P2 Popup-Erkennung)', { skip }, () => {
  it('Karte da → „Bestätigen“ ohne feste Pausen (< 500 ms ohne Humanizer)', async () => {
    tam = startTam({ gm: { places: KOELN } });
    await tam.ready();
    let cardAt = 0;
    tam.addOrder({ ...ORDER, nearby: [{ nr: 'MW3000001', km: 0 }], onOpen: (t, o) => setTimeout(() => { cardAt = Date.now(); t.openCard(o); }, 300) });
    assert.ok(await until(() => tam.accepted.length, 15000), tam.logs().join('\n'));
    assert.deepEqual(tam.accepted.sort(), ['MW3000001', 'MW3153893']);
    assert.ok(tam.acceptedAt - cardAt < 500, `${tam.acceptedAt - cardAt} ms`);
  });

  it('Umgebung wird nachgeladen → 0-km-Auftrag trotzdem im Warenkorb', async () => {
    tam = startTam({ gm: { places: KOELN } });
    await tam.ready();
    tam.addOrder({ ...ORDER, onOpen: (t, o) => {
      const card = t.openCard(o);
      setTimeout(() => { // TAM liefert „Aufträge in der Umgebung“ 100 ms später nach
        const z = t.document.createElement('div'); z.className = 'zusatzteilauftrag'; z.dataset.nr = 'MW3000002';
        z.innerHTML = '<div class="entfernung">0 km</div>MW3000002 Dienst';
        z.addEventListener('click', () => { const it = t.document.createElement('div'); it.className = 'x-view-item x-view-item-check';
          it.innerHTML = '<input type="checkbox" class="x-view-item-checkbox">MW3000002'; card.querySelector('[data-wk]').appendChild(it); });
        card.querySelectorAll('.x-view')[1].appendChild(z);
      }, 100);
    } });
    assert.ok(await until(() => tam.accepted.length, 15000), tam.logs().join('\n'));
    assert.deepEqual(tam.accepted.sort(), ['MW3000002', 'MW3153893']);
  });
});

// P3: Live-Verbindungen (ntfy) bleiben auch nach Schlaf/Netzwechsel verbunden
describe('ntfy-Verbindung neu aufbauen (P3)', { skip }, () => {
  const PUSH = 'tam-zrd6g634b4wej7aqhsycc9qm', RET = 'tamret-';
  const gm = (sec) => ({ places: KOELN, pushOnV3: true, ntfyWatchdogSec: sec });

  it('keine Lebenszeichen → Push-Verbindung wird neu aufgebaut', async () => {
    tam = startTam({ gm: gm(1) });
    await tam.ready();
    tam.esEmit(PUSH, 'open');
    assert.equal(tam.opened(PUSH), 1);
    assert.ok(await until(() => tam.opened(PUSH) >= 2, 4000), 'nicht neu verbunden');
    assert.equal(tam.live(PUSH).length, 1, 'alte Verbindung nicht geschlossen');
  });

  it('regelmäßige keepalives → keine neue Verbindung', async () => {
    tam = startTam({ gm: gm(1) });
    await tam.ready();
    tam.esEmit(PUSH, 'open');
    for (let i = 0; i < 8; i++) { await sleep(300); tam.esEmit(PUSH, 'keepalive'); }
    assert.equal(tam.opened(PUSH), 1);
  });

  it('Tab wird nach längerer Stille wieder sichtbar → sofort neu verbinden', async () => {
    tam = startTam({ gm: gm(4) });
    await tam.ready();
    tam.esEmit(PUSH, 'open');
    await sleep(2200);
    tam.document.dispatchEvent(new tam.window.Event('visibilitychange'));
    assert.ok(await until(() => tam.opened(PUSH) >= 2, 300), 'nicht sofort neu verbunden');
  });

  it('Verbindung endgültig geschlossen → neuer Versuch', async () => {
    tam = startTam({ gm: gm(60) });
    await tam.ready();
    tam.esEmit(PUSH, 'open');
    tam.esEmit(PUSH, 'error', true);
    assert.ok(await until(() => tam.opened(PUSH) >= 2, 4000), 'kein neuer Versuch');
  });

  it('Rückgabe-Kanal: neu verbinden und Verpasstes nachholen', async () => {
    tam = startTam({ gm: gm(1) });
    await tam.ready();
    const polls = () => tam.fetches.filter((f) => f.url.includes(RET) && /poll=1/.test(f.url)).length;
    await until(() => polls() >= 1, 2000);
    tam.esEmit(RET, 'open');
    assert.ok(await until(() => tam.opened(RET) >= 2 && polls() >= 2, 4000), `Verbindungen ${tam.opened(RET)}, Abrufe ${polls()}`);
  });
});

// Das Mock bildet die Annahme wie das echte TAM nach (Mitschnitt vom 07.10.2026): Karte lädt Auftrag und Dokumente, „Bestätigen“ sendet einen accept-Aufruf
describe('Mock: Annahme wie im echten TAM', { skip }, () => {
  it('Karte ruft getTeilauftrag + listAuftragsDokumente, „Bestätigen“ genau einen accept-Aufruf mit der ID; Auftrag verschwindet, Annahme verbucht', async () => {
    tam = startTam({ gm: { places: KOELN } });
    await tam.ready();
    tam.addOrder({ ...ORDER, id: '3709951' });
    assert.ok(await until(() => tam.accepted.includes(ORDER.nr), 15000), tam.logs().slice(-4).join('\n'));
    const urls = tam.xhrs.map((x) => `${x.url.split('tam.tuvsud.com')[1]} ${(x.body.match(/\|(getTeilauftrag|listAuftragsDokumente|accept)\|/) || [])[1] || ''}`);
    assert.ok(urls.includes('/gwt-rpc/auftrag getTeilauftrag') && urls.includes('/gwt-rpc/dienstleistung listAuftragsDokumente'), urls.join(' · '));
    const acc = tam.xhrs.filter((x) => /gwt-rpc\/workflow\/agent/.test(x.url) && /\|accept\|/.test(x.body));
    assert.equal(acc.length, 1); assert.equal(acc[0].headers['X-GWT-Permutation'], 'B0147C817E751A9BD6E4C4F5171A12B0');
    assert.deepEqual(tam.acceptCalls[0].ids, ['3709951']);
  });
  it('Warenkorb: ein accept-Aufruf mit den IDs aller angehakten Aufträge', async () => {
    tam = startTam({ gm: { places: KOELN } });
    await tam.ready();
    tam.addOrder({ ...ORDER, id: '3709951', nearby: [{ nr: 'MW3000001', km: 0, id: '3709952' }] });
    assert.ok(await until(() => tam.accepted.includes('MW3000001'), 15000), tam.logs().slice(-4).join('\n'));
    assert.equal(tam.acceptCalls.length, 1); assert.deepEqual(tam.acceptCalls[0].ids, ['3709951', '3709952']);
  });
});

// Stille Annahme (Beta): accept-Aufruf direkt an TAM, Anfrage von der ersten normalen Annahme gelernt, Rückfall auf die Auftragskarte
describe('Stille Annahme (Beta)', { skip }, () => {
  const SIXT2 = { nr: 'MW3153999', plz: '50825', ort: 'Köln', id: '3709952', dienst: 'Sixt Rückgabe' };
  const FIRST = { ...ORDER, id: '3709951' };
  const acceptFetches = () => tam.fetches.filter((f) => /gwt-rpc\/workflow\/agent/.test(f.url) && /\|accept\|/.test(String((f.o && f.o.body) || '')));
  async function learned(gm = {}) {
    tam = startTam({ gm: { places: KOELN, silentAccept: true, silentAcceptSixt: false, ...gm } });
    await tam.ready();
    tam.addOrder(FIRST); // erste Annahme: normal über die Karte – dabei lernt das Script die Anfrage
    assert.ok(await until(() => tam.accepted.includes(FIRST.nr), 15000), tam.logs().slice(-4).join('\n'));
    assert.ok(tam.store.get('acceptTpl'), 'Vorlage nicht gelernt');
    await sleep(1500);
  }

  it('Standard aus: normale Annahme über die Karte, keine stille Anfrage – die Vorlage wird trotzdem gelernt', async () => {
    tam = startTam({ gm: { places: KOELN } });
    await tam.ready();
    tam.addOrder(FIRST);
    assert.ok(await until(() => tam.accepted.includes(FIRST.nr), 15000));
    assert.equal(acceptFetches().length, 0); assert.deepEqual(tam.dblclicks, [FIRST.nr]);
    assert.ok(tam.store.get('acceptTpl') && /\|accept\|/.test(tam.store.get('acceptTpl').body));
  });

  it('an + gelernt: zweiter Auftrag still angenommen – ohne Doppelklick, Aufbau wie TAMs Anfrage, ausführlich im Protokoll, gebucht und gemeldet', async () => {
    await learned();
    tam.addOrder(SIXT2);
    assert.ok(await until(() => tam.accepted.includes(SIXT2.nr), 15000), tam.logs().slice(-6).join('\n'));
    assert.deepEqual(tam.dblclicks, [FIRST.nr], 'zweiter Auftrag lief über die Karte');
    const f = acceptFetches()[0];
    assert.ok(f.o.body.includes(`|8|${tam.gwtEnc('3709952')}|6|1|9|16|10|1|11|0|`), f.o.body); // Liste mit der ID, danach die feste Transition
    assert.equal(f.o.headers['X-GWT-Permutation'], 'B0147C817E751A9BD6E4C4F5171A12B0');
    assert.deepEqual(tam.acceptCalls.slice(-1)[0].nrs, [SIXT2.nr]);
    assert.ok(tam.logs().some((l) => /Stille Annahme MW3153999: sende accept \(ID 3709952 = /.test(l)));
    assert.ok(tam.logs().some((l) => /Stille Annahme MW3153999: TAM antwortet \/\/OK in \d+ ms/.test(l)));
    assert.ok((tam.store.get('orderbook') || []).some((e) => e.nr === SIXT2.nr));
    assert.ok(Object.keys((tam.store.get('accToday') || {}).items || {}).includes(SIXT2.nr));
    assert.ok(tam.posts('tamret-').some((m) => m.t === 'acc' && m.nrs.includes(SIXT2.nr)), 'Annahme nicht gemeldet');
  });

  it('„nur Sixt“: ein normaler Auftrag läuft weiter über die Karte', async () => {
    await learned({ silentAcceptSixt: true });
    tam.addOrder({ ...SIXT2, nr: 'MW3153998', id: '3709953', dienst: 'Standard' });
    assert.ok(await until(() => tam.accepted.includes('MW3153998'), 15000));
    assert.deepEqual(tam.dblclicks, [FIRST.nr, 'MW3153998']); assert.equal(acceptFetches().length, 0);
  });

  it('TAM meldet „bereits vergeben“ → kein Rückfall, Annahme fehlgeschlagen verbucht', async () => {
    await learned();
    tam.acceptFail = 'Auftrag bereits vergeben';
    tam.addOrder(SIXT2);
    assert.ok(await until(() => tam.logs().some((l) => /Annahme fehlgeschlagen: .*MW3153999/.test(l)), 15000), tam.logs().slice(-5).join('\n'));
    assert.deepEqual(tam.dblclicks, [FIRST.nr]);
    assert.ok(!tam.accepted.includes(SIXT2.nr));
  });

  it('unbekannte Antwort → Rückfall: Annahme über die Auftragskarte', async () => {
    await learned();
    tam.acceptFail = 'com.google.gwt.user.client.rpc.SerializationException';
    tam.addOrder(SIXT2);
    assert.ok(await until(() => tam.dblclicks.includes(SIXT2.nr), 15000), tam.logs().slice(-5).join('\n'));
    assert.ok(tam.logs().some((l) => /Stille Annahme MW3153999: unerwartete Antwort – nehme über die Auftragskarte an/.test(l)));
  });

  it('Aufbau mehrerer IDs: Liste „7|n|8|id|8|id …“, Transition bleibt (für den Warenkorb später)', async () => {
    await learned();
    const tpl = tam.store.get('acceptTpl'), p = tpl.body.split('|');
    assert.ok(p[2] === '11'); assert.ok(tpl.body.endsWith(`|7|1|8|${tam.gwtEnc('3709951')}|6|1|9|16|10|1|11|0|`));
  });
});

