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

### Schritt 3 – Lizenz aktivieren

Ohne Lizenz zeigt das Bedienfeld nur **„Lizenz erforderlich“** und eine **Installations-ID**
(z. B. `ABCD-EFGH-JKLM-NPQR`) – das Script nimmt dann nichts an.

1. Installations-ID mit **„Kopieren“** kopieren und an die IB Thomée GmbH schicken.
2. Den erhaltenen Lizenzschlüssel (beginnt mit `TAM1.`) einfügen und **„Aktivieren“** klicken.

Die Lizenz gilt nur für diese eine Installation und **bis zum 31.12. des laufenden Jahres**.
Ab 30 Tagen vor Ablauf erscheint ein roter Hinweis; danach ist eine neue Lizenz nötig.
Wird Tampermonkey neu installiert oder werden seine Daten gelöscht, entsteht eine neue ID.

> Empfehlung: In Tampermonkey unter *Einstellungen → Userscript-Updates* „Updates prüfen“
> auf **täglich** stellen. Zusätzlich prüft das Script selbst alle 6 Stunden auf GitHub.

## Automatische Updates

- Tampermonkey aktualisiert über `@updateURL` / `@downloadURL` (Raw-Datei im Branch `main`).
- Das Bedienfeld zeigt **„⬆ Update x.y.z verfügbar – installieren“**, sobald auf GitHub eine
  neuere `@version` liegt. Button **„Softwareupdate“** prüft sofort.
- Neue Version veröffentlichen: `@version` im Script erhöhen, Changelog ergänzen, nach `main` pushen.

## Bedienfeld

| Element | Funktion |
|---|---|
| **Tab-Anzeige** | Aktiver Reiter und Bereitschaft: **Veröffentlichte Aufträge – ✔ bereit zum Annehmen** (grün), **Angenommene Aufträge – ⏸ Annahme pausiert** (orange), sonst pausiert |
| **Start / Stop** | Automatische Prüfung und **verbindliche** Annahme ein/aus |
| **Auto-Refresh** | Klickt alle *x* Sekunden den Refresh-Pfeil der Tabelle (unabhängig von Start/Stop) |
| **alle … s** | Intervall für Refresh und Abgleich (Standard 30 s, min. 15 s) |
| **Ortslisten laden** | Lädt **beide** Listen neu: Ortsliste (Blatt „annehmen“) und Sperrliste (Blatt „nicht annehmen“) aus dem Excel in SharePoint – ohne Anmeldung; Ergebnis im Log; automatisch alle 30 min |
| **Liste einfügen** | Ortsliste manuell einfügen (`PLZ;Ort` je Zeile oder CSV mit Kopfzeile) |
| **Softwareupdate** | Sucht auf GitHub nach einer neuen Version |
| **Auftrag 1. Zeile annehmen** | Nimmt den obersten Auftrag **einmal verbindlich** an (mit Rückfrage, ohne Ortsliste) |

### Reiter „Erweiterte Einstellungen“ – Tages-Blacklist

PLZ eintragen, die **heute nicht** angenommen werden sollen – z. B. nach einem Storno, damit der Auftrag
nicht erneut angenommen wird. Gleiche Logik wie in der Ortsliste: `44` sperrt alle 44xxx, `47877` nur diese PLZ.
Die Liste leert sich **automatisch um Mitternacht**. Freigeben: auf den roten Eintrag klicken oder
„Alle freigeben“. Solange etwas gesperrt ist, zeigt der Reiter die Anzahl an („1 gesperrt“).
Gesperrte Treffer stehen im Protokoll („Treffer, aber gesperrt: … → nicht angenommen“).

**Sperrliste aus Excel:** Zusätzlich gilt das Blatt **„nicht annehmen“** derselben Excel-Datei
(gleiche Spalten und PLZ-Logik wie „annehmen“). Einträge dort gelten, **solange sie im Excel stehen**
(nicht nur heute). Das Excel wird alle 30 min neu geladen, sofort per **„Neu laden“**. Die Einträge
werden im Reiter angezeigt (braun), ändern nur im Excel. Fehlt das Blatt, ist die Sperrliste leer –
das Blatt „annehmen“ wird nie als Sperrliste verwendet.

**Verzögerung** (ebenfalls in „Erweiterte Einstellungen“): Checkbox + Slider **0,0–2,0 s** in 0,1-s-Schritten.
Vor jedem Klickschritt der Annahme (Doppelklick, 0-km-Aufträge, alle auswählen, Annehmen, Haken, Bestätigen)
wird die eingestellte Zeit gewartet. Mit **Randomizer** kommt bei jedem Schritt zufällig **0 bis x ms** dazu
(Standard **180 ms**, einstellbar), bei jedem Schritt neu gewürfelt.

**Console Log** (ebenfalls in „Erweiterte Einstellungen“, Standard **aus**): blendet das Protokoll des Scripts
unten im Bedienfeld ein/aus. Das Script schreibt nichts in die Browser-Konsole.

### Reiter „Auftragsbuch“

