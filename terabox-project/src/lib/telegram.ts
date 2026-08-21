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
  extractSurl,
  findShareUrl,
  formatBytes,
  truncate,
} from "./utils.js";

interface TelegramUser {
  id: number;
  first_name?: string;
  last_name?: string;
  username?: string;
}

interface TelegramChat {
  id: number;
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

function sleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }

    const timer = setTimeout(cleanup, milliseconds);
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
  if (!match?.[1]) {
    return null;
  }

  return {
    command: match[1].toLowerCase(),
    addressedTo: match[2]?.toLowerCase(),
    argument: match[3]?.trim() ?? "",
  };
}

const BROWSER_PAGE_SIZE = 5;
const BROWSER_SESSION_TTL_MS = 30 * 60 * 1_000;

function helpMessage(uploadEnabled: boolean): string {
  return [
    "<b>TeraBox Link Bot</b>",
    "",
    "Mujhe TeraBox share link bhejiye, main file details aur available direct download link dunga.",
    "",
    "Commands:",
    "• <code>/link &lt;TeraBox URL&gt;</code> — link resolve karein",
    "• <code>/scan &lt;TeraBox URL&gt;</code> — saare sub-folders scan karke full file list bheje",
    "• <code>/id</code> — apna User ID + Chat ID dekhein",
    "• <code>/setcookie &lt;JSON&gt;</code> — TeraBox cookies update karein (admin)",
    "• <code>/logs</code> — aakhri 40 log lines (admin)",
    "• <code>/access &lt;id&gt;</code>, <code>/revoke &lt;id&gt;</code>, <code>/users</code> — access manage (owner)",
    ...(uploadEnabled
      ? [
          "• <code>/upload &lt;TeraBox URL&gt; [file-number]</code> — ek file Telegram par upload karein",
          "• <code>/uploadall &lt;TeraBox URL&gt;</code> — saare files (sub-folders samet) upload karein",
          "• <code>/jobs</code> — transfer queue dekhein",
          "• <code>/stats</code> — queue, disk aur upload stats dekhein",
          "• <code>/cancel [job-id]</code> — active/queued transfer rok dein",
        ]
      : []),
    "• <code>/status</code> — bot status",
    "• <code>/help</code> — yeh help message",
    "",
    "Large upload ke liye bot file ko temporary server disk par download karta hai. Sirf unhi shares ka use karein jinhe access karne ki aapko permission ho.",
  ].join("\n");
}

/** Formats a share result for Telegram's conservative HTML parser. */
export function formatShareMessage(share: ResolvedShare, maximumFiles: number): string {
  if (share.files.length === 0) {
    return [
      "<b>ℹ️ Koi accessible file nahi mili.</b>",
      "Share link, password, aur TeraBox cookie check karke phir try karein.",
    ].join("\n");
  }

  const limit = Math.max(1, maximumFiles);
  const visibleFiles = share.files.slice(0, limit);
  let message = `<b>✅ ${share.files.length} item(s) found</b>`;
  let displayedCount = 0;
  let omittedForLength = false;

  for (let index = 0; index < visibleFiles.length; index += 1) {
    const file = visibleFiles[index];
    const lines = [`<b>${index + 1}. ${escapeHtml(truncate(file.name, 180))}</b>`];

    if (file.isFolder) {
      lines.push("📁 Folder");
    }
    if (file.sizeBytes !== undefined) {
      lines.push(`📦 ${escapeHtml(formatBytes(file.sizeBytes))}`);
    }
    if (!file.isFolder && file.download) {
      lines.push(`<a href="${escapeHtml(file.download)}">⬇️ Download</a>`);
    } else if (!file.isFolder) {
      lines.push("🔒 Direct link unavailable");
    }

    const block = `\n\n${lines.join("\n")}`;
    // Telegram allows 4096 characters. Keep a buffer for encoded entities and
    // the optional truncation note rather than sending an invalid oversized post.
    if (message.length + block.length > 3_700) {
      omittedForLength = true;
      break;
    }
    message += block;
    displayedCount += 1;
  }

  if (share.files.length > displayedCount || omittedForLength) {
    message += `\n\n<i>Showing ${displayedCount} item(s).</i>`;
  }

  return message;
}

