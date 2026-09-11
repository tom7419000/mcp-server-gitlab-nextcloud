import { logger } from "./logging.js";

export class DeckApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "DeckApiError";
  }
}

export interface DeckClientOptions {
  baseUrl: string;
  username: string;
  appPassword: string;
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
 * Client for the Nextcloud Deck OCS REST API. Only exposes GET requests -
 * there is no generic `request(method, ...)` escape hatch, so a compromised
 * or buggy tool implementation structurally cannot issue a write against
 * Deck.
 *
 * Note: unlike the classic `/ocs/v2.php/...` endpoints, Deck's API under
 * `/index.php/apps/deck/api/v1.0/` returns plain JSON (not OCS-envelope
 * wrapped `{ ocs: { data: ... } }`), but it still requires the
 * `OCS-APIRequest: true` header to bypass Nextcloud's CSRF protection for
 * non-browser clients.
 */
export class DeckClient {
  private readonly apiBaseUrl: string;
  private readonly authHeader: string;
  private readonly timeoutMs: number;

  constructor(options: DeckClientOptions) {
    const base = options.baseUrl.replace(/\/+$/, "");
    this.apiBaseUrl = `${base}/index.php/apps/deck/api/v1.0`;
    this.authHeader = `Basic ${Buffer.from(`${options.username}:${options.appPassword}`).toString("base64")}`;
    this.timeoutMs = options.timeoutMs;
  }

  async getJson<T = unknown>(path: string): Promise<T> {
    const response = await this.fetchWithRetry(`${this.apiBaseUrl}${path}`);
    return (await response.json()) as T;
  }

  private async fetchWithRetry(url: string, attempt = 1): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let response: Response;
    try {
      response = await fetch(url, {
        method: "GET",
        headers: {
          Authorization: this.authHeader,
          "OCS-APIRequest": "true",
          Accept: "application/json",
        },
        signal: controller.signal,
      });
    } catch (error) {
      clearTimeout(timer);
      if (attempt <= MAX_RETRIES) {
        const delay = backoffMs(attempt);
        logger.warn("deck_request_retry", { reason: "network_error", attempt, delayMs: delay });
        await sleep(delay);
        return this.fetchWithRetry(url, attempt + 1);
      }
      throw new DeckApiError(`Deck-Anfrage fehlgeschlagen: ${(error as Error).message}`);
    }
    clearTimeout(timer);

    if (RETRYABLE_STATUS.has(response.status) && attempt <= MAX_RETRIES) {
      const delay = backoffMs(attempt);
      logger.warn("deck_request_retry", { reason: "http_status", status: response.status, attempt, delayMs: delay });
      await sleep(delay);
      return this.fetchWithRetry(url, attempt + 1);
    }

    if (response.status === 404) {
      throw new DeckApiError("Ressource nicht gefunden.", 404);
    }
    if (!response.ok) {
      throw new DeckApiError(`Deck API antwortete mit Status ${response.status}`, response.status);
    }

    return response;
  }

  listBoards(): Promise<unknown[]> {
    return this.getJson<unknown[]>("/boards");
  }

  listStacks(boardId: number): Promise<unknown[]> {
    return this.getJson<unknown[]>(`/boards/${boardId}/stacks`);
  }

  getStack(boardId: number, stackId: number): Promise<unknown> {
    return this.getJson<unknown>(`/boards/${boardId}/stacks/${stackId}`);
  }

  getCard(boardId: number, stackId: number, cardId: number): Promise<unknown> {
    return this.getJson<unknown>(`/boards/${boardId}/stacks/${stackId}/cards/${cardId}`);
  }
}
