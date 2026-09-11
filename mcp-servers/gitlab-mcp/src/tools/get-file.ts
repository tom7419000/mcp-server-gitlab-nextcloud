import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "../tool-context.js";
import { textResult, withLogging } from "../tool-helpers.js";
import { truncateText } from "../response-limits.js";
import { projectApiIdentifier } from "../gitlab-client.js";

const TOOL_NAME = "get_file";

const inputShape = {
  project: z.string().min(1).describe("Projekt-ID oder vollständiger Pfad"),
  branch: z.string().min(1).describe("Branch- oder Tag-Name"),
  path: z.string().min(1).describe("Pfad der Datei im Repository, relativ zum Repo-Root"),
};
const InputSchema = z.object(inputShape);
type Input = z.infer<typeof InputSchema>;

export function registerGetFile(server: McpServer, ctx: ToolContext): void {
  if (!ctx.permissions.isToolEnabled(TOOL_NAME)) {
    return;
  }

  server.registerTool(
    TOOL_NAME,
    {
      title: "Datei aus GitLab-Repository lesen",
      description: "Liest den Rohinhalt einer Datei aus einem freigegebenen GitLab-Projekt/Branch.",
      inputSchema: inputShape,
    },
    withLogging(TOOL_NAME, async (args: Input) => {
      const project = ctx.permissions.assertBranchAllowed(args.project, args.branch);
      const encodedPath = encodeURIComponent(args.path.replace(/^\/+/, ""));
      const content = await ctx.gitlab.getText(
        `/projects/${projectApiIdentifier(project)}/repository/files/${encodedPath}/raw`,
        { ref: args.branch },
      );
      const { text } = truncateText(content, ctx.limits.maxResponseBytes);
      return textResult(text);
    }),
  );
}
