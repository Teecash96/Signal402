import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { encryptText } from './cryptoStore.js';
import { isUsableSecret } from './securityConfig.js';

const auditFile = process.env.SIGNAL402_AUDIT_LOG ?? path.resolve(process.cwd(), 'logs', 'signal402.jsonl');

function redact(value: unknown, key?: string): unknown {
  if (key && /(token|secret|private|password|authorization|signature|accesskey|apikey)/i.test(key)) return '[REDACTED]';
  if (Array.isArray(value)) return value.map((item) => redact(item));
  if (typeof value === 'string') {
    return value
      .replace(/(Bearer\s+)[A-Za-z0-9._~+\/-]+/gi, '$1[REDACTED]')
      .replace(/(X-Tesla-[A-Za-z-]+\s*[:=]\s*)\S+/gi, '$1[REDACTED]')
      .replace(/-----BEGIN [^-]+ PRIVATE KEY-----[\s\S]+?-----END [^-]+ PRIVATE KEY-----/g, '[REDACTED PRIVATE KEY]');
  }
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([childKey, childValue]) => [childKey, redact(childValue, childKey)]));
}

/** Write a redacted, append only audit event. */
export async function audit(event: string, details: Record<string, unknown> = {}): Promise<void> {
  const encryptionKey = process.env.SIGNAL402_AUDIT_ENCRYPTION_KEY;
  if ((process.env.SIGNAL402_REQUIRE_AUDIT_ENCRYPTION === 'true' || process.env.NODE_ENV === 'production') && !isUsableSecret(encryptionKey, 16)) {
    throw new Error('SIGNAL402_AUDIT_ENCRYPTION_KEY is required when audit encryption is enforced');
  }
  const safeDetails = redact(details);
  const record = {
    timestamp: new Date().toISOString(),
    event,
    ...(isUsableSecret(encryptionKey, 16)
      ? { detailsEncrypted: encryptText(JSON.stringify(safeDetails), encryptionKey) }
      : { details: safeDetails }),
  };

  await mkdir(path.dirname(auditFile), { recursive: true });
  await appendFile(auditFile, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600 });
}

export function auditPath(): string {
  return auditFile;
}
