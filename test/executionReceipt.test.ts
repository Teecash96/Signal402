import assert from 'node:assert/strict';
import test from 'node:test';
import { buildExecutionReceipt, receiptHash, verifyExecutionReceipt } from '../src/lib/executionReceipt.js';
import { executionReceiptSchema } from '../src/lib/schemas.js';

test('execution receipt hash is reproducible and events stay ordered', () => {
  const receipt = buildExecutionReceipt({
    receiptId: 'receipt_test_1',
    kind: 'spot',
    proposalId: 'proposal_test_1',
    planId: 'plan_test_1',
    paymentReceiptId: '0x' + 'a'.repeat(64),
    riskHash: 'b'.repeat(64),
    approvalAt: '2026-01-01T00:00:01.000Z',
    submittedAt: '2026-01-01T00:00:02.000Z',
    settledAt: '2026-01-01T00:00:03.000Z',
    mcpToolName: 'spot.order',
    orderId: '12345',
    filledPrice: 100,
    executedQty: 0.05,
    quoteAmount: 5,
    beforeBalances: [{ asset: 'USDT', free: 10, locked: 0 }],
    afterBalances: [{ asset: 'USDT', free: 5, locked: 0 }],
    events: [
      { sequence: 9, type: 'ORDER_SUBMITTED', observedAt: '2026-01-01T00:00:02.000Z' },
      { sequence: 9, type: 'FILL_RECONCILED', observedAt: '2026-01-01T00:00:03.000Z', detail: { orderId: '12345' } },
    ],
  });
  assert.equal(receipt.events[0].sequence, 1);
  assert.equal(receipt.events[1].sequence, 2);
  assert.equal(receiptHash(receipt), receipt.hash);
  assert.equal(verifyExecutionReceipt(receipt), true);
  assert.equal(executionReceiptSchema.safeParse(receipt).success, true);
  assert.equal(verifyExecutionReceipt({ ...receipt, orderId: 'tampered' }), false);
});
