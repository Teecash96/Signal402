import assert from 'node:assert/strict';
import test from 'node:test';
import { advanceFuturesTradeState, validateFuturesFillChange } from '../src/lib/futuresMonitor.js';
import { evaluateFuturesRisk, type FuturesContextInput, type FuturesOrderIntentInput } from '../src/lib/futuresRisk.js';
import { futuresContextSchema, futuresRiskEnvelopeSchema, futuresStatusInputSchema } from '../src/lib/schemas.js';

function validContext(overrides: Partial<FuturesContextInput> = {}): FuturesContextInput {
  return {
    marketType: 'USD_M',
    strategyMode: 'directional',
    symbol: 'BTCUSDT',
    markPrice: 100,
    indexPrice: 100,
    bidPrice: 99.9,
    askPrice: 100.1,
    orderBookDepthUSDT: 100_000,
    estimatedSlippageBps: 20,
    fundingRateBps: 2,
    nextFundingTime: Date.now() + 3_600_000,
    walletBalanceUSDT: 100,
    availableBalanceUSDT: 100,
    marginBalanceUSDT: 100,
    initialMarginUSDT: 0,
    maintenanceMarginUSDT: 0,
    openOrderInitialMarginUSDT: 0,
    leverage: 1,
    marginMode: 'ISOLATED',
    positionSide: 'BOTH',
    projectedLiquidationDistancePct: 30,
    exchangeFiltersVerified: true,
    leverageBracketVerified: true,
    orderBookVerified: true,
    positions: [],
    observedAt: new Date().toISOString(),
    sourceToolNames: ['futures_market_data', 'futures_order'],
    ...overrides,
  };
}

function validIntent(overrides: Partial<FuturesOrderIntentInput> = {}): FuturesOrderIntentInput {
  return {
    symbol: 'BTCUSDT',
    side: 'BUY',
    positionSide: 'BOTH',
    quantity: 0.05,
    notionalUSDT: 5,
    reduceOnly: false,
    action: 'OPEN',
    protectiveStopPrice: 95,
    protectiveStopSupported: true,
    ...overrides,
  };
}

test('USD M directional orders pass at 1x, 2x, and 3x', () => {
  for (const leverage of [1, 2, 3]) {
    const result = evaluateFuturesRisk(validContext({ leverage }), validIntent());
    assert.equal(result.action, 'OPEN');
    assert.equal(result.executionEligible, true);
    assert.equal(result.leverage, leverage);
  }
});

test('risk gate refuses leverage above 3x and cross margin', () => {
  const highLeverage = evaluateFuturesRisk(validContext({ leverage: 4 }), validIntent());
  assert.equal(highLeverage.action, 'WAIT');
  assert.equal(highLeverage.executionEligible, false);
  assert.match(highLeverage.reasons.join(' '), /3x/);
  const cross = evaluateFuturesRisk(validContext({ marginMode: 'CROSSED' }), validIntent());
  assert.equal(cross.action, 'WAIT');
  assert.match(cross.reasonCodes.join(' '), /CROSS_MARGIN/);
});

test('risk gate refuses a combined notional above 10 USDT', () => {
  const result = evaluateFuturesRisk(validContext({ openOrdersNotionalUSDT: 6 }), validIntent({ notionalUSDT: 5 }));
  assert.equal(result.action, 'WAIT');
  assert.match(result.reasonCodes.join(' '), /NOTIONAL_LIMIT/);
  const fromOpenOrders = evaluateFuturesRisk(validContext({ openOrders: [{ symbol: 'BTCUSDT', notionalUSDT: 6 }] }), validIntent({ notionalUSDT: 5 }));
  assert.equal(fromOpenOrders.action, 'WAIT');
  assert.match(fromOpenOrders.reasonCodes.join(' '), /NOTIONAL_LIMIT/);
});

test('neutral analysis reports but never executes and applies the combined cap', () => {
  const okay = evaluateFuturesRisk(validContext({ strategyMode: 'neutral' }), validIntent());
  assert.equal(okay.reportOnly, true);
  assert.equal(okay.executionEligible, false);
  assert.equal(okay.action, 'OPEN');
  const overCap = evaluateFuturesRisk(validContext({ strategyMode: 'neutral', openOrdersNotionalUSDT: 6 }), validIntent({ notionalUSDT: 5 }));
  assert.equal(overCap.action, 'WAIT');
  assert.match(overCap.reasonCodes.join(' '), /NOTIONAL_LIMIT/);
});

test('insufficient margin, funding, liquidation, filters, and book fail closed', () => {
  const insufficient = evaluateFuturesRisk(validContext({ availableBalanceUSDT: 0.001 }), validIntent());
  assert.match(insufficient.reasonCodes.join(' '), /INSUFFICIENT_MARGIN/);
  assert.equal(insufficient.executionEligible, false);
  const missing = evaluateFuturesRisk(validContext({ fundingRateBps: undefined, nextFundingTime: undefined, projectedLiquidationDistancePct: undefined, liquidationPrice: undefined, orderBookVerified: false, exchangeFiltersVerified: false, leverageBracketVerified: undefined }), validIntent());
  assert.match(missing.reasonCodes.join(' '), /FUNDING_MISSING/);
  assert.match(missing.reasonCodes.join(' '), /LIQUIDATION_MISSING/);
  assert.match(missing.reasonCodes.join(' '), /ORDER_BOOK_MISSING/);
  assert.match(missing.reasonCodes.join(' '), /FILTERS_UNVERIFIED/);
  assert.match(missing.reasonCodes.join(' '), /LEVERAGE_BRACKET_UNVERIFIED/);
});

