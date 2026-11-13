// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Managed toolchain HYGIENE notices (docs/plans/bootstrap-image-versioning.md
 * §10, Phase 4) — N34, through the ecosystem notification path the
 * version-withdrawal and plugin-security notices use:
 *
 *  - **yanked** — every org whose OWN default is the release hears it (its
 *    `toolchain:manage` holders, a team falling back to its root's, then the
 *    owners), and every org with pipelines PINNED to it hears it too (its
 *    pipeline writers), naming only that org's own pipelines;
 *  - **deprecated** — orgs whose default is the release;
 *  - **vulnerable** — the release picked up a KEV-listed or fixable Critical
 *    finding at a rescan: orgs whose default is the release;
 *  - **behind** — a platform-default change left an org's default MORE than
 *    {@link TOOLCHAIN_BEHIND_THRESHOLD} promoted releases behind. Sent once, on
 *    the change that crosses the threshold, not on every later promotion.
 *
 * "Releases behind" counts PROMOTED releases (ever the platform default) newer
 * than the org's and no newer than the platform default: patch releases are
 * cut automatically on any digest change, so counting every registered release
 * would cry wolf.
 *
 * Reads are elevated (the defaults and pins of every org). Each notice names
 * only the receiving org's own pipelines and never another org. Best-effort: a
 * failure is logged and counted (`toolchain_hygiene_notice_failures_total`,
 * alerted with the other security notices), never thrown into the action.
 */

import { compareSemver, createLogger, errorMessage, type EcosystemRecipientSpec } from '@pipeline-builder/api-core';
import { incCounter } from '@pipeline-builder/api-server';
import { runWithTenantContext, schema, withTenantTx } from '@pipeline-builder/pipeline-data';
import { and, eq, isNull, sql } from 'drizzle-orm';

import { enqueueEcosystemNotification } from './ecosystem-notifications.js';

const logger = createLogger('toolchain-hygiene');

/** K: an org default more than this many promoted releases behind the platform default is notified. */
export const TOOLCHAIN_BEHIND_THRESHOLD = 3;
/** Recipient rules per relay request (the relay caps a request at 50). */
const RECIPIENT_CHUNK = 50;
/** Pipelines a notice names (the rest are counted). */
const MAX_NAMED = 50;

/** What happened. */
export type ToolchainHygieneEvent =
  | { kind: 'yanked'; releaseVersion: string; reason?: string | null }
  | { kind: 'deprecated'; releaseVersion: string; message?: string | null }
  | { kind: 'vulnerable'; releaseVersion: string; plugin: string; criticalFixable: number; kev: number }
  | { kind: 'behind'; platformDefault: string; previousDefault: string | null };

export type ToolchainHygieneKind = ToolchainHygieneEvent['kind'];

/** How many orgs were told, by audience. */
export interface ToolchainHygieneResult {
  orgDefaultOrgs: number;
  pinnedOrgs: number;
}

interface PinnedPipeline { id: string; name: string | null; orgId: string }

type Tx = Parameters<Parameters<typeof withTenantTx>[0]>[0];

function elevatedRead<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  return runWithTenantContext({ isSuperAdmin: true }, () => withTenantTx(fn));
}

async function orgDefaultsOn(tx: Tx, releaseVersion: string): Promise<string[]> {
  const rows = await tx.select({ orgId: schema.orgToolchainDefault.orgId }).from(schema.orgToolchainDefault)
    .where(eq(schema.orgToolchainDefault.releaseVersion, releaseVersion));
  return rows.map((r) => r.orgId);
}

async function pipelinesPinnedTo(tx: Tx, releaseVersion: string): Promise<PinnedPipeline[]> {
  const rows = await tx.select({ id: schema.pipeline.id, name: schema.pipeline.pipelineName, orgId: schema.pipeline.orgId })
    .from(schema.pipeline)
    .where(and(isNull(schema.pipeline.deletedAt), sql`${schema.pipeline.props}->'toolchain'->>'release' = ${releaseVersion}`));
  return rows.map((r) => ({ id: String(r.id), name: r.name ?? null, orgId: r.orgId }));
}