function formatDuration(seconds: number | undefined): string | undefined {
  if (seconds === undefined || !Number.isFinite(seconds) || seconds < 0) {
    return undefined;
  }
  if (seconds < 60) {
    return `${Math.ceil(seconds)}s`;
  }
  if (seconds < 3_600) {
    return `${Math.ceil(seconds / 60)}m`;
  }
  return `${(seconds / 3_600).toFixed(1)}h`;
}

/** Formats a transfer status so its progress message can be edited safely. */
export function formatTransferStatus(job: TransferSnapshot): string {
  const title = job.filename ? escapeHtml(truncate(job.filename, 160)) : "TeraBox file";
  const id = escapeHtml(job.id);
  const bulkNote =
    job.totalFileCount && job.currentFileIndex
      ? `\n📁 File ${job.currentFileIndex}/${job.totalFileCount}`
      : "";
  const size = job.sourceSizeBytes !== undefined ? `\n📦 Source: ${escapeHtml(formatBytes(job.sourceSizeBytes))}` : "";
  const percentage = job.progress !== undefined ? ` (${Math.floor(job.progress * 100)}%)` : "";
  const bytes =
    job.transferredBytes !== undefined && job.totalBytes !== undefined
      ? `\n${escapeHtml(formatBytes(job.transferredBytes))} / ${escapeHtml(formatBytes(job.totalBytes))}${percentage}`
      : "";
  const speed = job.speedBytesPerSecond ? `\n⚡ ${escapeHtml(formatBytes(job.speedBytesPerSecond))}/s` : "";
  const eta = formatDuration(job.etaSeconds);
  const etaLine = eta ? ` · ETA ${escapeHtml(eta)}` : "";

  if (job.stage === "queued") {
    const retry = job.nextAttemptAt
      ? `\n🔁 Retry ${Math.min((job.attempt ?? 0) + 1, job.maxAttempts ?? 1)}/${job.maxAttempts ?? 1} at ${escapeHtml(new Date(job.nextAttemptAt).toLocaleTimeString())}`
      : "";
    return `<b>⏳ Upload queued</b>\n${title}${bulkNote}${size}\nJob: <code>${id}</code>\nQueue position: ${job.queuePosition ?? 1}${retry}`;
  }
  if (job.stage === "preparing") {
    return `<b>🔎 Preparing transfer</b>\n${title}${bulkNote}${size}\nJob: <code>${id}</code>`;
  }
  if (job.stage === "downloading") {
    return `<b>⬇️ Downloading from TeraBox</b>\n${title}${bulkNote}${bytes}${speed}${etaLine}\nJob: <code>${id}</code>`;
  }
  if (job.stage === "splitting") {
    return `<b>🗜️ Creating ZIP parts</b>\n${title}${bulkNote}${size}\nLarge file ko Telegram-safe parts me split kiya ja raha hai.\nJob: <code>${id}</code>`;
  }
  if (job.stage === "uploading") {
    const part = job.partCount && job.partCount > 1 ? `\nPart ${job.partIndex ?? 1}/${job.partCount}` : "";
    return `<b>⬆️ Uploading to Telegram</b>\n${title}${bulkNote}${part}${bytes}${speed}${etaLine}\nJob: <code>${id}</code>`;
  }
  if (job.stage === "completed") {
    const parts = job.partCount && job.partCount > 1 ? `\n✅ ${job.partCount} ZIP parts sent. Final <code>.zip</code> file ko parts ke saath extract karein.` : "";
    return `<b>✅ Transfer complete</b>\n${title}${parts}\nJob: <code>${id}</code>`;
  }
  if (job.stage === "cancelled") {
    return `<b>⏹️ Transfer cancelled</b>\n${title}\nJob: <code>${id}</code>`;
  }
  return `<b>⚠️ Transfer failed</b>\n${title}\n${escapeHtml(job.error ?? "Unknown transfer error.")}\nJob: <code>${id}</code>`;
}