test('spread, slippage, funding stress, and stale data fail closed', () => {
  assert.match(evaluateFuturesRisk(validContext({ bidPrice: 99, askPrice: 101 }), validIntent()).reasonCodes.join(' '), /SPREAD_LIMIT/);
  assert.match(evaluateFuturesRisk(validContext({ estimatedSlippageBps: 51 }), validIntent()).reasonCodes.join(' '), /SLIPPAGE_LIMIT/);
  assert.match(evaluateFuturesRisk(validContext({ fundingRateBps: 6 }), validIntent()).reasonCodes.join(' '), /FUNDING_STRESS/);
  assert.match(evaluateFuturesRisk(validContext({ observedAt: new Date(Date.now() - 16_000).toISOString() }), validIntent()).reasonCodes.join(' '), /STALE_DATA/);
});

test('COIN M is report only', () => {
  const result = evaluateFuturesRisk(validContext({ marketType: 'COIN_M' }), validIntent());
  assert.equal(result.reportOnly, true);
  assert.equal(result.executionEligible, false);
  assert.equal(result.action, 'OPEN');
  assert.match(result.reasonCodes.join(' '), /COIN_M_REPORT_ONLY/);
});

test('opening requires a protective stop plan', () => {
  const result = evaluateFuturesRisk(validContext(), validIntent({ protectiveStopPrice: undefined, protectiveStopSupported: false }));
  assert.equal(result.executionEligible, false);
  assert.match(result.reasonCodes.join(' '), /PROTECTIVE_STOP_REQUIRED/);
  const reduce = evaluateFuturesRisk(validContext({ positions: [{ symbol: 'BTCUSDT', positionSide: 'BOTH', positionAmt: 0.1, entryPrice: 100, markPrice: 100 }] }), validIntent({ side: 'SELL', quantity: 0.01, notionalUSDT: 1, reduceOnly: true, action: 'REDUCE', protectiveStopPrice: undefined, protectiveStopSupported: false }));
  assert.equal(reduce.action, 'REDUCE');
});

test('reduce only validates the live position and explicit position side', () => {
  const noPosition = evaluateFuturesRisk(validContext(), validIntent({ side: 'SELL', reduceOnly: true, action: 'REDUCE' }));
  assert.match(noPosition.reasonCodes.join(' '), /REDUCE_ONLY_POSITION/);
  const validReduce = evaluateFuturesRisk(validContext({ positions: [{ symbol: 'BTCUSDT', positionSide: 'BOTH', positionAmt: 0.1, entryPrice: 100, markPrice: 100, notionalUSDT: 10 }] }), validIntent({ side: 'SELL', quantity: 0.01, notionalUSDT: 1, reduceOnly: true, action: 'REDUCE' }));
  assert.equal(validReduce.action, 'REDUCE');
  const invalidSide = evaluateFuturesRisk(validContext(), validIntent({ positionSide: 'INVALID' as FuturesOrderIntentInput['positionSide'] }));
  assert.match(invalidSide.reasonCodes.join(' '), /INVALID_POSITION_SIDE/);
});

test('hash proof is reproducible for identical inputs', () => {
  const context = validContext();
  const intent = validIntent();
  const first = evaluateFuturesRisk(context, intent);
  const second = evaluateFuturesRisk(context, intent);
  assert.equal(first.inputHash, second.inputHash);
  assert.equal(first.outputHash, second.outputHash);
  assert.equal(futuresRiskEnvelopeSchema.safeParse(first).success, true);
});

test('strict Futures schemas reject unknown fields', () => {
  const parsed = futuresContextSchema.safeParse({ ...validContext(), unexpected: true });
  assert.equal(parsed.success, false);
  const event = futuresStatusInputSchema.safeParse({
    proposalId: 'proposal_1',
    eventType: 'ORDER_TRADE_UPDATE',
    status: 'submitted',
    orderId: '123',
    source: 'binance-mcp-host',
    mcpToolName: 'futures_order',
    observedAt: new Date().toISOString(),
    unexpected: true,
  });
  assert.equal(event.success, false);
});

test('Futures order event transitions accept valid flow and reject invalid flow', () => {
  assert.equal(advanceFuturesTradeState('approved', 'submitted'), 'submitted');
  assert.equal(advanceFuturesTradeState('approved', 'filled'), 'filled');
  assert.equal(advanceFuturesTradeState('submitted', 'partially_filled'), 'partially_filled');
  assert.equal(advanceFuturesTradeState('partially_filled', 'filled'), 'filled');
  assert.throws(() => advanceFuturesTradeState('pending', 'filled'), /Invalid Futures order event transition/);
});

test('fill proof rejects unchanged snapshots and accepts the expected change', () => {
  assert.equal(validateFuturesFillChange({ reduceOnly: false, beforeQuantity: 0, afterQuantity: 0, beforeNotional: 0, afterNotional: 0, accountChanged: true }).valid, false);
  assert.equal(validateFuturesFillChange({ reduceOnly: false, beforeQuantity: 0.05, afterQuantity: 0.05, beforeNotional: 5, afterNotional: 6, accountChanged: true }).valid, false);
  assert.equal(validateFuturesFillChange({ reduceOnly: false, beforeQuantity: 0, afterQuantity: 0.05, beforeNotional: 0, afterNotional: 5, accountChanged: true }).valid, true);
  assert.equal(validateFuturesFillChange({ reduceOnly: true, beforeQuantity: 0.05, afterQuantity: 0.05, beforeNotional: 5, afterNotional: 5, accountChanged: true }).valid, false);
  assert.equal(validateFuturesFillChange({ reduceOnly: true, beforeQuantity: 0.05, afterQuantity: 0, beforeNotional: 5, afterNotional: 0, accountChanged: true }).valid, true);
});
