import path from 'node:path';
import express from 'express';
import cookieParser from 'cookie-parser';
import { apiRouter } from './api/routes/index';
import { env } from './env';
import { healthStatus } from './api/health';

export function createApp(): express.Express {
  const app = express();
  app.disable('x-powered-by');

  // A hop count, not `true`. It lets req.secure reflect X-Forwarded-Proto when a
  // TLS proxy sits in front, so the session cookie is marked Secure exactly when
  // the connection is — but trusting the whole header also meant req.ip was
  // whatever the caller wrote, and the login limiter keys on that. Counting the
  // proxies that are actually yours takes the address from past anything a
  // caller can prepend. 0, the default, means req.ip is the socket itself.
  app.set('trust proxy', env.trustedProxyHops);

  app.use(express.json());
  app.use(cookieParser());
  app.get('/api/health', async (_req, res) => {
    const health = await healthStatus();
    res.set('Cache-Control', 'no-store').status(health.ok ? 200 : 503).json(health);
  });
  app.use('/api', apiRouter);

  const distPath = path.resolve('dist');
  app.use(express.static(distPath));

  // Express 5 requires a named wildcard; a bare '*' throws at registration.
  app.get('/*splat', (_req, res) => {
    res.sendFile(path.join(distPath, 'index.html'));
  });

  app.use((error: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error('[api]', error);
    const status = 'status' in error && typeof error.status === 'number' && error.status >= 400 && error.status < 500
      ? error.status : 500;
    res.status(status).json({ success: false, error: status < 500 ? error.message : 'Internal server error' });
  });

  return app;
}
