import assert from 'node:assert/strict';
import test from 'node:test';
import { DashboardAuth, hashDashboardPassword } from '../src/lib/auth.js';
import { decryptText, encryptText } from '../src/lib/cryptoStore.js';
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
