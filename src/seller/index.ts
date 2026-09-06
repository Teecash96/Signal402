import 'dotenv/config';

import axios from 'axios';
import cors from 'cors';
import { timingSafeEqual } from 'node:crypto';
import express, { type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { audit } from '../lib/audit.js';
import { DashboardAuth, dashboardLoginSchema } from '../lib/auth.js';
import { BinanceMcpClient, type BinanceTicker } from '../lib/binanceMcp.js';
import { dashboardCspNonce, configureHttpSecurity } from '../lib/httpSecurity.js';
import { createRateLimiter } from '../lib/rateLimit.js';
import { assessTradeRisk } from '../buyer/riskGuardian.js';
import { emptyBodySchema, hostMarketSchema, parseBody, tradeProposalInputSchema, tradeStatusInputSchema } from '../lib/schemas.js';
import { isUsableSecret } from '../lib/securityConfig.js';
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
const TURNSTILE_SITE_KEY = process.env.SIGNAL402_TURNSTILE_SITE_KEY ?? '';
if (TURNSTILE_SITE_KEY && !/^[A-Za-z0-9_-]{10,200}$/.test(TURNSTILE_SITE_KEY)) throw new Error('SIGNAL402_TURNSTILE_SITE_KEY is invalid');
const ALLOW_PUBLIC_REST_FALLBACK = process.env.ALLOW_PUBLIC_REST_FALLBACK === 'true';
const configuredMaxTradeSize = Number.parseFloat(process.env.MAX_TRADE_SIZE_USDT ?? '10');
const MAX_TRADE_SIZE_USDT = Number.isFinite(configuredMaxTradeSize) ? Math.min(Math.max(configuredMaxTradeSize, 0.01), 10) : 10;
const BINANCE_MODE = process.env.SIGNAL402_BINANCE_MODE ?? 'host';
const HOST_TOKEN = process.env.SIGNAL402_HOST_TOKEN;
const DASHBOARD_AUTH = new DashboardAuth();

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
configureHttpSecurity(app, PUBLIC_BASE_URL);
const allowedOrigins = new Set((process.env.SIGNAL402_ALLOWED_ORIGINS ?? PUBLIC_BASE_URL).split(',').map((origin) => origin.trim()).filter(Boolean));
app.use(cors({
  origin: (origin, callback) => callback(null, !origin || allowedOrigins.has(origin)),
  credentials: true,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'PAYMENT-SIGNATURE', 'X-PAYMENT-SIGNATURE'],
  exposedHeaders: ['PAYMENT-REQUIRED', 'PAYMENT-RESPONSE', 'X-PAYMENT-REQUIREMENTS'],
}));
app.use(express.json({ limit: '32kb', strict: true }));
app.use('/api/report', createRateLimiter({ windowMs: 60_000, max: 30, message: 'Too many report requests. Try again later.' }));

