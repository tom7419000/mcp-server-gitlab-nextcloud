import { timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { logger } from "./logging.js";

/**
 * Verifies the "Authorization: Bearer <token>" header on every MCP request
 * against a shared secret from ENV. Independent of the GitLab credentials -
 * this only protects the MCP endpoint itself from being reachable by anyone
 * on the LAN.
 */
export function createAuthMiddleware(expectedToken: string) {
  const expectedBuf = Buffer.from(expectedToken, "utf8");

  return function authMiddleware(req: Request, res: Response, next: NextFunction): void {
    const header = req.header("authorization") ?? "";
    const [scheme, token] = header.split(" ");

    if (scheme !== "Bearer" || !token) {
      logger.warn("mcp_auth_rejected", { reason: "missing_or_malformed_header", path: req.path });
      res.status(401).json({ error: "unauthorized" });
      return;
    }

    const tokenBuf = Buffer.from(token, "utf8");
    const isValid = tokenBuf.length === expectedBuf.length && timingSafeEqual(tokenBuf, expectedBuf);

    if (!isValid) {
      logger.warn("mcp_auth_rejected", { reason: "invalid_token", path: req.path });
      res.status(401).json({ error: "unauthorized" });
      return;
    }

    next();
  };
}
