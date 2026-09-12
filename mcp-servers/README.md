# gitlab-mcp + nextcloud-mcp

Zwei unabhängige, **read-only** MCP-Server für Claude Code (und andere MCP-Clients), die auf
einem Raspberry Pi (ARM64) via Docker laufen:

- **gitlab-mcp**: lesender Zugriff auf eine selbst gehostete GitLab CE (Free) Instanz
- **nextcloud-mcp**: lesender Zugriff auf Nextcloud-Dateien (WebDAV) und Nextcloud Deck

Beide Server sind komplett unabhängig (eigenes `package.json`, eigener Build, eigener
Prozess/Container) und teilen keinen Code. Schreibende Zugriffe sind nicht implementiert und
auf HTTP-Client-Ebene strukturell blockiert (siehe [Sicherheitsmodell](#sicherheitsmodell)).

## Architektur

```
Claude Code ──HTTPS──▶ nginx (TLS, bestehend) ──HTTP──▶ 127.0.0.1:3001 gitlab-mcp ──HTTPS──▶ GitLab CE
                                              └────────▶ 127.0.0.1:3002 nextcloud-mcp ──HTTPS──▶ Nextcloud (WebDAV + Deck)
```

Die Container binden nur an `127.0.0.1` - ohne den nginx-Reverse-Proxy sind sie vom LAN aus
nicht erreichbar. Zusätzlich verlangt jeder MCP-Server einen eigenen Bearer-Token
(`Authorization: Bearer ...`), unabhängig von den GitLab-/Nextcloud-Credentials.

## Sicherheitsmodell

1. **Tool-Whitelist**: Nur in `permissions.json` unter `tools` auf `true` gesetzte Tools werden
   beim MCP-Handshake überhaupt registriert - nicht freigegebene Tools existieren für den Client
   nicht.
2. **Scope-Whitelist**: gitlab-mcp erlaubt nur konfigurierte Projekte (optional mit
   Branch-Whitelist), nextcloud-mcp nur konfigurierte Pfade und Deck-Board-IDs.
3. **Path-Traversal-Schutz**: Pfade werden normalisiert und mit einem Prefix-Match samt
   Grenzzeichen-Check gegen die Whitelist geprüft (`/Foo` matched nicht versehentlich `/FooBar`).
4. **Hard-Guard auf HTTP-Client-Ebene**: `gitlab-client.ts`, `webdav-client.ts` und
   `deck-client.ts` exportieren ausschließlich GET/PROPFIND-Funktionen - es gibt keine
   generische `request(method, ...)`-Funktion, über die ein Tool (fehlerhaft oder kompromittiert)
   einen Schreibzugriff auslösen könnte.
5. **Eigenes Auth-Token pro MCP-Server**: schützt den HTTP/SSE-Endpunkt selbst, unabhängig von
   den GitLab-/Nextcloud-Credentials.
6. **Generische Fehlermeldungen**: Bei verweigerter Berechtigung bekommt der Client nur
   `"Zugriff auf diese Ressource ist durch die Server-Konfiguration nicht erlaubt."` - interne
   Pfade/IDs landen ausschließlich im strukturierten Server-Log.

## Setup

### 1. Voraussetzungen

- Docker + Docker Compose V2 (`docker compose ...`) auf dem Raspberry Pi
- Ein bereits laufender nginx (oder anderer Reverse Proxy) mit TLS-Terminierung
- Node.js 20+ nur für lokale Entwicklung nötig, nicht für den Docker-Betrieb

### 2. Repository vorbereiten

```bash
cd mcp-servers
cp .env.example .env
cp gitlab-mcp/permissions.example.json gitlab-mcp/permissions.json
cp nextcloud-mcp/permissions.example.json nextcloud-mcp/permissions.json
```

`.env` und beide `permissions.json` sind in `.gitignore` und werden nie committet.

### 3. GitLab Personal Access Token erstellen

1. In GitLab: Avatar (oben rechts) → **Edit profile** → **Access Tokens**
2. Name vergeben, **Scopes**: `read_api` und `read_repository` ankreuzen (keine weiteren!)
3. Token erzeugen und in `.env` als `GITLAB_TOKEN` eintragen

### 4. Nextcloud App-Passwort erstellen

1. In Nextcloud: **Einstellungen** → **Sicherheit** → Abschnitt **App-Passwörter erstellen**
2. Namen vergeben (z.B. `mcp-reader`), Passwort erzeugen
3. In `.env` als `NEXTCLOUD_APP_PASSWORD` eintragen (nicht das normale Login-Passwort!)
4. `NEXTCLOUD_USER` auf den Benutzernamen setzen, unter dem das App-Passwort erstellt wurde

Der verwendete Nextcloud-Benutzer sollte nur Zugriff auf die Ordner/Boards haben, die auch in
`permissions.json` freigegeben werden (zusätzliche Absicherung über Nextclouds eigene
Freigaben/Gruppen, nicht nur über diesen MCP-Server).

### 5. MCP-Auth-Token generieren

Für jeden Server ein eigenes, langes Zufalls-Secret erzeugen:

```bash
openssl rand -hex 32   # -> GITLAB_MCP_AUTH_TOKEN
openssl rand -hex 32   # -> NEXTCLOUD_MCP_AUTH_TOKEN
```

Beide Werte in `.env` eintragen.

### 6. Permission-Configs anpassen

`gitlab-mcp/permissions.json` und `nextcloud-mcp/permissions.json` auf die eigenen
Projekte/Pfade/Boards anpassen. Schema und Beispiele siehe [unten](#permission-config-schema).

### 7. Docker starten

```bash
docker compose up -d --build
docker compose ps
curl -s http://127.0.0.1:3001/health
curl -s http://127.0.0.1:3002/health
```

Beide sollten `{"status":"ok"}` liefern.

Falls die Images nicht direkt auf dem Pi gebaut werden, sondern auf einer x86-Maschine für den
Pi vorbereitet werden sollen:

```bash
docker buildx build --platform linux/arm64 -t gitlab-mcp:local ./gitlab-mcp --load
docker buildx build --platform linux/arm64 -t nextcloud-mcp:local ./nextcloud-mcp --load
```

### 8. nginx einbinden

Siehe [`nginx.snippet.conf`](./nginx.snippet.conf) - Location-Blöcke für beide Server inkl. der
für den Streamable-HTTP/SSE-Transport nötigen Timeout-/Buffering-Einstellungen in die bestehende
nginx-Config übernehmen und nginx neu laden (`nginx -s reload`).

### 9. In Claude Code eintragen

Angenommen, nginx terminiert unter `https://mcp.example.com` und leitet `/gitlab-mcp/` und
`/nextcloud-mcp/` gemäß `nginx.snippet.conf` weiter, ergibt sich die MCP-URL aus
`https://mcp.example.com/gitlab-mcp/mcp` (der Endpunkt `/mcp` kommt vom Server selbst dazu).

Per CLI:

```bash
claude mcp add --transport http gitlab https://mcp.example.com/gitlab-mcp/mcp \
  --header "Authorization: Bearer <GITLAB_MCP_AUTH_TOKEN>"

claude mcp add --transport http nextcloud https://mcp.example.com/nextcloud-mcp/mcp \
  --header "Authorization: Bearer <NEXTCLOUD_MCP_AUTH_TOKEN>"
```

Oder direkt in einer `.mcp.json`:

```json
{
  "mcpServers": {
    "gitlab": {
      "type": "http",
      "url": "https://mcp.example.com/gitlab-mcp/mcp",
      "headers": { "Authorization": "Bearer <GITLAB_MCP_AUTH_TOKEN>" }
    },
    "nextcloud": {
      "type": "http",
      "url": "https://mcp.example.com/nextcloud-mcp/mcp",
      "headers": { "Authorization": "Bearer <NEXTCLOUD_MCP_AUTH_TOKEN>" }
    }
  }
}
```

## Permission-Config-Schema

### gitlab-mcp

```json
{
  "tools": {
    "list_projects": true,
    "list_branches": true,
    "get_file": true,
    "list_commits": true,
    "list_merge_requests": true,
    "get_merge_request_diff": true,
    "search_code": true,
    "get_repo_tree": true
  },
  "projects": [
    { "id": 42, "path": "team/pizzagame", "branches": ["main", "develop"] },
    { "id": 17, "path": "team/infra", "branches": null }
  ],
  "limits": {
    "maxResponseBytes": 200000,
    "maxCommitsPerRequest": 50,
    "requestTimeoutMs": 10000
  }
}
```

- `tools.<name>` fehlt oder `false` ⇒ Tool wird nicht registriert.
- `projects[].branches: null` ⇒ alle Branches dieses Projekts erlaubt, sonst explizite Liste.
- Projekte können über `id` (numerisch) oder `path` (voller Namespace-Pfad) referenziert werden.

### nextcloud-mcp

```json
{
  "tools": {
    "list_files": true,
    "read_file": true,
    "search_files": true,
    "deck_list_boards": true,
    "deck_list_stacks": true,
    "deck_list_cards": true,
    "deck_get_card": true,
    "deck_search_cards": true
  },
  "paths": ["/Projekte/PizzaGame", "/Dokumentation"],
  "deckBoards": [3, 7],
  "limits": {
    "maxResponseBytes": 500000,
    "requestTimeoutMs": 10000
  }
}
```

- `paths` müssen mit `/` beginnen; Zugriff ist auf diese Pfade und alle Unterpfade beschränkt.
- `deckBoards` ist eine Liste erlaubter Board-IDs (Zahl, sichtbar in der Deck-URL).

## Wildcard-Scope (alle Projekte/Ordner/Boards)

Statt jedes Projekt/jeden Pfad/jedes Board einzeln einzutragen, kann `projects` (gitlab-mcp) bzw.
`paths`/`deckBoards` (nextcloud-mcp) auf das Literal `"*"` gesetzt werden. Die Zugriffsgrenze
verschiebt sich dann von `permissions.json` auf die vom jeweiligen Dienst selbst durchgesetzte
Sichtbarkeit - neue Projekte/Ordner/Boards sind ohne Config-Änderung sofort nutzbar, sobald sie
dort freigegeben werden:

- **gitlab-mcp**: `"projects": "*"` erlaubt alle Projekte, bei denen der Token-Owner **Mitglied**
  ist (`GET /projects?membership=true`), inkl. aller Branches. Empfehlung: einen eigenen
  GitLab-Benutzer/Token anlegen, der nur zu den gewünschten Projekten hinzugefügt wird - die
  Mitgliedschaft dort ist dann die eigentliche Access-Control.
- **nextcloud-mcp**: `"paths": "*"` erlaubt den kompletten für den App-Passwort-Benutzer
  sichtbaren Dateibaum, `"deckBoards": "*"` alle für ihn sichtbaren Deck-Boards. Die eigentliche
  Grenze ist dann, was diesem dedizierten Nextcloud-Benutzer freigegeben wurde (Datei-Freigaben
  bzw. Deck-Board-Mitgliedschaft) - genau das in der Frage beschriebene Setup mit einem eigenen
  Nextcloud-Benutzer.

Beide Felder sind unabhängig voneinander wählbar (z.B. `projects: "*"`, aber `paths` weiterhin
als explizite Liste). Der Path-Traversal-Schutz bei nextcloud-mcp bleibt auch im Wildcard-Modus
aktiv. Beispiel-Configs: [`gitlab-mcp/permissions.wildcard.example.json`](./gitlab-mcp/permissions.wildcard.example.json),
[`nextcloud-mcp/permissions.wildcard.example.json`](./nextcloud-mcp/permissions.wildcard.example.json).

```json
{ "projects": "*" }
```

```json
{ "paths": "*", "deckBoards": "*" }
```

## Token-Rotation

PAT (GitLab) und App-Passwort (Nextcloud) laufen irgendwann ab oder werden bewusst rotiert:

1. Neues Token/Passwort erzeugen (siehe oben)
2. In `.env` aktualisieren
3. `docker compose restart gitlab-mcp` bzw. `docker compose restart nextcloud-mcp`

Kein Rebuild nötig - Secrets stecken nie im Image, sondern werden nur zur Laufzeit über
`env_file` eingelesen. Ein abgelaufenes Token führt zu strukturierten `401`-Log-Einträgen statt
zu einem Absturz; der Healthcheck bleibt grün (der Prozess läuft ja), Tool-Aufrufe liefern aber
einen Fehler, bis das Token erneuert ist.

## Bekannte Einschränkungen

- **`search_code`**: Ohne Elasticsearch/Advanced Search (GitLab CE Free hat das nicht) ist die
  Projekt-Code-Suche auf den Default-Branch beschränkt und funktional eingeschränkter als mit
  Advanced Search.
- **Deck-API**: Antwortformate können sich zwischen Nextcloud-Minor-Versionen leicht
  unterscheiden; nextcloud-mcp parst defensiv (fehlende Felder werden zu `null`/`[]`, kein
  Absturz), aber sehr alte oder sehr neue Nextcloud-Versionen wurden nicht getestet.
- **`search_files`/`deck_search_cards`**: Es gibt keine native Volltextsuche über GET/PROPFIND
  bzw. die Deck-API; beide Tools laufen die freigegebenen Pfade/Boards clientseitig ab und sind
  auf eine begrenzte Anzahl Treffer/Knoten gedeckelt (Antwort enthält `truncated: true`, falls
  das Limit erreicht wurde).

## Entwicklung

```bash
cd gitlab-mcp   # oder nextcloud-mcp
npm install
npm run typecheck
npm run build
PERMISSIONS_FILE=./permissions.json npm start
```
