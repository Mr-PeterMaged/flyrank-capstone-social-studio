// One command: `npm start` boots the fake platform (4010) and the app + worker (3000).
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const procs = [
  ['platform', 'fakeplatform/server.js'],
  ['app     ', 'src/server.js'],
].map(([name, file]) => {
  const p = spawn(process.execPath, [file], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
  const tag = (d) => process.stdout.write(String(d).split('\n').filter(Boolean).map((l) => `[${name}] ${l}\n`).join(''));
  p.stdout.on('data', tag);
  p.stderr.on('data', tag);
  p.on('exit', (code) => {
    console.log(`[${name}] exited (${code})`);
    shutdown();
  });
  return p;
});

let closing = false;
function shutdown() {
  if (closing) return;
  closing = true;
  for (const p of procs) p.kill();
  setTimeout(() => process.exit(0), 300);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
