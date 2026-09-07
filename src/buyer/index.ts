import 'dotenv/config';

import axios from 'axios';
import { audit } from '../lib/audit.js';
import { validateSellerEndpoint } from '../lib/endpointSecurity.js';
import { BinanceMcpClient, extractUsdtBalance, type BinanceBalance, type BinanceOrder } from '../lib/binanceMcp.js';
import { purchaseReport, type PaidReport } from '../lib/binanceX402Client.js';
import { assessLiveTradeRisk, type RiskAssessment } from './riskGuardian.js';

const SELLER_ENDPOINT = process.env.SELLER_ENDPOINT_URL ?? 'http://localhost:3001';
validateSellerEndpoint(SELLER_ENDPOINT);
const SYMBOL = (process.env.TRADE_SYMBOL ?? 'BNBUSDT').toUpperCase();
const configuredMax = Number.parseFloat(process.env.MAX_TRADE_SIZE_USDT ?? '10');
const MAX_TRADE_SIZE_USDT = Number.isFinite(configuredMax) ? Math.min(configuredMax, 10) : 10;
const APPROVAL_TIMEOUT_MS = Number.parseInt(process.env.APPROVAL_TIMEOUT_MS ?? '300000', 10);
const APPROVAL_POLL_MS = Number.parseInt(process.env.APPROVAL_POLL_MS ?? '1000', 10);
const HOST_TOKEN = process.env.SIGNAL402_HOST_TOKEN ?? '';

function sellerAuthConfig(): { headers: { Authorization: string } } {
  return { headers: { Authorization: `Bearer ${HOST_TOKEN}` } };
}

type Signal = {
  direction: string;
  action: 'BUY_SMALL' | 'WAIT';
  risk: string;
  confidence: string;
  asset: string;
  recommendation: string;
};

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function parseTradingSignal(briefing: string): Signal {
  const direction = briefing.match(/DIRECTION:\s*([A-Z]+)/i)?.[1]?.toUpperCase() ?? 'UNKNOWN';
  const action = briefing.match(/RULE ACTION:\s*(BUY_SMALL|WAIT)/i)?.[1]?.toUpperCase() as Signal['action'] | undefined;
  const risk = briefing.match(/RISK TIER:\s*([A-Z]+)/i)?.[1]?.toUpperCase() ?? 'UNKNOWN';
  const confidence = briefing.match(/CONFIDENCE:\s*([A-Z]+)/i)?.[1]?.toUpperCase() ?? 'UNKNOWN';
  const asset = briefing.match(/ASSET:\s*([A-Z0-9]+)/i)?.[1]?.toUpperCase() ?? SYMBOL;
  const recommendation = briefing.match(/THESIS:\s*(.+)/i)?.[1]?.trim() ?? 'No screening thesis';
  return { direction, action: action ?? 'WAIT', risk, confidence, asset, recommendation };
}

function balanceSnapshot(balances: BinanceBalance[]): Array<{ asset: string; free: number; locked: number }> {
  return balances.map((balance) => ({ asset: balance.asset, free: balance.free, locked: balance.locked }));
}

async function publishRiskRefusal(
  signal: Signal,
  risk: RiskAssessment,
  paymentReceiptId: string | undefined,
  beforeBalances: BinanceBalance[],
  existingProposalId?: string,
): Promise<string> {
  const proposalId = existingProposalId ?? `risk_${Date.now()}`;
  if (!existingProposalId) {
    await axios.post(`${SELLER_ENDPOINT}/api/trade/proposal`, {
      proposalId,
      asset: signal.asset,
      side: 'BUY',
      amountUSDT: risk.proposedSizeUSDT,
      balanceUSDT: risk.balanceUSDT,
      reason: risk.reason,
      ...(paymentReceiptId ? { paymentReceiptId } : {}),
    }, sellerAuthConfig());
  }
  await axios.post(`${SELLER_ENDPOINT}/api/trade/status`, {
    proposalId,
    status: 'refused',
    reason: risk.reason,
  }, sellerAuthConfig());
  await audit('buyer.risk.refused', { proposalId, asset: signal.asset, proposedSizeUSDT: risk.proposedSizeUSDT, balanceUSDT: risk.balanceUSDT });
  return proposalId;
}

