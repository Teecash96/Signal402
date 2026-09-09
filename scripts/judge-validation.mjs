import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const checks = [
  { label: 'TypeScript build', command: npm, args: ['run', 'build'] },
  { label: 'Deterministic test suite', command: npm, args: ['test'] },
  { label: 'Dependency audit', command: npm, args: ['audit', '--audit-level=moderate'] },
  { label: 'Git whitespace check', command: 'git', args: ['diff', '--check'] }
];

console.log('Signal402 judge validation');
console.log('Local checks only. No payment, order, balance, or market evidence is created.');

const validationFile = resolve(process.cwd(), 'state', 'judge-validation.json');
rmSync(validationFile, { force: true });
const results = [];

let failed = false;
for (const check of checks) {
  console.log('\n[run] ' + check.label);
  const result = spawnSync(check.command, check.args, {
    cwd: process.cwd(),
    stdio: 'inherit',
    env: process.env
  });
  if (result.error) {
    console.error('[fail] ' + check.label + ': ' + result.error.message);
    results.push({ label: check.label, status: 'FAIL' });
    failed = true;
    continue;
  }
  if (result.status !== 0) {
    console.error('[fail] ' + check.label + ' exited with code ' + result.status);
    results.push({ label: check.label, status: 'FAIL' });
    failed = true;
    continue;
  }
  console.log('[pass] ' + check.label);
  results.push({ label: check.label, status: 'PASS' });
}

if (failed) {
  console.error('\nJudge validation failed.');
  process.exitCode = 1;
} else {
  mkdirSync(resolve(process.cwd(), 'state'), { recursive: true, mode: 0o700 });
  writeFileSync(validationFile, `${JSON.stringify({
    schemaVersion: 1,
    completedAt: new Date().toISOString(),
    checks: results,
  }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  console.log('\nJudge validation passed. Run the live MCP steps in README.md separately.');
}
