export type ReportAccessMode = 'b402' | 'free';
export type ReportAccessStatus = 'waiting' | 'settled' | 'free' | 'error';

export function reportAccessMode(env: NodeJS.ProcessEnv = process.env): ReportAccessMode {
  const configuredMode = env.SIGNAL402_ACCESS_MODE?.trim().toLowerCase();
  if (configuredMode === 'free') return 'free';
  if (configuredMode === 'b402' || configuredMode === 'paid') return 'b402';
  if (configuredMode) throw new Error('SIGNAL402_ACCESS_MODE must be "free" or "b402"');

  // Keep the old flag working for existing deployments. A missing setting is
  // intentionally free so MCP, CLI, and HTTP agents can use Signal402 without
  // merchant onboarding. Paid B402 access is an explicit opt in.
  const legacyFree = env.SIGNAL402_FREE_ACCESS?.trim().toLowerCase();
  if (legacyFree === 'true') return 'free';
  if (legacyFree === 'false') return 'b402';
  return 'free';
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
