import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export const EXECUTION_STATE_SCHEMA_VERSION = 'signal402-execution-state-v1';

type StoredExecutionState<T> = {
  schemaVersion: typeof EXECUTION_STATE_SCHEMA_VERSION;
  state: T;
};

/** Persist execution-critical Seller state with an atomic local file replacement. */
export class ExecutionStateStore {
  public constructor(private readonly filePath = process.env.SIGNAL402_EXECUTION_STATE_FILE
    ?? resolve(process.cwd(), 'state', 'signal402-execution.json')) {}

  public load<T>(): T | undefined {
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, 'utf8')) as Partial<StoredExecutionState<T>>;
      if (parsed.schemaVersion !== EXECUTION_STATE_SCHEMA_VERSION || !parsed.state || typeof parsed.state !== 'object') {
        throw new Error('Unsupported or invalid Signal402 execution state');
      }
      return parsed.state;
    } catch (error: unknown) {
      const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
      if (code === 'ENOENT') return undefined;
      throw error;
    }
  }

  public persist<T>(state: T): void {
    mkdirSync(dirname(this.filePath), { recursive: true, mode: 0o700 });
    const temporary = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    const stored: StoredExecutionState<T> = { schemaVersion: EXECUTION_STATE_SCHEMA_VERSION, state };
    writeFileSync(temporary, `${JSON.stringify(stored, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    chmodSync(temporary, 0o600);
    renameSync(temporary, this.filePath);
    chmodSync(this.filePath, 0o600);
  }
}
