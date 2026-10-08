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

  it('„bereits vergeben“ beim 2. Auftrag am Ort (Meldung ohne Nummer) wird nicht dem 1., angenommenen Auftrag zugeordnet', async () => {
    tam = startTam({ gm: { places: KOELN } });
    await tam.ready();
    const B = { nr: 'MW3153894', plz: '50825', ort: 'Köln', onOpen: (t) => setTimeout(() => t.showMessage('Auftrag bereits vergeben!', 'Sie können die Auftragskarte nicht mehr anzeigen lassen da der Auftrag bereits vergeben wurde.'), 50) };
    tam.addOrder(ORDER); tam.addOrder(B);
    assert.ok(await until(() => tam.accepted.includes(ORDER.nr) && tam.logs().some((l) => /Annahme fehlgeschlagen: MW3153894/.test(l)), 15000), tam.logs().slice(-8).join('\n'));
    await sleep(3000); // Nachkontrolle des 1. Auftrags vorbei
    assert.ok(!tam.logs().some((l) => /MW3153893: nachträglich/.test(l)), tam.logs().slice(-8).join('\n'));
    assert.ok((tam.store.get('orderbook') || []).some((e) => e.nr === ORDER.nr), '1. Auftrag fehlt im Auftragsbuch');
  });

  it('„bereits vergeben“, danach meldet ein eigenes Gerät die Annahme → grüne Korrektur, Trefferquote „von eigenen Geräten“', async () => {
    tam = startTam({ gm: { places: KOELN } });
    await tam.ready();
    const B = { nr: 'MW3153894', plz: '50825', ort: 'Köln', onOpen: (t) => setTimeout(() => t.showMessage('Auftrag bereits vergeben!', 'Sie können die Auftragskarte nicht mehr anzeigen lassen da der Auftrag bereits vergeben wurde.'), 50) };
    tam.addOrder(B);
    assert.ok(await until(() => tam.logs().some((l) => /Annahme fehlgeschlagen: MW3153894/.test(l)), 15000), tam.logs().slice(-6).join('\n'));
    assert.equal(tam.store.get('hitstats').MW3153894.s, 'vergeben');
    tam.ntfy('tamret-', { v: 1, t: 'acc', nrs: ['MW3153894'], by: 'LouisOnePlus', at: Date.now() });
    assert.ok(await until(() => tam.logs().some((l) => /Korrektur: MW3153894 war nicht an ein anderes Büro vergeben – LouisOnePlus hat ihn angenommen/.test(l)), 3000), tam.logs().slice(-4).join('\n'));
    assert.equal(tam.store.get('hitstats').MW3153894.s, 'intern');
    const line = [...tam.document.querySelectorAll('#tamauto-log div')].find((d) => /Korrektur: MW3153894/.test(d.textContent));
    assert.equal(line.style.color, 'rgb(46, 125, 50)');
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

  it('Status im Kopf: im Reiter „Veröffentlichte Aufträge“ grün „● bereit“ – auch mit stiller Annahme „nur Sixt“ (andere Aufträge laufen über die Karte)', async () => {
    const hs = () => tam.document.getElementById('tamauto-head-state');
    await learned({ running: true, silentOn: true, silentAcceptSixt: true });
    assert.equal(hs().textContent, '● bereit'); assert.equal(hs().style.color, 'rgb(46, 125, 50)');
  });

  it('Log: „Nehme an“ nennt Reiter und Weg; kopiertes Log hat „Status beim Kopieren“ mit Reiter und stiller Annahme', async () => {
    await learned({ running: true, silentOn: true });
    assert.ok(tam.logs().some((l) => /Nehme an: MW3153893 .* · Reiter „Veröffentlichte Aufträge“ · über die Auftragskarte/.test(l)), tam.logs().slice(-8).join('\n'));
    let clip = '';
    Object.defineProperty(tam.window.navigator, 'clipboard', { value: { writeText: async (t) => { clip = t; } }, configurable: true });
    tam.document.getElementById('tamauto-copylog').click();
    assert.ok(await until(() => clip, 2000));
    assert.match(clip, /\nStatus beim Kopieren: ● bereit · Reiter „Veröffentlichte Aufträge“ · Script läuft.* · Stille Annahme an \(alle, gelernt\)/);
  });

  it('grüner Haken und Lerndatum, sobald gelernt; vorher „noch nicht gelernt“', async () => {
    tam = startTam({ gm: { places: KOELN } }); await tam.ready();
    assert.equal(tam.document.getElementById('tamauto-sa-ok').style.display, 'none');
    assert.match(tam.document.getElementById('tamauto-silentaccept-state').textContent, /^noch nicht gelernt/);
    tam.close();
    await learned();
    assert.equal(tam.document.getElementById('tamauto-sa-ok').style.display, '');
    assert.match(tam.document.getElementById('tamauto-silentaccept-state').textContent, /^gelernt am \d{2}\.\d{2}\.\d{4}, \d{2}:\d{2}$/);
  });

  it('ⓘ neben „Stille Annahme“ klappt die Erklärung auf und wieder zu', async () => {
    tam = startTam({ gm: { places: KOELN } }); await tam.ready();
    const box = tam.document.getElementById('tamauto-sa-infobox');
    assert.equal(box.style.display, 'none');
    tam.document.getElementById('tamauto-sa-info').click();
    assert.equal(box.style.display, 'block'); assert.match(box.textContent, /einmal je Gerät/);
    tam.document.getElementById('tamauto-sa-info').click();
    assert.equal(box.style.display, 'none');
  });

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

  it('Hintergrund (Beta): Reiter „Angenommene Aufträge“ offen → neuer Auftrag still angenommen, ohne Karte und ohne Reiterwechsel; Status „● still aktiv“', async () => {
    await learned({ running: true, silentOn: true });
    await sleep(2500); // Nachkontrolle der ersten Annahme vorbei (sie holt sonst „Veröffentlichte Aufträge“ zurück)
    tam.selectTab('AgentEigeneAuftraege');
    await sleep(1200);
    assert.ok(!tam.onPublished());
    assert.equal(tam.document.getElementById('tamauto-head-state').textContent, '● still aktiv');
    tam.addOrder(SIXT2);
    assert.ok(await until(() => tam.accepted.includes(SIXT2.nr), 15000), tam.logs().slice(-8).join('\n'));
    assert.deepEqual(tam.dblclicks, [FIRST.nr], 'Auftragskarte geöffnet');
    assert.ok(!tam.onPublished(), 'Reiter gewechselt');
    assert.ok(tam.logs().some((l) => /Angenommen: MW3153999 .*im Hintergrund/.test(l)), tam.logs().slice(-6).join('\n'));
    assert.ok((tam.store.get('orderbook') || []).some((e) => e.nr === SIXT2.nr));
  });

  it('Hintergrund + Silent Reload: neue Daten bei TAM → Refresh-Pfeil der VERDECKTEN Tabelle wird geklickt, Reiter bleibt', async () => {
    await learned({ running: true, silentOn: true, silentSec: 2 });
    const bar = [...tam.document.querySelectorAll('#AgentVeroeffentlichteAuftraege .x-toolbar')].find((x) => /Einträge pro Seite/.test(x.textContent));
    bar.querySelectorAll('.x-btn')[4].querySelector('button').click(); // TAM-Anfrage übernehmen
    await sleep(2500);
    tam.selectTab('AgentEigeneAuftraege');
    await sleep(500);
    const r0 = tam.refreshes;
    tam.rpc = '//OK[1,2,' + JSON.stringify(['x.model.auftraege.Teilauftrag/1', 'MW3153999', '50825']) + ',0,7]';
    assert.ok(await until(() => tam.refreshes > r0, 8000), tam.logs().slice(-6).join('\n'));
    assert.ok(!tam.onPublished(), 'Reiter gewechselt');
    assert.ok(tam.logs().some((l) => /Silent Reload: neue Daten in TAM/.test(l)));
  });

  it('Hintergrund + „nur Sixt“: normaler Auftrag wartet (nicht als fehlgeschlagen gemerkt) und wird nach Rückkehr zu „Veröffentlichte Aufträge“ über die Karte angenommen', async () => {
    await learned({ running: true, silentOn: true, silentAcceptSixt: true });
    await sleep(2500);
    tam.selectTab('AgentEigeneAuftraege');
    await sleep(1200);
    assert.ok(!tam.onPublished());
    assert.equal(tam.document.getElementById('tamauto-head-state').textContent, '◐ still: Sixt + ab 150 €');
    const NORMAL = { nr: 'MW3153998', plz: '50825', ort: 'Köln', id: '3709953', dienst: 'Zustandsbericht' };
    tam.addOrder(NORMAL);
    assert.ok(await until(() => tam.logs().some((l) => /MW3153998: im Hintergrund nur still möglich \(Einstellung „nur Sixt \+ ab 150 €“\)/.test(l)), 8000), tam.logs().slice(-6).join('\n'));
    assert.ok(!tam.accepted.includes(NORMAL.nr)); assert.equal(acceptFetches().length, 0);
    assert.ok(!((tam.store.get('doneInfo') || {})[NORMAL.nr]), 'als erledigt/fehlgeschlagen gemerkt');
    tam.selectTab('AgentVeroeffentlichteAuftraege');
    assert.ok(await until(() => tam.accepted.includes(NORMAL.nr), 15000), tam.logs().slice(-6).join('\n'));
    assert.ok(tam.dblclicks.includes(NORMAL.nr), 'nicht über die Karte');
  });

  it('Hintergrund ohne stille Annahme: nichts angenommen, Status „⏸ pausiert“', async () => {
    tam = startTam({ gm: { places: KOELN, running: true, silentOn: true } });
    await tam.ready();
    tam.selectTab('AgentEigeneAuftraege');
    await sleep(1200);
    assert.equal(tam.document.getElementById('tamauto-head-state').textContent, '⏸ pausiert');
    tam.addOrder(SIXT2);
    await sleep(2500);
    assert.ok(!tam.accepted.includes(SIXT2.nr)); assert.deepEqual(tam.dblclicks, []);
  });

  it('„nur Sixt + ab 150 €“: normaler Auftrag unter 150 € läuft weiter über die Karte', async () => {
    await learned({ silentAcceptSixt: true });
    tam.addOrder({ ...SIXT2, nr: 'MW3153998', id: '3709953', dienst: 'Standard', preis: '149,99 €' });
    assert.ok(await until(() => tam.accepted.includes('MW3153998'), 15000));
    assert.deepEqual(tam.dblclicks, [FIRST.nr, 'MW3153998']); assert.equal(acceptFetches().length, 0);
  });

  it('„nur Sixt + ab 150 €“: normaler Auftrag ab 150 € wird still angenommen', async () => {
    await learned({ silentAcceptSixt: true });
    tam.addOrder({ ...SIXT2, nr: 'MW3153997', id: '3709954', dienst: 'Minderwertgutachten', preis: '150,75 €' });
    assert.ok(await until(() => tam.accepted.includes('MW3153997'), 15000), tam.logs().slice(-5).join('\n'));
    assert.deepEqual(tam.dblclicks, [FIRST.nr], 'lief über die Karte'); assert.equal(acceptFetches().length, 1);
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

