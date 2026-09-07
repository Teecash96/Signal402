import { z } from 'zod';

const safeId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/);
const txHash = z.string().regex(/^0x[0-9a-fA-F]{64}$/);

export const balanceSnapshotSchema = z.object({
  asset: z.string().trim().min(1).max(30).regex(/^[A-Za-z0-9._-]+$/),
  free: z.number().finite().nonnegative(),
  locked: z.number().finite().nonnegative(),
}).strict();

export const hostMarketSchema = z.object({
  source: z.literal('binance-mcp'),
  symbol: z.string().trim().min(1).max(30).regex(/^[A-Za-z0-9._-]+$/),
  price: z.number().finite().positive(),
  changePercent: z.number().finite().optional(),
  highPrice: z.number().finite().positive().optional(),
  lowPrice: z.number().finite().positive().optional(),
  weightedAvgPrice: z.number().finite().positive().optional(),
  volume: z.number().finite().nonnegative().optional(),
  quoteVolume: z.number().finite().nonnegative().optional(),
  toolNames: z.array(z.string().trim().min(1).max(200)).min(1).max(200),
  observedAt: z.string().datetime().optional(),
}).strict();

export const tradeProposalInputSchema = z.object({
  proposalId: safeId,
  asset: z.string().trim().min(1).max(30).regex(/^[A-Za-z0-9._-]+$/),
  side: z.literal('BUY'),
  amountUSDT: z.number().finite().positive().max(10),
  balanceUSDT: z.number().finite().nonnegative(),
  reason: z.string().trim().min(1).max(500),
  paymentReceiptId: txHash,
}).strict();

export const tradeStatusInputSchema = z.object({
  proposalId: safeId,
  status: z.enum(['refused', 'filled', 'cancelled']),
  reason: z.string().trim().min(1).max(500).optional(),
  orderId: safeId.optional(),
  filledPrice: z.number().finite().positive().optional(),
  executedQty: z.number().finite().positive().optional(),
  amountUSDT: z.number().finite().positive().max(10).optional(),
  source: z.enum(['binance-mcp-host', 'binance-mcp-direct-approved']).optional(),
  mcpToolName: z.string().trim().min(1).max(200).optional(),
  beforeBalances: z.array(balanceSnapshotSchema).min(1).max(200).optional(),
  afterBalances: z.array(balanceSnapshotSchema).min(1).max(200).optional(),
}).strict();

export const futuresPositionSchema = z.object({
  symbol: z.string().trim().min(1).max(30).regex(/^[A-Za-z0-9._-]+$/),
  positionSide: z.enum(['BOTH', 'LONG', 'SHORT']),
  positionAmt: z.number().finite(),
  entryPrice: z.number().finite().nonnegative(),
  markPrice: z.number().finite().positive(),
  liquidationPrice: z.number().finite().positive().optional(),
  leverage: z.number().finite().positive().optional(),
  marginMode: z.enum(['ISOLATED', 'CROSSED']).optional(),
  initialMarginUSDT: z.number().finite().nonnegative().optional(),
  maintenanceMarginUSDT: z.number().finite().nonnegative().optional(),
  unrealizedPnlUSDT: z.number().finite().optional(),
  notionalUSDT: z.number().finite().nonnegative().optional(),
}).strict();

export const futuresOpenOrderSchema = z.object({
  symbol: z.string().trim().min(1).max(30).regex(/^[A-Za-z0-9._-]+$/),
  side: z.enum(['BUY', 'SELL']).optional(),
  positionSide: z.enum(['BOTH', 'LONG', 'SHORT']).optional(),
  quantity: z.number().finite().positive().optional(),
  notionalUSDT: z.number().finite().nonnegative().optional(),
  reduceOnly: z.boolean().optional(),
  status: z.string().trim().min(1).max(50).optional(),
}).strict();

export const futuresIntentSchema = z.object({
  symbol: z.string().trim().min(1).max(30).regex(/^[A-Za-z0-9._-]+$/).optional(),
  side: z.enum(['BUY', 'SELL']),
  positionSide: z.enum(['BOTH', 'LONG', 'SHORT']),
  quantity: z.number().finite().positive(),
  notionalUSDT: z.number().finite().positive().max(10),
  reduceOnly: z.boolean(),
  action: z.enum(['OPEN', 'REDUCE', 'CLOSE']).optional(),
  protectiveStopPrice: z.number().finite().positive().optional(),
  protectiveStopSupported: z.boolean().optional(),
}).strict();

