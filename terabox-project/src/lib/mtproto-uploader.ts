import { stat } from "node:fs/promises";
import { TelegramClient, sessions, type Api } from "teleproto";
import type { TelegramConfig, TransferConfig } from "../config.js";
import {
  TransferCancelledError,
  TransferError,
  type TelegramFileUploader,
  type UploadInput,
} from "./transfer.js";

/**
 * Uploads as the same BotFather bot over Telegram's raw MTProto API. This is
 * separate from the standard Bot API used for commands/progress messages and
 * permits the larger raw Telegram file path when Telegram allows it.
 */
export class MtprotoBotUploader implements TelegramFileUploader {
  private readonly apiId: number;
  private readonly apiHash: string;
  private readonly botToken: string;
  private readonly workers: number;
  private readonly destChannelId?: number;
  private client: TelegramClient | undefined;
  private connecting: Promise<TelegramClient> | undefined;

  constructor(telegram: TelegramConfig, transfer: TransferConfig) {
    this.apiId = transfer.apiId;
    this.apiHash = transfer.apiHash;
    this.botToken = telegram.token;
    this.workers = transfer.uploadWorkers;
    this.destChannelId = telegram.destChannelId;
  }

  async upload(input: UploadInput): Promise<void> {
    if (input.signal.aborted) {
      throw new TransferCancelledError();
    }

    const fileStats = await stat(input.filePath);
    if (!fileStats.isFile() || fileStats.size <= 0) {
      throw new TransferError("Temporary transfer file is missing or empty.");
    }

    const client = await this.getClient();
    const progressCallback = ((progress: number) => {
      if (input.signal.aborted) {
        progressCallback.isCanceled = true;
        return;
      }
      input.onProgress(progress);
    }) as ((progress: number) => void) & { isCanceled?: boolean };
    const cancel = () => {
      progressCallback.isCanceled = true;
    };
    input.signal.addEventListener("abort", cancel, { once: true });

    try {
      const sendOptions: {
        file: string;
        fileSize: number;
        forceDocument: boolean;
        supportsStreaming: boolean;
        workers: number;
        caption: string;
        formattingEntities: Api.TypeMessageEntity[];
        progressCallback: (progress: number) => void;
      } = {
        file: input.filePath,
        fileSize: fileStats.size,
        forceDocument: input.mediaMode !== "video",
        supportsStreaming: input.mediaMode === "video",
        workers: this.workers,
        caption: input.caption,
        // Avoid parsing user-controlled filenames as Markdown in the caption.
        formattingEntities: [],
        progressCallback,
      };

      await client.sendFile(input.chatId, {
        ...sendOptions,
        replyTo: input.replyToMessageId,
      });

      // Also send a copy to the dump/destination channel if configured and
      // different from the requesting chat.
      if (this.destChannelId !== undefined && this.destChannelId !== input.chatId) {
        await client.sendFile(this.destChannelId, {
          ...sendOptions,
          replyTo: undefined,
        }).catch(() => {
          // Dump copy is best-effort (bot must be admin/member of the channel).
        });
      }

      if (input.signal.aborted) {
        throw new TransferCancelledError();
      }
      input.onProgress(1);
    } catch (error) {
      if (input.signal.aborted || error instanceof TransferCancelledError) {
        throw new TransferCancelledError();
      }
      throw new TransferError("Telegram upload failed. Check API credentials, bot permissions, and file-size limits.");
    } finally {
      input.signal.removeEventListener("abort", cancel);
    }
  }

  async stop(): Promise<void> {
    const client = this.client;
    this.client = undefined;
    this.connecting = undefined;
    await client?.disconnect().catch(() => undefined);
  }

  private async getClient(): Promise<TelegramClient> {
    if (this.client) {
      return this.client;
    }
    if (this.connecting) {
      return this.connecting;
    }

    this.connecting = this.connect();
    try {
      this.client = await this.connecting;
      return this.client;
    } finally {
      this.connecting = undefined;
    }
  }

  private async connect(): Promise<TelegramClient> {
    const client = new TelegramClient(new sessions.StringSession(""), this.apiId, this.apiHash, {
      connectionRetries: 5,
      requestRetries: 5,
      reconnectRetries: 5,
      floodSleepThreshold: 30,
      deviceModel: "TeraBox Transfer Bot",
      appVersion: "2.2.0",
    });

    try {
      await client.start({ botAuthToken: this.botToken });
      return client;
    } catch {
      await client.disconnect().catch(() => undefined);
      throw new TransferError("Could not authorize the raw Telegram upload client.");
    }
  }
}
