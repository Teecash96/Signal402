export interface RiskAssessment {
  approved: boolean;
  balanceUSDT: number;
  proposedSizeUSDT: number;
  reason: string;
}

/**
 * Check the simulated USDT balance before a trade proposal is sent.
 *
 * The demo deliberately uses DEMO_BALANCE_USDT so the safety path can be
 * reproduced without connecting an exchange account or risking real funds.
 */
export function assessTradeRisk(
  balanceUSDT: number,
  proposedSizeUSDT: number,
): RiskAssessment {
  if (!Number.isFinite(balanceUSDT) || balanceUSDT < 0) {
    return {
      approved: false,
      balanceUSDT,
      proposedSizeUSDT,
      reason: 'USDT balance is invalid',
    };
  }

  if (!Number.isFinite(proposedSizeUSDT) || proposedSizeUSDT <= 0) {
    return {
      approved: false,
      balanceUSDT,
      proposedSizeUSDT,
      reason: 'Proposed trade size is invalid',
    };
  }

  if (balanceUSDT < proposedSizeUSDT) {
    return {
      approved: false,
      balanceUSDT,
      proposedSizeUSDT,
      reason: `USDT balance ${balanceUSDT.toFixed(2)} is below the proposed trade size ${proposedSizeUSDT.toFixed(2)}`,
    };
  }

  return {
    approved: true,
    balanceUSDT,
    proposedSizeUSDT,
    reason: `USDT balance ${balanceUSDT.toFixed(2)} covers the proposed trade size ${proposedSizeUSDT.toFixed(2)}`,
  };
}

export function readDemoBalanceUSDT(): number {
  const configuredBalance = Number.parseFloat(process.env.DEMO_BALANCE_USDT ?? '10');
  return Number.isFinite(configuredBalance) ? configuredBalance : 0;
}
