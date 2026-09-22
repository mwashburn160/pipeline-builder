// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { wireServiceSecurity, createEnvSseTicketStore, SSE_TICKET_TTL_MS } from '@pipeline-builder/api-core';
import { createApp, runServer, attachRequestContext, postgresHealthCheck } from '@pipeline-builder/api-server';

import { mountRoutes } from './app-routes.js';
import { startReportingRetention, stopReportingRetention } from './services/reporting-retention.js';

const { app, sseManager } = createApp({ checkDependencies: postgresHealthCheck, jsonLimit: '5mb' });

// Boot security: forward denied authorizations to the authz.denied audit sink +
// register the env-Redis token-revocation reader (fail-open).
wireServiceSecurity('reporting');

app.use(attachRequestContext(sseManager));

// Single-use, org-bound tickets for the live execution-status SSE channel (the
// EventSource can't send an Authorization header, so the JWT is exchanged for a
// ticket). Distinct keyspace so an execution-stream ticket can't be redeemed on
// another service's SSE channel (e.g. message notifications) sharing this Redis.
const executionTicketStore = createEnvSseTicketStore({
  ttlMs: SSE_TICKET_TTL_MS,
  keyPrefix: 'reporting-exec',
});

mountRoutes(app, { sseManager, executionTicketStore });

void runServer(app, {
  name: 'Reporting Service',
  sseManager,
  onShutdown: async () => { stopReportingRetention(); },
});

// Split, per-org reporting retention sweep: leader-locked + batched.
// Deletes expired pipeline_events / deployment_outcomes / incidents by created_at
// (standard-event vs DORA-source windows). Opt out with REPORTING_RETENTION_ENABLED=false.
startReportingRetention();
