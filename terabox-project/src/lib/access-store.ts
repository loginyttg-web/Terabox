import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export interface AccessStoreOptions {
  databasePath: string;
  /** Users to seed on first run (from env TELEGRAM_ALLOWED_USER_IDS). */
  seedIds?: Iterable<number>;
  now?: () => number;
}

export interface AllowedUser {
  userId: number;
  grantedAtMs: number;
  grantedBy?: number;
}

/**
 * Persists runtime-granted bot access (the /access, /revoke commands).
 * On free Render (ephemeral /tmp) grants reset on restart but env-seeded
 * users are always re-added; on a disk-backed host grants persist.
 */
export class AccessStore {
  private readonly db: DatabaseSync;
  private readonly now: () => number;

  constructor(options: AccessStoreOptions) {
    const resolvedPath = options.databasePath;
    if (resolvedPath !== ":memory:") {
      mkdirSync(path.dirname(path.resolve(resolvedPath)), { recursive: true, mode: 0o700 });
    }
    this.now = options.now ?? Date.now;
    this.db = new DatabaseSync(resolvedPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS allowed_users (
        user_id INTEGER PRIMARY KEY,
        granted_at_ms INTEGER NOT NULL,
        granted_by INTEGER
      );
    `);
    if (options.seedIds) {
      for (const id of options.seedIds) {
        this.db
          .prepare("INSERT OR IGNORE INTO allowed_users (user_id, granted_at_ms) VALUES (?, ?)")
          .run(id, this.now());
      }
    }
  }

  has(userId: number): boolean {
    return !!this.db.prepare("SELECT 1 AS x FROM allowed_users WHERE user_id = ?").get(userId);
  }

  grant(userId: number, grantedBy?: number): boolean {
    const result = this.db
      .prepare("INSERT OR IGNORE INTO allowed_users (user_id, granted_at_ms, granted_by) VALUES (?, ?, ?)")
      .run(userId, this.now(), grantedBy ?? null);
    return result.changes > 0;
  }

  revoke(userId: number): boolean {
    const result = this.db.prepare("DELETE FROM allowed_users WHERE user_id = ?").run(userId);
    return result.changes > 0;
  }

  list(): AllowedUser[] {
    const rows = this.db
      .prepare("SELECT user_id, granted_at_ms, granted_by FROM allowed_users ORDER BY granted_at_ms ASC")
      .all() as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      userId: Number(row.user_id),
      grantedAtMs: Number(row.granted_at_ms),
      ...(row.granted_by != null ? { grantedBy: Number(row.granted_by) } : {}),
    }));
  }

  count(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS c FROM allowed_users").get() as Record<string, unknown>;
    return Number(row.c ?? 0);
  }

  close(): void {
    this.db.close();
  }
}
