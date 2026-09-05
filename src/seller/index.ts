import express from 'express';
import cors from 'cors';
import axios from 'axios';
import dotenv from 'dotenv';

dotenv.config();

interface MarketData {
  symbol: string;
  price: number;
  priceChangePercent: number;
  highPrice: number;
  lowPrice: number;
  volume: number;
  timestamp: string;
}

type TradeStatus = 'pending' | 'approved' | 'refused' | 'filled' | 'cancelled';
type RiskStatus = 'idle' | 'approved' | 'refused' | 'filled' | 'cancelled';

interface TradeProposal {
  proposalId: string;
  asset: string;
  side: 'BUY' | 'SELL';
  amountUSDT: number;
  balanceUSDT: number;
  status: TradeStatus;
  reason?: string;
  createdAt: string;
  updatedAt: string;
}

interface DashboardState {
  marketData: MarketData | null;
  riskStatus: RiskStatus;
  tradeProposal: TradeProposal | null;
  reportSales: number;
  lastEvent: string;
  lastError: string | null;
  updatedAt: string;
}

const app = express();
const PORT = Number.parseInt(process.env.SELLER_PORT ?? '3001', 10);
const REPORT_PRICE_USDC = Number.parseFloat(process.env.REPORT_PRICE_USDC ?? '0.01');

app.use(cors());
app.use(express.json());

const dashboardState: DashboardState = {
  marketData: null,
  riskStatus: 'idle',
  tradeProposal: null,
  reportSales: 0,
  lastEvent: 'Seller is ready for a Buyer agent',
  lastError: null,
  updatedAt: new Date().toISOString(),
};

const proposals = new Map<string, TradeProposal>();

function touchState(event: string): void {
  dashboardState.lastEvent = event;
  dashboardState.updatedAt = new Date().toISOString();
}

// Fetch live 24 hour data from the public Binance REST endpoint.
async function fetchMarketData(): Promise<MarketData> {
  const response = await axios.get('https://api.binance.com/api/v3/ticker/24hr', {
    params: { symbol: 'BNBUSDT' },
    timeout: 8_000,
  });

  return {
    symbol: response.data.symbol,
    price: Number.parseFloat(response.data.lastPrice),
    priceChangePercent: Number.parseFloat(response.data.priceChangePercent),
    highPrice: Number.parseFloat(response.data.highPrice),
    lowPrice: Number.parseFloat(response.data.lowPrice),
    volume: Number.parseFloat(response.data.volume),
    timestamp: new Date().toISOString(),
  };
}

async function refreshMarketData(): Promise<MarketData | null> {
  try {
    const marketData = await fetchMarketData();
    dashboardState.marketData = marketData;
    dashboardState.lastError = null;
    dashboardState.updatedAt = new Date().toISOString();
    return marketData;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown Binance API error';
    dashboardState.lastError = message;
    return dashboardState.marketData;
  }
}

