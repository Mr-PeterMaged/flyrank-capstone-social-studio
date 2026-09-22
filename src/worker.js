// Standalone worker process. Same container, same database as the web app: killing this
// process mid-batch and starting it again is exactly the crash-recovery scenario the
// durable queue is built for (see docs / EVIDENCE.md).
import { loadDotEnv, loadConfig, assertConfig } from './config.js';
import { createContainer } from './container.js';
import { log } from './lib/logger.js';

loadDotEnv();
const config = assertConfig(loadConfig());
const container = createContainer(config, { workerId: process.env.WORKER_ID });
container.worker.start();
// setInterval is unref'd so tests can exit; a real worker process must stay alive.
setInterval(() => {}, 1 << 30);

async function shutdown(signal) {
  log.info('worker shutting down', { signal });
  await container.worker.stop();
  container.close();
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
