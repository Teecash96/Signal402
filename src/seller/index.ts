import 'dotenv/config';

import axios from 'axios';
import cors from 'cors';
import { timingSafeEqual } from 'node:crypto';
import express, { type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { audit } from '../lib/audit.js';
import { DashboardAuth, dashboardLoginSchema } from '../lib/auth.js';
import { BinanceMcpClient, type BinanceTicker } from '../lib/binanceMcp.js';
import { dashboardCspNonce, configureHttpSecurity } from '../lib/httpSecurity.js';
import { deriveMarketSignal, type MarketSignal } from '../lib/marketSignal.js';
import { createRateLimiter } from '../lib/rateLimit.js';
import { assessTradeRisk } from '../buyer/riskGuardian.js';
import {
  emptyBodySchema,
  futuresProposalInputSchema,
  futuresRevalidateInputSchema,
  futuresStatusInputSchema,
  hostFuturesContextSchema,
  hostMarketSchema,
  parseBody,
  tradeProposalInputSchema,
  tradeStatusInputSchema,
} from '../lib/schemas.js';
import { isUsableSecret } from '../lib/securityConfig.js';
import { hasCurrentReportAccess, reportAccessMode, type ReportAccessStatus } from '../lib/reportAccess.js';
import {
  evaluateFuturesRisk,
  type FuturesContextInput,
  type FuturesOrderIntentInput,
  type FuturesRiskEnvelope,
  type FuturesRiskPolicy,
} from '../lib/futuresRisk.js';
import { advanceFuturesTradeState, validateFuturesFillChange, type FuturesTradeState } from '../lib/futuresMonitor.js';
import {
  b402IsConfigured,
  buildPaymentRequired,
  reportPriceUsdc,
  verifyAndSettlePayment,
  type SettlementReceipt,
} from '../lib/binanceX402.js';

const PORT = Number.parseInt(process.env.SELLER_PORT ?? '3001', 10);
const SYMBOL = (process.env.TRADE_SYMBOL ?? 'BNBUSDT').toUpperCase();
const FUTURES_SYMBOL = (process.env.FUTURES_SYMBOL ?? 'BTCUSDT').toUpperCase();
const PUBLIC_BASE_URL = process.env.PUBLIC_SELLER_URL ?? `http://localhost:${PORT}`;
const TURNSTILE_SITE_KEY = process.env.SIGNAL402_TURNSTILE_SITE_KEY ?? '';
if (TURNSTILE_SITE_KEY && !/^[A-Za-z0-9_-]{10,200}$/.test(TURNSTILE_SITE_KEY)) throw new Error('SIGNAL402_TURNSTILE_SITE_KEY is invalid');
const ALLOW_PUBLIC_REST_FALLBACK = process.env.ALLOW_PUBLIC_REST_FALLBACK === 'true';
function boundedPolicyEnv(name: string, fallback: number, minimum: number, maximum: number): number {
  const configured = Number.parseFloat(process.env[name] ?? '');
  return Number.isFinite(configured) ? Math.min(Math.max(configured, minimum), maximum) : fallback;
}
const configuredMaxTradeSize = Number.parseFloat(process.env.MAX_TRADE_SIZE_USDT ?? '10');
const MAX_TRADE_SIZE_USDT = Number.isFinite(configuredMaxTradeSize) ? Math.min(Math.max(configuredMaxTradeSize, 0.01), 10) : 10;
const BINANCE_MODE = process.env.SIGNAL402_BINANCE_MODE ?? 'host';
const HOST_TOKEN = process.env.SIGNAL402_HOST_TOKEN;
const ACCESS_MODE = reportAccessMode();
const FREE_ACCESS = ACCESS_MODE === 'free';
const MAX_FUTURES_NOTIONAL_USDT = boundedPolicyEnv('MAX_FUTURES_NOTIONAL_USDT', 10, 0.01, 10);
const MAX_FUTURES_LEVERAGE = boundedPolicyEnv('MAX_FUTURES_LEVERAGE', 3, 1, 3);
const FUTURES_POLICY: FuturesRiskPolicy = {
  maxTotalNotionalUSDT: MAX_FUTURES_NOTIONAL_USDT,
  maxLeverage: MAX_FUTURES_LEVERAGE,
  maxDataAgeMs: boundedPolicyEnv('FUTURES_MAX_DATA_AGE_MS', 15_000, 1, 15_000),
  maxSpreadBps: boundedPolicyEnv('FUTURES_MAX_SPREAD_BPS', 50, 0, 50),
  maxSlippageBps: boundedPolicyEnv('FUTURES_MAX_SLIPPAGE_BPS', 50, 0, 50),
  maxFundingBps: boundedPolicyEnv('FUTURES_MAX_FUNDING_BPS', 5, 0, 5),
  minLiquidationDistancePct: boundedPolicyEnv('FUTURES_MIN_LIQUIDATION_DISTANCE_PCT', 10, 10, 100),
  maxMarginUtilizationPct: boundedPolicyEnv('FUTURES_MAX_MARGIN_UTILIZATION_PCT', 25, 0, 25),
  feeReserveRate: boundedPolicyEnv('FUTURES_FEE_RESERVE_RATE', 0.001, 0, 0.1),
};
const DASHBOARD_AUTH = new DashboardAuth();

type MarketSource = 'MCP' | 'FALLBACK' | 'UNAVAILABLE';
type ProposalStatus = 'idle' | 'pending' | 'approved' | 'refused' | 'filled' | 'cancelled';

type TradeProposal = {
  proposalId: string;
  asset: string;
  side: 'BUY' | 'SELL';
  amountUSDT: number;
  balanceUSDT: number;
  reason: string;
  signalAction?: string;
  signalRisk?: string;
  status: ProposalStatus;
  riskStatus: 'approved' | 'refused' | 'pending';
  paymentReceiptId?: string;
  orderId?: string;
  filledPrice?: number;
  executedQty?: number;
  source?: string;
  mcpToolName?: string;
  beforeBalances?: unknown;
  afterBalances?: unknown;
  updatedAt: string;
};

type FuturesProposal = {
  proposalId: string;
  analysisId: string;
  marketType: 'USD_M' | 'COIN_M';
  strategyMode: 'directional' | 'neutral';
  symbol: string;
  side: 'BUY' | 'SELL';
  positionSide: 'BOTH' | 'LONG' | 'SHORT';
  quantity: number;
  notionalUSDT: number;
  reduceOnly: boolean;
  leverage: number;
  marginMode: 'ISOLATED';
  protectiveStopPrice?: number;
  protectiveStopSupported?: boolean;
  executionConfirmedAt?: string;
  reason: string;
  status: FuturesTradeState;
  riskStatus: 'approved' | 'refused' | 'pending';
  paymentReceiptId?: string;
  riskEnvelope: FuturesRiskEnvelope;
  orderId?: string;
  filledPrice?: number;
  executedQty?: number;
  realizedPnlUSDT?: number;
  source?: string;
  mcpToolName?: string;
  beforeAccountSnapshot?: unknown;
  afterAccountSnapshot?: unknown;
  beforePositionSnapshot?: unknown;
  afterPositionSnapshot?: unknown;
  updatedAt: string;
};

type FuturesEvent = {
  eventType: 'ORDER_TRADE_UPDATE' | 'ACCOUNT_UPDATE' | 'MARGIN_CALL';
  status: Exclude<FuturesTradeState, 'idle' | 'pending' | 'approved'>;
  orderId?: string;
  filledPrice?: number;
  executedQty?: number;
  realizedPnlUSDT?: number;
  source: string;
  mcpToolName: string;
  accountSnapshot?: unknown;
  beforeAccountSnapshot?: unknown;
  afterAccountSnapshot?: unknown;
  positionSnapshot?: unknown;
  beforePositionSnapshot?: unknown;
  afterPositionSnapshot?: unknown;
  observedAt: string;
  reason?: string;
};

type SellerState = {
  service: string;
  symbol: string;
  binanceMode: 'host' | 'direct';
  mcpStatus: 'connecting' | 'live' | 'error';
  mcpTools: string[];
  marketSource: MarketSource;
  ticker?: BinanceTicker;
  marketSignal?: MarketSignal;
  lastError?: string;
  reportsSold: number;
  paymentReceiptId?: string;
  paymentStatus: ReportAccessStatus;
  proposal?: TradeProposal;
  futuresContext?: FuturesContextInput;
  futuresIntent?: FuturesOrderIntentInput;
  futuresRisk?: FuturesRiskEnvelope;
  futuresProposal?: FuturesProposal;
  futuresEvents: FuturesEvent[];
  activity: string[];
  updatedAt: string;
};

const state: SellerState = {
  service: 'Signal402 Seller Agent',
  symbol: SYMBOL,
  binanceMode: BINANCE_MODE === 'direct' ? 'direct' : 'host',
  mcpStatus: 'connecting',
  mcpTools: [],
  marketSource: 'UNAVAILABLE',
  reportsSold: 0,
  paymentStatus: 'waiting',
  futuresEvents: [],
  activity: [],
  updatedAt: new Date().toISOString(),
};

const mcp = new BinanceMcpClient();
const app = express();
configureHttpSecurity(app, PUBLIC_BASE_URL);
const allowedOrigins = new Set((process.env.SIGNAL402_ALLOWED_ORIGINS ?? PUBLIC_BASE_URL).split(',').map((origin) => origin.trim()).filter(Boolean));
app.use(cors({
  origin: (origin, callback) => callback(null, !origin || allowedOrigins.has(origin)),
  credentials: true,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'PAYMENT-SIGNATURE', 'X-PAYMENT-SIGNATURE'],
  exposedHeaders: ['PAYMENT-REQUIRED', 'PAYMENT-RESPONSE', 'X-PAYMENT-REQUIREMENTS'],
}));
app.use(express.json({ limit: '32kb', strict: true }));
app.use('/api/report', createRateLimiter({ windowMs: 60_000, max: 30, message: 'Too many report requests. Try again later.' }));

