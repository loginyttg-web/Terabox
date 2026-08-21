import fs from "node:fs";
import path from "node:path";

/** Domains that are accepted as TeraBox share URLs. Keeping this allow-list
 * prevents the resolver from being used as a generic server-side fetch proxy. */
export const ALLOWED_HOSTS = new Set([
  // Primary / official
  "terabox.app",
  "www.terabox.app",
  "terabox.com",
  "www.terabox.com",
  "teraboxapp.com",
  "www.teraboxapp.com",
  "terabox.fun",
  "www.terabox.fun",
  "dm.terabox.app",

  // 1024 variants
  "1024terabox.com",
  "www.1024terabox.com",
  "1024-terabox.com",
  "1024tera.com",
  "www.1024tera.com",
  "1024tera.co",
  "tera1024box.com",

  // Share / short-link domains
  "teraboxshare.com",
  "www.teraboxshare.com",
  "teraboxsharefile.com",
  "teraboxlink.com",
  "www.teraboxlink.com",
  "terabox.link",
  "teraboxurl.com",
  "teraboxfree.com",
  "terabox.club",
  "terabox.click",
  "terasharelink.com",
  "www.terasharelink.com",
  "terasharefile.com",
  "terashareus.com",
  "terafileshare.com",

  // Mirror domains
  "mirrobox.com",
  "www.mirrobox.com",
  "nephobox.com",
  "www.nephobox.com",
  "freeterabox.com",
  "www.freeterabox.com",
  "4funbox.com",
  "www.4funbox.com",
  "4funbox.co",
  "4funbox.in",
  "momerybox.com",
  "www.momerybox.com",
  "memorybox.com",
  "tibibox.com",
  "www.tibibox.com",
  "gibibox.com",
  "pebibox.com",
  "fancybox.com",
  "fancybox.in",
  "bestclouddrive.com",
]);

const SURL_PATTERN = /^[A-Za-z0-9_-]{4,256}$/;
const COOKIE_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

export class ConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigurationError";
  }
}

function parseCookieObject(raw: string, source: string): Record<string, string> {
  let parsed: unknown;

  try {
    parsed = JSON.parse(raw);
  } catch {
    // COOKIE_JSON used to accept a plain ndus value. Preserve that small
    // compatibility path without weakening the preferred JSON configuration.
    if (source === "COOKIE_JSON" && raw.trim()) {
      return { ndus: raw.trim() };
    }
    throw new ConfigurationError(`${source} must contain a JSON object of cookie names and values.`);
  }

  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
    throw new ConfigurationError(`${source} must contain a JSON object of cookie names and values.`);
  }

  const cookies: Record<string, string> = {};
  for (const [name, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value !== "string" && typeof value !== "number") {
      throw new ConfigurationError(`${source} contains a non-string cookie value for "${name}".`);
    }
    cookies[name] = String(value);
  }

  return cookies;
}

/**
 * Loads TeraBox cookies without ever logging them. New deployments should use
 * TERABOX_COOKIES_JSON; the older COOKIE_JSON name remains supported.
 */
export function loadCookies(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const jsonValue = env.TERABOX_COOKIES_JSON?.trim();
  if (jsonValue) {
    return parseCookieObject(jsonValue, "TERABOX_COOKIES_JSON");
  }

  const legacyValue = env.COOKIE_JSON?.trim();
  if (legacyValue) {
    return parseCookieObject(legacyValue, "COOKIE_JSON");
  }

  const fileName = env.TERABOX_COOKIES_FILE?.trim();
  if (fileName) {
    const resolvedPath = path.resolve(fileName);
    try {
      return parseCookieObject(fs.readFileSync(resolvedPath, "utf8"), "TERABOX_COOKIES_FILE");
    } catch (error) {
      if (error instanceof ConfigurationError) {
        throw error;
      }
      throw new ConfigurationError(`Could not read TERABOX_COOKIES_FILE at "${resolvedPath}".`);
    }
  }

  return {};
}

/** Returns a safe Cookie request header, or undefined when no valid cookie exists. */
export function serializeCookies(cookies: Record<string, string>): string | undefined {
  const pairs = Object.entries(cookies)
    .filter(
      ([name, value]) =>
        COOKIE_NAME_PATTERN.test(name) &&
        value.length > 0 &&
        !/[\r\n;]/.test(value),
    )
    .map(([name, value]) => `${name}=${value}`);

  return pairs.length > 0 ? pairs.join("; ") : undefined;
}

export function isValidShareUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return false;
    }

    return ALLOWED_HOSTS.has(parsed.hostname.toLowerCase()) && extractSurl(value) !== null;
  } catch {
    return false;
  }
}

export function extractSurl(value: string): string | null {
  try {
    const parsed = new URL(value);
    const fromQuery = parsed.searchParams.get("surl");
    const fromPath = parsed.pathname.match(/(?:^|\/)s\/([A-Za-z0-9_-]+)(?:\/|$)/i)?.[1];
    const surl = fromQuery ?? fromPath;

    return surl && SURL_PATTERN.test(surl) ? surl : null;
  } catch {
    return null;
  }
}

/** Finds the first valid TeraBox URL in a Telegram message or command argument. */
export function findShareUrl(text: string): string | null {
  const candidates = text.match(/https?:\/\/[^\s<>"']+/gi) ?? [];

  for (const candidate of candidates) {
    // Pasted links are often followed by a full stop or closing parenthesis.
    const cleaned = candidate.replace(/[),.!?\]}]+$/g, "");
    if (isValidShareUrl(cleaned)) {
      return cleaned;
    }
  }

  const trimmed = text.trim();
  return isValidShareUrl(trimmed) ? trimmed : null;
}

export function formatBytes(value: number | string | undefined, decimals = 2): string {
  const bytes = typeof value === "string" ? Number(value) : value;
  if (!Number.isFinite(bytes) || !bytes || bytes < 0) {
    return "0 Bytes";
  }

  const units = ["Bytes", "KB", "MB", "GB", "TB", "PB", "EB", "ZB", "YB"];
  const unitIndex = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    units.length - 1,
  );
  const precision = Math.max(0, decimals);
  const amount = bytes / 1024 ** unitIndex;

  return `${Number(amount.toFixed(precision))} ${units[unitIndex]}`;
}

export function isSafeHttpUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0) {
    return false;
  }

  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" || parsed.protocol === "http:";
  } catch {
    return false;
  }
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function truncate(value: string, maximumLength: number): string {
  if (value.length <= maximumLength) {
    return value;
  }
  return `${value.slice(0, Math.max(0, maximumLength - 1))}…`;
}