export const futuresContextSchema = z.object({
  marketType: z.enum(['USD_M', 'COIN_M']),
  strategyMode: z.enum(['directional', 'neutral']),
  symbol: z.string().trim().min(1).max(30).regex(/^[A-Za-z0-9._-]+$/),
  markPrice: z.number().finite().positive(),
  indexPrice: z.number().finite().positive().optional(),
  bidPrice: z.number().finite().positive(),
  askPrice: z.number().finite().positive(),
  orderBookDepthUSDT: z.number().finite().positive(),
  estimatedSlippageBps: z.number().finite().nonnegative(),
  fundingRateBps: z.number().finite(),
  nextFundingTime: z.union([z.string().datetime(), z.number().finite()]),
  walletBalanceUSDT: z.number().finite().nonnegative(),
  availableBalanceUSDT: z.number().finite().nonnegative(),
  marginBalanceUSDT: z.number().finite().nonnegative(),
  initialMarginUSDT: z.number().finite().nonnegative(),
  maintenanceMarginUSDT: z.number().finite().nonnegative(),
  openOrderInitialMarginUSDT: z.number().finite().nonnegative(),
  leverage: z.number().finite().positive(),
  marginMode: z.enum(['ISOLATED', 'CROSSED']),
  positionSide: z.enum(['BOTH', 'LONG', 'SHORT']),
  liquidationPrice: z.number().finite().positive().optional(),
  projectedLiquidationDistancePct: z.number().finite().nonnegative().optional(),
  takerFeeRate: z.number().finite().nonnegative().optional(),
  exchangeFiltersVerified: z.boolean(),
  leverageBracketVerified: z.boolean().optional(),
  orderBookVerified: z.boolean(),
  positions: z.array(futuresPositionSchema).max(200),
  openOrders: z.array(futuresOpenOrderSchema).max(200).optional(),
  openOrdersNotionalUSDT: z.number().finite().nonnegative().optional(),
  observedAt: z.string().datetime(),
  sourceToolNames: z.array(z.string().trim().min(1).max(200)).min(1).max(200),
}).strict();

export const hostFuturesContextSchema = futuresContextSchema.extend({
  source: z.literal('binance-mcp'),
  intent: futuresIntentSchema,
}).strict();

export const futuresRevalidateInputSchema = hostFuturesContextSchema.omit({ source: true }).extend({
  proposalId: safeId,
}).strict();

const futuresStressScenarioSchema = z.object({
  name: z.string().min(1).max(100),
  markMovePct: z.number().finite(),
  fundingRateBps: z.number().finite(),
  estimatedPnlUSDT: z.number().finite(),
  projectedMarginImpactUSDT: z.number().finite().nonnegative(),
}).strict();

const futuresEvidenceSchema = z.object({
  observedAt: z.string().datetime(),
  sourceToolNames: z.array(z.string().trim().min(1).max(200)).min(1).max(200),
  checks: z.record(z.string(), z.union([z.number().finite(), z.string(), z.boolean(), z.null()])),
}).strict();

export const futuresRiskProofSchema = z.object({
  schemaVersion: z.string().min(1).max(100),
  methodologyVersion: z.string().min(1).max(100),
  analysisId: safeId,
  inputHash: z.string().regex(/^[0-9a-f]{64}$/),
  outputHash: z.string().regex(/^[0-9a-f]{64}$/),
  action: z.enum(['OPEN', 'WAIT', 'REDUCE', 'CLOSE']),
  riskZone: z.enum(['OPTIMAL', 'WATCH', 'DEFENSIVE', 'CRITICAL']),
  executionEligible: z.boolean(),
  reportOnly: z.boolean(),
}).strict();

export const futuresRiskEnvelopeSchema = z.object({
  schemaVersion: z.string().min(1).max(100),
  methodologyVersion: z.string().min(1).max(100),
  analysisId: safeId,
  generatedAt: z.string().datetime(),
  marketType: z.enum(['USD_M', 'COIN_M']),
  contractType: z.enum(['USD_M', 'COIN_M']),
  strategyMode: z.enum(['directional', 'neutral']),
  symbol: z.string().trim().min(1).max(30).regex(/^[A-Za-z0-9._-]+$/),
  action: z.enum(['OPEN', 'WAIT', 'REDUCE', 'CLOSE']),
  decision: z.enum(['OPEN', 'WAIT', 'REDUCE', 'CLOSE']),
  riskZone: z.enum(['OPTIMAL', 'WATCH', 'DEFENSIVE', 'CRITICAL']),
  executionEligible: z.boolean(),
  executionEligibility: z.boolean(),
  reportOnly: z.boolean(),
  reasonCodes: z.array(z.string().min(1).max(100)).max(100),
  reasons: z.array(z.string().min(1).max(500)).max(100),
  notionalUSDT: z.number().finite().nonnegative(),
  currentNotionalUSDT: z.number().finite().nonnegative(),
  combinedNotionalUSDT: z.number().finite().nonnegative(),
  leverage: z.number().finite().positive(),
  marginMode: z.enum(['ISOLATED', 'CROSSED']),
  positionSide: z.enum(['BOTH', 'LONG', 'SHORT']),
  marginRequiredUSDT: z.number().finite().nonnegative(),
  marginRequired: z.number().finite().nonnegative(),
  feeReserveUSDT: z.number().finite().nonnegative(),
  marginUtilizationPct: z.number().finite().nonnegative(),
  marginUtilization: z.number().finite().nonnegative(),
  fundingRateBps: z.number().finite().nullable(),
  fundingExposureUSDT: z.number().finite().nonnegative().nullable(),
  fundingExposure: z.number().finite().nonnegative().nullable(),
  spreadBps: z.number().finite().nonnegative().nullable(),
  slippageBps: z.number().finite().nonnegative().nullable(),
  liquidationDistancePct: z.number().finite().nonnegative().nullable(),
  hedgeRatio: z.number().finite().nonnegative().nullable(),
  hedgeDriftPct: z.number().finite().nonnegative().nullable(),
  stressScenarios: z.array(futuresStressScenarioSchema).max(20),
  evidence: futuresEvidenceSchema,
  invalidationRule: z.string().min(1).max(1000),
  invalidation: z.string().min(1).max(1000),
  constraints: z.array(z.string().min(1).max(500)).max(50),
  inputHash: z.string().regex(/^[0-9a-f]{64}$/),
  outputHash: z.string().regex(/^[0-9a-f]{64}$/),
}).strict();

