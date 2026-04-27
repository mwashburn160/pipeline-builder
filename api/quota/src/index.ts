// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createApp, runServer, attachRequestContext, mongoHealthCheck } from '@pipeline-builder/api-server';
import mongoose from 'mongoose';

import { config } from './config';
import { connectDatabase } from './helpers/database';
import getQuotaRoutes from './routes/read-quotas';
import updateQuotaRoutes from './routes/update-quota';

// -- Express app ---------------------------------------------------------------

const { app, sseManager } = createApp({
  checkDependencies: mongoHealthCheck(mongoose.connection),
  // Warm Mongo on /warmup so the first real request doesn't pay TCP+TLS+
  // auth cold-start. Postgres is already warmed by the default hook.
  warmupHooks: [async () => { await mongoose.connection.db?.admin().ping(); }],
});

app.use(attachRequestContext(sseManager));

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
