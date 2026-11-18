// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * WHERE each cascade leg goes: the downstream half of an org purge or a user
 * erasure, one entry per owning service.
 *
 * Every leg is delivered by the durable outbox (services/cascade-outbox.ts),
 * never inline, and every one through a typed internal contract, so each has
 * the same retry, backoff, dead-letter metric and alert. Before the outbox
 * there were two integration styles — platform wrote ~45 other services'
 * Postgres tables directly, and reached quota, billing, message blobs and the
 * registry over HTTP — and neither retried once the org document was gone.
 *
 * A leg's `deliver` NEVER throws and answers `ok` only for a 2xx: that is the
 * ack. Every handler it calls is idempotent, so redelivering an acked leg (a
 * crash between the 2xx and the `done` write) is harmless.
 */

import {
  BILLING_INTERNAL,
  callInternal,
  COMPLIANCE_INTERNAL,
  createSafeClient,
  errorMessage,
  getServiceAuthHeader,
  IMAGE_REGISTRY_INTERNAL,
  MESSAGE_INTERNAL,
  OPS_CENTER_INTERNAL,
  PIPELINE_INTERNAL,
  PLUGIN_INTERNAL,
  QUOTA_INTERNAL,
  REPORTING_INTERNAL,
  SYSTEM_ORG_ID,
  type InternalEndpointContract,
} from '@pipeline-builder/api-core';
import { config } from '../config/index.js';
import type { CascadeKind } from '../models/cascade-outbox.js';

/** One delivery attempt's outcome. */
export interface CascadeDelivery {
  /** True only for a 2xx — the ack. */
  ok: boolean;
  /** The service's HTTP status; absent when it could not be reached. */
  statusCode?: number;
  /** Why it failed (non-2xx body summary, transport error). */
  error?: string;
}

/** One downstream leg of a cascade. */
export interface CascadeLeg {
  kind: CascadeKind;
  /** The leg's name: the owning service (+ `-blobs` for message's object storage). */
  service: string;
  deliver: (subjectId: string) => Promise<CascadeDelivery>;
}

type SafeClient = ReturnType<typeof createSafeClient>;

interface Endpoint {
  serviceHost: string;
  servicePort: number;
}

function client(endpoint: Endpoint, timeout = config.organization.cascadeHttpTimeoutMs): SafeClient {
  return createSafeClient({ host: endpoint.serviceHost, port: endpoint.servicePort, timeout });
}

/**
 * The platform service token every leg sends: system-org bound (the purge is
 * the platform acting, not a tenant), with `x-org-id` naming the org being
 * torn down. Every receiving route gates on `requireInternalService` naming
 * `platform`; the target org is the PATH param.
 */
function headers(orgId: string): Record<string, string> {
  return {
    'Authorization': getServiceAuthHeader({ serviceName: 'platform', orgId: SYSTEM_ORG_ID, role: 'owner' }),
    'x-org-id': orgId,
  };
}

/**
 * Deliver through a typed internal contract (the path param named `param`).
 * `incomplete` reads a 2xx reply that nonetheless reports a partial teardown
 * (the registry answers 200 with the repositories it could not delete) — such a
 * reply is NOT an ack, so the leg retries.
 */
function viaContract(
  endpoint: () => Endpoint,
  contract: InternalEndpointContract,
  param: 'orgId' | 'userId',
  { timeout, incomplete }: { timeout?: () => number; incomplete?: (data: unknown) => string | null } = {},
): (subjectId: string) => Promise<CascadeDelivery> {
  return async (subjectId) => {
    try {
      const result = await callInternal(client(endpoint(), timeout?.()), contract, {
        params: { [param]: subjectId },
        options: { headers: headers(param === 'orgId' ? subjectId : SYSTEM_ORG_ID) },
      });
      if (result.ok) {
        const partial = incomplete?.(result.data) ?? null;
        return partial ? { ok: false, statusCode: result.status, error: partial } : { ok: true, statusCode: result.status };
      }
      if (result.reason === 'unreachable') return { ok: false, error: 'unreachable' };
      // A 2xx whose body does not match the contract is still an ack: the
      // owning service did the delete, it just answered in a shape we can't
      // count. A non-2xx status is a retry.
      if (result.reason === 'invalid-response') return { ok: true, statusCode: result.status };
      return { ok: false, statusCode: result.status, error: `HTTP ${result.status}` };
    } catch (err) {
      return { ok: false, error: errorMessage(err) };
    }
  };
}

/**
 * The `incomplete` hook for a leg answering `OrgPurgeWithRemainderResponse`:
 * any non-zero `remaining` count is a partial purge (not an ack).
 */
