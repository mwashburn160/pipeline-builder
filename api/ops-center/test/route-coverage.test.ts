// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Permission + audit coverage for every route this service serves.
 *
 * Builds the REAL route table from `src/app-routes.ts` (the same mount code
 * `index.ts` runs) and fails when a write route has no permission gate or no
 * declared audit action, or a read route has no permission gate. Exceptions are
 * explicit and carry a reason; a stale one fails the test too.
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeAll } from '@jest/globals';
import { buildRouteTable, REMOTE_AUDIT_ACTIONS, type RouteTableEntry } from '@pipeline-builder/api-core';
import {
  INFRA_ROUTE_EXCEPTIONS,
  compareRouteTableSnapshot,
  declaredAuditActions,
  findInternalRouteViolations,
  findRouteCoverageViolations, findSystemOrgGuardViolations,
  findDynamicAuthzViolations,
  type InternalRouteDeclaration,
  findQuotaCoverageViolations,
  type QuotaCoverageException,
  type RouteCoverageException,
} from '@pipeline-builder/api-core/testing';

process.env.JWT_SECRET ||= 'route-coverage-test-secret';

const here = dirname(fileURLToPath(import.meta.url));
const snapshotFile = resolve(here, '../../../frontend/src/generated/route-table/ops-center.json');

/**
 * Routes that legitimately can't satisfy a rule, each with its reason. Every
 * entry below moved here from platform's route-coverage suite with the route
 * (the surface split out of platform unchanged).
 */
