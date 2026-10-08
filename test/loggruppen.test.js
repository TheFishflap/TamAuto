// Log-Gruppen: jede Zeile zeigt, von welchem Feature sie ausgeht (Beispiele aus echten Logs vom 07.10.2026)
'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'tam-auto-annahme.user.js'), 'utf8');
const a = src.indexOf('// <log-gruppen>'), b = src.indexOf('// </log-gruppen>');
if (a < 0 || b < 0) throw new Error('Marker <log-gruppen> fehlt im Script');
const { logGruppe } = new Function(`${src.slice(a, b)}; return { logGruppe };`)();

describe('Log-Gruppen', () => {
  const faelle = [
    ['Auftragsbuch an die anderen Geräte gesendet (150 Aufträge, 15 Nachrichten).', 'Auftragsbuch'],
    ['Von LouisOnePlus angenommen: MW3214135 – im Auftragsbuch eingetragen.', 'Auftragsbuch'],
    ['Meldung an die anderen Geräte konnte nach mehreren Versuchen nicht gesendet werden (HTTP 429).', 'Auftragsbuch'],
    ['MA-Management: Auftragsbuch 181 Aufträge (7 Tage) · Terminpflicht ohne Tour 26', 'MA-Management'],
    ['Angenommene Aufträge (still gelesen): 2 Zeichen im Auftragsbuch ergänzt.', 'MA-Management'],
    ['Silent Reload: neue Daten in TAM (86 neue Einträge: …) → Tabelle aktualisieren', 'Web-Analyse'],
    ['Push-Signal: TAM meldet nichts Neues (Abfrage 167 ms) – Tabelle ist aktuell.', 'Web-Analyse'],
    ['MW3214086: nicht mehr veröffentlicht – ausgeblendet.', 'Web-Analyse'],
    ['Silent Reload → Abgleich: 14 Aufträge in Tabelle, 14 offen, 3 passend', 'Annahme'],
    ['MW3214069 · 45897 Gelsenkirchen · Arval → TREFFER → wird angenommen', 'Annahme'],
    ['Nehme an: MW3214086 · 35066 Frankenberg (Eder) · 76,65 €', 'Annahme'],
    ['Angenommen: MW3217075 · 51063 Köln · Toyota Kinto · 69,35 € · per Silent Reload gefunden · im Hintergrund (anderer Reiter offen)', 'Annahme'],
    ['Stille Annahme MW1: sende accept (ID 1 = B)', 'Stille Annahme'],
    ['Rückgabe gemeldet: MW1 – 48 h nicht annehmen.', 'Rückgabe'],
    ['Ortslisten unverändert – Ortsliste "annehmen": 35 PLZ', 'Ortsliste'],
    ['Kein Update – 1.29.1 ist aktuell (geprüft: GitHub).', 'Update'],
    ['Lizenz per Fernfreischaltung aktualisiert: gültig bis 01.01.2027.', 'Lizenz'],
    ['Start: beide Reiter geöffnet, „Angenommene Aufträge“ still geladen', 'Start'],
    ['TAM-Meldung sofort geschlossen: Es wurden 1 weitere Aufträge …', 'TAM-Fenster'],
    ['Priorität: Einzelpreis → Summe am Ort → Anzahl am Ort.', 'Einstellungen'],
  ];
  for (const [msg, g] of faelle) it(`${g}: ${msg.slice(0, 50)}`, () => assert.equal(logGruppe(msg), g));
});
