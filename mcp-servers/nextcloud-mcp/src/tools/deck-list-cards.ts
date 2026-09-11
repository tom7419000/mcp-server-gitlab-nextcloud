import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "../tool-context.js";
import { jsonResult, withLogging } from "../tool-helpers.js";
import { extractCardsFromStack, summarizeCard } from "../deck-format.js";

const TOOL_NAME = "deck_list_cards";

const inputShape = {
  board_id: z.number().int().positive(),
  stack_id: z.number().int().positive(),
};
const InputSchema = z.object(inputShape);
type Input = z.infer<typeof InputSchema>;

export function registerDeckListCards(server: McpServer, ctx: ToolContext): void {
  if (!ctx.permissions.isToolEnabled(TOOL_NAME)) {
    return;
  }

  server.registerTool(
    TOOL_NAME,
    {
      title: "Deck-Karten auflisten",
      description: "Listet die Karten eines Stacks auf einem freigegebenen Deck-Board auf (ohne volle Beschreibung).",
      inputSchema: inputShape,
    },
    withLogging(TOOL_NAME, async (args: Input) => {
      ctx.permissions.assertBoardAllowed(args.board_id);
      const stack = await ctx.deck.getStack(args.board_id, args.stack_id);
      const cards = extractCardsFromStack(stack);
      return jsonResult(
        cards.map((c) => summarizeCard(c, { includeDescription: false })),
        ctx.limits.maxResponseBytes,
      );
    }),
  );
}
