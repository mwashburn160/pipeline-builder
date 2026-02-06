/**
 * @module quota
 * @description Quota microservice.
 *
 * Routes mounted under /quotas:
 *
 *   GET    /quotas                    — own org quotas (from JWT)
 *   GET    /quotas/all                — all orgs with quotas (system admin)
 *   GET    /quotas/:orgId             — all quotas for a specific org
 *   GET    /quotas/:orgId/:quotaType  — single quota type status
 *   PUT    /quotas/:orgId             — update org name/slug/quotas (system admin)
 *   POST   /quotas/:orgId/reset       — reset usage (system admin)
 *   POST   /quotas/:orgId/increment   — increment usage (same-org or admin)
 */

import { createLogger, createHealthRouter } from '@mwashburn160/api-core';
import cors from 'cors';
import express from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import mongoose from 'mongoose';

import { config } from './config';
import { connectDatabase, registerShutdown } from './helpers/database';
import getQuotaRoutes from './routes/get-quota';
import updateQuotaRoutes from './routes/update-quota';

const logger = createLogger('quota');

// -- Express app ---------------------------------------------------------------

const app: express.Express = express();

app.use(helmet());
app.use(cors());
app.use(express.json());
app.use(rateLimit({
  windowMs: config.rateLimit.windowMs,
  max: config.rateLimit.max,
  message: { success: false, statusCode: 429, message: 'Too many requests' },
}));

app.use(createHealthRouter({
  serviceName: 'quota',
  checkDependencies: async () => ({
    mongodb: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
  }),
}));

app.use('/quotas', getQuotaRoutes);
app.use('/quotas', updateQuotaRoutes);

// -- Startup -------------------------------------------------------------------

async function startServer(): Promise<void> {
  try {
    logger.info('Starting quota service...');

    await connectDatabase(config.mongodb.uri);

    const server = app.listen(config.port, () => {
      logger.info(`Quota service listening on port ${config.port}`);
    });

    registerShutdown(server);
  } catch (error) {
    logger.error('Failed to start server', { error });
    process.exit(1);
  }
}

startServer().catch((error) => {
  logger.error('Unhandled error during startup', { error });
  process.exit(1);
});

export { app };
