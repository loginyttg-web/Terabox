import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { TransferStage } from "./transfer.js";

export interface StoredTransfer {
  id: string;
  chatId: number;
  ownerUserId?: number;
  replyToMessageId: number;
  statusMessageId?: number;
  surl: string;
  directory?: string;
  fileIndex?: number;
  uploadAll?: boolean;
  stage: TransferStage;
  createdAtMs: number;
  updatedAtMs: number;
  filename?: string;
  sourceSizeBytes?: number;
  transferredBytes?: number;
  totalBytes?: number;
  speedBytesPerSecond?: number;
  etaSeconds?: number;
  partIndex?: number;
  partCount?: number;
  error?: string;
  attempt: number;
  maxAttempts: number;
  nextAttemptAtMs?: number;
}

export interface TransferEvent {
  id: number;
  jobId: string;
  createdAtMs: number;
  stage: TransferStage;
  message?: string;
}

type SqlRow = Record<string, unknown>;

function nullableNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function nullableString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asTransfer(row: SqlRow): StoredTransfer {
  return {
    id: String(row.id),
    chatId: Number(row.chat_id),
    ownerUserId: nullableNumber(row.owner_user_id),
    replyToMessageId: Number(row.reply_to_message_id),
    statusMessageId: nullableNumber(row.status_message_id),
    surl: String(row.surl),
    directory: nullableString(row.directory),
    fileIndex: nullableNumber(row.file_index),
    uploadAll: row.upload_all ? Number(row.upload_all) === 1 : undefined,
    stage: String(row.stage) as TransferStage,
    createdAtMs: Number(row.created_at_ms),
    updatedAtMs: Number(row.updated_at_ms),
    filename: nullableString(row.filename),
    sourceSizeBytes: nullableNumber(row.source_size_bytes),
    transferredBytes: nullableNumber(row.transferred_bytes),
    totalBytes: nullableNumber(row.total_bytes),
    speedBytesPerSecond: nullableNumber(row.speed_bytes_per_second),
    etaSeconds: nullableNumber(row.eta_seconds),
    partIndex: nullableNumber(row.part_index),
    partCount: nullableNumber(row.part_count),
    error: nullableString(row.error),
    attempt: Number(row.attempt),
    maxAttempts: Number(row.max_attempts),
    nextAttemptAtMs: nullableNumber(row.next_attempt_at_ms),
  };
}

/**
 * Small SQLite persistence layer for transfer metadata. Files themselves are
 * never stored in SQLite; they remain in per-job temporary directories only.
 */
export class TransferStore {
  private readonly database: DatabaseSync;

