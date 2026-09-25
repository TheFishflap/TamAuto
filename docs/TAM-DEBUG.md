# TAM – Debug- & Strukturinfos für die Weiterentwicklung

Stand: 24.09.2026 · Script-Version 1.0.0 · ermittelt per DOM-Auszügen aus dem Live-TAM (Firefox + Tampermonkey).
Kundendaten sind hier bewusst weggelassen.

## 1. Technik der Seite

- **TAM – TÜV SÜD Auftragsmanagement**, GWT-Anwendung mit **GXT 2** (Ext-GWT), Theme `x-theme-blue`.
- Erkennung im Userscript: `script[src*="de.tomcom.tam.TAM"]` (lädt `de.tomcom.tam.TAM.nocache.js`).
- Wurzel: `#mainview.x-viewport`.
- Daten kommen per **GWT-RPC** (`./gwt-rpc/...`). JS ist obfuskiert → **keine** aufrufbaren Seitenfunktionen
  (z. B. kein `refresh()`); Steuerung nur über DOM-Events.
- Eigene Autoaktualisierung von TAM: Konsole zeigt `scheduling autorefreshing timer in 59.96 seconds`
  (Checkbox „Automatisch alle [1] Minuten aktualisieren“ in der Blätterleiste, min. 1 Minute).
- **Firefox + Tampermonkey:** `new MouseEvent(type, { view: window })` wirft
  `'view' member of UIEventInit does not implement interface Window` → `view` weglassen.
- Synthetische Events bewegen **nicht** den echten Mauszeiger (erwartet).

## 2. Tabs

| Tab | Reiter-`li`-ID | Panel-ID |
|---|---|---|
| Information Cockpit | `x-auto-35__x-auto-36` | `x-auto-36` (dynamisch!) |
| [Meine Aufträge] Veröffentlichte Aufträge | `x-auto-35__AgentVeroeffentlichteAuftraege` | **`AgentVeroeffentlichteAuftraege`** |
| [Meine Aufträge] Angenommene Aufträge | `x-auto-35__AgentEigeneAuftraege` | **`AgentEigeneAuftraege`** |

- Aktiver Reiter: Klasse `x-tab-strip-active` am `li`.
- Inaktives Panel: Klasse `x-hide-display` (am Panel selbst).
- Präfix `x-auto-35` ist dynamisch → immer mit `li[id$="__AgentVeroeffentlichteAuftraege"]` suchen.
- **Bewährte Prüfung** (funktioniert live):
  ```js
  const li = document.querySelector('li[id$="__AgentVeroeffentlichteAuftraege"]');
  const panel = document.getElementById('AgentVeroeffentlichteAuftraege');
  li?.classList.contains('x-tab-strip-active') && panel && !panel.closest('.x-hide-display');
  ```
- ❌ Nicht funktioniert: erstes `li.x-tab-strip-active` im Dokument nehmen + `offsetParent`-Sichtbarkeit.

## 3. Auftragstabelle (GXT Grid)

- Pro Tab ein `.x-grid3` im Panel; zusätzlich ein verstecktes Grid im Information Cockpit (Status/SLA-Summen).
- Kopf: `.x-grid3-hd-row td` – **nur sichtbare Spalten**.
- Zeilen: `.x-grid3-row`, Zellen `td.x-grid3-cell` – **enthalten auch alle ausgeblendeten Spalten**
  (z. B. 11 sichtbare Köpfe, aber 22 Zellen je Zeile; die ersten Zellen sind versteckt).
  → **Niemals per Index zuordnen.**
- Zuordnung über Spalten-ID-Klasse `x-grid3-td-<colId>` (Kopf-`td` und Zell-`td` tragen dieselbe).
- Spalten-IDs „Veröffentlichte Aufträge“ (live ermittelt):

  | Überschrift | colId |
  |---|---|
  | AuftragsNr | `teilAuftragNr` |
  | Dienstleistung | `cst_projekt_dienstleistung_name` |
  | Referenz | `referenz` |
  | Status | `status` |
  | Straße | `besichtigungsStrasse` |
  | PLZ | `besichtigungsPlz` |
  | Ort | `besichtigungsOrt` |
  | Preis | `preis` |
  | weitere sichtbar: Starttermin (Agent), Endtermin (Agent), Termin | – |

