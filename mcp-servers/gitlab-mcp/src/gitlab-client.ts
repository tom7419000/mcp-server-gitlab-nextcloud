import { logger } from "./logging.js";

export class GitlabApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "GitlabApiError";
  }
}

export interface GitlabClientOptions {
  baseUrl: string;
  token: string;
  timeoutMs: number;
}

const MAX_RETRIES = 3;
const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function backoffMs(attempt: number): number {
  return Math.min(1000 * 2 ** (attempt - 1), 8000);
}

/**
 * Thin GitLab REST v4 client. Deliberately only exposes GET requests - there
 * is no `request(method, ...)` escape hatch, so a compromised or buggy tool
 * implementation structurally cannot issue a write against the GitLab API.
 */
export class GitlabClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly timeoutMs: number;

  constructor(options: GitlabClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.token = options.token;
    this.timeoutMs = options.timeoutMs;
  }

  private buildUrl(path: string, query?: Record<string, string | number | undefined>): URL {
    const url = new URL(`${this.baseUrl}/api/v4${path}`);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined) {
          url.searchParams.set(key, String(value));
        }
      }
    }
    return url;
  }

  async getJson<T = unknown>(path: string, query?: Record<string, string | number | undefined>): Promise<T> {
    const response = await this.fetchWithRetry(this.buildUrl(path, query));
    return (await response.json()) as T;
  }

  async getText(path: string, query?: Record<string, string | number | undefined>): Promise<string> {
    const response = await this.fetchWithRetry(this.buildUrl(path, query));
    return response.text();
  }

  private async fetchWithRetry(url: URL, attempt = 1): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let response: Response;
    try {
      response = await fetch(url, {
        method: "GET",
        headers: {
          "PRIVATE-TOKEN": this.token,
          Accept: "application/json",
        },
        signal: controller.signal,
      });
    } catch (error) {
      clearTimeout(timer);
      if (attempt <= MAX_RETRIES) {
        const delay = backoffMs(attempt);
        logger.warn("gitlab_request_retry", { reason: "network_error", attempt, delayMs: delay });
        await sleep(delay);
        return this.fetchWithRetry(url, attempt + 1);
      }
      throw new GitlabApiError(`GitLab-Anfrage fehlgeschlagen: ${(error as Error).message}`);
    }
    clearTimeout(timer);

    if (RETRYABLE_STATUS.has(response.status) && attempt <= MAX_RETRIES) {
      const retryAfterHeader = Number(response.headers.get("retry-after"));
      const delay = Number.isFinite(retryAfterHeader) && retryAfterHeader > 0 ? retryAfterHeader * 1000 : backoffMs(attempt);
      logger.warn("gitlab_request_retry", { reason: "http_status", status: response.status, attempt, delayMs: delay });
      await sleep(delay);
      return this.fetchWithRetry(url, attempt + 1);
    }

    if (!response.ok) {
      throw new GitlabApiError(`GitLab API antwortete mit Status ${response.status}`, response.status);
    }

    return response;
  }
}

/** GitLab's `:id` path segment accepts either the numeric project ID or the URL-encoded full path. */
export function projectApiIdentifier(project: { id?: number; path?: string }): string {
  if (project.id !== undefined) {
    return String(project.id);
  }
  if (project.path !== undefined) {
    return encodeURIComponent(project.path);
  }
  throw new Error("Projekt-Konfiguration hat weder id noch path.");
}
