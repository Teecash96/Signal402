import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const auditFile = process.env.SIGNAL402_AUDIT_LOG ?? path.resolve(process.cwd(), 'logs', 'signal402.jsonl');

function redact(value: unknown, key?: string): unknown {
  if (key && /(token|secret|private|password|authorization|signature|accesskey|apikey)/i.test(key)) return '[REDACTED]';
  if (Array.isArray(value)) return value.map((item) => redact(item));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([childKey, childValue]) => [childKey, redact(childValue, childKey)]));
}

/** Write a redacted, append only audit event. */
export async function audit(event: string, details: Record<string, unknown> = {}): Promise<void> {
  const record = {
    timestamp: new Date().toISOString(),
    event,
    details: redact(details),
  };

  await mkdir(path.dirname(auditFile), { recursive: true });
  await appendFile(auditFile, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600 });
}

export function auditPath(): string {
  return auditFile;
}
