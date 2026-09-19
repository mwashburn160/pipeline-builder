// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Wiring test for src/index.ts route mounts.
 *
 * RBAC read-enforcement lock-in: the `/reports/execution` and `/reports/plugins`
 * query mounts (the user-facing dashboard reads) must sit behind
 * `requirePermission('reports:read')`. The guard is applied at the app-mount layer
 * (index.ts), NOT inside the individual route factories, so this test drives
 * index.ts with every heavy dependency mocked and inspects the middleware stack
 * captured from `app.use(...)`.
 *
 * The event-INGEST mount (`/reports/events`) is asserted NOT to carry the read
 * guard: it is a machine WRITE path authorized inside the router by the
 * `reporting:ingest` token scope, and gating it with `reports:read` would be wrong.
 */

import { jest, describe, it, expect } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

// Capture every app.use(...) call so we can inspect the middleware stacks.
const useCalls: unknown[][] = [];
const app = {
  use: (...args: unknown[]) => { useCalls.push(args); return app; },
  // index.ts also registers the live execution-status SSE routes directly on the
  // app (POST ticket + GET stream); accept them as no-ops for this wiring test.
  post: (..._args: unknown[]) => app,
  get: (..._args: unknown[]) => app,
};

// Distinct marker objects per route factory so a mount is identified by its
// final argument (the router) regardless of the shared '/reports' prefix.
const ROUTERS = {
  events: { __router: 'events' },
  ingestHealth: { __router: 'ingest-health' },
  incidents: { __router: 'incidents' },
  deployments: { __router: 'deployments' },
  execution: { __router: 'execution' },
  plugins: { __router: 'plugins' },
  settings: { __router: 'settings' },
  retentionSync: { __router: 'retention-sync' },
  retention: { __router: 'retention' },
} as const;

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  // Passthrough auth guard (no __permission tag) — mounted on the events prefix.
  requireAuth: (_req: unknown, _res: unknown, next?: () => void) => next?.(),
  // Live execution-status SSE wiring (index.ts constructs the ticket store at import).
  SSE_TICKET_TTL_MS: 30_000,
  createEnvSseTicketStore: () => ({
    issue: async () => ({ ok: true, ticket: 't' }),
    consume: async () => ({ orgId: 'o' }),
  }),
  sendSuccess: (_res: unknown, _code: number, _data?: unknown) => undefined,
  sendError: (_res: unknown, _code: number, _msg: string) => undefined,
  ErrorCode: new Proxy({}, { get: (_t, k) => k }),
}));

jest.unstable_mockModule('@pipeline-builder/api-server', () => ({
  createApp: () => ({ app, sseManager: {} }),
  runServer: jest.fn(),
  createAuthenticatedWithOrgRoute: () => [],
  attachRequestContext: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  postgresHealthCheck: async () => ({ ok: true }),
  // The live execution-status channel is registered via this shared helper; the
  // permission-wiring test only inspects the report-route mounts, so a no-op is fine.
  registerSseTicketChannel: () => undefined,
}));

jest.unstable_mockModule('../src/routes/event-ingest.js', () => ({ createEventIngestRoutes: () => ROUTERS.events }));
jest.unstable_mockModule('../src/routes/ingest-health.js', () => ({ createIngestHealthRoutes: () => ROUTERS.ingestHealth }));
jest.unstable_mockModule('../src/routes/incidents.js', () => ({ createIncidentRoutes: () => ROUTERS.incidents }));
jest.unstable_mockModule('../src/routes/deployment-outcomes.js', () => ({ createDeploymentOutcomeRoutes: () => ROUTERS.deployments }));
jest.unstable_mockModule('../src/routes/execution-reports.js', () => ({ createExecutionReportRoutes: () => ROUTERS.execution }));
jest.unstable_mockModule('../src/routes/plugin-reports.js', () => ({ createPluginReportRoutes: () => ROUTERS.plugins }));
jest.unstable_mockModule('../src/routes/report-settings.js', () => ({ createReportSettingsRoutes: () => ROUTERS.settings }));
jest.unstable_mockModule('../src/routes/retention-sync.js', () => ({ createRetentionSyncRoutes: () => ROUTERS.retentionSync }));
jest.unstable_mockModule('../src/routes/retention.js', () => ({ createRetentionRoutes: () => ROUTERS.retention }));
jest.unstable_mockModule('../src/services/audit.js', () => ({ getAuditClient: () => ({ record: jest.fn() }) }));
// Retention sweep (Phase 7) is wired at boot; stub it so this wiring test doesn't
// pull in pipeline-data / start a real scheduler.
jest.unstable_mockModule('../src/services/reporting-retention.js', () => ({
  startReportingRetention: jest.fn(),
  stopReportingRetention: jest.fn(),
}));

await import('../src/index.js');