async function platformDefaultOf(tx: Tx): Promise<string | null> {
  const [row] = await tx.select({ releaseVersion: schema.toolchainPlatformDefault.releaseVersion }).from(schema.toolchainPlatformDefault).limit(1);
  return row?.releaseVersion ?? null;
}

/** Promoted releases (ever the platform default) in `(from, to]`. */
export function releasesBehind(from: string, to: string, promoted: Iterable<string>): number {
  let n = 0;
  for (const p of new Set(promoted)) {
    if (compareSemver(p, from) > 0 && compareSemver(p, to) <= 0) n += 1;
  }
  return n;
}

/** Orgs whose default the change to `platformDefault` pushed past K (and not already past it at `previousDefault`). */
async function orgsNewlyBehind(tx: Tx, platformDefault: string, previousDefault: string | null): Promise<Array<{ orgId: string; releaseVersion: string; behind: number }>> {
  const [defaults, history] = await Promise.all([
    tx.select({ orgId: schema.orgToolchainDefault.orgId, releaseVersion: schema.orgToolchainDefault.releaseVersion }).from(schema.orgToolchainDefault),
    tx.select({ releaseVersion: schema.toolchainDefaultHistory.releaseVersion }).from(schema.toolchainDefaultHistory),
  ]);
  const promoted = [...history.map((h) => h.releaseVersion), platformDefault];
  const out: Array<{ orgId: string; releaseVersion: string; behind: number }> = [];
  for (const d of defaults) {
    const now = releasesBehind(d.releaseVersion, platformDefault, promoted);
    if (now <= TOOLCHAIN_BEHIND_THRESHOLD) continue;
    const before = previousDefault === null ? 0 : releasesBehind(d.releaseVersion, previousDefault, promoted);
    if (before > TOOLCHAIN_BEHIND_THRESHOLD) continue;
    out.push({ orgId: d.orgId, releaseVersion: d.releaseVersion, behind: now });
  }
  return out;
}

// -- Rendering ---------------------------------------------------------------

const FIX_DEFAULT = (platformDefault: string | null) =>
  `Choose an eligible release, or follow the platform default${platformDefault ? ` (currently ${platformDefault})` : ''}, under Settings → Organization → Pipeline toolchain.`;

/** The notice an org's `toolchain:manage` holders get about their OWN default. */
export function renderOrgDefaultNotice(event: ToolchainHygieneEvent, ctx: { releaseVersion: string; platformDefault: string | null; behind?: number }): { subject: string; text: string } {
  const v = ctx.releaseVersion;
  switch (event.kind) {
    case 'yanked':
      return {
        subject: `Your organization's toolchain default ${v} was yanked`,
        text: [
          `Your organization's pipeline toolchain default is release ${v}, which was yanked${event.reason?.trim() ? `: ${event.reason.trim()}` : '.'}`,
          'Your unpinned pipelines keep building on it, with a warning, until the default changes.',
          FIX_DEFAULT(ctx.platformDefault),
        ].join('\n\n'),
      };
    case 'deprecated':
      return {
        subject: `Your organization's toolchain default ${v} was deprecated`,
        text: [
          `Your organization's pipeline toolchain default is release ${v}, which was deprecated${event.message?.trim() ? `: ${event.message.trim()}` : '.'}`,
          'It keeps resolving, but it can no longer be chosen as a new default or pin.',
          FIX_DEFAULT(ctx.platformDefault),
        ].join('\n\n'),
      };
    case 'vulnerable':
      return {
        subject: `Your organization's toolchain default ${v} has a new security finding`,
        text: [
          `A rescan of ${event.plugin}@${v} — part of your organization's pipeline toolchain default — found`
            + ` ${event.criticalFixable} fixable Critical finding${event.criticalFixable === 1 ? '' : 's'}${event.kev ? ` and ${event.kev} on the CISA known-exploited list` : ''}.`,
          'Your pipelines keep building on it; vulnerability state never stops a pipeline.',
          FIX_DEFAULT(ctx.platformDefault),
        ].join('\n\n'),
      };
    case 'behind':
      return {
        subject: `Your organization's toolchain default ${v} is ${ctx.behind} releases behind`,
        text: [
          `Your organization's pipeline toolchain default (${v}) is now ${ctx.behind} releases behind the platform default (${event.platformDefault}).`,
          'Older releases stop receiving fixes; your unpinned pipelines build on it until the default changes.',
          FIX_DEFAULT(event.platformDefault),
        ].join('\n\n'),
      };
  }
}