const EXCEPTIONS: RouteCoverageException[] = [
  ...INFRA_ROUTE_EXCEPTIONS,
  {
    method: 'POST',
    path: '/observability/query/batch',
    waive: 'audit',
    reason: 'A READ carried on POST for its body: runs a dashboard\'s catalog queries (Prometheus + audit trail, each under the per-key catalog gate) in one metered call per refresh tick. Persists nothing.',
  },
  {
    method: 'POST',
    path: '/observability/client-vitals',
    waive: 'all',
    reason: 'Browser real-user monitoring (web vitals + error-boundary catches): ANY signed-in user may post (requireAuth), because the samples describe the browser\'s own experience of the UI, not tenant data, so no capability applies. Not audited: it is not an actor-attributed action and records nothing but aggregate Prometheus series — frontend_web_vitals{metric,route,rating} and frontend_error_boundary_caught_total{boundary,route} — whose labels are closed sets (the route a known page pattern or `other`), with no user id or URL. Bounded per user and per IP (middleware/limiters.ts).',
  },
  // -- Dynamic per-row authorization ----------------------------------------
  {
    path: /^(PUT|DELETE|POST) \/dashboards\/:id(\/restore|\/purge)?$/,
    waive: 'permission',
    reason: 'dashboardService.canWrite is DYNAMIC — it also lets the dashboard\'s own CREATOR write/delete/restore/purge it, not just an org admin, so it has to resolve the target row first (restore and purge additionally require step-up).',
  },
  // -- Signed machine webhooks ----------------------------------------------
  {
    method: 'POST',
    path: '/observability/alert-webhook',
    waive: 'all',
    reason: 'Alertmanager relay: machine-to-machine, authorized by a per-instance bearer token compared inside the handler against ALERT_WEBHOOK_INSTANCES (with the instance named in x-alertmanager-instance); it fans alerts out to destinations and persists nothing.',
  },
  {
    method: 'POST',
    path: '/observability/oncall-webhook',
    waive: 'all',
    reason: 'On-call paging leg: machine-to-machine, authorized by the same per-instance bearer token as the relay (helpers/alertmanager-auth.ts), so there is no user identity to gate a permission on. It persists NOTHING — it forwards a matched alert to PagerDuty Events v2 and returns counts. Its constraints are elsewhere: it pages only for `severity: critical` AND `component: support`, re-checked in the handler rather than trusted from Alertmanager routing so a misrouted or replayed payload cannot page; it is OFF unless ONCALL_ENABLED, where a disabled client accepts and drops so the always-present Alertmanager route accumulates no notification failures; and it sends IDS AND LABELS ONLY, never tenant case content, because the on-call permission is system-org scoped and grants no tenant access. Not audited: the audit trail is for actor-attributed actions, and every outcome here is counted on oncall_pages_total{action,outcome} plus a structured log, which is what makes a failed page alertable.',
  },
  {
    method: 'POST',
    path: '/observability/oncall-ack',
    waive: 'all',
    reason: 'The INBOUND on-call leg: PagerDuty posts incident state changes (acknowledged / escalated / resolved) here. Machine-to-machine with no user identity to gate a permission on — but unlike the three webhooks around it the credential is NOT the Alertmanager bearer: it is a PagerDuty v3 signature, `X-PagerDuty-Signature: v1=<hex>`, an HMAC-SHA256 over the RAW body (so app-routes.ts mounts express.raw for this path, because verifying a re-serialized object fails every time). It fails CLOSED with no PAGERDUTY_WEBHOOK_SECRET, which matters more here than on the other webhooks: this one WRITES, and what it writes is an audit row asserting that a human acknowledged a page. An unverified call would let anyone who learns the URL claim coverage this deployment does not have. The header may carry several comma-separated v1= values (PagerDuty rotating its secret), so any match is accepted, and the compare is length-guarded + timingSafeEqual. AUDIT IS WAIVED AT THE ROUTE and emitted from the HANDLER instead, because which action applies depends on the payload: an incident.acknowledged writes support.oncall.acknowledged, an incident.escalated writes support.oncall.escalated, and a resolved or unrecognised event writes NOTHING (the resolve is already our own act — the reply that stopped the clock, or the alert clearing — so recording the provider echo would double-record an event this system caused). A single audited() on the chain would therefore have to name one of three outcomes and would misdeclare the other two. Both actions are attributed to the provider agent as `pagerduty:<id>`, deliberately not resolved to a local user, since a click in their UI is not an identity this system can attest to. Every path is also counted on oncall_ack_webhook_total{outcome}, which is what makes a stream of refused or unrecognised calls alertable.',
  },
  {
    method: 'POST',
    path: '/observability/pvc-autoexpand',
    waive: 'permission',
    reason: 'Alertmanager-driven PVC expansion: machine-to-machine, authorized by the same per-instance bearer token as the relay (helpers/alertmanager-auth.ts), so there is no user identity to gate a permission on. Unlike the relay it DOES mutate — it patches a claim\'s requested size — so the constraints are elsewhere and are real: OFF unless PVC_AUTOEXPAND_ENABLED, a namespaced Role limited to get+patch on persistentvolumeclaims in this namespace only, a per-claim ceiling measured from an annotation-pinned original, a Redis cooldown it fails CLOSED without, and pvc_autoexpand_* metrics plus PVC annotations. Every expansion (and failed attempt) is AUDITED as observability.pvc.autoexpand, attributed to `alertmanager:<instance>`.',
  },
  {
    method: 'POST',
    path: '/observability/postgres-rung',
    waive: 'permission',
    reason: 'Alertmanager-driven VERTICAL scaling of Postgres: machine-to-machine, authorized by the same per-instance bearer token as the relay (helpers/alertmanager-auth.ts), so there is no user identity to gate a permission on. It mutates a running database — it patches the workload\'s resources and the derived server config — so the constraints are elsewhere and are real: OFF unless POSTGRES_RUNG_ENABLED; the DIRECTION comes from a closed set of alert names this handler owns, never from the request body, so holding the token cannot choose an arbitrary size; a namespaced Role limited to get+patch on deployments/statefulsets (no create, no delete, and NOT */scale, which is KEDA\'s); a hard ceiling at POSTGRES_RUNG_MAX, which is exactly the namespace LimitRange\'s container max; a floor at 1 CPU / 2Gi; a Redis cooldown it fails CLOSED without, because two ops-center replicas receiving the same fan-out would otherwise both restart the primary; and postgres_rung_* metrics plus a workload annotation. Every resize (and failed attempt) is AUDITED as observability.postgres.rung, attributed to `alertmanager:<instance>`.',
  },
  {
    method: 'POST',
    path: '/observability/node-disk-autoexpand',
    waive: 'permission',
    reason: 'The ec2 counterpart of /observability/pvc-autoexpand: same per-instance bearer token (helpers/alertmanager-auth.ts), so no user identity to gate a permission on. It grows the instance DataVolume and runs ONE fixed, parameterless SSM document to resize the filesystem — the instance role may run that document and nothing else, so credentials stolen via IMDS cannot become arbitrary root commands. OFF unless NODE_DISK_AUTOEXPAND_ENABLED, ceilinged against a tag recording the first-seen size, and behind a Redis cooldown it fails CLOSED without. Every expansion (and failed attempt) is AUDITED as observability.node_disk.autoexpand, attributed to `alertmanager:<instance>`.',
  },
];

