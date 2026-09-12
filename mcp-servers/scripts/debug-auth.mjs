#!/usr/bin/env node
// Eigenständiges Diagnose-Skript für gitlab-mcp / nextcloud-mcp Auth-Probleme.
//
// Testet die Nextcloud- und GitLab-Credentials direkt gegen die echten APIs -
// mit exakt demselben Auth-Header-Aufbau wie die MCP-Server selbst
// (webdav-client.ts, deck-client.ts, gitlab-client.ts) - damit ein Erfolg
// hier zuverlässig bedeutet, dass die Server-Container es auch schaffen.
//
// Nutzung (aus mcp-servers/ heraus, mit geladener .env):
//   node --env-file=.env scripts/debug-auth.mjs
// oder mit bereits exportierten Umgebungsvariablen:
//   node scripts/debug-auth.mjs
//
// Schreibt einen strukturierten Report nach scripts/debug-report.json
// (enthält keine Secrets, nur Status-Codes/Header/Body-Ausschnitte).

import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPORT_PATH = join(__dirname, "debug-report.json");
const BODY_SNIPPET_LIMIT = 500;

function requireEnv(name) {
  const value = process.env[name];
  if (!value || value.trim() === "") {
    return { ok: false, value: undefined, error: `Fehlende Umgebungsvariable: ${name}` };
  }
  return { ok: true, value };
}

async function bodySnippet(response) {
  try {
    const text = await response.text();
    return text.length > BODY_SNIPPET_LIMIT ? `${text.slice(0, BODY_SNIPPET_LIMIT)}…` : text;
  } catch {
    return null;
  }
}

function relevantHeaders(response) {
  const keys = ["www-authenticate", "content-type", "x-request-id"];
  const out = {};
  for (const key of keys) {
    const value = response.headers.get(key);
    if (value) out[key] = value;
  }
  return out;
}

/**
 * `fetch` verwirft den `Authorization`-Header bei einem Redirect auf einen
 * anderen Origin (Standardverhalten, kein Bug). Wird die Anfrage z.B. durch
 * einen vorgeschalteten Reverse-Proxy (http→https, non-www→www) umgeleitet,
 * kommt sie am eigentlichen Ziel ohne Header an - das ergibt exakt dieselbe
 * 401-Fehlermeldung wie ein falsches Passwort. Diese Funktion macht das
 * sichtbar, statt es zu verschweigen.
 */
const SLOW_RESPONSE_THRESHOLD_MS = 1500;

/** Wraps fetch to measure round-trip time - needed to spot bruteforce throttling below. */
async function timedFetch(url, options) {
  const start = Date.now();
  const response = await fetch(url, options);
  return { response, durationMs: Date.now() - start };
}

/**
 * Nextclouds Bruteforce-Schutz verzögert Antworten auf wiederholte Fehlversuche derselben
 * IP/User-Kombination bewusst (wachsender Delay), bevor er denselben generischen 401 liefert wie
 * ein echter Credential-Fehler - für den Client nicht zu unterscheiden außer über die Latenz. Eine
 * sofortige 401-Antwort ist dagegen ein normaler Auth-Fehler.
 */
function latencyWarning(status, durationMs) {
  if (status !== 401 || durationMs < SLOW_RESPONSE_THRESHOLD_MS) {
    return null;
  }
  return (
    `Ungewöhnlich langsame 401-Antwort (${durationMs}ms) - Hinweis auf serverseitiges ` +
    "Bruteforce-Throttling statt eines echten Credential-Fehlers, wenn genug Fehlversuche von " +
    "dieser IP/diesem Benutzer vorausgingen. IP-Bann serverseitig prüfen/zurücksetzen statt " +
    "weiter am Passwort zu zweifeln."
  );
}

function redirectWarning(response, requestedUrl) {
  if (!response.redirected) {
    return null;
  }
  const requestedOrigin = new URL(requestedUrl).origin;
  const finalOrigin = new URL(response.url).origin;
  if (finalOrigin !== requestedOrigin) {
    return (
      `Redirect erkannt: ${requestedOrigin} -> ${finalOrigin}. Der Authorization-Header wird von ` +
      "fetch bei einem Origin-Wechsel verworfen - das kann allein die 401-Antwort erklären, unabhängig " +
      "davon ob die Credentials korrekt sind. NEXTCLOUD_URL in .env auf die Ziel-Origin korrigieren."
    );
  }
  return `Redirect erkannt (gleicher Origin, unkritisch): ${requestedUrl} -> ${response.url}.`;
}

async function runCheck(name, fn) {
  console.log(`\n=== ${name} ===`);
  try {
    const result = await fn();
    console.log(`  Status: ${result.status}${result.durationMs !== undefined ? ` (${result.durationMs}ms)` : ""}`);
    console.log(`  Diagnose: ${result.diagnosis}`);
    if (result.detail) console.log(`  Detail: ${result.detail}`);
    return { name, ...result };
  } catch (error) {
    console.log(`  Fehler: ${error.message}`);
    return { name, ok: false, status: null, diagnosis: error.message };
  }
}

