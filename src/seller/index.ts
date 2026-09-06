import 'dotenv/config';

import axios from 'axios';
import cors from 'cors';
import express, { type Request, type Response } from 'express';
import { audit } from '../lib/audit.js';
import { BinanceMcpClient, type BinanceTicker } from '../lib/binanceMcp.js';
import {
  b402IsConfigured,
  buildPaymentRequired,
  reportPriceUsdc,
  verifyAndSettlePayment,
  type SettlementReceipt,
} from '../lib/binanceX402.js';

const PORT = Number.parseInt(process.env.SELLER_PORT ?? '3001', 10);
const SYMBOL = (process.env.TRADE_SYMBOL ?? 'BNBUSDT').toUpperCase();
const PUBLIC_BASE_URL = process.env.PUBLIC_SELLER_URL ?? `http://localhost:${PORT}`;
const ALLOW_PUBLIC_REST_FALLBACK = process.env.ALLOW_PUBLIC_REST_FALLBACK === 'true';
const MAX_TRADE_SIZE_USDT = Number.parseFloat(process.env.MAX_TRADE_SIZE_USDT ?? '10');
const BINANCE_MODE = process.env.SIGNAL402_BINANCE_MODE ?? 'host';
const HOST_TOKEN = process.env.SIGNAL402_HOST_TOKEN;

type MarketSource = 'MCP' | 'FALLBACK' | 'UNAVAILABLE';
type ProposalStatus = 'idle' | 'pending' | 'approved' | 'refused' | 'filled' | 'cancelled';

type TradeProposal = {
  proposalId: string;
  asset: string;
  side: 'BUY' | 'SELL';
  amountUSDT: number;
  balanceUSDT: number;
  reason: string;
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

type SellerState = {
  service: string;
  symbol: string;
  binanceMode: 'host' | 'direct';
  mcpStatus: 'connecting' | 'live' | 'error';
  mcpTools: string[];
  marketSource: MarketSource;
  ticker?: BinanceTicker;
  lastError?: string;
  reportsSold: number;
  paymentReceiptId?: string;
  paymentStatus: 'waiting' | 'settled' | 'error';
  proposal?: TradeProposal;
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
  activity: [],
  updatedAt: new Date().toISOString(),
};

const mcp = new BinanceMcpClient();
const app = express();
app.use(cors());
app.use(express.json({ limit: '32kb' }));

function hostAuthorized(req: Request): boolean {
  if (!HOST_TOKEN) return false;
  const authorization = req.headers.authorization;
  return authorization === `Bearer ${HOST_TOKEN}`;
}

function touch(message: string): void {
  state.updatedAt = new Date().toISOString();
  state.activity = [`${new Date().toLocaleTimeString()} ${message}`, ...state.activity].slice(0, 30);
}

function publicState(): SellerState {
  return JSON.parse(JSON.stringify(state)) as SellerState;
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
    raw: data,
  };
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
      touch(`FALLBACK market data live ${ticker.symbol} ${ticker.price}`);
      await audit('seller.market.read', { source: 'FALLBACK', symbol: ticker.symbol, price: ticker.price, reason: 'Supported Binance MCP host has not published data yet' });
    } catch (error: unknown) {
      state.mcpStatus = 'connecting';
      state.marketSource = 'UNAVAILABLE';
      touch(`Waiting for MCP data. Public REST fallback failed: ${error instanceof Error ? error.message : String(error)}`);
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
    state.lastError = undefined;
    touch(`MCP market data live ${ticker.symbol} ${ticker.price}`);
    await audit('seller.market.read', { source: 'MCP', symbol: ticker.symbol, price: ticker.price });
  } catch (error: unknown) {
    state.mcpStatus = 'error';
    state.lastError = error instanceof Error ? error.message : String(error);
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
      touch(`FALLBACK market data live ${ticker.symbol} ${ticker.price}`);
      await audit('seller.market.read', { source: 'FALLBACK', symbol: ticker.symbol, price: ticker.price, reason: state.lastError });
    } catch (fallbackError: unknown) {
      state.marketSource = 'UNAVAILABLE';
      state.lastError = `${state.lastError}; REST fallback failed: ${fallbackError instanceof Error ? fallbackError.message : String(fallbackError)}`;
      touch('MCP and REST fallback market data unavailable.');
      await audit('seller.market.error', { source: 'MCP_AND_REST', error: state.lastError });
    }
  }
}