/**
 * Long-polling Telegram Bot API client. Long polling avoids exposing a public
 * webhook endpoint and works on a normal Docker/VPS deployment.
 */
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
    if (this.pollingTask) {
      return;
    }

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
          // Move the cursor before handling. A malformed update must not stop
          // every later message from being processed indefinitely.
          this.offset = update.update_id + 1;
          await this.handleUpdate(update);
        }
      } catch (error) {
        if (this.stopController.signal.aborted) {
          break;
        }

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
    if (!message?.from || !message.text) {
      return;
    }

    const text = message.text.trim();
    const command = extractCommand(text);

    // Track /start (and /help) even from users without access, so the owner
    // sees every new user's id + details in the dump channel.
    if (command?.command === "start" || command?.command === "help") {
      await this.notifyUserActivity(message.from, message.chat.id);
    }

    if (!this.isAllowed(message.from.id)) {
      await this.sendText(message, "⛔ This bot is restricted to authorized users. Contact the owner to get access.");
      return;
    }

    if (command) {
      if (command.addressedTo && this.username && command.addressedTo !== this.username) {
        return;
      }

      if (command.command === "start" || command.command === "help") {
        await this.sendHtml(message, helpMessage(Boolean(this.transferManager)));
        return;
      }

      if (command.command === "id") {
        await this.sendHtml(
          message,
          `<b>Your IDs</b>\nUser ID: <code>${message.from.id}</code>\nChat ID: <code>${message.chat.id}</code>\n\nYe <code>chat id</code> owner ko bhejo /access ke liye.`,
        );
        return;
      }

      if (command.command === "access" || command.command === "revoke" || command.command === "users") {
        await this.handleAccessCommand(message, command);
        return;
      }

      if (command.command === "status") {
        const transferStatus = this.transferManager
          ? `\nUploads: enabled · active ${this.transferManager.getStatus().active_jobs ?? 0} · queued ${this.transferManager.getStatus().queued_jobs ?? 0}`
          : "\nUploads: disabled";
        await this.sendHtml(
          message,
          `<b>Bot is online</b>\nCache: ${this.resolver.cacheSize} item(s)${transferStatus}\nSend a TeraBox share URL to resolve it.`,
        );
        return;
      }

      if (command.command === "link") {
        await this.resolveMessageLink(message, command.argument);
        return;
      }

      if (command.command === "scan") {
        await this.scanShare(message, command.argument);
        return;
      }

      if (command.command === "setcookie") {
        await this.setCookieCommand(message, command.argument);
        return;
      }

      if (command.command === "logs") {
        await this.sendLogs(message);
        return;
      }

      if (command.command === "upload") {
        await this.enqueueUpload(message, command.argument);
        return;
      }

      if (command.command === "uploadall") {
        await this.enqueueUploadAll(message, command.argument);
        return;
      }

      if (command.command === "jobs") {
        await this.showJobs(message);
        return;
      }

      if (command.command === "stats") {
        await this.showTransferStats(message);
        return;
      }

      if (command.command === "cancel") {
        await this.cancelUpload(message, command.argument);
        return;
      }

      await this.sendHtml(message, "Unknown command. Send <code>/help</code> for instructions.");
      return;
    }

    await this.resolveMessageLink(message, text);
  }

  private async resolveMessageLink(message: TelegramMessage, source: string): Promise<void> {
    const shareUrl = findShareUrl(source);
    const surl = shareUrl ? extractSurl(shareUrl) : null;

    if (!surl) {
      await this.sendHtml(
        message,
        "TeraBox share URL nahi mila. Pura <code>https://...</code> link bhejein, ya <code>/help</code> use karein.",
      );
      return;
    }

    try {
      await this.call<boolean>("sendChatAction", { chat_id: message.chat.id, action: "typing" }, 10_000);
    } catch {
      // A chat action is optional; resolving the user request is more important.
    }

    try {
      const { value: share } = await this.resolver.resolve(surl);
      const browser = this.createBrowserSession(message.chat.id, message.from?.id ?? message.chat.id, share);
      await this.sendHtml(message, this.renderBrowserText(browser), this.renderBrowserKeyboard(browser));
      // Send a copy of the resolved content to the dump channel.
      const body = formatShareMessage(share, this.config.maxFilesPerReply);
      await this.sendToDump(
        `📦 <b>Content copy</b> · by <code>${message.from?.id ?? message.chat.id}</code>\n${body}`,
      );
    } catch (error) {
      const userMessage =
        error instanceof TeraBoxError
          ? error.message
          : "Link process nahi ho saka. Thodi der baad phir try karein.";
      await this.sendText(message, `⚠️ ${truncate(userMessage, 700)}`);
    }
  }

  /** Recursively walks every sub-folder of a share and reports the full list. */
  private async scanShare(message: TelegramMessage, source: string): Promise<void> {
    const shareUrl = findShareUrl(source);
    const surl = shareUrl ? extractSurl(shareUrl) : null;
    if (!surl) {
      await this.sendHtml(
        message,
        "TeraBox share URL nahi mila. Pura <code>https://...</code> link bhejein, ya <code>/help</code> use karein.",
      );
      return;
    }

    try {
      await this.call<boolean>("sendChatAction", { chat_id: message.chat.id, action: "typing" }, 10_000);
    } catch {
      // Optional.
    }

    const statusMessage = await this.sendHtml(
      message,
      "<b>🔎 Folder scan start hua…</b>\nSub-folders ko traverse kiya ja raha hai. Thodi der ruko.",
    );

    try {
      const scanned = await this.resolver.scanAll(surl);
      const files = scanned.filter((item) => !item.isFolder);
      const folders = scanned.filter((item) => item.isFolder);
      const totalBytes = files.reduce((sum, item) => sum + (item.sizeBytes ?? 0), 0);

      const lines = [
        `<b>📂 Scan complete</b>`,
        `Surl: <code>${escapeHtml(surl)}</code>`,
        `Folders: ${folders.length}`,
        `Files: ${files.length}`,
        `Total size: ${escapeHtml(formatBytes(totalBytes))}`,
        "",
      ];
      if (files.length === 0) {
        lines.push("<i>Koi file nahi mili.</i>");
      } else {
        const shown = files.slice(0, 20);
        shown.forEach((file, index) => {
          const size = file.sizeBytes !== undefined ? ` · ${escapeHtml(formatBytes(file.sizeBytes))}` : "";
          lines.push(`<b>${index + 1}.</b> <code>${escapeHtml(truncate(file.relativePath, 120))}</code>${size}`);
        });
        if (files.length > shown.length) {
          lines.push(`<i>… aur ${files.length - shown.length} file(s).</i>`);
        }
      }
      lines.push("", "Poore folder ko download karne ke liye <code>/uploadall</code> use karein (agar upload enabled ho).");

      await this.editHtml(statusMessage.chat.id, statusMessage.message_id, lines.join("\n"));
    } catch (error) {
      const userMessage =
        error instanceof TeraBoxError ? error.message : "Folder scan nahi ho saka. Thodi der baad try karein.";
      await this.editHtml(statusMessage.chat.id, statusMessage.message_id, `<b>⚠️ Scan failed</b>\n${escapeHtml(truncate(userMessage, 700))}`);
    }
  }

  /** Registers the bot's command menu (shown by Telegram's "/" button). */
  private async registerCommands(): Promise<void> {
    const commands = [
      { command: "start", description: "Bot start karein" },
      { command: "help", description: "Help message" },
      { command: "link", description: "TeraBox link resolve karein" },
      { command: "scan", description: "Saare sub-folders scan karein" },
      ...(this.transferManager
        ? [
            { command: "upload", description: "Ek file upload karein" },
            { command: "uploadall", description: "Poore folder upload karein" },
            { command: "jobs", description: "Transfer queue dekhein" },
            { command: "stats", description: "Transfer stats" },
            { command: "cancel", description: "Transfer rok dein" },
          ]
        : []),
      { command: "status", description: "Bot status" },
      { command: "logs", description: "Aakhri 40 logs dekhein" },
      { command: "setcookie", description: "TeraBox cookies update karein" },
      { command: "id", description: "Apna User/Chat ID dekhein" },
      { command: "access", description: "User ko access dein (owner)" },
      { command: "users", description: "Allowed users list (owner)" },
    ];
    await this.call<boolean>("setMyCommands", { commands }, 15_000);
  }

  /** Runtime cookie update. Expects a JSON object of cookie name -> value. */
  private async setCookieCommand(message: TelegramMessage, argument: string): Promise<void> {
    if (!this.resolver.setCookies) {
      await this.sendHtml(message, "Cookie update is not supported on this build.");
      return;
    }
    const raw = argument.trim();
    if (!raw) {
      await this.sendHtml(
        message,
        "Use: <code>/setcookie {&quot;ndus&quot;:&quot;...&quot;,&quot;browserid&quot;:&quot;...&quot;}</code>",
      );
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      await this.sendHtml(message, "⚠️ Invalid JSON. Valid example:\n<code>{\"ndus\":\"abc\",\"browserid\":\"xyz\"}</code>");
      return;
    }
    if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
      await this.sendHtml(message, "⚠️ Cookie ek JSON object honi chahiye: <code>{\"name\":\"value\"}</code>");
      return;
    }
    const cookies: Record<string, string> = {};
    for (const [name, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value !== "string" && typeof value !== "number") {
        await this.sendHtml(message, `⚠️ "${name}" ki value string/number honi chahiye.`);
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
    await this.sendHtml(message, `✅ TeraBox cookies update ho gayi.<br>Cookies: <code>${escapeHtml(names)}</code>`);
  }

  /** Sends the last ~40 captured log lines to the requester. */
  private async sendLogs(message: TelegramMessage): Promise<void> {
    const entries = logBuffer.tail(40);
    if (entries.length === 0) {
      await this.sendText(message, "Abhi koi logs nahi hain.");
      return;
    }
    const lines = entries.map((entry) => {
      const time = new Date(entry.ts).toLocaleTimeString();
      return `<code>[${time}] [${entry.level.toUpperCase()}]</code> ${escapeHtml(truncate(entry.message, 300))}`;
    });
    await this.sendHtml(message, `<b>Last ${entries.length} logs</b>\n${lines.join("\n")}`);
  }

  /** Owner-only access management: /access, /revoke, /users. */
  private async handleAccessCommand(
    message: TelegramMessage,
    command: { command: string; argument: string },
  ): Promise<void> {
    if (!this.isOwner(message.from!.id)) {
      await this.sendHtml(message, "⛔ Access commands sirf bot owner ke liye hain.");
      return;
    }
    if (!this.accessStore) {
      await this.sendHtml(message, "⚠️ Access store enabled nahi hai (set TELEGRAM_OWNER_ID).");
      return;
    }

    if (command.command === "users") {
      const users = this.accessStore.list();
      const lines = [
        `<b>Allowed users</b> (${users.length} + owner + env list)`,
        `Owner: <code>${this.config.ownerId}</code>`,
        ...users.map((u) => `• <code>${u.userId}</code> — ${new Date(u.grantedAtMs).toLocaleString()}`),
      ];
      await this.sendHtml(message, lines.join("\n"));
      return;
    }

    const target = Number(command.argument.trim());
    if (!Number.isSafeInteger(target) || target <= 0) {
      await this.sendHtml(
        message,
        `Use: <code>/${command.command} &lt;user-id&gt;</code>\nUser ID nikalne ke liye user bot me <code>/id</code> bheje.`,
      );
      return;
    }

    if (command.command === "access") {
      const added = this.accessStore.grant(target, message.from!.id);
      await this.sendHtml(
        message,
        added
          ? `✅ User <code>${target}</code> ko access de diya. Ab wo bot use kar sakta hai.`
          : `ℹ️ User <code>${target}</code> ko pehle se access hai.`,
      );
      await this.notifyUserActivity({ id: target }, message.chat.id);
      return;
    }

    // /revoke
    const removed = this.accessStore.revoke(target);
    await this.sendHtml(
      message,
      removed ? `⛔ User <code>${target}</code> ka access hat gaya.` : `ℹ️ User <code>${target}</code> allowed list me nahi tha.`,
    );
  }

  private createBrowserSession(chatId: number, userId: number, share: ResolvedShare): BrowserSession {
    this.pruneBrowserSessions();
    const session: BrowserSession = {
      id: randomUUID().replace(/-/g, "").slice(0, 10),
      chatId,
      userId,
      surl: share.surl,
      directory: share.directory,
      files: share.files,
      page: 0,
      expiresAt: Date.now() + BROWSER_SESSION_TTL_MS,
    };
    this.browserSessions.set(session.id, session);
    return session;
  }

  private pruneBrowserSessions(): void {
    const now = Date.now();
    for (const [id, session] of this.browserSessions) {
      if (session.expiresAt <= now) {
        this.browserSessions.delete(id);
      }
    }
  }

  private renderBrowserText(session: BrowserSession): string {
    const pageCount = Math.max(1, Math.ceil(session.files.length / BROWSER_PAGE_SIZE));
    const page = Math.min(session.page, pageCount - 1);
    const start = page * BROWSER_PAGE_SIZE;
    const pageFiles = session.files.slice(start, start + BROWSER_PAGE_SIZE);
    const location = session.directory || "/";
    const lines = [
      "<b>📂 TeraBox file browser</b>",
      `Folder: <code>${escapeHtml(truncate(location, 180))}</code>`,
      `${session.files.length} item(s) · Page ${page + 1}/${pageCount}`,
      "",
    ];

    if (pageFiles.length === 0) {
      lines.push("<i>This folder is empty.</i>");
    }
    for (let index = 0; index < pageFiles.length; index += 1) {
      const file = pageFiles[index];
      const globalIndex = start + index + 1;
      const kind = file.isFolder ? "📁" : "📄";
      const size = file.sizeBytes !== undefined ? ` · ${escapeHtml(formatBytes(file.sizeBytes))}` : "";
      lines.push(`${kind} <b>${globalIndex}. ${escapeHtml(truncate(file.name, 130))}</b>${size}`);
    }

    lines.push("", "Buttons se folder open, direct download, ya Telegram upload choose karein.");
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
      const label = truncate(file.name, 36);
      if (file.isFolder) {
        rows.push([
          { text: `📁 Open ${label}`, callback_data: `tb:${session.id}:o:${index}` },
        ]);
        continue;
      }

      const row: InlineKeyboardButton[] = [];
      if (file.download) {
        row.push({ text: `⬇️ Download ${index + 1}`, url: file.download });
      }
      if (this.transferManager && file.download) {
        row.push({ text: `⬆️ Upload ${index + 1}`, callback_data: `tb:${session.id}:u:${index}` });
      }
      if (row.length === 0) {
        row.push({ text: `🔒 ${label} unavailable`, callback_data: `tb:${session.id}:x:${index}` });
      }
      rows.push(row);
    }

    const navigation: InlineKeyboardButton[] = [];
    if (session.directory) {
      navigation.push({ text: "⬅️ Back", callback_data: `tb:${session.id}:b` });
    }
    if (page > 0) {
      navigation.push({ text: "◀️ Prev", callback_data: `tb:${session.id}:p:${page - 1}` });
    }
    if (page < pageCount - 1) {
      navigation.push({ text: "Next ▶️", callback_data: `tb:${session.id}:p:${page + 1}` });
    }
    if (navigation.length > 0) {
      rows.push(navigation);
    }

    return { inline_keyboard: rows };
  }

  private folderPath(session: BrowserSession, file: TeraBoxFile): string {
    if (file.path) {
      return file.path;
    }
    return path.posix.join(session.directory || "/", file.name);
  }

  private async handleCallbackQuery(query: TelegramCallbackQuery): Promise<void> {
    const message = query.message;
    const data = query.data;
    if (!message || !data) {
      await this.answerCallback(query.id, "This button is no longer available.");
      return;
    }
    if (!this.isAllowed(query.from.id)) {
      await this.answerCallback(query.id, "Not authorized.", true);
      return;
    }

    if (data.startsWith("tc:")) {
      const cancelled = this.transferManager?.cancel(message.chat.id, data.slice(3), query.from.id);
      await this.answerCallback(query.id, cancelled ? "Cancellation requested." : "Active job not found.");
      return;
    }

    const match = data.match(/^tb:([a-f0-9]{10}):([obupx])(?::(\d+))?$/i);
    if (!match?.[1] || !match[2]) {
      await this.answerCallback(query.id, "Invalid button action.");
      return;
    }
    this.pruneBrowserSessions();
    const session = this.browserSessions.get(match[1]);
    if (!session || session.chatId !== message.chat.id || session.userId !== query.from.id) {
      await this.answerCallback(query.id, "This file menu expired. Send the link again.", true);
      return;
    }
    session.expiresAt = Date.now() + BROWSER_SESSION_TTL_MS;

    const action = match[2];
    const index = match[3] === undefined ? undefined : Number(match[3]);
    if (action === "p" && index !== undefined) {
      const pageCount = Math.max(1, Math.ceil(session.files.length / BROWSER_PAGE_SIZE));
      session.page = Math.max(0, Math.min(pageCount - 1, index));
      await this.answerCallback(query.id);
      await this.editHtml(message.chat.id, message.message_id, this.renderBrowserText(session), this.renderBrowserKeyboard(session));
      return;
    }
    if (action === "b") {
      const parent = path.posix.dirname(session.directory || "/");
      const directory = parent === "/" || parent === "." ? undefined : parent;
      try {
        await this.answerCallback(query.id, "Opening folder…");
        const { value: share } = await this.resolver.resolve(session.surl, directory);
        session.directory = share.directory;
        session.files = share.files;
        session.page = 0;
        await this.editHtml(message.chat.id, message.message_id, this.renderBrowserText(session), this.renderBrowserKeyboard(session));
      } catch {
        await this.editHtml(message.chat.id, message.message_id, "<b>⚠️ Folder open nahi ho saka.</b>\nLink ko phir se bhejkar try karein.");
      }
      return;
    }
    if (index === undefined || !Number.isSafeInteger(index) || index < 0 || index >= session.files.length) {
      await this.answerCallback(query.id, "File selection invalid.");
      return;
    }

    const file = session.files[index];
    if (action === "o") {
      if (!file.isFolder) {
        await this.answerCallback(query.id, "This is not a folder.");
        return;
      }
      try {
        await this.answerCallback(query.id, "Opening folder…");
        const { value: share } = await this.resolver.resolve(session.surl, this.folderPath(session, file));
        session.directory = share.directory;
        session.files = share.files;
        session.page = 0;
        await this.editHtml(message.chat.id, message.message_id, this.renderBrowserText(session), this.renderBrowserKeyboard(session));
      } catch {
        await this.editHtml(message.chat.id, message.message_id, "<b>⚠️ Folder open nahi ho saka.</b>\nLink ko phir se bhejkar try karein.");
      }
      return;
    }
    if (action === "u") {
      if (!file.download || file.isFolder) {
        await this.answerCallback(query.id, "Upload ke liye file available nahi hai.");
        return;
      }
      await this.answerCallback(query.id, "Upload queue me add kiya ja raha hai…");
      await this.queueUpload(message, {
        surl: session.surl,
        directory: session.directory,
        fileIndex: index + 1,
        ownerUserId: query.from.id,
      });
      return;
    }

    await this.answerCallback(query.id, "This item has no available action.");
  }

  private async enqueueUpload(message: TelegramMessage, argument: string): Promise<void> {
    if (!this.transferManager) {
      await this.sendHtml(
        message,
        "Telegram upload is disabled on this server. Direct download link ke liye URL bhejein.",
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
        "Use <code>/upload &lt;TeraBox URL&gt; [file-number]</code>. Example: <code>/upload https://terabox.app/s/abc 2</code>",
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
      await this.sendHtml(
        message,
        "Telegram upload is disabled on this server. Direct download link ke liye URL bhejein.",
      );
      return;
    }

    const shareUrl = findShareUrl(argument);
    const surl = shareUrl ? extractSurl(shareUrl) : null;
    if (!surl) {
      await this.sendHtml(
        message,
        "Use <code>/uploadall &lt;TeraBox URL&gt;</code>. Example: <code>/uploadall https://terabox.app/s/abc</code>",
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
      await this.sendHtml(message, "Telegram upload is disabled on this server.");
      return;
    }

    const statusMessage = await this.sendHtml(message, "<b>⏳ Upload queue me add kiya ja raha hai…</b>");
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
      const detail = truncate(error instanceof Error ? error.message : "Could not queue this transfer.", 700);
      await this.editHtml(
        statusMessage.chat.id,
        statusMessage.message_id,
        `<b>⚠️ Upload queue failed</b>\n${escapeHtml(detail)}`,
      );
    }
  }

  private async showJobs(message: TelegramMessage): Promise<void> {
    if (!this.transferManager) {
      await this.sendHtml(message, "Telegram upload is disabled on this server.");
      return;
    }

    const jobs = this.transferManager.list(message.chat.id, message.from?.id);
    if (jobs.length === 0) {
      await this.sendHtml(message, "Abhi koi transfer job nahi hai.");
      return;
    }

    const lines = ["<b>Your latest transfer jobs</b>"];
    for (const job of jobs) {
      const filename = escapeHtml(truncate(job.filename ?? "TeraBox file", 80));
      const progress = job.progress !== undefined ? ` — ${Math.floor(job.progress * 100)}%` : "";
      lines.push(`• <code>${escapeHtml(job.id)}</code> · ${escapeHtml(job.stage)}${progress}\n  ${filename}`);
    }
    lines.push("\nUse <code>/cancel &lt;job-id&gt;</code> to stop one transfer.");
    await this.sendHtml(message, lines.join("\n"));
  }

  private async showTransferStats(message: TelegramMessage): Promise<void> {
    if (!this.transferManager) {
      await this.sendHtml(message, "Telegram upload is disabled on this server.");
      return;
    }
    const status = this.transferManager.getStatus();
    const dashboard = this.transferManager.getDashboard?.();
    const totals = dashboard?.totals && typeof dashboard.totals === "object"
      ? dashboard.totals as Record<string, unknown>
      : {};
    const dailyLimit = status.per_user_daily_limit === 0 ? "off" : status.per_user_daily_limit ?? "?";
    await this.sendHtml(
      message,
      [
        "<b>📊 Transfer stats</b>",
        `Active: ${status.active_jobs ?? 0}`,
        `Queued: ${status.queued_jobs ?? 0}/${status.max_queue ?? "?"}`,
        `Upload limit: ${escapeHtml(String(status.upload_limit ?? "?"))}`,
        `Daily user limit: ${dailyLimit}`,
        `Completed: ${totals.completed ?? 0}`,
        `Failed: ${totals.failed ?? 0}`,
        `Cancelled: ${totals.cancelled ?? 0}`,
      ].join("\n"),
    );
  }

  private async cancelUpload(message: TelegramMessage, argument: string): Promise<void> {
    if (!this.transferManager) {
      await this.sendHtml(message, "Telegram upload is disabled on this server.");
      return;
    }

    const cancelled = this.transferManager.cancel(message.chat.id, argument || undefined, message.from?.id);
    if (!cancelled) {
      await this.sendHtml(
        message,
        "Active job nahi mila. <code>/jobs</code> se job ID dekhein, phir <code>/cancel job-id</code> use karein.",
      );
      return;
    }
    await this.sendHtml(message, `<b>⏹️ Cancellation requested</b>\nJob: <code>${escapeHtml(cancelled.id)}</code>`);
  }

  private async updateTransferStatus(snapshot: TransferSnapshot): Promise<void> {
    if (snapshot.statusMessageId === undefined) {
      return;
    }
    const cancellable = ["queued", "preparing", "downloading", "splitting", "uploading"].includes(snapshot.stage);
    const replyMarkup = cancellable
      ? { inline_keyboard: [[{ text: "⏹ Cancel transfer", callback_data: `tc:${snapshot.id}` }]] }
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
    if (this.config.allowPublic) {
      return true;
    }
    if (this.isOwner(userId)) {
      return true;
    }
    if (this.config.allowedUserIds.has(userId)) {
      return true;
    }
    return Boolean(this.accessStore?.has(userId));
  }

  /** Sends a copy of content / user activity to the dump (destination) channel. */
  private async sendToDump(text: string, timeoutMs = 20_000): Promise<void> {
    const target = this.config.destChannelId;
    if (!target) {
      return;
    }
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
      // Dump delivery is best-effort; it must never break a user request.
      this.logger.warn("[telegram] Could not deliver to dump channel (is the bot in it?).");
    });
  }

  private userLabel(from: TelegramUser): string {
    const name = [from.first_name, from.last_name].filter(Boolean).join(" ") || "Unknown";
    return from.username ? `${name} (@${from.username})` : name;
  }

  /** Notifies the dump channel that a user interacted with the bot. */
  private async notifyUserActivity(from: TelegramUser, chatId: number): Promise<void> {
    await this.sendToDump(
      `👤 <b>User activity</b>\n` +
        `User ID: <code>${from.id}</code>\n` +
        `Name: ${escapeHtml(this.userLabel(from))}\n` +
        `Chat ID: <code>${chatId}</code>`,
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
      if (error instanceof TelegramApiError) {
        throw error;
      }
      if (controller.signal.aborted) {
        throw new TelegramApiError("Telegram request timed out or was stopped.");
      }
      throw new TelegramApiError("Could not reach the Telegram Bot API.");
    } finally {
      clearTimeout(timer);
      this.stopController.signal.removeEventListener("abort", stopRequest);
    }
  }

  private endpoint(method: string): string {
    return `https://api.telegram.org/bot${encodeURIComponent(this.config.token)}/${method}`;
  }
}
