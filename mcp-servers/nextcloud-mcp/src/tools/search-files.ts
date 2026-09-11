import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "../tool-context.js";
import type { WebdavClient } from "../webdav-client.js";
import { jsonResult, withLogging } from "../tool-helpers.js";
import { logger } from "../logging.js";

const TOOL_NAME = "search_files";

const inputShape = {
  query: z.string().min(1).describe("Suchbegriff (Teilstring, case-insensitive) für Datei-/Ordnernamen"),
};
const InputSchema = z.object(inputShape);
type Input = z.infer<typeof InputSchema>;

// Nextcloud's WebDAV endpoint has no simple GET/PROPFIND-only full-text search,
// so this tool walks the whitelisted folder trees breadth-first and matches
// file/folder names. Caps keep it bounded on Pi-class hardware and against
// very large trees.
const MAX_NODES_VISITED = 2000;
const MAX_MATCHES = 200;
const MAX_DEPTH = 8;

interface MatchEntry {
  name: string;
  path: string;
  type: "file" | "folder";
}

async function searchTree(webdav: WebdavClient, rootPath: string, query: string): Promise<{ matches: MatchEntry[]; capped: boolean }> {
  const lowerQuery = query.toLowerCase();
  const matches: MatchEntry[] = [];
  const queue: Array<{ path: string; depth: number }> = [{ path: rootPath, depth: 0 }];
  let visited = 0;
  let capped = false;

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (visited >= MAX_NODES_VISITED || matches.length >= MAX_MATCHES) {
      capped = true;
      break;
    }
    visited += 1;

    let entries;
    try {
      entries = await webdav.propfind(current.path);
    } catch (error) {
      logger.warn("search_files_propfind_failed", { path: current.path, error: (error as Error).message });
      continue;
    }

    for (const entry of entries) {
      if (matches.length >= MAX_MATCHES) {
        capped = true;
        break;
      }
      if (entry.name.toLowerCase().includes(lowerQuery)) {
        matches.push({ name: entry.name, path: entry.path, type: entry.isCollection ? "folder" : "file" });
      }
      if (entry.isCollection && current.depth < MAX_DEPTH) {
        queue.push({ path: entry.path, depth: current.depth + 1 });
      }
    }
  }

  return { matches, capped };
}

export function registerSearchFiles(server: McpServer, ctx: ToolContext): void {
  if (!ctx.permissions.isToolEnabled(TOOL_NAME)) {
    return;
  }

  server.registerTool(
    TOOL_NAME,
    {
      title: "Nextcloud-Dateien durchsuchen",
      description:
        "Durchsucht die freigegebenen Nextcloud-Ordner nach Datei-/Ordnernamen, die den Suchbegriff enthalten.",
      inputSchema: inputShape,
    },
    withLogging(TOOL_NAME, async (args: Input) => {
      const allowedPaths = ctx.permissions.listAllowedPaths();
      let cappedOverall = false;
      const allMatches: MatchEntry[] = [];

      for (const rootPath of allowedPaths) {
        const { matches, capped } = await searchTree(ctx.webdav, rootPath, args.query);
        allMatches.push(...matches);
        cappedOverall = cappedOverall || capped;
        if (allMatches.length >= MAX_MATCHES) {
          cappedOverall = true;
          break;
        }
      }

      return jsonResult(
        {
          matches: allMatches.slice(0, MAX_MATCHES),
          truncated: cappedOverall,
        },
        ctx.limits.maxResponseBytes,
      );
    }),
  );
}
