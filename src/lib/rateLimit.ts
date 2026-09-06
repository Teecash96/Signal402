import type { Request, RequestHandler, Response, NextFunction } from 'express';

type Bucket = { startedAt: number; count: number };

export function createRateLimiter(options: { windowMs: number; max: number; message: string }): RequestHandler {
  const buckets = new Map<string, Bucket>();
  return (req: Request, res: Response, next: NextFunction): void => {
    const now = Date.now();
    const key = req.ip ?? 'unknown';
    const existing = buckets.get(key);
    const bucket = !existing || existing.startedAt + options.windowMs <= now
      ? { startedAt: now, count: 0 }
      : existing;
    bucket.count += 1;
    buckets.set(key, bucket);
    if (buckets.size > 10_000) {
      for (const [candidate, value] of buckets) if (value.startedAt + options.windowMs <= now) buckets.delete(candidate);
    }
    if (bucket.count > options.max) {
      const retryAfter = Math.max(1, Math.ceil((bucket.startedAt + options.windowMs - now) / 1000));
      res.setHeader('Retry-After', String(retryAfter));
      res.status(429).json({ success: false, error: options.message });
      return;
    }
    next();
  };
}