function hostAuthorized(req: Request): boolean {
  if (!isUsableSecret(HOST_TOKEN)) return false;
  const authorization = req.headers.authorization;
  const expected = Buffer.from(`Bearer ${HOST_TOKEN}`, 'utf8');
  const actual = Buffer.from(typeof authorization === 'string' ? authorization : '', 'utf8');
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function dashboardOrHostAuthorized(req: Request): boolean {
  return hostAuthorized(req) || DASHBOARD_AUTH.isAuthenticated(req);
}

function futuresToolNameAllowed(name: string): boolean {
  const text = name.toLowerCase();
  return /(futures|usd.*m|usdm|um.?futures|coin.*m|coinm|cm.?futures|perpetual|perp|derivative|contract)/.test(text)
    && !/(withdraw|transfer|deposit)/.test(text);
}

function snapshotNotional(snapshot: unknown, symbol: string, markPrice: number): number {
  if (!Array.isArray(snapshot)) return 0;
  return snapshot.reduce((total, item) => {
    if (!item || typeof item !== 'object') return total;
    const record = item as Record<string, unknown>;
    if (`${record.symbol ?? ''}`.toUpperCase() !== symbol.toUpperCase()) return total;
    const notional = Number(record.notionalUSDT);
    if (Number.isFinite(notional) && notional >= 0) return total + Math.abs(notional);
    const quantity = Number(record.positionAmt);
    return Number.isFinite(quantity) ? total + Math.abs(quantity * markPrice) : total;
  }, 0);
}

function snapshotQuantity(snapshot: unknown, symbol: string, positionSide: string): number {
  if (!Array.isArray(snapshot)) return 0;
  const matching = snapshot.find((item) => item && typeof item === 'object'
    && `${(item as Record<string, unknown>).symbol ?? ''}`.toUpperCase() === symbol.toUpperCase()
    && `${(item as Record<string, unknown>).positionSide ?? 'BOTH'}` === positionSide);
  return matching && typeof matching === 'object' && Number.isFinite(Number((matching as Record<string, unknown>).positionAmt))
    ? Math.abs(Number((matching as Record<string, unknown>).positionAmt)) : 0;
}

function touch(message: string): void {
  state.updatedAt = new Date().toISOString();
  state.activity = [`${new Date().toLocaleTimeString()} ${message}`.slice(0, 320), ...state.activity].slice(0, 30);
}

function publicState(): Record<string, unknown> {
  const proposal = state.proposal;
  const futuresContext = state.futuresContext;
  const futuresProposal = state.futuresProposal;
  return {
    service: state.service,
    symbol: state.symbol,
    binanceMode: state.binanceMode,
    mcpStatus: state.mcpStatus,
    mcpTools: state.mcpTools.slice(0, 200),
    marketSource: state.marketSource,
    ticker: state.ticker ? {
      symbol: state.ticker.symbol,
      price: state.ticker.price,
      changePercent: state.ticker.changePercent,
      highPrice: state.ticker.highPrice,
      lowPrice: state.ticker.lowPrice,
      weightedAvgPrice: state.ticker.weightedAvgPrice,
      quoteVolume: state.ticker.quoteVolume,
    } : undefined,
    marketSignal: state.marketSignal,
    reportsSold: state.reportsSold,
    paymentReceiptId: state.paymentReceiptId,
    paymentStatus: state.paymentStatus,
    accessMode: ACCESS_MODE,
    proposal: proposal ? {
      proposalId: proposal.proposalId,
      asset: proposal.asset,
      side: proposal.side,
      amountUSDT: proposal.amountUSDT,
      balanceUSDT: proposal.balanceUSDT,
      reason: proposal.reason,
      signalAction: proposal.signalAction,
      signalRisk: proposal.signalRisk,
      status: proposal.status,
      riskStatus: proposal.riskStatus,
      paymentReceiptId: proposal.paymentReceiptId,
      orderId: proposal.orderId,
      filledPrice: proposal.filledPrice,
      executedQty: proposal.executedQty,
      source: proposal.source,
      mcpToolName: proposal.mcpToolName,
      beforeBalances: proposal.beforeBalances,
      afterBalances: proposal.afterBalances,
      updatedAt: proposal.updatedAt,
    } : undefined,
    futures: {
      context: futuresContext ? {
        marketType: futuresContext.marketType,
        strategyMode: futuresContext.strategyMode,
        symbol: futuresContext.symbol,
        markPrice: futuresContext.markPrice,
        indexPrice: futuresContext.indexPrice,
        bidPrice: futuresContext.bidPrice,
        askPrice: futuresContext.askPrice,
        orderBookDepthUSDT: futuresContext.orderBookDepthUSDT,
        estimatedSlippageBps: futuresContext.estimatedSlippageBps,
        fundingRateBps: futuresContext.fundingRateBps,
        nextFundingTime: futuresContext.nextFundingTime,
        walletBalanceUSDT: futuresContext.walletBalanceUSDT,
        availableBalanceUSDT: futuresContext.availableBalanceUSDT,
        marginBalanceUSDT: futuresContext.marginBalanceUSDT,
        initialMarginUSDT: futuresContext.initialMarginUSDT,
        maintenanceMarginUSDT: futuresContext.maintenanceMarginUSDT,
        openOrderInitialMarginUSDT: futuresContext.openOrderInitialMarginUSDT,
        leverage: futuresContext.leverage,
        marginMode: futuresContext.marginMode,
        positionSide: futuresContext.positionSide,
        liquidationPrice: futuresContext.liquidationPrice,
        projectedLiquidationDistancePct: futuresContext.projectedLiquidationDistancePct,
        exchangeFiltersVerified: futuresContext.exchangeFiltersVerified,
        leverageBracketVerified: futuresContext.leverageBracketVerified,
        orderBookVerified: futuresContext.orderBookVerified,
        positions: futuresContext.positions.map((position) => ({
          symbol: position.symbol,
          positionSide: position.positionSide,
          positionAmt: position.positionAmt,
          entryPrice: position.entryPrice,
          markPrice: position.markPrice,
          liquidationPrice: position.liquidationPrice,
          leverage: position.leverage,
          marginMode: position.marginMode,
          initialMarginUSDT: position.initialMarginUSDT,
          maintenanceMarginUSDT: position.maintenanceMarginUSDT,
          unrealizedPnlUSDT: position.unrealizedPnlUSDT,
          notionalUSDT: position.notionalUSDT,
        })),
        openOrders: futuresContext.openOrders,
        openOrdersNotionalUSDT: futuresContext.openOrdersNotionalUSDT,
        observedAt: futuresContext.observedAt,
        sourceToolNames: futuresContext.sourceToolNames,
      } : undefined,
      intent: state.futuresIntent ? {
        symbol: state.futuresIntent.symbol,
        side: state.futuresIntent.side,
        positionSide: state.futuresIntent.positionSide,
        quantity: state.futuresIntent.quantity,
        notionalUSDT: state.futuresIntent.notionalUSDT,
        reduceOnly: state.futuresIntent.reduceOnly,
        action: state.futuresIntent.action,
        protectiveStopPrice: state.futuresIntent.protectiveStopPrice,
        protectiveStopSupported: state.futuresIntent.protectiveStopSupported,
      } : undefined,
      risk: state.futuresRisk,
      proposal: futuresProposal ? {
        proposalId: futuresProposal.proposalId,
        analysisId: futuresProposal.analysisId,
        marketType: futuresProposal.marketType,
        strategyMode: futuresProposal.strategyMode,
        symbol: futuresProposal.symbol,
        side: futuresProposal.side,
        positionSide: futuresProposal.positionSide,
        quantity: futuresProposal.quantity,
        notionalUSDT: futuresProposal.notionalUSDT,
        reduceOnly: futuresProposal.reduceOnly,
        leverage: futuresProposal.leverage,
        marginMode: futuresProposal.marginMode,
        protectiveStopPrice: futuresProposal.protectiveStopPrice,
        protectiveStopSupported: futuresProposal.protectiveStopSupported,
        executionConfirmedAt: futuresProposal.executionConfirmedAt,
        reason: futuresProposal.reason,
        status: futuresProposal.status,
        riskStatus: futuresProposal.riskStatus,
        paymentReceiptId: futuresProposal.paymentReceiptId,
        orderId: futuresProposal.orderId,
        filledPrice: futuresProposal.filledPrice,
        executedQty: futuresProposal.executedQty,
        realizedPnlUSDT: futuresProposal.realizedPnlUSDT,
        source: futuresProposal.source,
        mcpToolName: futuresProposal.mcpToolName,
        beforeAccountSnapshot: futuresProposal.beforeAccountSnapshot,
        afterAccountSnapshot: futuresProposal.afterAccountSnapshot,
        beforePositionSnapshot: futuresProposal.beforePositionSnapshot,
        afterPositionSnapshot: futuresProposal.afterPositionSnapshot,
        riskEnvelope: futuresProposal.riskEnvelope,
        updatedAt: futuresProposal.updatedAt,
      } : undefined,
      events: state.futuresEvents.slice(0, 50),
    },
    activity: state.activity.slice(0, 30),
    updatedAt: state.updatedAt,
  };
}

async function readPublicRestTicker(): Promise<BinanceTicker> {
  const response = await axios.get('https://api.binance.com/api/v3/ticker/24hr', { params: { symbol: SYMBOL }, timeout: 10_000 });
  const data = response.data as Record<string, unknown>;
  const price = Number.parseFloat(`${data.lastPrice ?? ''}`);
  if (!Number.isFinite(price)) throw new Error('Binance public REST fallback returned no lastPrice');
  return {
    symbol: `${data.symbol ?? SYMBOL}`,
    price,
    changePercent: Number.parseFloat(`${data.priceChangePercent ?? ''}`),
    highPrice: Number.parseFloat(`${data.highPrice ?? ''}`),
    lowPrice: Number.parseFloat(`${data.lowPrice ?? ''}`),
    weightedAvgPrice: Number.parseFloat(`${data.weightedAvgPrice ?? ''}`),
    volume: Number.parseFloat(`${data.volume ?? ''}`),
    quoteVolume: Number.parseFloat(`${data.quoteVolume ?? ''}`),
    raw: data,
  };
}

function updateMarketSignal(ticker: BinanceTicker): void {
  state.marketSignal = deriveMarketSignal(ticker);
}

async function refreshMarketData(): Promise<void> {
  if (BINANCE_MODE !== 'direct') {
    if (state.marketSource === 'MCP') return;
    if (!ALLOW_PUBLIC_REST_FALLBACK) {
      state.mcpStatus = 'connecting';
      state.marketSource = 'UNAVAILABLE';
      touch('Waiting for the supported Binance MCP host to publish live market data.');
      return;
    }
    try {
      const ticker = await readPublicRestTicker();
      state.mcpStatus = 'error';
      state.marketSource = 'FALLBACK';
      state.ticker = ticker;
      updateMarketSignal(ticker);
      touch(`FALLBACK market data live ${ticker.symbol} ${ticker.price}`);
      await audit('seller.market.read', { source: 'FALLBACK', symbol: ticker.symbol, price: ticker.price, reason: 'Supported Binance MCP host has not published data yet' });
    } catch {
      state.mcpStatus = 'connecting';
      state.marketSource = 'UNAVAILABLE';
      touch('Waiting for MCP data. Public REST fallback failed.');
    }
    return;
  }
  state.mcpStatus = 'connecting';
  try {
    const ticker = await mcp.getTicker(SYMBOL);
    state.mcpStatus = 'live';
    state.mcpTools = mcp.toolNames;
    state.marketSource = 'MCP';
    state.ticker = ticker;
    updateMarketSignal(ticker);
    state.lastError = undefined;
    touch(`MCP market data live ${ticker.symbol} ${ticker.price}`);
    await audit('seller.market.read', { source: 'MCP', symbol: ticker.symbol, price: ticker.price });
  } catch {
    state.mcpStatus = 'error';
    state.lastError = 'MCP market data unavailable';
    state.mcpTools = mcp.toolNames;
    if (!ALLOW_PUBLIC_REST_FALLBACK) {
      state.marketSource = 'UNAVAILABLE';
      touch('MCP market data unavailable. REST fallback is disabled.');
      await audit('seller.market.error', { source: 'MCP', error: state.lastError });
      return;
    }
    try {
      const ticker = await readPublicRestTicker();
      state.marketSource = 'FALLBACK';
      state.ticker = ticker;
      updateMarketSignal(ticker);
      touch(`FALLBACK market data live ${ticker.symbol} ${ticker.price}`);
      await audit('seller.market.read', { source: 'FALLBACK', symbol: ticker.symbol, price: ticker.price, reason: state.lastError });
    } catch {
      state.marketSource = 'UNAVAILABLE';
      state.lastError = 'MCP and public REST market data unavailable';
      touch('MCP and REST fallback market data unavailable.');
      await audit('seller.market.error', { source: 'MCP_AND_REST', error: state.lastError });
    }
  }
}

function futuresBriefing(): string {
  const context = state.futuresContext;
  const risk = state.futuresRisk;
  if (!context || !risk) throw new Error('No live Futures risk context is available');
  return [
    'SIGNAL402 VERIFIED BINANCE FUTURES INTELLIGENCE',
    '===============================================',
    `CONTRACT: ${context.marketType}`,
    `STRATEGY: ${context.strategyMode}`,
    `SYMBOL: ${context.symbol}`,
    `MARK PRICE: ${context.markPrice.toFixed(8)}`,
    `SPREAD: ${risk.spreadBps === null ? 'unavailable' : `${risk.spreadBps.toFixed(2)} bps`}`,
    `ESTIMATED SLIPPAGE: ${risk.slippageBps === null ? 'unavailable' : `${risk.slippageBps.toFixed(2)} bps`}`,
    `FUNDING: ${risk.fundingRateBps === null ? 'unavailable' : `${risk.fundingRateBps.toFixed(2)} bps per interval`}`,
    `LIQUIDATION DISTANCE: ${risk.liquidationDistancePct === null ? 'unavailable' : `${risk.liquidationDistancePct.toFixed(2)}%`}`,
    `MARGIN: ${context.marginMode} · ${context.availableBalanceUSDT.toFixed(4)} USDT available · ${risk.marginUtilizationPct.toFixed(2)}% projected utilization`,
    `LEVERAGE: ${context.leverage.toFixed(2)}x`,
    `DECISION: ${risk.action}`,
    `RISK ZONE: ${risk.riskZone}`,
    `EXECUTION: ${risk.executionEligible ? 'ELIGIBLE' : 'NOT ELIGIBLE'}`,
    `HEDGE RATIO: ${risk.hedgeRatio === null ? 'not applicable' : risk.hedgeRatio.toFixed(4)}`,
    `ANALYSIS ID: ${risk.analysisId}`,
    `INPUT HASH: ${risk.inputHash}`,
    `OUTPUT HASH: ${risk.outputHash}`,
    `DATA SOURCE TOOLS: ${context.sourceToolNames.join(', ')}`,
    `OBSERVED AT: ${context.observedAt}`,
    '',
    risk.reasons.length ? `REFUSAL REASONS: ${risk.reasons.join(' ')}` : 'RISK GATE: all required live checks passed.',
    'This is a deterministic risk estimate, not a guaranteed loss limit. Directional USD M execution still requires a fresh read, dashboard APPROVE, and the exact CONFIRM step. Neutral and COIN M paths are report only.',
  ].join('\n');
}

function briefing(): string {
  if (state.futuresRisk && state.futuresContext) return futuresBriefing();
  if (!state.ticker) throw new Error('No live market data is available');
  const signal = state.marketSignal ?? deriveMarketSignal(state.ticker);
  const change = state.ticker.changePercent;
  const sourceLabel = state.marketSource === 'MCP' ? 'Binance Agentic MCP' : 'PUBLIC REST FALLBACK';
  return [
    'SIGNAL402 VERIFIED MARKET INTELLIGENCE',
    '======================================',
    `ASSET: ${state.ticker.symbol}`,
    `PRICE: ${state.ticker.price.toFixed(8)} USDT`,
    `24H CHANGE: ${change !== undefined && Number.isFinite(change) ? `${change.toFixed(2)}%` : 'unavailable'}`,
    `24H RANGE: ${signal.rangePercent === undefined ? 'unavailable' : `${signal.rangePercent.toFixed(2)}%`}`,
    `QUOTE VOLUME: ${state.ticker.quoteVolume === undefined || !Number.isFinite(state.ticker.quoteVolume) ? 'unavailable' : `${state.ticker.quoteVolume.toFixed(2)} USDT`}`,
    `DIRECTION: ${signal.direction}`,
    `RISK TIER: ${signal.risk}`,
    `CONFIDENCE: ${signal.confidence}`,
    `RULE ACTION: ${signal.action}`,
    `THESIS: ${signal.rationale}`,
    `INVALIDATION: ${signal.invalidation}`,
    `DATA SOURCE: ${sourceLabel}`,
    `OBSERVED AT: ${new Date().toISOString()}`,
    '',
    'SAFETY:',
    'This is an explainable screening result, not a profit guarantee. A BUY_SMALL result still requires a live balance check and human approval. A WAIT result blocks order creation.',
  ].join('\n');
}

function paymentHeader(req: Request): string | undefined {
  const value = req.headers['payment-signature'] ?? req.headers['x-payment-signature'];
  return typeof value === 'string' ? value : undefined;
}

function reportAccessIsCurrent(providedReceipt?: string): boolean {
  return hasCurrentReportAccess({
    mode: ACCESS_MODE,
    status: state.paymentStatus,
    currentReceipt: state.paymentReceiptId,
    providedReceipt,
  });
}

function reportAccessError(scope: 'Spot' | 'Futures'): string {
  return FREE_ACCESS
    ? `A free briefing must be requested before the ${scope} proposal`
    : `A ${scope} proposal requires the current real B402 settlement receipt`;
}

function sendPaymentChallenge(res: Response, required: Awaited<ReturnType<typeof buildPaymentRequired>>): void {
  const encoded = required.headerValue;
  res.setHeader('PAYMENT-REQUIRED', encoded);
  res.setHeader('X-PAYMENT-REQUIREMENTS', encoded);
  res.setHeader('Cache-Control', 'no-store');
  res.status(402).json(required.body);
}

function receiptHeader(receipt: SettlementReceipt): string {
  return Buffer.from(JSON.stringify({
    success: true,
    txHash: receipt.transaction,
    transaction: receipt.transaction,
    payer: receipt.payer,
    network: receipt.network,
    amount: receipt.amount,
  }), 'utf8').toString('base64');
}

async function deliverFreeBriefing(res: Response): Promise<void> {
  if (!state.futuresRisk && !state.ticker) await refreshMarketData();
  if (!state.futuresRisk && !state.ticker) {
    state.lastError = 'No live market data is available';
    state.paymentStatus = 'error';
    touch('Free briefing refused because no live market data is available.');
    await audit('seller.briefing.refused', { accessMode: 'free', error: state.lastError });
    res.status(503).json({ success: false, error: state.lastError, accessMode: 'free' });
    return;
  }
  const text = briefing();
  state.reportsSold += 1;
  state.paymentReceiptId = undefined;
  state.paymentStatus = 'free';
  const message = 'Free briefing delivered. No payment was requested or recorded.';
  touch(message);
  await audit('seller.briefing.delivered', {
    accessMode: 'free',
    source: state.marketSource,
    symbol: state.symbol,
  });
  res.setHeader('Cache-Control', 'no-store');
  res.json({
    success: true,
    accessMode: 'free',
    briefing: text,
    paymentReceiptId: null,
    payment: null,
    marketSource: state.marketSource,
  });
}

app.get('/', (_req, res) => {
  const nonce = dashboardCspNonce(res);
  const turnstileScript = TURNSTILE_SITE_KEY ? `<script nonce="${nonce}" src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>` : '';
  const turnstileWidget = TURNSTILE_SITE_KEY ? `<div class="cf-turnstile mt-4" data-sitekey="${TURNSTILE_SITE_KEY}" data-callback="signal402Turnstile"></div>` : '';
  res.type('html').send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Signal402 Agent OS</title><script nonce="${nonce}" src="https://cdn.tailwindcss.com"></script>
<script nonce="${nonce}">tailwind.config={theme:{extend:{colors:{ink:'#070b14',panel:'#0d1422',line:'#1d2a3d',cyan:'#67e8f9',lime:'#bef264'}}}}</script>
${turnstileScript}
<style>body{background:#070b14;color:#e5edf7;font-family:Inter,ui-sans-serif,system-ui}.glow{box-shadow:0 0 36px rgba(34,211,238,.10)}.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}</style></head>
<body><div id="loginPanel" class="fixed inset-0 z-50 flex items-center justify-center bg-ink/95 px-5"><form id="loginForm" class="w-full max-w-sm rounded-2xl border border-line bg-panel p-6 shadow-2xl"><p class="text-xs uppercase tracking-[.24em] text-cyan">Signal402 dashboard</p><h2 class="mt-3 text-2xl font-semibold">Sign in to approve trades</h2><p class="mt-3 text-sm leading-6 text-slate-400">The dashboard can show public market status, but order approval requires a server side session.</p><label class="mt-5 block text-sm text-slate-300" for="password">Dashboard password</label><input id="password" name="password" type="password" autocomplete="current-password" required maxlength="256" class="mt-2 w-full rounded-lg border border-line bg-ink px-3 py-3 text-sm text-white outline-none focus:border-cyan"><input id="turnstileToken" name="turnstileToken" type="hidden"><input name="website" type="text" tabindex="-1" autocomplete="off" class="hidden">${turnstileWidget}<button class="mt-5 w-full rounded-xl bg-cyan px-4 py-3 text-sm font-bold text-ink">SIGN IN</button><p id="loginError" class="mt-3 min-h-5 text-sm text-rose-300" role="alert"></p></form></div><main class="mx-auto min-h-screen max-w-7xl px-5 py-8 lg:px-10">
<header class="mb-8 flex flex-col gap-5 border-b border-line pb-6 sm:flex-row sm:items-end sm:justify-between">
<div><div class="mb-2 flex items-center gap-3"><span class="rounded-full border border-cyan/30 bg-cyan/10 px-3 py-1 text-xs font-bold tracking-[.25em] text-cyan">SIGNAL402</span><span class="text-xs uppercase tracking-[.22em] text-slate-500">Binance Agent OS</span></div><h1 class="text-3xl font-semibold tracking-tight sm:text-5xl">Agent-to-agent market intelligence</h1><p class="mt-3 max-w-2xl text-sm leading-6 text-slate-400">A live Seller Agent publishes ${FREE_ACCESS ? 'free' : 'paid'} Spot or Futures intelligence. Directional USD M orders pass a deterministic risk gate, dashboard approval, and a final CONFIRM step. Neutral and COIN M paths are report only.</p></div>
<div class="flex flex-wrap gap-2 text-xs font-semibold"><span id="mcpBadge" class="rounded-full border border-slate-700 bg-slate-900 px-3 py-2 text-slate-300">MCP: CONNECTING</span><span id="sourceBadge" class="rounded-full border border-slate-700 bg-slate-900 px-3 py-2 text-slate-300">DATA: WAITING</span><span id="paymentModeBadge" class="rounded-full border ${FREE_ACCESS ? 'border-amber-500/40 bg-amber-500/10 text-amber-300' : 'border-cyan/30 bg-cyan/10 text-cyan'} px-3 py-2">${FREE_ACCESS ? 'ACCESS: FREE' : 'PAYMENT: B402'}</span><span class="rounded-full border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-rose-300">WITHDRAWAL: NEVER</span><button id="logout" class="rounded-full border border-slate-700 bg-slate-900 px-3 py-2 text-slate-300">SIGN OUT</button></div>
</header>
<section class="grid gap-5 lg:grid-cols-[1.1fr_.9fr]">
<article class="glow rounded-2xl border border-line bg-panel p-6"><div class="mb-5 flex items-center justify-between"><div><p class="text-xs uppercase tracking-[.24em] text-cyan">Seller Agent</p><h2 class="mt-2 text-2xl font-semibold">Analyst Agent</h2></div><span class="rounded-lg border border-cyan/20 bg-cyan/10 px-3 py-2 text-xs text-cyan">LIVE FEED</span></div><div class="grid gap-4 sm:grid-cols-3"><div class="rounded-xl border border-line bg-ink p-4"><p class="text-xs text-slate-500">Pair</p><p id="pair" class="mt-2 text-xl font-semibold">${SYMBOL}</p></div><div class="rounded-xl border border-line bg-ink p-4"><p class="text-xs text-slate-500">Last price</p><p id="price" class="mt-2 text-xl font-semibold text-lime">Waiting</p></div><div class="rounded-xl border border-line bg-ink p-4"><p class="text-xs text-slate-500">24h change</p><p id="change" class="mt-2 text-xl font-semibold">Waiting</p></div></div><div class="mt-5 rounded-xl border border-line bg-ink p-4"><div class="flex items-center justify-between"><span class="text-xs uppercase tracking-[.18em] text-slate-500">Verified intelligence</span><span id="signalAction" class="rounded-full border border-slate-700 bg-slate-900 px-3 py-1 text-xs text-slate-300">WAITING</span></div><div class="mt-4 grid gap-3 sm:grid-cols-3 text-sm"><div><p class="text-xs text-slate-500">Direction</p><p id="signalDirection" class="mt-1 font-semibold">Waiting</p></div><div><p class="text-xs text-slate-500">Risk tier</p><p id="signalRisk" class="mt-1 font-semibold">Waiting</p></div><div><p class="text-xs text-slate-500">Confidence</p><p id="signalConfidence" class="mt-1 font-semibold">Waiting</p></div></div><p id="signalRationale" class="mt-4 text-sm leading-6 text-slate-400">${FREE_ACCESS ? 'Free access is enabled. No B402 payment is requested or recorded.' : 'The paid report combines live Binance data with an explainable screening rule.'}</p></div><div class="mt-5 rounded-xl border border-line bg-ink p-4"><div class="flex items-center justify-between"><span class="text-xs uppercase tracking-[.18em] text-slate-500">${FREE_ACCESS ? 'Free briefing' : 'Research paywall'}</span><span id="paymentPrice" class="text-sm font-semibold ${FREE_ACCESS ? 'text-amber-300' : 'text-cyan'}">${FREE_ACCESS ? 'FREE' : '0.01 USDC'}</span></div><p class="mt-3 text-sm leading-6 text-slate-400">${FREE_ACCESS ? 'Temporary free access. No payment was requested. Real Binance data and trade safety checks remain active.' : 'Real Binance B402 v2 settlement. The briefing is withheld until verification and on-chain settlement succeed.'}</p><p id="paymentReceipt" class="mt-3 break-all font-mono text-xs text-slate-500">${FREE_ACCESS ? 'Access: FREE · no payment requested' : 'Receipt: waiting'}</p></div></article>
<article class="glow rounded-2xl border border-line bg-panel p-6"><div class="mb-5 flex items-center justify-between"><div><p class="text-xs uppercase tracking-[.24em] text-lime">Buyer Agent</p><h2 class="mt-2 text-2xl font-semibold">Trader Agent</h2></div><span class="rounded-lg border border-lime/20 bg-lime/10 px-3 py-2 text-xs text-lime">HUMAN GATE</span></div><div class="rounded-xl border border-line bg-ink p-5"><div class="flex items-center justify-between"><span class="text-xs uppercase tracking-[.18em] text-slate-500">Risk Guardian</span><span id="riskBadge" class="rounded-full border border-slate-700 bg-slate-900 px-3 py-1 text-xs text-slate-400">idle</span></div><p id="riskReason" class="mt-4 text-sm leading-6 text-slate-400">Waiting for a buyer proposal backed by a live balance read.</p><div class="mt-5 grid gap-3 text-sm sm:grid-cols-3"><div><p class="text-xs text-slate-500">Proposed size</p><p id="tradeSize" class="mt-1 font-semibold">Waiting</p></div><div><p class="text-xs text-slate-500">USDT before</p><p id="balance" class="mt-1 font-semibold">Waiting</p></div><div><p class="text-xs text-slate-500">USDT after</p><p id="balanceAfter" class="mt-1 font-semibold">Waiting</p></div></div><button id="approve" class="mt-6 hidden w-full rounded-xl bg-lime px-4 py-3 text-sm font-bold text-ink transition hover:bg-lime/80">APPROVE</button><p id="order" class="mt-4 break-all font-mono text-xs text-slate-500">Order: waiting</p></div></article>
</section>
<section class="mt-5 grid gap-5 lg:grid-cols-[1.1fr_.9fr]"><article class="glow rounded-2xl border border-line bg-panel p-6"><div class="flex items-center justify-between"><div><p class="text-xs uppercase tracking-[.24em] text-cyan">Futures risk gate</p><h2 class="mt-2 text-2xl font-semibold">USDⓈ M and COIN M analysis</h2></div><span id="futuresMcpBadge" class="rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-xs text-slate-400">MCP: WAITING</span></div><div class="mt-5 grid gap-3 sm:grid-cols-3"><div class="rounded-xl border border-line bg-ink p-4"><p class="text-xs text-slate-500">Contract</p><p id="futuresContract" class="mt-1 font-semibold">Waiting</p></div><div class="rounded-xl border border-line bg-ink p-4"><p class="text-xs text-slate-500">Strategy</p><p id="futuresStrategy" class="mt-1 font-semibold">Waiting</p></div><div class="rounded-xl border border-line bg-ink p-4"><p class="text-xs text-slate-500">Decision</p><p id="futuresDecision" class="mt-1 font-semibold">Waiting</p></div></div><div class="mt-4 grid gap-3 text-sm sm:grid-cols-3"><div><p class="text-xs text-slate-500">Risk zone</p><p id="futuresRiskZone" class="mt-1 font-semibold">Waiting</p></div><div><p class="text-xs text-slate-500">Eligibility</p><p id="futuresEligibility" class="mt-1 font-semibold">Waiting</p></div><div><p class="text-xs text-slate-500">Leverage / margin</p><p id="futuresLeverage" class="mt-1 font-semibold">Waiting</p></div><div><p class="text-xs text-slate-500">Available margin</p><p id="futuresAvailable" class="mt-1 font-semibold">Waiting</p></div><div><p class="text-xs text-slate-500">Maintenance margin</p><p id="futuresMaintenance" class="mt-1 font-semibold">Waiting</p></div><div><p class="text-xs text-slate-500">Funding</p><p id="futuresFunding" class="mt-1 font-semibold">Waiting</p></div><div><p class="text-xs text-slate-500">Spread / slippage</p><p id="futuresSpread" class="mt-1 font-semibold">Waiting</p></div><div><p class="text-xs text-slate-500">Liquidation distance</p><p id="futuresLiquidation" class="mt-1 font-semibold">Waiting</p></div><div><p class="text-xs text-slate-500">Hedge ratio</p><p id="futuresHedge" class="mt-1 font-semibold">Not applicable</p></div></div><p id="futuresReasons" class="mt-5 rounded-xl border border-line bg-ink p-4 text-sm leading-6 text-slate-400">Waiting for strict live Futures context.</p><p id="futuresPaymentReceipt" class="mt-4 break-all font-mono text-xs text-slate-500">${FREE_ACCESS ? 'Access: FREE · no payment requested' : 'Payment receipt: waiting'}</p></article><article class="glow rounded-2xl border border-line bg-panel p-6"><div class="flex items-center justify-between"><div><p class="text-xs uppercase tracking-[.24em] text-lime">Futures execution</p><h2 class="mt-2 text-2xl font-semibold">Approval and event trail</h2></div><span id="futuresApprovalState" class="rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-xs text-slate-400">REPORT ONLY</span></div><p id="futuresOrder" class="mt-5 break-all font-mono text-xs text-slate-500">Order: waiting</p><p id="futuresBalances" class="mt-3 text-sm text-slate-400">Futures balances before and after: waiting</p><button id="approveFutures" class="mt-6 hidden w-full rounded-xl bg-lime px-4 py-3 text-sm font-bold text-ink transition hover:bg-lime/80">APPROVE FUTURES ORDER</button><p id="futuresConfirm" class="mt-4 text-sm leading-6 text-slate-400">Directional USD M execution also requires the host to ask for CONFIRM after this approval.</p><div class="mt-6"><p class="text-xs uppercase tracking-[.18em] text-slate-500">Futures event timeline</p><div id="futuresEvents" class="mono mt-3 max-h-64 space-y-2 overflow-auto text-xs leading-5 text-slate-400"><p>Waiting for authenticated Futures events.</p></div></div></article></section>
<section class="mt-5 grid gap-5 lg:grid-cols-[.8fr_1.2fr]"><article class="rounded-2xl border border-line bg-panel p-6"><p class="text-xs uppercase tracking-[.24em] text-slate-500">Safety model</p><div class="mt-4 space-y-3 text-sm text-slate-300"><p>✓ Supported host mode keeps Binance OAuth outside Signal402.</p><p>✓ Direct OAuth is disabled unless Binance approves this client.</p><p>✓ No withdrawal scope exists in Binance Agent OS.</p><p>✓ Every Spot or Futures order requires human approval.</p><p>✓ Combined Futures notional is capped at 10 USDT and leverage at 3x.</p><p>✓ Futures use isolated margin only. Signal402 never changes leverage or margin mode.</p><p>✓ Neutral and COIN M Futures paths are report only.</p><p>✓ Every action is appended to a local JSONL audit log.</p></div></article><article class="rounded-2xl border border-line bg-panel p-6"><div class="flex items-center justify-between"><p class="text-xs uppercase tracking-[.24em] text-slate-500">Agent activity</p><span id="updated" class="font-mono text-xs text-slate-600">waiting</span></div><div id="activity" class="mono mt-4 max-h-56 space-y-2 overflow-auto text-xs leading-5 text-slate-400"><p>Waiting for the Seller Agent.</p></div></article></section>
</main><script nonce="${nonce}">
const set=(id,value)=>{const el=document.getElementById(id);if(el)el.textContent=value};
const usdt=(balances)=>{const b=Array.isArray(balances)?balances.find((x)=>String(x?.asset??'').toUpperCase()==='USDT'):null;return b&&Number.isFinite(Number(b.free))?Number(b.free):undefined};
const loginPanel=document.getElementById('loginPanel');const loginError=document.getElementById('loginError');const showLogin=(show)=>loginPanel.classList.toggle('hidden',!show);window.signal402Turnstile=(token)=>{const field=document.getElementById('turnstileToken');if(field)field.value=token};
async function login(event){event.preventDefault();loginError.textContent='';const form=new FormData(event.currentTarget);const response=await fetch('/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},credentials:'same-origin',body:JSON.stringify({password:form.get('password'),website:form.get('website'),turnstileToken:form.get('turnstileToken')||undefined})});const data=await response.json().catch(()=>({}));if(!response.ok){loginError.textContent=data.error||'Login failed';return}event.currentTarget.reset();showLogin(false);await update()}
async function logout(){await fetch('/api/auth/logout',{method:'POST',credentials:'same-origin'});showLogin(true)}
function renderActivity(items){const target=document.getElementById('activity');target.replaceChildren(...(Array.isArray(items)?items:[]).map((item)=>{const p=document.createElement('p');p.textContent=String(item??'');return p}));if(!target.childElementCount){const p=document.createElement('p');p.textContent='Waiting for the Seller Agent.';target.appendChild(p)}}
async function approve(id){const button=document.getElementById('approve');button.disabled=true;button.textContent='APPROVING';const response=await fetch('/api/trade/approve',{method:'POST',headers:{'content-type':'application/json'},credentials:'same-origin',body:JSON.stringify({proposalId:id})});if(response.status===401){showLogin(true);return}await update()}
async function approveFutures(id){const button=document.getElementById('approveFutures');button.disabled=true;button.textContent='APPROVING';const response=await fetch('/api/futures/approve',{method:'POST',headers:{'content-type':'application/json'},credentials:'same-origin',body:JSON.stringify({proposalId:id})});if(response.status===401){showLogin(true);return}await update()}
async function update(){try{const response=await fetch('/api/state',{cache:'no-store',credentials:'same-origin'});if(response.status===401){showLogin(true);return}if(!response.ok)throw new Error('Dashboard state unavailable');const s=await response.json();showLogin(false);set('mcpBadge',s.mcpStatus==='live'?'MCP: LIVE':s.marketSource==='FALLBACK'?'MCP: FALLBACK':s.mcpStatus==='error'?'MCP: ERROR':'MCP: CONNECTING');set('sourceBadge',s.marketSource==='MCP'?'DATA: MCP LIVE':s.marketSource==='FALLBACK'?'DATA: FALLBACK':'DATA: WAITING');set('paymentModeBadge',s.accessMode==='free'?'ACCESS: FREE':'PAYMENT: B402');if(s.ticker){set('pair',s.ticker.symbol);set('price',Number(s.ticker.price).toFixed(8)+' USDT');set('change',Number.isFinite(Number(s.ticker.changePercent))?Number(s.ticker.changePercent).toFixed(2)+'%':'Unavailable')}const signal=s.marketSignal;if(signal){const action=document.getElementById('signalAction');set('signalAction',signal.action);action.className='rounded-full border px-3 py-1 text-xs '+(signal.action==='BUY_SMALL'?'border-lime/40 bg-lime/10 text-lime':'border-rose-500/40 bg-rose-500/10 text-rose-300');set('signalDirection',signal.direction);set('signalRisk',signal.risk);set('signalConfidence',signal.confidence);set('signalRationale',signal.rationale)}set('paymentReceipt',s.accessMode==='free'?'Access: FREE · no payment requested':s.paymentReceiptId?'Receipt: '+s.paymentReceiptId:'Receipt: waiting');set('updated',new Date(s.updatedAt).toLocaleTimeString());const p=s.proposal;const badge=document.getElementById('riskBadge');const button=document.getElementById('approve');if(p){set('riskBadge',p.status==='refused'?'RISK GUARDIAN: refused':p.status==='filled'?'TRADE FILLED':p.status==='approved'?'APPROVED':p.status.toUpperCase());badge.className='rounded-full border px-3 py-1 text-xs '+(p.status==='refused'?'border-rose-500/40 bg-rose-500/10 text-rose-300':p.status==='filled'?'border-lime/40 bg-lime/10 text-lime':'border-cyan/40 bg-cyan/10 text-cyan');set('riskReason',p.reason);set('tradeSize',Number(p.amountUSDT).toFixed(2)+' USDT');const beforeUsdt=usdt(p.beforeBalances);const afterUsdt=usdt(p.afterBalances);set('balance',(beforeUsdt===undefined?Number(p.balanceUSDT).toFixed(2):beforeUsdt.toFixed(8))+' USDT');set('balanceAfter',afterUsdt===undefined?'Waiting':afterUsdt.toFixed(8)+' USDT');set('order',p.orderId?'Order: '+p.orderId+(p.filledPrice?' · filled price '+Number(p.filledPrice).toFixed(8):''):'Order: waiting');if(p.status==='pending'){button.classList.remove('hidden');button.disabled=false;button.textContent='APPROVE';button.onclick=()=>approve(p.proposalId)}else{button.classList.add('hidden')}}else{button.classList.add('hidden')};const f=s.futures||{};const fc=f.context;const fr=f.risk;const fp=f.proposal;set('futuresMcpBadge',fc?'MCP: LIVE':'MCP: WAITING');if(fc){set('futuresContract',String(fc.marketType||'Unknown'));set('futuresStrategy',String(fc.strategyMode||'Unknown'));set('futuresLeverage',Number(fc.leverage).toFixed(2)+'x / '+String(fc.marginMode||'Unknown'));set('futuresAvailable',Number(fc.availableBalanceUSDT).toFixed(4)+' USDT');set('futuresMaintenance',Number(fc.maintenanceMarginUSDT).toFixed(4)+' USDT');set('futuresFunding',fr&&fr.fundingRateBps!==null?Number(fr.fundingRateBps).toFixed(2)+' bps':'Unavailable');set('futuresSpread',fr&&fr.spreadBps!==null?Number(fr.spreadBps).toFixed(2)+' / '+Number(fr.slippageBps).toFixed(2)+' bps':'Unavailable');set('futuresLiquidation',fr&&fr.liquidationDistancePct!==null?Number(fr.liquidationDistancePct).toFixed(2)+'%':'Unavailable');set('futuresHedge',fr&&fr.hedgeRatio!==null?Number(fr.hedgeRatio).toFixed(4):'Not applicable')}else{['futuresContract','futuresStrategy','futuresDecision','futuresRiskZone','futuresEligibility','futuresLeverage','futuresAvailable','futuresMaintenance','futuresFunding','futuresSpread','futuresLiquidation'].forEach((id)=>set(id,'Waiting'));set('futuresHedge','Not applicable')}if(fr){set('futuresDecision',fr.action);set('futuresRiskZone',fr.riskZone);set('futuresEligibility',fr.executionEligible?'ELIGIBLE':'REPORT ONLY / BLOCKED');set('futuresReasons',fr.reasons&&fr.reasons.length?fr.reasons.join(' '):'All strict live Futures checks passed.');set('futuresPaymentReceipt',s.accessMode==='free'?'Access: FREE · no payment requested':s.paymentReceiptId?'Payment receipt: '+s.paymentReceiptId:'Payment receipt: waiting')}else{set('futuresReasons','Waiting for strict live Futures context.');set('futuresPaymentReceipt',s.accessMode==='free'?'Access: FREE · no payment requested':s.paymentReceiptId?'Payment receipt: '+s.paymentReceiptId:'Payment receipt: waiting')}const futuresButton=document.getElementById('approveFutures');if(fp){const reportOnly=fp.marketType!=='USD_M'||fp.strategyMode!=='directional'||(fr&&!fr.executionEligible);set('futuresApprovalState',fp.status==='filled'?'FILLED':fp.status==='approved'?'APPROVED · CONFIRM REQUIRED':fp.status==='pending'?'WAITING APPROVAL':fp.status.toUpperCase());set('futuresOrder',fp.orderId?'Order: '+fp.orderId+(fp.filledPrice?' · fill '+Number(fp.filledPrice).toFixed(8)+' · qty '+Number(fp.executedQty||0).toFixed(8):''):'Order: waiting');set('futuresConfirm',reportOnly?'REPORT ONLY. No approval button and no order write is permitted.':'Dashboard approval is recorded. The host must still require CONFIRM before one live USD M order.');if(fp.status==='pending'&&!reportOnly){futuresButton.classList.remove('hidden');futuresButton.disabled=false;futuresButton.textContent='APPROVE FUTURES ORDER';futuresButton.onclick=()=>approveFutures(fp.proposalId)}else{futuresButton.classList.add('hidden')}}else{futuresButton.classList.add('hidden');set('futuresApprovalState',fr&&fr.reportOnly?'REPORT ONLY':'WAITING');set('futuresOrder','Order: waiting')}const beforeAccount=fp&&fp.beforeAccountSnapshot;const afterAccount=fp&&fp.afterAccountSnapshot;if(beforeAccount&&afterAccount){set('futuresBalances','Wallet before '+Number(beforeAccount.walletBalanceUSDT).toFixed(8)+' USDT · after '+Number(afterAccount.walletBalanceUSDT).toFixed(8)+' USDT · available after '+Number(afterAccount.availableBalanceUSDT).toFixed(8)+' USDT')}else{set('futuresBalances','Futures balances before and after: waiting')};const eventTarget=document.getElementById('futuresEvents');eventTarget.replaceChildren(...(Array.isArray(f.events)?f.events:[]).map((event)=>{const p=document.createElement('p');p.textContent=String(event.observedAt||'')+' · '+String(event.eventType||'')+' · '+String(event.status||'')+(event.orderId?' · '+String(event.orderId):'');return p}));if(!eventTarget.childElementCount){const p=document.createElement('p');p.textContent='Waiting for authenticated Futures events.';eventTarget.appendChild(p)}renderActivity(s.activity)}catch(e){console.error(e)}}
document.getElementById('loginForm').addEventListener('submit',login);document.getElementById('logout').addEventListener('click',logout);showLogin(true);update();setInterval(update,1500);
</script></body></html>`);
});

app.get('/api/auth/status', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json(DASHBOARD_AUTH.status());
});

app.get('/api/auth/me', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!DASHBOARD_AUTH.isAuthenticated(req)) {
    res.status(401).json({ authenticated: false });
    return;
  }
  res.json({ authenticated: true });
});

app.post('/api/auth/login', async (req, res) => {
  const parsed = parseBody(dashboardLoginSchema, req.body);
  if (!parsed.data) {
    res.status(400).json({ success: false, error: 'Invalid login payload' });
    return;
  }
  const result = await DASHBOARD_AUTH.login(req.ip ?? 'unknown', parsed.data.password, parsed.data.website, parsed.data.turnstileToken);
  if (!result.ok) {
    if (result.retryAfterSeconds) res.setHeader('Retry-After', String(result.retryAfterSeconds));
    await audit('dashboard.login.failed', { ip: req.ip ?? 'unknown', status: result.status });
    res.status(result.status).json({ success: false, error: result.message });
    return;
  }
  DASHBOARD_AUTH.setCookie(res, result.token);
  await audit('dashboard.login.succeeded', { ip: req.ip ?? 'unknown' });
  res.setHeader('Cache-Control', 'no-store');
  res.json({ success: true });
});

app.post('/api/auth/logout', (req, res) => {
  DASHBOARD_AUTH.clearCookie(res);
  res.setHeader('Cache-Control', 'no-store');
  res.json({ success: true });
});

app.get('/api/state', (req, res) => {
  if (!dashboardOrHostAuthorized(req)) {
    res.status(401).json({ success: false, error: 'Dashboard login or host authorization required' });
    return;
  }
  res.setHeader('Cache-Control', 'no-store');
  res.json(publicState());
});

app.get('/api/health', (_req, res) => res.json({ ok: true, mcp: state.mcpStatus === 'live', marketSource: state.marketSource, binanceMode: state.binanceMode }));

app.post('/api/host/market', async (req, res) => {
  if (!hostAuthorized(req)) {
    res.status(401).json({ success: false, error: 'Supported Binance MCP host authorization is missing' });
    return;
  }
  const parsed = parseBody(hostMarketSchema, req.body);
  if (!parsed.data) {
    res.status(400).json({ success: false, error: 'Invalid host market payload' });
    return;
  }
  const symbol = parsed.data.symbol.toUpperCase();
  const { price, changePercent, highPrice, lowPrice, weightedAvgPrice, volume, quoteVolume, toolNames, observedAt } = parsed.data;
  if (symbol !== SYMBOL) {
    res.status(400).json({ success: false, error: 'Host market symbol does not match the configured trade symbol' });
    return;
  }
  state.futuresContext = undefined;
  state.futuresIntent = undefined;
  state.futuresRisk = undefined;
  state.futuresProposal = undefined;
  state.futuresEvents = [];
  state.mcpStatus = 'live';
  state.marketSource = 'MCP';
  state.mcpTools = toolNames;
  state.ticker = {
    symbol,
    price,
    changePercent,
    highPrice,
    lowPrice,
    weightedAvgPrice,
    volume,
    quoteVolume,
    raw: { source: 'binance-mcp', observedAt: observedAt ?? new Date().toISOString() },
  };
  updateMarketSignal(state.ticker);
  state.lastError = undefined;
  touch(`Supported Binance MCP host published ${symbol} ${price}`);
  await audit('seller.market.host_received', { source: 'binance-mcp', symbol, price, changePercent, highPrice, lowPrice, weightedAvgPrice, quoteVolume, toolNames, observedAt });
  res.json({ success: true, source: 'MCP', symbol, price, changePercent, highPrice, lowPrice, weightedAvgPrice, quoteVolume, toolNames, signal: state.marketSignal });
});

app.post('/api/host/futures/context', async (req, res) => {
  if (!hostAuthorized(req)) {
    res.status(401).json({ success: false, error: 'Supported Binance MCP host authorization is missing' });
    return;
  }
  const parsed = parseBody(hostFuturesContextSchema, req.body);
  if (!parsed.data) {
    res.status(400).json({ success: false, error: 'Invalid host Futures context payload' });
    return;
  }
  const { source: _source, intent, ...context } = parsed.data;
  if (context.symbol.toUpperCase() !== FUTURES_SYMBOL) {
    res.status(400).json({ success: false, error: 'Host Futures symbol does not match the configured Futures symbol' });
    return;
  }
  if (intent.symbol && intent.symbol.toUpperCase() !== context.symbol.toUpperCase()) {
    res.status(400).json({ success: false, error: 'Futures order intent symbol does not match the context' });
    return;
  }
  if (!context.sourceToolNames.every(futuresToolNameAllowed)) {
    res.status(400).json({ success: false, error: 'Every Futures source tool must be clearly identified as a Futures or derivatives tool' });
    return;
  }
  const risk = evaluateFuturesRisk(context as FuturesContextInput, intent, FUTURES_POLICY);
  state.futuresContext = context as FuturesContextInput;
  state.futuresIntent = intent;
  state.futuresRisk = risk;
  state.futuresProposal = undefined;
  state.futuresEvents = [];
  state.paymentReceiptId = undefined;
  state.paymentStatus = 'waiting';
  state.mcpStatus = 'live';
  state.marketSource = 'MCP';
  state.mcpTools = [...context.sourceToolNames];
  state.lastError = undefined;
  touch(`Live ${context.marketType} Futures context received for ${context.symbol}. Risk gate: ${risk.action} ${risk.riskZone}.`);
  await audit('seller.futures.context.received', {
    marketType: context.marketType,
    strategyMode: context.strategyMode,
    symbol: context.symbol,
    sourceToolNames: context.sourceToolNames,
    observedAt: context.observedAt,
    inputHash: risk.inputHash,
    outputHash: risk.outputHash,
    action: risk.action,
    riskZone: risk.riskZone,
    executionEligible: risk.executionEligible,
  });
  if (!risk.executionEligible && !risk.reportOnly) {
    await audit('seller.futures.risk.refused', {
      analysisId: risk.analysisId,
      reasonCodes: risk.reasonCodes,
      riskZone: risk.riskZone,
    });
  }
  res.json({ success: true, source: 'MCP', risk });
});

app.get('/api/futures/context', (req, res) => {
  if (!dashboardOrHostAuthorized(req)) {
    res.status(401).json({ success: false, error: 'Dashboard login or host authorization required' });
    return;
  }
  if (!state.futuresContext || !state.futuresRisk) {
    res.status(404).json({ success: false, error: 'No Futures context is available' });
    return;
  }
  const current = publicState().futures as Record<string, unknown>;
  res.setHeader('Cache-Control', 'no-store');
  res.json({ success: true, context: current.context, risk: current.risk });
});

app.get('/api/futures/risk', (req, res) => {
  if (!dashboardOrHostAuthorized(req)) {
    res.status(401).json({ success: false, error: 'Dashboard login or host authorization required' });
    return;
  }
  if (!state.futuresRisk) {
    res.status(404).json({ success: false, error: 'No Futures risk envelope is available' });
    return;
  }
  res.setHeader('Cache-Control', 'no-store');
  res.json(state.futuresRisk);
});

app.post('/api/futures/revalidate', async (req, res) => {
  if (!hostAuthorized(req)) {
    res.status(401).json({ success: false, error: 'Supported Binance MCP host authorization is required' });
    return;
  }
  const parsed = parseBody(futuresRevalidateInputSchema, req.body);
  if (!parsed.data) {
    res.status(400).json({ success: false, error: 'Invalid Futures revalidation payload' });
    return;
  }
  const body = parsed.data;
  const proposal = state.futuresProposal;
  const currentContext = state.futuresContext;
  const currentIntent = state.futuresIntent;
  if (!proposal || proposal.proposalId !== body.proposalId || !currentContext || !currentIntent) {
    res.status(404).json({ success: false, error: 'Approved Futures proposal was not found' });
    return;
  }
  if (proposal.status !== 'approved' || !reportAccessIsCurrent(proposal.paymentReceiptId)) {
    res.status(409).json({
      success: false,
      error: FREE_ACCESS
        ? 'Futures revalidation requires the current dashboard approved free briefing'
        : 'Futures revalidation requires the current dashboard approved proposal and real payment receipt',
    });
    return;
  }
  if (body.symbol.toUpperCase() !== FUTURES_SYMBOL || body.marketType !== 'USD_M' || body.strategyMode !== 'directional') {
    res.status(409).json({ success: false, error: 'Only the approved directional USD M path can be revalidated for execution' });
    return;
  }
  if (body.intent.symbol && body.intent.symbol.toUpperCase() !== body.symbol.toUpperCase()) {
    res.status(400).json({ success: false, error: 'Futures revalidation intent symbol does not match the context' });
    return;
  }
  if (!body.sourceToolNames.every(futuresToolNameAllowed)) {
    res.status(400).json({ success: false, error: 'Every Futures revalidation source tool must be clearly identified as a Futures or derivatives tool' });
    return;
  }
  const exactIntent = body.intent.symbol === currentIntent.symbol
    && body.intent.side === currentIntent.side
    && body.intent.positionSide === currentIntent.positionSide
    && body.intent.quantity === currentIntent.quantity
    && body.intent.notionalUSDT === currentIntent.notionalUSDT
    && body.intent.reduceOnly === currentIntent.reduceOnly
    && body.intent.action === currentIntent.action
    && body.intent.protectiveStopPrice === currentIntent.protectiveStopPrice
    && body.intent.protectiveStopSupported === currentIntent.protectiveStopSupported;
  if (!exactIntent) {
    res.status(409).json({ success: false, error: 'Futures revalidation order fields do not match the approved intent' });
    return;
  }
  const { proposalId: _proposalId, intent, ...context } = body;
  const risk = evaluateFuturesRisk(context as FuturesContextInput, intent, FUTURES_POLICY);
  if (!risk.executionEligible || risk.reportOnly) {
    proposal.status = 'cancelled';
    proposal.riskStatus = 'refused';
    proposal.updatedAt = new Date().toISOString();
    touch(`Futures proposal ${proposal.proposalId} cancelled after revalidation failed closed.`);
    await audit('seller.futures.risk.refused', {
      proposalId: proposal.proposalId,
      analysisId: risk.analysisId,
      reasonCodes: risk.reasonCodes,
      riskZone: risk.riskZone,
      stage: 'revalidation',
    });
    res.status(409).json({ success: false, error: 'Fresh Futures context failed the execution risk gate', risk });
    return;
  }
  state.futuresContext = context as FuturesContextInput;
  state.futuresIntent = intent;
  state.futuresRisk = risk;
  proposal.analysisId = risk.analysisId;
  proposal.riskEnvelope = risk;
  proposal.updatedAt = new Date().toISOString();
  touch(`Futures proposal ${proposal.proposalId} passed fresh account and market revalidation.`);
  await audit('seller.futures.context.revalidated', {
    proposalId: proposal.proposalId,
    analysisId: risk.analysisId,
    inputHash: risk.inputHash,
    outputHash: risk.outputHash,
    observedAt: context.observedAt,
  });
  res.json({ success: true, proposalId: proposal.proposalId, analysisId: risk.analysisId, risk });
});

app.get('/api/report/info', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({
  service: 'Signal402 Seller Agent',
  access_mode: ACCESS_MODE,
  price: FREE_ACCESS ? 0 : reportPriceUsdc(),
  currency: FREE_ACCESS ? undefined : 'USDC',
  payment_protocol: FREE_ACCESS ? 'none (free access)' : 'Binance B402 x402 v2',
  network: FREE_ACCESS ? undefined : (process.env.B402_NETWORK ?? 'eip155:56'),
  payment_required: !FREE_ACCESS,
  payment_required_header: FREE_ACCESS ? undefined : 'PAYMENT-REQUIRED',
  settlement_endpoints: FREE_ACCESS ? [] : ['/papi/v2/b402/verify', '/papi/v2/b402/settle'],
  modes: ['spot', 'futures:USD_M:directional', 'futures:USD_M:neutral:report-only', 'futures:COIN_M:directional:report-only', 'futures:COIN_M:neutral:report-only'],
  futures_policy: { maxCombinedNotionalUSDT: MAX_FUTURES_NOTIONAL_USDT, maxLeverage: MAX_FUTURES_LEVERAGE, marginMode: 'ISOLATED', noWithdrawals: true },
  });
});

app.post('/api/report', async (req, res) => {
  if (!parseBody(emptyBodySchema, req.body).data) {
    res.status(400).json({ success: false, error: 'Request body must be an empty JSON object' });
    return;
  }
  const resourceUrl = `${PUBLIC_BASE_URL}/api/report`;
  try {
    if (FREE_ACCESS) {
      await deliverFreeBriefing(res);
      return;
    }
    const required = await buildPaymentRequired(resourceUrl);
    const signedPayment = paymentHeader(req);
    if (!signedPayment) {
      touch('402 challenge issued. No briefing delivered.');
      sendPaymentChallenge(res, required);
      return;
    }
    const receipt = await verifyAndSettlePayment(signedPayment, required.requirement);
    if (!state.futuresRisk && !state.ticker) await refreshMarketData();
    if (!state.futuresRisk && (!state.ticker || state.marketSource === 'UNAVAILABLE')) throw new Error('No live market data is available after payment settlement');
    const text = briefing();
    const paymentResponse = receiptHeader(receipt);
    state.reportsSold += 1;
    state.paymentReceiptId = receipt.transaction;
    state.paymentStatus = 'settled';
    touch(`x402 settled. Briefing delivered. Receipt ${receipt.transaction}`);
    await audit('seller.briefing.delivered', { receiptId: receipt.transaction, source: state.marketSource, symbol: state.symbol });
    res.setHeader('PAYMENT-RESPONSE', paymentResponse);
    res.json({ success: true, briefing: text, paymentReceiptId: receipt.transaction, payment: receipt, marketSource: state.marketSource });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : '';
    const missingCredentials = message.includes('credentials are missing');
    const publicError = missingCredentials
      ? 'Real B402 merchant credentials are not configured. No simulated payment is accepted.'
      : 'Payment verification or briefing delivery failed.';
    state.paymentStatus = 'error';
    state.lastError = publicError;
    touch(`Payment or briefing refused: ${publicError}`);
    await audit('seller.briefing.refused', { error: publicError });
    if (missingCredentials) {
      res.status(503).json({ success: false, error: publicError });
      return;
    }
    res.status(402).json({ success: false, error: publicError });
  }
});

app.post('/api/trade/proposal', async (req, res) => {
  if (!hostAuthorized(req)) {
    res.status(401).json({ success: false, error: 'Supported Binance MCP host authorization is required' });
    return;
  }
  const parsed = parseBody(tradeProposalInputSchema, req.body);
  if (!parsed.data) {
    res.status(400).json({ success: false, error: 'Invalid trade proposal payload' });
    return;
  }
  const body = parsed.data;
  if (state.futuresContext) {
    res.status(409).json({ success: false, error: 'A Futures context is active. Use the strict Futures proposal endpoint.' });
    return;
  }
  if (!reportAccessIsCurrent(body.paymentReceiptId)) {
    res.status(409).json({ success: false, error: reportAccessError('Spot') });
    return;
  }
  const asset = body.asset.toUpperCase();
  const amount = body.amountUSDT;
  const balance = body.balanceUSDT;
  if (asset !== SYMBOL || amount > MAX_TRADE_SIZE_USDT) {
    res.status(400).json({ success: false, error: `Invalid proposal. Maximum allowed size is ${MAX_TRADE_SIZE_USDT} USDT.` });
    return;
  }
  const assessment = assessTradeRisk(balance, amount);
  const signal = state.marketSignal;
  if (!signal) {
    res.status(409).json({ success: false, error: 'No current market intelligence is available. Refusing proposal creation.' });
    return;
  }
  const signalApproved = signal.action === 'BUY_SMALL';
  const decisionReason = signalApproved
    ? `${body.reason}. ${assessment.reason}. Signal402 ${signal.direction} ${signal.risk} risk screen approved a small order.`
    : `${body.reason}. Signal402 screening returned WAIT: ${signal.rationale}`;
  const proposal: TradeProposal = {
    proposalId: body.proposalId,
    asset,
    side: 'BUY',
    amountUSDT: amount,
    balanceUSDT: balance,
    reason: decisionReason.slice(0, 500),
    signalAction: signal.action,
    signalRisk: signal.risk,
    status: assessment.approved ? 'pending' : 'refused',
    riskStatus: assessment.approved ? 'approved' : 'refused',
    paymentReceiptId: body.paymentReceiptId,
    updatedAt: new Date().toISOString(),
  };
  if (!signalApproved) {
    proposal.status = 'refused';
    proposal.riskStatus = 'refused';
  }
  state.proposal = proposal;
  touch(proposal.status === 'pending'
    ? `Trade proposal ${proposal.proposalId} is waiting for human APPROVE.`
    : `Trade proposal ${proposal.proposalId} was refused by the live screening rules.`);
  await audit('seller.trade.proposed', { proposalId: proposal.proposalId, asset: proposal.asset, amountUSDT: amount, balanceUSDT: balance, signalAction: signal.action, signalRisk: signal.risk });
  res.json({ success: true, proposalId: proposal.proposalId, status: proposal.status });
});

app.get('/api/trade/proposal/:proposalId', (req, res) => {
  if (!dashboardOrHostAuthorized(req)) {
    res.status(401).json({ success: false, error: 'Dashboard login or host authorization required' });
    return;
  }
  const proposal = state.proposal;
  if (!proposal || proposal.proposalId !== req.params.proposalId) {
    res.status(404).json({ success: false, error: 'Proposal not found' });
    return;
  }
  res.json(proposal);
});

app.post('/api/trade/approve', async (req, res) => {
  if (!DASHBOARD_AUTH.requireConfigured(res) || !DASHBOARD_AUTH.require(req, res)) return;
  const parsed = parseBody(z.object({ proposalId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/) }).strict(), req.body);
  if (!parsed.data) {
    res.status(400).json({ success: false, error: 'Invalid approval payload' });
    return;
  }
  const proposal = state.proposal;
  if (!proposal || proposal.proposalId !== parsed.data.proposalId) {
    res.status(404).json({ success: false, error: 'Proposal not found' });
    return;
  }
  if (proposal.status !== 'pending') {
    res.status(409).json({ success: false, error: `Proposal is already ${proposal.status}` });
    return;
  }
  proposal.status = 'approved';
  proposal.updatedAt = new Date().toISOString();
  touch(`Human APPROVE received for ${proposal.proposalId}. Buyer may submit one capped Spot order.`);
  await audit('seller.trade.approved', { proposalId: proposal.proposalId, amountUSDT: proposal.amountUSDT });
  res.json({ success: true, status: proposal.status });
});

app.post('/api/trade/status', async (req, res) => {
  if (!hostAuthorized(req)) {
    res.status(401).json({ success: false, error: 'Supported Binance MCP host authorization is required' });
    return;
  }
  const parsed = parseBody(tradeStatusInputSchema, req.body);
  if (!parsed.data) {
    res.status(400).json({ success: false, error: 'Invalid trade status payload' });
    return;
  }
  const body = parsed.data;
  const proposal = state.proposal;
  if (!proposal || proposal.proposalId !== body.proposalId) {
    res.status(404).json({ success: false, error: 'Proposal not found' });
    return;
  }
  const nextStatus = body.status;
  if (nextStatus === 'filled' && proposal.status !== 'approved') {
    res.status(409).json({ success: false, error: 'Only an approved proposal can receive a fill receipt' });
    return;
  }
  if (nextStatus === 'filled' && (
    !body.orderId
    || !body.source
    || !body.mcpToolName
    || body.filledPrice === undefined
    || body.executedQty === undefined
    || body.amountUSDT === undefined
    || !body.beforeBalances
    || !body.afterBalances
    || !state.mcpTools.includes(body.mcpToolName)
    || body.amountUSDT > proposal.amountUSDT + 0.01
  )) {
    res.status(400).json({ success: false, error: 'A filled status requires a real Binance MCP source, tool name, order ID, filled price, executed quantity, and capped quote amount' });
    return;
  }
  if (nextStatus === 'filled') {
    const beforeUSDT = body.beforeBalances!.find((balance) => balance.asset.toUpperCase() === 'USDT')?.free ?? 0;
    const afterUSDT = body.afterBalances!.find((balance) => balance.asset.toUpperCase() === 'USDT')?.free ?? 0;
    const baseAsset = proposal.asset.endsWith('USDT') ? proposal.asset.slice(0, -4) : undefined;
    const beforeBase = baseAsset ? body.beforeBalances!.find((balance) => balance.asset.toUpperCase() === baseAsset)?.free ?? 0 : 0;
    const afterBase = baseAsset ? body.afterBalances!.find((balance) => balance.asset.toUpperCase() === baseAsset)?.free ?? 0 : 0;
    if (beforeUSDT < body.amountUSDT! || afterUSDT >= beforeUSDT || (baseAsset && afterBase <= beforeBase)) {
      res.status(400).json({ success: false, error: 'Balance snapshots do not prove that the real Spot order changed the account' });
      return;
    }
  }
  proposal.status = nextStatus as ProposalStatus;
  proposal.riskStatus = nextStatus === 'refused' ? 'refused' : 'approved';
  proposal.reason = `${body.reason ?? proposal.reason}`.slice(0, 500);
  proposal.orderId = body.orderId ?? proposal.orderId;
  proposal.filledPrice = body.filledPrice ?? proposal.filledPrice;
  proposal.executedQty = body.executedQty ?? proposal.executedQty;
  proposal.source = body.source ?? proposal.source;
  proposal.mcpToolName = body.mcpToolName ?? proposal.mcpToolName;
  proposal.beforeBalances = body.beforeBalances ?? proposal.beforeBalances;
  proposal.afterBalances = body.afterBalances ?? proposal.afterBalances;
  proposal.updatedAt = new Date().toISOString();
  touch(nextStatus === 'filled' ? `REAL TRADE FILLED. Order ${proposal.orderId}` : `Trade ${nextStatus}: ${proposal.reason}`);
  await audit(`seller.trade.${nextStatus}`, { proposalId: proposal.proposalId, orderId: proposal.orderId, filledPrice: proposal.filledPrice, beforeBalances: proposal.beforeBalances, afterBalances: proposal.afterBalances });
  res.json({ success: true, status: proposal.status, orderId: proposal.orderId });
});

app.post('/api/futures/proposal', async (req, res) => {
  if (!hostAuthorized(req)) {
    res.status(401).json({ success: false, error: 'Supported Binance MCP host authorization is required' });
    return;
  }
  const parsed = parseBody(futuresProposalInputSchema, req.body);
  if (!parsed.data) {
    res.status(400).json({ success: false, error: 'Invalid Futures proposal payload' });
    return;
  }
  const body = parsed.data;
  const context = state.futuresContext;
  const intent = state.futuresIntent;
  const risk = state.futuresRisk;
  if (!context || !intent || !risk) {
    res.status(409).json({ success: false, error: 'A live Futures context and risk envelope are required' });
    return;
  }
  if (!reportAccessIsCurrent(body.paymentReceiptId)) {
    res.status(409).json({ success: false, error: reportAccessError('Futures') });
    return;
  }
  if (body.analysisId !== risk.analysisId || body.riskEnvelope.analysisId !== risk.analysisId || body.riskEnvelope.inputHash !== risk.inputHash || body.riskEnvelope.outputHash !== risk.outputHash) {
    res.status(409).json({ success: false, error: 'Futures risk proof does not match the current live context' });
    return;
  }
  if (body.marketType !== 'USD_M' || body.strategyMode !== 'directional' || context.marketType !== 'USD_M' || context.strategyMode !== 'directional') {
    res.status(409).json({ success: false, error: 'Neutral and COIN M Futures paths are report only' });
    return;
  }
  if (!risk.executionEligible || (risk.action !== 'OPEN' && !body.reduceOnly)) {
    res.status(409).json({ success: false, error: 'The Futures risk gate did not allow this execution proposal' });
    return;
  }
  if (body.symbol.toUpperCase() !== context.symbol.toUpperCase() || body.notionalUSDT > MAX_FUTURES_NOTIONAL_USDT || body.notionalUSDT > risk.notionalUSDT + 0.000001) {
    res.status(400).json({ success: false, error: `Futures proposal does not match the gated symbol or ${MAX_FUTURES_NOTIONAL_USDT} USDT cap` });
    return;
  }
  if (body.positionSide !== context.positionSide && context.positionSide !== 'BOTH') {
    res.status(400).json({ success: false, error: 'Futures position side changed after risk assessment' });
    return;
  }
  const exactIntent = body.symbol.toUpperCase() === (intent.symbol ?? context.symbol).toUpperCase()
    && body.side === intent.side
    && body.positionSide === intent.positionSide
    && body.quantity === intent.quantity
    && body.notionalUSDT === intent.notionalUSDT
    && body.reduceOnly === intent.reduceOnly
    && body.protectiveStopPrice === intent.protectiveStopPrice
    && body.protectiveStopSupported === intent.protectiveStopSupported;
  if (!exactIntent) {
    res.status(409).json({ success: false, error: 'Futures proposal order fields do not match the exact intent used to create the risk proof' });
    return;
  }
  const proposal: FuturesProposal = {
    proposalId: body.proposalId,
    analysisId: body.analysisId,
    marketType: body.marketType,
    strategyMode: body.strategyMode,
    symbol: body.symbol.toUpperCase(),
    side: body.side,
    positionSide: body.positionSide,
    quantity: body.quantity,
    notionalUSDT: body.notionalUSDT,
    reduceOnly: body.reduceOnly,
    leverage: context.leverage,
    marginMode: 'ISOLATED',
    protectiveStopPrice: body.protectiveStopPrice,
    protectiveStopSupported: body.protectiveStopSupported,
    reason: body.reason.slice(0, 500),
    status: 'pending',
    riskStatus: 'approved',
    paymentReceiptId: body.paymentReceiptId,
    riskEnvelope: risk,
    updatedAt: new Date().toISOString(),
  };
  state.futuresProposal = proposal;
  state.futuresEvents = [];
  touch(`USD M directional Futures proposal ${proposal.proposalId} is waiting for dashboard APPROVE.`);
  await audit('seller.futures.proposal.created', {
    proposalId: proposal.proposalId,
    analysisId: proposal.analysisId,
    symbol: proposal.symbol,
    side: proposal.side,
    positionSide: proposal.positionSide,
    notionalUSDT: proposal.notionalUSDT,
    leverage: proposal.leverage,
    marginMode: proposal.marginMode,
    inputHash: risk.inputHash,
    outputHash: risk.outputHash,
  });
  res.json({ success: true, proposalId: proposal.proposalId, status: proposal.status, executionEligible: risk.executionEligible });
});

app.get('/api/futures/proposal/:proposalId', (req, res) => {
  if (!dashboardOrHostAuthorized(req)) {
    res.status(401).json({ success: false, error: 'Dashboard login or host authorization required' });
    return;
  }
  const proposal = state.futuresProposal;
  if (!proposal || proposal.proposalId !== req.params.proposalId) {
    res.status(404).json({ success: false, error: 'Futures proposal not found' });
    return;
  }
  const dashboardState = publicState().futures as Record<string, unknown>;
  res.json(dashboardState.proposal);
});

app.post('/api/futures/approve', async (req, res) => {
  if (!DASHBOARD_AUTH.requireConfigured(res) || !DASHBOARD_AUTH.require(req, res)) return;
  const parsed = parseBody(z.object({ proposalId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/) }).strict(), req.body);
  if (!parsed.data) {
    res.status(400).json({ success: false, error: 'Invalid Futures approval payload' });
    return;
  }
  const proposal = state.futuresProposal;
  if (!proposal || proposal.proposalId !== parsed.data.proposalId) {
    res.status(404).json({ success: false, error: 'Futures proposal not found' });
    return;
  }
  if (proposal.status !== 'pending') {
    res.status(409).json({ success: false, error: `Futures proposal is already ${proposal.status}` });
    return;
  }
  if (!proposal.riskEnvelope.executionEligible || proposal.riskEnvelope.reportOnly) {
    res.status(409).json({ success: false, error: 'This Futures proposal is report only' });
    return;
  }
  proposal.status = 'approved';
  proposal.updatedAt = new Date().toISOString();
  touch(`Human APPROVE received for Futures proposal ${proposal.proposalId}. CONFIRM is required before the live MCP order.`);
  await audit('seller.futures.approval.received', { proposalId: proposal.proposalId, notionalUSDT: proposal.notionalUSDT, orderId: proposal.orderId });
  res.json({ success: true, status: proposal.status });
});

app.post('/api/futures/confirm', async (req, res) => {
  if (!hostAuthorized(req)) {
    res.status(401).json({ success: false, error: 'Supported Binance MCP host authorization is required' });
    return;
  }
  const parsed = parseBody(z.object({ proposalId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/), confirmExecution: z.literal('CONFIRM') }).strict(), req.body);
  if (!parsed.data) {
    res.status(400).json({ success: false, error: 'The exact CONFIRM value is required before a Futures write' });
    return;
  }
  const proposal = state.futuresProposal;
  if (!proposal || proposal.proposalId !== parsed.data.proposalId) {
    res.status(404).json({ success: false, error: 'Futures proposal not found' });
    return;
  }
  if (proposal.status !== 'approved') {
    res.status(409).json({ success: false, error: 'Dashboard APPROVE is required before CONFIRM' });
    return;
  }
  if (!state.futuresContext || !state.futuresIntent) {
    res.status(409).json({ success: false, error: 'A fresh Futures context is required before CONFIRM' });
    return;
  }
  const freshRisk = evaluateFuturesRisk(state.futuresContext, state.futuresIntent, FUTURES_POLICY);
  if (!freshRisk.executionEligible || freshRisk.inputHash !== proposal.riskEnvelope.inputHash) {
    await audit('seller.futures.risk.refused', {
      proposalId: proposal.proposalId,
      analysisId: freshRisk.analysisId,
      reasonCodes: freshRisk.reasonCodes,
      riskZone: freshRisk.riskZone,
      stage: 'confirmation',
    });
    res.status(409).json({ success: false, error: 'Fresh Futures context no longer passes the execution risk gate', risk: freshRisk });
    return;
  }
  proposal.executionConfirmedAt = new Date().toISOString();
  proposal.updatedAt = proposal.executionConfirmedAt;
  touch(`Human CONFIRM received for Futures proposal ${proposal.proposalId}. One live USD M order may be submitted.`);
  await audit('seller.futures.execution.confirmed', { proposalId: proposal.proposalId });
  res.json({ success: true, confirmed: true, confirmedAt: proposal.executionConfirmedAt });
});

app.post('/api/futures/status', async (req, res) => {
  if (!hostAuthorized(req)) {
    res.status(401).json({ success: false, error: 'Supported Binance MCP host authorization is required' });
    return;
  }
  const parsed = parseBody(futuresStatusInputSchema, req.body);
  if (!parsed.data) {
    res.status(400).json({ success: false, error: 'Invalid Futures event payload' });
    return;
  }
  const body = parsed.data;
  const proposal = state.futuresProposal;
  const context = state.futuresContext;
  if (!proposal || proposal.proposalId !== body.proposalId || !context) {
    res.status(404).json({ success: false, error: 'Futures proposal not found' });
    return;
  }
  if (!futuresToolNameAllowed(body.mcpToolName)) {
    res.status(400).json({ success: false, error: 'Futures event tool is not clearly identified as a runtime Futures MCP tool' });
    return;
  }
  if (body.source === 'binance-mcp-direct-approved' && (BINANCE_MODE !== 'direct' || process.env.BINANCE_MCP_CLIENT_APPROVED !== 'true')) {
    res.status(403).json({ success: false, error: 'Direct Futures receipts require an explicitly Binance approved direct client' });
    return;
  }
  if (!Number.isFinite(Date.parse(body.observedAt)) || Date.parse(body.observedAt) - Date.now() > 5_000) {
    res.status(400).json({ success: false, error: 'Futures event timestamp is invalid' });
    return;
  }
  if (body.eventType === 'MARGIN_CALL' && body.status !== 'liquidated') {
    res.status(400).json({ success: false, error: 'A margin call event must be recorded as liquidated' });
    return;
  }
  const requiresOrderId = body.eventType === 'ORDER_TRADE_UPDATE';
  if (requiresOrderId && !body.orderId) {
    res.status(400).json({ success: false, error: 'A live Futures order event requires the real order ID' });
    return;
  }
  if (body.status !== 'rejected' && body.status !== 'cancelled' && !proposal.executionConfirmedAt) {
    res.status(409).json({ success: false, error: 'The exact CONFIRM step is required before a live Futures order event' });
    return;
  }
  if (body.orderId && proposal.orderId && body.orderId !== proposal.orderId) {
    res.status(409).json({ success: false, error: 'Futures event order ID does not match the existing order' });
    return;
  }
  if ((body.status === 'partially_filled' || body.status === 'filled') && (!body.executedQty || !body.filledPrice)) {
    res.status(400).json({ success: false, error: 'Futures fill events require a real filled price and executed quantity' });
    return;
  }
  if (body.executedQty !== undefined && body.executedQty > proposal.quantity * 1.001) {
    res.status(400).json({ success: false, error: 'Futures executed quantity exceeds the approved quantity' });
    return;
  }
  if (body.status === 'filled') {
    if (!body.beforeAccountSnapshot || !body.afterAccountSnapshot || !body.beforePositionSnapshot || !body.afterPositionSnapshot) {
      res.status(400).json({ success: false, error: 'A filled Futures event requires before and after account and position snapshots' });
      return;
    }
    const beforeNotional = snapshotNotional(body.beforePositionSnapshot, proposal.symbol, context.markPrice);
    const afterNotional = snapshotNotional(body.afterPositionSnapshot, proposal.symbol, context.markPrice);
    const beforeQuantity = snapshotQuantity(body.beforePositionSnapshot, proposal.symbol, proposal.positionSide);
    const afterQuantity = snapshotQuantity(body.afterPositionSnapshot, proposal.symbol, proposal.positionSide);
    const accountChanged = body.beforeAccountSnapshot.walletBalanceUSDT !== body.afterAccountSnapshot.walletBalanceUSDT
      || body.beforeAccountSnapshot.availableBalanceUSDT !== body.afterAccountSnapshot.availableBalanceUSDT
      || body.beforeAccountSnapshot.marginBalanceUSDT !== body.afterAccountSnapshot.marginBalanceUSDT
      || body.beforeAccountSnapshot.initialMarginUSDT !== body.afterAccountSnapshot.initialMarginUSDT
      || body.beforeAccountSnapshot.maintenanceMarginUSDT !== body.afterAccountSnapshot.maintenanceMarginUSDT;
    const fillCheck = validateFuturesFillChange({ reduceOnly: proposal.reduceOnly, beforeQuantity, afterQuantity, beforeNotional, afterNotional, accountChanged });
    if (!fillCheck.valid) {
      res.status(400).json({ success: false, error: `Futures fill snapshots do not prove that the real order changed margin and position state: ${fillCheck.reason}` });
      return;
    }
  }
  let nextStatus: FuturesTradeState;
  try {
    nextStatus = advanceFuturesTradeState(proposal.status, body.status);
  } catch (error: unknown) {
    res.status(409).json({ success: false, error: error instanceof Error ? error.message : 'Invalid Futures event transition' });
    return;
  }
  const event: FuturesEvent = {
    eventType: body.eventType,
    status: body.status,
    orderId: body.orderId,
    filledPrice: body.filledPrice,
    executedQty: body.executedQty,
    realizedPnlUSDT: body.realizedPnlUSDT,
    source: body.source,
    mcpToolName: body.mcpToolName,
    accountSnapshot: body.accountSnapshot,
    beforeAccountSnapshot: body.beforeAccountSnapshot,
    afterAccountSnapshot: body.afterAccountSnapshot,
    positionSnapshot: body.positionSnapshot,
    beforePositionSnapshot: body.beforePositionSnapshot,
    afterPositionSnapshot: body.afterPositionSnapshot,
    observedAt: body.observedAt,
    reason: body.reason,
  };
  state.futuresEvents = [event, ...state.futuresEvents].slice(0, 50);
  proposal.status = nextStatus;
  proposal.riskStatus = body.status === 'rejected' ? 'refused' : 'approved';
  proposal.orderId = body.orderId ?? proposal.orderId;
  proposal.filledPrice = body.filledPrice ?? proposal.filledPrice;
  proposal.executedQty = body.executedQty ?? proposal.executedQty;
  proposal.realizedPnlUSDT = body.realizedPnlUSDT ?? proposal.realizedPnlUSDT;
  proposal.source = body.source;
  proposal.mcpToolName = body.mcpToolName;
  proposal.beforeAccountSnapshot = body.beforeAccountSnapshot ?? proposal.beforeAccountSnapshot;
  proposal.afterAccountSnapshot = body.afterAccountSnapshot ?? proposal.afterAccountSnapshot;
  proposal.beforePositionSnapshot = body.beforePositionSnapshot ?? proposal.beforePositionSnapshot;
  proposal.afterPositionSnapshot = body.afterPositionSnapshot ?? proposal.afterPositionSnapshot;
  proposal.updatedAt = new Date().toISOString();
  touch(`Futures ${body.status.replace('_', ' ')} event received${proposal.orderId ? ` for ${proposal.orderId}` : ''}.`);
  await audit(`seller.futures.${body.status}`, {
    proposalId: proposal.proposalId,
    eventType: body.eventType,
    orderId: proposal.orderId,
    filledPrice: proposal.filledPrice,
    executedQty: proposal.executedQty,
    mcpToolName: body.mcpToolName,
    observedAt: body.observedAt,
  });
  res.json({ success: true, status: proposal.status, orderId: proposal.orderId, filledPrice: proposal.filledPrice, executedQty: proposal.executedQty });
});

app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  void audit('seller.http.error', { error: error instanceof Error ? error.message : 'Unhandled request error' }).catch(() => undefined);
  res.status(500).json({ success: false, error: 'Request failed' });
});

const server = app.listen(PORT, () => {
  console.log(`\n📡 Signal402 Seller Agent listening on http://localhost:${PORT}`);
  console.log(`   Pair: ${SYMBOL}`);
  console.log(`   Binance integration: ${BINANCE_MODE === 'direct' ? 'DIRECT CLIENT (requires Binance approval)' : 'SUPPORTED HOST MCP'}`);
  if (BINANCE_MODE !== 'direct') console.log('   Host bridge: POST live market data from the supported Binance MCP host to /api/host/market');
  console.log(`   access: ${FREE_ACCESS ? 'FREE ACCESS. No payment requested.' : b402IsConfigured() ? 'B402 credentials detected' : 'NOT CONFIGURED. Real payments only.'}`);
  console.log(`   Public REST fallback: ${ALLOW_PUBLIC_REST_FALLBACK ? 'ENABLED AND LABELLED' : 'DISABLED'}`);
  void refreshMarketData();
});

const refreshTimer = setInterval(() => { void refreshMarketData(); }, 15_000);

async function shutdown(): Promise<void> {
  clearInterval(refreshTimer);
  await mcp.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

process.once('SIGINT', () => { void shutdown().finally(() => process.exit(0)); });
process.once('SIGTERM', () => { void shutdown().finally(() => process.exit(0)); });
