import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "../tool-context.js";
import { jsonResult, withLogging } from "../tool-helpers.js";

const TOOL_NAME = "list_files";

const inputShape = {
  path: z.string().min(1).describe("Ordnerpfad, z.B. /Projekte/PizzaGame"),
};
const InputSchema = z.object(inputShape);
type Input = z.infer<typeof InputSchema>;

export function registerListFiles(server: McpServer, ctx: ToolContext): void {
  if (!ctx.permissions.isToolEnabled(TOOL_NAME)) {
    return;
  }

  server.registerTool(
    TOOL_NAME,
    {
      title: "Nextcloud-Ordner auflisten",
      description: "Listet Dateien und Unterordner eines freigegebenen Nextcloud-Pfads auf (nicht rekursiv).",
      inputSchema: inputShape,
    },
    withLogging(TOOL_NAME, async (args: Input) => {
      const normalizedPath = ctx.permissions.assertPathAllowed(args.path);
      const entries = await ctx.webdav.propfind(normalizedPath);

      return jsonResult(
        entries.map((e) => ({
          name: e.name,
          path: e.path,
          type: e.isCollection ? "folder" : "file",
          sizeBytes: e.contentLength,
          contentType: e.contentType,
          lastModified: e.lastModified,
        })),
        ctx.limits.maxResponseBytes,
      );
    }),
  );
}
