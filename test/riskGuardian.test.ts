import assert from 'node:assert/strict';
import test from 'node:test';
import { assessTradeRisk } from '../src/buyer/riskGuardian.js';

test('Risk Guardian approves a capped order covered by live balance', () => {
  const result = assessTradeRisk(20, 10);
  assert.equal(result.approved, true);
  assert.equal(result.balanceUSDT, 20);
});

test('Risk Guardian refuses when live USDT is below the proposed size', () => {
  const result = assessTradeRisk(2, 10);
  assert.equal(result.approved, false);
  assert.match(result.reason, /below the proposed trade size/);
});

test('Risk Guardian refuses invalid balance data', () => {
  const result = assessTradeRisk(Number.NaN, 10);
  assert.equal(result.approved, false);
});
