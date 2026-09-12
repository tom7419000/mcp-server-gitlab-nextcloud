import type { PermissionsConfig, ProjectPermission } from "./config.js";
import { logger } from "./logging.js";

/**
 * Generic, non-leaking error surfaced to MCP clients whenever a permission
 * check fails. The concrete reason (which project/branch/tool, why) is only
 * ever written to the structured server log, never returned to the caller.
 */
export class PermissionDeniedError extends Error {
  constructor(message = "Zugriff auf diese Ressource ist durch die Server-Konfiguration nicht erlaubt.") {
    super(message);
    this.name = "PermissionDeniedError";
  }
}

export class PermissionEngine {
  constructor(private readonly config: PermissionsConfig) {}

  get limits(): PermissionsConfig["limits"] {
    return this.config.limits;
  }

  /** Used at MCP handshake time: disabled tools are not registered at all. */
  isToolEnabled(name: string): boolean {
    return this.config.tools[name] === true;
  }

  /** True if `projects` is set to the wildcard "*" instead of an explicit list. */
  isWildcardProjects(): boolean {
    return this.config.projects === "*";
  }

  /** Read-only view of the whitelisted projects, e.g. for the list_projects tool. Empty in wildcard mode. */
  listConfiguredProjects(): readonly ProjectPermission[] {
    return this.config.projects === "*" ? [] : this.config.projects;
  }

  private findProject(identifier: string): ProjectPermission | undefined {
    const asNumber = Number(identifier);
    const isNumeric = identifier.trim() !== "" && Number.isFinite(asNumber);

    if (this.config.projects === "*") {
      // Wildcard mode: trust GitLab's own membership/visibility rules for
      // this identifier instead of a static list. The actual GET request
      // that follows will 403/404 if the token has no access here.
      return isNumeric ? { id: asNumber, branches: null } : { path: identifier, branches: null };
    }

    return this.config.projects.find((project) => {
      if (isNumeric && project.id === asNumber) {
        return true;
      }
      return project.path === identifier;
    });
  }

  /** Resolves and validates a project identifier (numeric ID or path) against the whitelist. */
  assertProjectAllowed(identifier: string): ProjectPermission {
    const project = this.findProject(identifier);
    if (!project) {
      logger.warn("permission_denied", { scope: "project", identifier });
      throw new PermissionDeniedError();
    }
    return project;
  }

  /** Validates a project + branch combination against the (optional) branch whitelist. */
  assertBranchAllowed(identifier: string, branch: string): ProjectPermission {
    const project = this.assertProjectAllowed(identifier);
    if (project.branches === null) {
      return project;
    }
    if (!project.branches.includes(branch)) {
      logger.warn("permission_denied", { scope: "branch", identifier, branch });
      throw new PermissionDeniedError();
    }
    return project;
  }
}
