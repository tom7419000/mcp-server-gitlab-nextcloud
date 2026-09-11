import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "../tool-context.js";
import { jsonResult, withLogging } from "../tool-helpers.js";
import { summarizeStack } from "../deck-format.js";

const TOOL_NAME = "deck_list_stacks";

const inputShape = {
  board_id: z.number().int().positive(),
};
const InputSchema = z.object(inputShape);
type Input = z.infer<typeof InputSchema>;

export function registerDeckListStacks(server: McpServer, ctx: ToolContext): void {
  if (!ctx.permissions.isToolEnabled(TOOL_NAME)) {
    return;
  }

  server.registerTool(
    TOOL_NAME,
    {
      title: "Deck-Stacks auflisten",
      description: "Listet die Stacks (Spalten) eines freigegebenen Deck-Boards auf.",
      inputSchema: inputShape,
    },
    withLogging(TOOL_NAME, async (args: Input) => {
      ctx.permissions.assertBoardAllowed(args.board_id);
      const stacks = await ctx.deck.listStacks(args.board_id);
      return jsonResult(
        stacks.map((s) => summarizeStack(s)),
        ctx.limits.maxResponseBytes,
      );
    }),
  );
}