function hostAuthorized(req: Request): boolean {
  if (!isUsableSecret(HOST_TOKEN)) return false;
  const authorization = req.headers.authorization;
  const expected = Buffer.from(`Bearer ${HOST_TOKEN}`, 'utf8');
  const actual = Buffer.from(typeof authorization === 'string' ? authorization : '', 'utf8');
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function dashboardOrHostAuthorized(req: Request): boolean {
  return hostAuthorized(req) || DASHBOARD_AUTH.isAuthenticated(req);
}

function touch(message: string): void {
  state.updatedAt = new Date().toISOString();
  state.activity = [`${new Date().toLocaleTimeString()} ${message}`.slice(0, 320), ...state.activity].slice(0, 30);
}

function publicState(): Record<string, unknown> {
  const proposal = state.proposal;
  return {
    service: state.service,
    symbol: state.symbol,
    binanceMode: state.binanceMode,
    mcpStatus: state.mcpStatus,
    mcpTools: state.mcpTools.slice(0, 200),
    marketSource: state.marketSource,
    ticker: state.ticker ? {
      symbol: state.ticker.symbol,
      price: state.ticker.price,
      changePercent: state.ticker.changePercent,
    } : undefined,
    reportsSold: state.reportsSold,
    paymentReceiptId: state.paymentReceiptId,
    paymentStatus: state.paymentStatus,
    proposal: proposal ? {
      proposalId: proposal.proposalId,
      asset: proposal.asset,
      side: proposal.side,
      amountUSDT: proposal.amountUSDT,
      balanceUSDT: proposal.balanceUSDT,
      reason: proposal.reason,
      status: proposal.status,
      riskStatus: proposal.riskStatus,
      paymentReceiptId: proposal.paymentReceiptId,
      orderId: proposal.orderId,
      filledPrice: proposal.filledPrice,
      executedQty: proposal.executedQty,
      source: proposal.source,
      mcpToolName: proposal.mcpToolName,
      beforeBalances: proposal.beforeBalances,
      afterBalances: proposal.afterBalances,
      updatedAt: proposal.updatedAt,
    } : undefined,
    activity: state.activity.slice(0, 30),
    updatedAt: state.updatedAt,
  };
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
    } catch {
      state.mcpStatus = 'connecting';
      state.marketSource = 'UNAVAILABLE';
      touch('Waiting for MCP data. Public REST fallback failed.');
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
  } catch {
    state.mcpStatus = 'error';
    state.lastError = 'MCP market data unavailable';
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
    } catch {
      state.marketSource = 'UNAVAILABLE';
      state.lastError = 'MCP and public REST market data unavailable';
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
  const nonce = dashboardCspNonce(res);
  const turnstileScript = TURNSTILE_SITE_KEY ? `<script nonce="${nonce}" src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>` : '';
  const turnstileWidget = TURNSTILE_SITE_KEY ? `<div class="cf-turnstile mt-4" data-sitekey="${TURNSTILE_SITE_KEY}" data-callback="signal402Turnstile"></div>` : '';
  res.type('html').send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Signal402 Agent OS</title><script nonce="${nonce}" src="https://cdn.tailwindcss.com"></script>
<script nonce="${nonce}">tailwind.config={theme:{extend:{colors:{ink:'#070b14',panel:'#0d1422',line:'#1d2a3d',cyan:'#67e8f9',lime:'#bef264'}}}}</script>
${turnstileScript}
<style>body{background:#070b14;color:#e5edf7;font-family:Inter,ui-sans-serif,system-ui}.glow{box-shadow:0 0 36px rgba(34,211,238,.10)}.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}</style></head>
<body><div id="loginPanel" class="fixed inset-0 z-50 flex items-center justify-center bg-ink/95 px-5"><form id="loginForm" class="w-full max-w-sm rounded-2xl border border-line bg-panel p-6 shadow-2xl"><p class="text-xs uppercase tracking-[.24em] text-cyan">Signal402 dashboard</p><h2 class="mt-3 text-2xl font-semibold">Sign in to approve trades</h2><p class="mt-3 text-sm leading-6 text-slate-400">The dashboard can show public market status, but order approval requires a server side session.</p><label class="mt-5 block text-sm text-slate-300" for="password">Dashboard password</label><input id="password" name="password" type="password" autocomplete="current-password" required maxlength="256" class="mt-2 w-full rounded-lg border border-line bg-ink px-3 py-3 text-sm text-white outline-none focus:border-cyan"><input id="turnstileToken" name="turnstileToken" type="hidden"><input name="website" type="text" tabindex="-1" autocomplete="off" class="hidden">${turnstileWidget}<button class="mt-5 w-full rounded-xl bg-cyan px-4 py-3 text-sm font-bold text-ink">SIGN IN</button><p id="loginError" class="mt-3 min-h-5 text-sm text-rose-300" role="alert"></p></form></div><main class="mx-auto min-h-screen max-w-7xl px-5 py-8 lg:px-10">
<header class="mb-8 flex flex-col gap-5 border-b border-line pb-6 sm:flex-row sm:items-end sm:justify-between">
<div><div class="mb-2 flex items-center gap-3"><span class="rounded-full border border-cyan/30 bg-cyan/10 px-3 py-1 text-xs font-bold tracking-[.25em] text-cyan">SIGNAL402</span><span class="text-xs uppercase tracking-[.22em] text-slate-500">Binance Agent OS</span></div><h1 class="text-3xl font-semibold tracking-tight sm:text-5xl">Agent-to-agent market intelligence</h1><p class="mt-3 max-w-2xl text-sm leading-6 text-slate-400">A live Seller Agent publishes a paid Binance briefing. A Buyer Agent checks its real account, waits for human approval, then submits one capped Spot order.</p></div>
<div class="flex flex-wrap gap-2 text-xs font-semibold"><span id="mcpBadge" class="rounded-full border border-slate-700 bg-slate-900 px-3 py-2 text-slate-300">MCP: CONNECTING</span><span id="sourceBadge" class="rounded-full border border-slate-700 bg-slate-900 px-3 py-2 text-slate-300">DATA: WAITING</span><span class="rounded-full border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-rose-300">WITHDRAWAL: NEVER</span><button id="logout" class="rounded-full border border-slate-700 bg-slate-900 px-3 py-2 text-slate-300">SIGN OUT</button></div>
</header>
<section class="grid gap-5 lg:grid-cols-[1.1fr_.9fr]">
<article class="glow rounded-2xl border border-line bg-panel p-6"><div class="mb-5 flex items-center justify-between"><div><p class="text-xs uppercase tracking-[.24em] text-cyan">Seller Agent</p><h2 class="mt-2 text-2xl font-semibold">Analyst Agent</h2></div><span class="rounded-lg border border-cyan/20 bg-cyan/10 px-3 py-2 text-xs text-cyan">LIVE FEED</span></div><div class="grid gap-4 sm:grid-cols-3"><div class="rounded-xl border border-line bg-ink p-4"><p class="text-xs text-slate-500">Pair</p><p id="pair" class="mt-2 text-xl font-semibold">${SYMBOL}</p></div><div class="rounded-xl border border-line bg-ink p-4"><p class="text-xs text-slate-500">Last price</p><p id="price" class="mt-2 text-xl font-semibold text-lime">Waiting</p></div><div class="rounded-xl border border-line bg-ink p-4"><p class="text-xs text-slate-500">24h change</p><p id="change" class="mt-2 text-xl font-semibold">Waiting</p></div></div><div class="mt-5 rounded-xl border border-line bg-ink p-4"><div class="flex items-center justify-between"><span class="text-xs uppercase tracking-[.18em] text-slate-500">Research paywall</span><span class="text-sm font-semibold text-cyan">0.01 USDC</span></div><p class="mt-3 text-sm leading-6 text-slate-400">Real Binance B402 v2 settlement. The briefing is withheld until verification and on-chain settlement succeed.</p><p id="paymentReceipt" class="mt-3 break-all font-mono text-xs text-slate-500">Receipt: waiting</p></div></article>
<article class="glow rounded-2xl border border-line bg-panel p-6"><div class="mb-5 flex items-center justify-between"><div><p class="text-xs uppercase tracking-[.24em] text-lime">Buyer Agent</p><h2 class="mt-2 text-2xl font-semibold">Trader Agent</h2></div><span class="rounded-lg border border-lime/20 bg-lime/10 px-3 py-2 text-xs text-lime">HUMAN GATE</span></div><div class="rounded-xl border border-line bg-ink p-5"><div class="flex items-center justify-between"><span class="text-xs uppercase tracking-[.18em] text-slate-500">Risk Guardian</span><span id="riskBadge" class="rounded-full border border-slate-700 bg-slate-900 px-3 py-1 text-xs text-slate-400">idle</span></div><p id="riskReason" class="mt-4 text-sm leading-6 text-slate-400">Waiting for a buyer proposal backed by a live balance read.</p><div class="mt-5 grid gap-3 text-sm sm:grid-cols-3"><div><p class="text-xs text-slate-500">Proposed size</p><p id="tradeSize" class="mt-1 font-semibold">Waiting</p></div><div><p class="text-xs text-slate-500">USDT before</p><p id="balance" class="mt-1 font-semibold">Waiting</p></div><div><p class="text-xs text-slate-500">USDT after</p><p id="balanceAfter" class="mt-1 font-semibold">Waiting</p></div></div><button id="approve" class="mt-6 hidden w-full rounded-xl bg-lime px-4 py-3 text-sm font-bold text-ink transition hover:bg-lime/80">APPROVE</button><p id="order" class="mt-4 break-all font-mono text-xs text-slate-500">Order: waiting</p></div></article>
</section>
<section class="mt-5 grid gap-5 lg:grid-cols-[.8fr_1.2fr]"><article class="rounded-2xl border border-line bg-panel p-6"><p class="text-xs uppercase tracking-[.24em] text-slate-500">Safety model</p><div class="mt-4 space-y-3 text-sm text-slate-300"><p>✓ Supported host mode keeps Binance OAuth outside Signal402.</p><p>✓ Direct OAuth is disabled unless Binance approves this client.</p><p>✓ No withdrawal scope exists in Binance Agent OS.</p><p>✓ Every order requires this human APPROVE action.</p><p>✓ Spot MARKET BUY is capped at 10 USDT.</p><p>✓ Every action is appended to a local JSONL audit log.</p></div></article><article class="rounded-2xl border border-line bg-panel p-6"><div class="flex items-center justify-between"><p class="text-xs uppercase tracking-[.24em] text-slate-500">Agent activity</p><span id="updated" class="font-mono text-xs text-slate-600">waiting</span></div><div id="activity" class="mono mt-4 max-h-56 space-y-2 overflow-auto text-xs leading-5 text-slate-400"><p>Waiting for the Seller Agent.</p></div></article></section>
</main><script nonce="${nonce}">
const set=(id,value)=>{const el=document.getElementById(id);if(el)el.textContent=value};
const usdt=(balances)=>{const b=Array.isArray(balances)?balances.find((x)=>String(x?.asset??'').toUpperCase()==='USDT'):null;return b&&Number.isFinite(Number(b.free))?Number(b.free):undefined};
const loginPanel=document.getElementById('loginPanel');const loginError=document.getElementById('loginError');const showLogin=(show)=>loginPanel.classList.toggle('hidden',!show);window.signal402Turnstile=(token)=>{const field=document.getElementById('turnstileToken');if(field)field.value=token};
async function login(event){event.preventDefault();loginError.textContent='';const form=new FormData(event.currentTarget);const response=await fetch('/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},credentials:'same-origin',body:JSON.stringify({password:form.get('password'),website:form.get('website'),turnstileToken:form.get('turnstileToken')||undefined})});const data=await response.json().catch(()=>({}));if(!response.ok){loginError.textContent=data.error||'Login failed';return}event.currentTarget.reset();showLogin(false);await update()}
async function logout(){await fetch('/api/auth/logout',{method:'POST',credentials:'same-origin'});showLogin(true)}
function renderActivity(items){const target=document.getElementById('activity');target.replaceChildren(...(Array.isArray(items)?items:[]).map((item)=>{const p=document.createElement('p');p.textContent=String(item??'');return p}));if(!target.childElementCount){const p=document.createElement('p');p.textContent='Waiting for the Seller Agent.';target.appendChild(p)}}
async function approve(id){const button=document.getElementById('approve');button.disabled=true;button.textContent='APPROVING';const response=await fetch('/api/trade/approve',{method:'POST',headers:{'content-type':'application/json'},credentials:'same-origin',body:JSON.stringify({proposalId:id})});if(response.status===401){showLogin(true);return}await update()}
async function update(){try{const response=await fetch('/api/state',{cache:'no-store',credentials:'same-origin'});if(response.status===401){showLogin(true);return}if(!response.ok)throw new Error('Dashboard state unavailable');const s=await response.json();showLogin(false);set('mcpBadge',s.mcpStatus==='live'?'MCP: LIVE':s.marketSource==='FALLBACK'?'MCP: FALLBACK':s.mcpStatus==='error'?'MCP: ERROR':'MCP: CONNECTING');set('sourceBadge',s.marketSource==='MCP'?'DATA: MCP LIVE':s.marketSource==='FALLBACK'?'DATA: FALLBACK':'DATA: WAITING');if(s.ticker){set('pair',s.ticker.symbol);set('price',Number(s.ticker.price).toFixed(8)+' USDT');set('change',Number.isFinite(Number(s.ticker.changePercent))?Number(s.ticker.changePercent).toFixed(2)+'%':'Unavailable')}set('paymentReceipt',s.paymentReceiptId?'Receipt: '+s.paymentReceiptId:'Receipt: waiting');set('updated',new Date(s.updatedAt).toLocaleTimeString());const p=s.proposal;const badge=document.getElementById('riskBadge');const button=document.getElementById('approve');if(p){set('riskBadge',p.status==='refused'?'RISK GUARDIAN: refused':p.status==='filled'?'TRADE FILLED':p.status==='approved'?'APPROVED':p.status.toUpperCase());badge.className='rounded-full border px-3 py-1 text-xs '+(p.status==='refused'?'border-rose-500/40 bg-rose-500/10 text-rose-300':p.status==='filled'?'border-lime/40 bg-lime/10 text-lime':'border-cyan/40 bg-cyan/10 text-cyan');set('riskReason',p.reason);set('tradeSize',Number(p.amountUSDT).toFixed(2)+' USDT');const beforeUsdt=usdt(p.beforeBalances);const afterUsdt=usdt(p.afterBalances);set('balance',(beforeUsdt===undefined?Number(p.balanceUSDT).toFixed(2):beforeUsdt.toFixed(8))+' USDT');set('balanceAfter',afterUsdt===undefined?'Waiting':afterUsdt.toFixed(8)+' USDT');set('order',p.orderId?'Order: '+p.orderId+(p.filledPrice?' · filled price '+Number(p.filledPrice).toFixed(8):''):'Order: waiting');if(p.status==='pending'){button.classList.remove('hidden');button.disabled=false;button.textContent='APPROVE';button.onclick=()=>approve(p.proposalId)}else{button.classList.add('hidden')}}else{button.classList.add('hidden')}renderActivity(s.activity)}catch(e){console.error(e)}}
document.getElementById('loginForm').addEventListener('submit',login);document.getElementById('logout').addEventListener('click',logout);showLogin(true);update();setInterval(update,1500);
</script></body></html>`);
});

app.get('/api/auth/status', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json(DASHBOARD_AUTH.status());
});

app.get('/api/auth/me', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!DASHBOARD_AUTH.isAuthenticated(req)) {
    res.status(401).json({ authenticated: false });
    return;
  }
  res.json({ authenticated: true });
});

app.post('/api/auth/login', async (req, res) => {
  const parsed = parseBody(dashboardLoginSchema, req.body);
  if (!parsed.data) {
    res.status(400).json({ success: false, error: 'Invalid login payload' });
    return;
  }
  const result = await DASHBOARD_AUTH.login(req.ip ?? 'unknown', parsed.data.password, parsed.data.website, parsed.data.turnstileToken);
  if (!result.ok) {
    if (result.retryAfterSeconds) res.setHeader('Retry-After', String(result.retryAfterSeconds));
    await audit('dashboard.login.failed', { ip: req.ip ?? 'unknown', status: result.status });
    res.status(result.status).json({ success: false, error: result.message });
    return;
  }
  DASHBOARD_AUTH.setCookie(res, result.token);
  await audit('dashboard.login.succeeded', { ip: req.ip ?? 'unknown' });
  res.setHeader('Cache-Control', 'no-store');
  res.json({ success: true });
});

app.post('/api/auth/logout', (req, res) => {
  DASHBOARD_AUTH.clearCookie(res);
  res.setHeader('Cache-Control', 'no-store');
  res.json({ success: true });
});

app.get('/api/state', (req, res) => {
  if (!dashboardOrHostAuthorized(req)) {
    res.status(401).json({ success: false, error: 'Dashboard login or host authorization required' });
    return;
  }
  res.setHeader('Cache-Control', 'no-store');
  res.json(publicState());
});

app.get('/api/health', (_req, res) => res.json({ ok: true, mcp: state.mcpStatus === 'live', marketSource: state.marketSource, binanceMode: state.binanceMode }));

app.post('/api/host/market', async (req, res) => {
  if (!hostAuthorized(req)) {
    res.status(401).json({ success: false, error: 'Supported Binance MCP host authorization is missing' });
    return;
  }
  const parsed = parseBody(hostMarketSchema, req.body);
  if (!parsed.data) {
    res.status(400).json({ success: false, error: 'Invalid host market payload' });
    return;
  }
  const symbol = parsed.data.symbol.toUpperCase();
  const { price, changePercent, toolNames, observedAt } = parsed.data;
  if (symbol !== SYMBOL) {
    res.status(400).json({ success: false, error: 'Host market symbol does not match the configured trade symbol' });
    return;
  }
  state.mcpStatus = 'live';
  state.marketSource = 'MCP';
  state.mcpTools = toolNames;
  state.ticker = { symbol, price, changePercent, raw: { source: 'binance-mcp', observedAt: observedAt ?? new Date().toISOString() } };
  state.lastError = undefined;
  touch(`Supported Binance MCP host published ${symbol} ${price}`);
  await audit('seller.market.host_received', { source: 'binance-mcp', symbol, price, changePercent, toolNames, observedAt });
  res.json({ success: true, source: 'MCP', symbol, price, changePercent, toolNames });
});

app.get('/api/report/info', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({
  service: 'Signal402 Seller Agent',
  price: reportPriceUsdc(),
  currency: 'USDC',
  payment_protocol: 'Binance B402 x402 v2',
  network: process.env.B402_NETWORK ?? 'eip155:56',
  payment_required_header: 'PAYMENT-REQUIRED',
  settlement_endpoints: ['/papi/v2/b402/verify', '/papi/v2/b402/settle'],
  });
});

app.post('/api/report', async (req, res) => {
  if (!parseBody(emptyBodySchema, req.body).data) {
    res.status(400).json({ success: false, error: 'Request body must be an empty JSON object' });
    return;
  }
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
    const message = error instanceof Error ? error.message : '';
    const missingCredentials = message.includes('credentials are missing');
    const publicError = missingCredentials
      ? 'Real B402 merchant credentials are not configured. No simulated payment is accepted.'
      : 'Payment verification or briefing delivery failed.';
    state.paymentStatus = 'error';
    state.lastError = publicError;
    touch(`Payment or briefing refused: ${publicError}`);
    await audit('seller.briefing.refused', { error: publicError });
    if (missingCredentials) {
      res.status(503).json({ success: false, error: publicError });
      return;
    }
    res.status(402).json({ success: false, error: publicError });
  }
});

app.post('/api/trade/proposal', async (req, res) => {
  if (!hostAuthorized(req)) {
    res.status(401).json({ success: false, error: 'Supported Binance MCP host authorization is required' });
    return;
  }
  const parsed = parseBody(tradeProposalInputSchema, req.body);
  if (!parsed.data) {
    res.status(400).json({ success: false, error: 'Invalid trade proposal payload' });
    return;
  }
  const body = parsed.data;
  if (state.paymentStatus !== 'settled' || !state.paymentReceiptId || body.paymentReceiptId !== state.paymentReceiptId) {
    res.status(409).json({ success: false, error: 'A proposal requires the current real B402 settlement receipt' });
    return;
  }
  const asset = body.asset.toUpperCase();
  const amount = body.amountUSDT;
  const balance = body.balanceUSDT;
  if (asset !== SYMBOL || amount > MAX_TRADE_SIZE_USDT) {
    res.status(400).json({ success: false, error: `Invalid proposal. Maximum allowed size is ${MAX_TRADE_SIZE_USDT} USDT.` });
    return;
  }
  const assessment = assessTradeRisk(balance, amount);
  const proposal: TradeProposal = {
    proposalId: body.proposalId,
    asset,
    side: 'BUY',
    amountUSDT: amount,
    balanceUSDT: balance,
    reason: `${body.reason}. ${assessment.reason}`.slice(0, 500),
    status: assessment.approved ? 'pending' : 'refused',
    riskStatus: assessment.approved ? 'approved' : 'refused',
    paymentReceiptId: body.paymentReceiptId,
    updatedAt: new Date().toISOString(),
  };
  state.proposal = proposal;
  touch(assessment.approved ? `Trade proposal ${proposal.proposalId} is waiting for human APPROVE.` : `Risk Guardian refused ${proposal.proposalId}.`);
  await audit('seller.trade.proposed', { proposalId: proposal.proposalId, asset: proposal.asset, amountUSDT: amount, balanceUSDT: balance });
  res.json({ success: true, proposalId: proposal.proposalId, status: proposal.status });
});

app.get('/api/trade/proposal/:proposalId', (req, res) => {
  if (!dashboardOrHostAuthorized(req)) {
    res.status(401).json({ success: false, error: 'Dashboard login or host authorization required' });
    return;
  }
  const proposal = state.proposal;
  if (!proposal || proposal.proposalId !== req.params.proposalId) {
    res.status(404).json({ success: false, error: 'Proposal not found' });
    return;
  }
  res.json(proposal);
});

app.post('/api/trade/approve', async (req, res) => {
  if (!DASHBOARD_AUTH.requireConfigured(res) || !DASHBOARD_AUTH.require(req, res)) return;
  const parsed = parseBody(z.object({ proposalId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/) }).strict(), req.body);
  if (!parsed.data) {
    res.status(400).json({ success: false, error: 'Invalid approval payload' });
    return;
  }
  const proposal = state.proposal;
  if (!proposal || proposal.proposalId !== parsed.data.proposalId) {
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
  if (!hostAuthorized(req)) {
    res.status(401).json({ success: false, error: 'Supported Binance MCP host authorization is required' });
    return;
  }
  const parsed = parseBody(tradeStatusInputSchema, req.body);
  if (!parsed.data) {
    res.status(400).json({ success: false, error: 'Invalid trade status payload' });
    return;
  }
  const body = parsed.data;
  const proposal = state.proposal;
  if (!proposal || proposal.proposalId !== body.proposalId) {
    res.status(404).json({ success: false, error: 'Proposal not found' });
    return;
  }
  const nextStatus = body.status;
  if (nextStatus === 'filled' && proposal.status !== 'approved') {
    res.status(409).json({ success: false, error: 'Only an approved proposal can receive a fill receipt' });
    return;
  }
  if (nextStatus === 'filled' && (
    !body.orderId
    || !body.source
    || !body.mcpToolName
    || body.filledPrice === undefined
    || body.executedQty === undefined
    || body.amountUSDT === undefined
    || !body.beforeBalances
    || !body.afterBalances
    || !state.mcpTools.includes(body.mcpToolName)
    || body.amountUSDT > proposal.amountUSDT + 0.01
  )) {
    res.status(400).json({ success: false, error: 'A filled status requires a real Binance MCP source, tool name, order ID, filled price, executed quantity, and capped quote amount' });
    return;
  }
  if (nextStatus === 'filled') {
    const beforeUSDT = body.beforeBalances!.find((balance) => balance.asset.toUpperCase() === 'USDT')?.free ?? 0;
    const afterUSDT = body.afterBalances!.find((balance) => balance.asset.toUpperCase() === 'USDT')?.free ?? 0;
    const baseAsset = proposal.asset.endsWith('USDT') ? proposal.asset.slice(0, -4) : undefined;
    const beforeBase = baseAsset ? body.beforeBalances!.find((balance) => balance.asset.toUpperCase() === baseAsset)?.free ?? 0 : 0;
    const afterBase = baseAsset ? body.afterBalances!.find((balance) => balance.asset.toUpperCase() === baseAsset)?.free ?? 0 : 0;
    if (beforeUSDT < body.amountUSDT! || afterUSDT >= beforeUSDT || (baseAsset && afterBase <= beforeBase)) {
      res.status(400).json({ success: false, error: 'Balance snapshots do not prove that the real Spot order changed the account' });
      return;
    }
  }
  proposal.status = nextStatus as ProposalStatus;
  proposal.riskStatus = nextStatus === 'refused' ? 'refused' : 'approved';
  proposal.reason = `${body.reason ?? proposal.reason}`.slice(0, 500);
  proposal.orderId = body.orderId ?? proposal.orderId;
  proposal.filledPrice = body.filledPrice ?? proposal.filledPrice;
  proposal.executedQty = body.executedQty ?? proposal.executedQty;
  proposal.source = body.source ?? proposal.source;
  proposal.mcpToolName = body.mcpToolName ?? proposal.mcpToolName;
  proposal.beforeBalances = body.beforeBalances ?? proposal.beforeBalances;
  proposal.afterBalances = body.afterBalances ?? proposal.afterBalances;
  proposal.updatedAt = new Date().toISOString();
  touch(nextStatus === 'filled' ? `REAL TRADE FILLED. Order ${proposal.orderId}` : `Trade ${nextStatus}: ${proposal.reason}`);
  await audit(`seller.trade.${nextStatus}`, { proposalId: proposal.proposalId, orderId: proposal.orderId, filledPrice: proposal.filledPrice, beforeBalances: proposal.beforeBalances, afterBalances: proposal.afterBalances });
  res.json({ success: true, status: proposal.status, orderId: proposal.orderId });
});

app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  void audit('seller.http.error', { error: error instanceof Error ? error.message : 'Unhandled request error' }).catch(() => undefined);
  res.status(500).json({ success: false, error: 'Request failed' });
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
