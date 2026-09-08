import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export const RISK_STATE_SCHEMA_VERSION = 'signal402-risk-state-v1';

export type DrawdownState = 'NORMAL' | 'WARN' | 'HALTED';

export type RiskState = {
  schemaVersion: typeof RISK_STATE_SCHEMA_VERSION;
  killSwitch: boolean;
  killSwitchReason?: string;
  drawdownState: DrawdownState;
  currentEquityUSDT?: number;
  peakEquityUSDT?: number;
  updatedAt: string;
};

const initialState = (): RiskState => ({
  schemaVersion: RISK_STATE_SCHEMA_VERSION,
  killSwitch: false,
  drawdownState: 'NORMAL',
  updatedAt: new Date().toISOString(),
});

function validNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function sanitize(value: unknown): RiskState {
  if (!value || typeof value !== 'object') return initialState();
  const record = value as Record<string, unknown>;
  const drawdownState = record.drawdownState === 'WARN' || record.drawdownState === 'HALTED' ? record.drawdownState : 'NORMAL';
  const updatedAt = typeof record.updatedAt === 'string' && Number.isFinite(Date.parse(record.updatedAt))
    ? new Date(record.updatedAt).toISOString()
    : new Date().toISOString();
  return {
    schemaVersion: RISK_STATE_SCHEMA_VERSION,
    killSwitch: record.killSwitch === true,
    killSwitchReason: typeof record.killSwitchReason === 'string' ? record.killSwitchReason.slice(0, 500) : undefined,
    drawdownState,
    currentEquityUSDT: validNumber(record.currentEquityUSDT) ? record.currentEquityUSDT : undefined,
    peakEquityUSDT: validNumber(record.peakEquityUSDT) ? record.peakEquityUSDT : undefined,
    updatedAt,
  };
}

export class RiskStateStore {
  private state: RiskState = initialState();

  public constructor(private readonly filePath = process.env.SIGNAL402_RISK_STATE_FILE ?? resolve(process.cwd(), 'state', 'signal402-risk.json')) {}

  public load(): RiskState {
    try {
      this.state = sanitize(JSON.parse(readFileSync(this.filePath, 'utf8')));
    } catch (error: unknown) {
      const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
      if (code !== 'ENOENT') throw error;
      this.state = initialState();
    }
    return this.snapshot();
  }

  public snapshot(): RiskState {
    return { ...this.state };
  }

  public isNewRiskBlocked(): boolean {
    return this.state.killSwitch || this.state.drawdownState === 'HALTED';
  }

  public setKillSwitch(reason: string): RiskState {
    this.state = { ...this.state, killSwitch: true, killSwitchReason: reason.trim().slice(0, 500) || 'Operator kill switch enabled', updatedAt: new Date().toISOString() };
    this.persist();
    return this.snapshot();
  }

  public clearKillSwitch(): RiskState {
    this.state = { ...this.state, killSwitch: false, killSwitchReason: undefined, updatedAt: new Date().toISOString() };
    this.persist();
    return this.snapshot();
  }

  public updateEquity(equityUSDT: number, warnDrawdownPct = 2, haltDrawdownPct = 3): RiskState {
    if (!validNumber(equityUSDT)) throw new Error('Equity must be a finite non-negative number');
    const peak = Math.max(this.state.peakEquityUSDT ?? equityUSDT, equityUSDT);
    const drawdownPct = peak > 0 ? ((peak - equityUSDT) / peak) * 100 : 0;
    const calculatedState: DrawdownState = drawdownPct >= haltDrawdownPct ? 'HALTED' : drawdownPct >= warnDrawdownPct ? 'WARN' : 'NORMAL';
    // A halt is sticky. Recovery must be explicit through resetHalt so a
    // transient account read cannot silently re-enable new exposure.
    const drawdownState: DrawdownState = this.state.drawdownState === 'HALTED' ? 'HALTED' : calculatedState;
    this.state = { ...this.state, currentEquityUSDT: equityUSDT, peakEquityUSDT: peak, drawdownState, updatedAt: new Date().toISOString() };
    this.persist();
    return this.snapshot();
  }

  public resetHalt(): RiskState {
    if (this.state.currentEquityUSDT === undefined || this.state.peakEquityUSDT === undefined) {
      throw new Error('Risk halt cannot be reset without a current and peak equity read');
    }
    const drawdownPct = this.state.peakEquityUSDT > 0
      ? ((this.state.peakEquityUSDT - this.state.currentEquityUSDT) / this.state.peakEquityUSDT) * 100
      : 0;
    if (drawdownPct >= 3) throw new Error('Risk halt cannot be reset while equity remains below the halt threshold');
    this.state = { ...this.state, drawdownState: 'NORMAL', updatedAt: new Date().toISOString() };
    this.persist();
    return this.snapshot();
  }

  private persist(): void {
    mkdirSync(dirname(this.filePath), { recursive: true, mode: 0o700 });
    const temporary = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(this.state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    chmodSync(temporary, 0o600);
    renameSync(temporary, this.filePath);
    chmodSync(this.filePath, 0o600);
  }
}
