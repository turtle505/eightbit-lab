// npm run update [-- --force]
// Pull the latest code, rebuild the web app and restart the backend — but only when nobody is mid-work,
// because a restart cuts off whatever an employee is doing. --force skips that check (and rebuilds even
// when there was nothing new to pull).
import { execFileSync, spawnSync } from 'node:child_process';
import { loadOffice, ROOT } from '../server/src/config.ts';

const force = process.argv.includes('--force');
const UNIT = 'eightbit-lab';

function run(cmd: string, args: string[]) {
  console.log(`$ ${cmd} ${args.join(' ')}`);
  const r = spawnSync(cmd, args, { cwd: ROOT, stdio: 'inherit' });
  if (r.status !== 0) {
    console.error(`✖ ${cmd} failed — stopping here; the running backend was not touched.`);
    process.exit(r.status ?? 1);
  }
}
const git = (...args: string[]) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();

// 1. is anyone working?
const office = loadOffice();
try {
  const res = await fetch(`http://127.0.0.1:${office.port}/api/busy`, {
    headers: office.authToken ? { 'X-Office-Token': office.authToken } : {},
    signal: AbortSignal.timeout(3000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const busy = (await res.json()) as { working: { id: string; name: string }[]; queued: number };
  if (busy.working.length || busy.queued) {
    const who = busy.working.map((w) => w.name).join(', ') || '—';
    console.log(`⏳ Working now: ${who}; waiting for a slot: ${busy.queued}.`);
    if (!force) {
      console.log('Not updating, since a restart would cut them off. Try again later, or run `npm run update -- --force`.');
      process.exit(1);
    }
    console.log('--force: going ahead anyway.');
  } else {
    console.log('✓ Nobody is working.');
  }
} catch (err) {
  console.log(`· Backend not reachable on :${office.port} (${(err as Error).message}) — nothing to interrupt.`);
}

// 2. pull
const before = git('rev-parse', 'HEAD');
run('git', ['pull', '--ff-only']);
const after = git('rev-parse', 'HEAD');
if (before === after && !force) {
  console.log('✓ Already up to date — nothing to rebuild.');
  process.exit(0);
}
const changed = before === after ? [] : git('diff', '--name-only', before, after).split('\n');

// 3. dependencies, only when they changed
if (changed.includes('package-lock.json')) run('npm', ['ci']);

// 4. build
run('npm', ['run', 'build']);

// 5. restart
const hasUnit = spawnSync('systemctl', ['--user', 'cat', UNIT], { stdio: 'ignore' }).status === 0;
if (hasUnit) {
  run('systemctl', ['--user', 'restart', UNIT]);
  spawnSync('systemctl', ['--user', '--no-pager', '--lines=0', 'status', UNIT], { stdio: 'inherit' });
  console.log(`✓ Updated to ${after.slice(0, 7)} and restarted.`);
} else {
  console.log(`✓ Updated to ${after.slice(0, 7)}. No systemd unit "${UNIT}" here — restart the backend yourself (npm start).`);
}
