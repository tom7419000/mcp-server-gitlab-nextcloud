import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "../tool-context.js";
import { jsonResult, withLogging } from "../tool-helpers.js";
import { projectApiIdentifier } from "../gitlab-client.js";

const TOOL_NAME = "get_repo_tree";

const inputShape = {
  project: z.string().min(1).describe("Projekt-ID oder vollständiger Pfad"),
  branch: z.string().min(1).describe("Branch- oder Tag-Name"),
  path: z.string().optional().describe("Unterordner im Repository (leer = Repo-Root)"),
};
const InputSchema = z.object(inputShape);
type Input = z.infer<typeof InputSchema>;

interface GitlabTreeEntry {
  id: string;
  name: string;
  type: "tree" | "blob";
  path: string;
}

export function registerGetRepoTree(server: McpServer, ctx: ToolContext): void {
  if (!ctx.permissions.isToolEnabled(TOOL_NAME)) {
    return;
  }

  server.registerTool(
    TOOL_NAME,
    {
      title: "GitLab-Repository-Baum lesen",
      description: "Listet Dateien/Ordner eines freigegebenen Projekts/Branches an einem Pfad auf (nicht rekursiv).",
      inputSchema: inputShape,
    },
    withLogging(TOOL_NAME, async (args: Input) => {
      const project = ctx.permissions.assertBranchAllowed(args.project, args.branch);
      const entries = await ctx.gitlab.getJson<GitlabTreeEntry[]>(
        `/projects/${projectApiIdentifier(project)}/repository/tree`,
        { ref: args.branch, path: args.path, per_page: 200 },
      );

      return jsonResult(
        entries.map((e) => ({ name: e.name, path: e.path, type: e.type })),
        ctx.limits.maxResponseBytes,
      );
    }),
  );
}
