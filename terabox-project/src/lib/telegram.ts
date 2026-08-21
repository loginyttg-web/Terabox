import { randomUUID } from "node:crypto";
import path from "node:path";
import type { TelegramConfig } from "../config.js";
import type { AccessStore } from "./access-store.js";
import { logBuffer } from "./logs.js";
import { type ShareResolver } from "./share-service.js";
import { type ResolvedShare, type TeraBoxFile, TeraBoxError } from "./terabox.js";
import { type TransferManagerLike, type TransferRequest, type TransferSnapshot } from "./transfer.js";
import {
  escapeHtml,
  extractSharePassword,
  extractSurl,
  findAllShareUrls,
  findShareUrl,
  formatBytes,
  formatProgressBar,
  getFileIcon,
  truncate,
} from "./utils.js";

// --- Telegram API types ---
interface TelegramUser {
  id: number;
  first_name?: string;
  last_name?: string;
  username?: string;
}
interface TelegramChat {
  id: number;
  type?: string;
}
interface TelegramMessage {
  message_id: number;
  chat: TelegramChat;
  from?: TelegramUser;
  text?: string;
}
interface TelegramSentMessage {
  message_id: number;
  chat: TelegramChat;
}
interface TelegramCallbackQuery {
  id: string;
  from: TelegramUser;
  message?: TelegramMessage;
  data?: string;
}
interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
}
interface InlineKeyboardButton {
  text: string;
  url?: string;
  callback_data?: string;
}
interface InlineKeyboardMarkup {
  inline_keyboard: InlineKeyboardButton[][];
}
interface BrowserSession {
  id: string;
  chatId: number;
  userId: number;
  surl: string;
  directory?: string;
  files: TeraBoxFile[];
  page: number;
  expiresAt: number;
  totalSize?: number;
}
interface TelegramBotIdentity {
  username?: string;
}
interface TelegramApiEnvelope<T> {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
}
export interface TelegramBotStatus {
  enabled: true;
  running: boolean;
  username?: string;
  lastSuccessfulPollAt?: string;
  lastError?: string;
}
export interface TelegramBotOptions {
  config: TelegramConfig;
  resolver: ShareResolver;
  transferManager?: TransferManagerLike;
  accessStore?: AccessStore;
  fetchImpl?: typeof fetch;
  logger?: Pick<Console, "info" | "warn" | "error">;
}

class TelegramApiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TelegramApiError";
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error";
}
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(cleanup, ms);
    const onAbort = () => cleanup();
    function cleanup(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve();
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
function extractCommand(text: string): { command: string; argument: string; addressedTo?: string } | null {
  const match = text.trim().match(/^\/([a-zA-Z0-9_]+)(?:@([a-zA-Z0-9_]+))?(?:\s+([\s\S]*))?$/);
  if (!match?.[1]) return null;
  return {
    command: match[1].toLowerCase(),
    addressedTo: match[2]?.toLowerCase(),
    argument: match[3]?.trim() ?? "",
  };
}

const BROWSER_PAGE_SIZE = 6;
const BROWSER_SESSION_TTL_MS = 45 * 60 * 1_000;

// ===================== PREMIUM UI MESSAGES =====================

function brandHeader(): string {
  return "🚀 <b>TeraBox Pro Bot</b> — Ultra Fast Resolver";
}

function welcomeMessage(firstName: string, uploadEnabled: boolean): string {
  const name = escapeHtml(firstName || "Friend");
  return [
    `👋 Hey <b>${name}</b>! Welcome to <b>TeraBox Pro</b> ✨`,
    "",
    "🔥 <b>Main kya kar sakta hoon?</b>",
    "• 📂 TeraBox links ko turant resolve",
    "• 🔍 Sub-folders ka deep scan",
    "• ⬇️ Direct download links generate",
    "• 📱 Beautiful file browser",
    uploadEnabled ? "• ⬆️ Telegram par direct upload (up to 2GB per file, >2GB auto-split ZIP)" : "",
    "• 🌐 60+ TeraBox domains supported",
    "",
    "💡 <b>Kaise use karein?</b>",
    "Bas koi bhi TeraBox link bhejo — jaise:",
    "<code>https://terabox.com/s/1AbCdEfGh</code>",
    "",
    "📚 Commands dekhne ke liye /help dabao",
    "🆔 Apna ID dekhne ke liye /id",
    "",
    "⚡ <i>Powered by Railway • Fast • Secure • No Ads</i>",
  ]
    .filter(Boolean)
    .join("\n");
}

function helpMessage(uploadEnabled: boolean): string {
  return [
    brandHeader(),
    "",
    "📖 <b>Complete Command Guide</b>",
    "",
    "🔗 <b>LINK RESOLVE:</b>",
    "• <code>/link &lt;URL&gt;</code> — Single link resolve + browser",
    "• <code>/scan &lt;URL&gt;</code> — Deep scan (all sub-folders, up to 10k files)",
    "• <i>Ya bas link bhejo, auto-detect ho jayega!</i>",
    "• <i>Multiple links ek saath bhi bhej sakte ho</i>",
    "",
    "📤 <b>UPLOAD (agar enabled ho):</b>",
    ...(uploadEnabled
      ? [
          "• <code>/upload &lt;URL&gt; [n]</code> — n-th file upload karo",
          "• <code>/uploadall &lt;URL&gt;</code> — Poora folder upload (recursive)",
          "• <code>/jobs</code> — Active uploads dekho",
          "• <code>/stats</code> — Server stats + queue info",
          "• <code>/cancel [id]</code> — Upload cancel karo",
        ]
      : ["• <i>Uploads currently disabled on this server</i>"]),
    "",
    "🛠️ <b>ADMIN / OWNER:</b>",
    "• <code>/setcookie {\"ndus\":\"...\"}</code> — Cookies update (no restart)",
    "• <code>/logs</code> — Last 50 log lines",
    "• <code>/status</code> — Bot + cache + upload status",
    "• <code>/id</code> — Apna User ID / Chat ID",
    "• <code>/access &lt;id&gt;</code> / <code>/revoke &lt;id&gt;</code> — User manage (owner)",
    "• <code>/users</code> — Allowed users list (owner)",
    "",
    "✨ <b>NEW FEATURES:</b>",
    "• <code>/about</code> — Bot ke baare me",
    "• <code>/features</code> — Saare features ki list",
    "• <code>/ping</code> — Speed test",
    "• <code>/donate</code> — Support karo",
    "",
    "🌐 <b>Supported Domains (60+):</b>",
    "<code>terabox.com, terabox.app, 1024terabox.com, teraboxlink.com, terasharelink.com, freeterabox.com, 4funbox.com, mirrobox.com, nephobox.com, dubox.com + 50 more</code>",
    "",
    "💡 <b>Tips:</b>",
    "• Folder ke andar jaane ke liye browser buttons use karo",
    "• Badi files (>2GB) auto ZIP parts me split hongi",
    "• Password wale links me <code>?pwd=YOURPASS</code> add karo",
    "",
    "❓ Problem? Owner se contact karo ya /id bhejo.",
  ].join("\n");
}

function aboutMessage(): string {
  return [
    "ℹ️ <b>About TeraBox Pro Bot</b>",
    "",
    "🚀 <b>Version:</b> 3.0 Pro (Railway Edition)",
    "👨‍💻 <b>Built for:</b> Fast, reliable TeraBox resolving",
    "⚡ <b>Tech:</b> Node.js 22 + SQLite + MTProto",
    "🌍 <b>Uptime:</b> 24/7 on Railway",
    "",
    "🔥 <b>What makes us different?</b>",
    "• No ads, no spam, no tracking",
    "• 60+ domains, auto-fallback origins",
    "• Beautiful UI with progress bars",
    "• Multi-link support, deep scan",
    "• Real-time transfer dashboard (/admin)",
    "• Secure cookie management",
    "",
    "📊 <b>Stats:</b>",
    "• Supports files up to 20GB source (configurable)",
    "• Parallel chunk download (up to 16x faster)",
    "• Smart caching (2hr TTL)",
    "",
    "💙 Made with love for TeraBox users",
    "🔗 GitHub: github.com/loginyttg-web/Terabox",
  ].join("\n");
}

function featuresMessage(): string {
  return [
    "✨ <b>TeraBox Pro — All Features</b>",
    "",
    "🔗 <b>Link Support:</b>",
    "• 60+ domains: terabox.com, terabox.app, 1024terabox, 4funbox, mirrobox, nephobox, dubox, etc.",
    "• Auto-detect surl from any URL shape (/s/, ?surl=, /sharing/link)",
    "• Password-protected links (pwd param)",
    "• Multi-link in one message",
    "",
    "📂 <b>Browsing:</b>",
    "• Interactive file browser with pagination",
    "• Folder navigation (back, next, prev)",
    "• File icons based on type (🎬 video, 🎵 audio, 🖼️ image, etc.)",
    "• Total size calculation",
    "• Breadcrumb path",
    "",
    "🔍 <b>Scanning:</b>",
    "• Deep recursive scan (15 levels, 10k files)",
    "• Total size + file/folder count",
    "• Relative paths preserved",
    "",
    "📤 <b>Upload (Optional):</b>",
    "• Direct to Telegram via MTProto",
    "• >2GB auto ZIP split (safe for Telegram 2GB limit)",
    "• Parallel chunk download (16 connections)",
    "• Queue system, retry, cancel",
    "• Progress bar + speed + ETA",
    "",
    "🛡️ <b>Security:</b>",
    "• Owner-only access control",
    "• Runtime cookie update",
    "• No cookie logging",
    "• Rate limiting (API)",
    "",
    "📊 <b>Admin:</b>",
    "• Live dashboard at /admin (SSE real-time)",
    "• Logs, stats, job history",
    "• Dump channel for tracking",
    "",
    "🚀 <b>Deployment:</b>",
    "• One-click Railway deploy",
    "• Docker ready",
    "• Health check at /health",
  ].join("\n");
}

/** Formats a share result for Telegram — premium UI */
export function formatShareMessage(share: ResolvedShare, maximumFiles: number): string {
  if (share.files.length === 0) {
    return [
      "😕 <b>Koi file nahi mili</b>",
      "",
      "• Link expired ho sakta hai",
      "• Password chahiye ho sakta hai (<code>?pwd=pass</code> add karo)",
      "• Cookie expired — owner ko /setcookie se update karna hoga",
      "",
      "🔁 Phir se try karo ya /help dekho.",
    ].join("\n");
  }

  const totalSize = share.totalSizeBytes ?? share.files.reduce((s, f) => s + (f.sizeBytes ?? 0), 0);
  const folders = share.files.filter((f) => f.isFolder).length;
  const files = share.files.filter((f) => !f.isFolder).length;

  const limit = Math.max(1, maximumFiles);
  const visibleFiles = share.files.slice(0, limit);
  let message = [
    `✅ <b>${share.files.length} items found</b> ${totalSize ? `• ${escapeHtml(formatBytes(totalSize))}` : ""}`,
    `${folders ? `📁 ${folders} folders` : ""} ${files ? `📄 ${files} files` : ""}`.trim(),
    share.directory ? `📂 Path: <code>${escapeHtml(truncate(share.directory, 80))}</code>` : "",
    "",
    "<b>📋 File List:</b>",
  ]
    .filter(Boolean)
    .join("\n");

  let displayedCount = 0;
  let omittedForLength = false;

  for (let index = 0; index < visibleFiles.length; index += 1) {
    const file = visibleFiles[index];
    const icon = getFileIcon(file.name, file.isFolder);
    const size = file.sizeBytes !== undefined ? ` • ${escapeHtml(formatBytes(file.sizeBytes))}` : "";
    const type = file.isFolder ? " <i>[Folder]</i>" : "";
    const line = `${icon} <b>${index + 1}. ${escapeHtml(truncate(file.name, 120))}</b>${size}${type}`;
    const block = `\n${line}`;

    if (message.length + block.length > 3500) {
      omittedForLength = true;
      break;
    }
    message += block;
    displayedCount += 1;
  }

  if (share.files.length > displayedCount || omittedForLength) {
    message += `\n\n<i>... aur ${share.files.length - displayedCount} items. Browser me sab dekho 👇</i>`;
  }

  return message;
}

function formatDuration(seconds: number | undefined): string | undefined {
  if (seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return undefined;
  if (seconds < 60) return `${Math.ceil(seconds)}s`;
  if (seconds < 3600) return `${Math.ceil(seconds / 60)}m`;
  return `${(seconds / 3600).toFixed(1)}h`;
}

/** Premium transfer status with progress bar */
export function formatTransferStatus(job: TransferSnapshot): string {
  const title = job.filename ? escapeHtml(truncate(job.filename, 140)) : "TeraBox file";
  const id = escapeHtml(job.id);
  const icon = getFileIcon(job.filename || "", false);
  const bulkNote =
    job.totalFileCount && job.currentFileIndex ? `\n📦 File ${job.currentFileIndex}/${job.totalFileCount}` : "";
  const size = job.sourceSizeBytes !== undefined ? `\n📦 Size: ${escapeHtml(formatBytes(job.sourceSizeBytes))}` : "";
  const progressBar =
    job.progress !== undefined ? `\n${formatProgressBar(job.progress, 14)}` : "";
  const bytes =
    job.transferredBytes !== undefined && job.totalBytes !== undefined
      ? `\n📊 ${escapeHtml(formatBytes(job.transferredBytes))} / ${escapeHtml(formatBytes(job.totalBytes))}`
      : "";
  const speed = job.speedBytesPerSecond ? `\n⚡ Speed: ${escapeHtml(formatBytes(job.speedBytesPerSecond))}/s` : "";
  const eta = formatDuration(job.etaSeconds);
  const etaLine = eta ? ` • ⏱️ ETA ${escapeHtml(eta)}` : "";

  const footer = `\n\n🆔 <code>${id}</code>`;

  if (job.stage === "queued") {
    const retry = job.nextAttemptAt
      ? `\n🔁 Retry ${Math.min((job.attempt ?? 0) + 1, job.maxAttempts ?? 1)}/${job.maxAttempts ?? 1} at ${escapeHtml(new Date(job.nextAttemptAt).toLocaleTimeString())}`
      : "";
    const pos = job.queuePosition ? `\n📍 Queue: #${job.queuePosition}` : "";
    return `⏳ <b>Queued — Waiting in line</b>\n${icon} ${title}${bulkNote}${size}${pos}${retry}${footer}`;
  }
  if (job.stage === "preparing") {
    return `🔎 <b>Preparing transfer...</b>\n${icon} ${title}${bulkNote}${size}\n<i>Resolving TeraBox link & checking disk space</i>${footer}`;
  }
  if (job.stage === "downloading") {
    return `⬇️ <b>Downloading from TeraBox</b>\n${icon} ${title}${bulkNote}${progressBar}${bytes}${speed}${etaLine}${footer}`;
  }
  if (job.stage === "splitting") {
    return `🗜️ <b>Creating ZIP parts</b>\n${icon} ${title}${bulkNote}${size}\n<i>File >2GB hai, Telegram-safe ZIP parts bana raha hoon...</i>${footer}`;
  }
  if (job.stage === "uploading") {
    const part = job.partCount && job.partCount > 1 ? `\n📦 Part ${job.partIndex ?? 1}/${job.partCount}` : "";
    return `⬆️ <b>Uploading to Telegram</b>\n${icon} ${title}${bulkNote}${part}${progressBar}${bytes}${speed}${etaLine}${footer}`;
  }
  if (job.stage === "completed") {
    const parts =
      job.partCount && job.partCount > 1
        ? `\n\n✅ <b>${job.partCount} ZIP parts sent!</b>\n<i>Sab parts download karke ek folder me rakho, phir final .zip open karo.</i>`
        : "\n\n🎉 <b>Done! File Telegram par bhej di gayi.</b>";
    return `✅ <b>Transfer Complete!</b>\n${icon} ${title}${parts}${footer}`;
  }
  if (job.stage === "cancelled") {
    return `⏹️ <b>Transfer Cancelled</b>\n${icon} ${title}${footer}\n<i>User ne cancel kiya.</i>`;
  }
  return `❌ <b>Transfer Failed</b>\n${icon} ${title}\n⚠️ ${escapeHtml(job.error ?? "Unknown error")}${footer}\n<i>Thodi der baad /upload se retry karo.</i>`;
}

// ===================== BOT CORE =====================

export class TelegramBot {
  private readonly config: TelegramConfig;
  private readonly resolver: ShareResolver;
  private readonly transferManager: TransferManagerLike | undefined;
  private readonly accessStore: AccessStore | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly logger: Pick<Console, "info" | "warn" | "error">;
  private readonly stopController = new AbortController();
  private pollingTask?: Promise<void>;
  private offset: number | undefined;
  private username: string | undefined;
  private running = false;
  private lastSuccessfulPollAt: string | undefined;
  private lastError: string | undefined;
  private transferRecoveryStarted = false;
  private readonly browserSessions = new Map<string, BrowserSession>();

  constructor(options: TelegramBotOptions) {
    this.config = options.config;
    this.resolver = options.resolver;
    this.transferManager = options.transferManager;
    this.accessStore = options.accessStore;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.logger = options.logger ?? console;
    this.transferManager?.setNotifier?.(async (snapshot) => {
      await this.updateTransferStatus(snapshot);
    });
  }

  start(): void {
    if (this.pollingTask) return;
    this.pollingTask = this.poll().finally(() => {
      this.running = false;
    });
  }

  async stop(): Promise<void> {
    this.stopController.abort();
    await this.pollingTask;
  }

  getStatus(): TelegramBotStatus {
    return {
      enabled: true,
      running: this.running,
      ...(this.username && { username: this.username }),
      ...(this.lastSuccessfulPollAt && { lastSuccessfulPollAt: this.lastSuccessfulPollAt }),
      ...(this.lastError && { lastError: this.lastError }),
    };
  }

  private async poll(): Promise<void> {
    this.running = true;
    let failedPolls = 0;

    while (!this.stopController.signal.aborted) {
      try {
        if (!this.username) {
          const identity = await this.call<TelegramBotIdentity>("getMe", {}, 15_000);
          this.username = identity.username?.toLowerCase();
          this.logger.info(`[telegram] Connected${this.username ? ` as @${this.username}` : ""}.`);
          await this.registerCommands().catch(() => undefined);
        }
        if (!this.transferRecoveryStarted && this.transferManager?.recover) {
          await this.transferManager.recover();
          this.transferRecoveryStarted = true;
        }

        const updates = await this.call<TelegramUpdate[]>(
          "getUpdates",
          {
            ...(this.offset !== undefined && { offset: this.offset }),
            timeout: this.config.pollingTimeoutSeconds,
            allowed_updates: ["message", "callback_query"],
          },
          Math.max(this.config.requestTimeoutMs, (this.config.pollingTimeoutSeconds + 10) * 1_000),
        );

        failedPolls = 0;
        this.lastError = undefined;
        this.lastSuccessfulPollAt = new Date().toISOString();

        for (const update of updates) {
          this.offset = update.update_id + 1;
          await this.handleUpdate(update);
        }
      } catch (error) {
        if (this.stopController.signal.aborted) break;
        failedPolls += 1;
        this.lastError = errorMessage(error);
        this.logger.warn(`[telegram] Polling failed: ${this.lastError}`);
        const delay = Math.min(1_000 * 2 ** Math.min(failedPolls - 1, 5), 30_000);
        await sleep(delay, this.stopController.signal);
      }
    }
  }

  private async handleUpdate(update: TelegramUpdate): Promise<void> {
    if (update.callback_query) {
      await this.handleCallbackQuery(update.callback_query);
      return;
    }

    const message = update.message;
    if (!message?.from || !message.text) return;

    const text = message.text.trim();
    const command = extractCommand(text);

    if (command?.command === "start" || command?.command === "help") {
      await this.notifyUserActivity(message.from, message.chat.id);
    }

    if (!this.isAllowed(message.from.id)) {
      await this.sendHtml(
        message,
        `⛔ <b>Access Restricted</b>\n\nHey ${escapeHtml(message.from.first_name || "there")}! Ye bot private hai.\n\n🆔 <b>Your ID:</b> <code>${message.from.id}</code>\n💬 Isko owner ko bhejo access ke liye.\n\n📩 Owner ko bolo: <code>/access ${message.from.id}</code> chalaye.\n\n🔒 <i>Security reason se sirf allowed users hi use kar sakte hain.</i>`,
      );
      return;
    }

    if (command) {
      if (command.addressedTo && this.username && command.addressedTo !== this.username) return;

      switch (command.command) {
        case "start": {
          const firstName = message.from.first_name || "Friend";
          const kb: InlineKeyboardMarkup = {
            inline_keyboard: [
              [
                { text: "📖 Help", callback_data: "help" },
                { text: "✨ Features", callback_data: "features" },
              ],
              [
                { text: "🆔 My ID", callback_data: "myid" },
                { text: "ℹ️ About", callback_data: "about" },
              ],
              [
                { text: "📊 Status", callback_data: "status" },
              ],
            ],
          };
          await this.sendHtml(message, welcomeMessage(firstName, Boolean(this.transferManager)), kb);
          return;
        }
        case "help": {
          await this.sendHtml(message, helpMessage(Boolean(this.transferManager)));
          return;
        }
        case "about": {
          await this.sendHtml(message, aboutMessage());
          return;
        }
        case "features": {
          await this.sendHtml(message, featuresMessage());
          return;
        }
        case "ping": {
          const start = Date.now();
          const sent = await this.sendHtml(message, "🏓 <b>Pinging...</b> ⚡");
          const ms = Date.now() - start;
          await this.editHtml(
            sent.chat.id,
            sent.message_id,
            `🏓 <b>Pong!</b>\n\n⚡ Latency: <code>${ms}ms</code>\n🤖 Bot: @${escapeHtml(this.username || "unknown")}\n📦 Cache: ${this.resolver.cacheSize} items\n⏰ Time: ${new Date().toLocaleString()}`,
          );
          return;
        }
        case "donate": {
          await this.sendHtml(
            message,
            [
              "💖 <b>Support TeraBox Pro Bot</b>",
              "",
              "Agar bot pasand aaya to support karo!",
              "",
              "☕ <b>Ways to support:</b>",
              "• Bot ko apne dosto ke saath share karo",
              "• GitHub par ⭐ star do",
              "• Feedback bhejo — kya improve karein?",
              "",
              "🙏 <i>Thanks for using TeraBox Pro!</i>",
            ].join("\n"),
          );
          return;
        }
        case "id": {
          await this.sendHtml(
            message,
            [
              "🆔 <b>Your IDs</b>",
              "",
              `👤 User ID: <code>${message.from.id}</code>`,
              `💬 Chat ID: <code>${message.chat.id}</code>`,
              `👋 Name: ${escapeHtml([message.from.first_name, message.from.last_name].filter(Boolean).join(" ") || "Unknown")}`,
              message.from.username ? `🔗 Username: @${escapeHtml(message.from.username)}` : "",
              "",
              "📩 <i>Ye ID owner ko bhejo access ke liye: </i><code>/access " + message.from.id + "</code>",
            ]
              .filter(Boolean)
              .join("\n"),
          );
          return;
        }
        case "access":
        case "revoke":
        case "users": {
          await this.handleAccessCommand(message, command);
          return;
        }
        case "status": {
          const tm = this.transferManager?.getStatus();
          const statusText = [
            "📊 <b>Bot Status — Live</b>",
            "",
            `🤖 Bot: @${escapeHtml(this.username || "unknown")} • ${this.running ? "🟢 Online" : "🔴 Offline"}`,
            `📦 Cache: ${this.resolver.cacheSize} items`,
            `⏰ Last poll: ${this.lastSuccessfulPollAt ? new Date(this.lastSuccessfulPollAt).toLocaleTimeString() : "—"}`,
            tm ? `⬆️ Uploads: ${tm.enabled ? "Enabled" : "Disabled"} • Active ${tm.active_jobs ?? 0} • Queued ${tm.queued_jobs ?? 0}` : "⬆️ Uploads: Disabled",
            this.lastError ? `⚠️ Last error: ${escapeHtml(truncate(this.lastError, 120))}` : "✅ No errors",
            "",
            "💡 <i>Send any TeraBox link to test resolver</i>",
          ].join("\n");
          await this.sendHtml(message, statusText);
          return;
        }
        case "link": {
          await this.resolveMessageLink(message, command.argument);
          return;
        }
        case "scan": {
          await this.scanShare(message, command.argument);
          return;
        }
        case "setcookie": {
          await this.setCookieCommand(message, command.argument);
          return;
        }
        case "logs": {
          await this.sendLogs(message);
          return;
        }
        case "upload": {
          await this.enqueueUpload(message, command.argument);
          return;
        }
        case "uploadall": {
          await this.enqueueUploadAll(message, command.argument);
          return;
        }
        case "jobs": {
          await this.showJobs(message);
          return;
        }
        case "stats": {
          await this.showTransferStats(message);
          return;
        }
        case "cancel": {
          await this.cancelUpload(message, command.argument);
          return;
        }
        default: {
          await this.sendHtml(
            message,
            `❓ Unknown command <code>/${escapeHtml(command.command)}</code>\n\n📖 /help se saare commands dekho.\n🚀 Bas TeraBox link bhejo, main resolve kar dunga!`,
          );
          return;
        }
      }
    }

    // No command — treat as link(s)
    await this.resolveMessageLink(message, text);
  }

  private async resolveMessageLink(message: TelegramMessage, source: string): Promise<void> {
    const allUrls = findAllShareUrls(source);
    const primaryUrl = allUrls.length > 0 ? allUrls[0] : findShareUrl(source);
    const surl = primaryUrl ? extractSurl(primaryUrl) : null;

    if (!surl) {
      await this.sendHtml(
        message,
        [
          "😕 <b>TeraBox link nahi mila</b>",
          "",
          "📎 Sahi format me link bhejo, jaise:",
          "<code>https://terabox.com/s/1AbCdEfGh</code>",
          "<code>https://terabox.app/sharing/link?surl=AbCdEfGh</code>",
          "",
          "🌐 Supported: terabox.com, terabox.app, 1024terabox, 4funbox, mirrobox, nephobox, dubox + 50 more",
          "",
          "💡 /help se guide dekho ya multiple links ek saath bhejo!",
        ].join("\n"),
      );
      return;
    }

    const pwd = primaryUrl ? extractSharePassword(primaryUrl) : null;

    try {
      await this.call<boolean>("sendChatAction", { chat_id: message.chat.id, action: "typing" }, 10_000);
    } catch {
      // ignore
    }

    // If multiple links, inform user
    if (allUrls.length > 1) {
      await this.sendHtml(
        message,
        `🔗 <b>${allUrls.length} links detected!</b>\nPehla link resolve kar raha hoon... Baki ke liye ek-ek karke bhejo ya /link use karo.`,
      );
    }

    const loadingMsg = await this.sendHtml(
      message,
      `🔍 <b>Resolving TeraBox link...</b>\n\n🔗 Surl: <code>${escapeHtml(surl)}</code>\n${pwd ? `🔑 Password: <code>***</code>\n` : ""}⏳ Please wait...`,
    );

    try {
      const { value: share, cacheHit } = await this.resolver.resolve(surl, undefined, pwd ? { pwd } : undefined);
      const browser = this.createBrowserSession(message.chat.id, message.from?.id ?? message.chat.id, share);
      await this.editHtml(
        loadingMsg.chat.id,
        loadingMsg.message_id,
        this.renderBrowserText(browser, cacheHit),
        this.renderBrowserKeyboard(browser),
      );

      // Dump channel copy (premium format)
      const body = formatShareMessage(share, this.config.maxFilesPerReply);
      await this.sendToDump(
        `📦 <b>New Resolve</b> • User: <code>${message.from?.id ?? message.chat.id}</code> • ${escapeHtml(
          message.from?.first_name || "",
        )}\n🔗 ${escapeHtml(primaryUrl || surl)}\n\n${body}`,
      );
    } catch (error) {
      const userMessage =
        error instanceof TeraBoxError ? error.message : "Link process nahi ho saka. Thodi der baad phir try karein.";
      await this.editHtml(
        loadingMsg.chat.id,
        loadingMsg.message_id,
        `❌ <b>Resolve Failed</b>\n\n⚠️ ${escapeHtml(truncate(userMessage, 700))}\n\n💡 Tips:\n• Link sahi hai check karo\n• Agar password protected hai to <code>?pwd=pass</code> add karo\n• /ping se bot status check karo`,
      );
    }
  }

  private async scanShare(message: TelegramMessage, source: string): Promise<void> {
    const shareUrl = findShareUrl(source);
    const surl = shareUrl ? extractSurl(shareUrl) : null;
    const pwd = shareUrl ? extractSharePassword(shareUrl) : null;
    if (!surl) {
      await this.sendHtml(
        message,
        "🔍 <b>Scan ke liye valid TeraBox link bhejo</b>\n<code>/scan https://terabox.com/s/xxxx</code>",
      );
      return;
    }

    try {
      await this.call<boolean>("sendChatAction", { chat_id: message.chat.id, action: "typing" }, 10_000);
    } catch {}

    const statusMessage = await this.sendHtml(
      message,
      [
        "🔎 <b>Deep Scan Started...</b>",
        "",
        `🔗 Surl: <code>${escapeHtml(surl)}</code>`,
        "📂 Saare sub-folders scan ho rahe hain...",
        "⏳ Ye 10-30 sec lag sakta hai bade folders ke liye",
        "",
        "<i>Please wait...</i>",
      ].join("\n"),
    );

    try {
      const scanned = await this.resolver.scanAll(surl, undefined, pwd ? { pwd } : undefined);
      const files = scanned.filter((item) => !item.isFolder);
      const folders = scanned.filter((item) => item.isFolder);
      const totalBytes = files.reduce((sum, item) => sum + (item.sizeBytes ?? 0), 0);

      const lines = [
        `📂 <b>Scan Complete — ${scanned.length} items</b>`,
        "",
        `🔗 Surl: <code>${escapeHtml(surl)}</code>`,
        `📁 Folders: ${folders.length} • 📄 Files: ${files.length}`,
        `💾 Total: ${escapeHtml(formatBytes(totalBytes))}`,
        "",
        "<b>📋 Top files:</b>",
      ];
      if (files.length === 0) {
        lines.push("<i>Koi file nahi mili.</i>");
      } else {
        const shown = files.slice(0, 25);
        shown.forEach((file, index) => {
          const icon = getFileIcon(file.name, false);
          const size = file.sizeBytes !== undefined ? ` • ${escapeHtml(formatBytes(file.sizeBytes))}` : "";
          lines.push(
            `${icon} <b>${index + 1}.</b> <code>${escapeHtml(truncate(file.relativePath, 90))}</code>${size}`,
          );
        });
        if (files.length > shown.length) {
          lines.push(`<i>... aur ${files.length - shown.length} files</i>`);
        }
      }
      lines.push(
        "",
        "💡 <b>Next:</b>",
        "• Poora folder upload karne ke liye <code>/uploadall</code> use karo",
        "• Direct links ke liye /link se browser kholo",
      );

      await this.editHtml(statusMessage.chat.id, statusMessage.message_id, lines.join("\n"));
    } catch (error) {
      const userMessage =
        error instanceof TeraBoxError ? error.message : "Folder scan nahi ho saka. Thodi der baad try karein.";
      await this.editHtml(
        statusMessage.chat.id,
        statusMessage.message_id,
        `❌ <b>Scan Failed</b>\n\n⚠️ ${escapeHtml(truncate(userMessage, 600))}`,
      );
    }
  }

  private async registerCommands(): Promise<void> {
    const commands = [
      { command: "start", description: "🚀 Bot start + welcome" },
      { command: "help", description: "📖 Saare commands + guide" },
      { command: "about", description: "ℹ️ Bot ke baare me" },
      { command: "features", description: "✨ Saare features dekho" },
      { command: "link", description: "🔗 TeraBox link resolve karo" },
      { command: "scan", description: "🔍 Deep folder scan karo" },
      ...(this.transferManager
        ? [
            { command: "upload", description: "⬆️ File upload karo" },
            { command: "uploadall", description: "📦 Poora folder upload" },
            { command: "jobs", description: "📋 Queue dekho" },
            { command: "stats", description: "📊 Stats dekho" },
            { command: "cancel", description: "⏹️ Cancel karo" },
          ]
        : []),
      { command: "id", description: "🆔 Apna ID dekho" },
      { command: "status", description: "📊 Bot status" },
      { command: "ping", description: "🏓 Latency check" },
      { command: "logs", description: "📝 Logs dekho (admin)" },
      { command: "setcookie", description: "🍪 Cookies update (admin)" },
      { command: "access", description: "🔑 Access do (owner)" },
      { command: "users", description: "👥 Users list (owner)" },
    ];
    await this.call<boolean>("setMyCommands", { commands }, 15_000);
  }

  private async setCookieCommand(message: TelegramMessage, argument: string): Promise<void> {
    if (!this.resolver.setCookies) {
      await this.sendHtml(message, "⚠️ Cookie update is not supported on this build.");
      return;
    }
    const raw = argument.trim();
    if (!raw) {
      await this.sendHtml(
        message,
        [
          "🍪 <b>Cookie Update Guide</b>",
          "",
          "Format: <code>/setcookie {\"ndus\":\"...\",\"browserid\":\"...\"}</code>",
          "",
          "🔍 <b>Kaise nikale?</b>",
          "1. Browser me terabox.com open karo + login",
          "2. F12 → Application → Cookies",
          "3. Saari cookies copy karo (ndus sabse important)",
          "4. JSON bana ke bhejo",
          "",
          "💡 Tip: Saari cookies bhejo for best reliability",
        ].join("\n"),
      );
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      await this.sendHtml(
        message,
        '⚠️ Invalid JSON. Example:\n<code>{"ndus":"abc...","browserid":"xyz..."}</code>',
      );
      return;
    }
    if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
      await this.sendHtml(message, "⚠️ Cookie JSON object honi chahiye: <code>{\"name\":\"value\"}</code>");
      return;
    }
    const cookies: Record<string, string> = {};
    for (const [name, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value !== "string" && typeof value !== "number") {
        await this.sendHtml(message, `⚠️ "${escapeHtml(name)}" ki value string/number honi chahiye.`);
        return;
      }
      cookies[name] = String(value);
    }
    if (Object.keys(cookies).length === 0) {
      await this.sendHtml(message, "⚠️ Koi cookie nahi mili.");
      return;
    }
    this.resolver.setCookies(cookies);
    const names = Object.keys(cookies).join(", ");
    this.logger.info(`[telegram] Cookies updated by user ${message.from?.id}: ${names}`);
    await this.sendHtml(
      message,
      `✅ <b>Cookies Updated!</b>\n\n🍪 Updated: <code>${escapeHtml(names)}</code>\n♻️ Cache cleared\n\n💡 Ab links phir se try karo, better success rate milega.`,
    );
  }

  private async sendLogs(message: TelegramMessage): Promise<void> {
    const entries = logBuffer.tail(50);
    if (entries.length === 0) {
      await this.sendHtml(message, "📝 <b>Logs</b>\n\nAbhi koi logs nahi hain. Bot fresh start hua hai.");
      return;
    }
    const lines = entries.map((entry) => {
      const time = new Date(entry.ts).toLocaleTimeString();
      const lvl = entry.level === "error" ? "❌" : entry.level === "warn" ? "⚠️" : "ℹ️";
      return `${lvl} <code>[${time}]</code> ${escapeHtml(truncate(entry.message, 280))}`;
    });
    await this.sendHtml(message, `📝 <b>Last ${entries.length} Logs</b>\n\n${lines.join("\n")}`);
  }

  private async handleAccessCommand(
    message: TelegramMessage,
    command: { command: string; argument: string },
  ): Promise<void> {
    if (!this.isOwner(message.from!.id)) {
      await this.sendHtml(message, "⛔ <b>Owner Only</b>\nYe commands sirf bot owner use kar sakta hai.");
      return;
    }
    if (!this.accessStore) {
      await this.sendHtml(message, "⚠️ Access store enabled nahi hai (TELEGRAM_OWNER_ID set karo).");
      return;
    }

    if (command.command === "users") {
      const users = this.accessStore.list();
      const lines = [
        `👥 <b>Allowed Users — ${users.length} total</b>`,
        "",
        `👑 Owner: <code>${this.config.ownerId}</code>`,
        users.length ? "" : "<i>No extra users yet. /access se add karo.</i>",
        ...users.map((u) => `• <code>${u.userId}</code> — ${new Date(u.grantedAtMs).toLocaleString()}`),
        "",
        "💡 <code>/access &lt;id&gt;</code> se add, <code>/revoke &lt;id&gt;</code> se remove",
      ];
      await this.sendHtml(message, lines.join("\n"));
      return;
    }

    const target = Number(command.argument.trim());
    if (!Number.isSafeInteger(target) || target <= 0) {
      await this.sendHtml(
        message,
        `🔑 <b>Usage:</b> <code>/${command.command} &lt;user-id&gt;</code>\n\nUser ko bolo /id bheje, phir uska ID yahan use karo.`,
      );
      return;
    }

    if (command.command === "access") {
      const added = this.accessStore.grant(target, message.from!.id);
      await this.sendHtml(
        message,
        added
          ? `✅ <b>Access Granted!</b>\n\nUser <code>${target}</code> ab bot use kar sakta hai. 🎉`
          : `ℹ️ User <code>${target}</code> ko pehle se access hai.`,
      );
      return;
    }

    const removed = this.accessStore.revoke(target);
    await this.sendHtml(
      message,
      removed
        ? `⛔ <b>Access Revoked</b>\nUser <code>${target}</code> ka access hat gaya.`
        : `ℹ️ User <code>${target}</code> allowed list me nahi tha.`,
    );
  }

  private createBrowserSession(chatId: number, userId: number, share: ResolvedShare): BrowserSession {
    this.pruneBrowserSessions();
    const totalSize = share.totalSizeBytes ?? share.files.reduce((s, f) => s + (f.sizeBytes ?? 0), 0);
    const session: BrowserSession = {
      id: randomUUID().replace(/-/g, "").slice(0, 10),
      chatId,
      userId,
      surl: share.surl,
      directory: share.directory,
      files: share.files,
      page: 0,
      expiresAt: Date.now() + BROWSER_SESSION_TTL_MS,
      totalSize,
    };
    this.browserSessions.set(session.id, session);
    return session;
  }

  private pruneBrowserSessions(): void {
    const now = Date.now();
    for (const [id, session] of this.browserSessions) {
      if (session.expiresAt <= now) this.browserSessions.delete(id);
    }
  }

  private renderBrowserText(session: BrowserSession, cacheHit?: boolean): string {
    const pageCount = Math.max(1, Math.ceil(session.files.length / BROWSER_PAGE_SIZE));
    const page = Math.min(session.page, pageCount - 1);
    const start = page * BROWSER_PAGE_SIZE;
    const pageFiles = session.files.slice(start, start + BROWSER_PAGE_SIZE);
    const location = session.directory || "/";
    const totalSize = session.totalSize ? formatBytes(session.totalSize) : null;
    const folders = session.files.filter((f) => f.isFolder).length;
    const files = session.files.filter((f) => !f.isFolder).length;

    const lines = [
      "📂 <b>TeraBox Browser — Pro</b>" + (cacheHit ? " ⚡ <i>(cached)</i>" : ""),
      "",
      `📁 Path: <code>${escapeHtml(truncate(location, 100))}</code>`,
      `📊 ${session.files.length} items • ${folders} 📁 • ${files} 📄 ${totalSize ? `• 💾 ${escapeHtml(totalSize)}` : ""}`,
      `📄 Page ${page + 1}/${pageCount}`,
      "",
      "<b>📋 Files:</b>",
    ];

    if (pageFiles.length === 0) {
      lines.push("<i>📭 This folder is empty.</i>");
    }
    for (let index = 0; index < pageFiles.length; index += 1) {
      const file = pageFiles[index];
      const globalIndex = start + index + 1;
      const icon = getFileIcon(file.name, file.isFolder);
      const size = file.sizeBytes !== undefined ? ` • ${escapeHtml(formatBytes(file.sizeBytes))}` : "";
      const folderMark = file.isFolder ? " <i>[Folder]</i>" : "";
      lines.push(`${icon} <b>${globalIndex}. ${escapeHtml(truncate(file.name, 80))}</b>${size}${folderMark}`);
    }

    lines.push(
      "",
      "💡 <b>Actions:</b>",
      "• 📁 Folder kholne ke liye button dabao",
      "• ⬇️ Direct download link",
      "• ⬆️ Telegram upload (agar enabled)",
      "• ◀️ ▶️ Pages navigate karo",
    );
    return lines.join("\n");
  }

  private renderBrowserKeyboard(session: BrowserSession): InlineKeyboardMarkup {
    const pageCount = Math.max(1, Math.ceil(session.files.length / BROWSER_PAGE_SIZE));
    const page = Math.min(session.page, pageCount - 1);
    const start = page * BROWSER_PAGE_SIZE;
    const pageFiles = session.files.slice(start, start + BROWSER_PAGE_SIZE);
    const rows: InlineKeyboardButton[][] = [];

    for (let offset = 0; offset < pageFiles.length; offset += 1) {
      const file = pageFiles[offset];
      const index = start + offset;
      const shortName = truncate(file.name, 28);
      if (file.isFolder) {
        rows.push([{ text: `📁 ${shortName}`, callback_data: `tb:${session.id}:o:${index}` }]);
        continue;
      }

      const row: InlineKeyboardButton[] = [];
      if (file.download) {
        row.push({ text: `⬇️ ${index + 1}`, url: file.download });
      }
      if (this.transferManager && file.download) {
        row.push({ text: `⬆️ ${index + 1}`, callback_data: `tb:${session.id}:u:${index}` });
      }
      if (row.length === 0) {
        row.push({ text: `🔒 ${shortName} — N/A`, callback_data: `tb:${session.id}:x:${index}` });
      } else {
        // Add file name as non-clickable context via second row if needed, but keep compact
      }
      rows.push(row);
    }

    const nav: InlineKeyboardButton[] = [];
    if (session.directory) {
      nav.push({ text: "⬅️ Back", callback_data: `tb:${session.id}:b` });
    }
    if (page > 0) {
      nav.push({ text: "◀️ Prev", callback_data: `tb:${session.id}:p:${page - 1}` });
    }
    if (page < pageCount - 1) {
      nav.push({ text: "Next ▶️", callback_data: `tb:${session.id}:p:${page + 1}` });
    }
    if (nav.length > 0) rows.push(nav);

    // Quick actions row
    rows.push([
      { text: "🔍 Deep Scan", callback_data: `tb:${session.id}:scan` },
      { text: "📊 Info", callback_data: `tb:${session.id}:info` },
    ]);

    return { inline_keyboard: rows };
  }

  private folderPath(session: BrowserSession, file: TeraBoxFile): string {
    if (file.path) return file.path;
    return path.posix.join(session.directory || "/", file.name);
  }

  private async handleCallbackQuery(query: TelegramCallbackQuery): Promise<void> {
    const message = query.message;
    const data = query.data;
    if (!message || !data) {
      await this.answerCallback(query.id, "Button expired.");
      return;
    }
    if (!this.isAllowed(query.from.id)) {
      await this.answerCallback(query.id, "Not authorized.", true);
      return;
    }

    // Handle simple callbacks like help, about etc from start message
    if (["help", "about", "features", "myid", "status"].includes(data)) {
      switch (data) {
        case "help":
          await this.answerCallback(query.id, "Opening help...");
          await this.sendHtml(
            { message_id: message.message_id, chat: message.chat, from: query.from } as any,
            helpMessage(Boolean(this.transferManager)),
          );
          return;
        case "about":
          await this.answerCallback(query.id);
          await this.sendHtml(
            { message_id: message.message_id, chat: message.chat, from: query.from } as any,
            aboutMessage(),
          );
          return;
        case "features":
          await this.answerCallback(query.id);
          await this.sendHtml(
            { message_id: message.message_id, chat: message.chat, from: query.from } as any,
            featuresMessage(),
          );
          return;
        case "myid":
          await this.answerCallback(query.id);
          await this.sendHtml(
            { message_id: message.message_id, chat: message.chat, from: query.from } as any,
            `🆔 <b>Your ID:</b> <code>${query.from.id}</code>\n💬 Chat: <code>${message.chat.id}</code>`,
          );
          return;
        case "status":
          await this.answerCallback(query.id);
          const tm = this.transferManager?.getStatus();
          await this.sendHtml(
            { message_id: message.message_id, chat: message.chat, from: query.from } as any,
            `📊 <b>Status</b>\nCache: ${this.resolver.cacheSize} • Uploads: ${tm ? `${tm.active_jobs} active` : "disabled"}`,
          );
          return;
      }
    }

    if (data.startsWith("tc:")) {
      const cancelled = this.transferManager?.cancel(message.chat.id, data.slice(3), query.from.id);
      await this.answerCallback(query.id, cancelled ? "✅ Cancellation requested." : "Job not found.");
      return;
    }

    const match = data.match(/^tb:([a-f0-9]{10}):([a-z]+)(?::(\d+))?$/i);
    if (!match?.[1] || !match[2]) {
      await this.answerCallback(query.id, "Invalid action.");
      return;
    }
    this.pruneBrowserSessions();
    const session = this.browserSessions.get(match[1]);
    if (!session || session.chatId !== message.chat.id) {
      await this.answerCallback(query.id, "Session expired. Send link again.", true);
      return;
    }
    // Allow any user in same chat to interact? For groups, check ownerId
    if (session.userId !== query.from.id && message.chat.type === "private") {
      // In private, only owner of session can interact
      if (session.userId !== query.from.id) {
        await this.answerCallback(query.id, "Ye session aapki nahi hai.", true);
        return;
      }
    }
    session.expiresAt = Date.now() + BROWSER_SESSION_TTL_MS;

    const action = match[2];
    const index = match[3] === undefined ? undefined : Number(match[3]);

    if (action === "p" && index !== undefined) {
      const pageCount = Math.max(1, Math.ceil(session.files.length / BROWSER_PAGE_SIZE));
      session.page = Math.max(0, Math.min(pageCount - 1, index));
      await this.answerCallback(query.id);
      await this.editHtml(
        message.chat.id,
        message.message_id,
        this.renderBrowserText(session),
        this.renderBrowserKeyboard(session),
      );
      return;
    }
    if (action === "b") {
      const parent = path.posix.dirname(session.directory || "/");
      const directory = parent === "/" || parent === "." ? undefined : parent;
      try {
        await this.answerCallback(query.id, "⬅️ Going back...");
        const { value: share } = await this.resolver.resolve(session.surl, directory);
        session.directory = share.directory;
        session.files = share.files;
        session.page = 0;
        session.totalSize = share.totalSizeBytes ?? share.files.reduce((s, f) => s + (f.sizeBytes ?? 0), 0);
        await this.editHtml(
          message.chat.id,
          message.message_id,
          this.renderBrowserText(session),
          this.renderBrowserKeyboard(session),
        );
      } catch {
        await this.editHtml(message.chat.id, message.message_id, "⚠️ <b>Back failed</b>\nFolder open nahi ho saka.");
      }
      return;
    }
    if (action === "scan") {
      await this.answerCallback(query.id, "🔍 Scanning all folders...");
      const fakeMsg = { message_id: message.message_id, chat: message.chat, from: query.from } as TelegramMessage;
      await this.scanShare(fakeMsg, `https://terabox.com/s/${session.surl}`);
      return;
    }
    if (action === "info") {
      await this.answerCallback(query.id);
      const total = session.totalSize ? formatBytes(session.totalSize) : "Unknown";
      const folders = session.files.filter((f) => f.isFolder).length;
      const files = session.files.filter((f) => !f.isFolder).length;
      await this.sendHtml(
        { message_id: message.message_id, chat: message.chat, from: query.from } as any,
        `📊 <b>Folder Info</b>\n\n📁 Path: <code>${escapeHtml(session.directory || "/")}</code>\n📦 Items: ${session.files.length}\n📁 Folders: ${folders}\n📄 Files: ${files}\n💾 Total: ${escapeHtml(total)}\n\n🔗 Surl: <code>${escapeHtml(session.surl)}</code>`,
      );
      return;
    }
    if (index === undefined || !Number.isSafeInteger(index) || index < 0 || index >= session.files.length) {
      await this.answerCallback(query.id, "Invalid selection.");
      return;
    }

    const file = session.files[index];
    if (action === "o") {
      if (!file.isFolder) {
        await this.answerCallback(query.id, "Not a folder.");
        return;
      }
      try {
        await this.answerCallback(query.id, `📂 Opening ${truncate(file.name, 30)}...`);
        const { value: share } = await this.resolver.resolve(session.surl, this.folderPath(session, file));
        session.directory = share.directory;
        session.files = share.files;
        session.page = 0;
        session.totalSize = share.totalSizeBytes ?? share.files.reduce((s, f) => s + (f.sizeBytes ?? 0), 0);
        await this.editHtml(
          message.chat.id,
          message.message_id,
          this.renderBrowserText(session),
          this.renderBrowserKeyboard(session),
        );
      } catch {
        await this.editHtml(message.chat.id, message.message_id, "⚠️ <b>Folder open failed</b>\nTry again.");
      }
      return;
    }
    if (action === "u") {
      if (!file.download || file.isFolder) {
        await this.answerCallback(query.id, "Upload not available for this file.");
        return;
      }
      await this.answerCallback(query.id, "⬆️ Queuing upload...");
      await this.queueUpload(message, {
        surl: session.surl,
        directory: session.directory,
        fileIndex: index + 1,
        ownerUserId: query.from.id,
      });
      return;
    }

    await this.answerCallback(query.id, "No action available.");
  }

  private async enqueueUpload(message: TelegramMessage, argument: string): Promise<void> {
    if (!this.transferManager) {
      await this.sendHtml(
        message,
        "⬆️ <b>Uploads Disabled</b>\n\nIs server par Telegram upload off hai. Sirf direct download links available hain.\n\n💡 Owner se bolo <code>TELEGRAM_UPLOAD_ENABLED=true</code> + API credentials set karein.",
      );
      return;
    }

    const indexMatch = argument.match(/\s+(\d+)\s*$/);
    const source = indexMatch?.index === undefined ? argument : argument.slice(0, indexMatch.index).trim();
    const shareUrl = findShareUrl(source);
    const surl = shareUrl ? extractSurl(shareUrl) : null;
    const fileIndex = indexMatch?.[1] ? Number(indexMatch[1]) : undefined;

    if (!surl || (fileIndex !== undefined && (!Number.isSafeInteger(fileIndex) || fileIndex < 1))) {
      await this.sendHtml(
        message,
        [
          "⬆️ <b>Upload Usage</b>",
          "",
          "<code>/upload &lt;TeraBox URL&gt; [file-number]</code>",
          "",
          "Examples:",
          "<code>/upload https://terabox.com/s/abc</code> — first file",
          "<code>/upload https://terabox.com/s/abc 2</code> — 2nd file",
          "",
          "💡 File browser me ⬆️ button se bhi upload kar sakte ho!",
        ].join("\n"),
      );
      return;
    }

    await this.queueUpload(message, {
      surl,
      ...(fileIndex !== undefined && { fileIndex }),
    });
  }

  private async enqueueUploadAll(message: TelegramMessage, argument: string): Promise<void> {
    if (!this.transferManager) {
      await this.sendHtml(message, "⬆️ Uploads disabled on this server.");
      return;
    }

    const shareUrl = findShareUrl(argument);
    const surl = shareUrl ? extractSurl(shareUrl) : null;
    if (!surl) {
      await this.sendHtml(
        message,
        "📦 <b>Upload All Usage</b>\n\n<code>/uploadall &lt;TeraBox URL&gt;</code>\nExample: <code>/uploadall https://terabox.com/s/abc</code>\n\n⚠️ Ye saare sub-folders ke files upload karega!",
      );
      return;
    }

    await this.queueUpload(message, { surl, uploadAll: true });
  }

  private async queueUpload(
    message: TelegramMessage,
    selection: Pick<TransferRequest, "surl" | "directory" | "fileIndex" | "uploadAll" | "ownerUserId">,
  ): Promise<void> {
    if (!this.transferManager) {
      await this.sendHtml(message, "Uploads disabled.");
      return;
    }

    const statusMessage = await this.sendHtml(message, "⏳ <b>Queuing upload...</b>\n<i>Checking file info...</i>");
    try {
      const job = await this.transferManager.enqueue({
        chatId: message.chat.id,
        replyToMessageId: message.message_id,
        statusMessageId: statusMessage.message_id,
        ...selection,
        ownerUserId: selection.ownerUserId ?? message.from?.id,
        onUpdate: async (snapshot) => {
          await this.updateTransferStatus(snapshot);
        },
      });
      await this.updateTransferStatus(job);
    } catch (error) {
      const detail = truncate(error instanceof Error ? error.message : "Could not queue transfer.", 700);
      await this.editHtml(
        statusMessage.chat.id,
        statusMessage.message_id,
        `❌ <b>Queue Failed</b>\n\n⚠️ ${escapeHtml(detail)}\n\n💡 /jobs se queue dekho, /cancel se clear karo.`,
      );
    }
  }

  private async showJobs(message: TelegramMessage): Promise<void> {
    if (!this.transferManager) {
      await this.sendHtml(message, "⬆️ Uploads disabled on this server.");
      return;
    }

    const jobs = this.transferManager.list(message.chat.id, message.from?.id);
    if (jobs.length === 0) {
      await this.sendHtml(
        message,
        "📋 <b>No Active Jobs</b>\n\nAbhi koi transfer nahi hai. /upload se naya start karo!",
      );
      return;
    }

    const lines = ["📋 <b>Your Transfer Jobs</b>", ""];
    for (const job of jobs) {
      const icon = getFileIcon(job.filename || "", false);
      const filename = escapeHtml(truncate(job.filename ?? "TeraBox file", 60));
      const progress = job.progress !== undefined ? ` ${formatProgressBar(job.progress, 8)}` : "";
      const stageEmoji =
        job.stage === "completed"
          ? "✅"
          : job.stage === "failed"
            ? "❌"
            : job.stage === "cancelled"
              ? "⏹️"
              : job.stage === "downloading"
                ? "⬇️"
                : job.stage === "uploading"
                  ? "⬆️"
                  : "⏳";
      lines.push(
        `${stageEmoji} <code>${escapeHtml(job.id)}</code> • ${escapeHtml(job.stage)}${progress}\n   ${icon} ${filename}`,
      );
    }
    lines.push("", "💡 <code>/cancel &lt;job-id&gt;</code> se cancel karo");
    await this.sendHtml(message, lines.join("\n"));
  }

  private async showTransferStats(message: TelegramMessage): Promise<void> {
    if (!this.transferManager) {
      await this.sendHtml(message, "⬆️ Uploads disabled.");
      return;
    }
    const status = this.transferManager.getStatus();
    const dashboard = this.transferManager.getDashboard?.();
    const totals =
      dashboard?.totals && typeof dashboard.totals === "object"
        ? (dashboard.totals as Record<string, unknown>)
        : {};
    const dailyLimit = status.per_user_daily_limit === 0 ? "♾️ Unlimited" : status.per_user_daily_limit ?? "?";
    const disk = (dashboard as any)?.disk as { available_bytes?: number; total_bytes?: number } | undefined;

    await this.sendHtml(
      message,
      [
        "📊 <b>Transfer Stats — Live</b>",
        "",
        `🔥 Active: ${status.active_jobs ?? 0} • Queued: ${status.queued_jobs ?? 0}/${status.max_queue ?? "?"}`,
        `📦 Upload limit: ${escapeHtml(String(status.upload_limit ?? "?"))} per file`,
        `👤 Daily limit per user: ${dailyLimit}`,
        `💾 Disk free: ${disk?.available_bytes ? escapeHtml(formatBytes(disk.available_bytes)) : "Unknown"}`,
        "",
        `✅ Completed: ${totals.completed ?? 0}`,
        `❌ Failed: ${totals.failed ?? 0}`,
        `⏹️ Cancelled: ${totals.cancelled ?? 0}`,
        "",
        `📦 Cache: ${this.resolver.cacheSize} items`,
        `🤖 Bot: @${escapeHtml(this.username || "?")}`,
      ].join("\n"),
    );
  }

  private async cancelUpload(message: TelegramMessage, argument: string): Promise<void> {
    if (!this.transferManager) {
      await this.sendHtml(message, "Uploads disabled.");
      return;
    }

    const cancelled = this.transferManager.cancel(message.chat.id, argument || undefined, message.from?.id);
    if (!cancelled) {
      await this.sendHtml(
        message,
        "⏹️ <b>No job found to cancel</b>\n\n📋 /jobs se job ID dekho, phir <code>/cancel &lt;id&gt;</code> use karo.\n\n💡 Bina ID ke /cancel likhoge to latest job cancel hoga (agar ek hi active hai).",
      );
      return;
    }
    await this.sendHtml(
      message,
      `⏹️ <b>Cancellation Requested</b>\n\n🆔 Job: <code>${escapeHtml(cancelled.id)}</code>\n📄 File: ${escapeHtml(truncate(cancelled.filename || "TeraBox file", 80))}\n\n<i>Stopping...</i>`,
    );
  }

  private async updateTransferStatus(snapshot: TransferSnapshot): Promise<void> {
    if (snapshot.statusMessageId === undefined) return;
    const cancellable = ["queued", "preparing", "downloading", "splitting", "uploading"].includes(snapshot.stage);
    const replyMarkup = cancellable
      ? { inline_keyboard: [[{ text: "⏹️ Cancel Upload", callback_data: `tc:${snapshot.id}` }]] }
      : { inline_keyboard: [] };
    await this.editHtml(
      snapshot.chatId,
      snapshot.statusMessageId,
      formatTransferStatus(snapshot),
      replyMarkup,
    );
  }

  private isOwner(userId: number): boolean {
    return this.config.ownerId !== undefined && userId === this.config.ownerId;
  }

  private isAllowed(userId: number): boolean {
    if (this.config.allowPublic) return true;
    if (this.isOwner(userId)) return true;
    if (this.config.allowedUserIds.has(userId)) return true;
    return Boolean(this.accessStore?.has(userId));
  }

  private async sendToDump(text: string, timeoutMs = 20_000): Promise<void> {
    const target = this.config.destChannelId;
    if (!target) return;
    await this.call<TelegramSentMessage>(
      "sendMessage",
      {
        chat_id: target,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: true,
      },
      timeoutMs,
    ).catch(() => {
      this.logger.warn("[telegram] Could not deliver to dump channel.");
    });
  }

  private userLabel(from: TelegramUser): string {
    const name = [from.first_name, from.last_name].filter(Boolean).join(" ") || "Unknown";
    return from.username ? `${name} (@${from.username})` : name;
  }

  private async notifyUserActivity(from: TelegramUser, chatId: number): Promise<void> {
    await this.sendToDump(
      `👤 <b>New User</b>\n` +
        `🆔 ID: <code>${from.id}</code>\n` +
        `👋 Name: ${escapeHtml(this.userLabel(from))}\n` +
        `💬 Chat: <code>${chatId}</code>\n` +
        `⏰ ${new Date().toLocaleString()}`,
    );
  }

  private async sendHtml(
    message: TelegramMessage,
    text: string,
    replyMarkup?: InlineKeyboardMarkup,
  ): Promise<TelegramSentMessage> {
    return this.call<TelegramSentMessage>(
      "sendMessage",
      {
        chat_id: message.chat.id,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: true,
        reply_to_message_id: message.message_id,
        ...(replyMarkup && { reply_markup: replyMarkup }),
      },
      15_000,
    );
  }

  private async sendText(message: TelegramMessage, text: string): Promise<TelegramSentMessage> {
    return this.call<TelegramSentMessage>(
      "sendMessage",
      {
        chat_id: message.chat.id,
        text,
        disable_web_page_preview: true,
        reply_to_message_id: message.message_id,
      },
      15_000,
    );
  }

  private async editHtml(
    chatId: number,
    messageId: number,
    text: string,
    replyMarkup?: InlineKeyboardMarkup,
  ): Promise<void> {
    await this.call<unknown>(
      "editMessageText",
      {
        chat_id: chatId,
        message_id: messageId,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: true,
        ...(replyMarkup && { reply_markup: replyMarkup }),
      },
      15_000,
    );
  }

  private async answerCallback(queryId: string, text?: string, showAlert = false): Promise<void> {
    await this.call<boolean>(
      "answerCallbackQuery",
      {
        callback_query_id: queryId,
        ...(text && { text: truncate(text, 180) }),
        ...(showAlert && { show_alert: true }),
      },
      10_000,
    );
  }

  private async call<T>(method: string, payload: Record<string, unknown>, timeoutMs: number): Promise<T> {
    const controller = new AbortController();
    const stopRequest = () => controller.abort();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    this.stopController.signal.addEventListener("abort", stopRequest, { once: true });

    try {
      const response = await this.fetchImpl(this.endpoint(method), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      const rawBody = await response.text();
      let data: TelegramApiEnvelope<T>;

      try {
        data = JSON.parse(rawBody) as TelegramApiEnvelope<T>;
      } catch {
        throw new TelegramApiError("Telegram returned an invalid response.");
      }

      if (!response.ok || !data.ok || data.result === undefined) {
        const description = data.description || `HTTP ${response.status}`;
        throw new TelegramApiError(`Telegram API error: ${description}`);
      }

      return data.result;
    } catch (error) {
      if (error instanceof TelegramApiError) throw error;
      if (controller.signal.aborted) throw new TelegramApiError("Telegram request timed out.");
      throw new TelegramApiError("Could not reach Telegram Bot API.");
    } finally {
      clearTimeout(timer);
      this.stopController.signal.removeEventListener("abort", stopRequest);
    }
  }

  private endpoint(method: string): string {
    return `https://api.telegram.org/bot${encodeURIComponent(this.config.token)}/${method}`;
  }
}
