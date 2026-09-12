import { randomUUID } from "node:crypto";
import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { loadConfig } from "./config.js";
import { WebdavClient } from "./webdav-client.js";
import { DeckClient } from "./deck-client.js";
import { PermissionEngine } from "./permissions.js";
import { logger } from "./logging.js";
import { createAuthMiddleware } from "./auth-middleware.js";
import type { ToolContext } from "./tool-context.js";
import { registerListFiles } from "./tools/list-files.js";
import { registerReadFile } from "./tools/read-file.js";
import { registerSearchFiles } from "./tools/search-files.js";
import { registerDeckListBoards } from "./tools/deck-list-boards.js";
import { registerDeckListStacks } from "./tools/deck-list-stacks.js";
import { registerDeckListCards } from "./tools/deck-list-cards.js";
import { registerDeckGetCard } from "./tools/deck-get-card.js";
import { registerDeckSearchCards } from "./tools/deck-search-cards.js";

function bootstrap() {
  let config: ReturnType<typeof loadConfig>;
  try {
    config = loadConfig();
  } catch (error) {
    console.error(`[nextcloud-mcp] Startup fehlgeschlagen: ${(error as Error).message}`);
    process.exit(1);
  }

  const webdav = new WebdavClient({
    baseUrl: config.nextcloudUrl,
    username: config.nextcloudUser,
    appPassword: config.nextcloudAppPassword,
    timeoutMs: config.permissions.limits.requestTimeoutMs,
  });
  const deck = new DeckClient({
    baseUrl: config.nextcloudUrl,
    username: config.nextcloudUser,
    appPassword: config.nextcloudAppPassword,
    timeoutMs: config.permissions.limits.requestTimeoutMs,
  });
  const permissions = new PermissionEngine(config.permissions);
  const toolCtx: ToolContext = { webdav, deck, permissions, limits: config.permissions.limits };

  function createMcpServer(): McpServer {
    const server = new McpServer({ name: "nextcloud-mcp", version: "1.0.0" });
    registerListFiles(server, toolCtx);
    registerReadFile(server, toolCtx);
    registerSearchFiles(server, toolCtx);
    registerDeckListBoards(server, toolCtx);
    registerDeckListStacks(server, toolCtx);
    registerDeckListCards(server, toolCtx);
    registerDeckGetCard(server, toolCtx);
    registerDeckSearchCards(server, toolCtx);
    return server;
  }

  const enabledTools = Object.keys(config.permissions.tools).filter((name) => config.permissions.tools[name]);
  logger.info("startup", {
    port: config.port,
    nextcloudUrl: config.nextcloudUrl,
    enabledTools,
    allowedPaths: config.permissions.paths === "*" ? "*" : config.permissions.paths.length,
    allowedBoards: config.permissions.deckBoards === "*" ? "*" : config.permissions.deckBoards.length,
  });

  const app = express();
  app.use(express.json({ limit: "2mb" }));

  app.get("/health", (_req, res) => {
    res.status(200).json({ status: "ok" });
  });

  const authMiddleware = createAuthMiddleware(config.mcpAuthToken);
  const transports = new Map<string, StreamableHTTPServerTransport>();

  app.all("/mcp", authMiddleware, async (req, res) => {
    try {
      const sessionId = req.header("mcp-session-id");
      let transport = sessionId ? transports.get(sessionId) : undefined;

      if (!transport) {
        if (req.method !== "POST" || !isInitializeRequest(req.body)) {
          res.status(400).json({ error: "Keine gültige MCP-Session. Erwarte eine initialize-Anfrage." });
          return;
        }

        const server = createMcpServer();
        const newTransport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id) => {
            transports.set(id, newTransport);
            logger.info("mcp_session_initialized", { sessionId: id });
          },
          onsessionclosed: (id) => {
            transports.delete(id);
            logger.info("mcp_session_closed", { sessionId: id });
          },
        });
        newTransport.onclose = () => {
          if (newTransport.sessionId) {
            transports.delete(newTransport.sessionId);
          }
        };
        await server.connect(newTransport);
        transport = newTransport;
      }

      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      logger.error("mcp_request_failed", { error: (error as Error).message });
      if (!res.headersSent) {
        res.status(500).json({ error: "internal_error" });
      }
    }
  });

  app.listen(config.port, () => {
    logger.info("listening", { port: config.port });
  });
}

bootstrap();
