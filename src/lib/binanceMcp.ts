import { createServer, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { UnauthorizedError, type OAuthClientProvider, type OAuthDiscoveryState } from '@modelcontextprotocol/sdk/client/auth.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import { audit } from './audit.js';

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
      this.store = JSON.parse(contents) as TokenStore;
    } catch (error: unknown) {
      const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
      if (code !== 'ENOENT') throw error;
    }
  }

  private async save(): Promise<void> {
    await writeFile(this.tokenFile, `${JSON.stringify(this.store, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
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

  private selectTool(kind: 'ticker' | 'balances' | 'spotOrder'): ToolDefinition {
    if (this.tools.length === 0) throw new Error('Binance MCP returned no tools');
    const scored = this.tools.map((tool) => {
      const text = `${tool.name} ${tool.description ?? ''}`.toLowerCase();
      let score = 0;
      if (kind === 'ticker') {
        if (/(ticker|price|quote|market data)/.test(text)) score += 7;
        if (/(24h|symbol|spot)/.test(text)) score += 2;
        if (/(order|trade|balance|account|klines|candles)/.test(text)) score -= 5;
      } else if (kind === 'balances') {
        if (/(balance|account|asset)/.test(text)) score += 8;
        if (/(spot|wallet)/.test(text)) score += 2;
        if (/(transfer|withdraw|deposit|order|trade)/.test(text)) score -= 5;
      } else {
        if (/(spot|order|trade)/.test(text)) score += 7;
        if (/(create|place|new|market|buy|sell)/.test(text)) score += 3;
        if (/(balance|account|ticker|price|transfer|withdraw)/.test(text)) score -= 5;
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
      found = { symbol: normaliseSymbol(symbolValue, symbol), price, changePercent: change, raw };
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