/** The notice an org's pipeline writers get about pipelines PINNED to a yanked release: only that org's pipelines. */
export function renderPinnedNotice(releaseVersion: string, reason: string | null | undefined, pipelines: readonly PinnedPipeline[]): { subject: string; text: string } {
  const named = pipelines.slice(0, MAX_NAMED).map((p) => `  • pipeline ${p.name ?? p.id}`);
  const more = pipelines.length > MAX_NAMED ? [`  … and ${pipelines.length - MAX_NAMED} more`] : [];
  return {
    subject: `Toolchain release ${releaseVersion}, pinned by your pipelines, was yanked`,
    text: [
      `Toolchain release ${releaseVersion}, which pipelines in your organization pin with toolchain.release, was yanked${reason?.trim() ? `: ${reason.trim()}` : '.'}`,
      'Pinned pipelines keep resolving it, with a warning.',
      `Your pipelines on it:\n${[...named, ...more].join('\n')}`,
      "Change each pipeline's toolchain.release to an eligible release, or remove it to follow your organization's default.",
    ].join('\n\n'),
  };
}

// -- Sending -----------------------------------------------------------------

const managers = (orgId: string): EcosystemRecipientSpec => ({ kind: 'org_permission', orgId, permission: 'toolchain:manage', inheritFromRoot: true });
const pipelineWriters = (orgId: string): EcosystemRecipientSpec => ({ kind: 'org_permission', orgId, permission: 'pipelines:write' });

async function sendToManagers(orgIds: readonly string[], content: { subject: string; text: string }): Promise<void> {
  for (let i = 0; i < orgIds.length; i += RECIPIENT_CHUNK) {
    await enqueueEcosystemNotification('N34', orgIds.slice(i, i + RECIPIENT_CHUNK).map(managers), content, { immediate: true });
  }
}

/**
 * Tell the orgs `event` concerns (see the module doc). Never throws; answers
 * how many orgs were told.
 */
export async function notifyToolchainHygiene(event: ToolchainHygieneEvent): Promise<ToolchainHygieneResult> {
  const result: ToolchainHygieneResult = { orgDefaultOrgs: 0, pinnedOrgs: 0 };
  try {
    if (event.kind === 'behind') {
      const behind = await elevatedRead((tx) => orgsNewlyBehind(tx, event.platformDefault, event.previousDefault));
      for (const b of behind) {
        await enqueueEcosystemNotification('N34', [managers(b.orgId)], renderOrgDefaultNotice(event, { releaseVersion: b.releaseVersion, platformDefault: event.platformDefault, behind: b.behind }), { immediate: true });
      }
      result.orgDefaultOrgs = behind.length;
    } else {
      const { orgIds, pinned, platformDefault } = await elevatedRead(async (tx) => ({
        orgIds: await orgDefaultsOn(tx, event.releaseVersion),
        pinned: event.kind === 'yanked' ? await pipelinesPinnedTo(tx, event.releaseVersion) : [],
        platformDefault: await platformDefaultOf(tx),
      }));
      // Every org default on one release gets the same text, so they share notices.
      if (orgIds.length > 0) await sendToManagers(orgIds, renderOrgDefaultNotice(event, { releaseVersion: event.releaseVersion, platformDefault }));
      result.orgDefaultOrgs = orgIds.length;
      if (event.kind === 'yanked') {
        const byOrg = new Map<string, PinnedPipeline[]>();
        for (const p of pinned) byOrg.set(p.orgId, [...(byOrg.get(p.orgId) ?? []), p]);
        for (const [orgId, ps] of byOrg) {
          await enqueueEcosystemNotification('N34', [pipelineWriters(orgId)], renderPinnedNotice(event.releaseVersion, event.reason, ps), { immediate: true });
        }
        result.pinnedOrgs = byOrg.size;
      }
    }
    if (result.orgDefaultOrgs + result.pinnedOrgs > 0) incCounter('toolchain_hygiene_notices_total', { kind: event.kind }, result.orgDefaultOrgs + result.pinnedOrgs);
    return result;
  } catch (err) {
    incCounter('toolchain_hygiene_notice_failures_total', { kind: event.kind });
    logger.warn('Toolchain hygiene notice failed', { kind: event.kind, error: errorMessage(err) });
    return result;
  }
}

