/**
 * Small in-memory ring buffer that captures the process's console output so
 * the admin dashboard and the Telegram /logs command can show recent logs.
 */
export interface LogEntry {
  ts: number;
  level: "log" | "info" | "warn" | "error";
  message: string;
}

const LEVELS = ["log", "info", "warn", "error"] as const;

function formatArgs(args: unknown[]): string {
  return args
    .map((arg) => {
      if (typeof arg === "string") {
        return arg;
      }
      if (arg instanceof Error) {
        return `${arg.name}: ${arg.message}`;
      }
      try {
        return JSON.stringify(arg);
      } catch {
        return String(arg);
      }
    })
    .join(" ");
}

export class LogBuffer {
  private entries: LogEntry[] = [];
  private attached = false;
  private readonly max: number;

  constructor(max = 500) {
    this.max = max;
  }

  /** Wraps console methods so every log line is recorded. Idempotent. */
  attach(): void {
    if (this.attached) {
      return;
    }
    this.attached = true;

    for (const level of LEVELS) {
      const original = console[level]?.bind(console);
      if (typeof original !== "function") {
        continue;
      }
      (console as unknown as Record<string, (...args: unknown[]) => void>)[level] = (
        ...args: unknown[]
      ) => {
        this.push(level, formatArgs(args));
        original(...args);
      };
    }
  }

  push(level: LogEntry["level"], message: string): void {
    this.entries.push({ ts: Date.now(), level, message });
    if (this.entries.length > this.max) {
      this.entries.splice(0, this.entries.length - this.max);
    }
  }

  /** Returns the last `count` log lines, newest first. */
  tail(count = 40): LogEntry[] {
    return this.entries.slice(-count).reverse();
  }
}

export const logBuffer = new LogBuffer();