async function checkNextcloudWebdav(url, user, appPassword) {
  const authHeader = `Basic ${Buffer.from(`${user}:${appPassword}`).toString("base64")}`;
  const davUrl = `${url.replace(/\/+$/, "")}/remote.php/dav/files/${encodeURIComponent(user)}/`;
  const { response, durationMs } = await timedFetch(davUrl, {
    method: "PROPFIND",
    headers: { Authorization: authHeader, Depth: "0", "Content-Type": "application/xml; charset=utf-8" },
    body: `<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:displayname/></d:prop></d:propfind>`,
  });
  const ok = response.status === 207 || response.ok;
  const redirect = redirectWarning(response, davUrl);
  const latency = latencyWarning(response.status, durationMs);
  return {
    ok,
    status: response.status,
    durationMs,
    headers: relevantHeaders(response),
    redirect,
    detail: ok ? null : await bodySnippet(response),
    diagnosis: ok
      ? "WebDAV-Login funktioniert - Basisauthentifizierung (Benutzer + App-Passwort) ist gültig."
      : response.status === 401
        ? "401: Benutzername/App-Passwort werden von Nextcloud abgelehnt (falsch, abgelaufen oder widerrufen)." +
          (redirect ? " ACHTUNG: " + redirect : "") +
          (latency ? " ACHTUNG: " + latency : "")
        : `Unerwarteter Status ${response.status} - siehe Detail.`,
  };
}

async function checkNextcloudDeck(url, user, appPassword) {
  const authHeader = `Basic ${Buffer.from(`${user}:${appPassword}`).toString("base64")}`;
  const deckUrl = `${url.replace(/\/+$/, "")}/index.php/apps/deck/api/v1.0/boards`;
  const { response, durationMs } = await timedFetch(deckUrl, {
    method: "GET",
    headers: { Authorization: authHeader, "OCS-APIRequest": "true", Accept: "application/json" },
  });
  const ok = response.ok;
  const redirect = redirectWarning(response, deckUrl);
  const latency = latencyWarning(response.status, durationMs);
  let boardCount = null;
  if (ok) {
    try {
      const json = await response.clone().json();
      boardCount = Array.isArray(json) ? json.length : null;
    } catch {
      // ignore parse errors, still report status
    }
  }
  return {
    ok,
    status: response.status,
    durationMs,
    headers: relevantHeaders(response),
    redirect,
    detail: ok ? (boardCount !== null ? `${boardCount} Board(s) sichtbar` : null) : await bodySnippet(response),
    diagnosis: ok
      ? "Deck-API-Login funktioniert."
      : response.status === 401
        ? "401: Gleiche Credentials wie WebDAV, aber Deck lehnt ab - vergleiche mit dem WebDAV-Check oben. " +
          "Beide 401 ⇒ Credential generell ungültig. Nur Deck 401 ⇒ Deck-spezifisches Problem " +
          "(App evtl. deaktiviert, oder Nextcloud-App-Passwort mit eingeschränkten App-Scopes)." +
          (redirect ? " ACHTUNG: " + redirect : "") +
          (latency ? " ACHTUNG: " + latency : "")
        : response.status === 404
          ? "404: Deck-App ist auf dieser Nextcloud-Instanz vermutlich nicht installiert/aktiviert."
          : `Unerwarteter Status ${response.status} - siehe Detail.`,
  };
}

async function checkGitlabToken(url, token) {
  const { response, durationMs } = await timedFetch(`${url.replace(/\/+$/, "")}/api/v4/user`, {
    headers: { "PRIVATE-TOKEN": token, Accept: "application/json" },
  });
  const ok = response.ok;
  const latency = latencyWarning(response.status, durationMs);
  let username = null;
  if (ok) {
    try {
      const json = await response.clone().json();
      username = json.username ?? null;
    } catch {
      // ignore
    }
  }
  return {
    ok,
    status: response.status,
    durationMs,
    headers: relevantHeaders(response),
    detail: ok ? (username ? `Token gehört zu Benutzer: ${username}` : null) : await bodySnippet(response),
    diagnosis: ok
      ? "GitLab-Token ist gültig."
      : response.status === 401
        ? "401: Token ungültig, abgelaufen oder widerrufen." + (latency ? " ACHTUNG: " + latency : "")
        : `Unerwarteter Status ${response.status} - siehe Detail.`,
  };
}

