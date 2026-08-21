import { isSafeHttpUrl, serializeCookies } from "./utils.js";

const TERABOX_ORIGINS = [
  "https://dm.terabox.app",
  "https://www.terabox.com",
  "https://terabox.app",
  "https://www.1024tera.com",
];
const TERABOX_ORIGIN = TERABOX_ORIGINS[0];

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
  /** Extra metadata for UI */
  fsId?: string;
  category?: number;
}

export interface ResolvedShare {
  surl: string;
  directory?: string;
  files: TeraBoxFile[];
  /** Total size of all files in this listing */
  totalSizeBytes?: number;
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

export interface ResolveOptions {
  pwd?: string;
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
  const rawDownload = record.dlink ?? record.download ?? record.downloadLink;
  const rawPath = record.path;
  const itemPath = typeof rawPath === "string" && rawPath.startsWith("/") && rawPath.length <= 1_024
    ? rawPath
    : undefined;
  const thumbs = asStringRecord(record.thumbs);
  const fsId = typeof record.fs_id === "number" ? String(record.fs_id) : typeof record.fs_id === "string" ? record.fs_id : undefined;
  const category = asFiniteNumber(record.category);

  return {
    name,
    ...(itemPath && { path: itemPath }),
    sizeBytes: asNonNegativeNumber(record.size ?? record.size_bytes),
    ...(isSafeHttpUrl(rawDownload) && { download: rawDownload as string }),
    ...(thumbs && { thumbs }),
    isFolder,
    ...(fsId && { fsId }),
    ...(category !== undefined && { category }),
  };
}

/** Extracts the JavaScript token from the different page shapes TeraBox serves. */
export function extractJsToken(html: string): string | null {
  const patterns = [
    /fn%28%22(.*?)%22%29/i,
    /fn\(["']([^"']+)["']\)/i,
    /["']jsToken["']\s*[:=]\s*["']([^"']+)["']/i,
    /jsToken\s*[:=]\s*["']([^"']+)["']/i,
    /window\.jsToken\s*=\s*["']([^"']+)["']/i,
    /"jsToken"\s*:\s*"([^"]+)"/i,
    /%22jsToken%22%3A%22([^%"]+)%22/i,
    /yjsToken\s*[:=]\s*["']([^"']+)["']/i,
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
      return token;
    }
  }

  // Try to find token in inline JS via window.yunData etc
  const yunMatch = html.match(/yunData\s*=\s*({.*?});/s);
  if (yunMatch?.[1]) {
    try {
      const json = JSON.parse(yunMatch[1]);
      if (json && typeof json.jsToken === "string") return json.jsToken;
    } catch {
      // ignore
    }
  }

  return null;
}

/**
 * Enhanced TeraBox page/API client with multi-origin fallback and password support.
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

  setCookies(cookies: Record<string, string>): void {
    this.cookies = cookies;
  }

  getCookieNames(): string[] {
    return Object.keys(this.cookies);
  }

  async resolve(surl: string, requestedDirectory?: string, opts?: ResolveOptions): Promise<ResolvedShare> {
    if (!/^[A-Za-z0-9_-]{4,256}$/.test(surl)) {
      throw new TeraBoxError("The TeraBox share identifier is invalid.", 400);
    }

    const directory = normalizeShareDirectory(requestedDirectory);
    const shortUrl = surl.startsWith("1") ? surl.slice(1) : surl;
    const cookieHeader = serializeCookies(this.cookies);
    const commonHeaders: Record<string, string> = {
      "User-Agent": TERABOX_USER_AGENT,
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
      "Cache-Control": "no-cache",
      Pragma: "no-cache",
    };
    if (cookieHeader) {
      commonHeaders.Cookie = cookieHeader;
    }

    let lastError: TeraBoxError | null = null;

    // Try multiple origins for resilience
    for (const origin of TERABOX_ORIGINS) {
      try {
        const landingUrl = new URL("/sharing/link", origin);
        landingUrl.searchParams.set("surl", surl);
        if (opts?.pwd) landingUrl.searchParams.set("pwd", opts.pwd);

        const landingResponse = await this.request(landingUrl, { headers: commonHeaders });
        const landingHtml = await landingResponse.text();
        const jsToken = extractJsToken(landingHtml);

        if (!jsToken) {
          // Some pages may not need jsToken and directly contain list data
          // Try to extract from HTML directly as fallback
          if (landingHtml.includes("No accessible file") || landingHtml.includes("link not valid")) {
            throw new TeraBoxError(
              "TeraBox share link expired or invalid. Check the link and try again.",
              404,
            );
          }
          // If no token found on this origin, try next origin
          if (origin !== TERABOX_ORIGINS[TERABOX_ORIGINS.length - 1]) continue;
          throw new TeraBoxError(
            "TeraBox did not return an accessible share page. Check the link and your TeraBox cookies. Cookie may have expired - update via /setcookie.",
          );
        }

        const listUrl = new URL("/share/list", origin);
        listUrl.searchParams.set("app_id", "250528");
        listUrl.searchParams.set("jsToken", jsToken);
        listUrl.searchParams.set("site_referer", "https://www.terabox.app/");
        listUrl.searchParams.set("shorturl", shortUrl);
        listUrl.searchParams.set("page", "1");
        listUrl.searchParams.set("num", "100");
        listUrl.searchParams.set("order", "time");
        listUrl.searchParams.set("desc", "1");
        if (opts?.pwd) listUrl.searchParams.set("pwd", opts.pwd);
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
          Origin: origin,
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
          // Handle specific error codes
          if (errno === 2 || errno === -9) {
            throw new TeraBoxError(`TeraBox share not found or expired: ${upstreamMessage}`, 404);
          }
          if (errno === -6 || errno === 400) {
            throw new TeraBoxError(`TeraBox authentication failed: ${upstreamMessage}. Please update cookies.`, 401);
          }
          throw new TeraBoxError(`TeraBox could not open this share: ${upstreamMessage} (code ${errno})`);
        }

        const rawList = Array.isArray(record.list) ? record.list : [];
        const files = rawList.map(normalizeFile).filter((file): file is TeraBoxFile => file !== null);
        const totalSize = files.reduce((sum, f) => sum + (f.sizeBytes ?? 0), 0);

        return {
          surl,
          ...(directory && { directory }),
          files,
          totalSizeBytes: totalSize > 0 ? totalSize : undefined,
        };
      } catch (error) {
        if (error instanceof TeraBoxError) {
          lastError = error;
          // Don't retry on client errors
          if (error.statusCode === 400 || error.statusCode === 404 || error.statusCode === 401) {
            throw error;
          }
          // Otherwise try next origin
          continue;
        }
        lastError = new TeraBoxError("Could not reach TeraBox. Please try again shortly.");
      }
    }

    throw lastError ?? new TeraBoxError("Could not reach TeraBox. Please try again shortly.");
  }

  private async request(url: URL, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs);

    try {
      const response = await this.fetchImpl(url, { ...init, signal: controller.signal });
      if (!response.ok) {
        if (response.status === 404) {
          throw new TeraBoxError("TeraBox share not found (404). Link may have expired.", 404);
        }
        if (response.status === 403) {
          throw new TeraBoxError("TeraBox access forbidden (403). Cookie may be expired or IP blocked.", 403);
        }
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
      // Some responses may be JSONP or wrapped
      const jsonMatch = text.match(/\{.*\}/s);
      if (jsonMatch) {
        try {
          return JSON.parse(jsonMatch[0]);
        } catch {
          // fallthrough
        }
      }
      throw new TeraBoxError("TeraBox returned an invalid API response.");
    }
  }
}
