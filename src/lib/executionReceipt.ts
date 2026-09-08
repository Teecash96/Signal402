import { randomUUID } from 'node:crypto';
import { sha256 } from './futuresRisk.js';

export const EXECUTION_RECEIPT_SCHEMA_VERSION = 'signal402-execution-receipt-v1';

export type ExecutionReceiptEvent = {
  sequence: number;
  type: string;
  observedAt: string;
  detail?: Record<string, unknown>;
};

export type ExecutionReceipt = {
  schemaVersion: typeof EXECUTION_RECEIPT_SCHEMA_VERSION;
  receiptId: string;
  kind: 'spot' | 'futures';
  proposalId: string;
  planId: string;
  paymentReceiptId?: string;
  contextHash?: string;
  riskHash?: string;
  approvalAt?: string;
  confirmationAt?: string;
  submittedAt?: string;
  settledAt?: string;
  mcpToolName: string;
  orderId: string;
  filledPrice?: number;
  executedQty?: number;
  quoteAmount?: number;
  beforeBalances?: unknown;
  afterBalances?: unknown;
  beforePositions?: unknown;
  afterPositions?: unknown;
  events: ExecutionReceiptEvent[];
  hash: string;
};

export type ExecutionReceiptInput = Omit<ExecutionReceipt, 'schemaVersion' | 'receiptId' | 'hash'> & {
  receiptId?: string;
};

function payload(receipt: Omit<ExecutionReceipt, 'hash'>): Record<string, unknown> {
  return { ...receipt };
}

export function receiptHash(receipt: ExecutionReceipt): string {
  const { hash: _hash, ...withoutHash } = receipt;
  return sha256(payload(withoutHash));
}

export function buildExecutionReceipt(input: ExecutionReceiptInput): ExecutionReceipt {
  const receipt: Omit<ExecutionReceipt, 'hash'> = {
    schemaVersion: EXECUTION_RECEIPT_SCHEMA_VERSION,
    receiptId: input.receiptId ?? `receipt_${randomUUID()}`,
    kind: input.kind,
    proposalId: input.proposalId,
    planId: input.planId,
    paymentReceiptId: input.paymentReceiptId,
    contextHash: input.contextHash,
    riskHash: input.riskHash,
    approvalAt: input.approvalAt,
    confirmationAt: input.confirmationAt,
    submittedAt: input.submittedAt,
    settledAt: input.settledAt,
    mcpToolName: input.mcpToolName,
    orderId: input.orderId,
    filledPrice: input.filledPrice,
    executedQty: input.executedQty,
    quoteAmount: input.quoteAmount,
    beforeBalances: input.beforeBalances,
    afterBalances: input.afterBalances,
    beforePositions: input.beforePositions,
    afterPositions: input.afterPositions,
    events: input.events.map((event, index) => ({ ...event, sequence: index + 1 })),
  };
  return { ...receipt, hash: sha256(payload(receipt)) };
}

export function verifyExecutionReceipt(receipt: ExecutionReceipt): boolean {
  return receiptHash(receipt) === receipt.hash
    && receipt.events.every((event, index) => event.sequence === index + 1);
}
