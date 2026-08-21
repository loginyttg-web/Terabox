import { randomUUID } from "node:crypto";
import { createReadStream, createWriteStream, mkdirSync, statfsSync } from "node:fs";
import { mkdir, readdir, rm, stat, statfs } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { TransferConfig } from "../config.js";
import type { ShareResolver } from "./share-service.js";
import { TransferStore, type StoredTransfer } from "./transfer-store.js";
import { createTeraBoxDownloadHeaders, type TeraBoxFile } from "./terabox.js";
import { formatBytes, truncate } from "./utils.js";

export type TransferStage =
  | "queued"
  | "preparing"
  | "downloading"
  | "splitting"
  | "uploading"
  | "completed"
  | "failed"
  | "cancelled";

export interface TransferSnapshot {
  id: string;
  chatId: number;
  ownerUserId?: number;
  replyToMessageId?: number;
  statusMessageId?: number;
  stage: TransferStage;
  createdAt: string;
  updatedAt: string;
  queuePosition?: number;
  filename?: string;
  sourceSizeBytes?: number;
  transferredBytes?: number;
  totalBytes?: number;
  progress?: number;
  speedBytesPerSecond?: number;
  etaSeconds?: number;
  partIndex?: number;
  partCount?: number;
  /** Total files in a bulk upload job. */
  totalFileCount?: number;
  /** 1-based index of the file currently uploading in a bulk job. */
  currentFileIndex?: number;
  attempt?: number;
  maxAttempts?: number;
  nextAttemptAt?: string;
  error?: string;
}

export interface TransferRequest {
  chatId: number;
  /** Used for per-user quotas and safe cancellation in group chats. */
  ownerUserId?: number;
  replyToMessageId: number;
  surl: string;
  /** Optional TeraBox directory path selected from the file browser. */
  directory?: string;
  /** One-based position in the selected directory listing. */
  fileIndex?: number;
  /** Upload every downloadable file in the share (recursively into sub-folders). */
  uploadAll?: boolean;
  /** Telegram status message that is edited with progress updates. */
  statusMessageId?: number;
  onUpdate?: (snapshot: TransferSnapshot) => void | Promise<void>;
}

export interface TransferManagerLike {
  enqueue(request: TransferRequest): Promise<TransferSnapshot>;
  list(chatId: number, ownerUserId?: number): TransferSnapshot[];
  cancel(chatId: number, id?: string, ownerUserId?: number): TransferSnapshot | null;
  getStatus(): Record<string, unknown>;
  getDashboard?(): Record<string, unknown>;
  setNotifier?(notifier: (snapshot: TransferSnapshot) => void | Promise<void>): void;
  subscribe?(listener: (snapshot: TransferSnapshot) => void): () => void;
  liveSnapshot?(): TransferSnapshot[];
  recover?(): Promise<void>;
  stop(): Promise<void>;
}

export class TransferError extends Error {
  constructor(message: string, public readonly retryable = true) {
    super(message);
    this.name = "TransferError";
  }
}

export class TransferCancelledError extends TransferError {
  constructor() {
    super("Transfer cancelled.");
    this.name = "TransferCancelledError";
  }
}

export interface FileDownloadInput {
  url: string;
  destination: string;
  expectedBytes: number;
  maxBytes: number;
  signal: AbortSignal;
  onProgress: (receivedBytes: number, totalBytes: number) => void;
}

export interface FileDownloader {
  download(input: FileDownloadInput): Promise<{ bytes: number }>;
}

export interface ArchivePart {
  path: string;
  name: string;
  size: number;
}

export interface ArchiveSplitInput {
  sourcePath: string;
  sourceName: string;
  outputDir: string;
  partBytes: number;
  signal: AbortSignal;
}

export interface ArchiveSplitter {
  split(input: ArchiveSplitInput): Promise<ArchivePart[]>;
}

export interface UploadInput {
  chatId: number;
  replyToMessageId: number;
  filePath: string;
  fileName: string;
  caption: string;
  mediaMode: "document" | "video";
  signal: AbortSignal;
  onProgress: (progress: number) => void;
}

export interface TelegramFileUploader {
  upload(input: UploadInput): Promise<void>;
  stop?(): Promise<void>;
}

export interface HttpFileDownloaderOptions {
  cookies: Record<string, string>;
  fetchImpl?: typeof fetch;
  connectTimeoutMs?: number;
}

/** Streams a resolved direct link to disk. It never buffers a media file in RAM. */
export class HttpFileDownloader implements FileDownloader {
  private readonly fetchImpl: typeof fetch;
  private readonly headers: Record<string, string>;
  private readonly connectTimeoutMs: number;

  constructor(options: HttpFileDownloaderOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.headers = createTeraBoxDownloadHeaders(options.cookies);
    this.connectTimeoutMs = options.connectTimeoutMs ?? 30_000;
  }

  async download(input: FileDownloadInput): Promise<{ bytes: number }> {
    if (input.signal.aborted) {
      throw new TransferCancelledError();
    }

    await mkdir(path.dirname(input.destination), { recursive: true, mode: 0o700 });
    const controller = new AbortController();
    const abort = () => controller.abort();
    input.signal.addEventListener("abort", abort, { once: true });
    const timeout = setTimeout(() => controller.abort(), this.connectTimeoutMs);

    let response: Response;
    try {
      response = await this.fetchImpl(input.url, {
        headers: this.headers,
        redirect: "follow",
        signal: controller.signal,
      });
    } catch (error) {
      if (input.signal.aborted) {
        throw new TransferCancelledError();
      }
      if (controller.signal.aborted) {
        throw new TransferError("Timed out while connecting to the TeraBox download server.");
      }
      throw new TransferError("Could not start the TeraBox file download.");
    } finally {
      clearTimeout(timeout);
      input.signal.removeEventListener("abort", abort);
    }

    if (!response.ok) {
      throw new TransferError(`TeraBox download server returned HTTP ${response.status}.`);
    }
    if (!response.body) {
      throw new TransferError("TeraBox returned an empty download response.");
    }

    const declaredSize = Number(response.headers.get("content-length"));
    const totalBytes = Number.isFinite(declaredSize) && declaredSize > 0
      ? declaredSize
      : input.expectedBytes;
    if (totalBytes > input.maxBytes) {
      throw new TransferError(
        `File size ${formatBytes(totalBytes)} exceeds the configured transfer limit of ${formatBytes(input.maxBytes)}.`,
      );
    }

    let receivedBytes = 0;
    const tracker = new Transform({
      transform: (chunk: Buffer, _encoding, callback) => {
        if (input.signal.aborted) {
          callback(new TransferCancelledError());
          return;
        }

        receivedBytes += chunk.length;
        if (receivedBytes > input.maxBytes) {
          callback(
            new TransferError(
              `Downloaded data exceeded the configured transfer limit of ${formatBytes(input.maxBytes)}.`,
            ),
          );
          return;
        }

        input.onProgress(receivedBytes, totalBytes);
        callback(null, chunk);
      },
    });

    try {
      await pipeline(
        Readable.fromWeb(response.body as never),
        tracker,
        createWriteStream(input.destination, { flags: "w", mode: 0o600 }),
        { signal: input.signal },
      );
    } catch (error) {
      await rm(input.destination, { force: true }).catch(() => undefined);
      if (input.signal.aborted || error instanceof TransferCancelledError) {
        throw new TransferCancelledError();
      }
      if (error instanceof TransferError) {
        throw error;
      }
      throw new TransferError("The TeraBox download was interrupted.");
    }

    if (receivedBytes <= 0) {
      await rm(input.destination, { force: true }).catch(() => undefined);
      throw new TransferError("TeraBox returned an empty file.");
    }

    input.onProgress(receivedBytes, totalBytes);
    return { bytes: receivedBytes };
  }
}

