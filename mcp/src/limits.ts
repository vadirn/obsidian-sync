import type { Request, Response, NextFunction } from "express";

// Flood guards for a 1-core/2GB box. Each `consult` runs vault-query, which
// rebuilds an in-memory tantivy index per call (no daemon), so an unbounded
// burst can OOM the box and take WireGuard down with it. Two independent guards:
// a per-IP token bucket (request frequency) and a global semaphore (simultaneous
// index builds). Hand-rolled to avoid a dependency on a security-sensitive box.

interface Bucket {
  tokens: number;
  last: number; // ms timestamp of the last refill
}

/**
 * Per-IP token-bucket rate limiter as Express middleware. Each IP gets `capacity`
 * tokens that refill linearly over `windowMs`; a request spends one token and an
 * empty bucket yields HTTP 429 with `Retry-After`. Idle (full) buckets are swept
 * so the map cannot grow unbounded under a spoofed-IP flood.
 *
 * Requires `app.set("trust proxy", 1)` so `req.ip` is the real client from Caddy's
 * X-Forwarded-For rather than Caddy's own address (else every request shares one
 * bucket).
 */
export function rateLimit(opts: {
  capacity: number;
  windowMs: number;
}): (req: Request, res: Response, next: NextFunction) => void {
  const { capacity, windowMs } = opts;
  const refillPerMs = capacity / windowMs;
  const buckets = new Map<string, Bucket>();

  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [ip, b] of buckets) {
      if (Math.min(capacity, b.tokens + (now - b.last) * refillPerMs) >= capacity) {
        buckets.delete(ip);
      }
    }
  }, windowMs);
  sweep.unref(); // never keep the process alive for the sweep

  return (req, res, next) => {
    const ip = req.ip ?? "unknown";
    const now = Date.now();
    let b = buckets.get(ip);
    if (!b) {
      b = { tokens: capacity, last: now };
      buckets.set(ip, b);
    } else {
      b.tokens = Math.min(capacity, b.tokens + (now - b.last) * refillPerMs);
      b.last = now;
    }
    if (b.tokens < 1) {
      const retryS = Math.ceil((1 - b.tokens) / refillPerMs / 1000);
      res
        .status(429)
        .set("Retry-After", String(retryS))
        .json({
          jsonrpc: "2.0",
          error: { code: -32029, message: "rate limit exceeded" },
          id: null,
        });
      return;
    }
    b.tokens -= 1;
    next();
  };
}

export class ConcurrencyLimitError extends Error {
  constructor(max: number) {
    super(`server busy: ${max} consults already in flight, retry shortly`);
    this.name = "ConcurrencyLimitError";
  }
}

/**
 * Counting semaphore that admits up to `max` concurrent callers. Callers past the
 * cap reject immediately with ConcurrencyLimitError (no queue) so a flood fails
 * fast instead of piling up index builds and exhausting memory.
 */
export class Semaphore {
  private inFlight = 0;
  constructor(private readonly max: number) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.inFlight >= this.max) throw new ConcurrencyLimitError(this.max);
    this.inFlight += 1;
    try {
      return await fn();
    } finally {
      this.inFlight -= 1;
    }
  }
}
