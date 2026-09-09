import axios, { type AxiosRequestConfig } from 'axios';
import dotenv from 'dotenv';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { assessTradeRisk } from '../buyer/riskGuardian.js';
import { payReportChallenge, requestReportChallenge, type ReportPaymentChallenge } from '../lib/binanceX402Client.js';
import { audit } from '../lib/audit.js';
import { validateSellerEndpoint } from '../lib/endpointSecurity.js';
import {
  evaluateFuturesRisk,
  type FuturesContextInput,
  type FuturesOrderIntentInput,
  type FuturesRiskPolicy,
} from '../lib/futuresRisk.js';
import { isUsableSecret } from '../lib/securityConfig.js';
import {
  carryContextSchema,
  futuresContextSchema,
  futuresIntentSchema,
  futuresProposalInputSchema,
  futuresRevalidateInputSchema,
  futuresStatusInputSchema,
  hostFuturesContextSchema,
} from '../lib/schemas.js';

dotenv.config({ path: resolve(dirname(fileURLToPath(import.meta.url)), '../../.env') });

const SELLER_ENDPOINT = process.env.SELLER_ENDPOINT_URL ?? 'http://localhost:3001';
validateSellerEndpoint(SELLER_ENDPOINT);
const HOST_TOKEN = process.env.SIGNAL402_HOST_TOKEN;
const MAX_TRADE_SIZE_USDT = Math.min(Number.parseFloat(process.env.MAX_TRADE_SIZE_USDT ?? '10') || 10, 10);
function boundedPolicyEnv(name: string, fallback: number, minimum: number, maximum: number): number {
  const configured = Number.parseFloat(process.env[name] ?? '');
  return Number.isFinite(configured) ? Math.min(Math.max(configured, minimum), maximum) : fallback;
}
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
const APPROVAL_POLL_MS = Number.parseInt(process.env.APPROVAL_POLL_MS ?? '1000', 10);
const PAYMENT_CHALLENGE_TTL_MS = 5 * 60 * 1000;

let pendingPaymentChallenge: ReportPaymentChallenge | undefined;
let pendingPaymentChallengeAt = 0;

const balanceSchema = z.object({
  asset: z.string().min(1),
  free: z.number().finite().nonnegative(),
  locked: z.number().finite().nonnegative(),
});

type BalanceSnapshot = z.infer<typeof balanceSchema>;

const WORKFLOW = `
Signal402 is a real Binance Agent OS workflow. The supported MCP host owns Binance OAuth.

1. Discover the currently available Binance MCP tools at runtime. Do not invent or hardcode tool names.
2. Call the Binance MCP market data tool for the requested symbol. Do not use public REST for account or trading data.
3. Call signal402_publish_market with the live MCP result and the complete list of runtime discovered Binance tool names, not only the ticker tool. Signal402 derives an explainable direction, risk tier, and BUY_SMALL or WAIT action from that snapshot.
4. Call signal402_request_briefing to inspect the access mode. Free mode is the default, so no payment is requested and no receipt exists. If the Seller is explicitly configured for B402, verify the real 0.01 USDC amount and merchant terms before continuing.
5. In paid mode, ask the human to approve that exact payment. Only then call signal402_pay_briefing with confirmPayment=true. In free mode, call signal402_pay_briefing only if you need the report body, and never invent or attach a receipt.
6. Call the Binance MCP account balance tool. Pass the live USDT balance to signal402_create_proposal.
7. If the Seller returns WAIT or a refused proposal, stop. Do not create an order. Otherwise wait for the human to press APPROVE in the Signal402 dashboard by calling signal402_wait_for_approval.
8. Only after approved, call the Binance MCP Spot order tool with one MARKET BUY capped at 10 USDT. Use the live tool schema. Never submit an order before approval.
9. Read the real order result and read balances again through Binance MCP. Call signal402_record_fill only with the real order ID, filled price, quantities, and before and after balances.
10. Treat the returned immutable execution plan as single use. It expires after 60 seconds, and every fill must return a hash verified execution receipt.

Futures branch, opt in with an explicit USD_M or COIN_M context:
1. Discover runtime Futures tools and reject tools that are not clearly marked Futures, USD M, COIN M, perpetual, derivative, or contract tools.
2. Read mark price, bid and ask, depth, funding and next funding time, exchange filters, leverage brackets, account margin, positions, open orders, and liquidation data. Publish them with signal402_publish_futures_context.
3. Run signal402_assess_futures_risk. The deterministic envelope fails closed on stale data, cross margin, leverage above 3x, a combined notional above 10 USDT, missing data, excessive spread, slippage, funding stress, or liquidation risk.
4. If B402 mode is explicitly enabled, pay the real 0.01 USDC challenge only after human payment approval. A settled receipt is required before the paid Futures report is released. In the default free mode, no payment or receipt is used.
5. Neutral and COIN M paths stop at a report. They never show an approval button and never submit an order.
6. Directional USD_M can create a proposal only when executionEligible=true and a supported protective stop plan is declared. Wait for dashboard APPROVE, then ask the human to type CONFIRM for the exact order.
7. Re-read the account and Futures context, then call signal402_revalidate_futures_context. Submit one MARKET order through the live runtime USD_M Futures MCP tool with symbol, side, explicit positionSide, quantity, reduceOnly, existing leverage at or below 3x, and isolated margin. Never send quoteOrderQty. Never change leverage or margin mode automatically.
8. Monitor the private Futures user stream or authenticated order status. Record submitted, order update, account update, fill, margin call, or liquidation events with signal402_record_futures_event. Reconcile the real order ID, fills, position, margin, and before and after balances.

No simulated receipt, balance, fill, or order ID is accepted. No withdrawal or transfer action is allowed. Every write action needs explicit human approval. A risk estimate is not a guaranteed loss limit.
`.trim();