export interface ChunkedHttpFileDownloaderOptions {
  cookies: Record<string, string>;
  fetchImpl?: typeof fetch;
  connectTimeoutMs?: number;
  /** Number of parallel Range-request connections (1–16). Default: 8. */
  parallelChunks?: number;
}

/**
 * Downloads files using multiple parallel HTTP Range requests.
 * Even when TeraBox throttles each connection to ~3 KB/s, 8 simultaneous
 * connections yield ~24 KB/s or more. Falls back to a single stream when the
 * server does not advertise Accept-Ranges: bytes or the file is too small.
 */
export class ChunkedHttpFileDownloader implements FileDownloader {
  private readonly fetchImpl: typeof fetch;
  private readonly headers: Record<string, string>;
  private readonly connectTimeoutMs: number;
  private readonly parallelChunks: number;

  constructor(options: ChunkedHttpFileDownloaderOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.headers = createTeraBoxDownloadHeaders(options.cookies);
    this.connectTimeoutMs = options.connectTimeoutMs ?? 30_000;
    this.parallelChunks = Math.max(1, Math.min(32, options.parallelChunks ?? 8));
  }

  async download(input: FileDownloadInput): Promise<{ bytes: number }> {
    if (input.signal.aborted) throw new TransferCancelledError();
    await mkdir(path.dirname(input.destination), { recursive: true, mode: 0o700 });

    // HEAD request: learn Content-Length and whether server accepts Range.
    let serverTotalBytes: number | undefined;
    let supportsRanges = false;
    try {
      const headCtrl = new AbortController();
      const headTimer = setTimeout(() => headCtrl.abort(), 15_000);
      const headResp = await this.fetchImpl(input.url, {
        method: "HEAD",
        headers: this.headers,
        redirect: "follow",
        signal: headCtrl.signal,
      }).finally(() => clearTimeout(headTimer));
      const cl = Number(headResp.headers.get("content-length"));
      if (Number.isFinite(cl) && cl > 0) serverTotalBytes = cl;
      supportsRanges = headResp.headers.get("accept-ranges") === "bytes";
    } catch {
      // HEAD failed — fall through to single-stream.
    }

    const totalBytes = serverTotalBytes ?? input.expectedBytes;
    if (totalBytes > input.maxBytes) {
      throw new TransferError(
        `File size ${formatBytes(totalBytes)} exceeds the configured limit of ${formatBytes(input.maxBytes)}.`,
        false,
      );
    }

    // Require at least 512 KB per chunk so tiny files don't spin up many connections.
    const minChunkBytes = 512 * 1_024;
    const useParallel =
      supportsRanges &&
      this.parallelChunks > 1 &&
      totalBytes >= minChunkBytes * this.parallelChunks;

    if (!useParallel) {
      return this.downloadSingle(input, totalBytes);
    }
    return this.downloadParallel(input, totalBytes);
  }

  /** Single-connection fallback — identical logic to the original HttpFileDownloader. */
  private async downloadSingle(input: FileDownloadInput, totalBytes: number): Promise<{ bytes: number }> {
    const controller = new AbortController();
    const abort = () => controller.abort();
    input.signal.addEventListener("abort", abort, { once: true });
    const timeout = setTimeout(() => controller.abort(), this.connectTimeoutMs);

    let response: Response;
    try {
      response = await this.fetchImpl(input.url, {
        headers: this.headers,
        redirect: "follow",
        signal: controller.signal,
      });
    } catch (error) {
      if (input.signal.aborted) throw new TransferCancelledError();
      if (controller.signal.aborted) throw new TransferError("Timed out connecting to the TeraBox download server.");
      throw new TransferError("Could not start the TeraBox file download.");
    } finally {
      clearTimeout(timeout);
      input.signal.removeEventListener("abort", abort);
    }

    if (!response.ok || !response.body) {
      throw new TransferError(`TeraBox download server returned HTTP ${response.status}.`);
    }

    let receivedBytes = 0;
    const tracker = new Transform({
      transform: (chunk: Buffer, _encoding, callback) => {
        if (input.signal.aborted) { callback(new TransferCancelledError()); return; }
        receivedBytes += chunk.length;
        if (receivedBytes > input.maxBytes) {
          callback(new TransferError(`Downloaded data exceeded the configured limit of ${formatBytes(input.maxBytes)}.`));
          return;
        }
        input.onProgress(receivedBytes, totalBytes);
        callback(null, chunk);
      },
    });

    try {
      await pipeline(
        Readable.fromWeb(response.body as never),
        tracker,
        createWriteStream(input.destination, { flags: "w", mode: 0o600 }),
        { signal: input.signal },
      );
    } catch (error) {
      await rm(input.destination, { force: true }).catch(() => undefined);
      if (input.signal.aborted || error instanceof TransferCancelledError) throw new TransferCancelledError();
      if (error instanceof TransferError) throw error;
      throw new TransferError("The TeraBox download was interrupted.");
    }

    input.onProgress(receivedBytes, totalBytes);
    return { bytes: receivedBytes };
  }

