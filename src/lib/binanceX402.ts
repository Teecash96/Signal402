import { createPrivateKey, createSign } from 'node:crypto';
import axios, { type AxiosRequestConfig } from 'axios';
import { audit } from './audit.js';

const REPORT_PRICE_USDC = Number.parseFloat(process.env.REPORT_PRICE_USDC ?? '0.01');
const USDC_DECIMALS = Number.parseInt(process.env.B402_USDC_DECIMALS ?? '6', 10);
const USDC_ASSET = process.env.B402_USDC_ASSET ?? '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d';
const B402_NETWORK = process.env.B402_NETWORK ?? 'eip155:56';
const B402_BASE_URL = process.env.B402_BASE_URL?.replace(/\/$/, '');
const B402_PAY_TO = process.env.B402_PAY_TO;
const B402_CLIENT_ID = process.env.B402_CLIENT_ID;
const B402_ACCESS_TOKEN = process.env.B402_ACCESS_TOKEN;
const B402_PRIVATE_KEY_BASE64 = process.env.B402_PRIVATE_KEY_BASE64;
const SETTLEMENT_TIMEOUT_MS = Number.parseInt(process.env.B402_SETTLEMENT_TIMEOUT_MS ?? `${30 * 60 * 1000}`, 10);

export type PaymentRequirement = {
  scheme: string;
  network: string;
  amount: string;
  asset: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra: Record<string, unknown>;
};

type SupportedResponse = {
  kinds?: Array<{
    x402Version?: number;
    scheme?: string;
    network?: string;
    extra?: Record<string, unknown>;
  }>;
  data?: { kinds?: SupportedResponse['kinds'] };
};

export type SettlementReceipt = {
  transaction: string;
  payer?: string;
  network?: string;
  amount?: string;
  raw: unknown;
};

function requireConfig(): void {
  const missing = [
    ['B402_BASE_URL', B402_BASE_URL],
    ['B402_PAY_TO', B402_PAY_TO],
    ['B402_CLIENT_ID', B402_CLIENT_ID],
    ['B402_ACCESS_TOKEN', B402_ACCESS_TOKEN],
    ['B402_PRIVATE_KEY_BASE64', B402_PRIVATE_KEY_BASE64],
  ].filter(([, value]) => !value).map(([name]) => name);
  if (missing.length > 0) {
    throw new Error(`Real Binance B402 seller credentials are missing: ${missing.join(', ')}. Refusing to issue a fake payment challenge.`);
  }
}

function signedHeaders(body: string): Record<string, string> {
  requireConfig();
  const timestamp = Date.now().toString();
  const privateKey = createPrivateKey({ key: Buffer.from(B402_PRIVATE_KEY_BASE64!, 'base64'), format: 'der', type: 'pkcs8' });
  const signature = createSign('SHA256').update(`${body}${timestamp}`, 'utf8').sign(privateKey, 'base64');
  return {
    'content-type': 'application/json',
    'X-Tesla-ClientId': B402_CLIENT_ID!,
    'X-Tesla-SignAccessToken': B402_ACCESS_TOKEN!,
    'X-Tesla-Signature': signature,
    'X-Tesla-Timestamp': timestamp,
  };
}

function unwrapB402<T>(value: unknown): T {
  if (!value || typeof value !== 'object') return value as T;
  const record = value as Record<string, unknown>;
  if (record.success === false || (typeof record.code === 'string' && record.code !== '000000')) {
    throw new Error(`Binance B402 rejected the request: ${JSON.stringify(value)}`);
  }
  return (record.data ?? value) as T;
}

async function b402Post<T>(path: string, payload: Record<string, unknown>): Promise<T> {
  requireConfig();
  const body = JSON.stringify(payload);
  const config: AxiosRequestConfig = { headers: signedHeaders(body), timeout: 30_000, validateStatus: () => true };
  const response = await axios.post(`${B402_BASE_URL}${path}`, payload, config);
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`Binance B402 ${path} returned HTTP ${response.status}: ${JSON.stringify(response.data)}`);
  }
  return unwrapB402<T>(response.data);
}

let supportedCache: SupportedResponse | undefined;
let supportedCacheAt = 0;

export async function getSupportedPaymentKinds(): Promise<SupportedResponse> {
  if (supportedCache && Date.now() - supportedCacheAt < 60 * 60 * 1000) return supportedCache;
  const response = await b402Post<SupportedResponse>('/papi/v2/b402/supported', {});
  supportedCache = response;
  supportedCacheAt = Date.now();
  await audit('x402.supported.loaded', { network: B402_NETWORK, kindCount: response.kinds?.length ?? 0 });
  return response;
}

function selectUsdcKind(response: SupportedResponse): NonNullable<SupportedResponse['kinds']>[number] {
  const kinds = response.kinds ?? response.data?.kinds ?? [];
  const selected = kinds.find((kind) => kind.x402Version === 2
    && kind.scheme === 'exact'
    && kind.network === B402_NETWORK
    && `${kind.extra?.name ?? ''}`.toLowerCase().includes('usd coin'))
    ?? kinds.find((kind) => kind.x402Version === 2 && kind.scheme === 'exact' && kind.network === B402_NETWORK);
  if (!selected?.extra) throw new Error(`Binance B402 does not advertise an exact USDC payment kind for ${B402_NETWORK}`);
  return selected;
}