  constructor(databasePath: string) {
    if (databasePath !== ":memory:") {
      mkdirSync(path.dirname(path.resolve(databasePath)), { recursive: true, mode: 0o700 });
    }
    this.database = new DatabaseSync(databasePath);
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      CREATE TABLE IF NOT EXISTS transfer_jobs (
        id TEXT PRIMARY KEY,
        chat_id INTEGER NOT NULL,
        owner_user_id INTEGER,
        reply_to_message_id INTEGER NOT NULL,
        status_message_id INTEGER,
        surl TEXT NOT NULL,
        directory TEXT,
        file_index INTEGER,
        upload_all INTEGER,
        stage TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        filename TEXT,
        source_size_bytes INTEGER,
        transferred_bytes INTEGER,
        total_bytes INTEGER,
        speed_bytes_per_second REAL,
        eta_seconds REAL,
        part_index INTEGER,
        part_count INTEGER,
        error TEXT,
        attempt INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL,
        next_attempt_at_ms INTEGER
      );
      CREATE INDEX IF NOT EXISTS transfer_jobs_chat_created
        ON transfer_jobs (chat_id, created_at_ms DESC);
      CREATE INDEX IF NOT EXISTS transfer_jobs_stage_next
        ON transfer_jobs (stage, next_attempt_at_ms);
      CREATE TABLE IF NOT EXISTS transfer_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL,
        stage TEXT NOT NULL,
        message TEXT
      );
      CREATE INDEX IF NOT EXISTS transfer_events_job_created
        ON transfer_events (job_id, created_at_ms DESC);
    `);
    // Existing deployments created before per-user quotas need this small,
    // idempotent schema migration.
    try {
      this.database.exec("ALTER TABLE transfer_jobs ADD COLUMN owner_user_id INTEGER");
    } catch (error) {
      if (!/duplicate column name/i.test(String(error))) {
        throw error;
      }
      // Column already exists.
    }
    this.database.exec(`
      CREATE INDEX IF NOT EXISTS transfer_jobs_owner_created
        ON transfer_jobs (owner_user_id, created_at_ms DESC);
    `);
    // Migration for bulk-upload flag (upload_all).
    try {
      this.database.exec("ALTER TABLE transfer_jobs ADD COLUMN upload_all INTEGER");
    } catch (error) {
      if (!/duplicate column name/i.test(String(error))) {
        throw error;
      }
      // Column already exists.
    }
  }

  save(job: StoredTransfer): void {
    this.database.prepare(`
      INSERT INTO transfer_jobs (
        id, chat_id, owner_user_id, reply_to_message_id, status_message_id, surl, directory, file_index, upload_all,
        stage, created_at_ms, updated_at_ms, filename, source_size_bytes, transferred_bytes,
        total_bytes, speed_bytes_per_second, eta_seconds, part_index, part_count, error,
        attempt, max_attempts, next_attempt_at_ms
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      )
      ON CONFLICT(id) DO UPDATE SET
        chat_id=excluded.chat_id,
        owner_user_id=excluded.owner_user_id,
        reply_to_message_id=excluded.reply_to_message_id,
        status_message_id=excluded.status_message_id,
        surl=excluded.surl,
        directory=excluded.directory,
        file_index=excluded.file_index,
        upload_all=excluded.upload_all,
        stage=excluded.stage,
        updated_at_ms=excluded.updated_at_ms,
        filename=excluded.filename,
        source_size_bytes=excluded.source_size_bytes,
        transferred_bytes=excluded.transferred_bytes,
        total_bytes=excluded.total_bytes,
        speed_bytes_per_second=excluded.speed_bytes_per_second,
        eta_seconds=excluded.eta_seconds,
        part_index=excluded.part_index,
        part_count=excluded.part_count,
        error=excluded.error,
        attempt=excluded.attempt,
        max_attempts=excluded.max_attempts,
        next_attempt_at_ms=excluded.next_attempt_at_ms
    `).run(
      job.id,
      job.chatId,
      job.ownerUserId ?? null,
      job.replyToMessageId,
      job.statusMessageId ?? null,
      job.surl,
      job.directory ?? null,
      job.fileIndex ?? null,
      job.uploadAll ? 1 : null,
      job.stage,
      job.createdAtMs,
      job.updatedAtMs,
      job.filename ?? null,
      job.sourceSizeBytes ?? null,
      job.transferredBytes ?? null,
      job.totalBytes ?? null,
      job.speedBytesPerSecond ?? null,
      job.etaSeconds ?? null,
      job.partIndex ?? null,
      job.partCount ?? null,
      job.error ?? null,
      job.attempt,
      job.maxAttempts,
      job.nextAttemptAtMs ?? null,
    );
  }

  addEvent(jobId: string, createdAtMs: number, stage: TransferStage, message?: string): void {
    this.database.prepare(
      "INSERT INTO transfer_events (job_id, created_at_ms, stage, message) VALUES (?, ?, ?, ?)",
    ).run(jobId, createdAtMs, stage, message ?? null);
  }

  loadRecentForChat(chatId: number, limit: number): StoredTransfer[] {
    const rows = this.database.prepare(
      "SELECT * FROM transfer_jobs WHERE chat_id = ? ORDER BY created_at_ms DESC LIMIT ?",
    ).all(chatId, limit) as SqlRow[];
    return rows.map(asTransfer);
  }

  loadRecent(limit: number): StoredTransfer[] {
    const rows = this.database.prepare(
      "SELECT * FROM transfer_jobs ORDER BY updated_at_ms DESC LIMIT ?",
    ).all(limit) as SqlRow[];
    return rows.map(asTransfer);
  }

  countCreatedByUserSince(ownerUserId: number, sinceMs: number): number {
    const row = this.database.prepare(
      "SELECT COUNT(*) AS count FROM transfer_jobs WHERE owner_user_id = ? AND created_at_ms >= ?",
    ).get(ownerUserId, sinceMs) as SqlRow | undefined;
    return Number(row?.count ?? 0);
  }

  loadRecoverable(now: number): StoredTransfer[] {
    const rows = this.database.prepare(`
      SELECT * FROM transfer_jobs
      WHERE stage IN ('queued', 'preparing', 'downloading', 'splitting', 'uploading')
      ORDER BY created_at_ms ASC
    `).all() as SqlRow[];

    const statement = this.database.prepare(`
      UPDATE transfer_jobs
      SET stage = 'queued', updated_at_ms = ?, next_attempt_at_ms = ?,
          transferred_bytes = NULL, total_bytes = NULL, speed_bytes_per_second = NULL,
          eta_seconds = NULL, error = ?
      WHERE id = ?
    `);
    const recovered: StoredTransfer[] = [];
    for (const row of rows) {
      const job = asTransfer(row);
      const error = "Recovered after service restart; restarting transfer from source.";
      statement.run(now, now, error, job.id);
      recovered.push({
        ...job,
        stage: "queued",
        updatedAtMs: now,
        nextAttemptAtMs: now,
        transferredBytes: undefined,
        totalBytes: undefined,
        speedBytesPerSecond: undefined,
        etaSeconds: undefined,
        error,
      });
    }
    return recovered;
  }

  getDashboard(limit: number): {
    totals: Record<string, number>;
    recentJobs: StoredTransfer[];
    recentEvents: TransferEvent[];
  } {
    const totals: Record<string, number> = {};
    const totalRows = this.database.prepare(
      "SELECT stage, COUNT(*) AS count FROM transfer_jobs GROUP BY stage",
    ).all() as SqlRow[];
    for (const row of totalRows) {
      totals[String(row.stage)] = Number(row.count);
    }

    const jobRows = this.database.prepare(
      "SELECT * FROM transfer_jobs ORDER BY updated_at_ms DESC LIMIT ?",
    ).all(limit) as SqlRow[];
    const eventRows = this.database.prepare(`
      SELECT id, job_id, created_at_ms, stage, message
      FROM transfer_events ORDER BY created_at_ms DESC LIMIT ?
    `).all(limit) as SqlRow[];

    return {
      totals,
      recentJobs: jobRows.map(asTransfer),
      recentEvents: eventRows.map((row) => ({
        id: Number(row.id),
        jobId: String(row.job_id),
        createdAtMs: Number(row.created_at_ms),
        stage: String(row.stage) as TransferStage,
        message: nullableString(row.message),
      })),
    };
  }

  trim(historyLimit: number): void {
    this.database.prepare(`
      DELETE FROM transfer_jobs
      WHERE id IN (
        SELECT id FROM transfer_jobs
        WHERE stage IN ('completed', 'failed', 'cancelled')
        ORDER BY updated_at_ms DESC
        LIMIT -1 OFFSET ?
      )
    `).run(historyLimit);
    this.database.prepare(`
      DELETE FROM transfer_events
      WHERE id NOT IN (
        SELECT id FROM transfer_events ORDER BY created_at_ms DESC LIMIT ?
      )
    `).run(Math.max(historyLimit * 10, 100));
  }

  close(): void {
    this.database.close();
  }
}
