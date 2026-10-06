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
