import { createHash } from 'node:crypto';

/**
 * Deterministic Futures risk gate. This module is deliberately pure. It does
 * not call Binance, make orders, or infer missing account data.
 */
export const FUTURES_RISK_SCHEMA_VERSION = 'signal402-futures-risk-v1';
export const FUTURES_METHODOLOGY_VERSION = 'deltazero-adapted-futures-v1';

export type FuturesMarketType = 'USD_M' | 'COIN_M';
export type FuturesStrategyMode = 'directional' | 'neutral';
export type FuturesMarginMode = 'ISOLATED' | 'CROSSED';
export type FuturesPositionSide = 'BOTH' | 'LONG' | 'SHORT';
export type FuturesOrderSide = 'BUY' | 'SELL';
export type FuturesDecision = 'OPEN' | 'WAIT' | 'REDUCE' | 'CLOSE';
export type FuturesRiskZone = 'OPTIMAL' | 'WATCH' | 'DEFENSIVE' | 'CRITICAL';

export interface FuturesPositionInput {
  symbol: string;
  positionSide: FuturesPositionSide;
  positionAmt: number;
  entryPrice: number;
  markPrice: number;
  liquidationPrice?: number;
  leverage?: number;
  marginMode?: FuturesMarginMode;
  initialMarginUSDT?: number;
  maintenanceMarginUSDT?: number;
  unrealizedPnlUSDT?: number;
  notionalUSDT?: number;
}

export interface FuturesOpenOrderInput {
  symbol: string;
  side?: FuturesOrderSide;
  positionSide?: FuturesPositionSide;
  quantity?: number;
  notionalUSDT?: number;
  reduceOnly?: boolean;
  status?: string;
}

export interface FuturesContextInput {
  marketType: FuturesMarketType;
  strategyMode: FuturesStrategyMode;
  symbol: string;
  markPrice: number;
  indexPrice?: number;
  bidPrice?: number;
  askPrice?: number;
  orderBookDepthUSDT?: number;
  estimatedSlippageBps?: number;
  fundingRateBps?: number;
  nextFundingTime?: string | number;
  walletBalanceUSDT: number;
  availableBalanceUSDT: number;
  marginBalanceUSDT: number;
  initialMarginUSDT: number;
  maintenanceMarginUSDT: number;
  openOrderInitialMarginUSDT: number;
  leverage: number;
  marginMode: FuturesMarginMode;
  positionSide: FuturesPositionSide;
  liquidationPrice?: number;
  projectedLiquidationDistancePct?: number;
  takerFeeRate?: number;
  exchangeFiltersVerified: boolean;
  leverageBracketVerified?: boolean;
  orderBookVerified: boolean;
  positions: FuturesPositionInput[];
  openOrders?: FuturesOpenOrderInput[];
  openOrdersNotionalUSDT?: number;
  observedAt: string;
  sourceToolNames: string[];
}

export interface FuturesOrderIntentInput {
  symbol?: string;
  side: FuturesOrderSide;
  positionSide: FuturesPositionSide;
  quantity: number;
  notionalUSDT: number;
  reduceOnly: boolean;
  action?: Extract<FuturesDecision, 'OPEN' | 'REDUCE' | 'CLOSE'>;
  protectiveStopPrice?: number;
  protectiveStopSupported?: boolean;
}

export interface FuturesRiskPolicy {
  maxTotalNotionalUSDT: number;
  maxLeverage: number;
  maxDataAgeMs: number;
  maxSpreadBps: number;
  maxSlippageBps: number;
  maxFundingBps: number;
  minLiquidationDistancePct: number;
  maxMarginUtilizationPct: number;
  feeReserveRate: number;
}

export interface FuturesRiskEvidence {
  observedAt: string;
  sourceToolNames: string[];
  checks: Record<string, number | string | boolean | null>;
}

export interface FuturesStressScenario {
  name: string;
  markMovePct: number;
  fundingRateBps: number;
  estimatedPnlUSDT: number;
  projectedMarginImpactUSDT: number;
}

