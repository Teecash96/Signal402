export type FuturesTradeState = 'idle' | 'pending' | 'approved' | 'submitted' | 'partially_filled' | 'filled' | 'rejected' | 'cancelled' | 'liquidated';

const transitions: Record<FuturesTradeState, FuturesTradeState[]> = {
  idle: ['pending'],
  pending: ['approved', 'rejected', 'cancelled'],
  approved: ['submitted', 'partially_filled', 'filled', 'rejected', 'cancelled'],
  submitted: ['submitted', 'partially_filled', 'filled', 'rejected', 'cancelled', 'liquidated'],
  partially_filled: ['partially_filled', 'filled', 'rejected', 'cancelled', 'liquidated'],
  filled: ['filled', 'liquidated'],
  rejected: ['rejected'],
  cancelled: ['cancelled'],
  liquidated: ['liquidated'],
};

export function canAdvanceFuturesTradeState(current: FuturesTradeState, next: FuturesTradeState): boolean {
  return transitions[current]?.includes(next) ?? false;
}

export function advanceFuturesTradeState(current: FuturesTradeState, next: FuturesTradeState): FuturesTradeState {
  if (!canAdvanceFuturesTradeState(current, next)) {
    throw new Error(`Invalid Futures order event transition: ${current} -> ${next}`);
  }
  return next;
}

export interface FuturesFillChangeCheck {
  reduceOnly: boolean;
  beforeQuantity: number;
  afterQuantity: number;
  beforeNotional: number;
  afterNotional: number;
  accountChanged: boolean;
}

/** Require an authenticated fill to change both account margin and position state. */
export function validateFuturesFillChange(input: FuturesFillChangeCheck): { valid: boolean; reason?: string } {
  if (!input.accountChanged) return { valid: false, reason: 'Account margin snapshot did not change' };
  const positionChanged = input.reduceOnly
    ? input.afterQuantity < input.beforeQuantity
    : input.afterQuantity > input.beforeQuantity;
  return positionChanged
    ? { valid: true }
    : { valid: false, reason: input.reduceOnly ? 'Reduce only fill did not reduce the position' : 'Opening fill did not increase the position' };
}
