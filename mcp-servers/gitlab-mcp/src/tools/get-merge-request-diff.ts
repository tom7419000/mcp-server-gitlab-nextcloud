import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "../tool-context.js";
import { textResult, withLogging } from "../tool-helpers.js";
import { truncateText } from "../response-limits.js";
import { projectApiIdentifier } from "../gitlab-client.js";

const TOOL_NAME = "get_merge_request_diff";

const inputShape = {
  project: z.string().min(1).describe("Projekt-ID oder vollständiger Pfad"),
  mr_iid: z.number().int().positive().describe("Interne Merge-Request-ID (iid), nicht die globale ID"),
};
const InputSchema = z.object(inputShape);
type Input = z.infer<typeof InputSchema>;

interface GitlabMrDiff {
  old_path: string;
  new_path: string;
  new_file: boolean;
  deleted_file: boolean;
  renamed_file: boolean;
  diff: string;
}

export function registerGetMergeRequestDiff(server: McpServer, ctx: ToolContext): void {
  if (!ctx.permissions.isToolEnabled(TOOL_NAME)) {
    return;
  }

  server.registerTool(
    TOOL_NAME,
    {
      title: "GitLab-Merge-Request-Diff lesen",
      description: "Liefert den Diff (alle geänderten Dateien) eines Merge Requests in einem freigegebenen Projekt.",
      inputSchema: inputShape,
    },
    withLogging(TOOL_NAME, async (args: Input) => {
      const project = ctx.permissions.assertProjectAllowed(args.project);
      const diffs = await ctx.gitlab.getJson<GitlabMrDiff[]>(
        `/projects/${projectApiIdentifier(project)}/merge_requests/${args.mr_iid}/diffs`,
        { per_page: 100 },
      );

      const combined = diffs
        .map((d) => {
          const header = d.new_file
            ? `--- neue Datei: ${d.new_path} ---`
            : d.deleted_file
              ? `--- gelöschte Datei: ${d.old_path} ---`
              : d.renamed_file
                ? `--- umbenannt: ${d.old_path} -> ${d.new_path} ---`
                : `--- geändert: ${d.new_path} ---`;
          return `${header}\n${d.diff}`;
        })
        .join("\n\n");

      const { text } = truncateText(combined, ctx.limits.maxResponseBytes);
      return textResult(text);
    }),
  );
}
