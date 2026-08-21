import fs from "node:fs";
import path from "node:path";

/** Domains that are accepted as TeraBox share URLs. Keeping this allow-list
 * prevents the resolver from being used as a generic server-side fetch proxy.
 * Expanded 2025-2026 to cover 60+ official + mirror + short domains. */
export const ALLOWED_HOSTS = new Set([
  // Primary / official
  "terabox.com",
  "www.terabox.com",
  "terabox.app",
  "www.terabox.app",
  "teraboxapp.com",
  "www.teraboxapp.com",
  "terabox.fun",
  "www.terabox.fun",
  "terabox.club",
  "www.terabox.club",
  "terabox.link",
  "www.terabox.link",
  "teraboxurl.com",
  "www.teraboxurl.com",
  "teraboxfree.com",
  "www.teraboxfree.com",
  "terabox.click",
  "www.terabox.click",
  "terabox.ws",
  "www.terabox.ws",
  "terabox.to",
  "www.terabox.to",
  "teraboxdrive.com",
  "www.teraboxdrive.com",
  "teraboxlite.com",
  "www.teraboxlite.com",
  "teraboxcdn.app",
  "www.teraboxcdn.app",
  "teraboxcdn.com",
  "www.teraboxcdn.com",
  "teraboxapi.com",
  "www.teraboxapi.com",
  "dm.terabox.app",
  "d.terabox.com",
  "api.terabox.com",
  "api.terabox.app",
  "www.dubox.com",
  "dubox.com",
  "www.dubox.cn",
  "dubox.cn",
  "dobox.com",
  "www.dobox.com",

  // 1024 variants
  "1024terabox.com",
  "www.1024terabox.com",
  "1024-terabox.com",
  "www.1024-terabox.com",
  "1024tera.com",
  "www.1024tera.com",
  "1024tera.co",
  "www.1024tera.co",
  "tera1024box.com",
  "www.tera1024box.com",
  "1024terabox.link",
  "1024tera.link",
  "www.1024terabox.link",
  "1024teraboxfile.com",
  "www.1024teraboxfile.com",
  "1024box.com",
  "www.1024box.com",

  // Share / short-link domains
  "teraboxshare.com",
  "www.teraboxshare.com",
  "teraboxsharefile.com",
  "www.teraboxsharefile.com",
  "teraboxlink.com",
  "www.teraboxlink.com",
  "teraboxfile.com",
  "www.teraboxfile.com",
  "teraboxfiles.com",
  "www.teraboxfiles.com",
  "teraboxdownloader.com",
  "www.teraboxdownloader.com",
  "teraboxplayer.com",
  "www.teraboxplayer.com",
  "terasharelink.com",
  "www.terasharelink.com",
  "terasharefile.com",
  "www.terasharefile.com",
  "terashareus.com",
  "www.terashareus.com",
  "terafileshare.com",
  "www.terafileshare.com",
  "teraboxsharelink.com",
  "www.teraboxsharelink.com",
  "terafilesharelink.com",
  "www.terafilesharelink.com",
  "teraboxdirect.com",
  "www.teraboxdirect.com",
  "teraboxlinks.com",
  "www.teraboxlinks.com",
  "teraboxshort.com",
  "www.teraboxshort.com",
  "freeterabox.com",
  "www.freeterabox.com",
  "freeterabox.link",
  "www.freeterabox.link",

  // Mirror / partner domains
  "mirrobox.com",
  "www.mirrobox.com",
  "nephobox.com",
  "www.nephobox.com",
  "4funbox.com",
  "www.4funbox.com",
  "4funbox.co",
  "www.4funbox.co",
  "4funbox.in",
  "www.4funbox.in",
  "4funbox.link",
  "www.4funbox.link",
  "momerybox.com",
  "www.momerybox.com",
  "memorybox.com",
  "www.memorybox.com",
  "tibibox.com",
  "www.tibibox.com",
  "gibibox.com",
  "www.gibibox.com",
  "pebibox.com",
  "www.pebibox.com",
  "fancybox.com",
  "www.fancybox.com",
  "fancybox.in",
  "www.fancybox.in",
  "bestclouddrive.com",
  "www.bestclouddrive.com",
  "teramod.com",
  "www.teramod.com",
  "teraboxmod.com",
  "www.teraboxmod.com",
  "tttturbonet.com",
  "www.tttturbonet.com",
  "teraboxpro.com",
  "www.teraboxpro.com",
  "diskwala.com",
  "www.diskwala.com",
  "diskwala.net",
  "www.diskwala.net",
]);

const ALLOWED_SUFFIXES = [".terabox.app", ".terabox.com", ".terabox.club", ".terabox.link", ".terabox.ws"];

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
      throw new ConfigurationError(`${source} contains a non-string cookie value for \"${name}\".`);
    }
    cookies[name] = String(value);
  }

  return cookies;
}

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
      throw new ConfigurationError(`Could not read TERABOX_COOKIES_FILE at \"${resolvedPath}\".`);
    }
  }

  return {};
}

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

function isAllowedHost(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  if (ALLOWED_HOSTS.has(lower)) return true;
  // Allow subdomains like *.terabox.app, d.terabox.com etc if suffix matches
  return ALLOWED_SUFFIXES.some((suffix) => lower.endsWith(suffix) && lower.length > suffix.length);
}

export function isValidShareUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return false;
    }
    return isAllowedHost(parsed.hostname) && extractSurl(value) !== null;
  } catch {
    return false;
  }
}

