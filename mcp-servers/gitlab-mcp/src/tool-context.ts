import type { PermissionsConfig } from "./config.js";
import type { GitlabClient } from "./gitlab-client.js";
import type { PermissionEngine } from "./permissions.js";

export interface ToolContext {
  gitlab: GitlabClient;
  permissions: PermissionEngine;
  limits: PermissionsConfig["limits"];
}
