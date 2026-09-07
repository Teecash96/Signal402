import { createServer, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { spawn } from 'node:child_process';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { UnauthorizedError, type OAuthClientProvider, type OAuthDiscoveryState } from '@modelcontextprotocol/sdk/client/auth.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import { audit } from './audit.js';
import { decryptText, encryptText } from './cryptoStore.js';
import { isUsableSecret } from './securityConfig.js';
import type { FuturesMarketType, FuturesOpenOrderInput, FuturesPositionSide } from './futuresRisk.js';

export const BINANCE_AGENTIC_MCP_URL = process.env.BINANCE_MCP_URL ?? 'https://agent.binance.com/mcp/agentic';
export const MCP_CALLBACK_PORT = Number.parseInt(process.env.MCP_CALLBACK_PORT ?? '8765', 10);
export const MCP_CALLBACK_URL = process.env.MCP_CALLBACK_URL ?? `http://localhost:${MCP_CALLBACK_PORT}/oauth/callback`;
export const MCP_CLIENT_METADATA_URL = process.env.MCP_CLIENT_METADATA_URL
  ?? 'https://raw.githubusercontent.com/Teecash96/Signal402/main/client-metadata.json';
export const MCP_TOKEN_FILE = process.env.MCP_TOKEN_FILE ?? '.mcp-tokens.json';

type ToolDefinition = {
  name: string;
  description?: string;
  inputSchema?: {
    properties?: Record<string, unknown>;
    required?: string[];
  };
};

type TokenStore = {
  clientInformation?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
  codeVerifier?: string;
  discoveryState?: OAuthDiscoveryState;
};

export interface BinanceTicker {
  symbol: string;
  price: number;
  changePercent?: number;
  highPrice?: number;
  lowPrice?: number;
  weightedAvgPrice?: number;
  volume?: number;
  quoteVolume?: number;
  raw: unknown;
}

export interface BinanceBalance {
  asset: string;
  free: number;
  locked: number;
  raw: unknown;
}

export interface BinanceOrder {
  orderId: string;
  mcpToolName?: string;
  status?: string;
  symbol?: string;
  side?: string;
  executedQty?: number;
  quoteAmount?: number;
  averagePrice?: number;
  raw: unknown;
}

export type SpotOrderRequest = {
  symbol: string;
  side: 'BUY' | 'SELL';
  quoteOrderQty?: number;
  quantity?: number;
};

export interface BinanceFuturesPosition {
  symbol: string;
  positionSide: FuturesPositionSide;
  positionAmt: number;
  entryPrice: number;
  markPrice: number;
  liquidationPrice?: number;
  leverage?: number;
  marginMode?: 'ISOLATED' | 'CROSSED';
  initialMarginUSDT?: number;
  maintenanceMarginUSDT?: number;
  unrealizedPnlUSDT?: number;
  notionalUSDT?: number;
  raw: unknown;
}

export interface BinanceFuturesOpenOrder extends FuturesOpenOrderInput {
  orderId?: string;
  raw: unknown;
}

export interface BinanceFuturesAccount {
  marketType: FuturesMarketType;
  walletBalanceUSDT: number;
  availableBalanceUSDT: number;
  marginBalanceUSDT: number;
  initialMarginUSDT: number;
  maintenanceMarginUSDT: number;
  openOrderInitialMarginUSDT: number;
  positions: BinanceFuturesPosition[];
  openOrders: BinanceFuturesOpenOrder[];
  openOrdersNotionalUSDT?: number;
  mcpToolName: string;
  raw: unknown;
}

export interface BinanceFuturesMarket {
  marketType: FuturesMarketType;
  symbol: string;
  markPrice: number;
  indexPrice?: number;
  bidPrice?: number;
  askPrice?: number;
  orderBookDepthUSDT?: number;
  estimatedSlippageBps?: number;
  fundingRateBps?: number;
  nextFundingTime?: string | number;
  exchangeFiltersVerified: boolean;
  leverageBracketVerified: boolean;
  orderBookVerified: boolean;
  observedAt: string;
  mcpToolName: string;
  raw: unknown;
}

export type FuturesOrderRequest = {
  marketType: FuturesMarketType;
  symbol: string;
  side: 'BUY' | 'SELL';
  positionSide: FuturesPositionSide;
  quantity: number;
  notionalUSDT: number;
  reduceOnly: boolean;
  leverage: number;
  marginMode: 'ISOLATED';
  protectiveStopPrice?: number;
  protectiveStopSupported?: boolean;
};

export interface BinanceFuturesOrder extends BinanceOrder {
  marketType: 'USD_M';
  positionSide: FuturesPositionSide;
  reduceOnly: boolean;
}

class FileOAuthProvider implements OAuthClientProvider {
  private store: TokenStore = {};
  private loaded = false;
  private readonly stateValue = randomUUID();
  private onRedirect?: (authorizationUrl: URL) => Promise<void>;

  public constructor(
    private readonly tokenFile: string,
    private readonly callbackUrl: string,
    private readonly metadataUrl: string,
    onRedirect?: (authorizationUrl: URL) => Promise<void>,
  ) {
    this.onRedirect = onRedirect;
  }

  public setRedirectHandler(handler: (authorizationUrl: URL) => Promise<void>): void {
    this.onRedirect = handler;
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const contents = await readFile(this.tokenFile, 'utf8');
      const secret = process.env.MCP_TOKEN_ENCRYPTION_KEY;
      if (!isUsableSecret(secret, 16)) throw new Error('MCP_TOKEN_ENCRYPTION_KEY is required to unlock the encrypted OAuth cache');
      if (contents.trimStart().startsWith('{')) {
        throw new Error('Refusing a plaintext OAuth token cache. Delete the old token file and set MCP_TOKEN_ENCRYPTION_KEY before signing in again.');
      }
      this.store = JSON.parse(decryptText(contents, secret)) as TokenStore;
    } catch (error: unknown) {
      const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
      if (code !== 'ENOENT') throw error;
    }
  }

  private async save(): Promise<void> {
    const secret = process.env.MCP_TOKEN_ENCRYPTION_KEY;
    if (!isUsableSecret(secret, 16)) throw new Error('MCP_TOKEN_ENCRYPTION_KEY is required to save the encrypted OAuth cache');
    await mkdir(dirname(this.tokenFile), { recursive: true, mode: 0o700 });
    await writeFile(this.tokenFile, `${encryptText(JSON.stringify(this.store), secret)}\n`, { encoding: 'utf8', mode: 0o600 });
    await chmod(this.tokenFile, 0o600);
  }

  public get redirectUrl(): string {
    return this.callbackUrl;
  }

  public get clientMetadataUrl(): string {
    return this.metadataUrl;
  }

  public get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: 'Signal402 Binance Agent OS client',
      redirect_uris: [this.callbackUrl],
      grant_types: ['authorization_code'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    };
  }

  public async state(): Promise<string> {
    return this.stateValue;
  }

  public async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
    await this.load();
    return this.store.clientInformation;
  }

  public async saveClientInformation(clientInformation: OAuthClientInformationMixed): Promise<void> {
    await this.load();
    this.store.clientInformation = clientInformation;
    await this.save();
  }

  public async tokens(): Promise<OAuthTokens | undefined> {
    await this.load();
    return this.store.tokens;
  }

  public async saveTokens(tokens: OAuthTokens): Promise<void> {
    await this.load();
    this.store.tokens = tokens;
    await this.save();
  }

  public async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    if (!this.onRedirect) throw new Error('OAuth browser redirect handler is not configured');
    await this.onRedirect(authorizationUrl);
  }

  public async saveCodeVerifier(codeVerifier: string): Promise<void> {
    await this.load();
    this.store.codeVerifier = codeVerifier;
    await this.save();
  }

  public async codeVerifier(): Promise<string> {
    await this.load();
    if (!this.store.codeVerifier) throw new Error('Missing OAuth PKCE code verifier');
    return this.store.codeVerifier;
  }

  public async saveDiscoveryState(discoveryState: OAuthDiscoveryState): Promise<void> {
    await this.load();
    this.store.discoveryState = discoveryState;
    await this.save();
  }

  public async discoveryState(): Promise<OAuthDiscoveryState | undefined> {
    await this.load();
    return this.store.discoveryState;
  }

  public async invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'): Promise<void> {
    await this.load();
    if (scope === 'all' || scope === 'client') delete this.store.clientInformation;
    if (scope === 'all' || scope === 'tokens') delete this.store.tokens;
    if (scope === 'all' || scope === 'verifier') delete this.store.codeVerifier;
    if (scope === 'all' || scope === 'discovery') delete this.store.discoveryState;
    await this.save();
  }
}

