// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { mongoSanitize } from '@pipeline-builder/api-core';
import { createApp, runServer, attachRequestContext, mongoHealthCheck, connectMongo } from '@pipeline-builder/api-server';
import mongoose from 'mongoose';

import { config } from './config';
import { createReadQuotaRoutes } from './routes/read-quotas';
import { createUpdateQuotaRoutes } from './routes/update-quota';

// -- Express app ---------------------------------------------------------------

const { app, sseManager } = createApp({
  checkDependencies: mongoHealthCheck(mongoose.connection),
  // Warm Mongo on /warmup so the first real request doesn't pay TCP+TLS+
  // auth cold-start. Postgres is already warmed by the default hook.
  warmupHooks: [async () => { await mongoose.connection.db?.admin().ping(); }],
});

app.use(attachRequestContext(sseManager));
// Mongo operator-injection guard — Quota is Mongo-backed.
app.use(mongoSanitize());

app.use('/quotas', createReadQuotaRoutes());
app.use('/quotas', createUpdateQuotaRoutes());

// -- Startup -------------------------------------------------------------------

runServer(app, {
  name: 'Quota Service',
  port: config.port,
  onBeforeStart: () => connectMongo(mongoose, config.mongodb.uri),
  testDatabase: async () => mongoose.connection.readyState === 1,
  closeDatabase: async () => { await mongoose.connection.close(false); },
});

export { app };
