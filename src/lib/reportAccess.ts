export type ReportAccessMode = 'b402' | 'free';
export type ReportAccessStatus = 'waiting' | 'settled' | 'free' | 'error';

export function reportAccessMode(env: NodeJS.ProcessEnv = process.env): ReportAccessMode {
  return env.SIGNAL402_FREE_ACCESS?.trim().toLowerCase() === 'true' ? 'free' : 'b402';
}

/**
 * A proposal may use a report only after the current report access was granted.
 * Free mode deliberately accepts no receipt value, so a stale or invented hash
 * cannot be used to bypass the paid mode checks.
 */
export function hasCurrentReportAccess(input: {
  mode: ReportAccessMode;
  status: ReportAccessStatus;
  currentReceipt?: string;
  providedReceipt?: string;
}): boolean {
  if (input.mode === 'free') return input.status === 'free' && input.providedReceipt === undefined;
  return input.status === 'settled'
    && typeof input.currentReceipt === 'string'
    && input.currentReceipt.length > 0
    && input.providedReceipt === input.currentReceipt;
}
