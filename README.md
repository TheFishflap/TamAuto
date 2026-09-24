# TAM Auto-Annahme (IB Thomée GmbH)

Tampermonkey-Userscript für das **TÜV SÜD Auftragsmanagement (TAM)**. Es prüft den Tab
**„[Meine Aufträge] Veröffentlichte Aufträge“** regelmäßig und nimmt Aufträge automatisch an,
deren **PLZ oder Ort** in der Ortsliste der IB Thomée GmbH steht.

<p align="center">
  <a href="https://raw.githubusercontent.com/TheFishflap/TamAuto/main/tam-auto-annahme.user.js">
    <img src="https://img.shields.io/badge/%E2%AC%87%20Script%20installieren-TAM%20Auto--Annahme-2e7d32?style=for-the-badge" alt="Script installieren">
  </a>
</p>

## Installation

### Schritt 1 – Tampermonkey installieren (einmalig)

Tampermonkey ist eine Browser-Erweiterung, die das Script im TAM ausführt. Link für den eigenen Browser öffnen
und dort auf **„Hinzufügen“** bzw. **„Zu Firefox hinzufügen“** klicken:

| Browser | Download |
|---|---|
| **Firefox** | [Tampermonkey für Firefox](https://addons.mozilla.org/de/firefox/addon/tampermonkey/) |
| **Chrome** | [Tampermonkey für Chrome](https://chromewebstore.google.com/detail/tampermonkey/dhdgffkkebhmkfjojejmpbldmpobfkfo) |
| **Edge** | [Tampermonkey für Edge](https://microsoftedge.microsoft.com/addons/detail/tampermonkey/iikmkjjbdkfcflbeekkhoceijjpeceki) |

> **Nur Chrome / Edge:** Nach der Installation in der Erweiterungsverwaltung (`chrome://extensions` bzw.
> `edge://extensions`) bei Tampermonkey auf **Details** gehen und **„Nutzerskripts zulassen“** einschalten
> (bei älteren Versionen oben rechts den **Entwicklermodus** aktivieren). Sonst läuft das Script nicht.

### Schritt 2 – Script installieren

1. Auf den grünen Button **[⬇ Script installieren](https://raw.githubusercontent.com/TheFishflap/TamAuto/main/tam-auto-annahme.user.js)**
   klicken (auch ganz oben auf dieser Seite).
2. Tampermonkey öffnet eine Seite mit den Script-Infos. Dort auf **„Installieren“** klicken:

   ![Tampermonkey: auf Installieren klicken](docs/img/tampermonkey-installieren.png)

   *Ist das Script schon installiert, heißt der Button „Neu installieren“ bzw. „Aktualisieren“.*
3. TAM neu laden (Taste **F5**). Unten rechts erscheint das Bedienfeld **„TAM Auto-Annahme“**.

Ein GitHub-Konto ist **nicht** nötig. Updates kommen danach automatisch (siehe unten).

> Empfehlung: In Tampermonkey unter *Einstellungen → Userscript-Updates* „Updates prüfen“
> auf **täglich** stellen. Zusätzlich prüft das Script selbst alle 6 Stunden auf GitHub.

## Automatische Updates

- Tampermonkey aktualisiert über `@updateURL` / `@downloadURL` (Raw-Datei im Branch `main`).
- Das Bedienfeld zeigt **„⬆ Update x.y.z verfügbar – installieren“**, sobald auf GitHub eine
  neuere `@version` liegt. Button **„Update prüfen“** prüft sofort.
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
| **Diagnose** | Zeigt Tab-Erkennung, gelesene Zeilen, Spalten, Ortsliste im Protokoll |
| **Update prüfen** | Sucht auf GitHub nach einer neuen Version |
| **Auftrag 1. Zeile annehmen** | Nimmt den obersten Auftrag **einmal verbindlich** an (mit Rückfrage, ohne Ortsliste) |

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
9. Nach erfolgreicher Annahme wird **sofort** wieder in den Reiter **Veröffentlichte Aufträge** gewechselt.

## Sicherheit

- Start immer im **Testmodus**; Live-Modus nur mit zusätzlicher Bestätigung.
- Max. **3 Annahmen pro Durchlauf**; jeder Auftrag wird nur **einmal** versucht.
- Abbruch, wenn Tab gewechselt, Tabelle neu geladen oder die falsche Auftragskarte geöffnet wurde.
- **Hinweis:** Das Script bestätigt die hinterlegten Auftragsbedingungen (TAM-Auftragsbedingungen,
  Kundenstandards) automatisch und verbindlich. Die Nutzungsbedingungen von TÜV SÜD / TAM zur
  automatisierten Nutzung sind vor dem Live-Betrieb zu prüfen.

## Entwicklung

- Struktur- und Debug-Infos zur TAM-Oberfläche: [docs/TAM-DEBUG.md](docs/TAM-DEBUG.md)
- Test mit nachgebauter TAM-Oberfläche (jsdom): `npm i jsdom@24 && node test/mock-tam.test.js`

## Changelog

### 1.0.3 – 2026-09-24
- Script-Name jetzt **„TAM Auto-Annahme (IB Thomée GmbH)“**.

### 1.0.2 – 2026-09-24
- Autor **IB Thomée GmbH** im Script-Kopf (statt „unbekannt“).
- Button **„Verlauf leeren“** entfernt.
- README: Download-Links für Tampermonkey, großer Installations-Button, Bildanleitung.

### 1.0.1 – 2026-09-24
- Button „1 Auftrag testen“ heißt jetzt **„Auftrag 1. Zeile annehmen“**.
- Nach erfolgreicher Annahme sofort automatisch zurück in den Reiter **Veröffentlichte Aufträge**.

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