Liste aller vom Script angenommenen Aufträge (Datum, AuftragsNr, PLZ, Ort, Euro – Dienstleistung als Tooltip),
Zeitraum wählbar (Heute / letzte 7 Tage / dieser Monat / alle). Unten: **Anzahl Aufträge, Anzahl PLZ,
Summe gesamt in Euro** sowie Aufträge je PLZ. 0-km-Aufträge aus der Umgebung stehen mit drin, haben aber
keinen Preis (steht nicht in der Tabelle). „Liste leeren“ löscht das Auftragsbuch (mit Rückfrage).
Das Auftragsbuch wird nur in diesem Browser gespeichert.

## Abgleich und Protokoll

Bei jedem Refresh der Tabelle wird die Liste neu mit der Ortsliste abgeglichen; passende Aufträge
werden sofort angenommen. Das gilt für den Auto-Refresh des Scripts, die TAM-eigene Aktualisierung
und einen manuellen Klick auf den Refresh-Pfeil. Jeder Abgleich steht mit Anlass im Protokoll, z. B.:

```
10:15:30  Refresh → Abgleich: 12 Aufträge in Tabelle, 1 offen, 1 passend, 11 bereits bearbeitet
10:15:30  MW3191767 · 56218 Mülheim-Kärlich · … → TREFFER → wird angenommen
10:15:31  Nehme an: MW3191767 · 56218 Mülheim-Kärlich · …
10:15:36  Angenommen: MW3191767 · 56218 Mülheim-Kärlich · …
```

Anlässe: **Refresh** (Auto-Refresh des Scripts), **Tabelle aktualisiert** (TAM-Aktualisierung oder
manueller Refresh), **Reiterwechsel**, **Intervall** (Auto-Refresh aus), **Start**, **Nachprüfung**
(Tabelle hat sich während einer Annahme geändert).

## Ablauf einer Annahme

1. Nur wenn der Tab **Veröffentlichte Aufträge** aktiv ist (feste TAM-ID `AgentVeroeffentlichteAuftraege`).
2. Spalten werden über ihre Spalten-ID erkannt – Reihenfolge und ausgeblendete Spalten sind egal.
   Pflicht: Spalten **PLZ** und **Ort** vorhanden, PLZ 5-stellig.
