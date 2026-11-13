// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The org toolchain DEFAULT (docs/plans/bootstrap-image-versioning.md §5,
 * Phase 4, D7, D13, D15): which managed toolchain release the caller org's
 * UNPINNED pipelines (and its teams that set none) synthesize with.
 *
 * - **Reads of eligibility and the effective release are ELEVATED**, through
 *   pipeline-data's resolver (`readOrgToolchainOverview`, `listEligibleReleases`,
 *   `isEligibleRelease`): the release tables are system-org only under RLS. They
 *   answer for the caller's own chain and nothing else.
 * - **Writes run in the org's OWN tenant context** — `runWithTenantContext({
 *   orgId, isSuperAdmin: false })`, never elevated — so `org_toolchain_default`'s
 *   own-org RLS is what stops a write landing on any other org, whatever the
 *   caller's flags. History is append-only (a clear is a row with a NULL release).
 * - Every org acts on ITSELF: a team sets the team's own default; inheritance is
 *   reported (`inheritedFrom`), never written.
 *
 * Authorization (`toolchain:manage` + `requireStepUp` on writes,
 * `pipelines:read` on reads) is the route's (routes/org-toolchain-default.ts).
 */

import {
  AppError, ErrorCode, compareSemver, getStatusForErrorCode, isoOrNull, lastScannedAt, recordAudit,
  toolchainFromMetadata, type PluginScanSummary, type PluginToolchain,
} from '@pipeline-builder/api-core';
import {
  isEligibleRelease, listEligibleReleases, readOrgToolchainOverview, runWithTenantContext, schema, withTenantTx,
  type EligibleToolchainRelease, type ManagedToolchainWarning, type ToolchainResolvedVia,
} from '@pipeline-builder/pipeline-data';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';

import type { Plugin } from './plugin-service.js';

/** Who is acting, and on which org (always their own). */
export interface OrgToolchainCaller {
  orgId: string;
  userId: string;
}

/** The org's own default row, as the panel shows it. */
export interface OrgDefaultView {
  releaseVersion: string;
  setBy: string;
  setAt: string;
  reason: string | null;
}

/** `GET /plugins/toolchain/org-default`. */
export interface OrgToolchainPanel {
  effective: { releaseVersion: string; resolvedVia: ToolchainResolvedVia };
  orgDefault: OrgDefaultView | null;
  /** The ancestor org whose default applies, when the org set none of its own. */
  inheritedFrom: string | null;
  canary: { member: boolean; releaseVersion: string | null; effective: boolean };
  platformDefault: string | null;
  counts: { pipelines: number; pinned: number; behind: number };
}

/** One row of `GET /plugins/toolchain/org-default/history`. */
export interface OrgDefaultHistoryEntry {
  releaseVersion: string | null;
  setBy: string;
  setAt: string;
  reason: string | null;
}

/** Where a selectable release sits. */
export type EligibleReleaseStatus = 'default' | 'canary' | 'available' | 'deprecated' | 'yanked';
/** A selectable release relative to the platform default. */
export type EligibleReleaseRelation = 'newer' | 'older' | 'current';

/** One row of `GET /plugins/toolchain/eligible`. */
export interface EligibleReleaseView {
  releaseVersion: string;
  status: EligibleReleaseStatus;
  relation: EligibleReleaseRelation;
  toolchain: PluginToolchain;
  releaseNotes: string | null;
  scan: { scannedAt: string | null; criticalFixable: number; highFixable: number; kev: number };
}

type TenantTx = Parameters<Parameters<typeof withTenantTx>[0]>[0];

/** Run `fn` in a transaction scoped to `orgId` — own-org RLS, NOT elevated. */
function asOrg<T>(orgId: string, fn: (tx: TenantTx) => Promise<T>): Promise<T> {
  return runWithTenantContext({ orgId, isSuperAdmin: false }, () => withTenantTx(fn));
}

function viewOf(row: { releaseVersion: string; setBy: string; setAt: Date; reason: string | null }): OrgDefaultView {
  return { releaseVersion: row.releaseVersion, setBy: row.setBy, setAt: row.setAt.toISOString(), reason: row.reason ?? null };
}

/** The org's own default row (own-org read). */
async function readOwnDefault(tx: TenantTx, orgId: string): Promise<OrgDefaultView | null> {
  const [row] = await tx.select().from(schema.orgToolchainDefault).where(eq(schema.orgToolchainDefault.orgId, orgId));
  return row ? viewOf(row) : null;
}

/**
 * The org's pipelines, how many pin a release, and how many build on a release
 * OLDER than the platform default (a pin older than it, or — unpinned — when
 * the org's effective release is older). Own-org read.
 */
async function pipelineCounts(orgId: string, effective: string, platformDefault: string | null): Promise<OrgToolchainPanel['counts']> {
  const rows = await asOrg(orgId, (tx) => tx
    .select({ release: sql<string | null>`${schema.pipeline.props}->'toolchain'->>'release'`, n: sql<number>`count(*)::int` })
    .from(schema.pipeline)
    .where(and(eq(schema.pipeline.orgId, orgId), isNull(schema.pipeline.deletedAt)))
    .groupBy(sql`1`)) as Array<{ release: string | null; n: number }>;
  const older = (v: string) => platformDefault !== null && compareSemver(v, platformDefault) < 0;
  let pipelines = 0;
  let pinned = 0;
  let behind = 0;
  for (const r of rows) {
    const n = Number(r.n);
    pipelines += n;
    if (r.release) {
      pinned += n;
      if (older(r.release)) behind += n;
    } else if (older(effective)) {
      behind += n;
    }
  }
  return { pipelines, pinned, behind };
}

/** `GET /plugins/toolchain/org-default` — the caller org's panel. */
export async function getOrgToolchainPanel(caller: OrgToolchainCaller): Promise<OrgToolchainPanel> {
  const overview = await readOrgToolchainOverview(caller.orgId);
  const orgDefault = await asOrg(caller.orgId, (tx) => readOwnDefault(tx, caller.orgId));
  return {
    effective: { releaseVersion: overview.effective.releaseVersion, resolvedVia: overview.effective.resolvedVia },
    orgDefault,
    inheritedFrom: orgDefault ? null : overview.inheritedFrom?.orgId ?? null,
    canary: {
      member: overview.canaryRelease !== null,
      releaseVersion: overview.canaryRelease,
      effective: overview.effective.resolvedVia === 'canary',
    },
    platformDefault: overview.platformDefault,
    counts: await pipelineCounts(caller.orgId, overview.effective.releaseVersion, overview.platformDefault),
  };
}

/** `GET /plugins/toolchain/org-default/history` — the org's own changes, newest first. */
export async function getOrgToolchainHistory(caller: OrgToolchainCaller, limit = 100): Promise<{ history: OrgDefaultHistoryEntry[] }> {
  const rows = await asOrg(caller.orgId, (tx) => tx.select().from(schema.orgToolchainDefaultHistory)
    .where(eq(schema.orgToolchainDefaultHistory.orgId, caller.orgId))
    .orderBy(desc(schema.orgToolchainDefaultHistory.setAt), desc(schema.orgToolchainDefaultHistory.id))
    .limit(limit));
  return {
    history: rows.map((r) => ({ releaseVersion: r.releaseVersion ?? null, setBy: r.setBy, setAt: r.setAt.toISOString(), reason: r.reason ?? null })),
  };
}

// -- Eligible releases -------------------------------------------------------

function scanOf(halves: readonly Plugin[]): EligibleReleaseView['scan'] {
  const scanned = halves.map((p) => lastScannedAt(p));
  // A release is scanned only when BOTH halves are; then it is as old as the older scan.
  const scannedAt = scanned.some((d) => d === null)
    ? null
    : new Date(Math.min(...scanned.map((d) => d!.getTime())));
  let criticalFixable = 0;
  let highFixable = 0;
  let kev = 0;
  for (const p of halves) {
    const s = p.scanSummary as PluginScanSummary | null;
    criticalFixable += s?.criticalFixable ?? p.vulnCriticalFixable ?? 0;
    highFixable += s?.highFixable ?? p.vulnHighFixable ?? 0;
    kev += s?.kev ?? 0;
  }
  return { scannedAt: isoOrNull(scannedAt), criticalFixable, highFixable, kev };
}

function relationOf(releaseVersion: string, platformDefault: string | null): EligibleReleaseRelation {
  if (platformDefault === null) return 'newer';
  const c = compareSemver(releaseVersion, platformDefault);
  return c === 0 ? 'current' : c > 0 ? 'newer' : 'older';
}

function statusOf(r: EligibleToolchainRelease): EligibleReleaseStatus {
  if (r.isPlatformDefault) return 'default';
  if (r.isCanary) return 'canary';
  return 'available';
}

/** A release's selector row. Deprecated / yanked never reach here (D15 excludes them). */
export function eligibleReleaseView(r: EligibleToolchainRelease, platformDefault: string | null): EligibleReleaseView {
  return {
    releaseVersion: r.releaseVersion,
    status: statusOf(r),
    relation: relationOf(r.releaseVersion, platformDefault),
    // D15 guarantees both halves live; the §8 metadata guard ran on promotion.
    toolchain: toolchainFromMetadata(r.bootstrap.metadata) as PluginToolchain,
    releaseNotes: r.release.releaseNotes ?? null,
    scan: scanOf([r.bootstrap, r.synth]),
  };
}

/**
 * `GET /plugins/toolchain/eligible` — ONLY the releases the caller may pin or
 * set (D15), newest first: live, both halves, and either a former / current
 * platform default or the caller's OWN canary. Nothing about other orgs.
 */
export async function getEligibleToolchainReleases(caller: OrgToolchainCaller): Promise<{ platformDefault: string | null; releases: EligibleReleaseView[] }> {
  const { platformDefault, releases } = await listEligibleReleases(caller.orgId);
  return { platformDefault, releases: releases.map((r) => eligibleReleaseView(r, platformDefault)) };
}

// -- Writes (own tenant context) ---------------------------------------------

/** Warnings an eligible release still carries (a vulnerability found after promotion). */
function vulnerabilityWarnings(r: EligibleToolchainRelease | undefined): ManagedToolchainWarning[] {
  if (!r) return [];
  const scan = scanOf([r.bootstrap, r.synth]);
  const flagged = r.bootstrap.scanFlaggedAt !== null || r.synth.scanFlaggedAt !== null;
  if (!flagged && scan.criticalFixable === 0 && scan.kev === 0) return [];
  return [{
    code: 'TOOLCHAIN_RELEASE_VULNERABLE',
    severity: 'warning',
    message: `Toolchain release ${r.releaseVersion} has ${scan.criticalFixable} fixable Critical finding${scan.criticalFixable === 1 ? '' : 's'}`
      + `${scan.kev ? ` and ${scan.kev} on CISA KEV` : ''}, found after it was promoted. It is still eligible; move to a patched release when one is available.`,
  }];
}

function notEligible(releaseVersion: string): AppError {
  return new AppError(
    getStatusForErrorCode(ErrorCode.TOOLCHAIN_RELEASE_NOT_ELIGIBLE),
    ErrorCode.TOOLCHAIN_RELEASE_NOT_ELIGIBLE,
    `Toolchain release ${releaseVersion} is not eligible for your organization: it must be live (not yanked, deprecated or inactive), complete, and either a current or former platform default or your organization's canary. Choose one from GET /plugins/toolchain/eligible.`,
    { releaseVersion },
  );
}

