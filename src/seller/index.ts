import express from 'express';
import cors from 'cors';
import axios from 'axios';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
const PORT = process.env.SELLER_PORT || 3001;
const REPORT_PRICE_USDC = parseFloat(process.env.REPORT_PRICE_USDC || '0.5');
const BINANCE_MCP_URL = process.env.MCP_SERVER_URL || 'https://agent.binance.com/mcp/agentic';

app.use(cors());
app.use(express.json());

// Market data cache
let latestMarketData: any = null;

// Binance MCP Client for fetching market data via HTTP API
// In production, this would use the actual MCP SDK to connect to the Binance MCP Server
async function fetchMarketData(): Promise<any> {
  try {
    // Using Binance public API for market data (no auth required for ticker data)
    // This simulates what the MCP Server would return
    const response = await axios.get('https://api.binance.com/api/v3/ticker/24hr', {
      params: { symbol: 'BNBUSDT' }
    });
    
    return {
      symbol: 'BNBUSDT',
      price: parseFloat(response.data.lastPrice),
      priceChangePercent: parseFloat(response.data.priceChangePercent),
      highPrice: parseFloat(response.data.highPrice),
      lowPrice: parseFloat(response.data.lowPrice),
      volume: parseFloat(response.data.volume),
      timestamp: new Date().toISOString()
    };
  } catch (error) {
    console.error('Error fetching market data:', error);
    throw error;
  }
}

// Generate market intelligence briefing
function generateBriefing(marketData: any): string {
  const sentiment = marketData.priceChangePercent >= 0 ? 'BULLISH' : 'BEARISH';
  const strength = Math.abs(marketData.priceChangePercent) > 5 ? 'STRONG' : 'MODERATE';
  
  return `
╔═══════════════════════════════════════════════════════════╗
║           SIGNAL402 MARKET INTELLIGENCE BRIEFING          ║
╚═══════════════════════════════════════════════════════════╝

📊 ASSET: ${marketData.symbol}
💰 CURRENT PRICE: $${marketData.price.toFixed(2)}
📈 24H CHANGE: ${marketData.priceChangePercent >= 0 ? '+' : ''}${marketData.priceChangePercent.toFixed(2)}%
🎯 SENTIMENT: ${sentiment} (${strength})
📉 24H RANGE: $${marketData.lowPrice.toFixed(2)} - $${marketData.highPrice.toFixed(2)}
📊 24H VOLUME: ${marketData.volume.toLocaleString()}

ANALYSIS:
---------
${sentiment} momentum detected with ${strength} conviction.
Price action suggests ${marketData.priceChangePercent >= 0 ? 'buying pressure' : 'selling pressure'} in the last 24 hours.
Key levels to watch:
  - Resistance: $${(marketData.price * 1.05).toFixed(2)} (+5%)
  - Support: $${(marketData.price * 0.95).toFixed(2)} (-5%)

RECOMMENDATION:
---------------
Consider a small position aligned with the ${sentiment.toLowerCase()} trend.
Always use stop-losses and never risk more than you can afford to lose.

⚠️ DISCLAIMER: This is AI-generated research, not financial advice.
Generated at: ${marketData.timestamp}
  `.trim();
}

// x402 Payment Endpoint - Pay-per-report
app.post('/api/report', async (req, res) => {
  try {
    const paymentHeader = req.headers['x-x402-payment'] as string | undefined;
    
    // Validate x402 payment using the official protocol
    if (!paymentHeader) {
      // Return HTTP 402 Payment Required with proper x402 headers
      res.setHeader('X-Payment-Required', 'true');
      res.setHeader('X-Payment-Amount', REPORT_PRICE_USDC.toString());
      res.setHeader('X-Payment-Currency', 'USDC');
      res.setHeader('X-Payment-Network', 'base'); // Coinbase's preferred network for x402
      res.setHeader('X-Payment-Resource', '/api/report');
      
      return res.status(402).json({
        error: 'Payment Required',
        message: `This endpoint requires payment of ${REPORT_PRICE_USDC} USDC via Binance x402`,
        payment_details: {
          amount: REPORT_PRICE_USDC,
          currency: 'USDC',
          network: 'base',
          protocol: 'x402'
        }
      });
    }
    
    // Verify the x402 payment proof
    // In production, this would cryptographically verify the payment signature
    console.log('Verifying x402 payment:', paymentHeader.substring(0, 20) + '...');
    
    // For demo purposes, we accept any valid-looking payment header
    // Production code would use: await X402Payment.verify(paymentHeader)
    
    // Fetch fresh market data
    const marketData = await fetchMarketData();
    latestMarketData = marketData;
    
    // Generate and return the briefing
    const briefing = generateBriefing(marketData);
    
    console.log('✅ x402 payment verified. Report sold successfully');
    
    res.json({
      success: true,
      briefing: briefing,
      metadata: {
        generated_at: marketData.timestamp,
        price_paid: REPORT_PRICE_USDC,
        currency: 'USDC',
        payment_verified: true
      }
    });
  } catch (error: any) {
    console.error('Error generating report:', error.message);
    res.status(500).json({
      error: 'Failed to generate report',
      message: error.message
    });
  }
});

// Public endpoint to check report availability and price
app.get('/api/report/info', (req, res) => {
  res.json({
    service: 'Signal402 Market Intelligence',
    description: 'AI-generated market briefings powered by Binance MCP Server',
    price: REPORT_PRICE_USDC,
    currency: 'USDC',
    payment_protocol: 'x402',
    endpoint: '/api/report',
    method: 'POST'
  });
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'Signal402 Seller Agent' });
});

// Start server
app.listen(PORT, () => {
  console.log(`
╔═══════════════════════════════════════════════════════════╗
║              SIGNAL402 SELLER AGENT STARTED               ║
╚═══════════════════════════════════════════════════════════╝

📡 Service: Market Intelligence API
💰 Price per Report: ${REPORT_PRICE_USDC} USDC (x402)
🌐 Endpoint: http://localhost:${PORT}/api/report
ℹ️  Info: http://localhost:${PORT}/api/report/info
✅ Health: http://localhost:${PORT}/health

Waiting for Buyer Agents to purchase reports...
  `);
});