function jsonResult(value: Record<string, unknown>) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
    structuredContent: value,
  };
}

function textResult(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function requireHostToken(): string {
  if (!isUsableSecret(HOST_TOKEN)) {
    throw new Error('SIGNAL402_HOST_TOKEN is not configured. Refusing host bridge writes.');
  }
  return HOST_TOKEN;
}

async function sellerRequest<T>(method: 'get' | 'post', path: string, data?: unknown): Promise<T> {
  const config: AxiosRequestConfig = {
    method,
    url: `${SELLER_ENDPOINT.replace(/\/$/, '')}${path}`,
    data,
    headers: { Authorization: `Bearer ${requireHostToken()}` },
    timeout: 30_000,
  };
  const response = await axios.request<T>(config);
  return response.data;
}

function uniqueToolNames(names: string[]): string[] {
  return [...new Set(names.map((name) => name.trim()).filter(Boolean))];
}

function extractBalances(value: unknown): BalanceSnapshot[] {
  const parsed = z.array(balanceSchema).safeParse(value);
  if (!parsed.success) throw new Error(`Invalid live Binance MCP balance snapshot: ${parsed.error.message}`);
  return parsed.data;
}

function extractUsdt(balances: BalanceSnapshot[]): number {
  return balances.find((balance) => balance.asset.toUpperCase() === 'USDT')?.free ?? 0;
}

function extractAsset(balances: BalanceSnapshot[], asset: string): number {
  return balances.find((balance) => balance.asset.toUpperCase() === asset.toUpperCase())?.free ?? 0;
}

const server = new McpServer({ name: 'signal402-agent', version: '1.0.0' });

server.registerTool('signal402_get_workflow', {
  title: 'Signal402 real Agent OS workflow',
  description: 'Returns the mandatory real Binance Agent OS workflow. The host must use its configured Binance MCP tools for live data and orders.',
}, async () => textResult(WORKFLOW));

server.registerTool('signal402_get_capabilities', {
  title: 'Read Signal402 capabilities',
  description: 'Return the machine readable supported Binance CEX modes, limits, payment mode, provenance policy, and safety gates. No account secrets or balances are returned.',
}, async () => jsonResult(await sellerRequest<Record<string, unknown>>('get', '/api/capabilities')));

server.registerTool('signal402_get_risk_state', {
  title: 'Read persistent risk controls',
  description: 'Read the authenticated persistent kill switch and drawdown state. A halted state blocks new exposure.',
}, async () => jsonResult(await sellerRequest<Record<string, unknown>>('get', '/api/risk/state')));

server.registerTool('signal402_publish_market', {
  title: 'Publish live Binance MCP market data',
  description: 'Publish a ticker read by the supported Binance MCP host to the Seller dashboard. Include every runtime discovered Binance tool name that may be used later for balances or orders. Public REST and invented values are rejected.',
  inputSchema: {
    symbol: z.string().min(1),
    price: z.number().finite().positive(),
    changePercent: z.number().finite().optional(),
    highPrice: z.number().finite().positive().optional(),
    lowPrice: z.number().finite().positive().optional(),
    weightedAvgPrice: z.number().finite().positive().optional(),
    volume: z.number().finite().nonnegative().optional(),
    quoteVolume: z.number().finite().nonnegative().optional(),
    toolNames: z.array(z.string().min(1)).min(1),
    observedAt: z.string().datetime().optional(),
  },
}, async ({ symbol, price, changePercent, highPrice, lowPrice, weightedAvgPrice, volume, quoteVolume, toolNames, observedAt }) => {
  const names = uniqueToolNames(toolNames);
  const result = await sellerRequest<Record<string, unknown>>('post', '/api/host/market', {
    source: 'binance-mcp',
    symbol: symbol.toUpperCase(),
    price,
    changePercent,
    highPrice,
    lowPrice,
    weightedAvgPrice,
    volume,
    quoteVolume,
    toolNames: names,
    observedAt: observedAt ?? new Date().toISOString(),
  });
  await audit('host.market.published', { symbol: symbol.toUpperCase(), price, changePercent, highPrice, lowPrice, weightedAvgPrice, quoteVolume, toolNames: names });
  return jsonResult(result);
});

server.registerTool('signal402_publish_futures_context', {
  title: 'Publish live Binance Futures context',
  description: 'Publish runtime discovered Futures market, funding, account, position, liquidation, and filter data. Public REST data cannot satisfy this tool.',
  inputSchema: { ...hostFuturesContextSchema.omit({ source: true }).shape },
}, async (input) => {
  const parsed = hostFuturesContextSchema.omit({ source: true }).safeParse(input);
  if (!parsed.success) throw new Error(`Invalid live Futures context: ${parsed.error.message}`);
  const result = await sellerRequest<Record<string, unknown>>('post', '/api/host/futures/context', {
    source: 'binance-mcp',
    ...parsed.data,
  });
  await audit('host.futures.context.published', {
    marketType: parsed.data.marketType,
    strategyMode: parsed.data.strategyMode,
    symbol: parsed.data.symbol,
    toolNames: parsed.data.sourceToolNames,
    observedAt: parsed.data.observedAt,
  });
  return jsonResult(result);
});

server.registerTool('signal402_publish_carry_context', {
  title: 'Publish Binance CEX carry context',
  description: 'Publish live Spot and Futures market inputs for a deterministic Binance CEX carry report. This path is report only and never submits a hedge.',
  inputSchema: { ...carryContextSchema.shape },
}, async (input) => {
  const parsed = carryContextSchema.safeParse(input);
  if (!parsed.success) throw new Error(`Invalid Binance CEX carry context: ${parsed.error.message}`);
  const result = await sellerRequest<Record<string, unknown>>('post', '/api/host/carry/context', parsed.data);
  await audit('host.carry.context.published', { symbol: parsed.data.symbol, sourceToolNames: parsed.data.sourceToolNames, observedAt: parsed.data.observedAt });
  return jsonResult(result);
});

server.registerTool('signal402_get_carry_report', {
  title: 'Read Binance CEX carry report',
  description: 'Read the latest deterministic Spot and Futures carry report. It is report only and contains no order instruction.',
}, async () => jsonResult(await sellerRequest<Record<string, unknown>>('get', '/api/carry/report')));

server.registerTool('signal402_revalidate_futures_context', {
  title: 'Revalidate the approved Futures order',
  description: 'Publish a fresh account and market context after dashboard approval. The Seller keeps the order blocked if any risk input changed or became stale.',
  inputSchema: { ...futuresRevalidateInputSchema.shape },
}, async (input) => {
  const parsed = futuresRevalidateInputSchema.safeParse(input);
  if (!parsed.success) throw new Error(`Invalid Futures revalidation payload: ${parsed.error.message}`);
  const result = await sellerRequest<Record<string, unknown>>('post', '/api/futures/revalidate', parsed.data);
  await audit('host.futures.context.revalidated', {
    proposalId: parsed.data.proposalId,
    marketType: parsed.data.marketType,
    strategyMode: parsed.data.strategyMode,
    symbol: parsed.data.symbol,
    toolNames: parsed.data.sourceToolNames,
    observedAt: parsed.data.observedAt,
  });
  return jsonResult(result);
});

server.registerTool('signal402_assess_futures_risk', {
  title: 'Run the deterministic Futures risk gate',
  description: 'Evaluate a strict live Futures context with the DeltaZero adapted risk envelope. The result never places an order.',
  inputSchema: {
    context: futuresContextSchema,
    intent: futuresIntentSchema,
  },
}, async ({ context, intent }) => {
  const contextParsed = futuresContextSchema.safeParse(context);
  const intentParsed = futuresIntentSchema.safeParse(intent);
  if (!contextParsed.success) throw new Error(`Invalid Futures risk input: ${contextParsed.error.message}`);
  if (!intentParsed.success) throw new Error(`Invalid Futures risk input: ${intentParsed.error.message}`);
  const envelope = evaluateFuturesRisk(contextParsed.data as FuturesContextInput, intentParsed.data as FuturesOrderIntentInput, FUTURES_POLICY);
  await audit('host.futures.risk.created', {
    analysisId: envelope.analysisId,
    marketType: envelope.marketType,
    strategyMode: envelope.strategyMode,
    action: envelope.action,
    riskZone: envelope.riskZone,
    executionEligible: envelope.executionEligible,
    inputHash: envelope.inputHash,
    outputHash: envelope.outputHash,
  });
  return jsonResult(envelope as unknown as Record<string, unknown>);
});

server.registerTool('signal402_request_briefing', {
  title: 'Request Seller briefing access',
  description: 'Request the Seller access response. Paid mode returns a real B402 challenge. Free mode returns the live briefing without requesting payment.',
}, async () => {
  const challenge = await requestReportChallenge(SELLER_ENDPOINT);
  pendingPaymentChallenge = challenge;
  pendingPaymentChallengeAt = Date.now();
  await audit(challenge.accessMode === 'free' ? 'host.briefing.free' : 'host.briefing.challenge', { url: challenge.url, accessMode: challenge.accessMode });
  return jsonResult({
    url: challenge.url,
    accessMode: challenge.accessMode,
    ...(challenge.paymentRequirements ? { paymentRequirements: challenge.paymentRequirements } : {}),
    challenge: challenge.body,
    nextStep: challenge.accessMode === 'free'
      ? 'Free access is enabled. No payment was requested. Continue to live risk checks.'
      : 'Verify the exact 0.01 USDC terms with the human before paying.',
  });
});

server.registerTool('signal402_pay_briefing', {
  title: 'Settle or retrieve the Seller briefing',
  description: 'Pay the real B402 challenge in paid mode. Free mode skips payment and returns no receipt.',
  inputSchema: { confirmPayment: z.boolean() },
}, async ({ confirmPayment }) => {
  if (!pendingPaymentChallenge || Date.now() - pendingPaymentChallengeAt > PAYMENT_CHALLENGE_TTL_MS) {
    pendingPaymentChallenge = undefined;
    pendingPaymentChallengeAt = 0;
    throw new Error('No fresh payment challenge is pending. Call signal402_request_briefing first.');
  }
  if (pendingPaymentChallenge.accessMode === 'free') {
    const freeChallenge = pendingPaymentChallenge;
    pendingPaymentChallenge = undefined;
    pendingPaymentChallengeAt = 0;
    await audit('host.briefing.free.returned', { url: freeChallenge.url });
    return jsonResult({
      paid: false,
      accessMode: 'free',
      paymentReceiptId: null,
      report: freeChallenge.body,
      message: 'Free access is enabled. No payment was requested or signed.',
    });
  }
  if (!confirmPayment) return jsonResult({
    paid: false,
    message: 'No payment was signed. Ask the human to approve the exact 0.01 USDC terms first.',
    url: pendingPaymentChallenge.url,
    paymentRequirements: pendingPaymentChallenge.paymentRequirements,
  });

  const approvedChallenge = pendingPaymentChallenge;
  pendingPaymentChallenge = undefined;
  pendingPaymentChallengeAt = 0;
  const currentChallenge = await requestReportChallenge(SELLER_ENDPOINT);
  if (currentChallenge.url !== approvedChallenge.url || currentChallenge.paymentRequirements !== approvedChallenge.paymentRequirements) {
    throw new Error('Seller payment terms changed after human approval. Request a fresh challenge and approve it again.');
  }
  const report = await payReportChallenge(currentChallenge, { explicitlyApproved: true });
  await audit('host.briefing.paid', { paymentReceiptId: report.paymentReceiptId });
  return jsonResult({ paid: true, accessMode: report.accessMode, paymentReceiptId: report.paymentReceiptId, report: report.body });
});

server.registerTool('signal402_assess_risk', {
  title: 'Run the Risk Guardian',
  description: 'Apply the hard live USDT balance rule before creating a trade proposal.',
  inputSchema: {
    balanceUSDT: z.number().finite(),
    proposedSizeUSDT: z.number().finite().positive().max(MAX_TRADE_SIZE_USDT),
  },
}, async ({ balanceUSDT, proposedSizeUSDT }) => jsonResult({ assessment: assessTradeRisk(balanceUSDT, proposedSizeUSDT), maxTradeSizeUSDT: MAX_TRADE_SIZE_USDT }));

server.registerTool('signal402_create_proposal', {
  title: 'Create a human gated trade proposal',
  description: 'Create a proposal from live Binance MCP balance data. Paid mode requires the exact B402 receipt. Free mode omits the receipt. Refused proposals never create an order intent.',
  inputSchema: {
    proposalId: z.string().min(1).optional(),
    asset: z.string().min(1),
    amountUSDT: z.number().finite().positive().max(MAX_TRADE_SIZE_USDT),
    balanceUSDT: z.number().finite(),
    paymentReceiptId: z.string().min(1).optional(),
    reason: z.string().min(1),
  },
}, async ({ proposalId, asset, amountUSDT, balanceUSDT, paymentReceiptId, reason }) => {
  const assessment = assessTradeRisk(balanceUSDT, amountUSDT);
  const id = proposalId ?? `proposal_${Date.now()}`;
  const result = await sellerRequest<Record<string, unknown>>('post', '/api/trade/proposal', {
    proposalId: id,
    asset: asset.toUpperCase(),
    side: 'BUY',
    amountUSDT,
    balanceUSDT,
    reason: `${reason}. ${assessment.reason}`.slice(0, 500),
    ...(paymentReceiptId ? { paymentReceiptId } : {}),
  });
  await audit('host.trade.proposal', { proposalId: id, asset: asset.toUpperCase(), amountUSDT, balanceUSDT, approved: assessment.approved });
  return jsonResult({ ...result, assessment, proposalId: id });
});

server.registerTool('signal402_create_futures_proposal', {
  title: 'Create a human gated Futures proposal',
  description: 'Create a USD M directional proposal only from a deterministic risk envelope. Paid mode requires a real B402 receipt. Free mode omits the receipt. Neutral and COIN M proposals remain report only.',
  inputSchema: { ...futuresProposalInputSchema.shape },
}, async (input) => {
  const parsed = futuresProposalInputSchema.safeParse(input);
  if (!parsed.success) throw new Error(`Invalid Futures proposal payload: ${parsed.error.message}`);
  const body = parsed.data;
  if (body.riskEnvelope.analysisId !== body.analysisId) throw new Error('Futures proposal analysis ID does not match the risk envelope');
  if (!body.riskEnvelope.executionEligible || body.riskEnvelope.reportOnly || body.marketType !== 'USD_M' || body.strategyMode !== 'directional') {
    throw new Error('Futures proposal is report only unless the USD M directional risk gate allows execution');
  }
  const result = await sellerRequest<Record<string, unknown>>('post', '/api/futures/proposal', body);
  await audit('host.futures.proposal.created', {
    proposalId: body.proposalId,
    analysisId: body.analysisId,
    marketType: body.marketType,
    strategyMode: body.strategyMode,
    symbol: body.symbol,
    notionalUSDT: body.notionalUSDT,
  });
  return jsonResult(result);
});

server.registerTool('signal402_wait_for_approval', {
  title: 'Wait for dashboard approval',
  description: 'Wait until the human presses APPROVE in the Signal402 dashboard. No Binance order is sent by this tool.',
  inputSchema: {
    proposalId: z.string().min(1),
    timeoutSeconds: z.number().int().positive().max(300).default(300),
  },
}, async ({ proposalId, timeoutSeconds }) => {
  const deadline = Date.now() + timeoutSeconds * 1000;
  while (Date.now() < deadline) {
    const proposal = await sellerRequest<Record<string, unknown>>('get', `/api/trade/proposal/${encodeURIComponent(proposalId)}`);
    const status = `${proposal.status ?? ''}`;
    if (status !== 'pending') return jsonResult({ proposal, approved: status === 'approved' });
    await new Promise<void>((resolve) => setTimeout(resolve, APPROVAL_POLL_MS));
  }
  return jsonResult({ proposalId, approved: false, status: 'timeout', message: 'No Binance order was submitted.' });
});

server.registerTool('signal402_wait_for_futures_approval', {
  title: 'Wait for Futures dashboard approval',
  description: 'Wait until the human approves the exact directional USD M proposal. This tool never submits an order.',
  inputSchema: {
    proposalId: z.string().min(1),
    timeoutSeconds: z.number().int().positive().max(300).default(300),
  },
}, async ({ proposalId, timeoutSeconds }) => {
  const deadline = Date.now() + timeoutSeconds * 1000;
  while (Date.now() < deadline) {
    const proposal = await sellerRequest<Record<string, unknown>>('get', `/api/futures/proposal/${encodeURIComponent(proposalId)}`);
    const status = `${proposal.status ?? ''}`;
    if (status !== 'pending') return jsonResult({ proposal, approved: status === 'approved' });
    await new Promise<void>((resolve) => setTimeout(resolve, APPROVAL_POLL_MS));
  }
  return jsonResult({ proposalId, approved: false, status: 'timeout', message: 'No Binance Futures order was submitted.' });
});

server.registerTool('signal402_confirm_futures_execution', {
  title: 'Confirm the exact Futures order',
  description: 'Require the human to type CONFIRM after dashboard APPROVE. Returns the exact live MCP order fields for the host to submit. This tool itself does not submit an order.',
  inputSchema: {
    proposalId: z.string().min(1),
    confirmExecution: z.literal('CONFIRM'),
  },
}, async ({ proposalId, confirmExecution }) => {
  const proposal = await sellerRequest<Record<string, unknown>>('get', `/api/futures/proposal/${encodeURIComponent(proposalId)}`);
  if (proposal.status !== 'approved') throw new Error(`Futures proposal ${proposalId} is not dashboard approved`);
  const confirmation = await sellerRequest<Record<string, unknown>>('post', '/api/futures/confirm', { proposalId, confirmExecution });
  await audit('host.futures.execution.confirmed', { proposalId });
  return jsonResult({
    readyToSubmit: true,
    confirmation,
    warning: 'Submit exactly one live USD M MARKET order through the runtime discovered Binance MCP Futures tool, then record its real events. Do not change leverage or margin mode.',
    order: {
      symbol: proposal.symbol,
      side: proposal.side,
      positionSide: proposal.positionSide,
      quantity: proposal.quantity,
      notionalUSDT: proposal.notionalUSDT,
      reduceOnly: proposal.reduceOnly,
      leverage: proposal.leverage,
      marginMode: proposal.marginMode,
      protectiveStopPrice: proposal.protectiveStopPrice,
      protectiveStopSupported: proposal.protectiveStopSupported,
      marketType: proposal.marketType,
    },
  });
});

server.registerTool('signal402_record_fill', {
  title: 'Record a real Binance MCP fill',
  description: 'Record a fill only after the host has called the real Binance MCP Spot order and balance tools.',
  inputSchema: {
    proposalId: z.string().min(1),
    planId: z.string().min(1).optional(),
    planHash: z.string().regex(/^[0-9a-f]{64}$/).optional(),
    asset: z.string().min(1),
    orderId: z.string().min(1),
    filledPrice: z.number().finite().positive(),
    executedQty: z.number().finite().positive(),
    quoteAmount: z.number().finite().positive().max(MAX_TRADE_SIZE_USDT),
    beforeBalances: z.array(balanceSchema).min(1),
    afterBalances: z.array(balanceSchema).min(1),
    mcpToolName: z.string().min(1),
  },
}, async ({ proposalId, planId, planHash, asset, orderId, filledPrice, executedQty, quoteAmount, beforeBalances, afterBalances, mcpToolName }) => {
  const proposal = await sellerRequest<Record<string, unknown>>('get', `/api/trade/proposal/${encodeURIComponent(proposalId)}`);
  if (proposal.status !== 'approved') throw new Error(`Proposal ${proposalId} is not approved. No fill can be recorded.`);
  const before = extractBalances(beforeBalances);
  const after = extractBalances(afterBalances);
  const beforeUsdt = extractUsdt(before);
  const afterUsdt = extractUsdt(after);
  if (beforeUsdt < quoteAmount) throw new Error('Before balance does not cover the real quote amount');
  if (afterUsdt >= beforeUsdt) throw new Error('Post trade USDT balance did not decrease; refusing an unverified fill');
  const baseAsset = asset.toUpperCase().endsWith('USDT') ? asset.slice(0, -4) : undefined;
  if (baseAsset && extractAsset(after, baseAsset) <= extractAsset(before, baseAsset)) {
    throw new Error(`Post trade ${baseAsset} balance did not increase; refusing an unverified fill`);
  }
  const result = await sellerRequest<Record<string, unknown>>('post', '/api/trade/status', {
    proposalId,
    ...(planId ? { planId } : {}),
    ...(planHash ? { planHash } : {}),
    asset: asset.toUpperCase(),
    status: 'filled',
    orderId,
    filledPrice,
    executedQty,
    amountUSDT: quoteAmount,
    beforeBalances: before,
    afterBalances: after,
    source: 'binance-mcp-host',
    mcpToolName,
    reason: `Real Binance MCP Spot MARKET BUY ${orderId} recorded after human approval and post-trade balance read.`,
  });
  await audit('host.trade.filled', { proposalId, orderId, filledPrice, executedQty, quoteAmount, mcpToolName, beforeBalances: before, afterBalances: after });
  return jsonResult({ ...result, orderId, filledPrice, beforeBalances: before, afterBalances: after });
});

server.registerTool('signal402_record_futures_event', {
  title: 'Record a real Binance Futures event',
  description: 'Record an authenticated Futures user stream or order status event. Simulated IDs, fills, balances, and positions are rejected by the Seller.',
  inputSchema: { ...futuresStatusInputSchema.shape },
}, async (input) => {
  const parsed = futuresStatusInputSchema.safeParse(input);
  if (!parsed.success) throw new Error(`Invalid Futures event payload: ${parsed.error.message}`);
  const body = parsed.data;
  const result = await sellerRequest<Record<string, unknown>>('post', '/api/futures/status', body);
  await audit('host.futures.event.recorded', {
    proposalId: body.proposalId,
    eventType: body.eventType,
    status: body.status,
    orderId: body.orderId,
    mcpToolName: body.mcpToolName,
  });
  return jsonResult(result);
});

server.registerTool('signal402_get_state', {
  title: 'Read the Seller dashboard state',
  description: 'Read current Signal402 state, including payment receipt, risk decision, approval, and real order receipt.',
}, async () => {
  const state = await sellerRequest<Record<string, unknown>>('get', '/api/state');
  return jsonResult(state);
});

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Signal402 host agent MCP server ready. Binance OAuth remains owned by the supported MCP host.');
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
