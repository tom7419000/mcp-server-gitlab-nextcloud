import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "../tool-context.js";
import { textResult, withLogging } from "../tool-helpers.js";
import { truncateText } from "../response-limits.js";

const TOOL_NAME = "read_file";

const inputShape = {
  path: z.string().min(1).describe("Dateipfad, z.B. /Projekte/PizzaGame/readme.md"),
};
const InputSchema = z.object(inputShape);
type Input = z.infer<typeof InputSchema>;

export function registerReadFile(server: McpServer, ctx: ToolContext): void {
  if (!ctx.permissions.isToolEnabled(TOOL_NAME)) {
    return;
  }

  server.registerTool(
    TOOL_NAME,
    {
      title: "Nextcloud-Datei lesen",
      description: "Liest den Inhalt einer Datei aus einem freigegebenen Nextcloud-Pfad.",
      inputSchema: inputShape,
    },
    withLogging(TOOL_NAME, async (args: Input) => {
      const normalizedPath = ctx.permissions.assertPathAllowed(args.path);
      const { content } = await ctx.webdav.getFile(normalizedPath);
      const { text } = truncateText(content, ctx.limits.maxResponseBytes);
      return textResult(text);
    }),
  );
}
