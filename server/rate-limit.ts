/**
 * Limitador de taxa em memória (token bucket por chave).
 * Adequado para uma instância. Com várias instâncias, mover para Redis
 * (ver ADR-0004). As chaves inativas são limpas periodicamente.
 */
export interface RateLimiter {
  take(key: string, now?: number): boolean;
}

export function createRateLimiter(capacity: number, refillPerSecond: number): RateLimiter {
  const buckets = new Map<string, { tokens: number; updated: number }>();
  let lastSweep = 0;

  return {
    take(key, now = Date.now()) {
      if (now - lastSweep > 60_000) {
        for (const [k, b] of buckets) if (now - b.updated > 10 * 60_000) buckets.delete(k);
        lastSweep = now;
      }
      const b = buckets.get(key) ?? { tokens: capacity, updated: now };
      const elapsed = (now - b.updated) / 1000;
      b.tokens = Math.min(capacity, b.tokens + elapsed * refillPerSecond);
      b.updated = now;
      const allowed = b.tokens >= 1;
      if (allowed) b.tokens -= 1;
      buckets.set(key, b);
      return allowed;
    },
  };
}
