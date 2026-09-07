import assert from 'node:assert/strict';
import test from 'node:test';
import { DashboardAuth, hashDashboardPassword } from '../src/lib/auth.js';
import { decryptText, encryptText } from '../src/lib/cryptoStore.js';
import { deriveMarketSignal } from '../src/lib/marketSignal.js';
import { isUsableSecret } from '../src/lib/securityConfig.js';

test('local sensitive data envelope authenticates and decrypts', () => {
  const envelope = encryptText(JSON.stringify({ accessToken: 'never log this' }), 'a'.repeat(32));
  assert.equal(envelope.startsWith('{'), false);
  assert.equal(decryptText(envelope, 'a'.repeat(32)), '{"accessToken":"never log this"}');
  assert.throws(() => decryptText(envelope, 'b'.repeat(32)));
});

test('dashboard authentication hashes passwords and rate limits failures', async () => {
  const previousHash = process.env.SIGNAL402_DASHBOARD_PASSWORD_HASH;
  const previousSecret = process.env.SIGNAL402_DASHBOARD_SESSION_SECRET;
  process.env.SIGNAL402_DASHBOARD_PASSWORD_HASH = hashDashboardPassword('correct horse battery staple');
  process.env.SIGNAL402_DASHBOARD_SESSION_SECRET = 'b'.repeat(32);
  try {
    const auth = new DashboardAuth();
    assert.equal(auth.status().configured, true);
    assert.equal((await auth.login('security-test', 'wrong password', '', undefined)).status, 401);
    assert.equal((await auth.login('security-test', 'correct horse battery staple', '', undefined)).ok, true);
    for (let index = 0; index < 5; index += 1) await auth.login('blocked-test', 'wrong password', '', undefined);
    assert.equal((await auth.login('blocked-test', 'correct horse battery staple', '', undefined)).status, 429);
  } finally {
    if (previousHash === undefined) delete process.env.SIGNAL402_DASHBOARD_PASSWORD_HASH;
    else process.env.SIGNAL402_DASHBOARD_PASSWORD_HASH = previousHash;
    if (previousSecret === undefined) delete process.env.SIGNAL402_DASHBOARD_SESSION_SECRET;
    else process.env.SIGNAL402_DASHBOARD_SESSION_SECRET = previousSecret;
  }
});

test('placeholder secrets are rejected', () => {
  assert.equal(isUsableSecret('replace-with-a-random-local-token'), false);
  assert.equal(isUsableSecret('c'.repeat(32)), true);
});

test('market intelligence produces an explainable small buy screen', () => {
  const signal = deriveMarketSignal({
    price: 102,
    changePercent: 2.4,
    highPrice: 104,
    lowPrice: 99,
    weightedAvgPrice: 100,
    quoteVolume: 250_000,
  });
  assert.equal(signal.direction, 'BULLISH');
  assert.equal(signal.action, 'BUY_SMALL');
  assert.equal(signal.risk, 'LOW');
  assert.equal(signal.confidence, 'HIGH');
  assert.match(signal.rationale, /momentum/i);
});

test('market intelligence blocks bearish or high volatility conditions', () => {
  assert.equal(deriveMarketSignal({ price: 98, changePercent: -1.2, highPrice: 101, lowPrice: 97 }).action, 'WAIT');
  const volatile = deriveMarketSignal({ price: 110, changePercent: 3, highPrice: 120, lowPrice: 100, quoteVolume: 10_000 });
  assert.equal(volatile.risk, 'HIGH');
  assert.equal(volatile.action, 'WAIT');
});
