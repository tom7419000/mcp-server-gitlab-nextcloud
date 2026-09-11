import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "../tool-context.js";
import { jsonResult, withLogging } from "../tool-helpers.js";
import { projectApiIdentifier } from "../gitlab-client.js";

const TOOL_NAME = "list_branches";

const inputShape = {
  project: z.string().min(1).describe("Projekt-ID (numerisch) oder vollständiger Pfad (z.B. team/pizzagame)"),
};
const InputSchema = z.object(inputShape);
type Input = z.infer<typeof InputSchema>;

interface GitlabBranch {
  name: string;
  merged: boolean;
  protected: boolean;
  default: boolean;
  commit: { id: string; short_id: string; title: string; committed_date: string };
}

export function registerListBranches(server: McpServer, ctx: ToolContext): void {
  if (!ctx.permissions.isToolEnabled(TOOL_NAME)) {
    return;
  }

  server.registerTool(
    TOOL_NAME,
    {
      title: "GitLab-Branches auflisten",
      description: "Listet die Branches eines freigegebenen GitLab-Projekts auf.",
      inputSchema: inputShape,
    },
    withLogging(TOOL_NAME, async (args: Input) => {
      const project = ctx.permissions.assertProjectAllowed(args.project);
      const branches = await ctx.gitlab.getJson<GitlabBranch[]>(
        `/projects/${projectApiIdentifier(project)}/repository/branches`,
        { per_page: 100 },
      );

      const visible =
        project.branches === null ? branches : branches.filter((branch) => project.branches!.includes(branch.name));

      return jsonResult(
        visible.map((b) => ({
          name: b.name,
          default: b.default,
          protected: b.protected,
          merged: b.merged,
          lastCommit: { id: b.commit.short_id, title: b.commit.title, date: b.commit.committed_date },
        })),
        ctx.limits.maxResponseBytes,
      );
    }),
  );
}
