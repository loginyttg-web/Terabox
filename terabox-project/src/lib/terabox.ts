import { isSafeHttpUrl, serializeCookies } from "./utils.js";

const TERABOX_ORIGIN = "https://dm.terabox.app";
export const TERABOX_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

export interface TeraBoxFile {
  name: string;
  /** Full TeraBox path used only to browse a folder in the same share. */
  path?: string;
  sizeBytes?: number;
  download?: string;
  thumbs?: Record<string, string>;
  isFolder: boolean;
}

export interface ResolvedShare {
  surl: string;
  directory?: string;
  files: TeraBoxFile[];
}

export class TeraBoxError extends Error {
  constructor(message: string, public readonly statusCode = 502) {
    super(message);
    this.name = "TeraBoxError";
  }
}

export interface TeraBoxClientOptions {
  cookies?: Record<string, string>;
  requestTimeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/** Headers needed when following a direct link returned by the share API. */
export function createTeraBoxDownloadHeaders(cookies: Record<string, string>): Record<string, string> {
  const cookieHeader = serializeCookies(cookies);
  return {
    "User-Agent": TERABOX_USER_AGENT,
    Accept: "*/*",
    Referer: "https://www.terabox.app/",
    ...(cookieHeader && { Cookie: cookieHeader }),
  };
}

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null;
}

function asFiniteNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && /^-?\d+(?:\.\d+)?$/.test(value)) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function asNonNegativeNumber(value: unknown): number | undefined {
  const number = asFiniteNumber(value);
  return number !== undefined && number >= 0 ? number : undefined;
}

function asStringRecord(value: unknown): Record<string, string> | undefined {
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }

  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(record)) {
    if (isSafeHttpUrl(item)) {
      result[key] = item;
    }
  }

  return Object.keys(result).length > 0 ? result : undefined;
}

function normalizeShareDirectory(value: string | undefined): string | undefined {
  const directory = value?.trim();
  if (!directory) {
    return undefined;
  }
  if (
    directory.length > 1_024 ||
    /[\u0000-\u001f]/.test(directory) ||
    !directory.startsWith("/") ||
    directory.split("/").some((segment) => segment === "..")
  ) {
    throw new TeraBoxError("The requested TeraBox folder path is invalid.", 400);
  }
  return directory;
}

function normalizeFile(value: unknown): TeraBoxFile | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }

  const rawName = record.server_filename ?? record.filename ?? record.name;
  const name = typeof rawName === "string" && rawName.trim() ? rawName.trim() : "Unnamed item";
  const rawFolder = record.isdir ?? record.is_dir ?? record.isFolder;
  const isFolder = rawFolder === 1 || rawFolder === "1" || rawFolder === true;
  const rawDownload = record.dlink ?? record.download;
  const rawPath = record.path;
  const itemPath = typeof rawPath === "string" && rawPath.startsWith("/") && rawPath.length <= 1_024
    ? rawPath
    : undefined;
  const thumbs = asStringRecord(record.thumbs);

  return {
    name,
    ...(itemPath && { path: itemPath }),
    sizeBytes: asNonNegativeNumber(record.size),
    ...(isSafeHttpUrl(rawDownload) && { download: rawDownload }),
    ...(thumbs && { thumbs }),
    isFolder,
  };
}

