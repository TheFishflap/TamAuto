# TAM – Aufbau der Seite (für die Weiterentwicklung)

Stand: 06.10.2026 · Script 1.20.0 · ermittelt aus Live-Mitschnitten (Firefox + Tampermonkey). Keine Kundendaten.

## 1. Technik
- **TAM – TÜV SÜD Auftragsmanagement**, GWT mit **GXT 2** (Ext-GWT), obfuskiert → keine aufrufbaren Seitenfunktionen,
  Steuerung nur über DOM-Ereignisse (synthetische MouseEvents; Firefox: kein `view: window`).
- Erkennung: `script[src*="de.tomcom.tam.TAM"]`, Wurzel `#mainview.x-viewport`.
- Daten per GWT-RPC (`./gwt-rpc/auftrag…`, Anfrage `loadTeilauftraege` → Silent Reload).
- Kontoname „IB Thomée GmbH“ steht als Text oben rechts in der Kopfzeile.

## 2. Reiter
| Reiter | `li`-ID | Panel-ID |
|---|---|---|
| Information Cockpit | `x-auto-35__x-auto-36` | `x-auto-36` |
| Veröffentlichte Aufträge | `…__AgentVeroeffentlichteAuftraege` | `AgentVeroeffentlichteAuftraege` |
| Angenommene Aufträge | `…__AgentEigeneAuftraege` | `AgentEigeneAuftraege` |

- Präfix (`x-auto-35`) ist dynamisch → immer `li[id$="__<Panel-ID>"]`. Aktiv: `x-tab-strip-active` am `li`; inaktives Panel:
  `x-hide-display`. Das Panel „Angenommene Aufträge“ existiert erst, nachdem der Reiter einmal geöffnet wurde.
- Detailfenster haben eigene Reiterleisten (weitere `li.x-tab-strip-active` im Dokument) → nie „erstes aktives `li`“ nehmen.

## 3. Tabellen (GXT Grid)
- Kopf `.x-grid3-hd-row td` enthält **nur sichtbare** Spalten; Zeilen `.x-grid3-row` mit `td.x-grid3-cell` enthalten **alle**
  Spalten, ausgeblendete mit `style="display:none"`. Zuordnung immer über `x-grid3-td-<colId>`, nie per Index.
- **Veröffentlichte Aufträge** (sichtbar): `slaBeginnAgent` Starttermin (Agent) · `slaEndeAgent` Endtermin (Agent) ·
  `teilAuftragNr` AuftragsNr · `cst_projekt_dienstleistung_name` Dienstleistung · `referenz` · `status` · `termin` ·
  `besichtigungsStrasse` · `besichtigungsPlz` · `besichtigungsOrt` · `preis`.
- **Angenommene Aufträge** (sichtbar): `cst_status` Ampel · `neutral` · `slaEndeAgent` Endtermin (Agent) · Dienstleistung ·
  `referenz` · `referenz2` · `status` · `termin` · Straße/PLZ/Ort · `zeichenAgent` **Ihr Zeichen** · `reserviertBis`.
  **AuftragsNr (`teilAuftragNr`) steht als ausgeblendete Spalte in jeder Zeile** (29 Zellen je Zeile, u. a. `id`,
  `cst_projekt_name`, `vertragsNr`, `cst_verantwortlicher_agent`).
- Endtermin-Format: `TT.MM.JJJJ HH:MM`. AuftragsNr-Formate: `MW3191767`, `SA040647`, `1002667348`, `9601182381-10`.
- Blätterleiste: `.x-toolbar` mit „Einträge pro Seite“; Refresh = **5. Symbol-Button**. Beim Laden erscheint
  `.ext-el-mask` / `.x-mask-loading` im Panel. Leere Tabelle: „Keine Daten vorhanden“.

## 4. Fenster
- **Auftragskarte** (Doppelklick in „Veröffentlichte Aufträge“): Titel „Auftragskarte zu MW…“; Warenkorb
  (`.x-view-item` + `input.x-view-item-checkbox`, Kopf-Checkbox „alle auswählen“ im `.x-panel-header`), „Aufträge in der
  Umgebung“ (`.zusatzteilauftrag` mit `.entfernung`), Buttons Weitere Aufträge finden · Annehmen · Ablehnen · Schließen.
  *Noch kein Live-Mitschnitt – Aufbau laut Beobachtung; bei der nächsten Gelegenheit mitschneiden (Abschnitt 6).*
- **Auftragsannahme bestätigen**: Checkbox `input.x-form-checkbox` (Bedingungen), Buttons Bestätigen (erst gesperrt,
  `x-item-disabled`) · Abbrechen.