export async function buildPaymentRequired(resourceUrl: string): Promise<{
  headerValue: string;
  body: Record<string, unknown>;
  requirement: PaymentRequirement;
}> {
  requireConfig();
  if (!B402_PAY_TO) throw new Error('B402_PAY_TO must be the seller wallet address that receives USDC');
  if (!Number.isFinite(REPORT_PRICE_USDC) || REPORT_PRICE_USDC <= 0) throw new Error('REPORT_PRICE_USDC must be positive');
  const supported = await getSupportedPaymentKinds();
  const kind = selectUsdcKind(supported);
  const requirement: PaymentRequirement = {
    scheme: kind.scheme!,
    network: kind.network!,
    amount: Math.round(REPORT_PRICE_USDC * (10 ** USDC_DECIMALS)).toString(),
    asset: USDC_ASSET,
    payTo: B402_PAY_TO,
    maxTimeoutSeconds: Number.parseInt(process.env.B402_MAX_TIMEOUT_SECONDS ?? '300', 10),
    extra: { ...kind.extra },
  };
  const body: Record<string, unknown> = {
    x402Version: 2,
    resource: { url: resourceUrl, description: 'Signal402 live Binance market briefing', mimeType: 'application/json' },
    accepts: [requirement],
  };
  const headerValue = Buffer.from(JSON.stringify(body), 'utf8').toString('base64');
  await audit('x402.challenge.issued', { resourceUrl, network: requirement.network, amount: requirement.amount, asset: requirement.asset, payTo: requirement.payTo });
  return { headerValue, body, requirement };
}

function paymentPayloadFromHeader(value: string): unknown {
  try {
    return JSON.parse(Buffer.from(value, 'base64').toString('utf8'));
  } catch {
    throw new Error('PAYMENT-SIGNATURE is not valid base64 encoded JSON');
  }
}

function verifyPayload(paymentPayload: unknown, requirement: PaymentRequirement): Record<string, unknown> {
  if (!paymentPayload || typeof paymentPayload !== 'object') throw new Error('PAYMENT-SIGNATURE payload is not an object');
  return {
    x402Version: 2,
    paymentPayload,
    paymentRequirements: requirement,
  };
}

async function settleUntilComplete(payload: Record<string, unknown>, timeoutMs = SETTLEMENT_TIMEOUT_MS): Promise<SettlementReceipt> {
  const started = Date.now();
  let delayMs = 3000;
  while (Date.now() - started < timeoutMs) {
    const response = await b402Post<Record<string, unknown>>('/papi/v2/b402/settle', payload);
    const data = (response.data ?? response) as Record<string, unknown>;
    const transaction = typeof data.transaction === 'string' ? data.transaction : '';
    if (data.success === true) {
      if (!/^0x[0-9a-fA-F]{64}$/.test(transaction)) throw new Error('Binance B402 reported successful settlement without a valid 32-byte transaction hash');
      return {
        transaction,
        payer: typeof data.payer === 'string' ? data.payer : undefined,
        network: typeof data.network === 'string' ? data.network : undefined,
        amount: typeof data.amount === 'string' ? data.amount : undefined,
        raw: response,
      };
    }
    if (!transaction) {
      throw new Error(`Binance B402 settlement failed before broadcasting: ${JSON.stringify(response)}`);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
    delayMs = Math.min(delayMs + 1000, 5000);
  }
  throw new Error('Binance B402 settlement did not complete before its timeout');
}

export async function verifyAndSettlePayment(paymentHeader: string, requirement: PaymentRequirement): Promise<SettlementReceipt> {
  const paymentPayload = paymentPayloadFromHeader(paymentHeader);
  const payload = verifyPayload(paymentPayload, requirement);
  const verification = await b402Post<Record<string, unknown>>('/papi/v2/b402/verify', payload);
  const verificationData = (verification.data ?? verification) as Record<string, unknown>;
  if (verificationData.isValid !== true) {
    throw new Error(`Binance B402 rejected payment verification: ${JSON.stringify(verification)}`);
  }
  await audit('x402.payment.verified', { network: requirement.network, amount: requirement.amount, asset: requirement.asset });
  const receipt = await settleUntilComplete(payload);
  await audit('x402.payment.settled', { transaction: receipt.transaction, payer: receipt.payer, network: receipt.network, amount: receipt.amount });
  return receipt;
}

export function reportPriceUsdc(): number {
  return REPORT_PRICE_USDC;
}

export function b402IsConfigured(): boolean {
  return Boolean(B402_BASE_URL && B402_PAY_TO && B402_CLIENT_ID && B402_ACCESS_TOKEN && B402_PRIVATE_KEY_BASE64);
}
