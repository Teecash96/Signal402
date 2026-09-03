# Signal402 📡💸
An agent-to-agent market-intelligence marketplace built on Binance Agent OS.

## 🏗️ Architecture
1. **Binance MCP Server:** Fetches live BNB/BTC data and executes human-confirmed Spot trades.
2. **Binance x402:** Machine-to-machine settlement for research reports.
3. **Agentic Sub-Accounts:** Total fund isolation; no withdrawal scopes granted.

## 🚀 Quick Start
```bash
git clone https://github.com/Teecash96/Signal402.git
cd Signal402
npm install
npm run start:seller  # Terminal 1
npm run start:buyer   # Terminal 2
```

## 📋 Prerequisites
- KYC'd Binance account
- Desktop with MCP-compatible AI client
- 10-20 USDT for testing

## 🔧 Setup
1. Connect your AI client to Binance MCP Server (Streamable HTTP: `https://agent.binance.com/mcp/agentic`)
2. Grant Market data + Account + Spot scopes (NO withdrawal permissions)
3. Fund your Agentic sub-account via Binance web UI
4. Copy `.env.example` to `.env` and fill in your credentials

## 🛡️ Safety Features (Judge Evaluation Criteria)
- ✅ **No Withdrawal Permissions:** Agents cannot withdraw funds
- ✅ **Human-in-the-Loop:** Every trade requires typing "CONFIRM"
- ✅ **Micro Trade Caps:** Maximum trade size limited to ~10 USDT

## 📁 Project Structure
```
src/
├── seller/       # Seller Agent (Analyst) - Sells market intelligence
│   └── index.ts
└── buyer/        # Buyer Agent (Trader) - Buys reports & executes trades
    └── index.ts
```

## 🎯 How It Works
1. **Seller Agent** connects to Binance MCP Server, fetches live market data
2. Generates structured market briefing and publishes behind x402 paywall (0.5 USDC)
3. **Buyer Agent** discovers endpoint, pays via x402 from isolated Agentic sub-account
4. Buyer consumes research, proposes small Spot trade
5. **Human must type "CONFIRM"** to execute the trade via MCP

## 📄 License
ISC