function audit(caller: OrgToolchainCaller, action: 'toolchain.org_default.set' | 'toolchain.org_default.clear', details: Record<string, unknown>): void {
  recordAudit({
    action,
    actorId: caller.userId,
    orgId: caller.orgId,
    targetType: 'org-toolchain-default',
    targetId: caller.orgId,
    details,
  });
}

/**
 * `PUT /plugins/toolchain/org-default` — set the caller org's default to an
 * ELIGIBLE release (D15; else 400 TOOLCHAIN_RELEASE_NOT_ELIGIBLE). A
 * vulnerability found after promotion is a warning, not a refusal. Writes the
 * row and a history row in the org's own tenant context; audited
 * `toolchain.org_default.set` with `previousReleaseVersion`.
 */
export async function setOrgToolchainDefault(
  caller: OrgToolchainCaller,
  input: { releaseVersion: string; reason?: string | null },
): Promise<{ orgDefault: OrgDefaultView; previousReleaseVersion: string | null; warnings: ManagedToolchainWarning[] }> {
  const { releaseVersion } = input;
  const reason = input.reason?.trim() ? input.reason.trim() : null;
  if (!(await isEligibleRelease(caller.orgId, releaseVersion))) throw notEligible(releaseVersion);
  const eligible = (await listEligibleReleases(caller.orgId)).releases.find((r) => r.releaseVersion === releaseVersion);

  const { orgDefault, previous } = await asOrg(caller.orgId, async (tx) => {
    const [current] = await tx.select().from(schema.orgToolchainDefault)
      .where(eq(schema.orgToolchainDefault.orgId, caller.orgId)).for('update');
    const now = new Date();
    const [row] = await tx.insert(schema.orgToolchainDefault)
      .values({ orgId: caller.orgId, releaseVersion, setBy: caller.userId, setAt: now, reason })
      .onConflictDoUpdate({ target: schema.orgToolchainDefault.orgId, set: { releaseVersion, setBy: caller.userId, setAt: now, reason } })
      .returning();
    await tx.insert(schema.orgToolchainDefaultHistory).values({ orgId: caller.orgId, releaseVersion, setBy: caller.userId, setAt: now, reason });
    return { orgDefault: viewOf(row!), previous: current?.releaseVersion ?? null };
  });
  audit(caller, 'toolchain.org_default.set', { releaseVersion, previousReleaseVersion: previous, ...(reason ? { reason } : {}) });
  return { orgDefault, previousReleaseVersion: previous, warnings: vulnerabilityWarnings(eligible) };
}

