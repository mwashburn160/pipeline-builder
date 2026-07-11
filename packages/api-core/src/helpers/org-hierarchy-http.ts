// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Org → team hierarchy lookups over HTTP against the platform service.
 *
 * The Mongoose-based traversal in {@link ./org-hierarchy} is for services that
 * own the org table (platform, quota). Everyone else reads the hierarchy over
 * the wire from platform's authoritative `/organization/:id/*` endpoints. This
 * module centralizes the transport for those reads — URL construction, the
 * signed service-token auth header, and timeout+retry via the shared
 * {@link InternalHttpClient} — so compliance, reporting, and any future caller
 * share ONE mechanism instead of each hand-rolling a `fetch`/client with its
 * own auth and failure semantics.
 *
 * These functions deliberately do NOT swallow transport errors: a connection
 * failure/timeout propagates so each caller keeps its own fallback policy (log
 * level, degrade-to-self vs. return-undefined). A non-2xx response is treated
 * as "no data" (returns undefined), matching what the callers previously did.
 */

import { getServiceAuthHeader } from '../middleware/auth.js';
import { InternalHttpClient } from '../services/http-client.js';
import type { ServiceConfig } from '../types/common.js';

/** Options shared by the platform org-hierarchy HTTP lookups. */
export interface OrgHierarchyHttpOptions {
  /** Platform service host/port (+ optional default timeout) for the client. */
  service: ServiceConfig;
  /** Service name minted into the service-auth JWT `sub` (e.g. 'compliance'). */
  serviceName: string;
  /**
   * Org id embedded in the signed service token's org context. Defaults to the
   * queried `orgId`; pass a system org id for a system-scoped lookup.
   */
  authOrgId?: string;
  /** Role carried by the service token (default 'member' — least privilege). */
  role?: 'owner' | 'admin' | 'member';
  /** Extra request headers merged after `Authorization` (e.g. `x-org-id`). */
  headers?: Record<string, string>;
  /** Per-request timeout override in ms (falls back to the client default). */
  timeout?: number;
}

function buildRequest(
  orgId: string,
  suffix: 'parent' | 'descendants',
  opts: OrgHierarchyHttpOptions,
): { client: InternalHttpClient; path: string; headers: Record<string, string> } {
  const client = new InternalHttpClient(opts.service);
  const path = `/organization/${encodeURIComponent(orgId)}/${suffix}`;
  const headers: Record<string, string> = {
    Authorization: getServiceAuthHeader({
      serviceName: opts.serviceName,
      orgId: opts.authOrgId ?? orgId,
      role: opts.role ?? 'member',
    }),
    ...opts.headers,
  };
  return { client, path, headers };
}

/**
 * Resolve an org's direct parent id via platform's
 * `GET /organization/:id/parent`. Returns `undefined` for a root org or a
 * non-2xx response. Throws on a transport failure (connection/timeout) so the
 * caller can apply its own fallback.
 */
export async function fetchParentOrgId(orgId: string, opts: OrgHierarchyHttpOptions): Promise<string | undefined> {
  const { client, path, headers } = buildRequest(orgId, 'parent', opts);
  const res = await client.get<{ data?: { parentOrgId?: string | null } }>(path, { headers, timeout: opts.timeout });
  if (res.statusCode >= 400) return undefined;
  return res.body?.data?.parentOrgId ?? undefined;
}

/**
 * Resolve `[self, ...descendantOrgIds]` for an org via platform's
 * `GET /organization/:id/descendants`. Returns the id list only when it is
 * larger than the org itself (a real subtree), else `undefined`; also
 * `undefined` on a non-2xx response. Throws on a transport failure so the
 * caller can apply its own fallback.
 */
export async function fetchOrgDescendants(orgId: string, opts: OrgHierarchyHttpOptions): Promise<string[] | undefined> {
  const { client, path, headers } = buildRequest(orgId, 'descendants', opts);
  const res = await client.get<{ data?: { orgIds?: unknown } }>(path, { headers, timeout: opts.timeout });
  if (res.statusCode >= 400) return undefined;
  const ids = res.body?.data?.orgIds;
  // Only meaningful when the subtree is larger than the org itself.
  return Array.isArray(ids) && ids.length > 1 ? (ids as string[]) : undefined;
}
