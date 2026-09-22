import { loadDotEnv, loadConfig, assertConfig } from './config.js';
import { createContainer } from './container.js';
import { createApp } from './http/app.js';
import { log } from './lib/logger.js';

loadDotEnv();
const config = assertConfig(loadConfig());
const container = createContainer(config);
const app = createApp(container);

const server = app.listen(config.port, () => {
  log.info('app listening', { port: config.port, workerInProcess: config.worker.inProcess });
});

// In one-command mode the worker runs inside this process. For the crash/restart demo
// run it separately (`npm run worker`) with WORKER_IN_PROCESS=false here.
if (config.worker.inProcess) container.worker.start();

async function shutdown(signal) {
  log.info('shutting down', { signal });
  server.close();
  await container.worker.stop();
  container.close();
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
