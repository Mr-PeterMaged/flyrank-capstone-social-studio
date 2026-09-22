// Seeds demo data straight into the database (safe while the app is running: SQLite WAL).
//   npm run seed
import { loadDotEnv, loadConfig, assertConfig } from '../src/config.js';
import { createContainer } from '../src/container.js';

loadDotEnv();
const container = createContainer(assertConfig(loadConfig()));

const posts = [
  {
    title: 'Why Idempotency Keys Make Retries Safe',
    url: 'https://example.com/blog/idempotency-keys',
    body:
      '# Retries\n\nNetworks fail. **A retry after a timeout** is dangerous when the first request actually succeeded. ' +
      'An idempotency key lets the server recognise the repeat and return the original result instead of doing the work twice. ' +
      'Generate the key once, store it with the job, and send it on every attempt. That single habit prevents duplicate charges, ' +
      'duplicate emails and duplicate posts.',
  },
  {
    title: 'Scheduling Work That Survives A Crash',
    url: 'https://example.com/blog/durable-scheduling',
    body:
      'A timer in memory disappears with the process. Store the job and its due time in the database, let workers claim jobs with a lease, ' +
      'and reclaim any job whose lease expired. Combined with idempotent publishing, a worker can die at any line and the campaign still ' +
      'goes out exactly once.',
  },
];

const existing = new Set(container.campaigns.listPosts().map((p) => p.url));
let created = 0;
for (const p of posts) {
  if (existing.has(p.url)) continue;
  container.campaigns.createPost(p);
  created++;
}
const first = container.campaigns.listPosts().at(-1);
if (!container.repos.campaigns.list().length && first) {
  const c = await container.campaigns.createCampaign(first.id);
  console.log(`Created campaign #${c.id} with ${c.variants.length} variants (${c.variants.map((v) => v.reviewStatus).join(', ')})`);
}
console.log(`Seeded ${created} post(s).`);
container.close();
