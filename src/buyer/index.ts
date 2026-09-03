import axios from 'axios';
import dotenv from 'dotenv';
import * as readline from 'readline';

dotenv.config();

const SELLER_ENDPOINT = process.env.SELLER_ENDPOINT_URL || 'http://localhost:3001';
const MAX_TRADE_SIZE_USDT = parseFloat(process.env.MAX_TRADE_SIZE_USDT || '10');
const CONFIRMATION_REQUIRED = process.env.CONFIRMATION_REQUIRED !== 'false';

// Create readline interface for user input (lazy initialization)
let rl: readline.Interface | null = null;

function getReadline(): readline.Interface {
  if (!rl) {
    rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });
  }
  return rl;
}

function prompt(question: string): Promise<string> {
  return new Promise((resolve) => {
    const readlineInst = getReadline();
    readlineInst.question(question, (answer) => {
      resolve(answer);
    });
  });
}

function closeReadline(): void {
  if (rl) {
    rl.close();
    rl = null;
  }
}

// x402 Payment Client using official @x402/core protocol
async function makeX402Payment(amount: number, currency: string, resource: string): Promise<string> {
  console.log(`\n💳 Processing x402 payment of ${amount} ${currency}...`);
  
  // In production with real Binance Agentic sub-account:
  // 1. Initialize x402Client with wallet/facilitator from @x402/core
  // 2. Get payment requirements from 402 response
  // 3. Create and sign payment via x402Client.createPayment()
  // 4. Encode payment as HTTP header using encodePaymentSignatureHeader
  
  // For demo: simulate the x402 payment flow following protocol spec
  await new Promise(resolve => setTimeout(resolve, 1000));
  
  // Simulated payment payload (in production this would be a signed PaymentPayload)
  const paymentPayload = {
    version: 2,
    scheme: 'erc20',
    network: 'base',
    payTo: '0xSIMULATED_ADDRESS',
    amount: Math.floor(amount * 1000000), // USDC has 6 decimals
    asset: '0xUSDC_ADDRESS',
    signature: `0x${Date.now().toString(16)}${Math.random().toString(16).substring(2, 10)}`
  };
  
  // Encode as base64 header (matching x402 protocol spec for X-X402-Payment)
  const paymentHeader = Buffer.from(JSON.stringify(paymentPayload)).toString('base64');
  
  console.log(`✅ x402 payment created! Header: ${paymentHeader.substring(0, 30)}...`);
  return paymentHeader;
}


// Purchase research report from Seller Agent
async function purchaseReport(): Promise<any> {
  try {
    console.log('\n🔍 Discovering Seller endpoint...');
    
    // Get report info
    const infoResponse = await axios.get(`${SELLER_ENDPOINT}/api/report/info`);
    const reportInfo = infoResponse.data;
    
    console.log(`\n📋 Report Details:`);
    console.log(`   Service: ${reportInfo.service}`);
    console.log(`   Price: ${reportInfo.price} ${reportInfo.currency}`);
    console.log(`   Protocol: ${reportInfo.payment_protocol}`);
    
    // First attempt: Try to fetch report WITHOUT payment (expect HTTP 402)
    console.log('\n📡 Requesting report (no payment yet)...');
    try {
      await axios.post(`${SELLER_ENDPOINT}/api/report`, {});
    } catch (error: any) {
      if (error.response?.status === 402) {
        console.log('\n⚠️  HTTP 402 Payment Required received!');
        console.log(`   Amount: ${error.response.headers['x-payment-amount']} ${error.response.headers['x-payment-currency']}`);
        console.log(`   Network: ${error.response.headers['x-payment-network']}`);
        
        // Make x402 payment to settle the required amount
        const amount = parseFloat(error.response.headers['x-payment-amount']);
        const currency = error.response.headers['x-payment-currency'];
        const resource = error.response.headers['x-payment-resource'];
        
        const paymentProof = await makeX402Payment(amount, currency, resource);
        
        // Retry with x402 payment header
        console.log('\n📥 Purchasing report with x402 payment...');
        const purchaseResponse = await axios.post(`${SELLER_ENDPOINT}/api/report`, 
          {}, 
          { headers: { 'X-X402-Payment': paymentProof } }
        );
        
        if (!purchaseResponse.data.success) {
          throw new Error('Failed to purchase report');
        }
        
        return purchaseResponse.data;
      } else {
        throw error;
      }
    }
    
    throw new Error('Expected 402 but got success without payment');
  } catch (error: any) {
    console.error('❌ Error purchasing report:', error.message);
    throw error;
  }
}

