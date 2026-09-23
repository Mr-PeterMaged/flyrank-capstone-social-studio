import { mkdir, readFile, writeFile, cp, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
const root = process.cwd();
const settings = JSON.parse(await readFile(path.join(root, 'deployment.json'), 'utf8'));
const output = path.join(root, '.vercel', 'output');
const staticDir = path.join(output, 'static');
let origin;
if (settings.backend) {
  const value = process.env.BACKEND_ORIGIN;
  if (!value) throw new Error('BACKEND_ORIGIN is required: use the external backend HTTPS origin, without a trailing slash.');
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.origin !== value || url.username || url.password) throw new Error('BACKEND_ORIGIN must be an HTTPS origin without path, query, credentials or trailing slash.');
  if ([process.env.VERCEL_URL, process.env.VERCEL_PROJECT_PRODUCTION_URL].includes(url.host)) throw new Error('BACKEND_ORIGIN must not point to this Vercel project (proxy loop).');
  origin = url.origin;
}
// Refuse stale output instead of accidentally publishing a previous build's files.
try {
  if ((await readdir(output)).length) throw new Error('Build output exists. Remove only .vercel/output before rebuilding.');
} catch (error) { if (error.code !== 'ENOENT') throw error; }
await mkdir(staticDir, { recursive: true });
const extensions = new Set(['.html', '.css', '.js', '.json', '.png', '.jpg', '.jpeg', '.svg', '.webp', '.ico', '.woff', '.woff2']);
async function copyWeb(source, destination) {
  const info = await stat(source);
  if (info.isDirectory()) {
    await mkdir(destination, { recursive: true });
    for (const entry of await readdir(source, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
      await copyWeb(path.join(source, entry.name), path.join(destination, entry.name));
    }
  } else if (extensions.has(path.extname(source))) {
    await mkdir(path.dirname(destination), { recursive: true });
    await cp(source, destination);
  }
}
for (const [source, destination] of settings.assets) await copyWeb(path.join(root, source), path.join(staticDir, destination));
const routes = [{ src: '/(.*)', headers: { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'strict-origin-when-cross-origin' }, continue: true }];
if (settings.home !== '/') routes.push({ src: '/', status: 307, headers: { Location: settings.home } });
if (settings.demo) {
  const demoIndex = path.join(staticDir, 'demo', 'index.html');
  let page = await readFile(demoIndex, 'utf8');
  page = page.replace('href="/style.css"', 'href="/demo/style.css"').replace('src="/runtime.js"', 'src="/demo/runtime.js"').replace('src="/demo.js"', 'src="/demo/demo.js"');
  await writeFile(demoIndex, page);
  await writeFile(path.join(staticDir, 'demo', 'runtime.js'), 'window.PLATFORM_ORIGIN=window.location.origin;\n');
}
routes.push({ handle: 'filesystem' });
if (origin) routes.push({ src: '/(.*)', dest: `${origin}/$1`, headers: { 'Cache-Control': 'private, no-store' } });
await writeFile(path.join(output, 'config.json'), JSON.stringify({ version: 3, routes }, null, 2) + '\n');
console.log('Vercel assets and routes built successfully.');
