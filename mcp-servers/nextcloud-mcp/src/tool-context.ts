import type { PermissionsConfig } from "./config.js";
import type { WebdavClient } from "./webdav-client.js";
import type { DeckClient } from "./deck-client.js";
import type { PermissionEngine } from "./permissions.js";

export interface ToolContext {
  webdav: WebdavClient;
  deck: DeckClient;
  permissions: PermissionEngine;
  limits: PermissionsConfig["limits"];
}
