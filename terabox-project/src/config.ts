import path from "node:path";
import { loadCookies } from "./lib/utils.js";

export interface TelegramConfig {
  token: string;
  allowedUserIds: ReadonlySet<number>;
  allowPublic: boolean;
  /** Bot owner's Telegram user id. Always allowed + can manage /access. */
  ownerId?: number;
  /** Dump/destination channel where a copy of content + user info goes. */
  destChannelId?: number;
  /** SQLite file that persists runtime /access grants. */
  accessDatabasePath: string;
  pollingTimeoutSeconds: number;
  requestTimeoutMs: number;
  maxFilesPerReply: number;
}

/** Optional raw-MTProto transfer settings. They are deliberately disabled by
 * default because large transfers need disk space and a reliable always-on host. */
export interface TransferConfig {
  apiId: number;
  apiHash: string;
  tempDir: string;
  maxUploadBytes: number;
  splitPartBytes: number;
  maxSourceBytes: number;
  diskSafetyBytes: number;
  queueConcurrency: number;
  maxQueueSize: number;
  uploadWorkers: number;
  progressIntervalMs: number;
  splitOversizeFiles: boolean;
  zipCommand: string;
  databasePath: string;
  maxAttempts: number;
  retryBaseDelayMs: number;
  historyLimit: number;
  mediaMode: "auto" | "document" | "video";
  maxJobsPerUserPerDay: number;
  /** How many simultaneous active/queued jobs a single chat may have (>=1). */
  maxJobsPerChat: number;
  /** Parallel HTTP Range connections for downloading from TeraBox (1–16). */
  downloadChunks: number;
}

export interface AppConfig {
  host: string;
  port: number;
  corsOrigin: string;
  cacheTtlMs: number;
  cacheMaxItems: number;
  terabox: {
    requestTimeoutMs: number;
    cookies: Record<string, string>;
  };
  telegram?: TelegramConfig;
  transfer?: TransferConfig;
  adminApiKey?: string;
  keepalive?: {
    urls: string[];
    intervalMs: number;
  };
}

