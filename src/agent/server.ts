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

dotenv.config({ path: resolve(dirname(fileURLToPath(import.meta.url)), '../../.env') });

const SELLER_ENDPOINT = process.env.SELLER_ENDPOINT_URL ?? 'http://localhost:3001';
const HOST_TOKEN = process.env.SIGNAL402_HOST_TOKEN;
const MAX_TRADE_SIZE_USDT = Math.min(Number.parseFloat(process.env.MAX_TRADE_SIZE_USDT ?? '10') || 10, 10);
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
3. Call signal402_publish_market with the live MCP result and the runtime tool names.
4. Call signal402_request_briefing to inspect the real B402 payment terms. Verify that the amount is 0.01 USDC and that the merchant terms are expected.
5. Ask the human to approve that exact payment. Only then call signal402_pay_briefing with confirmPayment=true.
6. Call the Binance MCP account balance tool. Pass the live USDT balance to signal402_create_proposal.
7. Wait for the human to press APPROVE in the Signal402 dashboard by calling signal402_wait_for_approval.
8. Only after approved, call the Binance MCP Spot order tool with one MARKET BUY capped at 10 USDT. Use the live tool schema. Never submit an order before approval.
9. Read the real order result and read balances again through Binance MCP. Call signal402_record_fill only with the real order ID, filled price, quantities, and before and after balances.

No simulated receipt, balance, fill, or order ID is accepted. No withdrawal or transfer action is allowed. Every write action needs explicit human approval.
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
  if (!HOST_TOKEN) {
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

server.registerTool('signal402_publish_market', {
  title: 'Publish live Binance MCP market data',
  description: 'Publish a ticker read by the supported Binance MCP host to the Seller dashboard. Public REST and invented values are rejected.',
  inputSchema: {
    symbol: z.string().min(1),
    price: z.number().finite().positive(),
    changePercent: z.number().finite().optional(),
    toolNames: z.array(z.string().min(1)).min(1),
    observedAt: z.string().datetime().optional(),
  },
}, async ({ symbol, price, changePercent, toolNames, observedAt }) => {
  const names = uniqueToolNames(toolNames);
  const result = await sellerRequest<Record<string, unknown>>('post', '/api/host/market', {
    source: 'binance-mcp',
    symbol: symbol.toUpperCase(),
    price,
    changePercent,
    toolNames: names,
    observedAt: observedAt ?? new Date().toISOString(),
  });
  await audit('host.market.published', { symbol: symbol.toUpperCase(), price, changePercent, toolNames: names });
  return jsonResult(result);
});

server.registerTool('signal402_request_briefing', {
  title: 'Request the real B402 terms',
  description: 'Request the Seller payment challenge without signing or sending a payment.',
}, async () => {
  const challenge = await requestReportChallenge(SELLER_ENDPOINT);
  pendingPaymentChallenge = challenge;
  pendingPaymentChallengeAt = Date.now();
  await audit('host.briefing.challenge', { url: challenge.url });
  return jsonResult({
    url: challenge.url,
    paymentRequirements: challenge.paymentRequirements,
    challenge: challenge.body,
    nextStep: 'Verify the exact 0.01 USDC terms with the human before paying.',
  });
});

server.registerTool('signal402_pay_briefing', {
  title: 'Pay for the briefing with Binance Agentic Wallet',
  description: 'Pay the real B402 challenge. confirmPayment must be true only after the human approves the exact payment terms.',
  inputSchema: { confirmPayment: z.boolean() },
}, async ({ confirmPayment }) => {
  if (!pendingPaymentChallenge || Date.now() - pendingPaymentChallengeAt > PAYMENT_CHALLENGE_TTL_MS) {
    pendingPaymentChallenge = undefined;
    pendingPaymentChallengeAt = 0;
    throw new Error('No fresh payment challenge is pending. Call signal402_request_briefing first.');
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
  return jsonResult({ paid: true, paymentReceiptId: report.paymentReceiptId, report: report.body });
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
  description: 'Create a proposal from live Binance MCP balance data. Refused proposals never create an order intent.',
  inputSchema: {
    proposalId: z.string().min(1).optional(),
    asset: z.string().min(1),
    amountUSDT: z.number().finite().positive().max(MAX_TRADE_SIZE_USDT),
    balanceUSDT: z.number().finite(),
    paymentReceiptId: z.string().min(1),
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
    riskStatus: assessment.approved ? 'approved' : 'refused',
    status: assessment.approved ? 'pending' : 'refused',
    reason: `${reason}. ${assessment.reason}`,
    paymentReceiptId,
  });
  if (!assessment.approved) {
    await sellerRequest('post', '/api/trade/status', {
      proposalId: id,
      status: 'refused',
      riskStatus: 'refused',
      reason: assessment.reason,
    });
  }
  await audit('host.trade.proposal', { proposalId: id, asset: asset.toUpperCase(), amountUSDT, balanceUSDT, approved: assessment.approved });
  return jsonResult({ ...result, assessment, proposalId: id });
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

server.registerTool('signal402_record_fill', {
  title: 'Record a real Binance MCP fill',
  description: 'Record a fill only after the host has called the real Binance MCP Spot order and balance tools.',
  inputSchema: {
    proposalId: z.string().min(1),
    asset: z.string().min(1),
    orderId: z.string().min(1),
    filledPrice: z.number().finite().positive(),
    executedQty: z.number().finite().positive(),
    quoteAmount: z.number().finite().positive().max(MAX_TRADE_SIZE_USDT),
    beforeBalances: z.array(balanceSchema).min(1),
    afterBalances: z.array(balanceSchema).min(1),
    mcpToolName: z.string().min(1),
  },
}, async ({ proposalId, asset, orderId, filledPrice, executedQty, quoteAmount, beforeBalances, afterBalances, mcpToolName }) => {
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
    asset: asset.toUpperCase(),
    side: 'BUY',
    status: 'filled',
    riskStatus: 'approved',
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

server.registerTool('signal402_get_state', {
  title: 'Read the Seller dashboard state',
  description: 'Read current Signal402 state, including payment receipt, risk decision, approval, and real order receipt.',
}, async () => {
  const state = await axios.get<Record<string, unknown>>(`${SELLER_ENDPOINT.replace(/\/$/, '')}/api/state`, { timeout: 10_000 });
  return jsonResult(state.data);
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
