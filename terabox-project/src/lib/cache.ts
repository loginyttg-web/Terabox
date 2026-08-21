export interface CachedValue<T> {
  value: T;
  cacheHit: boolean;
}

interface CacheEntry<T> {
  value?: T;
  expiresAt?: number;
  inFlight?: Promise<T>;
}

/**
 * A tiny bounded, TTL-aware cache. In-flight requests are shared so a popular
 * Telegram message cannot trigger many identical upstream TeraBox requests.
 */
export class ExpiringCache<T> {
  private readonly entries = new Map<string, CacheEntry<T>>();

  constructor(
    private readonly ttlMs: number,
    private readonly maxItems: number,
    private readonly now: () => number = () => Date.now(),
  ) {}

  get size(): number {
    return this.entries.size;
  }

  async getOrLoad(key: string, loader: () => Promise<T>): Promise<CachedValue<T>> {
    const existing = this.entries.get(key);
    const currentTime = this.now();

    if (existing?.value !== undefined && existing.expiresAt !== undefined && currentTime < existing.expiresAt) {
      // Reinsert to make the Map ordering act as a simple LRU list.
      this.entries.delete(key);
      this.entries.set(key, existing);
      return { value: existing.value, cacheHit: true };
    }

    if (existing?.inFlight) {
      return { value: await existing.inFlight, cacheHit: true };
    }

    const entry: CacheEntry<T> = {};
    const request = Promise.resolve().then(loader);
    entry.inFlight = request;
    this.entries.set(key, entry);

    try {
      const value = await request;
      entry.value = value;
      entry.expiresAt = this.now() + this.ttlMs;
      delete entry.inFlight;
      this.evict();
      return { value, cacheHit: false };
    } catch (error) {
      // Do not cache transient upstream failures.
      if (this.entries.get(key) === entry) {
        this.entries.delete(key);
      }
      throw error;
    }
  }

  clear(): void {
    this.entries.clear();
  }

  private evict(): void {
    const currentTime = this.now();
    for (const [key, entry] of this.entries) {
      if (!entry.inFlight && (entry.expiresAt === undefined || entry.expiresAt <= currentTime)) {
        this.entries.delete(key);
      }
    }

    while (this.entries.size > this.maxItems) {
      const oldestKey = this.entries.keys().next().value as string | undefined;
      if (!oldestKey) {
        break;
      }
      this.entries.delete(oldestKey);
    }
  }
}
