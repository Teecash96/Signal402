import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateCexCarry } from '../src/lib/carryEconomics.js';
import { carryReportSchema } from '../src/lib/schemas.js';

const context = {
  symbol: 'BTCUSDT',
  spotPrice: 100,
  futuresMarkPrice: 100.5,
  fundingRateBps: 1,
  fundingIntervalHours: 8,
  horizonHours: 24,
  spotFeeRate: 0.0001,
  futuresFeeRate: 0.0001,
  spotSpreadBps: 1,
  futuresSpreadBps: 1,
  spotSlippageBps: 1,
  futuresSlippageBps: 1,
  observedAt: '2026-01-01T00:00:00.000Z',
  sourceToolNames: ['spot.ticker24hr', 'futures.markPrice', 'futures.fundingRate'],
};

test('CEX carry report is deterministic and report only', () => {
  const report = evaluateCexCarry(context, Date.parse('2026-01-01T00:00:05.000Z'));
  assert.equal(report.symbol, 'BTCUSDT');
  assert.equal(report.reportOnly, true);
  assert.equal(report.dataFresh, true);
  assert.equal(report.basisBps, 50);
  assert.equal(report.fundingCarryBps, 3);
  assert.equal(report.decision, 'ENTER');
  assert.equal(carryReportSchema.safeParse(report).success, true);
  assert.equal(report.outputHash, evaluateCexCarry(context, Date.parse('2026-01-01T00:00:05.000Z')).outputHash);
  assert.equal(report.outputHash, evaluateCexCarry(context, Date.parse('2026-01-01T00:00:06.000Z')).outputHash);
});

test('stale CEX data fails closed to WAIT', () => {
  const report = evaluateCexCarry(context, Date.parse('2026-01-01T00:00:16.000Z'));
  assert.equal(report.dataFresh, false);
  assert.equal(report.decision, 'WAIT');
});
