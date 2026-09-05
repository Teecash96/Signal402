import { extractUsdtBalance, type BinanceBalance, type BinanceMcpClient } from '../lib/binanceMcp.js';

export interface RiskAssessment {
  approved: boolean;
  balanceUSDT: number;
  proposedSizeUSDT: number;
  reason: string;
}

export interface LiveRiskCheck {
  assessment: RiskAssessment;
  balances: BinanceBalance[];
}

/** Check the live USDT balance before a trade proposal is sent. */
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

/** Read Binance through MCP and apply the refusal rule to the returned USDT balance. */
export async function assessLiveTradeRisk(
  client: BinanceMcpClient,
  proposedSizeUSDT: number,
): Promise<LiveRiskCheck> {
  const balances = await client.getBalances();
  const balanceUSDT = extractUsdtBalance(balances);
  return { assessment: assessTradeRisk(balanceUSDT, proposedSizeUSDT), balances };
}
