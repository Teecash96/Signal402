import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ExecutionStateStore } from '../src/lib/executionState.js';

test('execution state is atomically persisted and recovered', () => {
  const directory = mkdtempSync(join(tmpdir(), 'signal402-execution-'));
  const file = join(directory, 'execution.json');
  try {
    const store = new ExecutionStateStore(file);
    assert.equal(store.load(), undefined);
    store.persist({ proposal: { proposalId: 'proposal_1', status: 'approved' } });
    assert.deepEqual(new ExecutionStateStore(file).load(), { proposal: { proposalId: 'proposal_1', status: 'approved' } });
    assert.match(readFileSync(file, 'utf8'), /signal402-execution-state-v1/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
