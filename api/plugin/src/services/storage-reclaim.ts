// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * What an organization's registry storage is spent on, and which of it can
 * actually be reclaimed.
 *
 * `storageBytes` is the only quota a tenant could not free. Scheduled GC is off
 * by default (`REGISTRY_GC_ENABLED`), manual GC needs `registry:purge`
 * (superadmin + aal2), and deleting a plugin version left its registry
 * manifests in place — so the only remedy an organization had was to buy
 * capacity or ask the operator. This module is the tenant-side remedy.
 *
 * It is a JOIN, and each half knows something the other cannot:
 *
 * - **image-registry** measures the bytes. Only it can compute what deleting
 *   one version would actually free, because that depends on which layers are
 *   shared (`/internal/storage-breakdown`).
 * - **this service** owns plugin versions and knows which ones a pipeline still
 *   references, which are published, and which are soft-deleted.
 *
 * Neither alone can answer "what may I safely delete, and what would it give
 * me back", which is why the surface lives here and the computation lives there.
 */

import { createLogger, errorMessage, getServiceAuthHeader, formatQuotaAmount, InternalHttpClient } from '@pipeline-builder/api-core';
import { Config } from '@pipeline-builder/pipeline-core';
import { distinctPipelines, findVersionReferences, runWithTenantContext, withTenantTx, schema, type VersionReferenceTarget } from '@pipeline-builder/pipeline-data';
import { and, eq, isNull } from 'drizzle-orm';

const logger = createLogger('storage-reclaim');

/** One version's storage facts, as the registry measured them. */
export interface BreakdownEntry {
  repo: string;
  tag: string;
  totalBytes: number;
  marginalBytes: number;
  published: boolean;
}

interface RegistryBreakdown {
  orgId: string;
  bytes: number;
  entries: BreakdownEntry[];
  computedAt: number;
  incomplete: boolean;
}

/** Why a version cannot be pruned. `null` means it can. */
export type IneligibleReason =
  /** A pipeline still references it. Update the pipeline first. */
  | 'in_use'
  /** A published copy: its bytes stay billed until the listing is withdrawn. */
  | 'published'
  /** Nothing in this service owns it — refuse rather than guess. */
  | 'unknown_version';

/** One row of the "what is using my storage" view. */
export interface ReclaimCandidate {
  repo: string;
  tag: string;
  /** The plugin row this version belongs to, when we own one. */
  pluginName: string | null;
  version: string | null;
  /** Bytes the version's layers occupy, SHARED ONES INCLUDED. */
  totalBytes: number;
  /**
   * Bytes that would come back if this version alone were removed. The only
   * figure safe to show beside a delete button — see the registry's
   * `StorageBreakdownEntry.marginalBytes`.
   */
  marginalBytes: number;
  /** Human form of {@link marginalBytes}, so every surface words it alike. */
  marginalLabel: string;
  eligible: boolean;
  /** Present when `eligible` is false. */
  reason: IneligibleReason | null;
  /** Pipelines blocking a prune (this org's own, named). */
  blockedBy: Array<{ id: string; name: string | null }>;
}

export interface ReclaimPlan {
  orgId: string;
  /** The org's measured total — the same figure the push gate enforces. */
  bytes: number;
  /** Sum of `marginalBytes` over ELIGIBLE candidates: what pruning could free. */
  reclaimableBytes: number;
  candidates: ReclaimCandidate[];
  /**
   * True when the registry could not measure everything. Both figures then
   * UNDER-state reality, so a surface must say the picture is partial rather
   * than present it as complete — a tenant is about to decide what to delete.
   */
  incomplete: boolean;
  computedAt: number;
}

const TIMEOUT_MS = 60_000;

type RegistryHttp = Pick<InternalHttpClient, 'get'> & Partial<Pick<InternalHttpClient, 'delete'>>;
let clientOverride: RegistryHttp | null = null;

