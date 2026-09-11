import { readFileSync } from "node:fs";
import { z } from "zod";

const ProjectPermissionSchema = z
  .object({
    id: z.number().int().positive().optional(),
    path: z.string().min(1).optional(),
    branches: z.array(z.string().min(1)).nullable().default(null),
  })
  .refine((project) => project.id !== undefined || project.path !== undefined, {
    message: "Jeder Eintrag unter 'projects' braucht mindestens 'id' oder 'path'.",
  });

const PermissionsSchema = z.object({
  tools: z.record(z.string(), z.boolean()).default({}),
  projects: z.array(ProjectPermissionSchema).default([]),
  limits: z
    .object({
      maxResponseBytes: z.number().int().positive().default(200_000),
      maxCommitsPerRequest: z.number().int().positive().default(50),
      requestTimeoutMs: z.number().int().positive().default(10_000),
    })
    .default({}),
});

export type PermissionsConfig = z.infer<typeof PermissionsSchema>;
export type ProjectPermission = z.infer<typeof ProjectPermissionSchema>;

export interface AppConfig {
  gitlabUrl: string;
  gitlabToken: string;
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
  return result.data;
}

export function loadConfig(): AppConfig {
  const gitlabUrl = requireEnv("GITLAB_URL").replace(/\/+$/, "");
  const gitlabToken = requireEnv("GITLAB_TOKEN");
  const mcpAuthToken = requireEnv("GITLAB_MCP_AUTH_TOKEN");
  const port = Number(process.env.GITLAB_MCP_PORT ?? "3001");
  const permissionsFile = process.env.PERMISSIONS_FILE ?? "./permissions.json";

  if (!Number.isInteger(port) || port <= 0) {
    throw new Error(`Ungültiger Port in GITLAB_MCP_PORT: ${process.env.GITLAB_MCP_PORT}`);
  }

  const permissions = loadPermissions(permissionsFile);

  return { gitlabUrl, gitlabToken, mcpAuthToken, port, permissions };
}