function remainingAfterPurge(service: string): (data: unknown) => string | null {
  return (data) => {
    const remaining = (data as { remaining?: unknown }).remaining;
    if (!remaining || typeof remaining !== 'object') return null;
    const left = Object.entries(remaining as Record<string, unknown>)
      .filter(([, n]) => typeof n === 'number' && n > 0)
      .map(([table, n]) => `${n} ${table}`);
    return left.length > 0 ? `${service} purge incomplete: ${left.join(', ')} left` : null;
  };
}

/**
 * Every downstream leg. An org purge enqueues all the `org.deleted` legs; a user
 * erasure all the `user.erased` legs. Adding a service that holds org or user
 * data means adding its leg HERE (and its slice to pipeline-data's
 * `ORG_DATA_OWNERSHIP`), never a direct write from platform.
 */
export const CASCADE_LEGS: readonly CascadeLeg[] = [
  // ---- org.deleted: Postgres rows, deleted by their owning service ----
  { kind: 'org.deleted', service: 'pipeline', deliver: viaContract(() => config.pipeline, PIPELINE_INTERNAL.purgeOrg, 'orgId') },
  { kind: 'org.deleted', service: 'plugin', deliver: viaContract(() => config.plugin, PLUGIN_INTERNAL.purgeOrg, 'orgId') },
  { kind: 'org.deleted', service: 'compliance', deliver: viaContract(() => config.compliance, COMPLIANCE_INTERNAL.purgeOrg, 'orgId') },
  { kind: 'org.deleted', service: 'message', deliver: viaContract(() => config.message, MESSAGE_INTERNAL.purgeOrgData, 'orgId') },
  { kind: 'org.deleted', service: 'reporting', deliver: viaContract(() => config.reporting, REPORTING_INTERNAL.purgeOrg, 'orgId') },
  // Dashboards, alert rules + destinations and their delivery status (the
  // operations control plane, split out of platform).
  { kind: 'org.deleted', service: 'ops-center', deliver: viaContract(() => config.opsCenter, OPS_CENTER_INTERNAL.purgeOrg, 'orgId') },
  // ---- org.deleted: Mongo documents, deleted by their owning service ----
  // The quota document (enforcement for the org). One deleteOne: no partial outcome.
  { kind: 'org.deleted', service: 'quota', deliver: viaContract(() => config.quota, QUOTA_INTERNAL.purgeOrg, 'orgId') },
  // Cancels any billable subscription at the provider, then drops it + its events.
  {
    kind: 'org.deleted',
    service: 'billing',
    deliver: viaContract(() => config.billing, BILLING_INTERNAL.purgeOrg, 'orgId', {
      // A 200 that KEPT subscriptions (their provider cancel failed) is a partial
      // purge: the provider is still charging, and the retry cancels them again.
      incomplete: remainingAfterPurge('billing'),
    }),
  },
  // The org's MinIO attachment blobs (`<orgId>/…`) — platform holds no object-storage client.
  { kind: 'org.deleted', service: 'message-blobs', deliver: viaContract(() => config.message, MESSAGE_INTERNAL.purgeOrgAttachments, 'orgId') },
  // The org's PRIVATE `org-<id>/*` registry namespace. Published `public/*`
  // copies are deliberately retained — other orgs install them. Slower in kind
  // (a per-manifest walk), so it takes the dedicated registry timeout.
  {
    kind: 'org.deleted',
    service: 'image-registry',
    deliver: viaContract(() => config.imageRegistry, IMAGE_REGISTRY_INTERNAL.purgeOrgNamespace, 'orgId', {
      timeout: () => config.organization.registryCascadeHttpTimeoutMs,
      // A 200 that names repositories it could not delete is a partial purge.
      incomplete: (data) => {
        const failed = (data as { failed?: unknown }).failed;
        return Array.isArray(failed) && failed.length > 0 ? `registry purge incomplete: ${failed.length} repositories left` : null;
      },
    }),
  },
  // ---- user.erased ----
  // GDPR: scrub the person out of the listing reviews they wrote (the rating stays).
  { kind: 'user.erased', service: 'plugin', deliver: viaContract(() => config.plugin, PLUGIN_INTERNAL.eraseUser, 'userId') },
];

/** The legs a cascade of `kind` fans out to. */
export function legsFor(kind: CascadeKind): CascadeLeg[] {
  return CASCADE_LEGS.filter((l) => l.kind === kind);
}

/** The leg for one outbox row, if it is still registered. */
export function findLeg(kind: CascadeKind, service: string): CascadeLeg | undefined {
  return CASCADE_LEGS.find((l) => l.kind === kind && l.service === service);
}
