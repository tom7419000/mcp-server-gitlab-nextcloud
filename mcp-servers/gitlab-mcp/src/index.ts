import { randomUUID } from "node:crypto";
import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { loadConfig } from "./config.js";
import { GitlabClient } from "./gitlab-client.js";
import { PermissionEngine } from "./permissions.js";
import { logger } from "./logging.js";
import { createAuthMiddleware } from "./auth-middleware.js";
import type { ToolContext } from "./tool-context.js";
import { registerListProjects } from "./tools/list-projects.js";
import { registerListBranches } from "./tools/list-branches.js";
import { registerGetFile } from "./tools/get-file.js";
import { registerListCommits } from "./tools/list-commits.js";
import { registerListMergeRequests } from "./tools/list-merge-requests.js";
import { registerGetMergeRequestDiff } from "./tools/get-merge-request-diff.js";
import { registerSearchCode } from "./tools/search-code.js";
import { registerGetRepoTree } from "./tools/get-repo-tree.js";

function bootstrap() {
  let config: ReturnType<typeof loadConfig>;
  try {
    config = loadConfig();
  } catch (error) {
    console.error(`[gitlab-mcp] Startup fehlgeschlagen: ${(error as Error).message}`);
    process.exit(1);
  }

  const gitlab = new GitlabClient({
    baseUrl: config.gitlabUrl,
    token: config.gitlabToken,
    timeoutMs: config.permissions.limits.requestTimeoutMs,
  });
  const permissions = new PermissionEngine(config.permissions);
  const toolCtx: ToolContext = { gitlab, permissions, limits: config.permissions.limits };

  function createMcpServer(): McpServer {
    const server = new McpServer({ name: "gitlab-mcp", version: "1.0.0" });
    registerListProjects(server, toolCtx);
    registerListBranches(server, toolCtx);
    registerGetFile(server, toolCtx);
    registerListCommits(server, toolCtx);
    registerListMergeRequests(server, toolCtx);
    registerGetMergeRequestDiff(server, toolCtx);
    registerSearchCode(server, toolCtx);
    registerGetRepoTree(server, toolCtx);
    return server;
  }

  const enabledTools = Object.keys(config.permissions.tools).filter((name) => config.permissions.tools[name]);
  logger.info("startup", {
    port: config.port,
    gitlabUrl: config.gitlabUrl,
    enabledTools,
    configuredProjects:
      config.permissions.projects === "*" ? "*" : config.permissions.projects.length,
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
