import { randomBytes, scryptSync } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import readline from 'node:readline';

function readPassword() {
  if (!process.stdin.isTTY) {
    return new Promise((resolve, reject) => {
      let value = '';
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (chunk) => { value += chunk; });
      process.stdin.on('end', () => resolve(value.trimEnd()));
      process.stdin.on('error', reject);
    });
  }
  if (process.platform === 'win32') {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise((resolve) => rl.question('Dashboard password (12+ characters): ', (answer) => { rl.close(); resolve(answer); }));
  }
  const terminalState = execFileSync('stty', ['-g'], { encoding: 'utf8' }).trim();
  execFileSync('stty', ['-echo']);
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question('Dashboard password (12+ characters): ', (answer) => {
      rl.close();
      execFileSync('stty', [terminalState]);
      process.stdout.write('\n');
      resolve(answer);
    });
  });
}

const password = await readPassword();
if (password.length < 12) throw new Error('Dashboard password must be at least 12 characters');
const n = 32_768;
const r = 8;
const p = 1;
const salt = randomBytes(16);
const hash = scryptSync(password, salt, 32, { N: n, r, p, maxmem: 64 * 1024 * 1024 });
process.stdout.write(`SIGNAL402_DASHBOARD_PASSWORD_HASH=scrypt$${n}$${r}$${p}$${salt.toString('base64url')}$${hash.toString('base64url')}\n`);