// -----------------------------------------------------------------------------
// Console announcements (§9, §10, Phase 5): promotion, canary membership and
// the recovery hint. The SAME path as the hygiene notices — N34, immediate, the
// org's `toolchain:manage` holders (a team without any: its root's, then the
// owners), or its pipeline writers for the per-pipeline recovery hint — and the
// same counters (`toolchain_hygiene_notices_total{kind}` and the alerted
// `toolchain_hygiene_notice_failures_total{kind}`). WHO is told is decided by
// the caller (the Toolchain console service, which walks the org hierarchy);
// each notice names only the receiving org's own pipelines.
// -----------------------------------------------------------------------------

/** One affected pipeline, as the recovery hint names it. */
export interface RecoveryPipeline { id: string; name: string | null }

/** What the console announces. */
export type ToolchainAnnouncement =
  /** A promotion: orgs that FOLLOW the platform default move; orgs with their own default stay. */
  | { kind: 'promoted'; releaseVersion: string; followingOrgIds: readonly string[]; ownDefaults: ReadonlyArray<{ orgId: string; releaseVersion: string }> }
  /** Orgs added to (or moved into) a release's canary. */
  | { kind: 'canary'; releaseVersion: string; orgs: ReadonlyArray<{ orgId: string; hasOrgDefault: boolean }> }
  /** Pipelines on `releaseVersion` whose latest synth failed: how to re-deploy each. */
  | { kind: 'recovery'; releaseVersion: string; orgs: ReadonlyArray<{ orgId: string; pipelines: readonly RecoveryPipeline[] }> };

/** How many orgs (and, for recovery, pipelines) a notice reached. */
export interface ToolchainAnnouncementResult { orgs: number; pipelines: number }

export function renderFollowingNotice(releaseVersion: string): { subject: string; text: string } {
  return {
    subject: `Pipeline toolchain is updating to ${releaseVersion}`,
    text: [
      `Pipeline toolchain is updating to ${releaseVersion}, effective on each pipeline's next run.`,
      'Your organization follows the platform default, so its unpinned pipelines pick it up automatically; pipelines that pin toolchain.release stay on their pin.',
      'To stay on a release, choose it as your organization default under Settings → Organization → Pipeline toolchain.',
    ].join('\n\n'),
  };
}

export function renderNewerAvailableNotice(releaseVersion: string, orgDefault: string): { subject: string; text: string } {
  return {
    subject: `A newer platform toolchain (${releaseVersion}) is available`,
    text: [
      `A newer platform toolchain (${releaseVersion}) is available. Your org stays on ${orgDefault} until you change it.`,
      'Switch your organization default, or follow the platform default, under Settings → Organization → Pipeline toolchain.',
    ].join('\n\n'),
  };
}

export function renderCanaryNotice(releaseVersion: string, hasOrgDefault: boolean): { subject: string; text: string } {
  return {
    subject: `Your organization joined the canary for toolchain ${releaseVersion}`,
    text: [
      `Your organization was added to the canary for pipeline toolchain release ${releaseVersion}.`,
      hasOrgDefault
        ? 'It has no effect while your organization default is set: your pipelines stay on that default.'
        : 'Your unpinned pipelines build on it from their next run; pipelines that pin toolchain.release stay on their pin. Its run results count toward the release\'s promotion.',
    ].join('\n\n'),
  };
}