export interface FuturesRiskEnvelope {
  schemaVersion: string;
  methodologyVersion: string;
  analysisId: string;
  generatedAt: string;
  marketType: FuturesMarketType;
  contractType: FuturesMarketType;
  strategyMode: FuturesStrategyMode;
  symbol: string;
  action: FuturesDecision;
  decision: FuturesDecision;
  riskZone: FuturesRiskZone;
  executionEligible: boolean;
  executionEligibility: boolean;
  reportOnly: boolean;
  reasonCodes: string[];
  reasons: string[];
  notionalUSDT: number;
  currentNotionalUSDT: number;
  combinedNotionalUSDT: number;
  leverage: number;
  marginMode: FuturesMarginMode;
  positionSide: FuturesPositionSide;
  marginRequiredUSDT: number;
  marginRequired: number;
  feeReserveUSDT: number;
  marginUtilizationPct: number;
  marginUtilization: number;
  fundingRateBps: number | null;
  fundingExposureUSDT: number | null;
  fundingExposure: number | null;
  spreadBps: number | null;
  slippageBps: number | null;
  liquidationDistancePct: number | null;
  hedgeRatio: number | null;
  hedgeDriftPct: number | null;
  stressScenarios: FuturesStressScenario[];
  evidence: FuturesRiskEvidence;
  invalidationRule: string;
  invalidation: string;
  constraints: string[];
  inputHash: string;
  outputHash: string;
}

export const DEFAULT_FUTURES_RISK_POLICY: FuturesRiskPolicy = {
  maxTotalNotionalUSDT: 10,
  maxLeverage: 3,
  maxDataAgeMs: 15_000,
  maxSpreadBps: 50,
  maxSlippageBps: 50,
  maxFundingBps: 5,
  minLiquidationDistancePct: 10,
  maxMarginUtilizationPct: 25,
  feeReserveRate: 0.001,
};

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

