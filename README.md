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
DEMO_BALANCE_USDT=10 npm run start:buyer  # Terminal 2
```

Open `http://localhost:3001/` after starting the Seller. The dashboard shows live
BNBUSDT data from Binance, the x402 report count, the Risk Guardian state, and the
human approval button for a pending trade.

To demonstrate the refusal path, start the Buyer with a balance below the capped
trade size:

```bash
DEMO_BALANCE_USDT=2 npm run start:buyer
```

The Buyer reports `RISK GUARDIAN: refused` and the dashboard displays a red badge.
With `DEMO_BALANCE_USDT=10`, the Buyer waits for the dashboard approval. Click
`APPROVE TRADE` to complete the simulated order.

## 📋 Prerequisites
- KYC'd Binance account
- Desktop with MCP-compatible AI client
- 10-20 USDT for testing

## 🔧 Setup
1. Connect your AI client to Binance MCP Server (Streamable HTTP: `https://agent.binance.com/mcp/agentic`)
2. Grant Market data + Account + Spot scopes (NO withdrawal permissions)
3. Fund your Agentic sub-account via Binance web UI if you are connecting a real MCP account
4. Copy `.env.example` to `.env` and fill in your credentials if your deployment needs them

## 🛡️ Safety Features (Judge Evaluation Criteria)
- ✅ **No Withdrawal Permissions:** Agents cannot withdraw funds
- ✅ **Human-in-the-Loop:** Every trade requires dashboard approval (or `APPROVAL_MODE=terminal` confirmation)
- ✅ **Micro Trade Caps:** Maximum trade size limited to ~10 USDT

## 📁 Project Structure
```
src/
├── seller/       # Seller Agent (Analyst) - Sells market intelligence
│   └── index.ts
└── buyer/        # Buyer Agent (Trader) - Buys reports & executes trades
    ├── index.ts
    └── riskGuardian.ts
```

## 🎯 How It Works
1. **Seller Agent** fetches live BNBUSDT data from Binance REST and serves the dashboard
2. Generates a structured market briefing and publishes it behind an x402 paywall (0.01 USDC)
3. **Buyer Agent** discovers endpoint, pays via x402 from isolated Agentic sub-account
4. Buyer consumes research and runs the Risk Guardian against its available USDT
5. An approved trade appears in the dashboard for human approval
6. The demo marks the approved Spot order as `FILLED` after the simulated MCP call

## 📄 License
ISC
