import { posix } from "node:path";
import type { PermissionsConfig } from "./config.js";
import { logger } from "./logging.js";

/**
 * Generic, non-leaking error surfaced to MCP clients whenever a permission
 * check fails. The concrete reason (which path/board, why) is only ever
 * written to the structured server log, never returned to the caller.
 */
export class PermissionDeniedError extends Error {
  constructor(message = "Zugriff auf diese Ressource ist durch die Server-Konfiguration nicht erlaubt.") {
    super(message);
    this.name = "PermissionDeniedError";
  }
}

// Defense-in-depth: reject percent-encoded traversal/separator sequences
// outright, in case any downstream consumer would ever decode them again
// after our whitelist check (e.g. "%2e%2e" -> "..").
const ENCODED_TRAVERSAL_PATTERN = /%2e|%2f|%5c/i;

export class PermissionEngine {
  constructor(private readonly config: PermissionsConfig) {}

  get limits(): PermissionsConfig["limits"] {
    return this.config.limits;
  }

  isToolEnabled(name: string): boolean {
    return this.config.tools[name] === true;
  }

  /** True if `paths` is set to the wildcard "*" instead of an explicit list. */
  isWildcardPaths(): boolean {
    return this.config.paths === "*";
  }

  /** True if `deckBoards` is set to the wildcard "*" instead of an explicit list. */
  isWildcardBoards(): boolean {
    return this.config.deckBoards === "*";
  }

  /** Read-only view of the whitelisted paths, e.g. for search_files. Empty in wildcard mode. */
  listAllowedPaths(): readonly string[] {
    return this.config.paths === "*" ? [] : this.config.paths;
  }

  /** Read-only view of the whitelisted board IDs, e.g. for deck_search_cards. Empty in wildcard mode. */
  listAllowedBoards(): readonly number[] {
    return this.config.deckBoards === "*" ? [] : this.config.deckBoards;
  }

  isBoardAllowed(boardId: number): boolean {
    return this.config.deckBoards === "*" || this.config.deckBoards.includes(boardId);
  }

  assertBoardAllowed(boardId: number): void {
    if (!this.isBoardAllowed(boardId)) {
      logger.warn("permission_denied", { scope: "board", boardId });
      throw new PermissionDeniedError();
    }
  }

  /**
   * Normalizes `rawPath`, rejects any traversal attempt, and checks the
   * result against the configured path whitelist. Returns the normalized
   * path for callers to use in the actual WebDAV request.
   *
   * Matching uses an exact-or-prefix-with-boundary check
   * (`normalized === allowed || normalized.startsWith(allowed + "/")`) so
   * that e.g. "/Projekte/PizzaGame2" is never mistaken for a child of the
   * whitelisted "/Projekte/PizzaGame".
   */
  assertPathAllowed(rawPath: string): string {
    if (ENCODED_TRAVERSAL_PATTERN.test(rawPath)) {
      logger.warn("permission_denied", { scope: "path", reason: "encoded_traversal_pattern" });
      throw new PermissionDeniedError();
    }

    const withLeadingSlash = rawPath.startsWith("/") ? rawPath : `/${rawPath}`;
    const normalized = posix.normalize(withLeadingSlash).replace(/\/+$/, "") || "/";

    if (normalized.split("/").includes("..")) {
      logger.warn("permission_denied", { scope: "path", reason: "traversal_after_normalize" });
      throw new PermissionDeniedError();
    }

    const isAllowed =
      this.config.paths === "*" ||
      this.config.paths.some((allowed) => normalized === allowed || normalized.startsWith(`${allowed}/`));

    if (!isAllowed) {
      logger.warn("permission_denied", { scope: "path" });
      throw new PermissionDeniedError();
    }

    return normalized;
  }
}
