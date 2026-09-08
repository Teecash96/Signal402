import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createExecutionPlan,
  executionPlanHash,
  isExecutionPlanCurrent,
  planOrderMatches,
  transitionExecutionPlan,
} from '../src/lib/executionPlan.js';

const input = {
  planId: 'plan_test_1',
  proposalId: 'proposal_test_1',
  kind: 'spot' as const,
  symbol: 'bnbusdt',
  side: 'BUY' as const,
  quantity: 0.01,
  notionalUSDT: 5,
  reduceOnly: false,
  riskHash: 'a'.repeat(64),
};

test('execution plans are deterministic, hashed, and expire after one minute', () => {
  const created = createExecutionPlan({ ...input, now: '2026-01-01T00:00:00.000Z' });
  assert.equal(created.symbol, 'BNBUSDT');
  assert.equal(created.expiresAt, '2026-01-01T00:01:00.000Z');
  assert.equal(isExecutionPlanCurrent(created, '2026-01-01T00:00:59.999Z'), true);
  assert.equal(isExecutionPlanCurrent(created, '2026-01-01T00:01:00.000Z'), false);
  assert.equal(executionPlanHash(created), created.planHash);
});

test('execution plans allow only ordered single use transitions', () => {
  const created = createExecutionPlan({ ...input, now: '2026-01-01T00:00:00.000Z' });
  const approved = transitionExecutionPlan(created, 'approved', '2026-01-01T00:00:01.000Z');
  const submitted = transitionExecutionPlan(approved, 'submitted', '2026-01-01T00:00:02.000Z');
  const filled = transitionExecutionPlan(submitted, 'filled', '2026-01-01T00:00:03.000Z');
  assert.equal(filled.status, 'filled');
  assert.throws(() => transitionExecutionPlan(filled, 'submitted'), /Invalid execution plan transition/);
  assert.equal(planOrderMatches(filled, { ...input, symbol: 'BNBUSDT', positionSide: undefined, leverage: undefined, marginMode: undefined }), true);
});

test('tampering with the order fields invalidates a plan', () => {
  const created = createExecutionPlan({ ...input, now: '2026-01-01T00:00:00.000Z' });
  const tampered = { ...created, notionalUSDT: 9 };
  assert.equal(isExecutionPlanCurrent(tampered, '2026-01-01T00:00:01.000Z'), false);
});
