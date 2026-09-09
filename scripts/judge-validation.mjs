import { spawnSync } from 'node:child_process';

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const checks = [
  { label: 'TypeScript build', command: npm, args: ['run', 'build'] },
  { label: 'Deterministic test suite', command: npm, args: ['test'] },
  { label: 'Dependency audit', command: npm, args: ['audit', '--audit-level=moderate'] },
  { label: 'Git whitespace check', command: 'git', args: ['diff', '--check'] }
];

console.log('Signal402 judge validation');
console.log('Local checks only. No payment, order, balance, or market evidence is created.');

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
    failed = true;
    continue;
  }
  if (result.status !== 0) {
    console.error('[fail] ' + check.label + ' exited with code ' + result.status);
    failed = true;
    continue;
  }
  console.log('[pass] ' + check.label);
}

if (failed) {
  console.error('\nJudge validation failed.');
  process.exitCode = 1;
} else {
  console.log('\nJudge validation passed. Run the live MCP steps in README.md separately.');
}
