import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "../tool-context.js";
import { jsonResult, withLogging } from "../tool-helpers.js";
import { projectApiIdentifier } from "../gitlab-client.js";

const TOOL_NAME = "list_projects";

interface GitlabProject {
  id: number;
  path_with_namespace: string;
  description: string | null;
  default_branch: string | null;
  web_url: string;
}

export function registerListProjects(server: McpServer, ctx: ToolContext): void {
  if (!ctx.permissions.isToolEnabled(TOOL_NAME)) {
    return;
  }

  server.registerTool(
    TOOL_NAME,
    {
      title: "GitLab-Projekte auflisten",
      description:
        "Listet die für diesen MCP-Server freigegebenen GitLab-Projekte auf. Im Wildcard-Modus " +
        "(projects: \"*\") sind das alle Projekte, bei denen der Token-Owner Mitglied ist; sonst nur " +
        "die explizit in der Permission-Config whitelisteten Projekte.",
      inputSchema: {},
    },
    withLogging<Record<string, never>>(TOOL_NAME, async () => {
      if (ctx.permissions.isWildcardProjects()) {
        const projects = await ctx.gitlab.getJson<GitlabProject[]>("/projects", {
          membership: "true",
          simple: "true",
          per_page: 100,
        });
        const details = projects.map((data) => ({
          id: data.id,
          path: data.path_with_namespace,
          description: data.description,
          defaultBranch: data.default_branch,
          webUrl: data.web_url,
          allowedBranches: null,
        }));
        if (details.length === 100) {
          return jsonResult(
            { projects: details, note: "Ggf. weitere Projekte vorhanden (Ergebnis bei 100 Treffern gedeckelt)." },
            ctx.limits.maxResponseBytes,
          );
        }
        return jsonResult({ projects: details }, ctx.limits.maxResponseBytes);
      }

      const configuredProjects = ctx.permissions.listConfiguredProjects();
      const details = await Promise.all(
        configuredProjects.map(async (project) => {
          try {
            const data = await ctx.gitlab.getJson<GitlabProject>(`/projects/${projectApiIdentifier(project)}`);
            return {
              id: data.id,
              path: data.path_with_namespace,
              description: data.description,
              defaultBranch: data.default_branch,
              webUrl: data.web_url,
              allowedBranches: project.branches,
            };
          } catch {
            return {
              id: project.id,
              path: project.path,
              error: "Projekt konnte nicht von GitLab geladen werden.",
              allowedBranches: project.branches,
            };
          }
        }),
      );
      return jsonResult(details, ctx.limits.maxResponseBytes);
    }),
  );
}