- Spaltenreihenfolge kann sich täglich ändern; **PLZ und Ort sind immer vorhanden** (Pflichtcheck).
- AuftragsNr-Formate: `MW3191767` oder rein numerisch `1002667348` (VTI).
- Leere Tabelle: Text „Keine Daten vorhanden“ in der Blätterleiste.
- Angenommene Aufträge: andere Spalten (Ampel, Neutral, Referenz 2, Ihr Zeichen, Reserviert bis), **keine** AuftragsNr-Spalte.

### Blätterleiste (unten im Panel)
`|<  <  Seite [1] von 1  >  >|  ⟳  ☑ Automatisch alle [1] Minuten aktualisieren  [500] Einträge pro Seite`
- Refresh-Pfeil = **5. Symbol-Button ohne Text** (`.x-btn`) in der `.x-toolbar`, die „Einträge pro Seite“ enthält.
- ❌ Früherer Fehler: `findButton(/aktualisier/)` traf die Leiste/Checkbox „…Minuten aktualisieren“.
- Live noch **nicht bestätigt**, ob der 5. Symbol-Button wirklich der Refresh ist → Script meldet
  „Refresh funktioniert ✓“ bzw. „ohne Wirkung ✗“.

## 4. Auftragskarte (nach Doppelklick auf eine Zeile)

- Fenster `.x-window`, Titel (`.x-window-header-text`): **„Auftragskarte zu MW…“**
- Links **Warenkorb** (GXT CheckBoxListView):
  - Kopf-Checkbox „alle auswählen“: `input.x-view-item-checkbox` im `.x-panel-header` mit Text „Warenkorb“
    (liegt **nicht** in `.x-view-item`).
  - Einträge: `div.x-view-item.x-view-item-check` mit `input.x-view-item-checkbox` + AuftragsNr als Text.
  - Beim Öffnen ist der eigene Auftrag **nicht** angehakt → ohne Haken meldet TAM
    „**Sie müssen den Auftrag noch auswählen.**“ (Tooltip unten rechts).
  - Unten „Summe  150,75 €“.
- Links unten **Aufträge in der Umgebung** (`x-view`):
  - Eintrag: `div.zusatzteilauftrag` → `div.entfernung` („5 km“) + AuftragsNr + Dienstleistung.
  - Einfacher Klick auf einen Eintrag legt ihn in den Warenkorb (laut Nutzer, noch nicht live verifiziert).
  - AuftragsNr hier auch 8-stellig (z. B. `19443184`).
- Rechts Reiter: Basisdaten · Auftragsdokumente · Bemerkungen.
- Buttons unten (`.x-btn`, Text im inneren `<button>`):
  „Weitere Aufträge finden“ · **„Annehmen“** · „Ablehnen“ · „Schließen“.
  Im Reiter Auftragsdokumente zusätzlich „Öffnen“ (disabled) und „ZIP-File download“.
- Gesperrte Buttons: Klasse `x-item-disabled`.

**Gewünschte Reihenfolge (Vorgabe Nutzer):** erst alle 0-km-Einträge je 1× anklicken,
**danach** „Warenkorb – alle auswählen“ anhaken, dann Annehmen.

## 5. Dialog „Auftragsannahme bestätigen“

- Zweites `.x-window`, Titel „Auftragsannahme bestätigen“.
- Text: „Um den gewählten Auftrag anzunehmen, müssen Sie die hinterlegten Auftragsbedingungen bestätigen …“
- Checkbox: `div.x-form-check-wrap` → `input.x-form-checkbox`
  („Ja, hiermit bestätige ich die Bedingungen zur Durchführung dieses Auftrages.“)
- Buttons „Bestätigen“ (anfangs `x-item-disabled`, nach Haken aktiv) und „Abbrechen“.
- Erscheint **einmal** für alle angehakten Warenkorb-Aufträge.

## 6. Veralteter Klickpfad (nur Angenommene Aufträge)

Doppelklick in „Angenommene Aufträge“ öffnet „Auftrag MW…“ mit Menü **Statusumschaltung**:
Bearbeiten · Abschließen · Systemwechsel · Anbieten · Problem mit Auftrag melden. → für die Annahme **nicht** relevant.

## 7. Ortsliste

- Google Sheet `1VTkQpt7AFA_mzrG6Bpw0yrzoVcJhrSzh`, gid `1524429178`, Export per
  `https://docs.google.com/spreadsheets/d/<id>/export?format=csv&gid=<gid>` (mit Google-Login im Browser).