/** Test hook: replace the HTTP client. */
export function setStorageRegistryClientForTests(c: RegistryHttp | null): void {
  clientOverride = c;
}

function client(): RegistryHttp {
  if (clientOverride) return clientOverride;
  const services = Config.get('server').services;
  return new InternalHttpClient({ host: services.imageRegistryHost, port: services.imageRegistryPort, timeout: TIMEOUT_MS });
}

/**
 * The call is made with a token for the TENANT's org, not the system org: the
 * registry's breakdown and prune routes refuse a token whose org differs from
 * the one being asked about, so a system-org token would be rejected — and
 * should be. The confinement is the point.
 */
const orgAuth = (orgId: string) => getServiceAuthHeader({ serviceName: 'plugin', orgId, role: 'member' });

/** The registry's per-version breakdown, or `null` when it cannot answer. */
async function fetchBreakdown(orgId: string): Promise<RegistryBreakdown | null> {
  try {
    const res = await client().get<{ data?: RegistryBreakdown }>(
      `/internal/storage-breakdown/${encodeURIComponent(orgId)}`,
      { headers: { Authorization: orgAuth(orgId) }, maxRetries: 0 },
    );
    if (res.statusCode < 200 || res.statusCode >= 300) {
      logger.warn('Registry refused the storage breakdown', { orgId, status: res.statusCode });
      return null;
    }
    return res.body?.data ?? null;
  } catch (err) {
    logger.warn('Registry unreachable for the storage breakdown', { orgId, error: errorMessage(err) });
    return null;
  }
}

/** The org's live (not soft-deleted) versions, keyed by their registry tag. */
async function ownedVersions(orgId: string): Promise<Map<string, { name: string; version: string; imageDigest: string | null }>> {
  const p = schema.plugin;
  const rows = await withTenantTx((tx) => tx
    .select({ name: p.name, version: p.version, imageDigest: p.imageDigest })
    .from(p)
    .where(and(eq(p.orgId, orgId), isNull(p.deletedAt))));
  // A version's registry tag IS its version string, so the tag is the join key.
  // Keyed by `name:version` because two plugins may carry the same version.
  return new Map(rows.map((r) => [`${r.name}:${r.version}`, { name: r.name, version: r.version, imageDigest: r.imageDigest ?? null }]));
}

/** `org-<id>/<plugin>` → `<plugin>`; null for anything outside the namespace. */
function pluginNameFromRepo(repo: string, orgId: string): string | null {
  const prefix = `org-${orgId.toLowerCase()}/`;
  return repo.toLowerCase().startsWith(prefix) ? repo.slice(prefix.length) : null;
}

/**
 * What an org's storage is spent on, and what it can reclaim.
 *
 * Returns `null` when the registry cannot answer: a reclaim surface must say
 * "we could not read your storage" rather than render an empty plan, which
 * would read as "nothing to free" — the opposite of the truth.
 */
