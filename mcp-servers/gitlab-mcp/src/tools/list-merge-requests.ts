import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "../tool-context.js";
import { jsonResult, withLogging } from "../tool-helpers.js";
import { projectApiIdentifier } from "../gitlab-client.js";

const TOOL_NAME = "list_merge_requests";

const inputShape = {
  project: z.string().min(1).describe("Projekt-ID oder vollständiger Pfad"),
  state: z.enum(["opened", "closed", "merged", "all"]).default("opened"),
};
const InputSchema = z.object(inputShape);
type Input = z.infer<typeof InputSchema>;

interface GitlabMergeRequest {
  iid: number;
  title: string;
  state: string;
  author: { username: string };
  source_branch: string;
  target_branch: string;
  web_url: string;
  updated_at: string;
}

export function registerListMergeRequests(server: McpServer, ctx: ToolContext): void {
  if (!ctx.permissions.isToolEnabled(TOOL_NAME)) {
    return;
  }

  server.registerTool(
    TOOL_NAME,
    {
      title: "GitLab-Merge-Requests auflisten",
      description: "Listet Merge Requests eines freigegebenen Projekts nach Status gefiltert auf.",
      inputSchema: inputShape,
    },
    withLogging(TOOL_NAME, async (args: Input) => {
      const project = ctx.permissions.assertProjectAllowed(args.project);
      const mrs = await ctx.gitlab.getJson<GitlabMergeRequest[]>(
        `/projects/${projectApiIdentifier(project)}/merge_requests`,
        { state: args.state, per_page: 100 },
      );

      return jsonResult(
        mrs.map((mr) => ({
          iid: mr.iid,
          title: mr.title,
          state: mr.state,
          author: mr.author.username,
          sourceBranch: mr.source_branch,
          targetBranch: mr.target_branch,
          updatedAt: mr.updated_at,
          webUrl: mr.web_url,
        })),
        ctx.limits.maxResponseBytes,
      );
    }),
  );
}
