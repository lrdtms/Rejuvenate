/**
 * Process entrypoint — binds the Express app to a port.
 *
 * Per architecture.md §11, Node binds to 127.0.0.1 (loopback only) in production;
 * Nginx terminates TLS and reverse-proxies `/api/*` to this process. PM2/systemd
 * supervises the process. See deploy/ for the deployment scaffolding.
 */
import { createApp } from './app';
import { env } from './config/env';

const app = createApp();

const host = env.NODE_ENV === 'production' ? '127.0.0.1' : '0.0.0.0';

app.listen(env.PORT, host, () => {
  // eslint-disable-next-line no-console
  console.log(`[api] listening on http://${host}:${env.PORT} (${env.NODE_ENV})`);
});
