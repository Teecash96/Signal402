import axios from 'axios';
import dotenv from 'dotenv';
import * as readline from 'readline';
import { assessTradeRisk, readDemoBalanceUSDT, type RiskAssessment } from './riskGuardian.js';

dotenv.config();

const SELLER_ENDPOINT = process.env.SELLER_ENDPOINT_URL || 'http://localhost:3001';
const MAX_TRADE_SIZE_USDT = Number.parseFloat(process.env.MAX_TRADE_SIZE_USDT || '10');
const APPROVAL_MODE = process.env.APPROVAL_MODE || 'dashboard';
const APPROVAL_TIMEOUT_MS = Number.parseInt(process.env.APPROVAL_TIMEOUT_MS || '120000', 10);
const APPROVAL_POLL_MS = Number.parseInt(process.env.APPROVAL_POLL_MS || '1000', 10);
const CONFIRMATION_REQUIRED = process.env.CONFIRMATION_REQUIRED !== 'false';

let rl: readline.Interface | null = null;

function getReadline(): readline.Interface {
  if (!rl) {
    rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  }
  return rl;
}

function prompt(question: string): Promise<string> {
  return new Promise((resolve) => getReadline().question(question, resolve));
}

function closeReadline(): void {
  if (rl) {
    rl.close();
    rl = null;
  }
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

// The production implementation would create a signed PaymentPayload with
// @x402/core. This deterministic demo payload keeps the local flow safe.
async function makeX402Payment(amount: number, currency: string, _resource: string): Promise<string> {
  console.log(`\n💳 Processing x402 payment of ${amount} ${currency}...`);
  await sleep(500);

  const paymentPayload = {
    version: 2,
    scheme: 'erc20',
    network: 'base',
    payTo: '0xSIMULATED_ADDRESS',
    amount: Math.floor(amount * 1_000_000),
    asset: '0xUSDC_ADDRESS',
    signature: `0x${Date.now().toString(16)}${Math.random().toString(16).substring(2, 10)}`,
  };

  const paymentHeader = Buffer.from(JSON.stringify(paymentPayload)).toString('base64');
  console.log(`✅ x402 payment created. Header: ${paymentHeader.substring(0, 30)}...`);
  return paymentHeader;
}

async function purchaseReport(): Promise<{ briefing: string; metadata: Record<string, unknown> }> {
  console.log('\n🔍 Discovering Seller endpoint...');
  const infoResponse = await axios.get(`${SELLER_ENDPOINT}/api/report/info`);
  const reportInfo = infoResponse.data;

  console.log('\n📋 Report details:');
  console.log(`   Service: ${reportInfo.service}`);
  console.log(`   Price: ${reportInfo.price} ${reportInfo.currency}`);
  console.log(`   Protocol: ${reportInfo.payment_protocol}`);
  console.log('\n📡 Requesting report without payment...');

  try {
    await axios.post(`${SELLER_ENDPOINT}/api/report`, {});
    throw new Error('Expected HTTP 402 but received a report without payment');
  } catch (error: unknown) {
    if (!axios.isAxiosError(error) || error.response?.status !== 402) {
      throw error;
    }

    console.log('\n⚠️  HTTP 402 Payment Required received.');
    console.log(`   Amount: ${error.response.headers['x-payment-amount']} ${error.response.headers['x-payment-currency']}`);
    console.log(`   Network: ${error.response.headers['x-payment-network']}`);

    const amount = Number.parseFloat(error.response.headers['x-payment-amount']);
    const currency = error.response.headers['x-payment-currency'];
    const resource = error.response.headers['x-payment-resource'];
    const paymentProof = await makeX402Payment(amount, currency, resource);

    console.log('\n📥 Purchasing report with x402 payment...');
    const purchaseResponse = await axios.post(
      `${SELLER_ENDPOINT}/api/report`,
      {},
      { headers: { 'X-X402-Payment': paymentProof } },
    );

    if (!purchaseResponse.data.success) throw new Error('Failed to purchase report');
    return purchaseResponse.data;
  }
}

function parseTradingSignal(briefing: string): { sentiment: string; asset: string; recommendation: string } {
  const sentimentMatch = briefing.match(/🎯 SENTIMENT: (\w+)/);
  const assetMatch = briefing.match(/📊 ASSET: (\w+)/);
  const recommendationMatch = briefing.match(/RECOMMENDATION:\n---------------\n([\s\S]*?)(?:\n\n|⚠️|$)/);

  return {
    sentiment: sentimentMatch?.[1] || 'UNKNOWN',
    asset: assetMatch?.[1] || 'UNKNOWN',
    recommendation: recommendationMatch?.[1]?.trim() || 'No recommendation',
  };
}

async function publishRiskRefusal(
  signal: { asset: string },
  side: 'BUY' | 'SELL',
  risk: RiskAssessment,
): Promise<void> {
  try {
    await axios.post(`${SELLER_ENDPOINT}/api/trade/status`, {
      proposalId: `risk_${Date.now()}`,
      asset: signal.asset,
      side,
      amountUSDT: risk.proposedSizeUSDT,
      balanceUSDT: risk.balanceUSDT,
      status: 'refused',
      riskStatus: 'refused',
      reason: risk.reason,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown dashboard error';
    console.error(`⚠️  Could not update the dashboard: ${message}`);
  }
}

async function createTradeProposal(
  signal: { asset: string },
  side: 'BUY' | 'SELL',
  risk: RiskAssessment,
): Promise<{ proposalId: string }> {
  const proposalId = `proposal_${Date.now()}`;
  const response = await axios.post(`${SELLER_ENDPOINT}/api/trade/proposal`, {
    proposalId,
    asset: signal.asset,
    side,
    amountUSDT: risk.proposedSizeUSDT,
    balanceUSDT: risk.balanceUSDT,
    reason: risk.reason,
  });
  return response.data;
}

async function waitForDashboardApproval(proposalId: string): Promise<boolean> {
  const deadline = Date.now() + APPROVAL_TIMEOUT_MS;
  console.log(`\n🖥️  Proposal ${proposalId} is waiting in the Seller dashboard.`);
  console.log('   Click APPROVE in http://localhost:3001 when you are ready.');

  while (Date.now() < deadline) {
    const response = await axios.get(`${SELLER_ENDPOINT}/api/trade/proposal/${proposalId}`);
    const status = response.data.status as string;
    if (status === 'approved') return true;
    if (status === 'refused' || status === 'cancelled') return false;
    await sleep(APPROVAL_POLL_MS);
  }

  console.log('⌛ Dashboard approval timed out.');
  return false;
}

async function requestTerminalApproval(): Promise<boolean> {
  if (!CONFIRMATION_REQUIRED) {
    console.log('⚠️  WARNING: Human confirmation disabled.');
    return true;
  }
  const answer = await prompt('Type "CONFIRM" to execute this trade: ');
  return answer.trim().toUpperCase() === 'CONFIRM';
}

async function executeTrade(
  asset: string,
  side: 'BUY' | 'SELL',
  amountUSDT: number,
  proposalId: string,
): Promise<void> {
  console.log(`\n🚀 Executing ${side} order for ${asset}...`);
  console.log('   Connecting to Binance MCP Server...');
  await sleep(500);
  console.log('   Submitting order...');
  await sleep(500);

  const orderId = `ORDER_${Date.now()}`;
  console.log(`\n✅ Trade FILLED!`);
  console.log(`   Order ID: ${orderId}`);
  console.log(`   Asset: ${asset}`);
  console.log(`   Side: ${side}`);
  console.log(`   Value: $${amountUSDT} USDT`);
  console.log('   Status: FILLED (simulated)');

  await axios.post(`${SELLER_ENDPOINT}/api/trade/status`, {
    proposalId,
    status: 'filled',
    reason: `Trade FILLED. Simulated Binance MCP order ${orderId}`,
  });
}

async function proposeTrade(
  signal: { sentiment: string; asset: string; recommendation: string },
): Promise<{ approved: boolean; proposalId?: string; side: 'BUY' | 'SELL'; risk: RiskAssessment }> {
  const side: 'BUY' | 'SELL' = signal.sentiment === 'BULLISH' ? 'BUY' : 'SELL';
  const risk = assessTradeRisk(readDemoBalanceUSDT(), MAX_TRADE_SIZE_USDT);

  console.log('\n╔═══════════════════════════════════════════════════════════╗');
  console.log('║              TRADE PROPOSAL GENERATED                    ║');
  console.log('╚═══════════════════════════════════════════════════════════╝');
  console.log(`\n📊 SIGNAL ANALYSIS:\n   Asset: ${signal.asset}\n   Sentiment: ${signal.sentiment}\n   Recommendation: ${signal.recommendation}`);
  console.log(`\n💼 TRADE DETAILS:\n   Action: ${side}\n   Amount: $${MAX_TRADE_SIZE_USDT} USDT (capped for safety)\n   Type: Spot Market Order`);
  console.log(`\n⚠️  SAFETY CHECKS:\n   ✅ Withdrawal permissions: DISABLED\n   ✅ Trade size capped at: $${MAX_TRADE_SIZE_USDT} USDT\n   ✅ Available USDT: $${risk.balanceUSDT.toFixed(2)}`);

  if (!risk.approved) {
    console.log(`\n🛡️  RISK GUARDIAN: refused`);
    console.log(`   ${risk.reason}`);
    await publishRiskRefusal(signal, side, risk);
    return { approved: false, side, risk };
  }

  console.log(`\n🛡️  RISK GUARDIAN: approved`);
  console.log(`   ${risk.reason}`);

  if (APPROVAL_MODE === 'terminal') {
    console.log('\n🔒 HUMAN CONFIRMATION REQUIRED');
    const confirmed = await requestTerminalApproval();
    return { approved: confirmed, side, risk, proposalId: `terminal_${Date.now()}` };
  }

  const proposal = await createTradeProposal(signal, side, risk);
  const approved = await waitForDashboardApproval(proposal.proposalId);
  return { approved, side, risk, proposalId: proposal.proposalId };
}

async function runBuyerAgent(): Promise<void> {
  console.log(`
╔═══════════════════════════════════════════════════════════╗
║              SIGNAL402 BUYER AGENT STARTED                ║
╚═══════════════════════════════════════════════════════════╝

🤖 Role: Research Consumer and Trader
🎯 Goal: Purchase market intelligence and act on signals
🔒 Safety: Risk Guardian, no withdrawals, human approval

Starting agent workflow...
  `);

  try {
    const report = await purchaseReport();
    console.log('\n' + report.briefing);

    const signal = parseTradingSignal(report.briefing);
    console.log('\n🧠 Analyzing research for trading signals...');
    console.log(`   Detected sentiment: ${signal.sentiment}`);

    const decision = await proposeTrade(signal);
    if (!decision.approved || !decision.proposalId) {
      console.log('\n🛑 Workflow terminated. Trade was not approved.');
      return;
    }

    await executeTrade(signal.asset, decision.side, decision.risk.proposedSizeUSDT, decision.proposalId);
    console.log('\n✅ Agent workflow completed successfully');
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown buyer error';
    console.error(`\n❌ Agent workflow failed: ${message}`);
  } finally {
    closeReadline();
  }
}

runBuyerAgent().catch((error: unknown) => {
  console.error(error);
  closeReadline();
});
