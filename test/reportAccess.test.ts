import assert from 'node:assert/strict';
import test from 'node:test';
import { payReportChallenge } from '../src/lib/binanceX402Client.js';
import { hasCurrentReportAccess, reportAccessMode } from '../src/lib/reportAccess.js';
import { tradeProposalInputSchema } from '../src/lib/schemas.js';

test('free mode requires a current free briefing and no receipt', () => {
  assert.equal(reportAccessMode({}), 'free');
  assert.equal(reportAccessMode({ SIGNAL402_ACCESS_MODE: 'free' }), 'free');
  assert.equal(reportAccessMode({ SIGNAL402_ACCESS_MODE: 'free', SIGNAL402_FREE_ACCESS: 'false' }), 'free');
  assert.equal(reportAccessMode({ SIGNAL402_FREE_ACCESS: 'true' }), 'free');
  assert.equal(hasCurrentReportAccess({ mode: 'free', status: 'free' }), true);
  assert.equal(hasCurrentReportAccess({ mode: 'free', status: 'waiting' }), false);
  assert.equal(hasCurrentReportAccess({ mode: 'free', status: 'free', providedReceipt: `0x${'a'.repeat(64)}` }), false);
});

test('paid mode still requires the exact settlement receipt', () => {
  const receipt = `0x${'a'.repeat(64)}`;
  assert.equal(reportAccessMode({ SIGNAL402_ACCESS_MODE: 'b402' }), 'b402');
  assert.equal(reportAccessMode({ SIGNAL402_ACCESS_MODE: 'paid' }), 'b402');
  assert.equal(reportAccessMode({ SIGNAL402_FREE_ACCESS: 'false' }), 'b402');
  assert.equal(hasCurrentReportAccess({ mode: 'b402', status: 'settled', currentReceipt: receipt, providedReceipt: receipt }), true);
  assert.equal(hasCurrentReportAccess({ mode: 'b402', status: 'settled', currentReceipt: receipt }), false);
  assert.equal(hasCurrentReportAccess({ mode: 'b402', status: 'free', currentReceipt: receipt, providedReceipt: receipt }), false);
});

test('Spot proposal schema permits an omitted receipt for server side free mode', () => {
  const parsed = tradeProposalInputSchema.safeParse({
    proposalId: 'proposal_free',
    asset: 'BNBUSDT',
    side: 'BUY',
    amountUSDT: 5,
    balanceUSDT: 20,
    reason: 'Free access test',
  });
  assert.equal(parsed.success, true);
});

test('free report retrieval never invokes a wallet payment', async () => {
  const result = await payReportChallenge({
    url: 'http://localhost:3001/api/report',
    accessMode: 'free',
    body: { accessMode: 'free', briefing: 'live report' },
  }, { explicitlyApproved: false });
  assert.equal(result.accessMode, 'free');
  assert.equal(result.paymentReceiptId, undefined);
  assert.deepEqual(result.body, { accessMode: 'free', briefing: 'live report' });
});
