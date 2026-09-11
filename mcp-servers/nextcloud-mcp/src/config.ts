import { readFileSync } from "node:fs";
import { z } from "zod";

const PermissionsSchema = z.object({
  tools: z.record(z.string(), z.boolean()).default({}),
  paths: z.array(z.string().min(1).startsWith("/", { message: "Pfade müssen mit '/' beginnen" })).default([]),
  deckBoards: z.array(z.number().int().positive()).default([]),
  limits: z
    .object({
      maxResponseBytes: z.number().int().positive().default(500_000),
      requestTimeoutMs: z.number().int().positive().default(10_000),
    })
    .default({}),
});

export type PermissionsConfig = z.infer<typeof PermissionsSchema>;

export interface AppConfig {
  nextcloudUrl: string;
  nextcloudUser: string;
  nextcloudAppPassword: string;
  mcpAuthToken: string;
  port: number;
  permissions: PermissionsConfig;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === "") {
    throw new Error(`Fehlende Umgebungsvariable: ${name}`);
  }
  return value;
}

function loadPermissions(filePath: string): PermissionsConfig {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch (error) {
    throw new Error(
      `Permission-Config konnte nicht gelesen werden (${filePath}): ${(error as Error).message}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Permission-Config ist kein gültiges JSON (${filePath}): ${(error as Error).message}`);
  }

  const result = PermissionsSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`Permission-Config ist ungültig (${filePath}): ${result.error.message}`);
  }

  // Normalisiere konfigurierte Pfade einmalig, damit die Whitelist-Checks zur
  // Laufzeit nur noch normalisierte Strings vergleichen müssen.
  const normalizedPaths = result.data.paths.map((p) => p.replace(/\/+$/, "") || "/");
  return { ...result.data, paths: normalizedPaths };
}

export function loadConfig(): AppConfig {
  const nextcloudUrl = requireEnv("NEXTCLOUD_URL").replace(/\/+$/, "");
  const nextcloudUser = requireEnv("NEXTCLOUD_USER");
  const nextcloudAppPassword = requireEnv("NEXTCLOUD_APP_PASSWORD");
  const mcpAuthToken = requireEnv("NEXTCLOUD_MCP_AUTH_TOKEN");
  const port = Number(process.env.NEXTCLOUD_MCP_PORT ?? "3002");
  const permissionsFile = process.env.PERMISSIONS_FILE ?? "./permissions.json";

  if (!Number.isInteger(port) || port <= 0) {
    throw new Error(`Ungültiger Port in NEXTCLOUD_MCP_PORT: ${process.env.NEXTCLOUD_MCP_PORT}`);
  }

  const permissions = loadPermissions(permissionsFile);

  return { nextcloudUrl, nextcloudUser, nextcloudAppPassword, mcpAuthToken, port, permissions };
}