3. Treffer, wenn die PLZ mit einem Eintrag der Ortsliste **beginnt** (siehe [Ortsliste](#ortsliste))
   und nicht auf der Tages-Blacklist steht.
4. Doppelklick auf den Auftrag → **Auftragskarte zu MW…** (Titel wird gegen die AuftragsNr geprüft).
5. Aufträge unter **„Aufträge in der Umgebung“ mit 0 km** je einmal anklicken (→ Warenkorb).
6. Danach **„Warenkorb – alle auswählen“** anhaken.
7. **Annehmen** → Dialog **„Auftragsannahme bestätigen“** → Haken „Ja, hiermit bestätige ich die
   Bedingungen …“ → **Bestätigen**.
8. Fehlermeldungen von TAM werden im Protokoll angezeigt, die Auftragskarte wird geschlossen.
9. Nach erfolgreicher Annahme wird **sofort** wieder in den Reiter **Veröffentlichte Aufträge** gewechselt.

## Sicherheit

- **Kein Testmodus, keine Rückfrage:** Nach **Start** werden passende Aufträge sofort verbindlich angenommen.
- Angenommen wird nur, wenn der Reiter **Veröffentlichte Aufträge** aktiv ist (siehe Tab-Anzeige).
- Max. **3 Annahmen pro Durchlauf**; jeder Auftrag wird nur **einmal** versucht.
- Abbruch, wenn Tab gewechselt, Tabelle neu geladen oder die falsche Auftragskarte geöffnet wurde.
- **Hinweis:** Das Script bestätigt die hinterlegten Auftragsbedingungen (TAM-Auftragsbedingungen,
  Kundenstandards) automatisch und verbindlich. Die Nutzungsbedingungen von TÜV SÜD / TAM zur
  automatisierten Nutzung sind vor dem Live-Betrieb zu prüfen.

## Entwicklung

- Struktur- und Debug-Infos zur TAM-Oberfläche: [docs/TAM-DEBUG.md](docs/TAM-DEBUG.md)
- Test mit nachgebauter TAM-Oberfläche (jsdom): `npm i jsdom@24 && node test/mock-tam.test.js`

## Ortsliste

- Quelle: Excel-Datei in SharePoint (Freigabe-Link, **keine Anmeldung** nötig), Blatt **„annehmen“**,
  Spalten **PLZ | Ort | SV**. Blatt **„nicht annehmen“** = Sperrliste (siehe oben). Neu laden alle 30 min.
- **PLZ-Logik:** mindestens 2, höchstens 5 Ziffern – der Eintrag ist der **Anfang** der PLZ.
  - `43` (oder `43***`) → alles, was mit 43 beginnt, also die ganze Umgebung.
  - `47877` → nur genau diese PLZ.
- Die Spalte **Ort** ist bei Zeilen mit PLZ nur zur Info. Nur Zeilen **ohne** PLZ werden über den
  Ortsnamen abgeglichen (normalisiert, ä→ae usw.).
- PLZ mit führender 0 in Excel als **Text** eintragen (sonst macht Excel aus `01` eine `1`;
  einstellige Werte werden automatisch zu `0x` ergänzt).

## Lizenz

© 2026 IB Thomée GmbH. Alle Rechte vorbehalten. Nutzung nur mit gültigem Lizenzschlüssel;
**Veränderung, Weitergabe und Vervielfältigung des Codes sind nicht gestattet.** Siehe [LICENSE](LICENSE).

## Changelog

### 1.6.0 – 2026-09-24
- **Lizenzschlüssel-Aktivierung:** Schlüssel pro Installation (Installations-ID), signiert von der
  IB Thomée GmbH, immer gültig bis 31.12. des laufenden Jahres. Ohne gültige Lizenz nimmt das Script nichts an.
- Lizenz: proprietär, IB Thomée GmbH – Veränderung und Weitergabe nicht gestattet (LICENSE).
- Verzögerung: Slider 0,0–2,0 s; Randomizer mit einstellbarem Bereich in ms (Standard 180 ms).
- Console Log standardmäßig aus.

### 1.5.1 – 2026-09-24
- Button **„Ortslisten laden“** lädt beide Listen (annehmen / nicht annehmen) ohne Cache neu und zeigt
  das Ergebnis immer im Log; Statuszeile zeigt auch die Anzahl der Sperrliste.

### 1.5.0 – 2026-09-24
- Neuer Reiter **Auftragsbuch**: alle angenommenen Aufträge, Anzahl PLZ, Summe gesamt in Euro.
- Sperrliste zusätzlich aus dem Excel-Blatt **„nicht annehmen“**; Excel wird alle 30 min neu geladen.
- Verzögerung: Slider in 0,1-s-Schritten (1,0–5,0 s), eigene Checkbox **Randomizer** (Streuung nicht im UI).
- **Console Log** statt Debug-Modus: blendet das Script-Protokoll ein/aus; keine Browser-Konsole mehr.

### 1.4.0 – 2026-09-24
- **Verzögerung** in „Erweiterte Einstellungen“: Checkbox + Slider 1–5 s, vor jedem Klickschritt der Annahme,
  plus zufällige Streuung 0,02–0,64 s (fest). Im Debug-Modus steht jede Verzögerung im Protokoll.

### 1.3.2 – 2026-09-24
- Konsolenausgaben nur noch mit Checkbox **Debug-Modus** (Reiter „Erweiterte Einstellungen“).
- Angenehmerer Hinweiston: sanfter Zwei-Ton-Gong statt Piepton.
- Button „Update prüfen“ heißt jetzt **„Softwareupdate“**.
- Auto-Refresh-Checkbox, Text und Intervall stehen auf einer Linie.

### 1.3.1 – 2026-09-24
- „Letzter Refresh“ wird auch bei Refresh von außen angezeigt – Klick auf den Refresh-Pfeil der Website
  („manuell“) oder TAM-Autoaktualisierung („TAM“) –, auch wenn das Script gestoppt ist.

### 1.3.0 – 2026-09-24
- **PLZ-Logik:** Einträge mit 2–5 Ziffern gelten als PLZ-Anfang (`43` → alle 43xxx, `47877` → nur diese).
  Ortsnamen zählen nur noch bei Listenzeilen ohne PLZ. Die Ortsliste wird nach dem Update einmal neu geladen.
- Neuer Reiter **„Erweiterte Einstellungen“** mit **Tages-Blacklist** für PLZ (z. B. nach Storno),
  leert sich um Mitternacht.

### 1.2.0 – 2026-09-24
- Ortsliste aus **SharePoint (Excel)** statt Google Sheets – keine Google-Anmeldung mehr nötig.
  Eine alte Google-Liste wird beim ersten Start automatisch ersetzt.
- **Tab-Anzeige** im Bedienfeld (Veröffentlichte / Angenommene Aufträge, Bereitschaft zum Annehmen);
  Tabwechsel stehen im Protokoll.
- Rückfrage beim Start entfernt.

### 1.1.0 – 2026-09-24
- **Testmodus entfernt** – nach Start wird immer verbindlich angenommen. Nach dem Update ist das
  Script einmalig gestoppt und muss neu gestartet werden.
- Button **Diagnose** entfernt.
- Jeder Refresh löst direkt einen Abgleich aus (Refresh und Abgleich laufen in einem Takt);
  jeder Abgleich wird mit Anlass im Protokoll geschrieben.

### 1.0.4 – 2026-09-24
- Fix: Tabellenänderungen während einer laufenden Prüfung/Annahme wurden verworfen – ein neuer
  Auftrag wurde dann erst beim nächsten Intervall (30 s) erkannt. Jetzt wird direkt danach erneut geprüft.

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