/** Find the app.use(...) call that mounts the given router marker. */
function mountFor(marker: unknown): unknown[] {
  const call = useCalls.find((args) => args[args.length - 1] === marker);
  if (!call) throw new Error('No mount found for the given router marker');
  return call;
}

/** The mounted `reports:read` gate on a mount, if any. */
function readGate(args: unknown[]): any {
  return args.find((a) => typeof a === 'function' && (a as any).__permission === 'reports:read');
}

describe('src/index.ts — reports:read enforcement', () => {
  it('mounts the execution query route behind requirePermission("reports:read")', () => {
    const gate = readGate(mountFor(ROUTERS.execution));
    expect(gate).toBeDefined();
    // Plain user-facing gate (any-of), NOT the service-admitting variant.
    expect(gate.__allowService).toBe(false);
  });

  it('mounts the plugins query route behind requirePermission("reports:read")', () => {
    const gate = readGate(mountFor(ROUTERS.plugins));
    expect(gate).toBeDefined();
    expect(gate.__allowService).toBe(false);
  });

  it('does NOT gate the event-ingest mount with reports:read', () => {
    // Ingest is a machine write path (reporting:ingest scope), not a dashboard
    // read — gating it with reports:read would be a regression.
    expect(readGate(mountFor(ROUTERS.events))).toBeUndefined();
  });

  it('does NOT gate the ingest-health mount with reports:read', () => {
    // Also a machine write path (reporting:ingest scope), authorized in-router.
    expect(readGate(mountFor(ROUTERS.ingestHealth))).toBeUndefined();
  });

  it('does NOT gate the incidents mount with reports:read', () => {
    // Incident webhook is a machine write path (reporting:ingest scope), authorized
    // in-router — mirrors ingest-health. The DORA reads that consume incidents carry
    // the advanced_reporting gate; the ingest itself must not require reports:read.
    expect(readGate(mountFor(ROUTERS.incidents))).toBeUndefined();
  });

  it('does NOT gate the retention-sync mount with reports:read', () => {
    // Inbound billing → reporting retention sync is a machine WRITE path
    // (service-principal / system-admin guard runs inside the router, mirroring
    // platform's seat-limit sync). Gating it with reports:read — or any org-user
    // permission — would reject the billing service token.
    expect(readGate(mountFor(ROUTERS.retentionSync))).toBeUndefined();
  });

  it('mounts the effective-retention read behind reports:read ONLY (no advanced_reporting gate)', () => {
    // The Retention Pack is sold to every tier, so the Reports date-range cap must
    // be readable without the DORA entitlement: exactly the read gate + the router.
    const mount = mountFor(ROUTERS.retention);
    expect(mount[0]).toBe('/reports/retention');
    const gate = readGate(mount);
    expect(gate).toBeDefined();
    expect(gate.__allowService).toBe(false);
    // path, the read gate, the router — nothing else (createAuthenticatedWithOrgRoute is [] here).
    expect(mount).toHaveLength(3);
  });

  it('mounts the report-settings routes behind requirePermission("reports:read")', () => {
    // Per-org reporting config (incident window) is user-facing + DORA-gated:
    // reports:read at the mount (advanced_reporting too); the PUT adds an
    // org-admin org:settings gate inside the router.
    const gate = readGate(mountFor(ROUTERS.settings));
    expect(gate).toBeDefined();
    expect(gate.__allowService).toBe(false);
  });

  it('mounts the deployment-outcome WRITE behind requirePermission("pipelines:write"), not reports:read', () => {
    // Marking a deploy failed/restored mutates DORA CFR/MTTR — a read-only report
    // viewer (reports:read alone) must not be able to forge outcomes.
    const mount = mountFor(ROUTERS.deployments);
    expect(readGate(mount)).toBeUndefined();
    const gate = mount.find((a) => typeof a === 'function' && (a as any).__permission === 'pipelines:write') as any;
    expect(gate).toBeDefined();
    expect(gate.__allowService).toBe(false);
  });

  describe('gate behavior', () => {
    const gate = () => readGate(mountFor(ROUTERS.execution));

    function run(user: unknown) {
      const res: any = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };
      const next = jest.fn();
      gate()({ user }, res, next);
      return { res, next };
    }

    it('403s a user WITHOUT reports:read', () => {
      const { res, next } = run({ permissions: ['pipelines:read'] });
      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(403);
    });

    it('passes a user WITH reports:read', () => {
      const { res, next } = run({ permissions: ['reports:read'] });
      expect(next).toHaveBeenCalled();
      expect(res.status).not.toHaveBeenCalledWith(403);
    });

    it('passes a superadmin (implicit-all)', () => {
      const { next } = run({ isSuperAdmin: true });
      expect(next).toHaveBeenCalled();
    });

    it('403s a service principal (no OrService on user-facing reads)', () => {
      const { res, next } = run({ sub: 'service:platform', permissions: [] });
      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(403);
    });
  });
});