function canonicalize(value: unknown): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
  if (Array.isArray(value)) return value.map((item) => canonicalize(item));
  if (typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalize(child)]));
  }
  return String(value);
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function sha256(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function nonNegative(value: unknown): value is number {
  return finite(value) && value >= 0;
}

function positive(value: unknown): value is number {
  return finite(value) && value > 0;
}

function upper(value: string): string {
  return value.trim().toUpperCase();
}

function positionNotional(position: FuturesPositionInput, markPrice: number): number {
  if (positive(position.notionalUSDT)) return Math.abs(position.notionalUSDT);
  if (finite(position.positionAmt) && positive(markPrice)) return Math.abs(position.positionAmt * markPrice);
  return 0;
}

function openOrderNotional(order: FuturesOpenOrderInput, markPrice: number): number {
  if (positive(order.notionalUSDT)) return Math.abs(order.notionalUSDT);
  if (positive(order.quantity) && positive(markPrice)) return Math.abs(order.quantity * markPrice);
  return 0;
}

function normalizePolicy(policy?: Partial<FuturesRiskPolicy>): FuturesRiskPolicy {
  const requested = { ...DEFAULT_FUTURES_RISK_POLICY, ...policy };
  const bounded = (value: number, minimum: number, maximum: number, fallback: number): number => {
    if (!finite(value)) return fallback;
    return Math.min(Math.max(value, minimum), maximum);
  };
  return {
    maxTotalNotionalUSDT: bounded(requested.maxTotalNotionalUSDT, 0.01, DEFAULT_FUTURES_RISK_POLICY.maxTotalNotionalUSDT, DEFAULT_FUTURES_RISK_POLICY.maxTotalNotionalUSDT),
    maxLeverage: bounded(requested.maxLeverage, 1, DEFAULT_FUTURES_RISK_POLICY.maxLeverage, DEFAULT_FUTURES_RISK_POLICY.maxLeverage),
    maxDataAgeMs: bounded(requested.maxDataAgeMs, 1, DEFAULT_FUTURES_RISK_POLICY.maxDataAgeMs, DEFAULT_FUTURES_RISK_POLICY.maxDataAgeMs),
    maxSpreadBps: bounded(requested.maxSpreadBps, 0, DEFAULT_FUTURES_RISK_POLICY.maxSpreadBps, DEFAULT_FUTURES_RISK_POLICY.maxSpreadBps),
    maxSlippageBps: bounded(requested.maxSlippageBps, 0, DEFAULT_FUTURES_RISK_POLICY.maxSlippageBps, DEFAULT_FUTURES_RISK_POLICY.maxSlippageBps),
    maxFundingBps: bounded(requested.maxFundingBps, 0, DEFAULT_FUTURES_RISK_POLICY.maxFundingBps, DEFAULT_FUTURES_RISK_POLICY.maxFundingBps),
    minLiquidationDistancePct: Math.max(
      finite(requested.minLiquidationDistancePct) ? requested.minLiquidationDistancePct : DEFAULT_FUTURES_RISK_POLICY.minLiquidationDistancePct,
      DEFAULT_FUTURES_RISK_POLICY.minLiquidationDistancePct,
    ),
    maxMarginUtilizationPct: bounded(requested.maxMarginUtilizationPct, 0, DEFAULT_FUTURES_RISK_POLICY.maxMarginUtilizationPct, DEFAULT_FUTURES_RISK_POLICY.maxMarginUtilizationPct),
    feeReserveRate: bounded(requested.feeReserveRate, 0, 0.1, DEFAULT_FUTURES_RISK_POLICY.feeReserveRate),
  };
}

function addReason(reasons: string[], codes: string[], code: string, reason: string): void {
  codes.push(code);
  reasons.push(reason);
}

function calculateLiquidationDistance(context: FuturesContextInput): number | null {
  if (finite(context.projectedLiquidationDistancePct)) return context.projectedLiquidationDistancePct;
  if (positive(context.markPrice) && positive(context.liquidationPrice)) {
    return Math.abs(context.markPrice - context.liquidationPrice) / context.markPrice * 100;
  }
  return null;
}

function validFundingTime(value: string | number | undefined): boolean {
  if (typeof value === 'string') return Number.isFinite(Date.parse(value));
  return finite(value) && value > 0;
}

function calculateHedgeRatio(context: FuturesContextInput, markPrice: number): number | null {
  if (context.strategyMode !== 'neutral') return null;
  let longNotional = 0;
  let shortNotional = 0;
  for (const position of context.positions) {
    const amount = positionNotional(position, markPrice);
    if (upper(position.symbol) !== upper(context.symbol)) continue;
    if (position.positionSide === 'LONG' || (position.positionSide === 'BOTH' && position.positionAmt > 0)) longNotional += amount;
    if (position.positionSide === 'SHORT' || (position.positionSide === 'BOTH' && position.positionAmt < 0)) shortNotional += amount;
  }
  if (longNotional === 0 && shortNotional === 0) return null;
  if (longNotional === 0 || shortNotional === 0) return 0;
  return Math.min(longNotional, shortNotional) / Math.max(longNotional, shortNotional);
}

function invalidationRule(): string {
  return 'Re-read all Futures context, account, positions, funding, order book, liquidation, and exchange filters immediately before any write. Any stale, changed, missing, or unverifiable value changes the decision to WAIT.';
}

/** Evaluate a Futures order intent against a live, host supplied context. */
export function evaluateFuturesRisk(
  context: FuturesContextInput,
  intent?: FuturesOrderIntentInput,
  suppliedPolicy?: Partial<FuturesRiskPolicy>,
): FuturesRiskEnvelope {
  const policy = normalizePolicy(suppliedPolicy);
  const now = Date.now();
  const observedMs = Date.parse(context.observedAt);
  const input = { context, intent: intent ?? null, policy };
  const inputHash = sha256(input);
  const reasons: string[] = [];
  const reasonCodes: string[] = [];
  const requestedSymbol = upper(intent?.symbol ?? context.symbol);
  const symbol = upper(context.symbol);
  const actionRequested: FuturesDecision = intent?.action
    ?? (intent?.reduceOnly ? 'REDUCE' : 'OPEN');
  const markPrice = context.markPrice;
  const listedOpenOrdersNotionalUSDT = (context.openOrders ?? []).reduce((sum, order) => sum + openOrderNotional(order, markPrice), 0);
  const openOrdersNotionalUSDT = context.openOrdersNotionalUSDT !== undefined
    ? (nonNegative(context.openOrdersNotionalUSDT) ? context.openOrdersNotionalUSDT : 0)
    : listedOpenOrdersNotionalUSDT;
  const currentNotionalUSDT = context.positions.reduce((sum, position) => sum + positionNotional(position, markPrice), 0)
    + openOrdersNotionalUSDT;
  const requestedNotional = intent?.notionalUSDT ?? 0;
  // Opening adds exposure. Reduce only orders remove exposure, so the cap is
  // checked against the projected post order exposure.
  const combinedNotionalUSDT = intent?.reduceOnly
    ? Math.max(0, currentNotionalUSDT - (positive(requestedNotional) ? requestedNotional : 0))
    : currentNotionalUSDT + (positive(requestedNotional) ? requestedNotional : 0);
  const marginRequiredUSDT = positive(intent?.quantity) && positive(context.leverage)
    ? requestedNotional / context.leverage
    : 0;
  const feeRate = positive(context.takerFeeRate) ? context.takerFeeRate : policy.feeReserveRate;
  const feeReserveUSDT = positive(requestedNotional) ? requestedNotional * feeRate : 0;
  const marginDenominator = context.marginBalanceUSDT;
  const calculatedMarginUtilizationPct = positive(marginDenominator)
    ? ((Math.max(0, context.initialMarginUSDT) + Math.max(0, context.openOrderInitialMarginUSDT) + marginRequiredUSDT) / marginDenominator) * 100
    : Number.POSITIVE_INFINITY;
  const marginUtilizationPct = Number.isFinite(calculatedMarginUtilizationPct) ? calculatedMarginUtilizationPct : 0;
  const spreadBps = positive(context.markPrice) && positive(context.bidPrice) && positive(context.askPrice)
    ? ((context.askPrice - context.bidPrice) / context.markPrice) * 10_000
    : null;
  const slippageBps = finite(context.estimatedSlippageBps) ? context.estimatedSlippageBps : null;
  const fundingRateBps = finite(context.fundingRateBps) ? context.fundingRateBps : null;
  const fundingExposureUSDT = fundingRateBps === null ? null : Math.abs(fundingRateBps / 10_000 * combinedNotionalUSDT);
  const liquidationDistancePct = calculateLiquidationDistance(context);
  const hedgeRatio = calculateHedgeRatio(context, markPrice);
  const hedgeDriftPct = hedgeRatio === null ? null : (1 - hedgeRatio) * 100;
  const exposureFactor = context.strategyMode === 'neutral' && hedgeRatio !== null ? Math.max(0, 1 - hedgeRatio) : 1;
  const sideSign = intent?.side === 'SELL' ? -1 : 1;
  const stressScenarios: FuturesStressScenario[] = [-5, 5].map((markMovePct) => ({
    name: markMovePct < 0 ? 'MARK_DOWN_5_PERCENT' : 'MARK_UP_5_PERCENT',
    markMovePct,
    fundingRateBps: fundingRateBps ?? 0,
    estimatedPnlUSDT: requestedNotional * (markMovePct / 100) * sideSign * exposureFactor,
    projectedMarginImpactUSDT: Math.abs(requestedNotional * (markMovePct / 100) * sideSign * exposureFactor)
      + (fundingRateBps === null ? 0 : Math.abs(fundingRateBps / 10_000 * requestedNotional)),
  }));

  if (!['USD_M', 'COIN_M'].includes(context.marketType)) addReason(reasons, reasonCodes, 'INVALID_MARKET_TYPE', 'Contract type is not recognised.');
  if (!['directional', 'neutral'].includes(context.strategyMode)) addReason(reasons, reasonCodes, 'INVALID_STRATEGY_MODE', 'Strategy mode is not recognised.');
  if (!symbol || requestedSymbol !== symbol) addReason(reasons, reasonCodes, 'SYMBOL_MISMATCH', 'Order symbol does not match the published Futures context.');
  if (!positive(markPrice)) addReason(reasons, reasonCodes, 'INVALID_MARK_PRICE', 'Mark price is missing or invalid.');
  if (!Number.isFinite(observedMs) || now - observedMs > policy.maxDataAgeMs || observedMs - now > 5_000) {
    addReason(reasons, reasonCodes, 'STALE_DATA', `Futures data is older than ${policy.maxDataAgeMs} ms or has an invalid timestamp.`);
  }
  if (!Array.isArray(context.sourceToolNames) || context.sourceToolNames.length === 0) addReason(reasons, reasonCodes, 'MISSING_MCP_TOOLS', 'The live MCP source tool names are missing.');
  if (context.openOrders && context.openOrdersNotionalUSDT !== undefined
    && Math.abs(context.openOrdersNotionalUSDT - listedOpenOrdersNotionalUSDT) > 0.000001) {
    addReason(reasons, reasonCodes, 'OPEN_ORDERS_MISMATCH', 'The declared open order notional does not match the listed live open orders.');
  }
  if (!context.exchangeFiltersVerified) addReason(reasons, reasonCodes, 'FILTERS_UNVERIFIED', 'Exchange filters cannot be verified.');
  if (context.leverageBracketVerified !== true) addReason(reasons, reasonCodes, 'LEVERAGE_BRACKET_UNVERIFIED', 'Leverage bracket data cannot be verified.');
  if (!context.orderBookVerified || !positive(context.bidPrice) || !positive(context.askPrice) || !positive(context.orderBookDepthUSDT)) {
    addReason(reasons, reasonCodes, 'ORDER_BOOK_MISSING', 'Order book bid, ask, depth, and verification are required.');
  }
  if (slippageBps === null || slippageBps < 0) addReason(reasons, reasonCodes, 'SLIPPAGE_MISSING', 'Estimated slippage is missing or invalid.');
  if (fundingRateBps === null || !validFundingTime(context.nextFundingTime)) addReason(reasons, reasonCodes, 'FUNDING_MISSING', 'Funding rate and next funding time are required.');
  if (liquidationDistancePct === null || liquidationDistancePct < 0) addReason(reasons, reasonCodes, 'LIQUIDATION_MISSING', 'Liquidation distance is missing or invalid.');
  if (!['ISOLATED', 'CROSSED'].includes(context.marginMode) || context.marginMode === 'CROSSED') addReason(reasons, reasonCodes, 'CROSS_MARGIN', 'Cross margin is not allowed. Use isolated margin only.');
  if (!positive(context.leverage) || context.leverage > policy.maxLeverage) addReason(reasons, reasonCodes, 'LEVERAGE_LIMIT', `Leverage must be at or below ${policy.maxLeverage}x.`);
  if (!nonNegative(context.walletBalanceUSDT) || !nonNegative(context.availableBalanceUSDT) || !nonNegative(context.marginBalanceUSDT)
    || !nonNegative(context.initialMarginUSDT) || !nonNegative(context.maintenanceMarginUSDT) || !nonNegative(context.openOrderInitialMarginUSDT)) {
    addReason(reasons, reasonCodes, 'ACCOUNT_DATA_INVALID', 'Wallet, available, margin, initial margin, and maintenance margin values are required.');
  }
  if (!intent || !positive(intent.quantity) || !positive(requestedNotional)) addReason(reasons, reasonCodes, 'ORDER_INTENT_MISSING', 'A positive quantity and notional are required.');
  if (intent && !['BUY', 'SELL'].includes(intent.side)) addReason(reasons, reasonCodes, 'INVALID_SIDE', 'Order side must be BUY or SELL.');
  if (intent && !['BOTH', 'LONG', 'SHORT'].includes(intent.positionSide)) addReason(reasons, reasonCodes, 'INVALID_POSITION_SIDE', 'An explicit BOTH, LONG, or SHORT position side is required.');
  if (intent && intent.positionSide !== context.positionSide && context.positionSide !== 'BOTH') addReason(reasons, reasonCodes, 'POSITION_SIDE_MISMATCH', 'Order position side does not match the live account context.');
  if (intent && intent.action && intent.action !== 'OPEN' && !intent.reduceOnly) addReason(reasons, reasonCodes, 'REDUCE_ONLY_REQUIRED', 'REDUCE and CLOSE actions must set reduceOnly=true.');
  if (positive(requestedNotional) && requestedNotional > policy.maxTotalNotionalUSDT) addReason(reasons, reasonCodes, 'NOTIONAL_LIMIT', `Each Futures order must not exceed ${policy.maxTotalNotionalUSDT} USDT notional.`);
  if (positive(combinedNotionalUSDT) && combinedNotionalUSDT > policy.maxTotalNotionalUSDT) addReason(reasons, reasonCodes, 'NOTIONAL_LIMIT', `Combined Futures notional must not exceed ${policy.maxTotalNotionalUSDT} USDT.`);
  if (spreadBps === null || spreadBps < 0 || spreadBps > policy.maxSpreadBps) addReason(reasons, reasonCodes, 'SPREAD_LIMIT', `Spread must be at or below ${policy.maxSpreadBps} basis points.`);
  if (slippageBps !== null && slippageBps > policy.maxSlippageBps) addReason(reasons, reasonCodes, 'SLIPPAGE_LIMIT', `Estimated slippage must be at or below ${policy.maxSlippageBps} basis points.`);
  if (fundingRateBps !== null && Math.abs(fundingRateBps) > policy.maxFundingBps) addReason(reasons, reasonCodes, 'FUNDING_STRESS', `Absolute funding must be at or below ${policy.maxFundingBps} basis points per interval.`);
  if (liquidationDistancePct !== null && liquidationDistancePct < policy.minLiquidationDistancePct) addReason(reasons, reasonCodes, 'LIQUIDATION_DISTANCE', `Projected liquidation distance must be at least ${policy.minLiquidationDistancePct} percent.`);
  if (!positive(marginDenominator) || marginUtilizationPct > policy.maxMarginUtilizationPct) addReason(reasons, reasonCodes, 'MARGIN_UTILIZATION', `Margin utilization must be at or below ${policy.maxMarginUtilizationPct} percent.`);
  if (intent && positive(requestedNotional) && context.availableBalanceUSDT < marginRequiredUSDT + feeReserveUSDT) addReason(reasons, reasonCodes, 'INSUFFICIENT_MARGIN', 'Available margin does not cover required margin plus the fee reserve.');

  if (intent?.reduceOnly) {
    const matching = context.positions.find((position) => {
      if (upper(position.symbol) !== symbol || position.positionSide !== intent.positionSide) return false;
      if (!finite(position.positionAmt) || position.positionAmt === 0) return false;
      if (intent.positionSide === 'BOTH') return intent.side === 'SELL' ? position.positionAmt > 0 : position.positionAmt < 0;
      return true;
    });
    if (!matching) addReason(reasons, reasonCodes, 'REDUCE_ONLY_POSITION', 'Reduce only order has no matching live position.');
    else if (Math.abs(matching.positionAmt) < intent.quantity) addReason(reasons, reasonCodes, 'REDUCE_ONLY_QUANTITY', 'Reduce only quantity exceeds the live position.');
  }

  const reportOnly = context.marketType === 'COIN_M' || context.strategyMode === 'neutral';
  if (context.marketType === 'COIN_M') addReason(reasons, reasonCodes, 'COIN_M_REPORT_ONLY', 'COIN M is report only in v1. No COIN M write is permitted.');
  if (context.strategyMode === 'neutral') addReason(reasons, reasonCodes, 'NEUTRAL_REPORT_ONLY', 'Neutral hedge analysis is report only in v1. Two hedge legs are never submitted.');
  const isOpening = actionRequested === 'OPEN' && !intent?.reduceOnly;
  if (isOpening && context.marketType === 'USD_M' && context.strategyMode === 'directional'
    && (intent?.protectiveStopSupported !== true || !positive(intent.protectiveStopPrice))) {
    addReason(reasons, reasonCodes, 'PROTECTIVE_STOP_REQUIRED', 'Opening a directional USD M position requires a declared protective stop plan supported by the live MCP host.');
  }

  const nonBlockingCodes = new Set(['COIN_M_REPORT_ONLY', 'NEUTRAL_REPORT_ONLY']);
  const blockingReasonCodes = reasonCodes.filter((code) => !nonBlockingCodes.has(code));
  const blockingReasons = reasons.filter((_reason, index) => !nonBlockingCodes.has(reasonCodes[index]));
  const executionEligible = blockingReasons.length === 0 && context.marketType === 'USD_M' && context.strategyMode === 'directional';
  let action: FuturesDecision = actionRequested;
  if (blockingReasons.length > 0) action = 'WAIT';
  if (intent?.reduceOnly && blockingReasons.length === 0) action = actionRequested === 'CLOSE' ? 'CLOSE' : 'REDUCE';
  const riskZone: FuturesRiskZone = blockingReasons.length > 0
    ? (blockingReasonCodes.some((code) => ['LIQUIDATION_DISTANCE', 'CROSS_MARGIN', 'LEVERAGE_LIMIT', 'NOTIONAL_LIMIT', 'INSUFFICIENT_MARGIN'].includes(code)) ? 'CRITICAL' : 'DEFENSIVE')
    : (spreadBps !== null && slippageBps !== null && fundingRateBps !== null && liquidationDistancePct !== null
      && spreadBps <= policy.maxSpreadBps / 2 && slippageBps <= policy.maxSlippageBps / 2
      && Math.abs(fundingRateBps) <= policy.maxFundingBps / 2 && liquidationDistancePct >= policy.minLiquidationDistancePct * 2
      ? 'OPTIMAL' : 'WATCH');
  if (reportOnly && blockingReasons.length === 0) action = intent?.reduceOnly ? 'REDUCE' : 'OPEN';

  const evidence: FuturesRiskEvidence = {
    observedAt: context.observedAt,
    sourceToolNames: [...context.sourceToolNames].sort(),
    checks: {
      dataAgeMs: Number.isFinite(observedMs) ? Math.max(0, now - observedMs) : null,
      spreadBps,
      slippageBps,
      fundingRateBps,
      liquidationDistancePct,
      availableBalanceUSDT: context.availableBalanceUSDT,
      marginRequiredUSDT,
      feeReserveUSDT,
      marginUtilizationPct: Number.isFinite(marginUtilizationPct) ? marginUtilizationPct : null,
      combinedNotionalUSDT,
      exchangeFiltersVerified: context.exchangeFiltersVerified,
      orderBookVerified: context.orderBookVerified,
    },
  };
  const outputWithoutHash = {
    schemaVersion: FUTURES_RISK_SCHEMA_VERSION,
    methodologyVersion: FUTURES_METHODOLOGY_VERSION,
    analysisId: `s402_fut_${inputHash.slice(0, 24)}`,
    // Tie the proof timestamp to the observed input so identical inputs yield
    // identical hashes. A caller must still enforce freshness before use.
    generatedAt: context.observedAt,
    marketType: context.marketType,
    contractType: context.marketType,
    strategyMode: context.strategyMode,
    symbol,
    action,
    decision: action,
    riskZone,
    executionEligible,
    executionEligibility: executionEligible,
    reportOnly,
    reasonCodes,
    reasons,
    notionalUSDT: requestedNotional,
    currentNotionalUSDT,
    combinedNotionalUSDT,
    leverage: context.leverage,
    marginMode: context.marginMode,
    positionSide: context.positionSide,
    marginRequiredUSDT,
    marginRequired: marginRequiredUSDT,
    feeReserveUSDT,
    marginUtilizationPct,
    marginUtilization: marginUtilizationPct,
    fundingRateBps,
    fundingExposureUSDT,
    fundingExposure: fundingExposureUSDT,
    spreadBps,
    slippageBps,
    liquidationDistancePct,
    hedgeRatio,
    hedgeDriftPct,
    stressScenarios,
    evidence,
    invalidationRule: invalidationRule(),
    invalidation: invalidationRule(),
    constraints: [
      'Combined Futures notional cap is 10 USDT.',
      'Maximum leverage is 3x.',
      'Isolated margin is required and Signal402 never changes leverage or margin mode automatically.',
      'No withdrawals or transfers are performed.',
      'Risk estimates are not guaranteed loss limits.',
      ...(reportOnly ? ['This path is report only and cannot submit an order.'] : []),
    ],
    inputHash,
  } as Omit<FuturesRiskEnvelope, 'outputHash'>;
  return { ...outputWithoutHash, outputHash: sha256(outputWithoutHash) };
}

/** Backwards friendly name for callers that use the word assess. */
export const assessFuturesRisk = evaluateFuturesRisk;
