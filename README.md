# derStandard Comment Ranker

Inoffizielle Browser-Erweiterung, mit der man die Postings im Forum von
[derStandard.at](https://www.derstandard.at) sortieren kann – und sehen,
wer ein Posting wie bewertet hat.

> Die Erweiterung ist ein privates Projekt und steht in keiner Verbindung
> zum STANDARD.

**Installieren:**
[Chrome Web Store](https://chromewebstore.google.com/detail/kcnlkimhnhlacphcnigicjkkbenhfkeb) ·
[Firefox Add-ons](https://addons.mozilla.org/firefox/addon/derstandard-comment-ranker/)
(auch Firefox für Android)

## Funktionen

- **Drei Sortierungen**, jeweils in beide Richtungen (nochmal klicken dreht um):
  - **Balance** – beste (oder schlechteste) Bilanz aus Plus und Minus zuerst;
    bei gleicher Bilanz die Postings mit mehr Stimmen
  - **Pure** – Postings mit möglichst wenig Gegenstimmen zuerst
    (oder umgekehrt: fast nur Minus)
  - **Timeline** – neueste oder älteste zuerst, auf die Minute genau
- **Lädt automatisch alle Postings** eines Forums, nicht nur die erste Seite
  (Fortschritt als kleiner Ring neben der Sortierleiste)
- **Wer hat wie bewertet:** Klick auf die Bewertung eines Postings zeigt alle
  Plus- und Minus-Stimmen
- **Antworten bleiben zugeklappt**, bis man sie öffnet – ohne dass die Seite
  springt
- Aufgeräumte Posting-Karten; gelöschte Postings ohne Antworten werden
  ausgeblendet; angeheftete Postings bleiben oben
- Glas-Look oder flaches Design (umschaltbar im Popup)

## Datenschutz und Berechtigungen

- Einzige Berechtigung: **„storage“** – für die gewählte Sortierung und
  Einstellungen im Browser.
- Läuft **nur auf derstandard.at und derstandard.de**.
- **Keine Datensammlung, kein Tracking, keine Werbung.** Die Erweiterung ruft
  nur Seiten von derStandard selbst auf (für die Liste der Bewertungen).
- Kein Login, keine Zugangsdaten.

Das lässt sich im Code nachprüfen; ein automatischer Test
(`tests/unit/manifest.test.js`) stellt außerdem sicher, dass nur
derStandard-Adressen angesprochen werden.

## Wie die Erweiterung entsteht

Ich bin kein Profi-Entwickler. Die Erweiterung entsteht mit KI-Unterstützung
(Claude von Anthropic) – das sieht man auch an den Commits. Damit sie
zuverlässig bleibt, wird sie umfassend automatisch getestet:

- über 370 Unit- und Integrationstests (Sortierung, Laden, Bewertungen,
  Antworten, Popup, …)
- Browser-Tests mit der echten Erweiterung in Chrome
  (inkl. Scroll-Stabilität und Performance bei großen Foren)
- ein Test gegen die echte derStandard-Seite, der anschlägt, wenn derStandard
  etwas am Forum umbaut
- Mozillas Prüfwerkzeug für Add-ons (`web-ext lint`)

Details: [tests/README.md](tests/README.md)

## Entwicklung

```bash
npm install
npm test              # Unit- und Integrationstests
npm run test:e2e      # Browser-Tests (Chromium)
npm run lint:firefox  # Mozilla-Prüfung
```

Zum Ausprobieren ohne Store: in Chrome unter `chrome://extensions` den
Entwicklermodus einschalten und „Entpackte Erweiterung laden“ → diesen Ordner
wählen. In Firefox unter `about:debugging` → „Temporäres Add-on laden“ →
`manifest.json` wählen.

Für die Stores werden nur die Erweiterungsdateien gepackt (`manifest.json`,
`*.js`, `popup.html`, `icons/`), nicht `tests/`, `node_modules/` usw.

## Feedback

Fehler und Ideen gern als [Issue](https://github.com/sruf79/derstandard-comment-ranker/issues)
oder über die Adresse im Popup der Erweiterung.

Wer Danke sagen will: [Buy me a coffee](https://buymeacoffee.com/diversion) ☕

## Lizenz

[MIT](LICENSE). Das Kaffee-Symbol stammt aus Noto Emoji (Apache-2.0), siehe
[icons/NOTICE.txt](icons/NOTICE.txt).