export const futuresProposalInputSchema = z.object({
  proposalId: safeId,
  paymentReceiptId: txHash,
  analysisId: safeId,
  marketType: z.enum(['USD_M', 'COIN_M']),
  strategyMode: z.enum(['directional', 'neutral']),
  symbol: z.string().trim().min(1).max(30).regex(/^[A-Za-z0-9._-]+$/),
  side: z.enum(['BUY', 'SELL']),
  positionSide: z.enum(['BOTH', 'LONG', 'SHORT']),
  quantity: z.number().finite().positive(),
  notionalUSDT: z.number().finite().positive().max(10),
  reduceOnly: z.boolean(),
  protectiveStopPrice: z.number().finite().positive().optional(),
  protectiveStopSupported: z.boolean().optional(),
  reason: z.string().trim().min(1).max(500),
  riskEnvelope: z.union([futuresRiskEnvelopeSchema, futuresRiskProofSchema]),
}).strict();

const futuresAccountSnapshotSchema = z.object({
  walletBalanceUSDT: z.number().finite().nonnegative(),
  availableBalanceUSDT: z.number().finite().nonnegative(),
  marginBalanceUSDT: z.number().finite().nonnegative(),
  initialMarginUSDT: z.number().finite().nonnegative(),
  maintenanceMarginUSDT: z.number().finite().nonnegative(),
}).strict();

const futuresPositionSnapshotSchema = z.object({
  symbol: z.string().trim().min(1).max(30).regex(/^[A-Za-z0-9._-]+$/),
  positionSide: z.enum(['BOTH', 'LONG', 'SHORT']),
  positionAmt: z.number().finite(),
  markPrice: z.number().finite().positive(),
  notionalUSDT: z.number().finite().nonnegative().optional(),
}).strict();

export const futuresStatusInputSchema = z.object({
  proposalId: safeId,
  eventType: z.enum(['ORDER_TRADE_UPDATE', 'ACCOUNT_UPDATE', 'MARGIN_CALL']),
  status: z.enum(['submitted', 'partially_filled', 'filled', 'rejected', 'cancelled', 'liquidated']),
  orderId: safeId.optional(),
  filledPrice: z.number().finite().positive().optional(),
  executedQty: z.number().finite().positive().optional(),
  realizedPnlUSDT: z.number().finite().optional(),
  source: z.enum(['binance-mcp-host', 'binance-mcp-direct-approved']),
  mcpToolName: z.string().trim().min(1).max(200),
  accountSnapshot: futuresAccountSnapshotSchema.optional(),
  beforeAccountSnapshot: futuresAccountSnapshotSchema.optional(),
  afterAccountSnapshot: futuresAccountSnapshotSchema.optional(),
  positionSnapshot: z.array(futuresPositionSnapshotSchema).max(200).optional(),
  beforePositionSnapshot: z.array(futuresPositionSnapshotSchema).max(200).optional(),
  afterPositionSnapshot: z.array(futuresPositionSnapshotSchema).max(200).optional(),
  observedAt: z.string().datetime(),
  reason: z.string().trim().min(1).max(500).optional(),
}).strict();

export const emptyBodySchema = z.object({}).strict();

export function parseBody<T>(schema: z.ZodType<T>, body: unknown): { data?: T; error?: string } {
  const result = schema.safeParse(body);
  return result.success ? { data: result.data } : { error: result.error.message };
}