- Ergebnis live: **1 PLZ / 115 Orte** → die „1 PLZ“ ist vermutlich ein Ausreißer; Aufbau des Sheets
  (Spalten/Reiter) noch **nicht geklärt**. Abgleich: PLZ **oder** Ort (normalisiert, ä→ae usw.).

## 8. Offene Punkte / nicht live verifiziert

1. Refresh-Button (5. Symbol) – Anzeige ✓/✗ im Bedienfeld prüfen.
2. Warenkorb-Checkbox per `input.click()` → reagiert GXT wie beim echten Klick?
3. 0-km-Eintrag per Einzelklick → erscheint er im Warenkorb?
4. Buttons per `mouseover/mousedown/mouseup/click` auf inneres `<button>` – Annehmen/Bestätigen live testen
   (Button „1 Auftrag testen“ im Bedienfeld).
5. Erfolgs-/Fehlermeldungen nach „Bestätigen“ (Texte unbekannt; Script sucht nach
   `fehler|error|nicht möglich|bereits|vergeben`).
6. Ortsliste: Sheet-Aufbau klären (1 PLZ).
7. Auto-Update braucht **öffentliches** Repo (`raw.githubusercontent.com`).

## 9. Hilfs-Snippets (Browser-Konsole, F12)

Tab-Status:
```js
(() => { const id='AgentVeroeffentlichteAuftraege', p=document.getElementById(id), h=p&&p.closest('.x-hide-display');
copy(JSON.stringify({ reiter:[...document.querySelectorAll(`li[id$="__${id}"]`)].map(l=>l.id+' | '+l.className),
panelKlasse:p&&p.className, verstecktDurch:h?h.id:null,
aktiveReiter:[...document.querySelectorAll('li.x-tab-strip-active')].map(l=>l.id) },null,1)); })();
```

Offene Fenster (Auftragskarte / Dialog):
```js
(() => { const t=e=>e.textContent.replace(/\s+/g,' ').trim(), v=e=>e.offsetParent!==null, c=e=>String(e.className).slice(0,80);
copy(JSON.stringify([...document.querySelectorAll('.x-window')].filter(v).map(w=>({
 titel:t(w.querySelector('.x-window-header-text')||w).slice(0,60),
 buttons:[...w.querySelectorAll('.x-btn')].filter(v).map(b=>({text:t(b),cls:c(b)})),
 checkboxen:[...w.querySelectorAll('input[type=checkbox]')].filter(v).map(i=>({cls:c(i),an:i.checked,zeile:t(i.closest('.x-view-item,.x-panel-header,.x-form-check-wrap')||i.parentElement).slice(0,30)})),
 umgebung:[...w.querySelectorAll('.zusatzteilauftrag')].map(z=>t(z).slice(0,40)) })),null,1)); })();
```

Tabellen-Spalten und erste Zeile (per Spalten-ID):
```js
(() => { const p=document.getElementById('AgentVeroeffentlichteAuftraege'), g=[...p.querySelectorAll('.x-grid3')].find(x=>x.offsetParent);
const hd=[...g.querySelectorAll('.x-grid3-hd-row td')].map(td=>({n:td.textContent.trim(),id:(td.className.match(/x-grid3-td-(\S+)/)||[])[1]}));
const r=g.querySelector('.x-grid3-row');
copy(JSON.stringify(hd.map(h=>({...h,wert:r?(r.querySelector('td.x-grid3-td-'+h.id)||{}).textContent?.trim().slice(0,15):null})),null,1)); })();
```

Meldung „bereits vergeben“ / „nicht verfügbar“ – Aufbau erfassen (ausführen, **während die Meldung offen ist**;
Ergebnis liegt danach in der Zwischenablage). Alternativ: Console Log einschalten – das Script schreibt beim
Schließen solcher Meldungen den Aufbau („Aufbau: …“) selbst ins Log.
```js
copy([...document.querySelectorAll('div')].filter(e => /vergeben|verfügbar/i.test(e.textContent) && e.offsetParent && e.children.length < 15).slice(-3).map(e => e.className + ' | ' + e.textContent.trim().slice(0, 80)).join('\n'))
```

## 10. Testumgebung

`test/mock-tam.test.js` baut die TAM-Struktur mit jsdom nach (Tab, Grid mit versteckten Spalten,
Blätterleiste, Auftragskarte mit Warenkorb/Umgebung, Bestätigungsdialog) und prüft den kompletten
Annahme-Ablauf: `npm i jsdom@24 && node test/mock-tam.test.js`