/**
 * The INTERNAL routes this service exposes and the services allowed to call
 * them — the same list `deploy/*​/k8s/istio-internal-routes.yaml` names.
 */
const INTERNAL_ROUTES: InternalRouteDeclaration[] = [
  // platform's durable cascade outbox: tear a purged org's rows out of this service's own tables (idempotent).
  { method: 'POST', path: '/ops/internal/orgs/:orgId/purge', callers: ['platform'] },
];

/**
 * User routes that deliberately do not meter and/or check apiCalls (docs/quotas.md).
 * The machine webhooks carry no user, so the quota middleware skips them itself.
 */
const QUOTA_EXCEPTIONS: QuotaCoverageException[] = [
  {
    method: 'POST',
    path: '/observability/client-vitals',
    waive: 'all',
    reason: 'Telemetry the app sends on its own (web vitals, error-boundary catches), not a call the customer makes: it must neither spend the org\'s apiCalls budget nor be refused when the org is at its cap. Mounted ahead of the /observability tenant prefix for exactly that; bounded instead by its own per-user and per-IP buckets.',
  },
];

let table: RouteTableEntry[];

beforeAll(async () => {
  const [{ createApp, postgresHealthCheck }, { mountRoutes, ONCALL_ACK_PATH }] = await Promise.all([
    import('@pipeline-builder/api-server'),
    import('../src/app-routes.js'),
  ]);
  // Built exactly as index.ts builds it.
  const { app } = createApp({ enableOpenApi: false, checkDependencies: postgresHealthCheck, enableRateLimit: false, jsonBodyExclude: [ONCALL_ACK_PATH] });
  mountRoutes(app);
  table = buildRouteTable(app);
});

describe('ops-center route coverage', () => {
  it('meters and checks apiCalls on every user route, and meters none twice', () => {
    const { violations } = findQuotaCoverageViolations(table, QUOTA_EXCEPTIONS);
    expect(violations).toEqual([]);
  });

  it('has no stale quota exceptions', () => {
    const { unusedExceptions } = findQuotaCoverageViolations(table, QUOTA_EXCEPTIONS);
    expect(unusedExceptions).toEqual([]);
  });

  it('serves a non-empty route table', () => {
    expect(table.length).toBeGreaterThan(0);
  });

  it('gates every write route on a permission and declares its audit action', () => {
    const { violations } = findRouteCoverageViolations(table, EXCEPTIONS);
    expect(violations).toEqual([]);
  });

  // Every route gated on a SYSTEM-ORG-ONLY permission must also run
  // `requireSystemOrg` and demand an MFA-grade session — i.e. be wired with
  // `requireSystemOrgPermission`, which composes all three so a route cannot
  // forget one. Token confinement already drops those permissions from a
  // tenant-scoped token, so this is the second half of an AND: the claim-only
  // org check costs nothing per request and does not depend on confinement
  // being applied correctly at every minting site.
  //
  // This assertion used to run in only two services, which is exactly how the
  // platform-operations permissions arrived without it. No exception list.
  it('guards every system-org-only route to the system org with aal2', () => {
    expect(findSystemOrgGuardViolations(table)).toEqual([]);
  });

  // The same rule for a route whose authority is resolved in its HANDLER.
  // `dynamicAuthz` is the only thing that puts such a route on the table at all
  // — its row otherwise reads `systemAdmin: false, permissions: []`, which is
  // indistinguishable from "merely authenticated" — so the declaration has to be
  // answerable: every dynamic rule names the principal KINDS it admits, and one
  // admitting a system-org principal names the permission ids it consults.
  //
  it('declares who every dynamically-authorized route admits', () => {
    expect(findDynamicAuthzViolations(table)).toEqual([]);
  });

  it('has no stale coverage exceptions', () => {
    const { unusedExceptions } = findRouteCoverageViolations(table, EXCEPTIONS);
    expect(unusedExceptions).toEqual([]);
  });

  it('declares only audit actions platform accepts from a service', () => {
    const unknown = declaredAuditActions(table).filter((a) => !(REMOTE_AUDIT_ACTIONS as readonly string[]).includes(a));
    expect(unknown).toEqual([]);
  });

  it('gates every internal route on requireInternalService, with the declared callers', () => {
    expect(findInternalRouteViolations(table, INTERNAL_ROUTES)).toEqual([]);
  });

  it('matches the route table the frontend reads', () => {
    expect(compareRouteTableSnapshot(table, snapshotFile)).toBeNull();
  });
});
