import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { isUsableSecret } from './securityConfig.js';

const SESSION_COOKIE = 'signal402_session';
const SESSION_TTL_MS = 30 * 60 * 1000;
const LOGIN_WINDOW_MS = 10 * 60 * 1000;
const LOGIN_MAX_FAILURES = 5;
const TURNSTILE_TIMEOUT_MS = 5_000;

export const dashboardLoginSchema = z.object({
  password: z.string().min(1).max(256),
  website: z.string().max(128).optional(),
  turnstileToken: z.string().max(4096).optional(),
}).strict();

type LoginAttempt = {
  windowStartedAt: number;
  failures: number;
  blockedUntil: number;
};

type LoginResult =
  | { ok: true; token: string }
  | { ok: false; status: 401 | 403 | 429 | 503; message: string; retryAfterSeconds?: number };

function hashSession(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function parseCookieHeader(header: string | undefined): Record<string, string> {
  if (!header) return {};
  return Object.fromEntries(header.split(';').flatMap((part) => {
    const separator = part.indexOf('=');
    if (separator < 0) return [];
    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (!key) return [];
    try {
      return [[key, decodeURIComponent(value)] as [string, string]];
    } catch {
      return [];
    }
  }));
}

function verifyPassword(password: string, encoded: string): boolean {
  const parts = encoded.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, nText, rText, pText, saltText, hashText] = parts;
  const n = Number(nText);
  const r = Number(rText);
  const p = Number(pText);
  if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p) || n < 16_384 || r < 1 || p < 1) return false;
  try {
    const expected = Buffer.from(hashText, 'base64url');
    const actual = scryptSync(password, Buffer.from(saltText, 'base64url'), expected.length, {
      N: n,
      r,
      p,
      maxmem: 128 * n * r + 1024 * 1024,
    });
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

/** Generate a password hash for SIGNAL402_DASHBOARD_PASSWORD_HASH. */
export function hashDashboardPassword(password: string): string {
  if (!password || password.length < 12) throw new Error('Dashboard password must be at least 12 characters');
  const n = 32_768;
  const r = 8;
  const p = 1;
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 32, { N: n, r, p, maxmem: 64 * 1024 * 1024 });
  return ['scrypt', n, r, p, salt.toString('base64url'), hash.toString('base64url')].join('$');
}

async function verifyTurnstile(token: string | undefined, remoteIp: string): Promise<boolean> {
  const secret = process.env.SIGNAL402_TURNSTILE_SECRET_KEY;
  if (!secret) return true;
  if (!token) return false;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TURNSTILE_TIMEOUT_MS);
  try {
    const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ secret, response: token, remoteip: remoteIp }),
      signal: controller.signal,
    });
    if (!response.ok) return false;
    const result = await response.json() as { success?: boolean };
    return result.success === true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export class DashboardAuth {
  private readonly sessions = new Map<string, number>();
  private readonly attempts = new Map<string, LoginAttempt>();
  private readonly passwordHash = process.env.SIGNAL402_DASHBOARD_PASSWORD_HASH;
  private readonly sessionSecret = process.env.SIGNAL402_DASHBOARD_SESSION_SECRET;

  public status(): { configured: boolean; turnstileRequired: boolean } {
    return {
      configured: Boolean(this.passwordHash?.startsWith('scrypt$') && isUsableSecret(this.sessionSecret)),
      turnstileRequired: Boolean(process.env.SIGNAL402_TURNSTILE_SECRET_KEY),
    };
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [session, expiresAt] of this.sessions) if (expiresAt <= now) this.sessions.delete(session);
    for (const [ip, attempt] of this.attempts) if (attempt.windowStartedAt + LOGIN_WINDOW_MS <= now && attempt.blockedUntil <= now) this.attempts.delete(ip);
  }

  private rateLimit(ip: string): { allowed: boolean; retryAfterSeconds?: number } {
    this.cleanup();
    const now = Date.now();
    const attempt = this.attempts.get(ip);
    if (attempt && attempt.blockedUntil > now) {
      return { allowed: false, retryAfterSeconds: Math.ceil((attempt.blockedUntil - now) / 1000) };
    }
    if (!attempt || attempt.windowStartedAt + LOGIN_WINDOW_MS <= now) {
      this.attempts.set(ip, { windowStartedAt: now, failures: 0, blockedUntil: 0 });
    }
    return { allowed: true };
  }

  private failure(ip: string): void {
    const now = Date.now();
    const attempt = this.attempts.get(ip) ?? { windowStartedAt: now, failures: 0, blockedUntil: 0 };
    if (attempt.windowStartedAt + LOGIN_WINDOW_MS <= now) {
      attempt.windowStartedAt = now;
      attempt.failures = 0;
    }
    attempt.failures += 1;
    if (attempt.failures >= LOGIN_MAX_FAILURES) attempt.blockedUntil = now + LOGIN_WINDOW_MS;
    this.attempts.set(ip, attempt);
  }

  public async login(ip: string, password: string, website: string | undefined, turnstileToken: string | undefined): Promise<LoginResult> {
    const limited = this.rateLimit(ip);
    if (!limited.allowed) return { ok: false, status: 429, message: 'Too many login attempts. Try again later.', retryAfterSeconds: limited.retryAfterSeconds };
    if (website?.trim()) {
      this.failure(ip);
      return { ok: false, status: 403, message: 'Login rejected' };
    }
    if (!this.passwordHash?.startsWith('scrypt$') || !isUsableSecret(this.sessionSecret)) return { ok: false, status: 503, message: 'Dashboard authentication is not configured' };
    if (!(await verifyTurnstile(turnstileToken, ip))) {
      this.failure(ip);
      return { ok: false, status: 403, message: 'Bot verification failed' };
    }
    if (!verifyPassword(password, this.passwordHash)) {
      this.failure(ip);
      return { ok: false, status: 401, message: 'Invalid credentials' };
    }
    const token = randomBytes(32).toString('base64url');
    this.sessions.set(hashSession(`${this.sessionSecret}:${token}`), Date.now() + SESSION_TTL_MS);
    return { ok: true, token };
  }

  public isAuthenticated(req: Request): boolean {
    this.cleanup();
    if (!isUsableSecret(this.sessionSecret)) return false;
    const token = parseCookieHeader(req.headers.cookie)[SESSION_COOKIE];
    if (!token) return false;
    const key = hashSession(`${this.sessionSecret}:${token}`);
    return this.sessions.has(key);
  }

  public require(req: Request, res: Response): boolean {
    if (this.isAuthenticated(req)) return true;
    res.status(401).json({ success: false, error: 'Dashboard login required' });
    return false;
  }

  public requireConfigured(res: Response): boolean {
    if (this.status().configured) return true;
    res.status(503).json({ success: false, error: 'Dashboard authentication is not configured' });
    return false;
  }

  public setCookie(res: Response, token: string): void {
    const secure = process.env.SIGNAL402_COOKIE_SECURE === 'true' || process.env.NODE_ENV === 'production';
    const parts = [
      `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
      'Path=/',
      `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
      'HttpOnly',
      'SameSite=Strict',
    ];
    if (secure) parts.push('Secure');
    res.setHeader('Set-Cookie', parts.join('; '));
  }

  public clearCookie(res: Response): void {
    const secure = process.env.SIGNAL402_COOKIE_SECURE === 'true' || process.env.NODE_ENV === 'production';
    const parts = [`${SESSION_COOKIE}=`, 'Path=/', 'Max-Age=0', 'HttpOnly', 'SameSite=Strict'];
    if (secure) parts.push('Secure');
    res.setHeader('Set-Cookie', parts.join('; '));
  }
}