export async function reclaimPlan(orgId: string): Promise<ReclaimPlan | null> {
  const breakdown = await fetchBreakdown(orgId);
  if (!breakdown) return null;

  const owned = await ownedVersions(orgId);

  // One reference read for the versions we own, elevated so a pipeline in a
  // TEAM of this account counts — a team's pipeline pinning the image is just
  // as much a reason not to delete it.
  const targets: VersionReferenceTarget[] = [...owned.values()].map((v) => ({
    pluginName: v.name, pluginVersion: v.version, imageDigest: v.imageDigest, ownerOrgId: orgId,
  }));
  const referenced = new Map<string, Array<{ id: string; name: string | null }>>();
  if (targets.length > 0) {
    try {
      const refs = await runWithTenantContext({ isSuperAdmin: true }, () =>
        Promise.all(targets.map(async (t) => ({ key: `${t.pluginName}:${t.pluginVersion}`, refs: await findVersionReferences(t) }))));
      for (const { key, refs: found } of refs) {
        const pipelines = distinctPipelines(found);
        if (pipelines.length > 0) referenced.set(key, pipelines.map((p) => ({ id: p.pipelineId, name: p.pipelineName })));
      }
    } catch (err) {
      // FAIL CLOSED on eligibility: if references cannot be read we must not
      // offer a prune, because the refusal is the safety rule that keeps a
      // deployed pipeline's image alive.
      logger.warn('Version references unreadable; every candidate is ineligible', { orgId, error: errorMessage(err) });
      for (const key of owned.keys()) referenced.set(key, []);
    }
  }

  const candidates: ReclaimCandidate[] = breakdown.entries.map((e) => {
    const pluginName = pluginNameFromRepo(e.repo, orgId);
    const key = pluginName ? `${pluginName}:${e.tag}` : null;
    const row = key ? owned.get(key) : undefined;
    const blockedBy = key ? referenced.get(key) ?? [] : [];
    const reason: IneligibleReason | null =
      e.published ? 'published'
        : !row ? 'unknown_version'
          : blockedBy.length > 0 || referenced.has(key!) ? 'in_use'
            : null;
    return {
      repo: e.repo,
      tag: e.tag,
      pluginName: row?.name ?? pluginName,
      version: row?.version ?? null,
      totalBytes: e.totalBytes,
      marginalBytes: e.marginalBytes,
      marginalLabel: formatQuotaAmount('storageBytes', e.marginalBytes),
      eligible: reason === null,
      reason,
      blockedBy,
    };
  });

  return {
    orgId,
    bytes: breakdown.bytes,
    // Only ELIGIBLE candidates count toward what pruning could free. Summing
    // every candidate would promise the shared and the published bytes too.
    reclaimableBytes: candidates.filter((c) => c.eligible).reduce((sum, c) => sum + c.marginalBytes, 0),
    candidates,
    incomplete: breakdown.incomplete,
    computedAt: breakdown.computedAt,
  };
}

/** The outcome of a prune attempt, for the route's response and its audit row. */
export interface PruneOutcome {
  pruned: boolean;
  repo: string;
  tag: string;
  /** Bytes the breakdown said this would free, recorded at decision time. */
  freedBytes: number;
  reason: IneligibleReason | 'registry_unavailable' | null;
}

/**
 * Drop one version's registry tag so its layers leave the org's storage total.
 *
 * Re-checks eligibility against a FRESH plan rather than trusting the caller:
 * the surface's figures may be a minute old, and in that minute a pipeline
 * could have started referencing the version. The check that matters is the one
 * at the moment of deletion.
 */
export async function pruneVersion(orgId: string, repo: string, tag: string): Promise<PruneOutcome> {
  const plan = await reclaimPlan(orgId);
  if (!plan) return { pruned: false, repo, tag, freedBytes: 0, reason: 'registry_unavailable' };
  const candidate = plan.candidates.find((c) => c.repo === repo && c.tag === tag);
  if (!candidate) return { pruned: false, repo, tag, freedBytes: 0, reason: 'unknown_version' };
  if (!candidate.eligible) return { pruned: false, repo, tag, freedBytes: 0, reason: candidate.reason };

  const c = client();
  if (!c.delete) throw new Error('image-registry client cannot delete');
  const res = await c.delete<{ data?: unknown }>(
    `/internal/storage-prune/${encodeURIComponent(orgId)}`,
    { headers: { Authorization: orgAuth(orgId) }, maxRetries: 0, body: { repo, tag } } as never,
  );
  if (res.statusCode < 200 || res.statusCode >= 300) {
    logger.warn('Registry refused the storage prune', { orgId, repo, tag, status: res.statusCode });
    return { pruned: false, repo, tag, freedBytes: 0, reason: 'registry_unavailable' };
  }
  logger.info('Pruned a version to reclaim storage', { orgId, repo, tag, freedBytes: candidate.marginalBytes });
  return { pruned: true, repo, tag, freedBytes: candidate.marginalBytes, reason: null };
}
