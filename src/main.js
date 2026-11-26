import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildConfig } from './config.js';

const __filename = fileURLToPath(import.meta.url);

async function main() {
  const argv = process.argv.slice(2);
  const config = buildConfig(argv);

  if (config.demo) {
    const { startDemo } = await import('./demo.js');
    await startDemo(config);
    return;
  }

  const { startProxy } = await import('./server.js');
  const app = await startProxy(config);
  await app.listen();
  const url = `http://${config.host}:${config.port}`;
  app.logger.info(`proxy listening on ${url}  (debug console: ${url}/)`);
  if (app.pool.size === 0) {
    app.logger.warn('no upstreams configured — pass --upstream host:port[,host:port]');
  }
  for (const u of app.pool.snapshot()) app.logger.info(`upstream ${u.id} → ${u.url.raw}`);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === __filename;
if (isMain) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