async function createTradeProposal(signal: Signal, risk: RiskAssessment, paymentReceiptId: string): Promise<string> {
  const proposalId = `proposal_${Date.now()}`;
  const response = await axios.post(`${SELLER_ENDPOINT}/api/trade/proposal`, {
    proposalId,
    asset: signal.asset,
    side: 'BUY',
    amountUSDT: risk.proposedSizeUSDT,
    balanceUSDT: risk.balanceUSDT,
    reason: risk.reason,
    paymentReceiptId,
  }, sellerAuthConfig());
  if (!response.data?.proposalId) throw new Error('Seller did not create a trade proposal');
  await audit('buyer.trade.proposed', { proposalId, asset: signal.asset, amountUSDT: risk.proposedSizeUSDT, balanceUSDT: risk.balanceUSDT });
  return `${response.data.proposalId}`;
}

async function waitForDashboardApproval(proposalId: string): Promise<boolean> {
  const deadline = Date.now() + APPROVAL_TIMEOUT_MS;
  console.log(`\n🖥️  Proposal ${proposalId} is waiting in the Seller dashboard.`);
  console.log('   Open http://localhost:3001 and click APPROVE.');
  while (Date.now() < deadline) {
    const response = await axios.get(`${SELLER_ENDPOINT}/api/trade/proposal/${encodeURIComponent(proposalId)}`, sellerAuthConfig());
    const status = `${response.data.status}`;
    if (status === 'approved') return true;
    if (status === 'refused' || status === 'cancelled') return false;
    await sleep(APPROVAL_POLL_MS);
  }
  await audit('buyer.trade.approval_timeout', { proposalId });
  console.log('⌛ Dashboard approval timed out. No order was submitted.');
  return false;
}

function filledPrice(order: BinanceOrder): number | undefined {
  if (order.averagePrice !== undefined && Number.isFinite(order.averagePrice) && order.averagePrice > 0) return order.averagePrice;
  if (order.quoteAmount !== undefined && order.executedQty !== undefined && order.executedQty > 0) return order.quoteAmount / order.executedQty;
  return undefined;
}

async function publishTradeFilled(
  proposalId: string,
  signal: Signal,
  order: BinanceOrder,
  before: BinanceBalance[],
  after: BinanceBalance[],
): Promise<void> {
  const price = filledPrice(order);
  if (price === undefined) throw new Error('MCP order response did not include a real filled price');
  await axios.post(`${SELLER_ENDPOINT}/api/trade/status`, {
    proposalId,
    amountUSDT: order.quoteAmount,
    status: 'filled',
    orderId: order.orderId,
    filledPrice: price,
    executedQty: order.executedQty,
    source: 'binance-mcp-direct-approved',
    mcpToolName: order.mcpToolName,
    beforeBalances: balanceSnapshot(before),
    afterBalances: balanceSnapshot(after),
    reason: `Real Binance MCP Spot MARKET BUY ${order.orderId} confirmed with post-trade balance read.`,
  }, sellerAuthConfig());
  await audit('buyer.trade.filled', { proposalId, orderId: order.orderId, filledPrice: price, beforeBalances: balanceSnapshot(before), afterBalances: balanceSnapshot(after) });
}

async function executeApprovedTrade(
  mcp: BinanceMcpClient,
  proposalId: string,
  signal: Signal,
): Promise<void> {
  const liveRisk = await assessLiveTradeRisk(mcp, MAX_TRADE_SIZE_USDT);
  const beforeBalances = liveRisk.balances;
  const beforeUSDT = extractUsdtBalance(beforeBalances);
  const finalRisk = liveRisk.assessment;
  if (!finalRisk.approved) {
    await publishRiskRefusal(signal, finalRisk, undefined, beforeBalances, proposalId);
    throw new Error(`Risk Guardian refused after approval because the live balance changed: ${finalRisk.reason}`);
  }
  if (beforeUSDT < MAX_TRADE_SIZE_USDT) throw new Error('Live USDT balance is below the capped order size');
  console.log(`\n🚀 Human approval received. Submitting REAL Binance MCP Spot MARKET BUY for ${MAX_TRADE_SIZE_USDT.toFixed(2)} USDT.`);
  const order = await mcp.placeSpotOrder({ symbol: signal.asset || SYMBOL, side: 'BUY', quoteOrderQty: MAX_TRADE_SIZE_USDT });
  const afterBalances = await mcp.getBalances();
  const price = filledPrice(order);
  if (!price) throw new Error(`Binance returned order ${order.orderId} without a filled price`);
  console.log('\n✅ Trade FILLED!');
  console.log(`   Real order ID: ${order.orderId}`);
  console.log(`   Filled price: ${price}`);
  console.log(`   USDT before: ${beforeUSDT.toFixed(8)}`);
  console.log(`   USDT after: ${extractUsdtBalance(afterBalances).toFixed(8)}`);
  await publishTradeFilled(proposalId, signal, order, beforeBalances, afterBalances);
}