function briefing(): string {
  if (!state.ticker) throw new Error('No live market data is available');
  const change = state.ticker.changePercent;
  const sentiment = change !== undefined && Number.isFinite(change) && change >= 0 ? 'BULLISH' : 'BEARISH';
  const sourceLabel = state.marketSource === 'MCP' ? 'Binance Agentic MCP' : 'PUBLIC REST FALLBACK';
  return [
    'SIGNAL402 LIVE MARKET BRIEFING',
    '==============================',
    `ASSET: ${state.ticker.symbol}`,
    `PRICE: ${state.ticker.price.toFixed(8)} USDT`,
    `24H CHANGE: ${change !== undefined && Number.isFinite(change) ? `${change.toFixed(2)}%` : 'unavailable'}`,
    `SENTIMENT: ${sentiment}`,
    `DATA SOURCE: ${sourceLabel}`,
    `OBSERVED AT: ${new Date().toISOString()}`,
    '',
    'RECOMMENDATION:',
    'Use a small MARKET BUY only after the human approval gate. The buyer enforces a 10 USDT maximum and checks its live USDT balance immediately before ordering.',
  ].join('\n');
}

function paymentHeader(req: Request): string | undefined {
  const value = req.headers['payment-signature'] ?? req.headers['x-payment-signature'];
  return typeof value === 'string' ? value : undefined;
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

app.get('/', (_req, res) => {
  res.type('html').send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Signal402 Agent OS</title><script src="https://cdn.tailwindcss.com"></script>
<script>tailwind.config={theme:{extend:{colors:{ink:'#070b14',panel:'#0d1422',line:'#1d2a3d',cyan:'#67e8f9',lime:'#bef264'}}}}</script>
<style>body{background:#070b14;color:#e5edf7;font-family:Inter,ui-sans-serif,system-ui}.glow{box-shadow:0 0 36px rgba(34,211,238,.10)}.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}</style></head>
<body><main class="mx-auto min-h-screen max-w-7xl px-5 py-8 lg:px-10">
<header class="mb-8 flex flex-col gap-5 border-b border-line pb-6 sm:flex-row sm:items-end sm:justify-between">
<div><div class="mb-2 flex items-center gap-3"><span class="rounded-full border border-cyan/30 bg-cyan/10 px-3 py-1 text-xs font-bold tracking-[.25em] text-cyan">SIGNAL402</span><span class="text-xs uppercase tracking-[.22em] text-slate-500">Binance Agent OS</span></div><h1 class="text-3xl font-semibold tracking-tight sm:text-5xl">Agent-to-agent market intelligence</h1><p class="mt-3 max-w-2xl text-sm leading-6 text-slate-400">A live Seller Agent publishes a paid Binance briefing. A Buyer Agent checks its real account, waits for human approval, then submits one capped Spot order.</p></div>
<div class="flex flex-wrap gap-2 text-xs font-semibold"><span id="mcpBadge" class="rounded-full border border-slate-700 bg-slate-900 px-3 py-2 text-slate-300">MCP: CONNECTING</span><span id="sourceBadge" class="rounded-full border border-slate-700 bg-slate-900 px-3 py-2 text-slate-300">DATA: WAITING</span><span class="rounded-full border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-rose-300">WITHDRAWAL: NEVER</span></div>
</header>
<section class="grid gap-5 lg:grid-cols-[1.1fr_.9fr]">
<article class="glow rounded-2xl border border-line bg-panel p-6"><div class="mb-5 flex items-center justify-between"><div><p class="text-xs uppercase tracking-[.24em] text-cyan">Seller Agent</p><h2 class="mt-2 text-2xl font-semibold">Analyst Agent</h2></div><span class="rounded-lg border border-cyan/20 bg-cyan/10 px-3 py-2 text-xs text-cyan">LIVE FEED</span></div><div class="grid gap-4 sm:grid-cols-3"><div class="rounded-xl border border-line bg-ink p-4"><p class="text-xs text-slate-500">Pair</p><p id="pair" class="mt-2 text-xl font-semibold">${SYMBOL}</p></div><div class="rounded-xl border border-line bg-ink p-4"><p class="text-xs text-slate-500">Last price</p><p id="price" class="mt-2 text-xl font-semibold text-lime">Waiting</p></div><div class="rounded-xl border border-line bg-ink p-4"><p class="text-xs text-slate-500">24h change</p><p id="change" class="mt-2 text-xl font-semibold">Waiting</p></div></div><div class="mt-5 rounded-xl border border-line bg-ink p-4"><div class="flex items-center justify-between"><span class="text-xs uppercase tracking-[.18em] text-slate-500">Research paywall</span><span class="text-sm font-semibold text-cyan">0.01 USDC</span></div><p class="mt-3 text-sm leading-6 text-slate-400">Real Binance B402 v2 settlement. The briefing is withheld until verification and on-chain settlement succeed.</p><p id="paymentReceipt" class="mt-3 break-all font-mono text-xs text-slate-500">Receipt: waiting</p></div></article>
<article class="glow rounded-2xl border border-line bg-panel p-6"><div class="mb-5 flex items-center justify-between"><div><p class="text-xs uppercase tracking-[.24em] text-lime">Buyer Agent</p><h2 class="mt-2 text-2xl font-semibold">Trader Agent</h2></div><span class="rounded-lg border border-lime/20 bg-lime/10 px-3 py-2 text-xs text-lime">HUMAN GATE</span></div><div class="rounded-xl border border-line bg-ink p-5"><div class="flex items-center justify-between"><span class="text-xs uppercase tracking-[.18em] text-slate-500">Risk Guardian</span><span id="riskBadge" class="rounded-full border border-slate-700 bg-slate-900 px-3 py-1 text-xs text-slate-400">idle</span></div><p id="riskReason" class="mt-4 text-sm leading-6 text-slate-400">Waiting for a buyer proposal backed by a live balance read.</p><div class="mt-5 grid gap-3 text-sm sm:grid-cols-3"><div><p class="text-xs text-slate-500">Proposed size</p><p id="tradeSize" class="mt-1 font-semibold">Waiting</p></div><div><p class="text-xs text-slate-500">USDT before</p><p id="balance" class="mt-1 font-semibold">Waiting</p></div><div><p class="text-xs text-slate-500">USDT after</p><p id="balanceAfter" class="mt-1 font-semibold">Waiting</p></div></div><button id="approve" class="mt-6 hidden w-full rounded-xl bg-lime px-4 py-3 text-sm font-bold text-ink transition hover:bg-lime/80">APPROVE</button><p id="order" class="mt-4 break-all font-mono text-xs text-slate-500">Order: waiting</p></div></article>
</section>
<section class="mt-5 grid gap-5 lg:grid-cols-[.8fr_1.2fr]"><article class="rounded-2xl border border-line bg-panel p-6"><p class="text-xs uppercase tracking-[.24em] text-slate-500">Safety model</p><div class="mt-4 space-y-3 text-sm text-slate-300"><p>✓ Binance OAuth is owned by the supported MCP host.</p><p>✓ Signal402 never stores or forwards Binance tokens.</p><p>✓ No withdrawal scope exists in Binance Agent OS.</p><p>✓ Every order requires this human APPROVE action.</p><p>✓ Spot MARKET BUY is capped at 10 USDT.</p><p>✓ Every action is appended to a local JSONL audit log.</p></div></article><article class="rounded-2xl border border-line bg-panel p-6"><div class="flex items-center justify-between"><p class="text-xs uppercase tracking-[.24em] text-slate-500">Agent activity</p><span id="updated" class="font-mono text-xs text-slate-600">waiting</span></div><div id="activity" class="mono mt-4 max-h-56 space-y-2 overflow-auto text-xs leading-5 text-slate-400"><p>Waiting for the Seller Agent.</p></div></article></section>
</main><script>
const esc=(v)=>String(v??'').replace(/[&<>"']/g,(c)=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const set=(id,value)=>{const el=document.getElementById(id);if(el)el.textContent=value};
const usdt=(balances)=>{const b=Array.isArray(balances)?balances.find((x)=>String(x?.asset??'').toUpperCase()==='USDT'):null;return b&&Number.isFinite(Number(b.free))?Number(b.free):undefined};
async function approve(id){const b=document.getElementById('approve');b.disabled=true;b.textContent='APPROVING';await fetch('/api/trade/approve',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({proposalId:id})});await update()}
async function update(){try{const s=await (await fetch('/api/state',{cache:'no-store'})).json();set('mcpBadge',s.mcpStatus==='live'?'MCP: LIVE':s.marketSource==='FALLBACK'?'MCP: FALLBACK':s.mcpStatus==='error'?'MCP: ERROR':'MCP: CONNECTING');set('sourceBadge',s.marketSource==='MCP'?'DATA: MCP LIVE':s.marketSource==='FALLBACK'?'DATA: FALLBACK':'DATA: WAITING');if(s.ticker){set('pair',s.ticker.symbol);set('price',Number(s.ticker.price).toFixed(8)+' USDT');set('change',Number.isFinite(Number(s.ticker.changePercent))?Number(s.ticker.changePercent).toFixed(2)+'%':'Unavailable')}set('paymentReceipt',s.paymentReceiptId?'Receipt: '+s.paymentReceiptId:'Receipt: waiting');set('updated',new Date(s.updatedAt).toLocaleTimeString());const p=s.proposal;const badge=document.getElementById('riskBadge');const button=document.getElementById('approve');if(p){set('riskBadge',p.status==='refused'?'RISK GUARDIAN: refused':p.status==='filled'?'TRADE FILLED':p.status==='approved'?'APPROVED':p.status.toUpperCase());badge.className='rounded-full border px-3 py-1 text-xs '+(p.status==='refused'?'border-rose-500/40 bg-rose-500/10 text-rose-300':p.status==='filled'?'border-lime/40 bg-lime/10 text-lime':'border-cyan/40 bg-cyan/10 text-cyan');set('riskReason',p.reason);set('tradeSize',Number(p.amountUSDT).toFixed(2)+' USDT');const beforeUsdt=usdt(p.beforeBalances);const afterUsdt=usdt(p.afterBalances);set('balance',(beforeUsdt===undefined?Number(p.balanceUSDT).toFixed(2):beforeUsdt.toFixed(8))+' USDT');set('balanceAfter',afterUsdt===undefined?'Waiting':afterUsdt.toFixed(8)+' USDT');set('order',p.orderId?'Order: '+p.orderId+(p.filledPrice?' · filled price '+Number(p.filledPrice).toFixed(8):''):'Order: waiting');if(p.status==='pending'){button.classList.remove('hidden');button.disabled=false;button.textContent='APPROVE';button.onclick=()=>approve(p.proposalId)}else{button.classList.add('hidden')}}else{button.classList.add('hidden')}const a=document.getElementById('activity');a.innerHTML=(s.activity||[]).map((x)=>'<p>'+esc(x)+'</p>').join('')||'<p>Waiting for the Seller Agent.</p>'}catch(e){console.error(e)}}update();setInterval(update,1500);
</script></body></html>`);
});

app.get('/api/state', (_req, res) => res.json(publicState()));

app.get('/api/health', (_req, res) => res.json({ ok: true, mcp: state.mcpStatus === 'live', marketSource: state.marketSource, binanceMode: state.binanceMode, x402Configured: b402IsConfigured() }));

app.post('/api/host/market', async (req, res) => {
  if (!hostAuthorized(req)) {
    res.status(401).json({ success: false, error: 'Supported Binance MCP host authorization is missing' });
    return;
  }
  const body = req.body as {
    source?: unknown;
    symbol?: unknown;
    price?: unknown;
    changePercent?: unknown;
    toolNames?: unknown;
    observedAt?: unknown;
  };
  const symbol = `${body.symbol ?? ''}`.trim().toUpperCase();
  const price = Number(body.price);
  const changePercent = body.changePercent === undefined || body.changePercent === null ? undefined : Number(body.changePercent);
  const toolNames = Array.isArray(body.toolNames) ? body.toolNames.filter((name): name is string => typeof name === 'string' && name.trim() !== '') : [];
  if (body.source !== 'binance-mcp' || symbol !== SYMBOL || !Number.isFinite(price) || price <= 0 || (changePercent !== undefined && !Number.isFinite(changePercent)) || toolNames.length === 0) {
    res.status(400).json({ success: false, error: 'Host market payload must contain a real Binance MCP source, matching symbol, positive price, and runtime tool names' });
    return;
  }
  state.mcpStatus = 'live';
  state.marketSource = 'MCP';
  state.mcpTools = toolNames;
  state.ticker = { symbol, price, changePercent, raw: { source: body.source, observedAt: body.observedAt ?? new Date().toISOString() } };
  state.lastError = undefined;
  touch(`Supported Binance MCP host published ${symbol} ${price}`);
  await audit('seller.market.host_received', { source: body.source, symbol, price, changePercent, toolNames, observedAt: body.observedAt });
  res.json({ success: true, source: 'MCP', symbol, price, changePercent, toolNames });
});

app.get('/api/report/info', (_req, res) => res.json({
  service: 'Signal402 Seller Agent',
  price: reportPriceUsdc(),
  currency: 'USDC',
  payment_protocol: 'Binance B402 x402 v2',
  network: process.env.B402_NETWORK ?? 'eip155:56',
  payment_required_header: 'PAYMENT-REQUIRED',
  settlement_endpoints: ['/papi/v2/b402/verify', '/papi/v2/b402/settle'],
}));

app.post('/api/report', async (req, res) => {
  const resourceUrl = `${PUBLIC_BASE_URL}/api/report`;
  try {
    const required = await buildPaymentRequired(resourceUrl);
    const signedPayment = paymentHeader(req);
    if (!signedPayment) {
      touch('402 challenge issued. No briefing delivered.');
      sendPaymentChallenge(res, required);
      return;
    }
    const receipt = await verifyAndSettlePayment(signedPayment, required.requirement);
    if (!state.ticker) await refreshMarketData();
    if (!state.ticker || state.marketSource === 'UNAVAILABLE') throw new Error('No live market data is available after payment settlement');
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
    const message = error instanceof Error ? error.message : String(error);
    state.paymentStatus = 'error';
    state.lastError = message;
    touch(`Payment or briefing refused: ${message}`);
    await audit('seller.briefing.refused', { error: message });
    if (message.includes('credentials are missing')) {
      res.status(503).json({ success: false, error: 'Real B402 merchant credentials are not configured. No simulated payment is accepted.' });
      return;
    }
    res.status(402).json({ success: false, error: message });
  }
});

app.post('/api/trade/proposal', async (req, res) => {
  const body = req.body as Partial<TradeProposal>;
  if (state.paymentStatus !== 'settled' || !state.paymentReceiptId || body.paymentReceiptId !== state.paymentReceiptId) {
    res.status(409).json({ success: false, error: 'A proposal requires the current real B402 settlement receipt' });
    return;
  }
  const amount = Number(body.amountUSDT);
  const balance = Number(body.balanceUSDT);
  if (!body.proposalId || !body.asset || !Number.isFinite(amount) || amount <= 0 || amount > MAX_TRADE_SIZE_USDT || !Number.isFinite(balance)) {
    res.status(400).json({ success: false, error: `Invalid proposal. Maximum allowed size is ${MAX_TRADE_SIZE_USDT} USDT.` });
    return;
  }
  const proposal: TradeProposal = {
    proposalId: `${body.proposalId}`,
    asset: `${body.asset}`.toUpperCase(),
    side: 'BUY',
    amountUSDT: amount,
    balanceUSDT: balance,
    reason: `${body.reason ?? 'Live balance covers the capped order.'}`,
    status: body.status === 'refused' ? 'refused' : 'pending',
    riskStatus: body.riskStatus === 'refused' || body.status === 'refused' ? 'refused' : 'approved',
    paymentReceiptId: typeof body.paymentReceiptId === 'string' ? body.paymentReceiptId : state.paymentReceiptId,
    updatedAt: new Date().toISOString(),
  };
  state.proposal = proposal;
  touch(`Trade proposal ${proposal.proposalId} is waiting for human APPROVE.`);
  await audit('seller.trade.proposed', { proposalId: proposal.proposalId, asset: proposal.asset, amountUSDT: amount, balanceUSDT: balance });
  res.json({ success: true, proposalId: proposal.proposalId, status: proposal.status });
});

app.get('/api/trade/proposal/:proposalId', (req, res) => {
  const proposal = state.proposal;
  if (!proposal || proposal.proposalId !== req.params.proposalId) {
    res.status(404).json({ success: false, error: 'Proposal not found' });
    return;
  }
  res.json(proposal);
});

app.post('/api/trade/approve', async (req, res) => {
  const proposal = state.proposal;
  if (!proposal || proposal.proposalId !== req.body?.proposalId) {
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
  const body = req.body as Partial<TradeProposal>;
  const proposal = state.proposal;
  if (!proposal || proposal.proposalId !== body.proposalId) {
    res.status(404).json({ success: false, error: 'Proposal not found' });
    return;
  }
  const nextStatus = body.status;
  if (!['refused', 'filled', 'cancelled'].includes(`${nextStatus}`)) {
    res.status(400).json({ success: false, error: 'Invalid trade status' });
    return;
  }
  if (nextStatus === 'filled' && body.source === 'binance-mcp-host' && !hostAuthorized(req)) {
    res.status(401).json({ success: false, error: 'Supported Binance MCP host authorization is required for fill receipts' });
    return;
  }
  if (nextStatus === 'filled' && (
    !body.orderId
    || `${body.orderId}`.trim() === ''
    || body.source !== 'binance-mcp-host' && body.source !== 'binance-mcp-direct-approved'
    || !body.mcpToolName
    || !Number.isFinite(Number(body.filledPrice))
    || !Number.isFinite(Number(body.executedQty))
    || !Number.isFinite(Number(body.amountUSDT))
    || Number(body.amountUSDT) <= 0
    || Number(body.amountUSDT) > MAX_TRADE_SIZE_USDT
  )) {
    res.status(400).json({ success: false, error: 'A filled status requires a real Binance MCP source, tool name, order ID, filled price, executed quantity, and capped quote amount' });
    return;
  }
  proposal.status = nextStatus as ProposalStatus;
  proposal.riskStatus = nextStatus === 'refused' ? 'refused' : 'approved';
  proposal.reason = `${body.reason ?? proposal.reason}`;
  proposal.orderId = typeof body.orderId === 'string' ? body.orderId : proposal.orderId;
  proposal.filledPrice = Number.isFinite(Number(body.filledPrice)) ? Number(body.filledPrice) : proposal.filledPrice;
  proposal.executedQty = Number.isFinite(Number(body.executedQty)) ? Number(body.executedQty) : proposal.executedQty;
  proposal.source = typeof body.source === 'string' ? body.source : proposal.source;
  proposal.mcpToolName = typeof body.mcpToolName === 'string' ? body.mcpToolName : proposal.mcpToolName;
  proposal.beforeBalances = body.beforeBalances ?? proposal.beforeBalances;
  proposal.afterBalances = body.afterBalances ?? proposal.afterBalances;
  proposal.updatedAt = new Date().toISOString();
  touch(nextStatus === 'filled' ? `REAL TRADE FILLED. Order ${proposal.orderId}` : `Trade ${nextStatus}: ${proposal.reason}`);
  await audit(`seller.trade.${nextStatus}`, { proposalId: proposal.proposalId, orderId: proposal.orderId, filledPrice: proposal.filledPrice, beforeBalances: proposal.beforeBalances, afterBalances: proposal.afterBalances });
  res.json({ success: true, status: proposal.status, orderId: proposal.orderId });
});

const server = app.listen(PORT, () => {
  console.log(`\n📡 Signal402 Seller Agent listening on http://localhost:${PORT}`);
  console.log(`   Pair: ${SYMBOL}`);
  console.log(`   Binance integration: ${BINANCE_MODE === 'direct' ? 'DIRECT CLIENT (requires Binance approval)' : 'SUPPORTED HOST MCP'}`);
  if (BINANCE_MODE !== 'direct') console.log('   Host bridge: POST live market data from the supported Binance MCP host to /api/host/market');
  console.log(`   x402: ${b402IsConfigured() ? 'B402 credentials detected' : 'NOT CONFIGURED. Real payments only.'}`);
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
