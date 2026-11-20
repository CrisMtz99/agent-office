// The OS door's token: the secret a local command center sends as its bearer token (see index.ts and
// docs/os-door.md). 32 random bytes in hex, in .agent-office/os-door-token, made the first time the
// office or `agent-office os-door token` needs it, and kept until someone deletes the file.

import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { officeHome } from '../config.js';

export const OS_DOOR_TOKEN_FILE = 'os-door-token';

/** Where the token is kept: next to the office's other data (`cfg.dataDir`, `<home>/.agent-office`). */
export const osDoorTokenPath = (dataDir: string) => path.join(dataDir, OS_DOOR_TOKEN_FILE);

/** The office's OS door token, made (owner-only) when it isn't there yet. */
export function ensureOsDoorToken(dataDir: string): string {
  const file = osDoorTokenPath(dataDir);
  try {
    // `wx`: if two make it at once, one writes and the other reads what it wrote.
    writeFileSync(file, `${randomBytes(32).toString('hex')}\n`, { mode: 0o600, flag: 'wx' });
    ownerOnly(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
  }
  const token = readFileSync(file, 'utf8').trim();
  if (!/^[0-9a-f]{64}$/.test(token)) throw new Error(`${file} isn't an OS door token: delete it and the office makes a new one`);
  return token;
}

/** Windows ignores the file mode: take away what the folder hands down, and let only its owner in. */
function ownerOnly(file: string) {
  if (process.platform !== 'win32') return;
  try {
    execFileSync('icacls', [file, '/inheritance:r', '/grant:r', `${os.userInfo().username}:F`], { stdio: 'ignore', windowsHide: true });
  } catch {
    // the folder's own permissions (the user's profile) still keep other users out
  }
}

const HELP = `Usage: agent-office os-door token [--home <dir>]

Prints the OS door's token (docs/os-door.md): the bearer token a command center on
this computer sends to /api/os/*. Made the first time it's needed.

  --home <dir>   The office's home, as it was started with (else this folder when
                 an office runs here, else $AGENT_OFFICE_HOME or ~/agent-office)
`;

/** `agent-office os-door token`: prints the token of the office in `--home`, or here, or its home. */
export function osDoorCommand(argv: string[]): number {
  let dir = existsSync(path.join(process.cwd(), '.agent-office', 'config.json')) ? process.cwd() : officeHome();
  const args: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') {
      process.stdout.write(HELP);
      return 0;
    }
    if (a === '--home' || a === '-d' || a === '--dir') {
      if (!argv[i + 1]) return usage(`${a} needs a value`);
      dir = path.resolve(argv[++i]);
    } else if (a.startsWith('--home=')) dir = path.resolve(a.slice('--home='.length));
    else if (a.startsWith('-')) return usage(`unknown option ${a}`);
    else args.push(a);
  }
  if (args.length !== 1 || args[0] !== 'token') return usage('the one command is `token`');
  const dataDir = path.join(dir, '.agent-office');
  try {
    if (!statSync(dataDir).isDirectory()) throw new Error();
  } catch {
    console.error(`agent-office os-door: no office has run in ${dir} yet — start it once with \`agent-office\` there (or give its --home)`);
    return 1;
  }
  try {
    process.stdout.write(`${ensureOsDoorToken(dataDir)}\n`);
    return 0;
  } catch (err) {
    console.error(`agent-office os-door: ${(err as Error).message}`);
    return 1;
  }
}

function usage(why: string): number {
  console.error(`agent-office os-door: ${why}\n`);
  process.stderr.write(HELP);
  return 2;
}