- **Detailansicht** „Auftrag MW…“ (Doppelklick in „Angenommene Aufträge“, oder statt der Karte, wenn der Auftrag schon
  vergeben ist): Reiter Basisdaten · Auftragsdokumente · Zugewiesene Dokumente · Ergebnisdokumente · Bemerkungen; Button
  Schließen. Enthält Kundendaten.
- **Kontextmenü** (Rechtsklick auf Zeile in „Angenommene Aufträge“): `.x-menu` mit `.x-menu-item`: Statusumschaltung ·
  Ansehen · Bearbeiten (gesperrt) · **Ihr Zeichen bearbeiten**. Statusumschaltung/Ansehen sind im Script gesperrt
  (`NEVER_CLICK`).
- **Ihr Zeichen bearbeiten**: Fenster mit Projekt, Dienstleistung, „Auftrag: MW…“, Textfeld `input.x-form-text` (bisheriges
  Zeichen, z. B. „PM Okt 07 10 T“), Buttons Speichern · Abbrechen.
- **Terminvereinbarung** nach der Annahme (z. B. Sixt): wird vom Script in den 30 s nach einer eigenen Annahme weggeklickt.
- Meldungen („bereits vergeben“, „nicht verfügbar“, „falscher Status“) erscheinen als `.x-window`, teils als
  `.x-info`/`.x-tip`.

## 5. Listen (Excel in SharePoint, anonyme Freigabelinks)
- Blatt **„annehmen“** (Ortsliste), **„nicht annehmen“** (Sperrliste PLZ/Ort), **„nicht annehmen Adresse“** (PLZ | Straße).
  Neu geladen alle 30 min.

## 6. Mitschnitte für die Testumgebung
Ablage nur lokal in `test/fixtures/` (per `.gitignore` ausgeschlossen – enthält echte Daten). Befehl in der
Browser-Konsole (F12) auf tam.tuvsud.com; lädt `tam-<Reiter>-<Zeit>.html` herunter (ohne Bedienfeld und `<script>`,
höchstens 5 Zeilen je Tabelle, Eingabewerte bleiben erhalten). Für Menüs/Dialoge, die beim Wechsel in die Konsole
zugehen: den Befehl in `setTimeout(() => { … }, 5000)` einpacken und in den 5 s das Menü öffnen.
```js
(()=>{const r=document.body.cloneNode(true);r.querySelectorAll('#tamauto,script,iframe,noscript').forEach(e=>e.remove());r.querySelectorAll('.x-grid3-body').forEach(b=>[...b.querySelectorAll('.x-grid3-row')].slice(5).forEach(x=>x.remove()));r.querySelectorAll('input,textarea').forEach(i=>{if(/checkbox|radio/.test(i.type)){if(i.checked)i.setAttribute('checked','')}else if(i.tagName==='TEXTAREA')i.textContent=i.value;else i.setAttribute('value',i.value)});const t=(document.querySelector('li.x-tab-strip-active[id*="__Agent"]')||{id:'tam'}).id.split('__').pop(),h=`<!-- TAM-Snapshot ${new Date().toISOString()} · ${t} · ${innerWidth}x${innerHeight} -->\n`+r.outerHTML,a=document.createElement('a');a.href=URL.createObjectURL(new Blob([h],{type:'text/html'}));a.download=`tam-${t}-${Date.now()}.html`;a.click()})()
```
Vorhandene Mitschnitte (Dateinamen in `test/fixtures/`): `veroeffentlicht-leer`, `angenommen`, `angenommen-detail`,
`angenommen-kontextmenue`, `angenommen-kurzzeichen`. Noch gesucht: Auftragskarte, Bestätigungsdialog, Terminvereinbarung.

## 7. Tests
- `npm run test:fast` – reine Logik (Zeichen, Listenantwort, Marktgebiete, Mail), unter 1 s; beim Entwickeln.
- `npm test` – alles, ca. 25 s: das echte Script läuft in jsdom auf den Mitschnitten (`test/harness.js` bildet Reiterwechsel,
  Auftragskarte, Refresh, ntfy usw. nach). Ohne Mitschnitte werden diese Tests übersprungen.
- Die Tests mit dem Script stehen in `test/mock-1.test.js` … `mock-8.test.js`, damit Node sie **parallel** ausführt. Eine einzelne große
  Datei läuft nacheinander und wird mit jedem Test langsamer. Neue Tests in die Datei mit der geringsten Laufzeit legen
  (Dauer je Datei: `npm test`, Zeile „duration_ms“ bzw. die Zeiten der obersten `describe`-Blöcke) – nicht in die längste.