  /** Parallel Range-request download: N connections simultaneously. */
  private async downloadParallel(input: FileDownloadInput, totalBytes: number): Promise<{ bytes: number }> {
    const chunkSize = Math.ceil(totalBytes / this.parallelChunks);
    const ranges: Array<{ start: number; end: number; index: number }> = [];
    for (let i = 0; i < this.parallelChunks; i++) {
      const start = i * chunkSize;
      const end = Math.min(start + chunkSize - 1, totalBytes - 1);
      if (start < totalBytes) ranges.push({ start, end, index: i });
    }

    const chunkPaths = ranges.map((r) => `${input.destination}.part${r.index}`);
    const bytesReceived = new Array<number>(ranges.length).fill(0);

    const downloadRange = async (r: { start: number; end: number; index: number }): Promise<void> => {
      const ctrl = new AbortController();
      const onAbort = () => ctrl.abort();
      input.signal.addEventListener("abort", onAbort, { once: true });
      const timer = setTimeout(() => ctrl.abort(), this.connectTimeoutMs);

      let response: Response;
      try {
        response = await this.fetchImpl(input.url, {
          headers: { ...this.headers, Range: `bytes=${r.start}-${r.end}` },
          redirect: "follow",
          signal: ctrl.signal,
        });
      } catch (error) {
        if (input.signal.aborted) throw new TransferCancelledError();
        throw new TransferError("A parallel chunk connection to TeraBox failed.");
      } finally {
        clearTimeout(timer);
        input.signal.removeEventListener("abort", onAbort);
      }

      if (!response.ok || !response.body) {
        throw new TransferError(`TeraBox chunk ${r.index} returned HTTP ${response.status}.`);
      }

      const tracker = new Transform({
        transform: (chunk: Buffer, _enc, cb) => {
          if (input.signal.aborted) { cb(new TransferCancelledError()); return; }
          bytesReceived[r.index] += chunk.length;
          const totalDownloaded = bytesReceived.reduce((a, b) => a + b, 0);
          if (totalDownloaded > input.maxBytes) {
            cb(new TransferError("Downloaded data exceeded the configured limit.")); return;
          }
          input.onProgress(totalDownloaded, totalBytes);
          cb(null, chunk);
        },
      });

      await pipeline(
        Readable.fromWeb(response.body as never),
        tracker,
        createWriteStream(chunkPaths[r.index], { flags: "w", mode: 0o600 }),
        { signal: input.signal },
      );
    };

    // Download all chunks in parallel.
    try {
      await Promise.all(ranges.map(downloadRange));
    } catch (error) {
      await Promise.all(chunkPaths.map((p) => rm(p, { force: true }).catch(() => undefined)));
      if (input.signal.aborted || error instanceof TransferCancelledError) throw new TransferCancelledError();
      if (error instanceof TransferError) throw error;
      throw new TransferError("Parallel chunk download failed.");
    }

    // Assemble chunks into final file via streams (no large RAM allocation).
    const out = createWriteStream(input.destination, { flags: "w", mode: 0o600 });
    try {
      for (const chunkPath of chunkPaths) {
        await pipeline(createReadStream(chunkPath), out, { end: false });
        await rm(chunkPath, { force: true }).catch(() => undefined);
      }
    } catch (error) {
      out.destroy();
      await rm(input.destination, { force: true }).catch(() => undefined);
      throw new TransferError("Failed to assemble downloaded file chunks.");
    }
    await new Promise<void>((resolve, reject) =>
      out.end((err: unknown) => (err ? reject(err) : resolve())),
    );

    const finalBytes = bytesReceived.reduce((a, b) => a + b, 0);
    input.onProgress(finalBytes, totalBytes);
    return { bytes: finalBytes };
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function compareArchiveParts(left: ArchivePart, right: ArchivePart): number {
  const leftZip = left.name.endsWith(".zip");
  const rightZip = right.name.endsWith(".zip");
  if (leftZip !== rightZip) {
    return leftZip ? 1 : -1;
  }
  return left.name.localeCompare(right.name, undefined, { numeric: true });
}

async function runZip(
  command: string,
  args: string[],
  cwd: string,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) {
    throw new TransferCancelledError();
  }

  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
    });
    let stderr = "";
    const abort = () => child.kill("SIGTERM");

    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < 2_000) {
        stderr += chunk.toString("utf8");
      }
    });
    child.once("error", (error) => {
      signal.removeEventListener("abort", abort);
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        reject(new TransferError(`ZIP command "${command}" was not found on this server.`));
      } else {
        reject(new TransferError("Could not start the ZIP splitter."));
      }
    });
    child.once("close", (code) => {
      signal.removeEventListener("abort", abort);
      if (signal.aborted) {
        reject(new TransferCancelledError());
      } else if (code === 0) {
        resolve();
      } else {
        const detail = stderr.trim() ? ` (${truncate(stderr.trim(), 300)})` : "";
        reject(new TransferError(`ZIP split failed${detail}`));
      }
    });
    signal.addEventListener("abort", abort, { once: true });
  });
}

/**
 * Creates a standard multi-volume ZIP without recompressing the original file.
 * The resulting .z01, .z02, ... and final .zip files must remain together for
 * a recipient to extract the archive.
 */
export class ZipArchiveSplitter implements ArchiveSplitter {
  constructor(private readonly command = "zip") {}

  async split(input: ArchiveSplitInput): Promise<ArchivePart[]> {
    const sourceName = path.basename(input.sourceName);
    const archiveStem = `${sourceName}.terabox`;
    const archiveName = `${archiveStem}.zip`;
    const archivePath = path.join(input.outputDir, archiveName);
    // Info-ZIP interprets the `m` suffix as mebibytes. Round down from our
    // decimal-byte configuration so every produced volume stays below the
    // configured Telegram upload ceiling.
    const volumeMegabytes = Math.max(1, Math.floor(input.partBytes / (1024 * 1024)));

    await rm(archivePath, { force: true }).catch(() => undefined);
    await runZip(
      this.command,
      ["-q", "-0", "-s", `${volumeMegabytes}m`, archiveName, "--", sourceName],
      input.outputDir,
      input.signal,
    );

    const parts: ArchivePart[] = [];
    const partPattern = new RegExp(`^${escapeRegExp(archiveStem)}\\.z\\d+$`, "i");
    for (const entry of await readdir(input.outputDir, { withFileTypes: true })) {
      if (!entry.isFile() || (entry.name !== archiveName && !partPattern.test(entry.name))) {
        continue;
      }
      const filePath = path.join(input.outputDir, entry.name);
      const fileStats = await stat(filePath);
      if (fileStats.size > 0) {
        parts.push({ path: filePath, name: entry.name, size: fileStats.size });
      }
    }

    parts.sort(compareArchiveParts);
    if (parts.length === 0) {
      throw new TransferError("ZIP splitter did not produce any archive parts.");
    }
    return parts;
  }
}

