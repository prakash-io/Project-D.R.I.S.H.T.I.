// D.R.I.S.H.T.I. backend (Epic 1: API-01 .. API-04).
//
//   npm start          -- HTTP + Socket.IO
//   npm run worker     -- the Burst Sync worker, separately
//
// The worker is a separate process on purpose. Draining a few thousand
// dark-zone points is CPU-bound JSON and database work; running it inside the
// API process would stall the live telemetry of every other truck, which is
// the exact thing the queue exists to prevent.
import http from 'node:http';
import express from 'express';
import { Server as SocketServer } from 'socket.io';

import { config } from './config.js';
import { pool, healthcheck } from './db.js';
import { attachTelemetry } from './sockets/telemetry.js';
import { incidentsRouter } from './routes/incidents.js';
import { syncRouter } from './routes/sync.js';
import { routingRouter } from './routes/routing.js';
import { riskRouter } from './routes/risk.js';
import { tilesRouter } from './routes/tiles.js';
import { closeQueue } from './queues/burstSync.js';

export function createApp() {
  const app = express();
  // The dashboard is served by Vite on another origin in development.
  app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', config.corsOrigin);
    res.setHeader('Access-Control-Allow-Headers', 'content-type');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    return next();
  });
  // Burst-sync batches are large; the default 100 kb limit rejects a real
  // backlog. 50,000 points is the endpoint's own cap, checked in sync.js.
  app.use(express.json({ limit: '32mb' }));

  app.get('/health', async (_req, res) => {
    try {
      const graph = await healthcheck();
      res.json({
        service: 'drishti-backend',
        status: 'ok',
        graph: {
          edges: Number(graph.edges),
          nodes: Number(graph.nodes),
          districts: Number(graph.districts),
          main_component: graph.main_component === null ? null : Number(graph.main_component),
        },
        ai_service: config.aiServiceUrl,
        auto_block_on_ai_verdict: config.autoBlockOnAiVerdict,
      });
    } catch (error) {
      res.status(503).json({ status: 'degraded', error: error.message });
    }
  });

  app.use('/incidents', incidentsRouter);
  app.use('/risk', riskRouter);
  app.use('/tiles', tilesRouter);
  app.use('/sync', syncRouter);
  app.use('/', routingRouter);

  app.use((error, _req, res, _next) => {
    console.error('[api]', error);
    res.status(error.status ?? 500).json({ error: error.message ?? 'internal error' });
  });

  return app;
}

export function createServer() {
  const app = createApp();
  const server = http.createServer(app);
  const io = new SocketServer(server, {
    path: config.socketPath,
    cors: { origin: '*' },
  });
  attachTelemetry(io);
  return { app, server, io };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { server } = createServer();
  server.listen(config.port, () => {
    console.log(`[api] listening on :${config.port}${config.socketPath}`);
    console.log(`[api] ai service ${config.aiServiceUrl}`);
    console.log(`[api] auto-block on AI verdict: ${config.autoBlockOnAiVerdict}`);
  });

  const shutdown = async () => {
    console.log('\n[api] shutting down');
    server.close();
    await closeQueue();
    await pool.end();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
