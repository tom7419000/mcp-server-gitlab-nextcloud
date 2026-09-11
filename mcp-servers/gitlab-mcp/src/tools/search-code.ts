import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "../tool-context.js";
import { jsonResult, withLogging } from "../tool-helpers.js";
import { projectApiIdentifier } from "../gitlab-client.js";

const TOOL_NAME = "search_code";

const inputShape = {
  project: z.string().min(1).describe("Projekt-ID oder vollständiger Pfad"),
  query: z.string().min(1).describe("Suchbegriff"),
};
const InputSchema = z.object(inputShape);
type Input = z.infer<typeof InputSchema>;

interface GitlabBlobResult {
  path: string;
  ref: string;
  startline: number;
  data: string;
}

export function registerSearchCode(server: McpServer, ctx: ToolContext): void {
  if (!ctx.permissions.isToolEnabled(TOOL_NAME)) {
    return;
  }

  server.registerTool(
    TOOL_NAME,
    {
      title: "Code in GitLab-Projekt durchsuchen",
      description:
        "Durchsucht den Code eines freigegebenen Projekts (scope=blobs). Ohne Elasticsearch/Advanced Search auf " +
        "GitLab CE ist die Suche auf den Default-Branch beschränkt und funktional eingeschränkt.",
      inputSchema: inputShape,
    },
    withLogging(TOOL_NAME, async (args: Input) => {
      const project = ctx.permissions.assertProjectAllowed(args.project);
      const results = await ctx.gitlab.getJson<GitlabBlobResult[]>(
        `/projects/${projectApiIdentifier(project)}/search`,
        { scope: "blobs", search: args.query, per_page: 50 },
      );

      return jsonResult(
        results.map((r) => ({ path: r.path, ref: r.ref, startLine: r.startline, snippet: r.data })),
        ctx.limits.maxResponseBytes,
      );
    }),
  );
}