async function runBuyerAgent(): Promise<void> {
  if ((process.env.SIGNAL402_BINANCE_MODE ?? 'host') !== 'direct') {
    console.error('The Buyer CLI direct path is disabled in supported host mode. Configure the Signal402 MCP server in Codex, Claude, Cursor, or ChatGPT and call signal402_get_workflow.');
    process.exitCode = 1;
    return;
  }
  console.log(`\nSIGNAL402 BUYER AGENT\nReal Binance payment, real MCP account reads, real Spot order after dashboard approval.\nOrder cap: ${MAX_TRADE_SIZE_USDT.toFixed(2)} USDT\n`);
  if (configuredMax > 10) console.log('MAX_TRADE_SIZE_USDT was above the hard 10 USDT safety cap. It was reduced to 10 USDT.');
  const mcp = new BinanceMcpClient();
  let report: PaidReport | undefined;
  try {
    report = await purchaseReport(SELLER_ENDPOINT);
    const briefing = typeof report.body === 'object' && report.body && 'briefing' in report.body
      ? `${(report.body as { briefing: unknown }).briefing}`
      : '';
    if (!briefing) throw new Error('Paid seller response did not include a briefing');
    console.log(`\n${briefing}`);
    console.log(`\n💳 Real x402 settlement receipt: ${report.paymentReceiptId}`);
    const signal = parseTradingSignal(briefing);
    if (signal.action !== 'BUY_SMALL') {
      console.log(`\n🧭 SIGNAL402 SCREEN: WAIT`);
      console.log(`   Direction: ${signal.direction}. Risk: ${signal.risk}. Confidence: ${signal.confidence}.`);
      console.log(`   ${signal.recommendation}`);
      console.log('   No balance read, proposal, or order was submitted.');
      await audit('buyer.signal.wait', { asset: signal.asset, direction: signal.direction, risk: signal.risk, confidence: signal.confidence });
      return;
    }
    await mcp.connect();
    const liveRisk = await assessLiveTradeRisk(mcp, MAX_TRADE_SIZE_USDT);
    const beforeBalances = liveRisk.balances;
    const balanceUSDT = extractUsdtBalance(beforeBalances);
    const risk = liveRisk.assessment;
    console.log(`\n🛡️  RISK GUARDIAN: ${risk.approved ? 'approved' : 'refused'}`);
    console.log(`   ${risk.reason}`);
    if (!risk.approved) {
      await publishRiskRefusal(signal, risk, report.paymentReceiptId, beforeBalances);
      console.log('🛑 No order was submitted. The dashboard shows the refusal.');
      return;
    }
    const proposalId = await createTradeProposal(signal, risk, report.paymentReceiptId);
    const approved = await waitForDashboardApproval(proposalId);
    if (!approved) {
      await axios.post(`${SELLER_ENDPOINT}/api/trade/status`, { proposalId, status: 'cancelled', reason: 'Human dashboard approval was not received.' }, sellerAuthConfig());
      console.log('🛑 No order was submitted.');
      return;
    }
    await executeApprovedTrade(mcp, proposalId, signal);
    console.log('\n✅ Buyer workflow completed with real settlement and real Binance order data.');
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`\n❌ Buyer workflow stopped: ${message}`);
    await audit('buyer.workflow.error', { error: message, paymentReceiptId: report?.paymentReceiptId });
  } finally {
    await mcp.close();
  }
}

void runBuyerAgent();
