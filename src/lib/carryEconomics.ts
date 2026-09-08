import { sha256 } from './futuresRisk.js';

export const CARRY_METHODOLOGY_VERSION = 'signal402-binance-cex-carry-v1';
export const CARRY_SCHEMA_VERSION = 'signal402-cex-carry-v1';

export type CexCarryContext = {
  symbol: string;
  spotPrice: number;
  futuresMarkPrice: number;
  fundingRateBps: number;
  fundingIntervalHours: number;
  horizonHours: number;
  spotFeeRate: number;
  futuresFeeRate: number;
  spotSpreadBps: number;
  futuresSpreadBps: number;
  spotSlippageBps: number;
  futuresSlippageBps: number;
  observedAt: string;
  sourceToolNames: string[];
};

export type CexCarryReport = {
  schemaVersion: typeof CARRY_SCHEMA_VERSION;
  methodologyVersion: typeof CARRY_METHODOLOGY_VERSION;
  generatedAt: string;
  symbol: string;
  decision: 'ENTER' | 'WAIT';
  reportOnly: true;
  dataFresh: boolean;
  dataAgeMs: number | null;
  basisBps: number;
  fundingCarryBps: number;
  fundingSettlements: number;
  roundTripCostBps: number;
  netExpectedCarryBps: number;
  breakEvenHours: number | null;
  invalidationRule: string;
  assumptions: string[];
  sourceToolNames: string[];
  inputHash: string;
  outputHash: string;
};

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function round(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

export function evaluateCexCarry(context: CexCarryContext, now = Date.now(), maxAgeMs = 15_000): CexCarryReport {
  const dataTimestamp = Date.parse(context.observedAt);
  const dataAgeMs = Number.isFinite(dataTimestamp) ? Math.max(0, now - dataTimestamp) : null;
  const dataFresh = dataAgeMs !== null && dataAgeMs <= maxAgeMs;
  const inputHash = sha256(context);
  const basisBps = finite(context.spotPrice) && context.spotPrice > 0
    ? ((context.futuresMarkPrice - context.spotPrice) / context.spotPrice) * 10_000
    : 0;
  const fundingSettlements = context.fundingIntervalHours > 0 ? context.horizonHours / context.fundingIntervalHours : 0;
  const fundingCarryBps = context.fundingRateBps * fundingSettlements;
  const roundTripCostBps = (2 * (context.spotFeeRate + context.futuresFeeRate) * 10_000)
    + context.spotSpreadBps + context.futuresSpreadBps + context.spotSlippageBps + context.futuresSlippageBps;
  const netExpectedCarryBps = basisBps + fundingCarryBps - roundTripCostBps;
  const breakEvenHours = context.fundingRateBps > 0
    ? roundTripCostBps / context.fundingRateBps * context.fundingIntervalHours
    : null;
  const decision: 'ENTER' | 'WAIT' = dataFresh && netExpectedCarryBps > 0 ? 'ENTER' : 'WAIT';
  const report: Omit<CexCarryReport, 'outputHash'> = {
    schemaVersion: CARRY_SCHEMA_VERSION,
    methodologyVersion: CARRY_METHODOLOGY_VERSION,
    generatedAt: new Date(now).toISOString(),
    symbol: context.symbol.trim().toUpperCase(),
    decision,
    reportOnly: true,
    dataFresh,
    dataAgeMs,
    basisBps: round(basisBps),
    fundingCarryBps: round(fundingCarryBps),
    fundingSettlements: round(fundingSettlements),
    roundTripCostBps: round(roundTripCostBps),
    netExpectedCarryBps: round(netExpectedCarryBps),
    breakEvenHours: breakEvenHours === null ? null : round(breakEvenHours),
    invalidationRule: 'Re-read spot, futures mark, funding, fees, spread, slippage, and timestamps. Any stale or missing input changes the report to WAIT.',
    assumptions: [
      'Binance CEX Spot and Futures legs only. No DEX, wallet, transfer, or withdrawal action exists.',
      'Funding carry is shown with its observed sign. It is not a guaranteed return.',
      'Cost includes two fee legs per venue plus observed spread and slippage.',
      'This report is analytical only. It never submits a hedge or opens a position.',
    ],
    sourceToolNames: [...context.sourceToolNames],
    inputHash,
  };
  // generatedAt and dataAgeMs depend on the evaluator's wall clock. Keep
  // both values visible for operators, but omit their volatile values from
  // the proof so identical market input produces an identical report hash.
  const hashableReport = {
    ...report,
    generatedAt: context.observedAt,
    dataAgeMs: null,
  };
  return { ...report, outputHash: sha256(hashableReport) };
}