function readInteger(
  env: NodeJS.ProcessEnv,
  name: string,
  defaultValue: number,
  minimum: number,
  maximum: number,
): number {
  const raw = env[name]?.trim();
  if (!raw) {
    return defaultValue;
  }

  if (!/^\d+$/.test(raw)) {
    throw new Error(`${name} must be an integer.`);
  }

  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be between ${minimum} and ${maximum}.`);
  }

  return value;
}

function readRequiredInteger(
  env: NodeJS.ProcessEnv,
  name: string,
  minimum: number,
  maximum: number,
): number {
  const raw = env[name]?.trim();
  if (!raw) {
    throw new Error(`${name} is required when TELEGRAM_UPLOAD_ENABLED=true.`);
  }
  return readInteger(env, name, 0, minimum, maximum);
}

function readBoolean(env: NodeJS.ProcessEnv, name: string, defaultValue: boolean): boolean {
  const raw = env[name]?.trim().toLowerCase();
  if (!raw) {
    return defaultValue;
  }
  if (["1", "true", "yes", "on"].includes(raw)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(raw)) {
    return false;
  }
  throw new Error(`${name} must be true or false.`);
}

/** Optional signed integer (channel ids are negative like -100123456). */
function readOptionalSignedInt(env: NodeJS.ProcessEnv, name: string): number | undefined {
  const raw = env[name]?.trim();
  if (!raw) {
    return undefined;
  }
  if (!/^-?\d+$/.test(raw)) {
    throw new Error(`${name} must be an integer.`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value === 0) {
    throw new Error(`${name} must be a non-zero integer.`);
  }
  return value;
}

function readOptionalPositiveInt(env: NodeJS.ProcessEnv, name: string): number | undefined {
  const raw = env[name]?.trim();
  if (!raw) {
    return undefined;
  }
  if (!/^\d+$/.test(raw)) {
    throw new Error(`${name} must be a positive integer.`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return value;
}

function readAllowedUserIds(env: NodeJS.ProcessEnv): Set<number> {
  const raw = env.TELEGRAM_ALLOWED_USER_IDS?.trim();
  if (!raw) {
    return new Set();
  }

  const ids = new Set<number>();
  for (const value of raw.split(",")) {
    const trimmed = value.trim();
    if (!/^\d+$/.test(trimmed)) {
      throw new Error("TELEGRAM_ALLOWED_USER_IDS must be a comma-separated list of numeric Telegram user IDs.");
    }

    const id = Number(trimmed);
    if (!Number.isSafeInteger(id) || id <= 0) {
      throw new Error("TELEGRAM_ALLOWED_USER_IDS contains an invalid Telegram user ID.");
    }
    ids.add(id);
  }

  return ids;
}

function readMegabytes(
  env: NodeJS.ProcessEnv,
  name: string,
  defaultValue: number,
  minimum: number,
  maximum: number,
): number {
  const megabytes = readInteger(env, name, defaultValue, minimum, maximum);
  return megabytes * 1_000_000;
}

function readGigabytes(
  env: NodeJS.ProcessEnv,
  name: string,
  defaultValue: number,
  minimum: number,
  maximum: number,
): number {
  const gigabytes = readInteger(env, name, defaultValue, minimum, maximum);
  return gigabytes * 1_000_000_000;
}

function loadTransferConfig(env: NodeJS.ProcessEnv, telegram: TelegramConfig | undefined): TransferConfig | undefined {
  const enabled = readBoolean(env, "TELEGRAM_UPLOAD_ENABLED", false);
  if (!enabled) {
    return undefined;
  }

  if (!telegram) {
    throw new Error("TELEGRAM_BOT_TOKEN is required when TELEGRAM_UPLOAD_ENABLED=true.");
  }

  const apiHash = env.TELEGRAM_API_HASH?.trim();
  if (!apiHash || apiHash.length < 16 || /\s/.test(apiHash)) {
    throw new Error("TELEGRAM_API_HASH is required when TELEGRAM_UPLOAD_ENABLED=true.");
  }

  const maxUploadBytes = readMegabytes(env, "TRANSFER_UPLOAD_LIMIT_MB", 1_900, 10, 1_900);
  const splitPartBytes = readMegabytes(env, "TRANSFER_SPLIT_PART_MB", 1_800, 10, 1_900);
  if (splitPartBytes > maxUploadBytes) {
    throw new Error("TRANSFER_SPLIT_PART_MB must not be larger than TRANSFER_UPLOAD_LIMIT_MB.");
  }

  const tempDir = env.TRANSFER_TEMP_DIR?.trim() || "/tmp/terabox-transfers";
  const databasePath = env.TRANSFER_DATABASE_PATH?.trim() || path.join(tempDir, "transfer-jobs.sqlite");
  const zipCommand = env.TRANSFER_ZIP_COMMAND?.trim() || "zip";
  if (!zipCommand || /[\r\n]/.test(zipCommand)) {
    throw new Error("TRANSFER_ZIP_COMMAND must be a valid executable path or command name.");
  }
  const mediaMode = (env.TRANSFER_MEDIA_MODE?.trim().toLowerCase() || "auto") as TransferConfig["mediaMode"];
  if (!["auto", "document", "video"].includes(mediaMode)) {
    throw new Error("TRANSFER_MEDIA_MODE must be auto, document, or video.");
  }

  return {
    apiId: readRequiredInteger(env, "TELEGRAM_API_ID", 1, 2_147_483_647),
    apiHash,
    tempDir,
    maxUploadBytes,
    splitPartBytes,
    maxSourceBytes: readGigabytes(env, "TRANSFER_MAX_SOURCE_GB", 20, 1, 1_000),
    diskSafetyBytes: readMegabytes(env, "TRANSFER_DISK_SAFETY_MB", 1_024, 128, 100_000),
    queueConcurrency: readInteger(env, "TRANSFER_QUEUE_CONCURRENCY", 1, 1, 2),
    maxQueueSize: readInteger(env, "TRANSFER_MAX_QUEUE", 3, 1, 20),
    uploadWorkers: readInteger(env, "TRANSFER_UPLOAD_WORKERS", 4, 1, 8),
    progressIntervalMs: readInteger(env, "TRANSFER_PROGRESS_INTERVAL_SECONDS", 5, 1, 60) * 1_000,
    splitOversizeFiles: readBoolean(env, "TRANSFER_SPLIT_OVERSIZE", true),
    zipCommand,
    databasePath,
    maxAttempts: readInteger(env, "TRANSFER_MAX_ATTEMPTS", 3, 1, 10),
    retryBaseDelayMs: readInteger(env, "TRANSFER_RETRY_BASE_SECONDS", 30, 5, 3_600) * 1_000,
    historyLimit: readInteger(env, "TRANSFER_JOB_HISTORY_LIMIT", 100, 10, 10_000),
    mediaMode,
    maxJobsPerUserPerDay: readInteger(env, "TRANSFER_MAX_JOBS_PER_USER_PER_DAY", 20, 0, 10_000),
    maxJobsPerChat: readInteger(env, "TRANSFER_MAX_JOBS_PER_CHAT", 1, 1, 20),
    downloadChunks: readInteger(env, "TRANSFER_DOWNLOAD_CHUNKS", 16, 1, 32),
  };
}

/** Reads and validates all runtime configuration once during startup. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const host = env.HOST?.trim() || "0.0.0.0";
  const port = readInteger(env, "PORT", 5000, 1, 65_535);
  const corsOrigin = env.CORS_ORIGIN?.trim() || "*";
  const cacheTtlSeconds = readInteger(env, "CACHE_TTL_SECONDS", 7_200, 0, 86_400);
  const cacheMaxItems = readInteger(env, "CACHE_MAX_ITEMS", 500, 1, 10_000);
  const teraboxRequestTimeoutMs = readInteger(
    env,
    "TERABOX_REQUEST_TIMEOUT_MS",
    20_000,
    1_000,
    120_000,
  );

  const token = env.TELEGRAM_BOT_TOKEN?.trim();
  const adminApiKey = env.ADMIN_API_KEY?.trim();
  if (adminApiKey && (adminApiKey.length < 16 || /\s/.test(adminApiKey))) {
    throw new Error("ADMIN_API_KEY must be a secret value of at least 16 non-space characters.");
  }
  let telegram: TelegramConfig | undefined;

  if (token) {
    const allowedUserIds = readAllowedUserIds(env);
    const allowPublic = readBoolean(env, "TELEGRAM_ALLOW_PUBLIC", false);
    const ownerId =
      readOptionalPositiveInt(env, "TELEGRAM_OWNER_ID") ??
      readOptionalPositiveInt(env, "TELEGRAM_ADMIN_ID");
    const destChannelId = readOptionalSignedInt(env, "TELEGRAM_DEST_CHANNEL_ID");
    const accessDatabasePath = env.ACCESS_DATABASE_PATH?.trim() || "/tmp/terabox-transfers/access.sqlite";

    if (!allowPublic && allowedUserIds.size === 0 && ownerId === undefined) {
      throw new Error(
        "Set TELEGRAM_ALLOWED_USER_IDS, TELEGRAM_OWNER_ID, or TELEGRAM_ALLOW_PUBLIC=true.",
      );
    }

    telegram = {
      token,
      allowedUserIds,
      allowPublic,
      ...(ownerId !== undefined && { ownerId }),
      ...(destChannelId !== undefined && { destChannelId }),
      accessDatabasePath,
      pollingTimeoutSeconds: readInteger(env, "TELEGRAM_POLL_TIMEOUT_SECONDS", 25, 1, 50),
      requestTimeoutMs: readInteger(env, "TELEGRAM_REQUEST_TIMEOUT_MS", 40_000, 5_000, 120_000),
      maxFilesPerReply: readInteger(env, "TELEGRAM_MAX_FILES_PER_REPLY", 5, 1, 10),
    };
  }

  return {
    host,
    port,
    corsOrigin,
    cacheTtlMs: cacheTtlSeconds * 1_000,
    cacheMaxItems,
    terabox: {
      requestTimeoutMs: teraboxRequestTimeoutMs,
      cookies: loadCookies(env),
    },
    telegram,
    transfer: loadTransferConfig(env, telegram),
    ...(adminApiKey && { adminApiKey }),
    ...(env.KEEPALIVE_URLS?.trim() && {
      keepalive: {
        urls: env.KEEPALIVE_URLS.split(",").map((s) => s.trim()).filter(Boolean),
        intervalMs: readInteger(env, "KEEPALIVE_INTERVAL_SECONDS", 600, 60, 86_400) * 1_000,
      },
    }),
  };
}
