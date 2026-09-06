import { randomBytes } from 'node:crypto';
import type { Application, Request, Response, NextFunction } from 'express';

function shouldForceHttps(publicBaseUrl: string): boolean {
  if (process.env.SIGNAL402_FORCE_HTTPS === 'true') return true;
  if (process.env.SIGNAL402_FORCE_HTTPS === 'false') return false;
  return process.env.NODE_ENV === 'production' || publicBaseUrl.startsWith('https://');
}

function secureRedirectTarget(req: Request, publicBaseUrl: string): string {
  const base = publicBaseUrl.startsWith('https://')
    ? publicBaseUrl
    : publicBaseUrl.replace(/^http:\/\//i, 'https://');
  const requestUrl = new URL(req.originalUrl.startsWith('/') ? req.originalUrl : `/${req.originalUrl}`, 'http://localhost');
  const target = new URL(`${base.replace(/\/$/, '')}/`);
  target.pathname = requestUrl.pathname;
  target.search = requestUrl.search;
  return target.toString();
}

/** Apply conservative browser, transport, and cross-origin defaults. */
export function configureHttpSecurity(app: Application, publicBaseUrl: string): void {
  app.disable('x-powered-by');
  app.set('trust proxy', process.env.SIGNAL402_TRUST_PROXY === 'true');
  app.use((req: Request, res: Response, next: NextFunction) => {
    const nonce = randomBytes(16).toString('base64');
    res.locals.cspNonce = nonce;
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('Content-Security-Policy', [
      "default-src 'self'",
      "base-uri 'none'",
      "object-src 'none'",
      "frame-ancestors 'none'",
      `script-src 'self' https://cdn.tailwindcss.com https://challenges.cloudflare.com 'nonce-${nonce}'`,
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      "connect-src 'self' https://challenges.cloudflare.com",
      "frame-src https://challenges.cloudflare.com",
      "form-action 'self'",
    ].join('; '));
    if (req.secure) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    if (shouldForceHttps(publicBaseUrl) && !req.secure) {
      res.redirect(308, secureRedirectTarget(req, publicBaseUrl));
      return;
    }
    next();
  });
}

export function dashboardCspNonce(res: Response): string {
  return typeof res.locals.cspNonce === 'string' ? res.locals.cspNonce : '';
}
