import { loadConfig } from './config';
import { createHttpServer } from './http';
import { logger, setLevel } from './log';
import { SessionStore } from './store';
import { createWsServer, resolveUpgrade } from './ws';

const log = logger('relay');

function main(): void {
  const config = loadConfig();
  setLevel(config.logLevel);

  const store = new SessionStore(config);
  const server = createHttpServer(store);
  const wss = createWsServer(store, config);

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    if (!url.pathname.startsWith('/ws/')) {
      socket.destroy();
      return;
    }
    const resolved = resolveUpgrade(url, store);
    if ('error' in resolved) {
      log.warn(`upgrade refused on ${url.pathname}: ${resolved.error}`);
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req, resolved);
    });
  });

  if (config.bootstrap) {
    const session = store.create(
      config.bootstrap.sessionId,
      config.bootstrap.hostToken,
      config.bootstrap.nornsToken,
    );
    // Registrations open immediately: the demo stack is usable on first load.
    session.open();
    log.info('bootstrap session ready');
    log.info(`  host   ${session.hostUrl}`);
    log.info(`  join   ${session.joinUrl}`);
    log.info(`  stage  ${session.stageUrl}`);
  }

  store.start();

  server.listen(config.port, config.host, () => {
    log.info(`StageIn relay listening on http://${config.host}:${config.port}`);
    log.info(`public base url: ${config.publicBaseUrl}`);
  });

  const shutdown = (signal: string): void => {
    log.info(`${signal} received — shutting down`);
    store.shutdown();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2_000).unref();
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('unhandledRejection', (err) => log.error('unhandled rejection', err));
}

main();
