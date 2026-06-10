// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { mongoSanitize } from '@pipeline-builder/api-core';
import { createApp, runServer, attachRequestContext, mongoHealthCheck, connectMongo } from '@pipeline-builder/api-server';
import mongoose from 'mongoose';

import { config } from './config.js';
import { createReadQuotaRoutes } from './routes/read-quotas.js';
import { createUpdateQuotaRoutes } from './routes/update-quota.js';

// -- Express app ---------------------------------------------------------------

const { app, sseManager } = createApp({
  checkDependencies: mongoHealthCheck(mongoose.connection),
  // Warm Mongo on /warmup so the first real request doesn't pay TCP+TLS+
  // auth cold-start. Postgres is already warmed by the default hook.
  warmupHooks: [async () => { await mongoose.connection.db?.admin().ping(); }],
});

// Mongo operator-injection guard — Quota is Mongo-backed. Runs BEFORE the
// request-context middleware so any structured logging triggered by the
// sanitizer (or by downstream middleware reading req.body/req.query) sees
// the already-sanitised payload, not the raw operator-laden one.
app.use(mongoSanitize());
app.use(attachRequestContext(sseManager));

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