type PendingCallback = {
  promise: Promise<string>;
  resolve: (code: string) => void;
  reject: (error: Error) => void;
};

function openInBrowser(url: URL): void {
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  const args = process.platform === 'win32' ? ['', url.toString()] : [url.toString()];
  const child = spawn(command, args, { detached: true, stdio: 'ignore' });
  child.unref();
}

function toNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function isPositive(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function configuredFuturesNotionalCap(): number {
  const configured = Number.parseFloat(process.env.MAX_FUTURES_NOTIONAL_USDT ?? '10');
  return Number.isFinite(configured) ? Math.min(Math.max(configured, 0.01), 10) : 10;
}

function configuredFuturesLeverageCap(): number {
  const configured = Number.parseFloat(process.env.MAX_FUTURES_LEVERAGE ?? '3');
  return Number.isFinite(configured) ? Math.min(Math.max(configured, 1), 3) : 3;
}

function parseJsonText(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function unwrapMcpResult(result: unknown): unknown {
  if (!result || typeof result !== 'object') return result;
  const record = result as Record<string, unknown>;
  if (record.isError === true) throw new Error(`Binance MCP tool returned an error: ${JSON.stringify(result)}`);
  if (record.structuredContent !== undefined) return record.structuredContent;
  if (Array.isArray(record.content)) {
    const parsed = record.content
      .map((item) => item && typeof item === 'object' && 'text' in item ? parseJsonText((item as { text?: unknown }).text) : item)
      .filter((item) => item !== undefined);
    if (parsed.length === 1) return parsed[0];
    if (parsed.length > 1) return parsed;
  }
  return result;
}

function walkObjects(value: unknown, callback: (record: Record<string, unknown>) => void): void {
  if (Array.isArray(value)) {
    for (const item of value) walkObjects(item, callback);
    return;
  }
  if (!value || typeof value !== 'object') return;
  const record = value as Record<string, unknown>;
  callback(record);
  for (const child of Object.values(record)) walkObjects(child, callback);
}

function findProperty(record: Record<string, unknown>, names: string[]): unknown {
  for (const name of names) {
    const key = Object.keys(record).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
    if (key) return record[key];
  }
  return undefined;
}

function normaliseSymbol(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value.trim().toUpperCase() : fallback;
}

function hasUsdMFuturesMarker(text: string): boolean {
  return /usd.*m|usdm|um.?futures/i.test(text);
}

function hasCoinMFuturesMarker(text: string): boolean {
  return /coin.*m|coinm|cm.?futures/i.test(text);
}

function assertFuturesTool(tool: ToolDefinition, marketType: FuturesMarketType, write: boolean): void {
  const text = `${tool.name} ${tool.description ?? ''}`;
  if (!/(futures|perpetual|perp|derivative|contract|usd.*m|coin.*m|usdm|coinm)/i.test(text)) {
    throw new Error(`Runtime MCP tool ${tool.name} is not clearly identified as a Futures tool`);
  }
  if (write && hasCoinMFuturesMarker(text)) throw new Error('COIN M order writes are disabled');
  if (marketType === 'USD_M' && hasCoinMFuturesMarker(text) && !hasUsdMFuturesMarker(text)) throw new Error(`Runtime MCP tool ${tool.name} is identified as COIN M, not USD M`);
  if (marketType === 'COIN_M' && hasUsdMFuturesMarker(text) && !hasCoinMFuturesMarker(text)) throw new Error(`Runtime MCP tool ${tool.name} is identified as USD M, not COIN M`);
}

function timestampToIso(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
  }
  const numberValue = toNumber(value);
  if (numberValue === undefined) return undefined;
  const milliseconds = numberValue < 10_000_000_000 ? numberValue * 1000 : numberValue;
  return new Date(milliseconds).toISOString();
}

function orderBookDepth(record: Record<string, unknown>): number | undefined {
  const direct = toNumber(findProperty(record, ['orderBookDepthUSDT', 'depthUSDT', 'depth', 'quoteDepth', 'notionalDepth']));
  if (direct !== undefined && direct > 0) return direct;
  let total = 0;
  for (const sideName of ['bids', 'asks']) {
    const side = findProperty(record, [sideName]);
    if (!Array.isArray(side)) continue;
    for (const level of side) {
      if (Array.isArray(level)) {
        const price = toNumber(level[0]);
        const quantity = toNumber(level[1]);
        if (price !== undefined && quantity !== undefined) total += Math.abs(price * quantity);
      } else if (level && typeof level === 'object') {
        const levelRecord = level as Record<string, unknown>;
        const price = toNumber(findProperty(levelRecord, ['price', 'p']));
        const quantity = toNumber(findProperty(levelRecord, ['quantity', 'qty', 'q', 'amount']));
        if (price !== undefined && quantity !== undefined) total += Math.abs(price * quantity);
      }
    }
  }
  return total > 0 ? total : undefined;
}

function parseOrderRecord(raw: unknown, toolName: string, request: { symbol: string; side: string; positionSide: FuturesPositionSide; reduceOnly: boolean }, marketType: 'USD_M'): BinanceFuturesOrder | undefined {
  let parsed: BinanceFuturesOrder | undefined;
  walkObjects(raw, (record) => {
    if (parsed) return;
    const idValue = findProperty(record, ['orderId', 'orderID', 'id', 'clientOrderId']);
    if (idValue === undefined || idValue === null || `${idValue}`.trim() === '') return;
    const executedQty = toNumber(findProperty(record, ['executedQty', 'executedQuantity', 'filledQty', 'quantityFilled']));
    const averagePrice = toNumber(findProperty(record, ['avgPrice', 'averagePrice', 'fillPrice', 'price']));
    const statusValue = findProperty(record, ['status', 'orderStatus', 'executionType']);
    const positionSideValue = findProperty(record, ['positionSide', 'position_side']);
    const reduceOnlyValue = findProperty(record, ['reduceOnly', 'reduce_only']);
    parsed = {
      orderId: `${idValue}`,
      mcpToolName: toolName,
      status: typeof statusValue === 'string' ? statusValue : undefined,
      symbol: normaliseSymbol(findProperty(record, ['symbol', 'pair', 'contract']), request.symbol),
      side: typeof findProperty(record, ['side']) === 'string' ? `${findProperty(record, ['side'])}` : request.side,
      executedQty,
      quoteAmount: toNumber(findProperty(record, ['cumQuote', 'quoteAmount', 'notional', 'cumBase'])),
      averagePrice,
      raw,
      marketType,
      positionSide: positionSideValue === 'LONG' || positionSideValue === 'SHORT' || positionSideValue === 'BOTH'
        ? positionSideValue
        : request.positionSide,
      reduceOnly: typeof reduceOnlyValue === 'boolean' ? reduceOnlyValue : request.reduceOnly,
    };
  });
  return parsed;
}

export class BinanceMcpClient {
  private client?: Client;
  private transport?: StreamableHTTPClientTransport;
  private provider: FileOAuthProvider;
  private callbackServer?: Server;
  private pendingCallback?: PendingCallback;
  private tools: ToolDefinition[] = [];
  private connectPromise?: Promise<void>;

  public constructor(
    private readonly serverUrl = BINANCE_AGENTIC_MCP_URL,
    tokenFile = MCP_TOKEN_FILE,
  ) {
    this.provider = new FileOAuthProvider(tokenFile, MCP_CALLBACK_URL, MCP_CLIENT_METADATA_URL);
    this.provider.setRedirectHandler(async (authorizationUrl) => {
      await this.startCallbackServer();
      console.log(`\n🔐 Binance OAuth required. Opening browser: ${authorizationUrl.toString()}`);
      console.log(`   OAuth callback: ${MCP_CALLBACK_URL}`);
      openInBrowser(authorizationUrl);
    });
  }

  public get toolNames(): string[] {
    return this.tools.map((tool) => tool.name);
  }

  public get isConnected(): boolean {
    return Boolean(this.client && this.transport);
  }

  public async connect(): Promise<void> {
    if (this.isConnected) return;
    if (this.connectPromise) return this.connectPromise;
    this.connectPromise = this.connectInternal().finally(() => {
      this.connectPromise = undefined;
    });
    return this.connectPromise;
  }

  private async connectInternal(): Promise<void> {
    if (process.env.SIGNAL402_BINANCE_MODE !== 'direct' || process.env.BINANCE_MCP_CLIENT_APPROVED !== 'true') {
      throw new Error('Direct Binance MCP OAuth is disabled. Use the supported Binance MCP host. Set SIGNAL402_BINANCE_MODE=direct and BINANCE_MCP_CLIENT_APPROVED=true only after Binance approves this client.');
    }
    if (!isUsableSecret(process.env.MCP_TOKEN_ENCRYPTION_KEY, 16)) {
      throw new Error('MCP_TOKEN_ENCRYPTION_KEY is required. OAuth tokens are never cached in plaintext.');
    }
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const client = new Client({ name: 'signal402', version: '1.0.0' }, { capabilities: {} });
      const transport = new StreamableHTTPClientTransport(new URL(this.serverUrl), {
        authProvider: this.provider,
      });
      this.client = client;
      this.transport = transport;
      try {
        await client.connect(transport);
        const result = await client.listTools();
        this.tools = (result.tools ?? []) as ToolDefinition[];
        console.log(`✅ Binance MCP connected: ${this.serverUrl}`);
        console.log(`🧰 Runtime MCP tools (${this.tools.length}):`);
        for (const tool of this.tools) console.log(`   • ${tool.name}${tool.description ? `: ${tool.description}` : ''}`);
        await audit('mcp.connected', { serverUrl: this.serverUrl, tools: this.toolNames });
        return;
      } catch (error: unknown) {
        lastError = error;
        if (!(error instanceof UnauthorizedError)) throw error;
        const authorizationCode = await this.waitForCallback();
        await transport.finishAuth(authorizationCode);
        await transport.close();
        this.client = undefined;
        this.transport = undefined;
        console.log('✅ Binance OAuth tokens saved. Reconnecting to MCP.');
      }
    }
    throw lastError instanceof Error ? lastError : new Error('Binance MCP authentication failed');
  }

  private async startCallbackServer(): Promise<void> {
    if (this.callbackServer && this.pendingCallback) return;
    const expectedState = await this.provider.state();
    this.pendingCallback = {} as PendingCallback;
    this.pendingCallback.promise = new Promise<string>((resolve, reject) => {
      this.pendingCallback!.resolve = resolve;
      this.pendingCallback!.reject = reject;
    });
    this.callbackServer = createServer((request, response) => {
      const requestUrl = new URL(request.url ?? '/', `http://localhost:${MCP_CALLBACK_PORT}`);
      if (requestUrl.pathname !== new URL(MCP_CALLBACK_URL).pathname) {
        response.writeHead(404);
        response.end('Not found');
        return;
      }
      const error = requestUrl.searchParams.get('error');
      const code = requestUrl.searchParams.get('code');
      const returnedState = requestUrl.searchParams.get('state');
      if (returnedState !== expectedState) {
        this.pendingCallback?.reject(new Error('Binance OAuth state validation failed'));
        response.writeHead(400, { 'content-type': 'text/html; charset=utf-8' });
        response.end('<h1>Binance authorization failed</h1><p>OAuth state did not match.</p>');
        void this.stopCallbackServer();
        return;
      }
      if (error) {
        this.pendingCallback?.reject(new Error(`Binance OAuth authorization failed: ${error}`));
        response.writeHead(400, { 'content-type': 'text/html; charset=utf-8' });
        response.end('<h1>Binance authorization failed</h1><p>You can close this window.</p>');
        void this.stopCallbackServer();
        return;
      }
      if (!code) {
        response.writeHead(400);
        response.end('Missing authorization code');
        return;
      }
      this.pendingCallback?.resolve(code);
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end('<h1>Signal402 connected</h1><p>You can close this window and return to the terminal.</p>');
      void this.stopCallbackServer();
    });
    await new Promise<void>((resolve, reject) => {
      this.callbackServer!.once('error', reject);
      this.callbackServer!.listen(MCP_CALLBACK_PORT, '127.0.0.1', () => resolve());
    });
  }

  private async stopCallbackServer(): Promise<void> {
    const server = this.callbackServer;
    this.callbackServer = undefined;
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private async waitForCallback(): Promise<string> {
    if (!this.pendingCallback) throw new Error('OAuth callback listener was not started');
    const pending = this.pendingCallback.promise;
    try {
      return await pending;
    } finally {
      this.pendingCallback = undefined;
      await this.stopCallbackServer();
    }
  }

  private requireClient(): Client {
    if (!this.client) throw new Error('Binance MCP client is not connected');
    return this.client;
  }

  private selectTool(kind: 'ticker' | 'balances' | 'spotOrder' | 'futuresAccount' | 'futuresMarket' | 'futuresOrder' | 'futuresOrderStatus'): ToolDefinition {
    if (this.tools.length === 0) throw new Error('Binance MCP returned no tools');
    const scored = this.tools.map((tool) => {
      const text = `${tool.name} ${tool.description ?? ''}`.toLowerCase();
      let score = 0;
      if (kind === 'ticker') {
        if (/(ticker|price|quote|market data)/.test(text)) score += 7;
        if (/(24h|symbol|spot)/.test(text)) score += 2;
        if (/(futures|usd.?m|coin.?m|perpetual|derivative|contract)/.test(text)) score -= 4;
        if (/(order|trade|balance|account|klines|candles)/.test(text)) score -= 5;
      } else if (kind === 'balances') {
        if (/(balance|account|asset)/.test(text)) score += 8;
        if (/(spot|wallet)/.test(text)) score += 2;
        if (/(futures|usd.?m|coin.?m|perpetual|derivative|contract)/.test(text)) score -= 4;
        if (/(transfer|withdraw|deposit|order|trade)/.test(text)) score -= 5;
      } else if (kind === 'spotOrder') {
        if (/(spot|order|trade)/.test(text)) score += 7;
        if (/(create|place|new|market|buy|sell)/.test(text)) score += 3;
        if (/(balance|account|ticker|price|transfer|withdraw)/.test(text)) score -= 5;
        if (/(futures|usd.?m|coin.?m|perpetual|derivative|contract)/.test(text)) score -= 10;
      } else if (kind === 'futuresAccount') {
        if (/(futures|usd.?m|coin.?m|perpetual|derivative|contract)/.test(text)) score += 8;
        if (/(account|balance|position|margin|wallet)/.test(text)) score += 5;
        if (/(spot|convert|withdraw|transfer|deposit|order|trade)/.test(text)) score -= 7;
      } else if (kind === 'futuresMarket') {
        if (/(futures|usd.?m|coin.?m|perpetual|derivative|contract)/.test(text)) score += 8;
        if (/(ticker|mark|funding|order.?book|depth|price|exchange.?info|filter)/.test(text)) score += 5;
        if (/(spot|convert|withdraw|transfer|deposit|account|balance|order|trade)/.test(text)) score -= 7;
      } else if (kind === 'futuresOrder') {
        if (/(futures|usd.?m|perpetual|derivative|contract)/.test(text)) score += 10;
        if (/(order|trade|create|place|new|market|buy|sell)/.test(text)) score += 5;
        if (/(coin.?m|spot|convert|margin|withdraw|transfer|deposit|balance|account|ticker|price)/.test(text)) score -= 8;
        if (/(status|query|get|open)/.test(text)) score += 1;
      } else {
        if (/(futures|usd.?m|perpetual|derivative|contract)/.test(text)) score += 8;
        if (/(order|trade|status|query|open|history)/.test(text)) score += 6;
        if (/(create|place|new|submit|cancel|buy|sell)/.test(text)) score -= 7;
        if (/(coin.?m|spot|convert|margin|withdraw|transfer|deposit|balance|account|ticker|price)/.test(text)) score -= 8;
      }
      return { tool, score };
    }).sort((left, right) => right.score - left.score);
    if (scored[0].score <= 0) {
      throw new Error(`Could not identify a runtime MCP tool for ${kind}. Available tools: ${this.toolNames.join(', ')}`);
    }
    return scored[0].tool;
  }

  private async callTool(tool: ToolDefinition, arguments_: Record<string, unknown>): Promise<unknown> {
    const client = this.requireClient();
    await audit('mcp.tool.call', { tool: tool.name, arguments: arguments_ });
    const result = await client.callTool({ name: tool.name, arguments: arguments_ });
    const unwrapped = unwrapMcpResult(result);
    await audit('mcp.tool.result', { tool: tool.name, success: true });
    return unwrapped;
  }

  private argumentKeys(tool: ToolDefinition): string[] {
    return Object.keys(tool.inputSchema?.properties ?? {});
  }

  public async getTicker(symbol = 'BNBUSDT'): Promise<BinanceTicker> {
    await this.connect();
    const tool = this.selectTool('ticker');
    const args: Record<string, unknown> = {};
    const keys = this.argumentKeys(tool);
    const symbolKey = keys.find((key) => /(symbol|pair|ticker|instrument)/i.test(key));
    if (symbolKey) args[symbolKey] = symbol;
    else if (keys.length === 1) args[keys[0]] = symbol;
    const raw = await this.callTool(tool, args);
    let found: BinanceTicker | undefined;
    walkObjects(raw, (record) => {
      if (found) return;
      const price = toNumber(findProperty(record, ['price', 'lastPrice', 'last', 'close', 'currentPrice']))
        ?? (typeof record.result === 'object' && record.result ? toNumber(findProperty(record.result as Record<string, unknown>, ['price', 'lastPrice'])) : undefined);
      if (price === undefined) return;
      const symbolValue = findProperty(record, ['symbol', 'pair', 'instrument']);
      const change = toNumber(findProperty(record, ['priceChangePercent', 'changePercent', 'percentChange', 'change24h']));
      found = {
        symbol: normaliseSymbol(symbolValue, symbol),
        price,
        changePercent: change,
        highPrice: toNumber(findProperty(record, ['highPrice', 'dayHigh', 'high', '24hHigh'])),
        lowPrice: toNumber(findProperty(record, ['lowPrice', 'dayLow', 'low', '24hLow'])),
        weightedAvgPrice: toNumber(findProperty(record, ['weightedAvgPrice', 'weightedAveragePrice', 'vwap'])),
        volume: toNumber(findProperty(record, ['volume', 'baseVolume'])),
        quoteVolume: toNumber(findProperty(record, ['quoteVolume', 'quoteAssetVolume'])),
        raw,
      };
    });
    if (!found) throw new Error(`Binance MCP ticker tool ${tool.name} returned no numeric price`);
    return found;
  }

  public async getBalances(): Promise<BinanceBalance[]> {
    await this.connect();
    const tool = this.selectTool('balances');
    const raw = await this.callTool(tool, {});
    const balances: BinanceBalance[] = [];
    walkObjects(raw, (record) => {
      const assetValue = findProperty(record, ['asset', 'assetCode', 'coin', 'currency']);
      if (typeof assetValue !== 'string' || !assetValue.trim()) return;
      const free = toNumber(findProperty(record, ['free', 'available', 'availableBalance', 'freeBalance'])) ?? 0;
      const locked = toNumber(findProperty(record, ['locked', 'hold', 'lockedBalance', 'frozen'])) ?? 0;
      if (free === 0 && locked === 0 && !('free' in record) && !('available' in record)) return;
      if (!balances.some((balance) => balance.asset === assetValue.toUpperCase())) {
        balances.push({ asset: assetValue.toUpperCase(), free, locked, raw: record });
      }
    });
    if (balances.length === 0) throw new Error(`Binance MCP balance tool ${tool.name} returned no balances`);
    return balances;
  }

  public async getUsdtBalance(): Promise<BinanceBalance> {
    const balances = await this.getBalances();
    const usdt = balances.find((balance) => balance.asset === 'USDT');
    if (!usdt) throw new Error('Binance MCP response did not include a USDT balance');
    return usdt;
  }

  public async placeSpotOrder(request: SpotOrderRequest): Promise<BinanceOrder> {
    await this.connect();
    const tool = this.selectTool('spotOrder');
    const keys = this.argumentKeys(tool);
    const args: Record<string, unknown> = {};
    for (const key of keys) {
      const lower = key.toLowerCase();
      if (/(symbol|pair|ticker|instrument)/.test(lower)) args[key] = request.symbol;
      else if (lower === 'side' || lower.includes('orderside')) args[key] = request.side;
      else if (lower === 'type' || lower.includes('ordertype')) args[key] = 'MARKET';
      else if (/(quote.*(qty|quantity|amount)|notional|usdt.*amount)/.test(lower) && request.quoteOrderQty !== undefined) args[key] = request.quoteOrderQty;
      else if (/(^quantity$|base.*(qty|quantity|amount)|order.*quantity)/.test(lower) && request.quantity !== undefined) args[key] = request.quantity;
      else if (lower === 'neworderresptype' || lower === 'responseType'.toLowerCase()) args[key] = 'FULL';
    }
    if (Object.keys(args).length === 0) throw new Error(`MCP spot order schema for ${tool.name} had no recognised fields`);
    const raw = await this.callTool(tool, args);
    let order: BinanceOrder | undefined;
    walkObjects(raw, (record) => {
      if (order) return;
      const idValue = findProperty(record, ['orderId', 'orderID', 'id', 'clientOrderId']);
      if (idValue === undefined || idValue === null || `${idValue}`.trim() === '') return;
      const status = findProperty(record, ['status', 'orderStatus']);
      const executedQty = toNumber(findProperty(record, ['executedQty', 'executedQuantity', 'filledQty', 'quantityFilled']));
      const quoteAmount = toNumber(findProperty(record, ['cummulativeQuoteQty', 'cumQuote', 'quoteOrderQty', 'quoteAmount', 'notional']));
      const averagePrice = toNumber(findProperty(record, ['avgPrice', 'averagePrice', 'price']));
      const fills = findProperty(record, ['fills']);
      let fillQuantity = executedQty;
      let fillQuote = quoteAmount;
      if (Array.isArray(fills)) {
        let quantityTotal = 0;
        let quoteTotal = 0;
        for (const fill of fills) {
          if (!fill || typeof fill !== 'object') continue;
          const fillRecord = fill as Record<string, unknown>;
          const fillQty = toNumber(findProperty(fillRecord, ['qty', 'quantity', 'executedQty']));
          const fillPrice = toNumber(findProperty(fillRecord, ['price', 'fillPrice']));
          if (fillQty !== undefined) quantityTotal += fillQty;
          if (fillQty !== undefined && fillPrice !== undefined) quoteTotal += fillQty * fillPrice;
        }
        if (quantityTotal > 0) fillQuantity = quantityTotal;
        if (quoteTotal > 0) fillQuote = quoteTotal;
      }
      order = {
        orderId: `${idValue}`,
        mcpToolName: tool.name,
        status: typeof status === 'string' ? status : undefined,
        symbol: typeof findProperty(record, ['symbol', 'pair']) === 'string' ? `${findProperty(record, ['symbol', 'pair'])}` : request.symbol,
        side: typeof findProperty(record, ['side']) === 'string' ? `${findProperty(record, ['side'])}` : request.side,
        executedQty: fillQuantity,
        quoteAmount: fillQuote,
        averagePrice: averagePrice ?? (fillQuantity && fillQuote ? fillQuote / fillQuantity : undefined),
        raw,
      };
    });
    if (!order) throw new Error(`Binance MCP spot order tool ${tool.name} returned no order ID`);
    await audit('mcp.order.confirmed', { orderId: order.orderId, status: order.status, symbol: order.symbol, side: order.side });
    return order;
  }

  /** Read a USDⓈ M or COIN M account through a runtime discovered Futures tool. */
  public async getFuturesAccount(marketType: FuturesMarketType = 'USD_M'): Promise<BinanceFuturesAccount> {
    await this.connect();
    const tool = this.selectTool('futuresAccount');
    assertFuturesTool(tool, marketType, false);
    const keys = this.argumentKeys(tool);
    const args: Record<string, unknown> = {};
    for (const key of keys) {
      const lower = key.toLowerCase();
      if (/(market|contract|product|venue)/.test(lower) && /(type|kind|market|contract)/.test(lower)) args[key] = marketType;
    }
    const raw = await this.callTool(tool, args);
    let walletBalanceUSDT: number | undefined;
    let availableBalanceUSDT: number | undefined;
    let marginBalanceUSDT: number | undefined;
    let initialMarginUSDT: number | undefined;
    let maintenanceMarginUSDT: number | undefined;
    let openOrderInitialMarginUSDT: number | undefined;
    let openOrdersNotionalUSDT: number | undefined;
    const positions: BinanceFuturesPosition[] = [];
    const openOrders: BinanceFuturesOpenOrder[] = [];
    walkObjects(raw, (record) => {
      walletBalanceUSDT ??= toNumber(findProperty(record, ['walletBalance', 'totalWalletBalance']));
      availableBalanceUSDT ??= toNumber(findProperty(record, ['availableBalance', 'availableMargin', 'availableWalletBalance']));
      marginBalanceUSDT ??= toNumber(findProperty(record, ['marginBalance', 'totalMarginBalance']));
      initialMarginUSDT ??= toNumber(findProperty(record, ['totalInitialMargin', 'initialMargin', 'positionInitialMargin']));
      maintenanceMarginUSDT ??= toNumber(findProperty(record, ['totalMaintMargin', 'maintenanceMargin', 'maintMargin']));
      if (openOrderInitialMarginUSDT === undefined) {
        const value = toNumber(findProperty(record, ['totalOpenOrderInitialMargin', 'openOrderInitialMargin', 'openOrdersInitialMargin']));
        if (value !== undefined) openOrderInitialMarginUSDT = value;
      }
      openOrdersNotionalUSDT ??= toNumber(findProperty(record, ['openOrdersNotionalUSDT', 'openOrderNotional', 'openOrdersNotional']));
      const symbolValue = findProperty(record, ['symbol', 'pair', 'contract', 'instrument']);
      const orderIdValue = findProperty(record, ['orderId', 'orderID', 'clientOrderId', 'client_order_id']);
      const orderQuantity = toNumber(findProperty(record, ['origQty', 'originalQuantity', 'quantity', 'qty', 'orderQuantity']));
      const orderNotional = toNumber(findProperty(record, ['notionalUSDT', 'notional', 'quoteOrderQty', 'quoteAmount']));
      if (typeof symbolValue === 'string' && orderIdValue !== undefined && (orderQuantity !== undefined || orderNotional !== undefined)) {
        const orderStatus = findProperty(record, ['status', 'orderStatus']);
        const terminal = typeof orderStatus === 'string' && /^(FILLED|CANCELED|CANCELLED|EXPIRED|REJECTED)$/i.test(orderStatus);
        if (!terminal && !openOrders.some((candidate) => candidate.orderId === `${orderIdValue}`)) {
          const sideValue = findProperty(record, ['side', 'orderSide']);
          const positionSideValue = findProperty(record, ['positionSide', 'position_side']);
          openOrders.push({
            orderId: `${orderIdValue}`,
            symbol: normaliseSymbol(symbolValue, ''),
            side: sideValue === 'BUY' || sideValue === 'SELL' ? sideValue : undefined,
            positionSide: positionSideValue === 'LONG' || positionSideValue === 'SHORT' || positionSideValue === 'BOTH'
              ? positionSideValue : undefined,
            quantity: orderQuantity,
            notionalUSDT: orderNotional,
            reduceOnly: findProperty(record, ['reduceOnly', 'reduce_only']) === true,
            status: typeof orderStatus === 'string' ? orderStatus : undefined,
            raw: record,
          });
        }
      }
      const positionAmt = toNumber(findProperty(record, ['positionAmt', 'positionAmount', 'positionSize', 'positionQuantity']));
      if (typeof symbolValue !== 'string' || positionAmt === undefined) return;
      const positionSideValue = findProperty(record, ['positionSide', 'position_side']);
      const positionSide: FuturesPositionSide = positionSideValue === 'LONG' || positionSideValue === 'SHORT' || positionSideValue === 'BOTH'
        ? positionSideValue
        : 'BOTH';
      const markPrice = toNumber(findProperty(record, ['markPrice', 'fairPrice', 'indexPrice', 'lastPrice'])) ?? 0;
      const entryPrice = toNumber(findProperty(record, ['entryPrice', 'averageEntryPrice', 'avgEntryPrice'])) ?? 0;
      const liquidationPrice = toNumber(findProperty(record, ['liquidationPrice', 'liqPrice']));
      const marginType = findProperty(record, ['marginType', 'marginMode']);
      const marginMode = typeof marginType === 'string' && marginType.toUpperCase().includes('CROSS') ? 'CROSSED' : 'ISOLATED';
      const position: BinanceFuturesPosition = {
        symbol: normaliseSymbol(symbolValue, ''),
        positionSide,
        positionAmt,
        entryPrice,
        markPrice,
        liquidationPrice,
        leverage: toNumber(findProperty(record, ['leverage', 'initialLeverage'])),
        marginMode,
        initialMarginUSDT: toNumber(findProperty(record, ['initialMargin', 'positionInitialMargin'])),
        maintenanceMarginUSDT: toNumber(findProperty(record, ['maintMargin', 'maintenanceMargin'])),
        unrealizedPnlUSDT: toNumber(findProperty(record, ['unrealizedProfit', 'unrealizedPnl', 'unrealizedPnlUSDT'])),
        notionalUSDT: toNumber(findProperty(record, ['notional', 'notionalUSDT', 'positionNotional'])),
        raw: record,
      };
      if (position.symbol && !positions.some((candidate) => candidate.symbol === position.symbol && candidate.positionSide === position.positionSide && candidate.positionAmt === position.positionAmt)) positions.push(position);
    });
    if (walletBalanceUSDT === undefined || availableBalanceUSDT === undefined || marginBalanceUSDT === undefined || initialMarginUSDT === undefined || maintenanceMarginUSDT === undefined || openOrderInitialMarginUSDT === undefined) {
      throw new Error(`Binance MCP Futures account tool ${tool.name} returned incomplete account margin data`);
    }
    const account: BinanceFuturesAccount = {
      marketType,
      walletBalanceUSDT,
      availableBalanceUSDT,
      marginBalanceUSDT,
      initialMarginUSDT,
      maintenanceMarginUSDT,
      openOrderInitialMarginUSDT,
      positions,
      openOrders,
      openOrdersNotionalUSDT: openOrdersNotionalUSDT ?? openOrders.reduce((sum, order) => sum + (order.notionalUSDT ?? 0), 0),
      mcpToolName: tool.name,
      raw,
    };
    await audit('mcp.futures.account.read', { marketType, tool: tool.name, positionCount: positions.length });
    return account;
  }

  public async getFuturesPositions(marketType: FuturesMarketType = 'USD_M'): Promise<BinanceFuturesPosition[]> {
    const account = await this.getFuturesAccount(marketType);
    return account.positions;
  }

  /** Read mark, book, funding, filters, and leverage metadata from a Futures tool. */
  public async getFuturesMarket(symbol = 'BTCUSDT', marketType: FuturesMarketType = 'USD_M'): Promise<BinanceFuturesMarket> {
    await this.connect();
    const tool = this.selectTool('futuresMarket');
    assertFuturesTool(tool, marketType, false);
    const keys = this.argumentKeys(tool);
    const args: Record<string, unknown> = {};
    for (const key of keys) {
      const lower = key.toLowerCase();
      if (/(symbol|pair|ticker|instrument|contract)/.test(lower)) args[key] = symbol;
      else if (/(market|contract|product|venue)/.test(lower) && /(type|kind|market|contract)/.test(lower)) args[key] = marketType;
    }
    const raw = await this.callTool(tool, args);
    let found: BinanceFuturesMarket | undefined;
    let filtersSeen = false;
    let bracketSeen = false;
    let bookSeen = false;
    walkObjects(raw, (record) => {
      const recordBid = toNumber(findProperty(record, ['bidPrice', 'bid', 'bestBid']));
      const recordAsk = toNumber(findProperty(record, ['askPrice', 'ask', 'bestAsk']));
      const recordDepth = orderBookDepth(record);
      if (recordBid !== undefined && recordAsk !== undefined && recordDepth !== undefined) bookSeen = true;
      if (findProperty(record, ['filters', 'exchangeFilters', 'priceFilter', 'lotSize', 'stepSize', 'minQty']) !== undefined) filtersSeen = true;
      if (findProperty(record, ['leverageBrackets', 'brackets', 'maxNotionalValue', 'maintMarginRatio']) !== undefined) bracketSeen = true;
      if (found) return;
      const markPrice = toNumber(findProperty(record, ['markPrice', 'fairPrice', 'mark', 'lastPrice', 'price']));
      if (!isPositive(markPrice)) return;
      const indexPrice = toNumber(findProperty(record, ['indexPrice', 'index']));
      const bidPrice = toNumber(findProperty(record, ['bidPrice', 'bid', 'bestBid']));
      const askPrice = toNumber(findProperty(record, ['askPrice', 'ask', 'bestAsk']));
      const fundingRateBpsValue = toNumber(findProperty(record, ['fundingRateBps', 'fundingBps']));
      const fundingRate = fundingRateBpsValue ?? toNumber(findProperty(record, ['fundingRate', 'lastFundingRate']));
      const fundingRateBps = fundingRateBpsValue ?? (fundingRate === undefined ? undefined : fundingRate * 10_000);
      const nextFundingTime = findProperty(record, ['nextFundingTime', 'nextFundingTimestamp', 'fundingTime']);
      const depth = orderBookDepth(record);
      const filterValue = findProperty(record, ['filters', 'exchangeFilters', 'priceFilter', 'lotSize', 'stepSize', 'minQty']);
      const bracketValue = findProperty(record, ['leverageBrackets', 'brackets', 'maxNotionalValue', 'maintMarginRatio']);
      const observedAt = timestampToIso(findProperty(record, ['observedAt', 'timestamp', 'time', 'eventTime']));
      found = {
        marketType,
        symbol: normaliseSymbol(findProperty(record, ['symbol', 'pair', 'contract', 'instrument']), symbol),
        markPrice,
        indexPrice,
        bidPrice,
        askPrice,
        orderBookDepthUSDT: depth,
        estimatedSlippageBps: toNumber(findProperty(record, ['estimatedSlippageBps', 'slippageBps'])),
        fundingRateBps,
        nextFundingTime: typeof nextFundingTime === 'string' || typeof nextFundingTime === 'number' ? nextFundingTime : undefined,
        exchangeFiltersVerified: filterValue !== undefined,
        leverageBracketVerified: bracketValue !== undefined,
        orderBookVerified: bidPrice !== undefined && askPrice !== undefined && depth !== undefined,
        observedAt: observedAt ?? '',
        mcpToolName: tool.name,
        raw,
      };
    });
    if (!found) throw new Error(`Binance MCP Futures market tool ${tool.name} returned no numeric mark price`);
    if (!Number.isFinite(Date.parse(found.observedAt))) throw new Error(`Binance MCP Futures market tool ${tool.name} returned no verifiable data timestamp`);
    found.exchangeFiltersVerified = found.exchangeFiltersVerified || filtersSeen;
    found.leverageBracketVerified = found.leverageBracketVerified || bracketSeen;
    found.orderBookVerified = found.orderBookVerified || bookSeen;
    await audit('mcp.futures.market.read', { marketType, symbol: found.symbol, tool: tool.name });
    return found;
  }

  /** Submit one USDⓈ M order only after the caller's risk gate and human gate pass. */
  public async placeFuturesOrder(request: FuturesOrderRequest): Promise<BinanceFuturesOrder> {
    if (request.marketType !== 'USD_M') throw new Error('COIN M order writes are disabled. COIN M is report only.');
    if (!isPositive(request.quantity) || !isPositive(request.notionalUSDT) || request.notionalUSDT > configuredFuturesNotionalCap() || !isPositive(request.leverage) || request.leverage > configuredFuturesLeverageCap()) throw new Error('Futures order notional, leverage, or quantity is outside the Signal402 policy');
    if (request.marginMode !== 'ISOLATED') throw new Error('Futures order requires isolated margin');
    if (!['BUY', 'SELL'].includes(request.side) || !['BOTH', 'LONG', 'SHORT'].includes(request.positionSide)) throw new Error('Futures order requires an explicit valid side and position side');
    if (!request.reduceOnly && (request.protectiveStopSupported !== true || !isPositive(request.protectiveStopPrice))) {
      throw new Error('Opening a USD M Futures position requires a declared protective stop plan supported by the live MCP host');
    }
    await this.connect();
    const tool = this.selectTool('futuresOrder');
    assertFuturesTool(tool, 'USD_M', true);
    const keys = this.argumentKeys(tool);
    if (keys.some((key) => /(quote.*(qty|quantity)|quoteorderqty)/i.test(key))) throw new Error('quoteOrderQty is not allowed for Futures orders');
    const args: Record<string, unknown> = {};
    let hasSymbol = false;
    let hasSide = false;
    let hasPositionSide = false;
    let hasQuantity = false;
    let hasReduceOnly = false;
    for (const key of keys) {
      const lower = key.toLowerCase();
      if (/(symbol|pair|ticker|instrument|contract)/.test(lower)) { args[key] = request.symbol; hasSymbol = true; }
      else if (lower === 'side' || lower.includes('orderside')) { args[key] = request.side; hasSide = true; }
      else if (lower === 'position_side' || lower === 'positionside' || lower.includes('position.side')) { args[key] = request.positionSide; hasPositionSide = true; }
      else if (lower === 'quantity' || lower === 'qty' || /order.*(quantity|qty)/.test(lower)) { args[key] = request.quantity; hasQuantity = true; }
      else if (lower === 'reduceonly' || lower === 'reduce_only' || lower.includes('reduce.only')) { args[key] = request.reduceOnly; hasReduceOnly = true; }
      else if (lower === 'type' || lower.includes('ordertype')) args[key] = 'MARKET';
      else if (lower === 'neworderresptype' || lower === 'responsetype') args[key] = 'RESULT';
    }
    if (!hasSymbol || !hasSide || !hasPositionSide || !hasQuantity || !hasReduceOnly) {
      throw new Error(`MCP Futures order schema for ${tool.name} did not expose symbol, side, positionSide, quantity, and reduceOnly`);
    }
    const raw = await this.callTool(tool, args);
    const order = parseOrderRecord(raw, tool.name, request, 'USD_M');
    if (!order) throw new Error(`Binance MCP Futures order tool ${tool.name} returned no order ID`);
    await audit('mcp.futures.order.confirmed', { marketType: request.marketType, orderId: order.orderId, status: order.status, symbol: order.symbol, side: order.side, positionSide: order.positionSide, reduceOnly: order.reduceOnly });
    return order;
  }

  /** Read an authenticated Futures order status without submitting or changing anything. */
  public async getFuturesOrderStatus(symbol: string, orderId: string, marketType: FuturesMarketType = 'USD_M'): Promise<BinanceFuturesOrder> {
    if (marketType !== 'USD_M') throw new Error('COIN M order status is report only in v1');
    await this.connect();
    const tool = this.selectTool('futuresOrderStatus');
    assertFuturesTool(tool, marketType, false);
    const args: Record<string, unknown> = {};
    let hasOrderId = false;
    for (const key of this.argumentKeys(tool)) {
      const lower = key.toLowerCase();
      if (/(symbol|pair|ticker|instrument|contract)/.test(lower)) args[key] = symbol;
      else if (/(orderid|order_id|clientorderid|client_order_id)/.test(lower)) { args[key] = orderId; hasOrderId = true; }
      else if (/(market|contract|product|venue)/.test(lower) && /(type|kind|market|contract)/.test(lower)) args[key] = marketType;
    }
    if (!hasOrderId) throw new Error(`MCP Futures status schema for ${tool.name} did not expose an order ID field`);
    const raw = await this.callTool(tool, args);
    const order = parseOrderRecord(raw, tool.name, { symbol, side: 'BUY', positionSide: 'BOTH', reduceOnly: false }, 'USD_M');
    if (!order) throw new Error(`Binance MCP Futures status tool ${tool.name} returned no order ID`);
    if (order.orderId !== orderId) throw new Error('Binance MCP Futures status returned a different order ID');
    await audit('mcp.futures.order.status', { marketType, orderId, status: order.status, symbol: order.symbol, tool: tool.name });
    return order;
  }

  public async close(): Promise<void> {
    await this.transport?.close();
    this.client = undefined;
    this.transport = undefined;
    await this.stopCallbackServer();
  }
}

export function extractUsdtBalance(balances: BinanceBalance[]): number {
  const usdt = balances.find((balance) => balance.asset.toUpperCase() === 'USDT');
  return usdt ? usdt.free : 0;
}

export function flattenMcpValue(value: unknown): unknown {
  return parseJsonText(unwrapMcpResult(value));
}

const defaultClient = new BinanceMcpClient();

/** Named helpers for callers that do not need to manage the client lifecycle. */
export async function listTools(): Promise<string[]> {
  await defaultClient.connect();
  return defaultClient.toolNames;
}

export async function getTicker(symbol = 'BNBUSDT'): Promise<BinanceTicker> {
  return defaultClient.getTicker(symbol);
}

export async function getBalances(): Promise<BinanceBalance[]> {
  return defaultClient.getBalances();
}

export async function placeSpotOrder(request: SpotOrderRequest): Promise<BinanceOrder> {
  return defaultClient.placeSpotOrder(request);
}

export async function getFuturesAccount(marketType: FuturesMarketType = 'USD_M'): Promise<BinanceFuturesAccount> {
  return defaultClient.getFuturesAccount(marketType);
}

export async function getFuturesPositions(marketType: FuturesMarketType = 'USD_M'): Promise<BinanceFuturesPosition[]> {
  return defaultClient.getFuturesPositions(marketType);
}

export async function getFuturesMarket(symbol = 'BTCUSDT', marketType: FuturesMarketType = 'USD_M'): Promise<BinanceFuturesMarket> {
  return defaultClient.getFuturesMarket(symbol, marketType);
}

export async function getFuturesMarketData(symbol = 'BTCUSDT', marketType: FuturesMarketType = 'USD_M'): Promise<BinanceFuturesMarket> {
  return defaultClient.getFuturesMarket(symbol, marketType);
}

export async function placeFuturesOrder(request: FuturesOrderRequest): Promise<BinanceFuturesOrder> {
  return defaultClient.placeFuturesOrder(request);
}

export async function placeUsdMFuturesOrder(request: Omit<FuturesOrderRequest, 'marketType'>): Promise<BinanceFuturesOrder> {
  return defaultClient.placeFuturesOrder({ ...request, marketType: 'USD_M' });
}

export async function getFuturesOrderStatus(symbol: string, orderId: string, marketType: FuturesMarketType = 'USD_M'): Promise<BinanceFuturesOrder> {
  return defaultClient.getFuturesOrderStatus(symbol, orderId, marketType);
}