async function checkGitlabProjects(url, token) {
  const { response, durationMs } = await timedFetch(
    `${url.replace(/\/+$/, "")}/api/v4/projects?membership=true&per_page=100&simple=true`,
    { headers: { "PRIVATE-TOKEN": token, Accept: "application/json" } },
  );
  const ok = response.ok;
  let projects = [];
  if (ok) {
    try {
      const json = await response.clone().json();
      projects = Array.isArray(json)
        ? json.map((p) => ({ id: p.id, path: p.path_with_namespace }))
        : [];
    } catch {
      // ignore
    }
  }
  return {
    ok,
    status: response.status,
    durationMs,
    headers: relevantHeaders(response),
    projects,
    detail: ok
      ? `${projects.length} Projekt(e) mit Mitgliedschaft gefunden - vollständige Liste im Report.`
      : await bodySnippet(response),
    diagnosis: ok
      ? projects.length === 0
        ? "Token ist gültig, ist aber bei KEINEM Projekt Mitglied - GitLab-Projekt-Mitgliedschaft prüfen."
        : "Vergleiche 'path' unten mit dem in permissions.json bzw. im Tool-Aufruf genutzten Pfad."
      : `Unerwarteter Status ${response.status} - siehe Detail (fehlende 'read_api'-Scope möglich).`,
  };
}

/**
 * Klassisches Copy-Paste-Artefakt: ein Wert wurde mit einem führenden/
 * nachgestellten Whitespace oder einem \r (Windows-Zeilenumbruch) in .env
 * eingefügt. Für Basic-Auth ist "app-password " ein anderes Passwort als
 * "app-password" - das ergibt dieselbe 401-Antwort wie ein echter Tippfehler,
 * ist aber unsichtbar beim bloßen Ansehen der Datei. Der Wert selbst wird nie
 * geloggt, nur seine Länge und ob er "sauber" ist.
 */
function hygieneWarning(name, rawValue) {
  if (rawValue === undefined) return null;
  const hasCr = rawValue.includes("\r");
  const trimmed = rawValue.trim();
  if (!hasCr && trimmed === rawValue) {
    return null;
  }
  return (
    `${name}: Rohwert (${rawValue.length} Zeichen) unterscheidet sich vom getrimmten Wert ` +
    `(${trimmed.length} Zeichen)${hasCr ? " und enthält ein \\r (Windows-Zeilenumbruch)" : ""} - ` +
    "vermutlich ein Copy-Paste-Artefakt in .env. Wert dort ohne führende/nachgestellte Whitespaces neu eintragen."
  );
}

async function main() {
  const nextcloudUrl = requireEnv("NEXTCLOUD_URL");
  const nextcloudUser = requireEnv("NEXTCLOUD_USER");
  const nextcloudAppPassword = requireEnv("NEXTCLOUD_APP_PASSWORD");
  const gitlabUrl = requireEnv("GITLAB_URL");
  const gitlabToken = requireEnv("GITLAB_TOKEN");

  const missing = [nextcloudUrl, nextcloudUser, nextcloudAppPassword, gitlabUrl, gitlabToken].filter(
    (v) => !v.ok,
  );
  if (missing.length > 0) {
    for (const m of missing) console.error(m.error);
    console.error(
      "\nBitte mit geladener .env starten, z.B.: node --env-file=.env scripts/debug-auth.mjs (aus mcp-servers/)",
    );
    process.exit(1);
  }

  const hygieneWarnings = [
    hygieneWarning("NEXTCLOUD_USER", nextcloudUser.value),
    hygieneWarning("NEXTCLOUD_APP_PASSWORD", nextcloudAppPassword.value),
    hygieneWarning("GITLAB_TOKEN", gitlabToken.value),
  ].filter(Boolean);
  if (hygieneWarnings.length > 0) {
    console.log("\n=== Werte-Hygiene ===");
    for (const warning of hygieneWarnings) {
      console.log(`  ACHTUNG: ${warning}`);
    }
  }

  const results = [];
  results.push(
    await runCheck("Nextcloud WebDAV (Basis-Login)", () =>
      checkNextcloudWebdav(nextcloudUrl.value, nextcloudUser.value, nextcloudAppPassword.value),
    ),
  );
  results.push(
    await runCheck("Nextcloud Deck API", () =>
      checkNextcloudDeck(nextcloudUrl.value, nextcloudUser.value, nextcloudAppPassword.value),
    ),
  );
  results.push(await runCheck("GitLab Token (/api/v4/user)", () => checkGitlabToken(gitlabUrl.value, gitlabToken.value)));
  results.push(
    await runCheck("GitLab Projekt-Mitgliedschaft (/api/v4/projects?membership=true)", () =>
      checkGitlabProjects(gitlabUrl.value, gitlabToken.value),
    ),
  );

  const report = {
    generatedAt: new Date().toISOString(),
    hygieneWarnings,
    checks: results,
  };
  await writeFile(REPORT_PATH, JSON.stringify(report, null, 2), "utf8");
  console.log(`\nReport geschrieben nach: ${REPORT_PATH}`);

  const allOk = results.every((r) => r.ok);
  if (!allOk) {
    console.log("\nMindestens ein Check ist fehlgeschlagen - siehe Diagnose-Hinweise oben.");
    process.exit(1);
  }
  console.log("\nAlle Checks erfolgreich.");
}

main();
