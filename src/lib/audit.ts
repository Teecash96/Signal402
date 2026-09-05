import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const auditFile = process.env.SIGNAL402_AUDIT_LOG ?? path.resolve(process.cwd(), 'logs', 'signal402.jsonl');

/** Write a redacted, append only audit event. Secrets are never accepted here. */
export async function audit(event: string, details: Record<string, unknown> = {}): Promise<void> {
  const record = {
    timestamp: new Date().toISOString(),
    event,
    details,
  };

  await mkdir(path.dirname(auditFile), { recursive: true });
  await appendFile(auditFile, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600 });
}

export function auditPath(): string {
  return auditFile;
}