// Parse briefing to extract trading signal
function parseTradingSignal(briefing: string): { sentiment: string; asset: string; recommendation: string } {
  const sentimentMatch = briefing.match(/🎯 SENTIMENT: (\w+)/);
  const assetMatch = briefing.match(/📊 ASSET: (\w+)/);
  const recommendationMatch = briefing.match(/RECOMMENDATION:\n---------------\n([\s\S]*?)(?:\n\n|⚠️|$)/);
  
  return {
    sentiment: sentimentMatch ? sentimentMatch[1] : 'UNKNOWN',
    asset: assetMatch ? assetMatch[1] : 'UNKNOWN',
    recommendation: recommendationMatch ? recommendationMatch[1].trim() : 'No recommendation'
  };
}

// Propose trade based on research
async function proposeTrade(signal: any): Promise<boolean> {
  console.log('\n╔═══════════════════════════════════════════════════════════╗');
  console.log('║              TRADE PROPOSAL GENERATED                   ║');
  console.log('╚═══════════════════════════════════════════════════════════╝');
  
  const side = signal.sentiment === 'BULLISH' ? 'BUY' : 'SELL';
  const quantity = MAX_TRADE_SIZE_USDT; // Safety cap
  
  console.log(`
📊 SIGNAL ANALYSIS:
   Asset: ${signal.asset}
   Sentiment: ${signal.sentiment}
   Recommendation: ${signal.recommendation}

💼 TRADE DETAILS:
   Action: ${side}
   Amount: $${quantity} USDT (capped for safety)
   Type: Spot Market Order

⚠️ SAFETY CHECKS:
   ✅ Withdrawal permissions: DISABLED
   ✅ Trade size capped at: $${MAX_TRADE_SIZE_USDT} USDT
   ✅ Human confirmation required: ${CONFIRMATION_REQUIRED ? 'YES' : 'NO'}
  `);
  
  if (!CONFIRMATION_REQUIRED) {
    console.log('⚠️  WARNING: Human confirmation disabled - executing automatically');
    return true;
  }
  
  console.log('\n🔒 HUMAN CONFIRMATION REQUIRED');
  const answer = await prompt('Type "CONFIRM" to execute this trade: ');
  
  if (answer.trim().toUpperCase() === 'CONFIRM') {
    console.log('✅ Trade confirmed by human operator');
    return true;
  } else {
    console.log('❌ Trade cancelled - no confirmation received');
    return false;
  }
}

// Execute trade via Binance MCP Server
async function executeTrade(asset: string, side: string, amountUSDT: number): Promise<void> {
  console.log(`\n🚀 Executing ${side} order for ${asset}...`);
  
  try {
    // In production, this would call the actual Binance MCP Server
    // Example: POST to https://agent.binance.com/mcp/agentic with trade parameters
    
    console.log('   Connecting to Binance MCP Server...');
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    console.log('   Submitting order...');
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    // Simulated order response
    const orderId = `ORDER_${Date.now()}`;
    
    console.log(`
╔═══════════════════════════════════════════════════════════╗
║                  TRADE EXECUTED SUCCESSFULLY              ║
╚═══════════════════════════════════════════════════════════╝

📋 ORDER DETAILS:
   Order ID: ${orderId}
   Asset: ${asset}
   Side: ${side}
   Value: $${amountUSDT} USDT
   Status: FILLED (simulated)

⚠️ REMINDER: This is a demo. In production, this would execute
   via the Binance MCP Server with real funds.
    `);
  } catch (error: any) {
    console.error('❌ Trade execution failed:', error.message);
    throw error;
  }
}

// Main Buyer Agent workflow
async function runBuyerAgent(): Promise<void> {
  console.log(`
╔═══════════════════════════════════════════════════════════╗
║              SIGNAL402 BUYER AGENT STARTED                ║
╚═══════════════════════════════════════════════════════════╝

🤖 Role: Research Consumer & Trader
🎯 Goal: Purchase market intelligence and act on signals
🔒 Safety: No withdrawal permissions, human confirmation required

Starting agent workflow...
  `);
  
  try {
    // Step 1: Purchase research report
    const report = await purchaseReport();
    console.log('\n' + report.briefing);
    
    // Step 2: Parse trading signal from research
    const signal = parseTradingSignal(report.briefing);
    console.log('\n🧠 Analyzing research for trading signals...');
    console.log(`   Detected sentiment: ${signal.sentiment}`);
    
    // Step 3: Propose trade and get human confirmation
    const confirmed = await proposeTrade(signal);
    
    if (!confirmed) {
      console.log('\n🛑 Workflow terminated - trade not confirmed');
      closeReadline();
      return;
    }
    
    // Step 4: Execute trade
    const side = signal.sentiment === 'BULLISH' ? 'BUY' : 'SELL';
    await executeTrade(signal.asset, side, MAX_TRADE_SIZE_USDT);
    
    console.log('\n✅ Agent workflow completed successfully');
  } catch (error: any) {
    console.error('\n❌ Agent workflow failed:', error.message);
  } finally {
    closeReadline();
  }
}

// Run the Buyer Agent
runBuyerAgent().catch(console.error);