interface InternalJob {
  id: string;
  chatId: number;
  ownerUserId?: number;
  replyToMessageId: number;
  statusMessageId?: number;
  surl: string;
  shareDirectory?: string;
  fileIndex?: number;
  uploadAll?: boolean;
  /** Total files queued for upload in a bulk job (uploadAll). */
  totalFileCount?: number;
  /** 1-based index of the file currently being processed in a bulk job. */
  currentFileIndex?: number;
  stage: TransferStage;
  controller: AbortController;
  createdAt: Date;
  updatedAt: Date;
  callback?: TransferRequest["onUpdate"];
  callbackChain: Promise<void>;
  lastNotificationAt: number;
  filename?: string;
  sourceSizeBytes?: number;
  transferredBytes?: number;
  totalBytes?: number;
  speedBytesPerSecond?: number;
  etaSeconds?: number;
  partIndex?: number;
  partCount?: number;
  attempt: number;
  maxAttempts: number;
  nextAttemptAt?: number;
  error?: string;
  lastProgressBytes?: number;
  lastProgressAt?: number;
  workspaceDirectory?: string;
}

export interface TransferManagerOptions {
  config: TransferConfig;
  resolver: ShareResolver;
  uploader: TelegramFileUploader;
  cookies: Record<string, string>;
  downloader?: FileDownloader;
  splitter?: ArchiveSplitter;
  getFreeBytes?: (directory: string) => Promise<number>;
  store?: TransferStore;
  now?: () => number;
}