function generateBriefing(marketData: MarketData): string {
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

const dashboardHtml = String.raw`<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Signal402 Agent Desk</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <script>
      tailwind.config = {
        theme: {
          extend: {
            colors: {
              ink: '#090b12',
              panel: '#111522',
              line: '#252b3b',
              cyan: '#62e6e2',
              violet: '#9d8cff'
            },
            boxShadow: { glow: '0 0 35px rgba(98, 230, 226, 0.10)' }
          }
        }
      };
    </script>
  </head>
  <body class="min-h-screen bg-ink text-slate-100 antialiased">
    <main class="mx-auto max-w-6xl px-4 py-6 sm:px-8 sm:py-10">
      <header class="mb-8 flex flex-col gap-5 border-b border-line pb-6 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <div class="mb-3 flex items-center gap-3 text-xs font-semibold uppercase tracking-[0.28em] text-cyan">
            <span class="h-2 w-2 rounded-full bg-cyan shadow-[0_0_12px_#62e6e2]"></span>
            Signal402 control room
          </div>
          <h1 class="text-3xl font-semibold tracking-tight text-white sm:text-5xl">Analyst Agent <span class="text-slate-500">/</span> Trader Agent</h1>
          <p class="mt-3 max-w-2xl text-sm leading-6 text-slate-400">A pay-per-briefing marketplace with a visible risk gate before any Spot order can be approved.</p>
        </div>
        <div class="rounded-full border border-emerald-400/30 bg-emerald-400/10 px-4 py-2 text-xs font-semibold uppercase tracking-widest text-emerald-300" id="connection">LIVE</div>
      </header>

      <section class="mb-6 grid gap-4 sm:grid-cols-3">
        <article class="rounded-2xl border border-line bg-panel p-5 shadow-glow">
          <div class="flex items-center justify-between"><span class="text-xs uppercase tracking-widest text-slate-500">Live market</span><span class="text-xs text-cyan">BINANCE REST</span></div>
          <div class="mt-4 flex items-end justify-between"><span class="text-3xl font-semibold" id="price">Waiting</span><span class="text-sm font-medium" id="change">Loading</span></div>
          <div class="mt-3 text-xs text-slate-500"><span id="symbol">BNBUSDT</span> · refreshed <span id="marketTime">just now</span></div>
        </article>
        <article class="rounded-2xl border border-line bg-panel p-5">
          <div class="flex items-center justify-between"><span class="text-xs uppercase tracking-widest text-slate-500">24h range</span><span class="text-xs text-slate-500">High / low</span></div>
          <div class="mt-4 text-2xl font-semibold" id="range">Loading</div>
          <div class="mt-3 text-xs text-slate-500">Volume <span class="text-slate-300" id="volume">Loading</span></div>
        </article>
        <article class="rounded-2xl border border-line bg-panel p-5">
          <div class="text-xs uppercase tracking-widest text-slate-500">Reports sold</div>
          <div class="mt-4 text-3xl font-semibold text-violet" id="sales">0</div>
          <div class="mt-3 text-xs text-slate-500">x402 price <span class="text-slate-300" id="reportPrice">0.01 USDC</span></div>
        </article>
      </section>

      <section class="grid gap-6 lg:grid-cols-[1.15fr_0.85fr]">
        <article class="rounded-2xl border border-line bg-panel p-6 shadow-glow sm:p-8">
          <div class="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <div class="text-xs font-semibold uppercase tracking-[0.24em] text-violet">Trader Agent queue</div>
              <h2 class="mt-2 text-2xl font-semibold">Trade proposal</h2>
              <p class="mt-2 text-sm text-slate-400" id="event">Waiting for a Buyer agent.</p>
            </div>
            <div class="inline-flex w-fit items-center gap-2 rounded-full border px-3 py-2 text-xs font-semibold uppercase tracking-wide" id="riskBadge">
              <span class="h-2 w-2 rounded-full bg-slate-500"></span> RISK GUARDIAN: idle
            </div>
          </div>
          <div class="mt-8 rounded-xl border border-dashed border-line bg-black/20 p-5" id="proposalEmpty">
            <div class="text-sm font-medium text-slate-300">No active proposal</div>
            <div class="mt-1 text-sm text-slate-500">The Buyer agent will appear here after it purchases a briefing.</div>
          </div>
          <div class="mt-8 hidden rounded-xl border border-line bg-black/20 p-5" id="proposalCard">
            <div class="grid gap-5 sm:grid-cols-2">
              <div><div class="text-xs uppercase tracking-widest text-slate-500">Asset</div><div class="mt-2 text-xl font-semibold" id="proposalAsset">BNBUSDT</div></div>
              <div><div class="text-xs uppercase tracking-widest text-slate-500">Action</div><div class="mt-2 text-xl font-semibold" id="proposalSide">BUY</div></div>
              <div><div class="text-xs uppercase tracking-widest text-slate-500">Proposed size</div><div class="mt-2 text-xl font-semibold" id="proposalAmount">0 USDT</div></div>
              <div><div class="text-xs uppercase tracking-widest text-slate-500">Available USDT</div><div class="mt-2 text-xl font-semibold" id="proposalBalance">0 USDT</div></div>
            </div>
            <div class="mt-5 rounded-lg border border-line bg-panel px-4 py-3 text-sm text-slate-400" id="proposalReason">Waiting for risk status.</div>
            <button class="mt-5 w-full rounded-xl bg-cyan px-4 py-3 text-sm font-bold uppercase tracking-widest text-ink transition hover:bg-cyan/80 disabled:cursor-not-allowed disabled:opacity-40" id="approveButton">Approve trade</button>
          </div>
        </article>

        <aside class="rounded-2xl border border-line bg-panel p-6 sm:p-8">
          <div class="text-xs font-semibold uppercase tracking-[0.24em] text-cyan">Protocol monitor</div>
          <h2 class="mt-2 text-2xl font-semibold">Agent safety</h2>
          <div class="mt-6 space-y-4 text-sm">
            <div class="flex items-center justify-between border-b border-line pb-4"><span class="text-slate-400">Payment rail</span><span class="font-medium text-emerald-300">x402 USDC</span></div>
            <div class="flex items-center justify-between border-b border-line pb-4"><span class="text-slate-400">Trade permission</span><span class="font-medium text-emerald-300">Spot only</span></div>
            <div class="flex items-center justify-between border-b border-line pb-4"><span class="text-slate-400">Withdrawal access</span><span class="font-medium text-emerald-300">Disabled</span></div>
            <div class="flex items-center justify-between"><span class="text-slate-400">Last update</span><span class="font-medium text-slate-300" id="updatedAt">Loading</span></div>
          </div>
          <div class="mt-8 rounded-xl border border-cyan/20 bg-cyan/5 p-4 text-sm leading-6 text-slate-300">The Risk Guardian blocks proposals that exceed the available USDT balance. Approval is still a human action.</div>
          <div class="mt-5 text-xs text-rose-300" id="error"></div>
        </aside>
      </section>
    </main>

    <script>
      let currentProposalId = null;
      let approving = false;

      function setText(id, value) { document.getElementById(id).textContent = value; }

      function render(data) {
        const market = data.marketData;
        if (market) {
          setText('price', '$' + Number(market.price).toFixed(2));
          setText('symbol', market.symbol);
          setText('change', (market.priceChangePercent >= 0 ? '+' : '') + Number(market.priceChangePercent).toFixed(2) + '%');
          document.getElementById('change').className = 'text-sm font-medium ' + (market.priceChangePercent >= 0 ? 'text-emerald-300' : 'text-rose-300');
          setText('range', '$' + Number(market.lowPrice).toFixed(2) + ' / $' + Number(market.highPrice).toFixed(2));
          setText('volume', Number(market.volume).toLocaleString());
          setText('marketTime', new Date(market.timestamp).toLocaleTimeString());
        }

        setText('sales', String(data.reportSales));
        setText('reportPrice', Number(data.reportPrice).toFixed(2) + ' USDC');
        setText('event', data.lastEvent);
        setText('updatedAt', new Date(data.updatedAt).toLocaleTimeString());
        setText('error', data.lastError ? 'Binance data warning: ' + data.lastError : '');

        const badge = document.getElementById('riskBadge');
        const badgeLabel = data.riskStatus === 'refused' ? 'RISK GUARDIAN: refused' : 'RISK GUARDIAN: ' + data.riskStatus;
        badge.innerHTML = '<span class="h-2 w-2 rounded-full"></span> ' + badgeLabel;
        badge.className = 'inline-flex w-fit items-center gap-2 rounded-full border px-3 py-2 text-xs font-semibold uppercase tracking-wide ' + (data.riskStatus === 'refused' ? 'border-rose-400/40 bg-rose-400/10 text-rose-300' : data.riskStatus === 'approved' || data.riskStatus === 'filled' ? 'border-emerald-400/40 bg-emerald-400/10 text-emerald-300' : 'border-slate-600 bg-slate-800/40 text-slate-400');
        badge.querySelector('span').className = 'h-2 w-2 rounded-full ' + (data.riskStatus === 'refused' ? 'bg-rose-400' : data.riskStatus === 'approved' || data.riskStatus === 'filled' ? 'bg-emerald-400' : 'bg-slate-500');

        const proposal = data.tradeProposal;
        const empty = document.getElementById('proposalEmpty');
        const card = document.getElementById('proposalCard');
        const button = document.getElementById('approveButton');
        if (!proposal) {
          empty.classList.remove('hidden');
          card.classList.add('hidden');
          currentProposalId = null;
          return;
        }

        empty.classList.add('hidden');
        card.classList.remove('hidden');
        currentProposalId = proposal.proposalId;
        setText('proposalAsset', proposal.asset);
        setText('proposalSide', proposal.side);
        setText('proposalAmount', '$' + Number(proposal.amountUSDT).toFixed(2) + ' USDT');
        setText('proposalBalance', '$' + Number(proposal.balanceUSDT).toFixed(2) + ' USDT');
        setText('proposalReason', proposal.reason || 'Proposal received.');
        button.disabled = approving || proposal.status !== 'pending';
        button.textContent = proposal.status === 'pending' ? 'Approve trade' : proposal.status === 'filled' ? 'Trade FILLED!' : proposal.status.toUpperCase();
      }

      async function refresh() {
        try {
          const response = await fetch('/api/dashboard/state');
          if (!response.ok) throw new Error('Dashboard state request failed');
          render(await response.json());
          setText('connection', 'LIVE');
        } catch (error) {
          setText('connection', 'RECONNECTING');
        }
      }

      async function approveTrade() {
        if (!currentProposalId || approving) return;
        approving = true;
        try {
          await fetch('/api/trade/approve', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ proposalId: currentProposalId }) });
          await refresh();
        } finally {
          approving = false;
        }
      }

      document.getElementById('approveButton').addEventListener('click', approveTrade);
      refresh();
      setInterval(refresh, 2000);
    </script>
  </body>
</html>`;

app.get('/', (_req, res) => {
  res.type('html').send(dashboardHtml);
});

app.get('/api/dashboard/state', async (_req, res) => {
  await refreshMarketData();
  res.json({ ...dashboardState, reportPrice: REPORT_PRICE_USDC });
});

app.post('/api/trade/proposal', (req, res) => {
  const body = req.body as Partial<TradeProposal>;
  const amountUSDT = Number(body.amountUSDT);
  const balanceUSDT = Number(body.balanceUSDT);
  const side = body.side === 'SELL' ? 'SELL' : 'BUY';

  if (!body.asset || !Number.isFinite(amountUSDT) || !Number.isFinite(balanceUSDT)) {
    res.status(400).json({ error: 'asset, amountUSDT and balanceUSDT are required' });
    return;
  }

  const now = new Date().toISOString();
  const proposal: TradeProposal = {
    proposalId: body.proposalId || `proposal_${Date.now()}`,
    asset: body.asset,
    side,
    amountUSDT,
    balanceUSDT,
    status: 'pending',
    reason: body.reason || 'Risk Guardian approved the available balance.',
    createdAt: now,
    updatedAt: now,
  };

  proposals.set(proposal.proposalId, proposal);
  dashboardState.tradeProposal = proposal;
  dashboardState.riskStatus = 'approved';
  touchState(`Trade proposal received for ${proposal.side} ${proposal.asset}`);
  res.status(201).json(proposal);
});

app.get('/api/trade/proposal/:proposalId', (req, res) => {
  const proposal = proposals.get(req.params.proposalId);
  if (!proposal) {
    res.status(404).json({ error: 'Proposal not found' });
    return;
  }
  res.json(proposal);
});

app.post('/api/trade/approve', (req, res) => {
  const proposalId = String(req.body?.proposalId || '');
  const proposal = proposals.get(proposalId);
  if (!proposal) {
    res.status(404).json({ error: 'Proposal not found' });
    return;
  }
  if (proposal.status !== 'pending') {
    res.status(409).json({ error: `Proposal is already ${proposal.status}`, proposal });
    return;
  }

  proposal.status = 'approved';
  proposal.updatedAt = new Date().toISOString();
  dashboardState.tradeProposal = proposal;
  dashboardState.riskStatus = 'approved';
  touchState(`Human approved ${proposal.side} ${proposal.asset}`);
  res.json(proposal);
});

app.post('/api/trade/status', (req, res) => {
  const body = req.body as Partial<TradeProposal> & { riskStatus?: RiskStatus };
  let proposal = body.proposalId ? proposals.get(body.proposalId) : undefined;

  if (!proposal && body.riskStatus === 'refused') {
    const now = new Date().toISOString();
    proposal = {
      proposalId: body.proposalId || `risk_${Date.now()}`,
      asset: body.asset || 'BNBUSDT',
      side: body.side === 'SELL' ? 'SELL' : 'BUY',
      amountUSDT: Number(body.amountUSDT) || 0,
      balanceUSDT: Number(body.balanceUSDT) || 0,
      status: 'refused',
      reason: body.reason || 'Risk Guardian refused the trade.',
      createdAt: now,
      updatedAt: now,
    };
    proposals.set(proposal.proposalId, proposal);
  }

  if (!proposal) {
    res.status(404).json({ error: 'Proposal not found' });
    return;
  }

  if (body.status && ['approved', 'refused', 'filled', 'cancelled'].includes(body.status)) {
    proposal.status = body.status as TradeStatus;
  }
  if (body.reason) proposal.reason = body.reason;
  proposal.updatedAt = new Date().toISOString();
  dashboardState.tradeProposal = proposal;
  dashboardState.riskStatus = proposal.status === 'refused' ? 'refused' : proposal.status === 'filled' ? 'filled' : proposal.status === 'cancelled' ? 'cancelled' : 'approved';
  touchState(proposal.status === 'refused' ? `RISK GUARDIAN: refused ${proposal.reason}` : proposal.status === 'filled' ? 'Trade FILLED!' : `Trade status: ${proposal.status}`);
  res.json(proposal);
});

// x402 payment endpoint for a live market briefing.
app.post('/api/report', async (req, res) => {
  try {
    const paymentHeader = req.headers['x-x402-payment'] as string | undefined;
    if (!paymentHeader) {
      res.setHeader('X-Payment-Required', 'true');
      res.setHeader('X-Payment-Amount', REPORT_PRICE_USDC.toString());
      res.setHeader('X-Payment-Currency', 'USDC');
      res.setHeader('X-Payment-Network', 'base');
      res.setHeader('X-Payment-Resource', '/api/report');
      res.status(402).json({
        error: 'Payment Required',
        message: `This endpoint requires payment of ${REPORT_PRICE_USDC} USDC via Binance x402`,
        payment_details: { amount: REPORT_PRICE_USDC, currency: 'USDC', network: 'base', protocol: 'x402' },
      });
      return;
    }

    console.log('Verifying x402 payment:', paymentHeader.substring(0, 20) + '...');
    const marketData = await fetchMarketData();
    dashboardState.marketData = marketData;
    dashboardState.reportSales += 1;
    touchState('Analyst Agent sold a live Binance briefing');
    console.log('x402 payment verified. Report sold successfully');

    res.json({
      success: true,
      briefing: generateBriefing(marketData),
      metadata: { generated_at: marketData.timestamp, price_paid: REPORT_PRICE_USDC, currency: 'USDC', payment_verified: true },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown report error';
    console.error('Error generating report:', message);
    res.status(500).json({ error: 'Failed to generate report', message });
  }
});

app.get('/api/report/info', (_req, res) => {
  res.json({
    service: 'Signal402 Market Intelligence',
    description: 'AI-generated market briefings powered by Binance public market data',
    price: REPORT_PRICE_USDC,
    currency: 'USDC',
    payment_protocol: 'x402',
    endpoint: '/api/report',
    method: 'POST',
  });
});

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'Signal402 Seller Agent' });
});

app.listen(PORT, () => {
  console.log(`
╔═══════════════════════════════════════════════════════════╗
║              SIGNAL402 SELLER AGENT STARTED               ║
╚═══════════════════════════════════════════════════════════╝

📡 Dashboard: http://localhost:${PORT}/
💰 Price per Report: ${REPORT_PRICE_USDC} USDC (x402)
📊 Report API: http://localhost:${PORT}/api/report
✅ Health: http://localhost:${PORT}/health

Waiting for Buyer Agents to purchase reports...
  `);
});