export function renderRecoveryNotice(releaseVersion: string, pipelines: readonly RecoveryPipeline[]): { subject: string; text: string } {
  const named = pipelines.slice(0, MAX_NAMED).map((p) => `  • ${p.name ?? p.id}:  pipeline-manager pipeline deploy --id ${p.id}`);
  const more = pipelines.length > MAX_NAMED ? [`  … and ${pipelines.length - MAX_NAMED} more (the console lists them)`] : [];
  return {
    subject: `Action needed: re-deploy pipelines whose synth failed on toolchain ${releaseVersion}`,
    text: [
      `The synth step of these pipelines last failed on pipeline toolchain release ${releaseVersion}. A pipeline whose synth fails cannot update itself, so it stays on that release until it is re-deployed.`,
      `Run this from a workstation for each one; it re-synthesizes against the current toolchain and deploys:\n${[...named, ...more].join('\n')}`,
      "See \"My pipeline's synth step fails after a toolchain update\" in the pipeline-manager guide.",
    ].join('\n\n'),
  };
}

function count(kind: string, n: number): void {
  if (n > 0) incCounter('toolchain_hygiene_notices_total', { kind }, n);
}

/**
 * Send a console announcement. Never throws: a failure is logged and counted
 * per org, and the result counts only the orgs (pipelines) actually reached.
 */
export async function announceToolchain(event: ToolchainAnnouncement): Promise<ToolchainAnnouncementResult> {
  const result: ToolchainAnnouncementResult = { orgs: 0, pipelines: 0 };
  const failed = (err: unknown, orgIds: readonly string[]) => {
    incCounter('toolchain_hygiene_notice_failures_total', { kind: event.kind });
    logger.warn('Toolchain announcement failed', { kind: event.kind, releaseVersion: event.releaseVersion, orgs: orgIds.length, error: errorMessage(err) });
  };
  const toManagers = async (orgIds: readonly string[], content: { subject: string; text: string }) => {
    for (let i = 0; i < orgIds.length; i += RECIPIENT_CHUNK) {
      const chunk = orgIds.slice(i, i + RECIPIENT_CHUNK);
      try {
        await enqueueEcosystemNotification('N34', chunk.map(managers), content, { immediate: true });
        result.orgs += chunk.length;
      } catch (err) { failed(err, chunk); }
    }
  };

  if (event.kind === 'promoted') {
    if (event.followingOrgIds.length > 0) await toManagers(event.followingOrgIds, renderFollowingNotice(event.releaseVersion));
    // Every org on the same own default gets the same text, so they share notices.
    const byRelease = new Map<string, string[]>();
    for (const d of event.ownDefaults) {
      if (d.releaseVersion === event.releaseVersion) continue;
      byRelease.set(d.releaseVersion, [...(byRelease.get(d.releaseVersion) ?? []), d.orgId]);
    }
    for (const [orgDefault, orgIds] of byRelease) await toManagers(orgIds, renderNewerAvailableNotice(event.releaseVersion, orgDefault));
  } else if (event.kind === 'canary') {
    for (const hasOrgDefault of [false, true]) {
      const orgIds = event.orgs.filter((o) => o.hasOrgDefault === hasOrgDefault).map((o) => o.orgId);
      if (orgIds.length > 0) await toManagers(orgIds, renderCanaryNotice(event.releaseVersion, hasOrgDefault));
    }
  } else {
    for (const org of event.orgs) {
      if (org.pipelines.length === 0) continue;
      try {
        await enqueueEcosystemNotification('N34', [pipelineWriters(org.orgId)], renderRecoveryNotice(event.releaseVersion, org.pipelines), { immediate: true });
        result.orgs += 1;
        result.pipelines += org.pipelines.length;
      } catch (err) { failed(err, [org.orgId]); }
    }
  }
  count(event.kind, result.orgs);
  return result;
}