function safeFilename(value: string): string {
  const basename = path.basename(value).replace(/[\u0000-\u001f<>:"/\\|?*\u007f]/g, "_").trim();
  const normalized = basename.replace(/^\.+$/, "").replace(/^-+/, "_");
  return truncate(normalized || "terabox-file.bin", 180);
}

const STREAMABLE_VIDEO_EXTENSIONS = new Set([".mp4", ".m4v", ".mov"]);

export function chooseMediaMode(
  filename: string,
  configuredMode: TransferConfig["mediaMode"],
  isSplitArchive: boolean,
): "document" | "video" {
  if (isSplitArchive || configuredMode === "document") {
    return "document";
  }
  if (configuredMode === "video") {
    return "video";
  }
  return STREAMABLE_VIDEO_EXTENSIONS.has(path.extname(filename).toLowerCase()) ? "video" : "document";
}

function isTerminal(stage: TransferStage): boolean {
  return stage === "completed" || stage === "failed" || stage === "cancelled";
}

function defaultFreeBytes(directory: string): Promise<number> {
  return statfs(directory).then((info) => Number(info.bavail) * Number(info.bsize));
}

/**
 * Bounded, in-memory transfer queue. Files are written only to an isolated
 * temporary job directory and removed when the job reaches a terminal state.
 */
export class TransferManager implements TransferManagerLike {
  private readonly config: TransferConfig;
  private readonly resolver: ShareResolver;
  private readonly uploader: TelegramFileUploader;
  private readonly downloader: FileDownloader;
  private readonly splitter: ArchiveSplitter;
  private readonly getFreeBytes: (directory: string) => Promise<number>;
  private readonly store: TransferStore;
  private readonly now: () => number;
  private readonly jobs = new Map<string, InternalJob>();
  private readonly queued: InternalJob[] = [];
  private readonly active = new Map<string, Promise<void>>();
  private globalNotifier?: (snapshot: TransferSnapshot) => void | Promise<void>;
  private recoveryPromise?: Promise<void>;
  private wakeTimer?: NodeJS.Timeout;
  private stopped = false;
  private readonly liveSubscribers = new Set<(snapshot: TransferSnapshot) => void>();

  /** Registers a live listener for every transfer snapshot (web UI). */
  subscribe(listener: (snapshot: TransferSnapshot) => void): () => void {
    this.liveSubscribers.add(listener);
    return () => this.liveSubscribers.delete(listener);
  }

  /** Current snapshots of all recent jobs (for the web UI initial paint). */
  liveSnapshot(): TransferSnapshot[] {
    return [...this.jobs.values()]
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
      .slice(0, 25)
      .map((job) => this.snapshot(job));
  }

  constructor(options: TransferManagerOptions) {
    this.config = options.config;
    this.resolver = options.resolver;
    this.uploader = options.uploader;
    this.downloader = options.downloader ?? new ChunkedHttpFileDownloader({
      cookies: options.cookies,
      parallelChunks: options.config.downloadChunks,
    });
    this.splitter = options.splitter ?? new ZipArchiveSplitter(options.config.zipCommand);
    this.getFreeBytes = options.getFreeBytes ?? defaultFreeBytes;
    this.store = options.store ?? new TransferStore(options.config.databasePath);
    this.now = options.now ?? Date.now;
  }

  setNotifier(notifier: (snapshot: TransferSnapshot) => void | Promise<void>): void {
    this.globalNotifier = notifier;
  }

  /** Requeues jobs interrupted by a process restart and deletes stale temp files. */
  async recover(): Promise<void> {
    if (this.recoveryPromise) {
      return this.recoveryPromise;
    }
    this.recoveryPromise = this.recoverInternal().catch((error) => {
      this.recoveryPromise = undefined;
      throw error;
    });
    return this.recoveryPromise;
  }

  private async recoverInternal(): Promise<void> {
    await this.cleanupStaleWorkspaces();
    const now = this.now();
    // Keep terminal history available to /jobs after a restart as well.
    for (const stored of this.store.loadRecent(this.config.historyLimit)) {
      this.jobs.set(stored.id, this.fromStored(stored));
    }
    const recovered = this.store.loadRecoverable(now);
    for (const stored of recovered) {
      const job = this.fromStored(stored);
      await rm(path.join(this.config.tempDir, job.id), { recursive: true, force: true }).catch(() => undefined);
      this.jobs.set(job.id, job);
      this.queued.push(job);
      this.store.addEvent(job.id, now, "queued", "Recovered after service restart.");
      void this.notify(job, true);
    }
    this.notifyQueuedPositions();
    this.pump();
  }

  async enqueue(request: TransferRequest): Promise<TransferSnapshot> {
    if (this.stopped) {
      throw new TransferError("Transfer service is shutting down.");
    }
    if (this.queued.length + this.active.size >= this.config.maxQueueSize) {
      throw new TransferError("Transfer queue is full. Wait for a current transfer to finish.", false);
    }
    if (request.ownerUserId && this.config.maxJobsPerUserPerDay > 0) {
      const since = this.now() - 24 * 60 * 60 * 1_000;
      if (this.store.countCreatedByUserSince(request.ownerUserId, since) >= this.config.maxJobsPerUserPerDay) {
        throw new TransferError("Daily transfer limit reached. Try again after older jobs expire.", false);
      }
    }
    const activeInChat = [...this.jobs.values()].filter(
      (job) => job.chatId === request.chatId && !isTerminal(job.stage),
    ).length;
    if (activeInChat >= this.config.maxJobsPerChat) {
      throw new TransferError(
        `Is chat me pehle se ${activeInChat} active/queued upload hai (limit ${this.config.maxJobsPerChat}). /jobs ya /cancel use karein.`,
        false,
      );
    }

    const timestamp = new Date(this.now());
    const job: InternalJob = {
      id: randomUUID().replace(/-/g, "").slice(0, 10),
      chatId: request.chatId,
      ownerUserId: request.ownerUserId,
      replyToMessageId: request.replyToMessageId,
      statusMessageId: request.statusMessageId,
      surl: request.surl,
      shareDirectory: request.directory,
      fileIndex: request.fileIndex,
      uploadAll: request.uploadAll,
      stage: "queued",
      controller: new AbortController(),
      createdAt: timestamp,
      updatedAt: timestamp,
      callback: request.onUpdate,
      callbackChain: Promise.resolve(),
      lastNotificationAt: 0,
      attempt: 0,
      maxAttempts: this.config.maxAttempts,
    };

    this.jobs.set(job.id, job);
    this.persist(job, "Queued by user");
    this.queued.push(job);
    void this.notify(job, true);
    this.notifyQueuedPositions();
    this.pump();
    return this.snapshot(job);
  }

  list(chatId: number, ownerUserId?: number): TransferSnapshot[] {
    return [...this.jobs.values()]
      .filter((job) => job.chatId === chatId && (!ownerUserId || job.ownerUserId === undefined || job.ownerUserId === ownerUserId))
      .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())
      .slice(0, 10)
      .map((job) => this.snapshot(job));
  }

  cancel(chatId: number, id?: string, ownerUserId?: number): TransferSnapshot | null {
    const normalizedId = id?.trim().toLowerCase();
    const candidates = [...this.jobs.values()].filter(
      (job) =>
        job.chatId === chatId &&
        (!ownerUserId || job.ownerUserId === undefined || job.ownerUserId === ownerUserId) &&
        !isTerminal(job.stage) &&
        (!normalizedId || job.id.toLowerCase().startsWith(normalizedId)),
    );
    if (candidates.length !== 1) {
      return null;
    }

    const job = candidates[0];
    job.controller.abort();
    if (job.stage === "queued") {
      const index = this.queued.indexOf(job);
      if (index >= 0) {
        this.queued.splice(index, 1);
      }
      this.setStage(job, "cancelled", true);
      void this.cleanup(job).finally(() => this.pruneHistory());
      this.notifyQueuedPositions();
    }
    return this.snapshot(job);
  }

  getStatus(): Record<string, unknown> {
    return {
      enabled: true,
      active_jobs: this.active.size,
      queued_jobs: this.queued.length,
      max_queue: this.config.maxQueueSize,
      upload_limit: formatBytes(this.config.maxUploadBytes),
      split_oversize_files: this.config.splitOversizeFiles,
      max_attempts: this.config.maxAttempts,
      per_user_daily_limit: this.config.maxJobsPerUserPerDay,
    };
  }

  getDashboard(): Record<string, unknown> {
    const dashboard = this.store.getDashboard(25);
    let disk: Record<string, unknown> | undefined;
    try {
      mkdirSync(this.config.tempDir, { recursive: true, mode: 0o700 });
      const info = statfsSync(this.config.tempDir);
      const totalBytes = Number(info.blocks) * Number(info.bsize);
      const availableBytes = Number(info.bavail) * Number(info.bsize);
      disk = {
        total_bytes: totalBytes,
        available_bytes: availableBytes,
        used_bytes: Math.max(0, totalBytes - availableBytes),
      };
    } catch {
      disk = undefined;
    }
    return {
      ...this.getStatus(),
      ...(disk && { disk }),
      totals: dashboard.totals,
      recent_jobs: dashboard.recentJobs.map((job) => this.snapshot(this.fromStored(job))),
      recent_events: dashboard.recentEvents.map((event) => ({
        id: event.id,
        job_id: event.jobId,
        created_at: new Date(event.createdAtMs).toISOString(),
        stage: event.stage,
        ...(event.message && { message: event.message }),
      })),
    };
  }

  async stop(): Promise<void> {
    if (this.stopped) {
      return;
    }
    this.stopped = true;
    if (this.wakeTimer) {
      clearTimeout(this.wakeTimer);
      this.wakeTimer = undefined;
    }

    const now = this.now();
    for (const job of this.queued) {
      job.error = "Paused during service shutdown; will resume after restart.";
      job.nextAttemptAt = now;
      job.updatedAt = new Date(now);
      this.persist(job, job.error);
    }
    for (const job of this.jobs.values()) {
      if (!isTerminal(job.stage) && this.active.has(job.id)) {
        job.controller.abort();
      }
    }

    await Promise.allSettled([...this.active.values()]);
    await this.uploader.stop?.();
    this.store.close();
  }

  private pump(): void {
    if (this.stopped) {
      return;
    }
    if (this.wakeTimer) {
      clearTimeout(this.wakeTimer);
      this.wakeTimer = undefined;
    }

    while (this.active.size < this.config.queueConcurrency && this.queued.length > 0) {
      const now = this.now();
      const dueIndex = this.queued.findIndex(
        (job) => !job.nextAttemptAt || job.nextAttemptAt <= now,
      );
      if (dueIndex < 0) {
        this.scheduleNextPump();
        break;
      }

      const [job] = this.queued.splice(dueIndex, 1);
      if (!job || job.controller.signal.aborted) {
        continue;
      }

      const task = this.execute(job).finally(() => {
        this.active.delete(job.id);
        this.notifyQueuedPositions();
        this.pump();
      });
      this.active.set(job.id, task);
      void task;
    }
  }

  private scheduleNextPump(): void {
    const next = this.queued
      .map((job) => job.nextAttemptAt)
      .filter((time): time is number => time !== undefined)
      .sort((left, right) => left - right)[0];
    if (next === undefined || this.stopped) {
      return;
    }
    const delay = Math.max(100, next - this.now());
    this.wakeTimer = setTimeout(() => {
      this.wakeTimer = undefined;
      this.pump();
    }, delay);
  }

  private async execute(job: InternalJob): Promise<void> {
    try {
      this.setStage(job, "preparing", true);
      this.throwIfCancelled(job);
      job.attempt += 1;
      job.nextAttemptAt = undefined;
      this.persist(job, `Attempt ${job.attempt}/${job.maxAttempts} started.`);
      job.workspaceDirectory = path.join(this.config.tempDir, job.id);
      await mkdir(job.workspaceDirectory, { recursive: true, mode: 0o700 });

      if (job.uploadAll) {
        // Bulk mode: scan every sub-folder and upload all downloadable files.
        const scanned = await this.resolver.scanAll(job.surl, job.shareDirectory);
        const files = scanned.filter((item) => !item.isFolder && Boolean(item.download) && (item.sizeBytes ?? 0) > 0);
        if (files.length === 0) {
          throw new TransferError("Is share me koi downloadable file nahi mili.", false);
        }
        job.totalFileCount = files.length;
        const totalSize = files.reduce((sum, item) => sum + (item.sizeBytes ?? 0), 0);
        job.sourceSizeBytes = totalSize;

        for (let index = 0; index < files.length; index += 1) {
          this.throwIfCancelled(job);
          const item = files[index];
          job.currentFileIndex = index + 1;
          job.filename = safeFilename(item.relativePath || item.name);
          await this.processFile(job, {
            name: item.name,
            relativePath: item.relativePath,
            sizeBytes: item.sizeBytes,
            download: item.download,
          });
        }
        this.setStage(job, "completed", true);
        return;
      }

      // Single-file mode.
      const { value: share } = await this.resolver.resolve(job.surl, job.shareDirectory);
      const file = this.selectFile(share.files, job.fileIndex);
      if (file.isFolder || !file.download) {
        throw new TransferError("Selected item is a folder or has no downloadable file.", false);
      }
      if (file.sizeBytes === undefined || file.sizeBytes <= 0) {
        throw new TransferError("TeraBox did not provide a usable file size, so safe upload cannot start.", false);
      }
      job.filename = safeFilename(file.name);
      job.sourceSizeBytes = file.sizeBytes;
      await this.processFile(job, {
        name: file.name,
        relativePath: file.name,
        sizeBytes: file.sizeBytes,
        download: file.download,
      });
      this.setStage(job, "completed", true);
    } catch (error) {
      if (job.controller.signal.aborted || error instanceof TransferCancelledError) {
        if (this.stopped) {
          this.requeueAfterInterruption(job, "Interrupted by service shutdown; restarting after boot.");
        } else {
          job.error = undefined;
          this.setStage(job, "cancelled", true, "Cancelled by user.");
        }
      } else {
        const message = truncate(
          error instanceof Error ? error.message : "Unexpected transfer failure.",
          500,
        );
        const retryable = !(error instanceof TransferError) || error.retryable;
        if (retryable && job.attempt < job.maxAttempts) {
          this.requeueAfterFailure(job, message);
        } else {
          job.error = message;
          this.setStage(job, "failed", true, message);
        }
      }
    } finally {
      await this.cleanup(job);
      await job.callbackChain;
      this.pruneHistory();
    }
  }

  /** Downloads + uploads one file (splitting oversized files into ZIP parts). */
  private async processFile(
    job: InternalJob,
    file: { name: string; relativePath: string; sizeBytes?: number; download?: string },
  ): Promise<void> {
    if (!file.download) {
      throw new TransferError(`"${truncate(file.name, 100)}" ka koi download link nahi mila.`, false);
    }
    if (file.sizeBytes === undefined || file.sizeBytes <= 0) {
      throw new TransferError(`"${truncate(file.name, 100)}" ka size mil nahi paya, safe upload nahi ho sakta.`, false);
    }
    if (file.sizeBytes > this.config.maxSourceBytes) {
      throw new TransferError(
        `${truncate(file.name, 100)} is ${formatBytes(file.sizeBytes)}. Server limit is ${formatBytes(this.config.maxSourceBytes)}.`,
        false,
      );
    }

    job.sourceSizeBytes = file.sizeBytes;
    job.transferredBytes = 0;
    job.totalBytes = file.sizeBytes;
    job.lastProgressAt = undefined;
    job.lastProgressBytes = undefined;

    const requiresSplit = file.sizeBytes > this.config.maxUploadBytes;
    if (requiresSplit && !this.config.splitOversizeFiles) {
      throw new TransferError(
        `${truncate(file.name, 100)} is larger than ${formatBytes(this.config.maxUploadBytes)}. ZIP splitting is disabled.`,
        false,
      );
    }
    // Do not trust a remote Content-Length blindly: permit only a small
    // metadata variance so a malformed upstream response cannot fill disk.
    const downloadCeiling = Math.min(
      this.config.maxSourceBytes,
      Math.max(file.sizeBytes + 5_000_000, Math.ceil(file.sizeBytes * 1.05)),
    );
    await this.ensureDiskSpace(job, requiresSplit ? downloadCeiling * 2 : downloadCeiling);

    const safeName = safeFilename(file.name);
    const sourcePath = path.join(job.workspaceDirectory ?? this.config.tempDir, safeName);
    this.setStage(job, "downloading", true);
    await this.downloader.download({
      url: file.download,
      destination: sourcePath,
      expectedBytes: file.sizeBytes,
      maxBytes: downloadCeiling,
      signal: job.controller.signal,
      onProgress: (receivedBytes, totalBytes) => {
        this.updateProgress(job, receivedBytes, totalBytes);
      },
    });
    this.throwIfCancelled(job);

    if (!requiresSplit) {
      await this.uploadOne(job, {
        path: sourcePath,
        name: safeName,
        size: (await stat(sourcePath)).size,
      }, 1, 1, false);
    } else {
      this.setStage(job, "splitting", true);
      job.transferredBytes = undefined;
      job.totalBytes = undefined;
      job.speedBytesPerSecond = undefined;
      job.etaSeconds = undefined;
      const parts = await this.splitter.split({
        sourcePath,
        sourceName: safeName,
        outputDir: job.workspaceDirectory ?? this.config.tempDir,
        partBytes: this.config.splitPartBytes,
        signal: job.controller.signal,
      });
      this.throwIfCancelled(job);
      await rm(sourcePath, { force: true });

      for (let index = 0; index < parts.length; index += 1) {
        await this.uploadOne(job, parts[index], index + 1, parts.length, true);
      }
    }
    await rm(sourcePath, { force: true }).catch(() => undefined);
  }

  private requeueAfterFailure(job: InternalJob, reason: string): void {
    const delay = Math.min(
      this.config.retryBaseDelayMs * 2 ** Math.max(0, job.attempt - 1),
      60 * 60 * 1_000,
    );
    job.error = `Attempt ${job.attempt}/${job.maxAttempts} failed: ${reason}`;
    job.nextAttemptAt = this.now() + delay;
    job.transferredBytes = undefined;
    job.totalBytes = undefined;
    job.speedBytesPerSecond = undefined;
    job.etaSeconds = undefined;
    job.partIndex = undefined;
    job.partCount = undefined;
    job.lastProgressAt = undefined;
    job.lastProgressBytes = undefined;
    this.setStage(job, "queued", true, `Retry scheduled in ${Math.ceil(delay / 1_000)} seconds.`);
    this.queued.push(job);
  }

  private requeueAfterInterruption(job: InternalJob, reason: string): void {
    job.error = reason;
    job.nextAttemptAt = this.now();
    job.transferredBytes = undefined;
    job.totalBytes = undefined;
    job.speedBytesPerSecond = undefined;
    job.etaSeconds = undefined;
    job.partIndex = undefined;
    job.partCount = undefined;
    this.setStage(job, "queued", true, reason);
    // Do not push into this manager's queue: it is shutting down. The SQLite
    // record will be rehydrated by the next process.
  }

  private async uploadOne(
    job: InternalJob,
    part: ArchivePart,
    partIndex: number,
    partCount: number,
    isSplitArchive: boolean,
  ): Promise<void> {
    this.throwIfCancelled(job);
    if (part.size > this.config.maxUploadBytes) {
      throw new TransferError(
        `Upload part ${part.name} is ${formatBytes(part.size)}, above the configured Telegram limit of ${formatBytes(this.config.maxUploadBytes)}.`,
        false,
      );
    }
    this.setStage(job, "uploading", true);
    job.partIndex = partIndex;
    job.partCount = partCount;
    job.transferredBytes = 0;
    job.totalBytes = part.size;
    job.speedBytesPerSecond = undefined;
    job.etaSeconds = undefined;
    void this.notify(job, true);

    const archiveNote = isSplitArchive
      ? `\nZIP part ${partIndex}/${partCount}. Download all parts, keep them together, then open the final .zip file.`
      : "";
    await this.uploader.upload({
      chatId: job.chatId,
      replyToMessageId: job.replyToMessageId,
      filePath: part.path,
      fileName: part.name,
      caption: `${truncate(job.filename ?? part.name, 700)}${archiveNote}`,
      mediaMode: chooseMediaMode(part.name, this.config.mediaMode, isSplitArchive),
      signal: job.controller.signal,
      onProgress: (progress) => {
        const normalized = Math.max(0, Math.min(1, progress));
        this.updateProgress(job, Math.round(part.size * normalized), part.size);
      },
    });
    this.throwIfCancelled(job);
  }

  private selectFile(files: TeraBoxFile[], requestedIndex?: number): TeraBoxFile {
    if (requestedIndex !== undefined) {
      const selected = files[requestedIndex - 1];
      if (!selected) {
        throw new TransferError(`File #${requestedIndex} was not found in this share.`, false);
      }
      return selected;
    }

    const firstDownloadable = files.find((file) => !file.isFolder && Boolean(file.download));
    if (!firstDownloadable) {
      throw new TransferError("No downloadable file was found in this share.", false);
    }
    return firstDownloadable;
  }

  private async ensureDiskSpace(job: InternalJob, primaryBytes: number): Promise<void> {
    await mkdir(this.config.tempDir, { recursive: true, mode: 0o700 });
    const required = primaryBytes + this.config.diskSafetyBytes;
    const free = await this.getFreeBytes(this.config.tempDir).catch(() => {
      throw new TransferError("Could not determine free disk space for this transfer.", false);
    });
    if (!Number.isFinite(free) || free < required) {
      throw new TransferError(
        `Insufficient server disk space. Need about ${formatBytes(required)}, available ${formatBytes(free)}.`,
        false,
      );
    }
    this.throwIfCancelled(job);
  }

  private updateProgress(job: InternalJob, transferredBytes: number, totalBytes: number): void {
    const currentTime = this.now();
    if (job.lastProgressAt !== undefined && job.lastProgressBytes !== undefined) {
      const elapsedSeconds = (currentTime - job.lastProgressAt) / 1_000;
      const byteDelta = transferredBytes - job.lastProgressBytes;
      if (elapsedSeconds > 0 && byteDelta >= 0) {
        const speed = byteDelta / elapsedSeconds;
        if (Number.isFinite(speed) && speed > 0) {
          job.speedBytesPerSecond = speed;
          job.etaSeconds = totalBytes > transferredBytes ? (totalBytes - transferredBytes) / speed : 0;
        }
      }
    }
    job.lastProgressAt = currentTime;
    job.lastProgressBytes = transferredBytes;
    job.transferredBytes = transferredBytes;
    job.totalBytes = totalBytes;
    job.updatedAt = new Date(currentTime);
    void this.notify(job, false);
  }

  private setStage(
    job: InternalJob,
    stage: TransferStage,
    notify: boolean,
    eventMessage?: string,
  ): void {
    job.stage = stage;
    job.updatedAt = new Date(this.now());
    if (stage !== "uploading") {
      job.partIndex = stage === "completed" ? job.partIndex : undefined;
      job.partCount = stage === "completed" ? job.partCount : undefined;
    }
    this.persist(job, eventMessage);
    if (notify) {
      void this.notify(job, true);
    }
  }

  private snapshot(job: InternalJob): TransferSnapshot {
    const queueIndex = job.stage === "queued" ? this.queued.indexOf(job) : -1;
    const progress =
      job.transferredBytes !== undefined && job.totalBytes !== undefined && job.totalBytes > 0
        ? Math.max(0, Math.min(1, job.transferredBytes / job.totalBytes))
        : undefined;
    return {
      id: job.id,
      chatId: job.chatId,
      ...(job.ownerUserId !== undefined && { ownerUserId: job.ownerUserId }),
      replyToMessageId: job.replyToMessageId,
      ...(job.statusMessageId !== undefined && { statusMessageId: job.statusMessageId }),
      stage: job.stage,
      createdAt: job.createdAt.toISOString(),
      updatedAt: job.updatedAt.toISOString(),
      ...(queueIndex >= 0 && { queuePosition: queueIndex + 1 }),
      ...(job.filename && { filename: job.filename }),
      ...(job.sourceSizeBytes !== undefined && { sourceSizeBytes: job.sourceSizeBytes }),
      ...(job.transferredBytes !== undefined && { transferredBytes: job.transferredBytes }),
      ...(job.totalBytes !== undefined && { totalBytes: job.totalBytes }),
      ...(progress !== undefined && { progress }),
      ...(job.speedBytesPerSecond !== undefined && { speedBytesPerSecond: job.speedBytesPerSecond }),
      ...(job.etaSeconds !== undefined && { etaSeconds: job.etaSeconds }),
      ...(job.partIndex !== undefined && { partIndex: job.partIndex }),
      ...(job.partCount !== undefined && { partCount: job.partCount }),
      ...(job.totalFileCount !== undefined && { totalFileCount: job.totalFileCount }),
      ...(job.currentFileIndex !== undefined && { currentFileIndex: job.currentFileIndex }),
      attempt: job.attempt,
      maxAttempts: job.maxAttempts,
      ...(job.nextAttemptAt !== undefined && { nextAttemptAt: new Date(job.nextAttemptAt).toISOString() }),
      ...(job.error && { error: job.error }),
    };
  }

  private async notify(job: InternalJob, force: boolean): Promise<void> {
    const currentTime = this.now();
    if (!force && currentTime - job.lastNotificationAt < this.config.progressIntervalMs) {
      return;
    }
    job.lastNotificationAt = currentTime;
    job.updatedAt = new Date(currentTime);
    this.persist(job);
    const snapshot = this.snapshot(job);
    // Live web-UI subscribers fire and forget.
    for (const subscriber of this.liveSubscribers) {
      try {
        subscriber(snapshot);
      } catch {
        // A bad subscriber must never break transfers.
      }
    }
    const callback = job.callback ?? this.globalNotifier;
    if (!callback) {
      return;
    }
    job.callbackChain = job.callbackChain
      .then(async () => {
        await callback(snapshot);
      })
      // Telegram progress-message edits are best-effort. A temporary edit
      // failure must never cancel a large file transfer.
      .catch(() => undefined);
    await job.callbackChain;
  }

  private notifyQueuedPositions(): void {
    for (const job of this.queued) {
      void this.notify(job, true);
    }
  }

  private throwIfCancelled(job: InternalJob): void {
    if (job.controller.signal.aborted || this.stopped) {
      throw new TransferCancelledError();
    }
  }

  private persist(job: InternalJob, eventMessage?: string): void {
    const stored: StoredTransfer = {
      id: job.id,
      chatId: job.chatId,
      ownerUserId: job.ownerUserId,
      replyToMessageId: job.replyToMessageId,
      statusMessageId: job.statusMessageId,
      surl: job.surl,
      directory: job.shareDirectory,
      fileIndex: job.fileIndex,
      uploadAll: job.uploadAll,
      stage: job.stage,
      createdAtMs: job.createdAt.getTime(),
      updatedAtMs: job.updatedAt.getTime(),
      filename: job.filename,
      sourceSizeBytes: job.sourceSizeBytes,
      transferredBytes: job.transferredBytes,
      totalBytes: job.totalBytes,
      speedBytesPerSecond: job.speedBytesPerSecond,
      etaSeconds: job.etaSeconds,
      partIndex: job.partIndex,
      partCount: job.partCount,
      error: job.error,
      attempt: job.attempt,
      maxAttempts: job.maxAttempts,
      nextAttemptAtMs: job.nextAttemptAt,
    };
    this.store.save(stored);
    if (eventMessage) {
      this.store.addEvent(job.id, job.updatedAt.getTime(), job.stage, eventMessage);
    }
  }

  private fromStored(stored: StoredTransfer): InternalJob {
    return {
      id: stored.id,
      chatId: stored.chatId,
      ownerUserId: stored.ownerUserId,
      replyToMessageId: stored.replyToMessageId,
      statusMessageId: stored.statusMessageId,
      surl: stored.surl,
      shareDirectory: stored.directory,
      fileIndex: stored.fileIndex,
      uploadAll: stored.uploadAll,
      stage: stored.stage,
      controller: new AbortController(),
      createdAt: new Date(stored.createdAtMs),
      updatedAt: new Date(stored.updatedAtMs),
      callbackChain: Promise.resolve(),
      lastNotificationAt: 0,
      filename: stored.filename,
      sourceSizeBytes: stored.sourceSizeBytes,
      transferredBytes: stored.transferredBytes,
      totalBytes: stored.totalBytes,
      speedBytesPerSecond: stored.speedBytesPerSecond,
      etaSeconds: stored.etaSeconds,
      partIndex: stored.partIndex,
      partCount: stored.partCount,
      attempt: stored.attempt,
      maxAttempts: stored.maxAttempts,
      nextAttemptAt: stored.nextAttemptAtMs,
      error: stored.error,
    };
  }

  private async cleanupStaleWorkspaces(): Promise<void> {
    await mkdir(this.config.tempDir, { recursive: true, mode: 0o700 });
    const entries = await readdir(this.config.tempDir, { withFileTypes: true }).catch(() => []);
    await Promise.all(
      entries
        .filter((entry) => entry.isDirectory() && /^[a-f0-9]{10}$/i.test(entry.name))
        .map((entry) => rm(path.join(this.config.tempDir, entry.name), { recursive: true, force: true })),
    );
  }

  private async cleanup(job: InternalJob): Promise<void> {
    if (job.workspaceDirectory) {
      await rm(job.workspaceDirectory, { recursive: true, force: true }).catch(() => undefined);
      job.workspaceDirectory = undefined;
    }
  }

  private pruneHistory(): void {
    const completed = [...this.jobs.values()]
      .filter((job) => isTerminal(job.stage))
      .sort((left, right) => left.updatedAt.getTime() - right.updatedAt.getTime());
    while (completed.length > this.config.historyLimit) {
      const oldest = completed.shift();
      if (oldest) {
        this.jobs.delete(oldest.id);
      }
    }
    this.store.trim(this.config.historyLimit);
  }
}
