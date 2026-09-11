import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "../tool-context.js";
import { jsonResult, withLogging } from "../tool-helpers.js";
import { summarizeCard } from "../deck-format.js";

const TOOL_NAME = "deck_get_card";

const inputShape = {
  board_id: z.number().int().positive(),
  stack_id: z.number().int().positive(),
  card_id: z.number().int().positive(),
};
const InputSchema = z.object(inputShape);
type Input = z.infer<typeof InputSchema>;

export function registerDeckGetCard(server: McpServer, ctx: ToolContext): void {
  if (!ctx.permissions.isToolEnabled(TOOL_NAME)) {
    return;
  }

  server.registerTool(
    TOOL_NAME,
    {
      title: "Deck-Karte lesen",
      description:
        "Liest eine einzelne Karte inkl. Beschreibung, Labels und Fälligkeitsdatum von einem freigegebenen Deck-Board.",
      inputSchema: inputShape,
    },
    withLogging(TOOL_NAME, async (args: Input) => {
      ctx.permissions.assertBoardAllowed(args.board_id);
      const card = await ctx.deck.getCard(args.board_id, args.stack_id, args.card_id);
      return jsonResult(summarizeCard(card, { includeDescription: true }), ctx.limits.maxResponseBytes);
    }),
  );
}
