# TAM Auto-Annahme (IB Thomée)

Tampermonkey-Userscript für das **TÜV SÜD Auftragsmanagement (TAM)**. Es prüft den Tab
**„[Meine Aufträge] Veröffentlichte Aufträge“** regelmäßig und nimmt Aufträge automatisch an,
deren **PLZ oder Ort** in der Ortsliste der IB Thomée GmbH steht.

## Installation

1. Browser-Erweiterung **Tampermonkey** installieren (Firefox / Chrome / Edge).
2. Installationslink öffnen – Tampermonkey zeigt den Installationsdialog:
   [tam-auto-annahme.user.js](https://raw.githubusercontent.com/TheFishflap/TamAuto/main/tam-auto-annahme.user.js)
3. **Installieren** klicken, TAM neu laden. Unten rechts erscheint das Bedienfeld.

> Empfehlung: In Tampermonkey unter *Einstellungen → Userscript-Updates* „Updates prüfen“
> auf **täglich** stellen. Zusätzlich prüft das Script selbst alle 6 Stunden auf GitHub.

## Automatische Updates

- Tampermonkey aktualisiert über `@updateURL` / `@downloadURL` (Raw-Datei im Branch `main`).
- Das Bedienfeld zeigt **„⬆ Update x.y.z verfügbar – installieren“**, sobald auf GitHub eine
  neuere `@version` liegt. Button **„Update prüfen“** prüft sofort.
- Voraussetzung: Das Repository ist **öffentlich** (Raw-Dateien privater Repos sind ohne Token
  nicht abrufbar).
- Neue Version veröffentlichen: `@version` im Script erhöhen, Changelog ergänzen, nach `main` pushen.

## Bedienfeld

| Element | Funktion |
|---|---|
| **Start / Stop** | Automatische Prüfung und Annahme ein/aus |
| **Testmodus** | Nur melden („[TEST] würde annehmen“), nichts annehmen |
| **Auto-Refresh** | Klickt alle *x* Sekunden den Refresh-Pfeil der Tabelle (unabhängig von Start/Stop) |
| **alle … s** | Intervall für Prüfung und Refresh (Standard 30 s, min. 15 s) |
| **Ortsliste laden** | Lädt die Ortsliste aus Google Sheets (automatisch, wenn älter als 6 h) |
| **Liste einfügen** | Ortsliste manuell einfügen (`PLZ;Ort` je Zeile oder CSV mit Kopfzeile) |
| **Verlauf leeren** | Vergisst bereits bearbeitete Aufträge |
| **Diagnose** | Zeigt Tab-Erkennung, gelesene Zeilen, Spalten, Ortsliste im Protokoll |
| **Update prüfen** | Sucht auf GitHub nach einer neuen Version |
| **1 Auftrag testen** | Nimmt den obersten Auftrag **einmal verbindlich** an (mit Rückfrage, ohne Ortsliste) |

## Ablauf einer Annahme

1. Nur wenn der Tab **Veröffentlichte Aufträge** aktiv ist (feste TAM-ID `AgentVeroeffentlichteAuftraege`).
2. Spalten werden über ihre Spalten-ID erkannt – Reihenfolge und ausgeblendete Spalten sind egal.
   Pflicht: Spalten **PLZ** und **Ort** vorhanden, PLZ 5-stellig.
3. Treffer, wenn PLZ **oder** Ort in der Ortsliste steht.
4. Doppelklick auf den Auftrag → **Auftragskarte zu MW…** (Titel wird gegen die AuftragsNr geprüft).
5. Aufträge unter **„Aufträge in der Umgebung“ mit 0 km** je einmal anklicken (→ Warenkorb).
6. Danach **„Warenkorb – alle auswählen“** anhaken.
7. **Annehmen** → Dialog **„Auftragsannahme bestätigen“** → Haken „Ja, hiermit bestätige ich die
   Bedingungen …“ → **Bestätigen**.
8. Fehlermeldungen von TAM werden im Protokoll angezeigt, die Auftragskarte wird geschlossen.

## Sicherheit

- Start immer im **Testmodus**; Live-Modus nur mit zusätzlicher Bestätigung.
- Max. **3 Annahmen pro Durchlauf**; jeder Auftrag wird nur **einmal** versucht.
- Abbruch, wenn Tab gewechselt, Tabelle neu geladen oder die falsche Auftragskarte geöffnet wurde.
- **Hinweis:** Das Script bestätigt die hinterlegten Auftragsbedingungen (TAM-Auftragsbedingungen,
  Kundenstandards) automatisch und verbindlich. Die Nutzungsbedingungen von TÜV SÜD / TAM zur
  automatisierten Nutzung sind vor dem Live-Betrieb zu prüfen.

## Changelog

### 1.0.0 – 2026-09-24
- Erstes Release.
- Auto-Update über GitHub (`@updateURL`/`@downloadURL`), Update-Hinweis im Bedienfeld,
  Button „Update prüfen“, Versionsanzeige im Titel.

### 0.10.1
- Button **„1 Auftrag testen“**: oberster Auftrag einmal verbindlich annehmen (mit Rückfrage).

### 0.10.0
- Checkbox **Auto-Refresh** (unabhängig von Start/Stop) mit Anzeige „Letzter Refresh ✓/✗“.
- Warenkorb: erst 0-km-Aufträge anklicken, danach **„alle auswählen“**; Prüfung, dass alles angehakt ist.

### 0.9.0
- Annahme-Ablauf auf den echten Aufbau der Auftragskarte umgestellt
  (Warenkorb-Checkboxen, „Aufträge in der Umgebung“ mit Entfernungsfeld, Bestätigungsdialog).
- Refresh über den Refresh-Pfeil der Blätterleiste mit Warten auf die Lade-Maske;
  Standard-Intervall 30 s.
- Fehlerhinweise von TAM („Sie müssen den Auftrag noch auswählen“) im Protokoll.

### 0.8.0
- Sofortige Prüfung bei jeder Tabellenänderung (MutationObserver).

### 0.7.0 / 0.7.1
- Spaltenzuordnung über GXT-Spalten-IDs statt Position (ausgeblendete/umsortierte Spalten).
- Pflichtprüfung PLZ/Ort, Plausibilitätscheck PLZ.
- Tab-Erkennung über feste TAM-ID; Doppelklick auf sichtbare Zelle.

### 0.6.0
- Ausführliches Protokoll (Entscheidung je Auftrag), Button **Diagnose**.

### 0.5.0
- Firefox-Fix (MouseEvent ohne `view`).
- Treffer bei PLZ **oder** Ort.
- 0-km-Aufträge aus „Aufträge in der Umgebung“ werden mit angenommen.

### 0.4.0
- Annahme über die Auftragskarte inkl. Bestätigung der Auftragsbedingungen.

### 0.3.0
- Annahme nur im Tab „Veröffentlichte Aufträge“ (mehrfache Prüfung).

### 0.2.0
- Annahme per Doppelklick → Auftragsfenster → Statusumschaltung.

### 0.1.0
- Erste Version: Bedienfeld, Testmodus, Ortsliste aus Google Sheets, Polling der Tabelle.
