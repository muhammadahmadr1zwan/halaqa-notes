export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface RetryOptions {
  attempts?: number;
  baseMs?: number;
  maxMs?: number;
  isRetryable?: (e: unknown) => boolean;
  onRetry?: (e: unknown, attempt: number, delayMs: number) => void;
}

/** Exponential backoff with jitter. Non-retryable errors are thrown immediately. */
export async function withRetry<T>(fn: (attempt: number) => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const { attempts = 4, baseMs = 2000, maxMs = 60_000, isRetryable = () => true, onRetry } = opts;
  let lastErr: unknown;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn(i);
    } catch (e) {
      lastErr = e;
      if (i === attempts || !isRetryable(e)) throw e;
      const delay = Math.min(maxMs, baseMs * 2 ** (i - 1)) * (0.75 + Math.random() * 0.5);
      onRetry?.(e, i, delay);
      await sleep(delay);
    }
  }
  throw lastErr;
}

/** Run `fn` over items with at most `limit` in flight; results keep input order. */
export async function mapPool<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}
