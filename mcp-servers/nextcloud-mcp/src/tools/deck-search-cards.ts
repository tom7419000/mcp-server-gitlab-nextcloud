import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "../tool-context.js";
import { jsonResult, withLogging } from "../tool-helpers.js";
import { extractCardsFromStack, summarizeBoard, summarizeCard, summarizeStack } from "../deck-format.js";
import { logger } from "../logging.js";

const TOOL_NAME = "deck_search_cards";

const inputShape = {
  query: z.string().min(1).describe("Suchbegriff (Teilstring, case-insensitive) für Titel und Beschreibung"),
};
const InputSchema = z.object(inputShape);
type Input = z.infer<typeof InputSchema>;

// The Deck API has no dedicated search endpoint, so this walks every
// whitelisted board's stacks/cards and filters client-side. Bounded by the
// number of whitelisted boards, which is expected to be small.
const MAX_MATCHES = 200;

export function registerDeckSearchCards(server: McpServer, ctx: ToolContext): void {
  if (!ctx.permissions.isToolEnabled(TOOL_NAME)) {
    return;
  }

  server.registerTool(
    TOOL_NAME,
    {
      title: "Deck-Karten durchsuchen",
      description: "Durchsucht Titel und Beschreibung aller Karten auf den freigegebenen Deck-Boards.",
      inputSchema: inputShape,
    },
    withLogging(TOOL_NAME, async (args: Input) => {
      const lowerQuery = args.query.toLowerCase();
      const matches: Array<Record<string, unknown>> = [];
      let truncated = false;

      let boardIds: readonly number[];
      if (ctx.permissions.isWildcardBoards()) {
        const boards = await ctx.deck.listBoards();
        boardIds = boards
          .map((b) => summarizeBoard(b).id)
          .filter((id): id is number => typeof id === "number");
      } else {
        boardIds = ctx.permissions.listAllowedBoards();
      }

      for (const boardId of boardIds) {
        if (matches.length >= MAX_MATCHES) {
          truncated = true;
          break;
        }
        let stacks: unknown[];
        try {
          stacks = await ctx.deck.listStacks(boardId);
        } catch (error) {
          logger.warn("deck_search_cards_board_failed", { boardId, error: (error as Error).message });
          continue;
        }

        for (const stack of stacks) {
          const stackInfo = summarizeStack(stack);
          const cards = extractCardsFromStack(stack);
          for (const rawCard of cards) {
            if (matches.length >= MAX_MATCHES) {
              truncated = true;
              break;
            }
            const card = summarizeCard(rawCard, { includeDescription: true });
            const title = String(card.title ?? "").toLowerCase();
            const description = String(card.description ?? "").toLowerCase();
            if (title.includes(lowerQuery) || description.includes(lowerQuery)) {
              matches.push({ boardId, stackId: stackInfo.id, ...card });
            }
          }
        }
      }

      return jsonResult({ matches, truncated }, ctx.limits.maxResponseBytes);
    }),
  );
}
