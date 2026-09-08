import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { RiskStateStore } from '../src/lib/riskState.js';

test('risk state persists kill switch and drawdown halt without secrets', () => {
  const directory = mkdtempSync(join(tmpdir(), 'signal402-risk-'));
  const file = join(directory, 'risk.json');
  try {
    const store = new RiskStateStore(file);
    store.load();
    assert.throws(() => store.resetHalt(), /current and peak equity/);
    store.updateEquity(100);
    store.updateEquity(96);
    assert.equal(store.snapshot().drawdownState, 'HALTED');
    assert.equal(store.isNewRiskBlocked(), true);
    assert.throws(() => store.resetHalt(), /cannot be reset/);
    assert.equal(store.updateEquity(99).drawdownState, 'HALTED');
    assert.equal(store.resetHalt().drawdownState, 'NORMAL');
    store.setKillSwitch('operator test');
    assert.equal(store.snapshot().killSwitch, true);
    const reloaded = new RiskStateStore(file);
    assert.equal(reloaded.load().killSwitch, true);
    assert.match(readFileSync(file, 'utf8'), /operator test/);
    assert.doesNotMatch(readFileSync(file, 'utf8'), /token|secret|private/i);
    reloaded.clearKillSwitch();
    assert.equal(reloaded.snapshot().killSwitch, false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('risk state warns before it halts', () => {
  const directory = mkdtempSync(join(tmpdir(), 'signal402-risk-warn-'));
  try {
    const store = new RiskStateStore(join(directory, 'risk.json'));
    store.load();
    store.updateEquity(100);
    assert.equal(store.updateEquity(97.5).drawdownState, 'WARN');
    assert.equal(store.isNewRiskBlocked(), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
