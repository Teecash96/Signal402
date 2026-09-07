export type SignalDirection = 'BULLISH' | 'NEUTRAL' | 'BEARISH';
export type SignalAction = 'BUY_SMALL' | 'WAIT';
export type SignalRisk = 'LOW' | 'MEDIUM' | 'HIGH';
export type SignalConfidence = 'LOW' | 'MEDIUM' | 'HIGH';

export type MarketSnapshot = {
  price: number;
  changePercent?: number;
  highPrice?: number;
  lowPrice?: number;
  weightedAvgPrice?: number;
  quoteVolume?: number;
};

export type MarketSignal = {
  direction: SignalDirection;
  action: SignalAction;
  risk: SignalRisk;
  confidence: SignalConfidence;
  rangePercent?: number;
  vwapDistancePercent?: number;
  rationale: string;
  invalidation: string;
};

function finite(value: number | undefined): value is number {
  return value !== undefined && Number.isFinite(value);
}

function formatPercent(value: number | undefined): string {
  return value === undefined ? 'unavailable' : `${value >= 0 ? '+' : ''}${value.toFixed(2)}%`;
}

/**
 * Build a deterministic, explainable screening result from a live Binance
 * 24 hour ticker. This is market intelligence, not a promise of profit.
 */
export function deriveMarketSignal(snapshot: MarketSnapshot): MarketSignal {
  if (!Number.isFinite(snapshot.price) || snapshot.price <= 0) {
    throw new Error('Cannot derive a market signal without a positive price');
  }

  const change = finite(snapshot.changePercent) ? snapshot.changePercent : undefined;
  const rangePercent = finite(snapshot.highPrice) && finite(snapshot.lowPrice) && snapshot.lowPrice > 0 && snapshot.highPrice >= snapshot.lowPrice
    ? ((snapshot.highPrice - snapshot.lowPrice) / snapshot.lowPrice) * 100
    : undefined;
  const vwapDistancePercent = finite(snapshot.weightedAvgPrice) && snapshot.weightedAvgPrice > 0
    ? ((snapshot.price - snapshot.weightedAvgPrice) / snapshot.weightedAvgPrice) * 100
    : undefined;

  const direction: SignalDirection = change === undefined
    ? 'NEUTRAL'
    : change >= 1
      ? 'BULLISH'
      : change <= -1
        ? 'BEARISH'
        : 'NEUTRAL';

  const risk: SignalRisk = Math.abs(change ?? 0) >= 8 || (rangePercent !== undefined && rangePercent >= 12)
    ? 'HIGH'
    : Math.abs(change ?? 0) >= 4 || (rangePercent !== undefined && rangePercent >= 8)
      ? 'MEDIUM'
      : 'LOW';

  const action: SignalAction = direction === 'BULLISH' && risk !== 'HIGH' ? 'BUY_SMALL' : 'WAIT';
  const confidence: SignalConfidence = change === undefined || rangePercent === undefined
    ? 'LOW'
    : action === 'BUY_SMALL' && change >= 2 && finite(snapshot.quoteVolume) && snapshot.quoteVolume > 0
      ? 'HIGH'
      : 'MEDIUM';

  const rationale = direction === 'BULLISH'
    ? `24h momentum is ${formatPercent(change)}. The rule allows a small buy only while the move remains below the high volatility band.`
    : direction === 'BEARISH'
      ? `24h momentum is ${formatPercent(change)}. The rule blocks a buy while momentum is negative.`
      : `24h momentum is ${formatPercent(change)}. The move is too weak to justify a buy under the screening rule.`;

  return {
    direction,
    action,
    risk,
    confidence,
    rangePercent,
    vwapDistancePercent,
    rationale,
    invalidation: 'Recheck the live MCP market and balance immediately before any order. A WAIT result or failed Risk Guardian check blocks the order.',
  };
}
