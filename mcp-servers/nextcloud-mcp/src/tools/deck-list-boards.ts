import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "../tool-context.js";
import { jsonResult, withLogging } from "../tool-helpers.js";
import { summarizeBoard } from "../deck-format.js";

const TOOL_NAME = "deck_list_boards";

export function registerDeckListBoards(server: McpServer, ctx: ToolContext): void {
  if (!ctx.permissions.isToolEnabled(TOOL_NAME)) {
    return;
  }

  server.registerTool(
    TOOL_NAME,
    {
      title: "Deck-Boards auflisten",
      description: "Listet die für diesen MCP-Server freigegebenen Deck-Boards auf.",
      inputSchema: {},
    },
    withLogging<Record<string, never>>(TOOL_NAME, async () => {
      const allowedBoards = new Set(ctx.permissions.listAllowedBoards());
      const boards = await ctx.deck.listBoards();

      const visible = boards
        .map((b) => summarizeBoard(b))
        .filter((b) => typeof b.id === "number" && allowedBoards.has(b.id as number));

      return jsonResult(visible, ctx.limits.maxResponseBytes);
    }),
  );
}
