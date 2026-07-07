// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { mongoSanitize, createLogger, DEFAULT_TIER, QUOTA_TIERS, VALID_TIERS, isValidTier } from '@pipeline-builder/api-core';
import { createApp, runServer, attachRequestContext, mongoHealthCheck, connectMongo } from '@pipeline-builder/api-server';
import mongoose from 'mongoose';

import { config } from './config.js';
import { createReadQuotaRoutes } from './routes/read-quotas.js';
import { createUpdateQuotaRoutes } from './routes/update-quota.js';

const logger = createLogger('quota-service');

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

// Validation: if DEFAULT_QUOTA_TIER was set but isn't a real tier, it silently
// falls back to 'developer' — surface that loudly so a typo isn't a silent no-op.
if (process.env.DEFAULT_QUOTA_TIER && !isValidTier(process.env.DEFAULT_QUOTA_TIER)) {
  logger.warn('DEFAULT_QUOTA_TIER is not a valid tier — falling back to developer', {
    value: process.env.DEFAULT_QUOTA_TIER,
    validTiers: VALID_TIERS,
  });
}

// Echo the EFFECTIVE tier config at startup so operators can confirm their
// DEFAULT_QUOTA_TIER / QUOTA_TIER_* / QUOTA_TIER_*_LABEL overrides took effect
// (these are read from env once at module load).
logger.info('Effective quota tiers', {
  defaultTier: DEFAULT_TIER,
  tiers: Object.fromEntries(
    VALID_TIERS.map((t) => [t, { label: QUOTA_TIERS[t].label, ...QUOTA_TIERS[t].limits }]),
  ),
});

runServer(app, {
  name: 'Quota Service',
  port: config.port,
  onBeforeStart: () => connectMongo(mongoose, config.mongodb.uri),
  testDatabase: async () => mongoose.connection.readyState === 1,
  closeDatabase: async () => { await mongoose.connection.close(false); },
});

export { app };
