import axios from 'axios';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { audit } from './audit.js';

const execFileAsync = promisify(execFile);
const BAW_BIN = process.env.BINANCE_AGENTIC_WALLET_BIN ?? 'baw';

type BawEnvelope<T> = { success?: boolean; data?: T; error?: unknown };

type PreviewOption = {
  index: number;
  status: string;
  reasons?: string[];
  tokenSymbol?: string;
  amount?: string;
  amountUsd?: string;
  payTo?: string;
  currentBalance?: string;
  originalAccept?: Record<string, unknown>;
};

type Preview = {
  paymentId: string;
  options: PreviewOption[];
};

type SignResult = {
  paymentHeaderName: string;
  paymentHeaderValue: string;
  approveTxHash?: string | null;
  signatureExpiresAt?: number;
};

export type PaidReport = {
  body: unknown;
  paymentReceiptId: string;
  paymentResponse: unknown;
};

function decodePaymentHeader(response: { headers: Record<string, unknown>; data?: unknown }): string {
  const headers = response.headers;
  const value = headers['payment-required'] ?? headers['x-payment-requirements'] ?? headers['PAYMENT-REQUIRED'] ?? headers['X-PAYMENT-REQUIREMENTS'];
  if (typeof value === 'string' && value.trim()) return value;
  const body = response.data;
  if (body && typeof body === 'object' && 'accepts' in body) return Buffer.from(JSON.stringify(body), 'utf8').toString('base64');
  throw new Error('Seller returned HTTP 402 without a PAYMENT-REQUIRED or X-PAYMENT-REQUIREMENTS header');
}

function parseJsonOutput(output: string): unknown {
  const trimmed = output.trim();
  const firstBrace = trimmed.indexOf('{');
  const candidate = firstBrace >= 0 ? trimmed.slice(firstBrace) : trimmed;
  return JSON.parse(candidate);
}

async function baw<T>(args: string[]): Promise<T> {
  try {
    const result = await execFileAsync(BAW_BIN, args, { maxBuffer: 2 * 1024 * 1024 });
    const parsed = parseJsonOutput(result.stdout) as BawEnvelope<T>;
    if (parsed.success === false) throw new Error(`baw rejected the request: ${JSON.stringify(parsed)}`);
    return (parsed.data ?? parsed) as T;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Binance Agentic Wallet command failed (${BAW_BIN} ${args.join(' ')}): ${message}`);
  }
}

async function confirmPayment(option: PreviewOption): Promise<void> {
  if (process.env.CONFIRM_X402_PAYMENT === 'true') return;
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('Real x402 signing requires a human confirmation. Set CONFIRM_X402_PAYMENT=true only when you have explicitly approved this exact payment.');
  }
  const readline = await import('node:readline/promises');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(`\nConfirm real x402 payment of ${option.amount ?? 'unknown'} ${option.tokenSymbol ?? 'token'} to ${option.payTo ?? 'merchant'}? Type PAY to sign: `);
  rl.close();
  if (answer.trim().toUpperCase() !== 'PAY') throw new Error('User did not approve the x402 payment signature');
}

async function waitForApprovalTransaction(txHash: string): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const result = await baw<Record<string, unknown>>(['wallet', 'tx-history', '--tx', txHash, '--json']);
    const status = `${result.status ?? result.state ?? ''}`.toUpperCase();
    if (['CONFIRMED', 'SUCCESS', 'COMPLETED', 'MINED'].includes(status)) return;
    if (['FAILED', 'REVERTED'].includes(status)) throw new Error(`Permit2 approval transaction failed: ${txHash}`);
    await new Promise<void>((resolve) => setTimeout(resolve, 3000));
  }
  throw new Error(`Permit2 approval transaction did not confirm in time: ${txHash}`);
}

function paymentReceiptId(headers: Record<string, unknown>): { id: string; raw: unknown } {
  const value = headers['payment-response'] ?? headers['PAYMENT-RESPONSE'];
  if (typeof value !== 'string' || !value) throw new Error('Seller did not return a PAYMENT-RESPONSE settlement receipt');
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(value, 'base64').toString('utf8'));
  } catch {
    throw new Error('Seller returned an invalid base64 PAYMENT-RESPONSE header');
  }
  const record = decoded && typeof decoded === 'object' ? decoded as Record<string, unknown> : {};
  const id = record.txHash ?? record.transaction ?? record.transactionHash;
  if (typeof id !== 'string' || !id) throw new Error('PAYMENT-RESPONSE did not contain a real settlement transaction hash');
  return { id, raw: decoded };
}

export async function purchaseReport(endpoint: string, resourcePath = '/api/report'): Promise<PaidReport> {
  const url = `${endpoint.replace(/\/$/, '')}${resourcePath}`;
  await audit('x402.resource.requested', { url });
  let challenge;
  try {
    challenge = await axios.post(url, {}, { validateStatus: () => true, timeout: 30_000 });
  } catch (error: unknown) {
    throw new Error(`Seller challenge request failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (challenge.status !== 402) throw new Error(`Expected real HTTP 402 from seller, received ${challenge.status}`);
  const paymentRequirements = decodePaymentHeader(challenge);
  const preview = await baw<Preview>(['x402-payment', 'preview', '--paymentRequirements', paymentRequirements, '--json']);
  const ready = preview.options.find((option) => option.status === 'READY_TO_SIGN');
  if (!ready) {
    throw new Error(`No signable Binance Agentic Wallet x402 option. Options: ${JSON.stringify(preview.options)}`);
  }
  await audit('x402.payment.previewed', { paymentId: preview.paymentId, optionIndex: ready.index, token: ready.tokenSymbol, amount: ready.amount, payTo: ready.payTo });
  await confirmPayment(ready);
  const signed = await baw<SignResult>(['x402-payment', 'sign', '--paymentId', preview.paymentId, '--selectedIndex', String(ready.index), '--json']);
  if (!signed.paymentHeaderName || !signed.paymentHeaderValue) throw new Error('baw did not return a replay payment header');
  if (signed.approveTxHash) await waitForApprovalTransaction(signed.approveTxHash);
  await audit('x402.payment.signed', { paymentId: preview.paymentId, optionIndex: ready.index, approveTxHash: signed.approveTxHash ?? null });
  const paid = await axios.post(url, {}, {
    headers: { [signed.paymentHeaderName]: signed.paymentHeaderValue },
    validateStatus: () => true,
    timeout: 90_000,
  });
  if (paid.status !== 200) throw new Error(`Seller rejected the signed x402 payment with HTTP ${paid.status}: ${JSON.stringify(paid.data)}`);
  const receipt = paymentReceiptId(paid.headers as Record<string, unknown>);
  await audit('x402.resource.delivered', { url, paymentReceiptId: receipt.id });
  return { body: paid.data, paymentReceiptId: receipt.id, paymentResponse: receipt.raw };
}
