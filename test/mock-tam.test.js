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

describe('Annahme', { skip }, () => {
  it('nimmt passenden Auftrag mit 0-km-Auftrag an, 5 km bleibt draußen', async () => {
    tam = startTam({ gm: { places: KOELN } });
    await tam.ready();
    tam.addOrder({ ...ORDER, nearby: [{ nr: 'MW3000001', km: 0 }, { nr: 'MW3054003', km: 5 }] });
    assert.ok(await until(() => tam.accepted.length, 15000), tam.logs().join('\n'));
    assert.deepEqual(tam.accepted.sort(), ['MW3000001', 'MW3153893']);
  });

  it('nimmt im Reiter „Angenommene Aufträge“ nichts an', async () => {
    tam = startTam({ tab: 'accepted', gm: { places: KOELN } });
    await tam.ready();
    tam.addOrder(ORDER);
    await sleep(1500);
    assert.deepEqual(tam.dblclicks, []);
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

// P1: Lizenz darf nicht per Backup (Tampermonkey-Speicher) auf ein anderes Gerät wandern
describe('Gerätebindung der Lizenz (P1)', { skip }, () => {
  const TABLET_A = { platform: 'Linux armv8l', hardwareConcurrency: 8, maxTouchPoints: 5, width: 800, height: 1280, dpr: 2 };
  const TABLET_B = { platform: 'Linux armv8l', hardwareConcurrency: 6, maxTouchPoints: 10, width: 1200, height: 1920, dpr: 1.5 };
  // Erstinstallation auf Tablet A → Tampermonkey-Speicher (Inhalt eines Backups) und Website-Speicher
  async function installOn(device) {
    const t = startTam({ device });
    await t.ready();
    const keys = ['installId', 'licenseKey', 'devMark', 'devFp'];
    const gm = Object.fromEntries(keys.filter((k) => t.store.has(k)).map((k) => [k, t.store.get(k)]));
    const local = Object.fromEntries(['installId', 'licenseKey', 'devMark'].filter((k) => t.local(k)).map((k) => [k, t.local(k)]));
    t.close();
    return { gm, local };
  }

  it('Backup auf anderem Gerät → neue ID, Lizenz erforderlich', async () => {
    const a = await installOn(TABLET_A);
    assert.ok(a.gm.devMark && a.gm.devFp, 'Gerätedaten nicht gespeichert');
    tam = startTam({ device: TABLET_B, gm: a.gm }); // Tampermonkey-Backup eingespielt, Website-Speicher leer
    await tam.ready();
    assert.ok(tam.licensePanel(), 'Script läuft trotz fremdem Gerät');
    assert.notEqual(tam.store.get('installId'), a.gm.installId);
  });

  it('gleiches Gerät, Website-Daten gelöscht → Lizenz bleibt', async () => {
    const a = await installOn(TABLET_A);
    tam = startTam({ device: TABLET_A, gm: a.gm });
    await tam.ready();
    assert.ok(tam.mainPanel());
    assert.equal(tam.store.get('installId'), a.gm.installId);
    assert.equal(tam.local('devMark'), a.gm.devMark, 'Markierung nicht wieder eingetragen');
  });

  it('gleiches Gerät, Fingerabdruck geändert (z. B. Browser-Update) → Lizenz bleibt', async () => {
    const a = await installOn(TABLET_A);
    tam = startTam({ device: { ...TABLET_A, hardwareConcurrency: 4 }, gm: a.gm, local: a.local });
    await tam.ready();
    assert.ok(tam.mainPanel());
    assert.equal(tam.store.get('installId'), a.gm.installId);
  });

  it('Bestandsinstallation ohne Gerätedaten → läuft weiter und wird gebunden', async () => {
    tam = startTam({ device: TABLET_A });
    await tam.ready();
    assert.ok(tam.mainPanel());
    assert.ok(tam.store.get('devFp') && tam.store.get('devMark') && tam.local('devMark'));
  });
});

describe('Silent Reload', { skip }, () => {
  // Arbeitszeit so legen, dass „jetzt“ sicher außerhalb liegt
  const now = new Date(), hh = (h) => `${String((now.getHours() + h + 24) % 24).padStart(2, '0')}:00`;
  const OUTSIDE = { schedOn: true, schedFrom: hh(2), schedTo: hh(3) };
  const state = () => tam.document.getElementById('tamauto-silent-state').textContent;

  it('Checkbox schaltet an/aus und wird gespeichert', async () => {
    tam = startTam({ gm: { places: KOELN } });
    await tam.ready();
    const cb = tam.document.getElementById('tamauto-silent-on');
    assert.equal(cb.checked, false);
    assert.equal(state(), 'aus');
    cb.click();
    assert.equal(tam.store.get('silentOn'), true);
  });

  it('pausiert außerhalb der Arbeitszeit', async () => {
    tam = startTam({ gm: { places: KOELN, silentOn: true, silentSec: 5, ...OUTSIDE } });
    await tam.ready();
    assert.ok(await until(() => /außerhalb der Arbeitszeit/.test(state()), 2000), state());
  });

  it('altes „alle 5 s“ (ohne Checkbox) bleibt an', async () => {
    tam = startTam({ gm: { places: KOELN, silentSec: 5 } });
    await tam.ready();
    assert.equal(tam.document.getElementById('tamauto-silent-on').checked, true);
  });
});

// P1 Sixt: Auftrag passt, wird aber als „bereits bearbeitet“ übersprungen (done dauerhaft verunreinigt)
describe('Bereits bearbeitet / done (P1 Sixt)', { skip }, () => {
  const SIXT = { nr: 'MW3160001', plz: '50825', ort: 'Köln', dienst: 'Sixt Rückgabe' };
  const MIN = 60000;

  it('alter Eintrag aus früherer Version, nie angenommen → wird wieder angenommen', async () => {
    tam = startTam({ gm: { places: KOELN, doneRefs: [SIXT.nr] } });
    await tam.ready();
    tam.addOrder(SIXT);
    assert.ok(await until(() => tam.accepted.includes(SIXT.nr), 15000), tam.logs().join('\n'));
  });

  it('alter Eintrag, laut Auftragsbuch angenommen → bleibt gesperrt, Herkunft im Log', async () => {
    tam = startTam({ gm: { places: KOELN, doneRefs: [SIXT.nr], orderbook: [{ ts: '2026-10-01T10:00:00Z', nr: SIXT.nr }] } });
    await tam.ready();
    tam.addOrder(SIXT);
    assert.ok(await until(() => tam.logs().some((l) => l.includes(SIXT.nr) && /bereits bearbeitet/.test(l) && /angenommen/.test(l)), 5000), tam.logs().join('\n'));
    assert.deepEqual(tam.dblclicks, []);
  });

  it('fehlgeschlagene Annahme sperrt nur befristet', async () => {
    tam = startTam({ gm: { places: KOELN, doneRefs: [SIXT.nr],
      doneInfo: { [SIXT.nr]: { at: Date.now() - 20 * MIN, why: 'Annahme fehlgeschlagen (vergeben)', exp: Date.now() - 5 * MIN } } } });
    await tam.ready();
    tam.addOrder(SIXT);
    assert.ok(await until(() => tam.accepted.includes(SIXT.nr), 15000), tam.logs().join('\n'));
  });

  it('Fehlschlag wird mit Herkunft und Ablauf gemerkt', async () => {
    tam = startTam({ gm: { places: KOELN } });
    await tam.ready();
    tam.addOrder({ ...SIXT, onOpen: () => {} }); // Karte öffnet sich nicht
    assert.ok(await until(() => (tam.store.get('doneInfo') || {})[SIXT.nr], 30000), 'kein done-Eintrag');
    const info = tam.store.get('doneInfo')[SIXT.nr];
    assert.match(info.why, /fehlgeschlagen/);
    assert.ok(info.exp > Date.now() && info.exp - Date.now() <= 15 * MIN);
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

describe('Gesperrte Aufträge in der Tabelle', { skip }, () => {
  it('Schalter „Farbige TAM-Einträge“: Standard an; aus → alle Farben weg, wieder an → zurück', async () => {
    tam = startTam({ gm: { places: KOELN } });
    await tam.ready();
    const cb = tam.document.getElementById('tamauto-colorrows');
    assert.equal(cb.checked, true);
    tam.addOrder({ nr: 'MW3170030', plz: '99999', ort: 'Nirgendwo' });
    const row = () => [...tam.document.querySelectorAll('#AgentVeroeffentlichteAuftraege .x-grid3-row')].find((r) => r.textContent.includes('MW3170030'));
    assert.ok(await until(() => row().classList.contains('tamauto-nomatch'), 3000));
    cb.click();
    assert.equal(tam.store.get('colorRows'), false);
    assert.ok(!row().classList.contains('tamauto-nomatch') && !row().title, 'Markierung nicht entfernt');
    cb.click();
    assert.ok(row().classList.contains('tamauto-nomatch'));
  });

  it('passender Auftrag grün, nicht passender grau', async () => {
    tam = startTam({ gm: { places: KOELN } });
    await tam.ready();
    tam.addOrder({ nr: 'MW3170020', plz: '99999', ort: 'Nirgendwo' });
    tam.addOrder({ nr: 'MW3170021', plz: '50825', ort: 'Köln', onOpen: () => {} });
    const row = (nr) => [...tam.document.querySelectorAll('#AgentVeroeffentlichteAuftraege .x-grid3-row')].find((r) => r.textContent.includes(nr));
    assert.ok(await until(() => row('MW3170020').classList.contains('tamauto-nomatch'), 3000));
    assert.ok(!row('MW3170021').classList.contains('tamauto-nomatch'));
    assert.ok(row('MW3170021').classList.contains('tamauto-match'), 'auf der Annahmeliste → grün');
    assert.ok(!row('MW3170020').classList.contains('tamauto-match'));
    assert.match(row('MW3170020').title, /nicht auf der Annahmeliste/);
  });

  const rowOf = (nr) => [...tam.document.querySelectorAll('#AgentVeroeffentlichteAuftraege .x-grid3-row')].find((r) => r.textContent.includes(nr));

  it('Excel „nicht annehmen“ → rot, Rückgabe → orange, andere Zeilen ohne Markierung', async () => {
    const places = { ...KOELN, plz: ['50825', '51'], block: { plz: ['51'], orte: [] } };
    tam = startTam({ gm: { places, retMinGoneSec: 1 } });
    await tam.ready();
    tam.ntfy('tamret-', { v: 1, t: 'acc', nrs: ['MW3170003'], at: Date.now() });
    tam.ntfy('tamret-', { v: 1, t: 'ret', nrs: ['MW3170003'], at: Date.now() });
    tam.addOrder({ nr: 'MW3170003', plz: '50825', ort: 'Köln', onOpen: () => {} });
    tam.addOrder({ nr: 'MW3170004', plz: '51105', ort: 'Köln', onOpen: () => {} });
    tam.addOrder({ nr: 'MW3170005', plz: '99999', ort: 'Nirgendwo' });
    assert.ok(await until(() => rowOf('MW3170003').classList.contains('tamauto-returned'), 3000));
    assert.ok(!rowOf('MW3170003').classList.contains('tamauto-blocked'));
    assert.ok(rowOf('MW3170004').classList.contains('tamauto-blocked'));
    assert.ok(!rowOf('MW3170004').classList.contains('tamauto-returned'));
    assert.ok(!rowOf('MW3170005').classList.contains('tamauto-blocked') && !rowOf('MW3170005').classList.contains('tamauto-returned'));
    assert.ok(rowOf('MW3170005').classList.contains('tamauto-nomatch'), 'nicht auf der Annahmeliste → grau');
    assert.ok(!rowOf('MW3170004').classList.contains('tamauto-nomatch'), 'gesperrt geht vor grau');
    assert.ok(!rowOf('MW3170004').classList.contains('tamauto-match') && !rowOf('MW3170003').classList.contains('tamauto-match'), 'gesperrt geht vor grün');
    assert.match(rowOf('MW3170003').title, /zurückgegeben/);
    assert.doesNotMatch(rowOf('MW3170003').title, /erkannt von/);
  });

  it('Rückgabe-Meldung enthält nur Auftragsnummern', async () => {
    const NR = 'MW3170006';
    tam = startTam({ gm: { places: KOELN, retMinGoneSec: 1 } });
    await tam.ready();
    tam.ntfy('tamret-', { v: 1, t: 'acc', nrs: [NR], at: Date.now() });
    tam.addOrder({ nr: 'MW3999998', plz: '99999', ort: 'Nirgendwo' });
    await sleep(1500);
    tam.addOrder({ nr: NR, plz: '50825', ort: 'Köln' });
    assert.ok(await until(() => tam.posts('tamret-').some((m) => m.t === 'ret'), 5000));
    tam.posts('tamret-').forEach((m) => assert.deepEqual(Object.keys(m).sort(), ['at', 'nrs', 't', 'v']));
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

describe('Log', { skip }, () => {
  it('Millisekunden nur als ganze Zahl', async () => {
    tam = startTam({ gm: { places: KOELN, pushOnV3: true } });
    await tam.ready();
    tam.ntfy('tam-zrd6g634b4wej7aqhsycc9qm', { v: 1, src: 'Test', ts: Date.now() - 123.456, test: true });
    assert.ok(await until(() => tam.logs().some((l) => /Push-Signal empfangen/.test(l)), 2000), tam.logs().join('\n'));
    assert.ok(!tam.logs().some((l) => /\d[.,]\d+ ?ms\b/.test(l)), tam.logs().filter((l) => /ms\b/.test(l)).join('\n'));
  });
});

// Zweiter Update-Kanal: OneDrive, falls GitHub (Repo) nicht erreichbar ist
describe('Update über GitHub oder OneDrive', { skip }, () => {
  const { revocationList } = require('./harness');
  const ONEDRIVE = 'IQALfRz3JKDFTajqSq2MROJNAcTdmeeQDOYup07olXdgzlg';
  const xhr = (gh, od) => (o) => {
    if (o.url.includes('IQBmSNFRkXF5')) return { status: 200, responseText: revocationList() };
    if (o.url.includes('raw.githubusercontent.com') && /\.user\.js/.test(o.url)) return gh ? { status: 200, responseText: `// @version ${gh}` } : { status: 404, responseText: '' };
    if (o.url.includes(ONEDRIVE)) return od ? { status: 200, responseText: `// @version ${od}` } : { error: true };
    return { error: true };
  };
  const link = () => tam.document.getElementById('tamauto-update');
  const updLog = () => until(() => tam.logs().find((l) => /Update .* verfügbar/.test(l)), 3000);

  it('GitHub weg → Update von OneDrive', async () => {
    tam = startTam({ gm: { places: KOELN }, xhr: xhr(null, '9.9.9') });
    await tam.ready();
    assert.match(await updLog() || '', /9\.9\.9.*OneDrive/);
    assert.ok(link().href.includes(ONEDRIVE), link().href);
  });

  it('GitHub zuerst: GitHub hat ein Update → GitHub-Link, auch wenn OneDrive eine noch neuere Version hat', async () => {
    tam = startTam({ gm: { places: KOELN }, xhr: xhr('9.9.9', '9.9.10') });
    await tam.ready();
    assert.match(await updLog() || '', /9\.9\.9.*GitHub/);
    assert.match(link().href, /^https:\/\/raw\.githubusercontent\.com\/.*\.user\.js$/);
  });

  it('GitHub ohne Update, OneDrive mit Update → OneDrive (Ersatz)', async () => {
    tam = startTam({ gm: { places: KOELN }, xhr: xhr('1.0.0', '9.9.9') });
    await tam.ready();
    assert.match(await updLog() || '', /9\.9\.9.*OneDrive/);
  });

  it('Tampermonkey prüft Updates über GitHub (Kopf @updateURL/@downloadURL)', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'tam-auto-annahme.user.js'), 'utf8');
    assert.match(src, /@updateURL\s+https:\/\/raw\.githubusercontent\.com\/TheFishflap\/TamAuto\/main\/tam-auto-annahme\.user\.js/);
    assert.match(src, /@downloadURL\s+https:\/\/raw\.githubusercontent\.com\/TheFishflap\/TamAuto\/main\/tam-auto-annahme\.user\.js/);
  });
});

// Autohaus-Regeln: Blatt „nicht annehmen Adresse“ sperrt nur eine Adresse, nicht die ganze PLZ
describe('Excel „nicht annehmen Adresse“', { skip }, () => {
  const { makeXlsx, revocationList } = require('./harness');
  const xlsx = makeXlsx({
    annehmen: [['PLZ', 'Ort'], ['50825', 'Köln']],
    'nicht annehmen': [['PLZ', 'Ort']],
    'nicht annehmen Adresse': [['PLZ', 'Straße'], ['50825', 'Maarweg 241'], ['50825', 'Venloer Str.']],
  });
  const xhr = (o) => o.url.includes('IQBmSNFRkXF5') ? { status: 200, responseText: revocationList() }
    : o.url.includes('IQDymsXIGo99') ? { status: 200, response: xlsx } : { error: true };
  const rowOf = (nr) => [...tam.document.querySelectorAll('#AgentVeroeffentlichteAuftraege .x-grid3-row')].find((r) => r.textContent.includes(nr));

  it('gesperrte Adresse rot und nicht angenommen, andere Adresse in derselben PLZ angenommen', async () => {
    tam = startTam({ gm: { places: { plz: [], orte: [] } }, xhr });
    await tam.ready();
    assert.ok(await until(() => (tam.store.get('places').blockAddr || []).length === 2, 5000), JSON.stringify(tam.store.get('places')));
    tam.addOrder({ nr: 'MW3180001', plz: '50825', ort: 'Köln', strasse: 'Maarweg 241-251', onOpen: () => {} });
    tam.addOrder({ nr: 'MW3180002', plz: '50825', ort: 'Köln', strasse: 'Venloer Straße 12', onOpen: () => {} });
    tam.addOrder({ nr: 'MW3180003', plz: '50825', ort: 'Köln', strasse: 'Maarweg 24' });
    assert.ok(await until(() => tam.accepted.includes('MW3180003'), 15000), tam.logs().join('\n'));
    assert.ok(!tam.dblclicks.includes('MW3180001') && !tam.dblclicks.includes('MW3180002'), tam.dblclicks.join());
    assert.ok(rowOf('MW3180001').classList.contains('tamauto-blocked'));
    assert.match(rowOf('MW3180001').title, /Maarweg 241/);
    assert.ok(!rowOf('MW3180003').classList.contains('tamauto-blocked'));
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

// Terminvereinbarung nach der Annahme weggeklickt (z. B. Sixt) → im Auftragsbuch rote 1, wenn der Auftrag laut
// „Angenommene Aufträge“ (Endtermin (Agent)) innerhalb von 2 h nach der Annahme aus der SLA fällt
describe('Auftragsbuch: rote 1 (Terminvereinbarung weggeklickt, SLA ≤ 2 h)', { skip }, () => {
  const terminWin = (t) => {
    const m = t.document.createElement('div'); m.className = 'x-window x-component';
    m.innerHTML = '<div class="x-window-header"><span class="x-window-header-text">Terminvereinbarung</span></div>' +
      '<div class="x-window-body">Termin mit dem Kunden vereinbaren <input type="checkbox"></div>' +
      '<table class="x-btn"><tbody><tr><td><button>Speichern</button></td></tr></tbody></table>' +
      '<table class="x-btn"><tbody><tr><td><button>Abbrechen</button></td></tr></tbody></table>';
    m.querySelectorAll('button')[1].addEventListener('click', () => { t.closed.push('Terminvereinbarung'); m.remove(); });
    t.document.body.appendChild(m);
  };
  const inH = (h) => { const d = new Date(Date.now() + h * 3600000), p = (n) => String(n).padStart(2, '0');
    return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`; };
  const red = () => [...tam.document.querySelectorAll('#tamauto-ob-rows td span.tamauto-termin')];
  async function acceptWithTermin(extra = {}) {
    tam = startTam({ gm: { places: KOELN } });
    await tam.ready();
    tam.addOrder({ ...ORDER, ...extra, afterAccept: (t) => setTimeout(() => terminWin(t), 200) });
    assert.ok(await until(() => tam.closed.includes('Terminvereinbarung'), 5000), 'nicht weggeklickt');
    assert.ok(await until(() => (tam.store.get('orderbook') || []).length, 5000));
    await sleep(3000); // Nachkontrolle vorbei
  }

  it('Endtermin in „Angenommene Aufträge“ in 1 h → rote 1 (auch beim Warenkorb-Auftrag)', async () => {
    await acceptWithTermin({ nearby: [{ nr: 'MW3000001', km: 0 }] });
    assert.equal(red().length, 0, 'rote 1 vor dem Lesen des Endtermins');
    tam.addAccepted(ORDER.nr, inH(1), { zeichen: '' }); tam.addAccepted('MW3000001', inH(1.5), { zeichen: '' });
    tam.selectTab('AgentEigeneAuftraege');
    assert.ok(await until(() => red().length === 2, 3000), JSON.stringify(tam.store.get('orderbook')));
    assert.equal(red()[0].textContent, '1');
  });

  it('Endtermin in 5 h → keine rote 1', async () => {
    await acceptWithTermin();
    tam.addAccepted(ORDER.nr, inH(5));
    tam.selectTab('AgentEigeneAuftraege');
    await sleep(1500);
    assert.equal(red().length, 0);
  });

  it('Endtermin nicht lesbar → keine rote 1', async () => {
    await acceptWithTermin();
    tam.addAccepted(ORDER.nr, '');
    tam.selectTab('AgentEigeneAuftraege');
    await sleep(1500);
    assert.equal(red().length, 0);
  });

  it('ohne weggeklickte Terminvereinbarung → keine rote 1, auch bei knapper SLA', async () => {
    tam = startTam({ gm: { places: KOELN } });
    await tam.ready();
    tam.addOrder(ORDER);
    assert.ok(await until(() => (tam.store.get('orderbook') || []).length, 8000));
    tam.addAccepted(ORDER.nr, inH(1));
    tam.selectTab('AgentEigeneAuftraege');
    await sleep(1500);
    assert.equal(red().length, 0);
  });
});

// „Ihr Zeichen“ im Auftragsbuch setzen: auswählen → „In TAM übernehmen“ → still per saveMerkmal (wie im Mitschnitt)
describe('Ihr Zeichen still setzen (Auftragsbuch)', { skip }, () => {
  const today = new Date().toISOString();
  const BOOK = [{ ts: today, nr: 'MW3190201', plz: '50825', ort: 'Köln', preis: 50 }, { ts: today, nr: 'MW3190202', plz: '50825', ort: 'Köln', preis: 60 }];
  const $ = (id) => tam.document.getElementById(id);
  const bookRow = (nr) => [...tam.document.querySelectorAll('#tamauto-ob-rows tr')].find((r) => r.textContent.includes(nr));
  async function setup(gm = {}) {
    tam = startTam({ gm: { places: KOELN, orderbook: BOOK, ...gm } });
    await tam.ready();
    // TAM-Anfrage übernehmen (für Kopfzeilen/Prüfsumme), Angenommene Aufträge mit IDs und Zeichen
    const bar = [...tam.document.querySelectorAll('#AgentVeroeffentlichteAuftraege .x-toolbar')].find((x) => /Einträge pro Seite/.test(x.textContent));
    bar.querySelectorAll('.x-btn')[4].querySelector('button').click();
    await sleep(1200);
    tam.addAccepted('MW3190201', '', { id: '3705231', zeichen: '' });
    tam.addAccepted('MW3190202', '', { id: '3705232', zeichen: 'PM' });
    tam.selectTab('AgentEigeneAuftraege');
    assert.ok(await until(() => tam.store.get('orderbook').every((e) => e.tid), 3000), 'Abgleich mit „Angenommene Aufträge“ fehlt');
    tam.selectTab('AgentVeroeffentlichteAuftraege');
    await sleep(500);
  }

  it('Eingabefeld: höchstens 20 Zeichen, Standard „neu“', async () => {
    await setup();
    assert.equal($('tamauto-zeichen-text').maxLength, 20);
    assert.equal($('tamauto-zeichen-text').value, 'neu');
  });

  it('Preis aus „Angenommene Aufträge“ ins Auftragsbuch übernommen', async () => {
    tam = startTam({ gm: { places: KOELN, orderbook: [{ ts: today, nr: 'MW3190203', plz: '50825', ort: 'Köln', preis: null }] } });
    await tam.ready();
    tam.addAccepted('MW3190203', '', { id: '3705233', zeichen: '', preis: '77,50 €' });
    tam.selectTab('AgentEigeneAuftraege');
    assert.ok(await until(() => tam.store.get('orderbook')[0].preis === 77.5, 3000), JSON.stringify(tam.store.get('orderbook')));
  });

  it('vorhandenes Zeichen aus „Angenommene Aufträge“ im Auftragsbuch, grau', async () => {
    await setup();
    assert.ok(await until(() => bookRow('MW3190202') && bookRow('MW3190202').textContent.includes('PM'), 2000));
    assert.equal(bookRow('MW3190202').style.background, 'rgb(238, 238, 238)');
  });

  it('auswählen und übernehmen → still gespeichert (ID kodiert wie TAM), belegte Aufträge übersprungen', async () => {
    await setup();
    $('tamauto-zeichen-on').click();
    bookRow('MW3190201').click();
    bookRow('MW3190202').click(); // grau/belegt → nicht auswählbar
    assert.match($('tamauto-zeichen-go').textContent, /\(1\)/);
    $('tamauto-zeichen-go').click();
    assert.ok(await until(() => tam.saves.length, 3000), tam.logs().slice(-4).join('\n'));
    assert.equal(tam.saves.length, 1);
    assert.match(tam.saves[0], /\|saveMerkmal\|java\.lang\.Long\/4227064769\|java\.lang\.String\/2004016611\|neu\|1\|2\|3\|4\|2\|5\|6\|5\|OImP\|7\|$/);
    assert.ok(await until(() => (tam.store.get('orderbook').find((e) => e.nr === 'MW3190201') || {}).zeichen === 'neu', 2000));
    assert.equal(tam.store.get('orderbook').find((e) => e.nr === 'MW3190202').zeichen, 'PM');
  });

  it('TAM meldet Fehler → Zeichen nicht übernommen', async () => {
    await setup();
    tam.rpcSave = '//EX[1,["com.google.gwt.user.client.rpc.SerializationException"]]';
    $('tamauto-zeichen-on').click();
    bookRow('MW3190201').click();
    $('tamauto-zeichen-go').click();
    assert.ok(await until(() => tam.saves.length, 3000));
    await sleep(300);
    assert.ok(!tam.store.get('orderbook').find((e) => e.nr === 'MW3190201').zeichen);
  });

  it('ausgeschaltet (Standard): Klick wählt nichts aus', async () => {
    await setup();
    bookRow('MW3190201').click();
    assert.equal($('tamauto-zeichen-go').disabled, true);
  });
});

describe('Angenommene Zeile lokal ausblenden', { skip }, () => {
  const rowOf = (nr) => [...tam.document.querySelectorAll('#AgentVeroeffentlichteAuftraege .x-grid3-row')].find((r) => r.textContent.includes(nr));
  const terminLess = (t, title, body) => setTimeout(() => t.showMessage(title, body), 300);

  it('nach erfolgreicher Annahme: Auftrag und Warenkorb-Auftrag ausgeblendet', async () => {
    tam = startTam({ gm: { places: KOELN } });
    await tam.ready();
    tam.addOrder({ nr: 'MW3000001', plz: '99999', ort: 'Nirgendwo' }); // 0-km-Auftrag steht auch in der Tabelle
    tam.addOrder({ ...ORDER, nearby: [{ nr: 'MW3000001', km: 0 }] });
    assert.ok(await until(() => rowOf(ORDER.nr).classList.contains('tamauto-gone'), 15000), tam.logs().slice(-5).join('\n'));
    assert.ok(rowOf('MW3000001').classList.contains('tamauto-gone'));
  });

  it('TAM meldet danach „bereits vergeben“ → wieder eingeblendet', async () => {
    tam = startTam({ gm: { places: KOELN } });
    await tam.ready();
    tam.addOrder({ ...ORDER, afterAccept: (t) => terminLess(t, 'Auftrag bereits vergeben!', 'Der Auftrag MW3153893 wurde bereits vergeben.') });
    assert.ok(await until(() => tam.logs().some((l) => /nachträglich/.test(l)), 15000), tam.logs().join('\n'));
    assert.ok(!rowOf(ORDER.nr).classList.contains('tamauto-gone'));
  });

  it('Schalter „Farbige TAM-Einträge“ aus → nichts ausgeblendet', async () => {
    tam = startTam({ gm: { places: KOELN, colorRows: false } });
    await tam.ready();
    tam.addOrder(ORDER);
    assert.ok(await until(() => tam.accepted.length, 15000));
    await sleep(1000);
    assert.ok(!rowOf(ORDER.nr).classList.contains('tamauto-gone'));
  });
});

// Stille Abfrage bei TAM (gemeinsam für Push-Signal und Nachfragen nach einem Refresh von Hand)
describe('Stille Abfrage (Push-Signal)', { skip }, () => {
  const PUSH = 'tam-zrd6g634b4wej7aqhsycc9qm';
  async function ready() {
    tam = startTam({ gm: { places: KOELN, pushOnV3: true } });
    await tam.ready();
    // einmal von TAM aktualisieren lassen → Script übernimmt TAMs Anfrage
    const bar = [...tam.document.querySelectorAll('#AgentVeroeffentlichteAuftraege .x-toolbar')].find((x) => /Einträge pro Seite/.test(x.textContent));
    bar.querySelectorAll('.x-btn')[4].querySelector('button').click();
    await until(() => tam.refreshes === 1, 2000);
    await sleep(1500);
    return tam.refreshes;
  }
  it('TAM meldet neuen Auftrag → Tabelle wird aktualisiert', async () => {
    const r0 = await ready();
    tam.rpc = '//OK["com.extjs.gxt.ui.client.data.BasePagingLoadResult/496878394","MW3199999","50825","Köln"]';
    tam.ntfy(PUSH, { v: 1, src: 'Test-Tablet', ts: Date.now() });
    assert.ok(await until(() => tam.refreshes > r0, 4000), tam.logs().slice(-5).join('\n'));
    assert.ok(tam.logs().some((l) => /neue Daten in TAM/.test(l)));
  });
  it('TAM meldet nichts Neues → keine Aktualisierung', async () => {
    const r0 = await ready();
    tam.rpc = '//OK["com.extjs.gxt.ui.client.data.BasePagingLoadResult/496878394"]';
    tam.ntfy(PUSH, { v: 1, src: 'Test-Tablet', ts: Date.now() });
    assert.ok(await until(() => tam.fetches.some((f) => /gwt-rpc/.test(f.url)), 4000), 'keine stille Abfrage');
    await sleep(1000);
    assert.equal(tam.refreshes, r0);
  });
});

// Stille Abfrage hält die Tabelle aktuell: nicht mehr veröffentlichte Aufträge lokal ausblenden
describe('Tabelle über stille Abfrage aktuell halten', { skip }, () => {
  const PUSH = 'tam-zrd6g634b4wej7aqhsycc9qm';
  const RPC = (...nrs) => `//OK["com.extjs.gxt.ui.client.data.BasePagingLoadResult/496878394",${nrs.map((n) => `"${n}"`).join(',')}]`;
  const row = (nr) => [...tam.document.querySelectorAll('#AgentVeroeffentlichteAuftraege .x-grid3-row')].find((r) => r.textContent.includes(nr));
  async function setup(gm = {}) {
    tam = startTam({ gm: { places: KOELN, pushOnV3: true, ...gm } });
    await tam.ready();
    tam.addOrder({ nr: 'MW3180101', plz: '99999', ort: 'Nirgendwo' });
    tam.addOrder({ nr: 'MW3180102', plz: '99998', ort: 'Irgendwo' });
    const bar = [...tam.document.querySelectorAll('#AgentVeroeffentlichteAuftraege .x-toolbar')].find((x) => /Einträge pro Seite/.test(x.textContent));
    bar.querySelectorAll('.x-btn')[4].querySelector('button').click(); // TAM-Anfrage übernehmen
    await sleep(1500);
  }
  const push = () => tam.ntfy(PUSH, { v: 1, src: 'Test-Tablet', ts: Date.now() });

  it('Auftrag fehlt in TAMs Antwort → ausgeblendet; taucht wieder auf → eingeblendet', async () => {
    await setup();
    tam.rpc = RPC('MW3180101');
    push();
    assert.ok(await until(() => row('MW3180102').classList.contains('tamauto-vanished'), 4000), tam.logs().slice(-5).join('\n'));
    assert.ok(!row('MW3180101').classList.contains('tamauto-vanished'));
    await sleep(10500); // Push-Signale innerhalb von 10 s werden zusammengefasst
    tam.rpc = RPC('MW3180101', 'MW3180102');
    push();
    assert.ok(await until(() => !row('MW3180102').classList.contains('tamauto-vanished'), 4000));
  });

  it('fehlerhafte TAM-Antwort → nichts ausgeblendet', async () => {
    await setup();
    tam.rpc = '//EX[Sitzung abgelaufen]';
    push();
    assert.ok(await until(() => tam.fetches.some((f) => /gwt-rpc/.test(f.url)), 4000));
    await sleep(800);
    assert.ok(!row('MW3180101').classList.contains('tamauto-vanished') && !row('MW3180102').classList.contains('tamauto-vanished'));
  });

  it('Schalter „Farbige TAM-Einträge“ aus → nichts ausgeblendet', async () => {
    await setup({ colorRows: false });
    tam.rpc = RPC('MW3180101');
    push();
    assert.ok(await until(() => tam.fetches.some((f) => /gwt-rpc/.test(f.url)), 4000));
    await sleep(800);
    assert.ok(!row('MW3180102').classList.contains('tamauto-vanished'));
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