/** Extracts the JavaScript token from the different page shapes TeraBox serves. */
export function extractJsToken(html: string): string | null {
  const patterns = [
    /fn%28%22(.*?)%22%29/i,
    /fn\(["']([^"']+)["']\)/i,
    /["']jsToken["']\s*[:=]\s*["']([^"']+)["']/i,
  ];

  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (!match?.[1]) {
      continue;
    }

    const token = match[1].trim();
    try {
      return decodeURIComponent(token);
    } catch {
      // An already-decoded token is still usable as-is.
      return token;
    }
  }

  return null;
}

/**
 * Minimal TeraBox page/API client. It only calls TeraBox's known endpoints;
 * callers never control an upstream hostname.
 */
export class TeraBoxClient {
  private cookies: Record<string, string>;
  private readonly requestTimeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: TeraBoxClientOptions = {}) {
    this.cookies = options.cookies ?? {};
    this.requestTimeoutMs = options.requestTimeoutMs ?? 20_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /** Runtime-updatable cookies (e.g. the Telegram /setcookie command). */
  setCookies(cookies: Record<string, string>): void {
    this.cookies = cookies;
  }

  getCookieNames(): string[] {
    return Object.keys(this.cookies);
  }

  async resolve(surl: string, requestedDirectory?: string): Promise<ResolvedShare> {
    if (!/^[A-Za-z0-9_-]{4,256}$/.test(surl)) {
      throw new TeraBoxError("The TeraBox share identifier is invalid.", 400);
    }

    const directory = normalizeShareDirectory(requestedDirectory);
    const shortUrl = surl.startsWith("1") ? surl.slice(1) : surl;
    const cookieHeader = serializeCookies(this.cookies);
    const commonHeaders: Record<string, string> = {
      "User-Agent": TERABOX_USER_AGENT,
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    };
    if (cookieHeader) {
      commonHeaders.Cookie = cookieHeader;
    }

    const landingUrl = new URL("/sharing/link", TERABOX_ORIGIN);
    landingUrl.searchParams.set("surl", surl);
    const landingResponse = await this.request(landingUrl, { headers: commonHeaders });
    const landingHtml = await landingResponse.text();
    const jsToken = extractJsToken(landingHtml);

    if (!jsToken) {
      throw new TeraBoxError(
        "TeraBox did not return an accessible share page. Check the link and your TeraBox cookies.",
      );
    }

    const listUrl = new URL("/share/list", TERABOX_ORIGIN);
    listUrl.searchParams.set("app_id", "250528");
    listUrl.searchParams.set("jsToken", jsToken);
    listUrl.searchParams.set("site_referer", "https://www.terabox.app/");
    listUrl.searchParams.set("shorturl", shortUrl);
    if (directory) {
      listUrl.searchParams.set("dir", directory);
      listUrl.searchParams.set("root", "0");
    } else {
      listUrl.searchParams.set("root", "1");
    }

    const apiHeaders: Record<string, string> = {
      "User-Agent": TERABOX_USER_AGENT,
      Accept: "application/json, text/plain, */*",
      "Accept-Language": "en-US,en;q=0.9",
      "X-Requested-With": "XMLHttpRequest",
      Referer: landingUrl.toString(),
      Origin: TERABOX_ORIGIN,
    };
    if (cookieHeader) {
      apiHeaders.Cookie = cookieHeader;
    }

    const listResponse = await this.request(listUrl, { headers: apiHeaders });
    const payload = await this.parseJson(listResponse);
    const record = asRecord(payload);

    if (!record) {
      throw new TeraBoxError("TeraBox returned an unexpected response.");
    }

    const errno = asFiniteNumber(record.errno);
    if (errno !== undefined && errno !== 0) {
      const upstreamMessage = typeof record.errmsg === "string" ? record.errmsg : "Unknown TeraBox error";
      throw new TeraBoxError(`TeraBox could not open this share: ${upstreamMessage}`);
    }

    const rawList = Array.isArray(record.list) ? record.list : [];
    const files = rawList.map(normalizeFile).filter((file): file is TeraBoxFile => file !== null);

    return { surl, ...(directory && { directory }), files };
  }

  private async request(url: URL, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs);

    try {
      const response = await this.fetchImpl(url, { ...init, signal: controller.signal });
      if (!response.ok) {
        throw new TeraBoxError(`TeraBox returned HTTP ${response.status}.`);
      }
      return response;
    } catch (error) {
      if (error instanceof TeraBoxError) {
        throw error;
      }
      if (controller.signal.aborted) {
        throw new TeraBoxError("The request to TeraBox timed out.");
      }
      throw new TeraBoxError("Could not reach TeraBox. Please try again shortly.");
    } finally {
      clearTimeout(timer);
    }
  }

  private async parseJson(response: Response): Promise<unknown> {
    const text = await response.text();
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new TeraBoxError("TeraBox returned an invalid API response.");
    }
  }
}
