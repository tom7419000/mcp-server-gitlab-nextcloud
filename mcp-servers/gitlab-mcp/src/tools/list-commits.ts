import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "../tool-context.js";
import { jsonResult, withLogging } from "../tool-helpers.js";
import { projectApiIdentifier } from "../gitlab-client.js";

const TOOL_NAME = "list_commits";

const inputShape = {
  project: z.string().min(1).describe("Projekt-ID oder vollständiger Pfad"),
  branch: z.string().min(1).describe("Branch- oder Tag-Name"),
  limit: z.number().int().positive().max(200).optional().describe("Max. Anzahl Commits (Default/Deckel per Server-Config)"),
};
const InputSchema = z.object(inputShape);
type Input = z.infer<typeof InputSchema>;

interface GitlabCommit {
  id: string;
  short_id: string;
  title: string;
  author_name: string;
  committed_date: string;
  web_url: string;
}

export function registerListCommits(server: McpServer, ctx: ToolContext): void {
  if (!ctx.permissions.isToolEnabled(TOOL_NAME)) {
    return;
  }

  server.registerTool(
    TOOL_NAME,
    {
      title: "GitLab-Commits auflisten",
      description: "Listet die letzten Commits eines Branches in einem freigegebenen Projekt auf.",
      inputSchema: inputShape,
    },
    withLogging(TOOL_NAME, async (args: Input) => {
      const project = ctx.permissions.assertBranchAllowed(args.project, args.branch);
      const perPage = Math.min(args.limit ?? ctx.limits.maxCommitsPerRequest, ctx.limits.maxCommitsPerRequest);

      const commits = await ctx.gitlab.getJson<GitlabCommit[]>(
        `/projects/${projectApiIdentifier(project)}/repository/commits`,
        { ref_name: args.branch, per_page: perPage },
      );

      return jsonResult(
        commits.map((c) => ({
          id: c.short_id,
          title: c.title,
          author: c.author_name,
          date: c.committed_date,
          webUrl: c.web_url,
        })),
        ctx.limits.maxResponseBytes,
      );
    }),
  );
}