/**
 * Extracts surl from many TeraBox URL shapes:
 * - https://terabox.com/s/1abc...
 * - https://terabox.app/sharing/link?surl=xxx
 * - https://terabox.com/wap/share/filelist?surl=xxx
 * - https://terabox.com/surl/xxx
 * - ?shorturl=xxx, ?shareid=xxx, ?app_id & surl
 */
export function extractSurl(value: string): string | null {
  try {
    const parsed = new URL(value);
    const qp = parsed.searchParams;
    // Common query keys
    const keys = ["surl", "shorturl", "shareid", "share_id", "s"];
    for (const k of keys) {
      const v = qp.get(k);
      if (v && SURL_PATTERN.test(v)) return v;
      if (v && v.length >= 4) {
        // Some links have leading 1, strip and test
        const stripped = v.startsWith("1") ? v.slice(1) : v;
        if (SURL_PATTERN.test(v) || SURL_PATTERN.test(stripped)) return v;
      }
    }

    // Path patterns: /s/xxx, /sharing/link, /surl/xxx, /share/xxx
    const pathPatterns = [
      /(?:^|\/)s\/([A-Za-z0-9_-]{4,256})(?:\/|$)/i,
      /(?:^|\/)surl\/([A-Za-z0-9_-]{4,256})(?:\/|$)/i,
      /(?:^|\/)sharing\/link\/?(?:\?.*)?$/i, // will rely on query already checked
      /(?:^|\/)share\/([A-Za-z0-9_-]{4,256})(?:\/|$)/i,
      /(?:^|\/)file\/([A-Za-z0-9_-]{4,256})(?:\/|$)/i,
    ];
    for (const pat of pathPatterns) {
      const m = parsed.pathname.match(pat);
      if (m?.[1] && SURL_PATTERN.test(m[1])) return m[1];
    }

    // Fallback: search entire URL for surl=xxx pattern
    const fallback = value.match(/[?&](?:surl|shorturl|shareid)=([A-Za-z0-9_-]{4,256})/i);
    if (fallback?.[1] && SURL_PATTERN.test(fallback[1])) return fallback[1];

    return null;
  } catch {
    return null;
  }
}

/** Extracts optional password/pwd from URL if present (for protected shares) */
export function extractSharePassword(value: string): string | null {
  try {
    const parsed = new URL(value);
    const pwd = parsed.searchParams.get("pwd") || parsed.searchParams.get("password") || parsed.searchParams.get("pass");
    if (pwd && pwd.trim().length >= 1 && pwd.trim().length <= 64) return pwd.trim();
    return null;
  } catch {
    return null;
  }
}

/** Finds the first valid TeraBox URL in a Telegram message or command argument. */
export function findShareUrl(text: string): string | null {
  const candidates = text.match(/https?:\/\/[^\s<>"']+/gi) ?? [];

  for (const candidate of candidates) {
    const cleaned = candidate.replace(/[),.!?\]}]+$/g, "");
    if (isValidShareUrl(cleaned)) {
      return cleaned;
    }
  }

  const trimmed = text.trim();
  return isValidShareUrl(trimmed) ? trimmed : null;
}

/** Finds ALL valid TeraBox URLs in a text (for multi-link support) */
export function findAllShareUrls(text: string): string[] {
  const candidates = text.match(/https?:\/\/[^\s<>"']+/gi) ?? [];
  const found: string[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const cleaned = candidate.replace(/[),.!?\]}]+$/g, "");
    if (isValidShareUrl(cleaned) && !seen.has(cleaned)) {
      seen.add(cleaned);
      found.push(cleaned);
    }
  }
  return found;
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

/** Returns file-type emoji based on extension */
export function getFileIcon(name: string, isFolder: boolean): string {
  if (isFolder) return "📁";
  const ext = name.split(".").pop()?.toLowerCase() || "";
  const map: Record<string, string> = {
    mp4: "🎬",
    mkv: "🎬",
    avi: "🎬",
    mov: "🎬",
    m4v: "🎬",
    flv: "🎬",
    webm: "🎬",
    mp3: "🎵",
    m4a: "🎵",
    flac: "🎵",
    wav: "🎵",
    aac: "🎵",
    ogg: "🎵",
    jpg: "🖼️",
    jpeg: "🖼️",
    png: "🖼️",
    gif: "🖼️",
    webp: "🖼️",
    bmp: "🖼️",
    svg: "🖼️",
    pdf: "📄",
    doc: "📝",
    docx: "📝",
    txt: "📝",
    zip: "🗜️",
    rar: "🗜️",
    "7z": "🗜️",
    tar: "🗜️",
    gz: "🗜️",
    apk: "📦",
    exe: "💿",
    iso: "💿",
  };
  return map[ext] || "📄";
}

/** Progress bar using block characters: [████░░░░░░] 60% */
export function formatProgressBar(progress: number, length = 12): string {
  const pct = Math.max(0, Math.min(1, progress));
  const filled = Math.round(pct * length);
  const empty = length - filled;
  const bar = "█".repeat(filled) + "░".repeat(empty);
  return `[${bar}] ${Math.floor(pct * 100)}%`;
}

/** Human readable duration */
export function formatDurationHuman(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "—";
  if (seconds < 60) return `${Math.ceil(seconds)}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${Math.ceil(seconds % 60)}s`;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h}h ${m}m`;
}
