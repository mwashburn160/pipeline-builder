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

import { createHealthRouter } from '@mwashburn160/api-core';
import { createApp, runServer } from '@mwashburn160/api-server';
import mongoose from 'mongoose';

import { config } from './config';
import { connectDatabase } from './helpers/database';
import getQuotaRoutes from './routes/get-quota';
import updateQuotaRoutes from './routes/update-quota';

// -- Express app ---------------------------------------------------------------

const { app } = createApp({ skipDefaultHealthCheck: true });

app.use(createHealthRouter({
  serviceName: 'quota',
  checkDependencies: async () => ({
    mongodb: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
  }),
}));

app.use('/quotas', getQuotaRoutes);
app.use('/quotas', updateQuotaRoutes);

// -- Startup -------------------------------------------------------------------

runServer(app, {
  name: 'Quota Service',
  port: config.port,
  onBeforeStart: () => connectDatabase(config.mongodb.uri),
  testDatabase: async () => mongoose.connection.readyState === 1,
  closeDatabase: async () => { await mongoose.connection.close(false); },
});

export { app };