/**
 * `DELETE /plugins/toolchain/org-default` — "Follow platform default": delete
 * the org's row and append a history row with a NULL release. Idempotent (a
 * clear with no row still records nothing new and answers the same). Audited
 * `toolchain.org_default.clear` with `previousReleaseVersion`.
 */
export async function clearOrgToolchainDefault(caller: OrgToolchainCaller, input: { reason?: string | null } = {}): Promise<{ previousReleaseVersion: string | null }> {
  const reason = input.reason?.trim() ? input.reason.trim() : null;
  const previous = await asOrg(caller.orgId, async (tx) => {
    const removed = await tx.delete(schema.orgToolchainDefault)
      .where(eq(schema.orgToolchainDefault.orgId, caller.orgId))
      .returning({ releaseVersion: schema.orgToolchainDefault.releaseVersion });
    const prev = removed[0]?.releaseVersion ?? null;
    if (prev !== null) {
      await tx.insert(schema.orgToolchainDefaultHistory).values({ orgId: caller.orgId, releaseVersion: null, setBy: caller.userId, setAt: new Date(), reason });
    }
    return prev;
  });
  audit(caller, 'toolchain.org_default.clear', { releaseVersion: null, previousReleaseVersion: previous, ...(reason ? { reason } : {}) });
  return { previousReleaseVersion: previous };
}
