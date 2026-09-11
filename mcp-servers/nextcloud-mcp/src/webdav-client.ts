import { XMLParser } from "fast-xml-parser";
import { logger } from "./logging.js";

export class WebdavError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "WebdavError";
  }
}

export interface WebdavClientOptions {
  baseUrl: string;
  username: string;
  appPassword: string;
  timeoutMs: number;
}

export interface WebdavEntry {
  path: string;
  name: string;
  isCollection: boolean;
  contentLength?: number;
  contentType?: string;
  lastModified?: string;
}

const MAX_RETRIES = 3;
const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function backoffMs(attempt: number): number {
  return Math.min(1000 * 2 ** (attempt - 1), 8000);
}

const xmlParser = new XMLParser({ ignoreAttributes: false, removeNSPrefix: true });

const PROPFIND_BODY = `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:">
  <d:prop>
    <d:displayname/>
    <d:resourcetype/>
    <d:getcontentlength/>
    <d:getcontenttype/>
    <d:getlastmodified/>
  </d:prop>
</d:propfind>`;

/**
 * WebDAV client restricted to PROPFIND and GET - the only two methods this
 * module exposes. There is no generic `request(method, ...)` escape hatch,
 * so a compromised or buggy tool implementation structurally cannot issue a
 * write (PUT/DELETE/MKCOL/...) against Nextcloud.
 */
export class WebdavClient {
  private readonly davBaseUrl: string;
  private readonly authHeader: string;
  private readonly timeoutMs: number;

  constructor(options: WebdavClientOptions) {
    const base = options.baseUrl.replace(/\/+$/, "");
    this.davBaseUrl = `${base}/remote.php/dav/files/${encodeURIComponent(options.username)}`;
    this.authHeader = `Basic ${Buffer.from(`${options.username}:${options.appPassword}`).toString("base64")}`;
    this.timeoutMs = options.timeoutMs;
  }

  private buildUrl(davPath: string): string {
    const segments = davPath.split("/").filter(Boolean).map(encodeURIComponent);
    return `${this.davBaseUrl}/${segments.join("/")}`;
  }

  /** Lists the immediate children of `davPath` (already-validated, normalized path). */
  async propfind(davPath: string): Promise<WebdavEntry[]> {
    const response = await this.requestWithRetry(this.buildUrl(davPath), "PROPFIND", {
      Depth: "1",
      "Content-Type": "application/xml; charset=utf-8",
    }, PROPFIND_BODY);
    const xml = await response.text();
    return parseMultistatus(xml, davPath);
  }

  /** Reads the raw content of a single file at `davPath` (already-validated, normalized path). */
  async getFile(davPath: string): Promise<{ content: string; contentType: string | null }> {
    const response = await this.requestWithRetry(this.buildUrl(davPath), "GET", {});
    const contentType = response.headers.get("content-type");
    const content = await response.text();
    return { content, contentType };
  }

  private async requestWithRetry(
    url: string,
    method: "GET" | "PROPFIND",
    extraHeaders: Record<string, string>,
    body?: string,
    attempt = 1,
  ): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers: { Authorization: this.authHeader, ...extraHeaders },
        body,
        signal: controller.signal,
      });
    } catch (error) {
      clearTimeout(timer);
      if (attempt <= MAX_RETRIES) {
        const delay = backoffMs(attempt);
        logger.warn("webdav_request_retry", { reason: "network_error", attempt, delayMs: delay });
        await sleep(delay);
        return this.requestWithRetry(url, method, extraHeaders, body, attempt + 1);
      }
      throw new WebdavError(`WebDAV-Anfrage fehlgeschlagen: ${(error as Error).message}`);
    }
    clearTimeout(timer);

    if (RETRYABLE_STATUS.has(response.status) && attempt <= MAX_RETRIES) {
      const delay = backoffMs(attempt);
      logger.warn("webdav_request_retry", {
        reason: "http_status",
        status: response.status,
        attempt,
        delayMs: delay,
      });
      await sleep(delay);
      return this.requestWithRetry(url, method, extraHeaders, body, attempt + 1);
    }

    if (response.status === 404) {
      throw new WebdavError("Ressource nicht gefunden.", 404);
    }
    if (!response.ok && response.status !== 207) {
      throw new WebdavError(`WebDAV antwortete mit Status ${response.status}`, response.status);
    }

    return response;
  }
}

function parseMultistatus(xml: string, requestedDavPath: string): WebdavEntry[] {
  const parsed = xmlParser.parse(xml);
  const responses = parsed?.multistatus?.response;
  const list = Array.isArray(responses) ? responses : responses ? [responses] : [];
  const requestedNormalized = requestedDavPath.replace(/\/+$/, "");

  const entries: WebdavEntry[] = [];
  for (const entry of list) {
    try {
      const rawHref = String(entry.href ?? "");
      const decodedHref = decodeURIComponent(rawHref);
      const relativePath = decodedHref.replace(/^.*\/remote\.php\/dav\/files\/[^/]+/, "").replace(/\/+$/, "");

      // The requested collection itself is always included in a Depth:1
      // multistatus response - skip it, we only want the children.
      if (relativePath === requestedNormalized) {
        continue;
      }

      const propstatList = Array.isArray(entry.propstat) ? entry.propstat : [entry.propstat];
      const okPropstat =
        propstatList.find((p: Record<string, unknown>) => String(p?.status ?? "").includes("200")) ??
        propstatList[0];
      const prop = (okPropstat?.prop as Record<string, unknown>) ?? {};

      const resourcetype = prop.resourcetype;
      const isCollection =
        typeof resourcetype === "object" && resourcetype !== null && "collection" in resourcetype;

      const contentLengthRaw = prop.getcontentlength;
      const lastModifiedRaw = prop.getlastmodified;
      const contentTypeRaw = prop.getcontenttype;

      entries.push({
        path: relativePath,
        name: relativePath.split("/").pop() ?? relativePath,
        isCollection,
        contentLength:
          typeof contentLengthRaw === "string" || typeof contentLengthRaw === "number"
            ? Number(contentLengthRaw)
            : undefined,
        contentType: typeof contentTypeRaw === "string" ? contentTypeRaw : undefined,
        lastModified: typeof lastModifiedRaw === "string" ? lastModifiedRaw : undefined,
      });
    } catch (error) {
      logger.warn("webdav_propfind_entry_skipped", { reason: (error as Error).message });
    }
  }
  return entries;
}
