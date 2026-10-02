/**
 * Small TTL cache with in-flight promise deduplication.
 *
 * Two jobs, both about not hammering OpenStatus:
 *  - cache: five connected phones asking for uptime must not become five
 *    upstream requests.
 *  - dedupe: five phones asking *simultaneously* on a cold cache must not become
 *    five upstream requests either. Plain TTL caching does not protect against
 *    that; sharing the in-flight promise does.
 */
interface Entry<T> {
  value: T;
  expiresAt: number;
}

export class TtlCache<T> {
  private readonly entries = new Map<string, Entry<T>>();
  private readonly inflight = new Map<string, Promise<T>>();

  constructor(
    private readonly ttlMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  async resolve(key: string, load: () => Promise<T>): Promise<T> {
    const cached = this.entries.get(key);
    if (cached && cached.expiresAt > this.now()) return cached.value;

    const pending = this.inflight.get(key);
    if (pending) return pending;

    const promise = load()
      .then((value) => {
        this.entries.set(key, { value, expiresAt: this.now() + this.ttlMs });
        return value;
      })
      .finally(() => {
        this.inflight.delete(key);
      });

    this.inflight.set(key, promise);
    return promise;
  }

  set(key: string, value: T): void {
    this.entries.set(key, { value, expiresAt: this.now() + this.ttlMs });
  }

  /** Invalidate without a refetch — used after a webhook or a mutation. */
  delete(key: string): void {
    this.entries.delete(key);
  }

  /** Drop entries whose key starts with the given prefix. */
  deletePrefix(prefix: string): void {
    for (const key of [...this.entries.keys()]) {
      if (key.startsWith(prefix)) this.entries.delete(key);
    }
  }

  clear(): void {
    this.entries.clear();
  }
}

/**
 * Run `tasks` with at most `limit` in flight.
 *
 * OpenStatus allows 600 requests/minute per API key. An unbounded
 * `Promise.all` over 100 monitors would eat that in seconds.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;

  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = cursor++;
      const item = items[index];
      if (item === undefined) return;
      results[index] = await fn(item, index);
    }
  });

  await Promise.all(workers);
  return results;
}