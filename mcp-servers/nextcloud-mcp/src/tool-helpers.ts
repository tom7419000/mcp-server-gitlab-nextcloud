import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { logToolCall } from "./logging.js";
import { PermissionDeniedError } from "./permissions.js";
import { truncateText } from "./response-limits.js";

export function textResult(text: string): CallToolResult {
  return { content: [{ type: "text", text }] };
}

export function errorResult(text: string): CallToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

/** Serializes `data` as pretty JSON and truncates it to `maxBytes` if needed. */
export function jsonResult(data: unknown, maxBytes: number): CallToolResult {
  const { text } = truncateText(JSON.stringify(data, null, 2), maxBytes);
  return textResult(text);
}

/**
 * Wraps a tool handler with uniform structured logging (tool name + params,
 * duration, outcome) and uniform error handling, so individual tools never
 * need to repeat this boilerplate or accidentally leak an internal error
 * message (with paths/IDs) back to the MCP client.
 */
export function withLogging<Args extends Record<string, unknown>>(
  toolName: string,
  handler: (args: Args) => Promise<CallToolResult>,
): (args: Args) => Promise<CallToolResult> {
  return async (args: Args): Promise<CallToolResult> => {
    const start = Date.now();
    try {
      const result = await handler(args);
      logToolCall({
        tool: toolName,
        params: args,
        durationMs: Date.now() - start,
        outcome: result.isError ? "error" : "success",
        resultBytes: JSON.stringify(result.content).length,
      });
      return result;
    } catch (error) {
      const durationMs = Date.now() - start;
      if (error instanceof PermissionDeniedError) {
        logToolCall({ tool: toolName, params: args, durationMs, outcome: "denied", errorMessage: error.message });
        return errorResult(error.message);
      }
      logToolCall({
        tool: toolName,
        params: args,
        durationMs,
        outcome: "error",
        errorMessage: (error as Error).message,
      });
      return errorResult("Interner Fehler bei der Verarbeitung der Anfrage.");
    }
  };
}
