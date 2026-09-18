// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createLogger, createQuotaService, wireServiceSecurity } from '@pipeline-builder/api-core';
import {
  createApp,
  runServer,
  attachRequestContext,
  postgresHealthCheck,
} from '@pipeline-builder/api-server';
import { createSoftDeletePurgeScheduler } from '@pipeline-builder/pipeline-data';

import { mountRoutes } from './app-routes.js';
import { startAuditPruneCron } from './helpers/compliance-check-log.js';
import { startDigestScheduler, stopDigestScheduler } from './helpers/digest-scheduler.js';
import { startScanScheduler, stopScanScheduler } from './helpers/scan-scheduler.js';
import { getAuditClient } from './services/audit.js';
import { complianceRuleService } from './services/compliance-rule-service.js';
import { compliancePolicyService } from './services/policy-service.js';

const logger = createLogger('compliance');
const quotaService = createQuotaService();
const { app, sseManager } = createApp({
  // Compliance's hard dependency is postgres. Redis is only used fail-open now
  // (token-revocation reader + scheduler leader locks via the shared env-Redis
  // client), so it must NOT gate readiness — a Redis outage degrades gracefully
  // rather than pulling the service out of the load balancer.
  checkDependencies: postgresHealthCheck,
});

// Attach request context to all requests
app.use(attachRequestContext(sseManager));

mountRoutes(app, { quotaService });

logger.info('All /compliance routes registered');

// Forward denied state-changing authorizations (rejected by requirePermission /
// requireSystemAdmin) into the same remote audit sink as the mutation events,
// as best-effort `authz.denied` failure records. Registered once at boot.
// Token-revocation reader (session-invalidation option b): the env-Redis store
// is lazily built + fully fail-open, so `requireAuth` can reject a token whose
// `tokenVersion` is behind the platform-published version, degrading to natural
// token expiry (never a lockout) when Redis is absent.
wireServiceSecurity('compliance', getAuditClient);

// Daily prune of compliance_audit_log (default 180 days, override via
// COMPLIANCE_AUDIT_RETENTION_DAYS). The handle is captured for graceful
// shutdown so tests/process-exit don't leave a dangling timer.
const auditPrune = startAuditPruneCron();

// Retention purge: hard-delete compliance policy + rule tombstones past their
// purge_after deadline. Leader-locked + sysadmin-scoped inside the sweep. Opt
// out with SOFT_DELETE_PURGE_ENABLED=false.
const purgeScheduler = createSoftDeletePurgeScheduler({
  service: 'compliance',
  entities: [
    { name: 'compliance_policy', purgeExpired: (now, limit) => compliancePolicyService.purgeExpired(now, limit) },
    { name: 'compliance_rule', purgeExpired: (now, limit) => complianceRuleService.purgeExpired(now, limit) },
  ],
});

void runServer(app, {
  name: 'Compliance Service',
  sseManager,
  onShutdown: async () => {
    stopScanScheduler();
    stopDigestScheduler();
    auditPrune.stop();
    purgeScheduler?.stop();
  },
});

startScanScheduler();
startDigestScheduler();
purgeScheduler?.start();

export { app };
