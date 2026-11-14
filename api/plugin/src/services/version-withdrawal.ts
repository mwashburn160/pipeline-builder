// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * What a WITHDRAWAL that does not refuse tells the people it affects.
 *
 * Deleting or purging a version a pipeline references is refused outright
 * (`PluginService.assertRemovable`). Everything short of removal — deactivating
 * an org version, yanking it, deleting an UNreferenced one (a force-deleted
 * listed source included), uninstalling a listing, suspending a listing or a
 * publisher — lands, because none of it deletes an image a pipeline pulls. It
 * still changes what those pipelines' next synth resolves to, so:
 *
 *  - {@link withdrawalImpact} — the pipelines that reference the withdrawn
 *    version(s) (pipeline-data `findVersionReferences`: declared, deployed, open
 *    deployed exposure), as an in-use WARNING the response carries, never a
 *    refusal. The caller sees its own org's pipelines by name and other orgs'
 *    only as counts.
 *  - {@link notifyWithdrawal} — each affected org's approvers hear it (N14, the
 *    deprecation notice's channel and recipients), listing the org's OWN
 *    affected pipelines and nothing about any other org.
 *  - {@link onVersionWithdrawn} — an org version's deactivate / yank / delete:
 *    the orgs `findOrgsUsingVersion` names (configs, deployed manifests,
 *    listing installers) plus every referencing org.
 *
 * All of it is best-effort: a failure is logged, never thrown into the action.
 */

import { createLogger, errorMessage, type EcosystemRecipientSpec } from '@pipeline-builder/api-core';
import { incCounter } from '@pipeline-builder/api-server';
import { distinctPipelines, findVersionReferences, runWithTenantContext, type VersionReferenceTarget } from '@pipeline-builder/pipeline-data';

import { enqueueEcosystemNotification } from './ecosystem-notifications.js';
import { pluginService } from './plugin-service.js';

const logger = createLogger('plugin-version-withdrawal');

/** Recipient rules per relay request (the relay caps a request at 50). */
const RECIPIENT_CHUNK = 50;
/** Own-org pipelines a warning or notice names (the rest are counted). */
const MAX_NAMED = 50;

/**
 * Every way a version is withdrawn, keyed by kind: what happened to it, and
 * what a pipeline on it meets at its next synth.
 */
const WITHDRAWALS = {
  deactivated: { what: 'was deactivated', next: 'A range or the default no longer resolves to it; an exact pin still does.' },
  yanked: { what: 'was yanked', next: 'A range, `latest` and the default skip it; an exact pin still resolves, with a warning.' },
  deleted: { what: 'was deleted', next: 'It no longer resolves at all.' },
  uninstalled: { what: 'was uninstalled', next: 'The organization can no longer resolve the listing until it is installed again.' },
  listing_suspended: { what: 'was suspended by the system org', next: 'The listing no longer resolves for new synths until the suspension is lifted.' },
  publisher_suspended: { what: 'belongs to a publisher the system org suspended', next: 'Its listings are hidden and re-signed with the lowest trust.' },
} as const satisfies Record<string, { what: string; next: string }>;

/** What happened to the version(s). */
export type WithdrawalKind = keyof typeof WITHDRAWALS;

/** One affected pipeline. */
export interface AffectedPipeline {
  pipelineId: string;
  pipelineName: string | null;
  orgId: string;
  steps: string[];
}

/** The in-use warning a non-refusing withdrawal answers with. */
export interface InUseWarning {
  code: 'PLUGIN_VERSION_IN_USE';
  severity: 'warning';
  message: string;
  pipelineCount: number;
  orgCount: number;
  /** The caller org's own affected pipelines (other orgs' are counts only). */
  pipelines: Array<{ id: string; name: string | null; steps: string[] }>;
}

/**
 * The pipelines referencing any of `targets` (elevated: every org counts), and
 * the warning for a caller in `viewerOrgId` — null when nothing references them.
 * An unanswerable reference read yields no warning (the action already landed).
 */
export async function withdrawalImpact(
  targets: readonly VersionReferenceTarget[],
  opts: { viewerOrgId: string; label: string; kind: WithdrawalKind; onlyViewerOrg?: boolean },
): Promise<{ affected: AffectedPipeline[]; warning: InUseWarning | null }> {
  let affected: AffectedPipeline[];
  try {
    const refs = (await runWithTenantContext({ isSuperAdmin: true }, () => Promise.all(targets.map((t) => findVersionReferences(t))))).flat();
    affected = distinctPipelines(refs).map((p) => ({ pipelineId: p.pipelineId, pipelineName: p.pipelineName, orgId: p.orgId.toLowerCase(), steps: p.steps }));
    // An org-local withdrawal (an uninstall) affects only that org's pipelines.
    if (opts.onlyViewerOrg) affected = affected.filter((p) => p.orgId === opts.viewerOrgId.toLowerCase());
  } catch (err) {
    logger.warn('Withdrawal impact not computed', { label: opts.label, error: errorMessage(err) });
    return { affected: [], warning: null };
  }
  if (affected.length === 0) return { affected, warning: null };
  const viewer = opts.viewerOrgId.toLowerCase();
  const own = affected.filter((p) => p.orgId === viewer);
  const orgCount = new Set(affected.map((p) => p.orgId)).size;
  const n = affected.length;
  return {
    affected,
    warning: {
      code: 'PLUGIN_VERSION_IN_USE',
      severity: 'warning',
      message: `${opts.label} ${WITHDRAWALS[opts.kind].what} while ${n} pipeline${n === 1 ? '' : 's'}${orgCount > 1 ? ` in ${orgCount} organizations` : ''} reference${n === 1 ? 's' : ''} it. `
        + `${WITHDRAWALS[opts.kind].next} Nothing was deleted: deployed pipelines keep pulling their pinned image, and their owners have been notified.`,
      pipelineCount: n,
      orgCount,
      pipelines: own.slice(0, MAX_NAMED).map((p) => ({ id: p.pipelineId, name: p.pipelineName, steps: p.steps })),
    },
  };
}

/** The notice one org's approvers get: only that org's own pipelines. */
export function renderWithdrawalNotice(
  label: string,
  kind: WithdrawalKind,
  pipelines: readonly AffectedPipeline[],
  reason?: string | null,
): { subject: string; text: string } {
  const named = pipelines.slice(0, MAX_NAMED).map((p) => `  • pipeline ${p.pipelineName ?? p.pipelineId}${p.steps.length ? ` (${p.steps.join(', ')})` : ''}`);
  const more = pipelines.length > MAX_NAMED ? [`  … and ${pipelines.length - MAX_NAMED} more`] : [];
  return {
    subject: `Plugin ${label} ${WITHDRAWALS[kind].what}`,
    text: [
      `Plugin ${label}, used by pipelines in your organization, ${WITHDRAWALS[kind].what}.`,
      ...(reason?.trim() ? [`Reason: ${reason.trim()}`] : []),
      WITHDRAWALS[kind].next,
      ...(named.length ? [`Your pipelines on it:\n${[...named, ...more].join('\n')}`] : []),
      'Move them to a supported version, then re-synth.',
    ].join('\n\n'),
  };
}

/**
 * Tell each org in `orgIds` (plus every org owning an `affected` pipeline) that
 * `label` was withdrawn — N14 to its approvers (`plugin_installs:manage`,
 * falling back to the root org), each notice naming only that org's pipelines.
 * Never throws.
 */
export async function notifyWithdrawal(input: {
  label: string;
  kind: WithdrawalKind;
  affected: readonly AffectedPipeline[];
  orgIds?: readonly string[];
  reason?: string | null;
}): Promise<number> {
  try {
    const byOrg = new Map<string, AffectedPipeline[]>();
    for (const o of input.orgIds ?? []) byOrg.set(o.toLowerCase(), []);
    for (const p of input.affected) byOrg.set(p.orgId, [...(byOrg.get(p.orgId) ?? []), p]);
    if (byOrg.size === 0) return 0;
    // Orgs without named pipelines share one notice; each org with pipelines gets its own.
    const bare = [...byOrg].filter(([, ps]) => ps.length === 0).map(([o]) => o);
    for (let i = 0; i < bare.length; i += RECIPIENT_CHUNK) {
      await enqueueEcosystemNotification('N14', bare.slice(i, i + RECIPIENT_CHUNK).map(recipientOf), renderWithdrawalNotice(input.label, input.kind, [], input.reason));
    }
    for (const [orgId, ps] of byOrg) {
      if (ps.length > 0) await enqueueEcosystemNotification('N14', [recipientOf(orgId)], renderWithdrawalNotice(input.label, input.kind, ps, input.reason));
    }
    incCounter('plugin_withdrawal_notices_total', { kind: input.kind });
    return byOrg.size;
  } catch (err) {
    incCounter('plugin_withdrawal_notice_failures_total', { kind: input.kind });
    logger.warn('Withdrawal notice failed', { label: input.label, kind: input.kind, error: errorMessage(err) });
    return 0;
  }
}

function recipientOf(orgId: string): EcosystemRecipientSpec {
  return { kind: 'org_permission', orgId, permission: 'plugin_installs:manage', inheritFromRoot: true };
}

/** The reference targets of a listing's versions (matched by digest when published with one). */
export function listingTargets(
  publisherHandle: string,
  listingName: string,
  versions: ReadonlyArray<{ version: string; imageDigest?: string | null }>,
): VersionReferenceTarget[] {
  return versions.map((v) => ({ pluginName: listingName, pluginVersion: v.version, imageDigest: v.imageDigest ?? null, publisher: publisherHandle }));
}

/** The org version fields {@link onVersionWithdrawn} reads. */
export interface WithdrawnVersion {
  id: string;
  orgId: string;
  name: string;
  version: string;
  isDefault: boolean;
  visibility: string | null;
  imageDigest?: string | null;
  buildType?: string | null;
}

/**
 * An org version was deactivated, yanked or deleted: notify the orgs that use it
 * (`findOrgsUsingVersion` — configs, deployed manifests, listing installers —
 * plus every pipeline `findVersionReferences` names), and return the in-use
 * warning for the acting org. Never throws.
 */
export async function onVersionWithdrawn(
  plugin: WithdrawnVersion,
  kind: Extract<WithdrawalKind, 'deactivated' | 'yanked' | 'deleted'>,
  opts: { reason?: string | null } = {},
): Promise<InUseWarning | null> {
  const label = `${plugin.name}@${plugin.version}`;
  const { affected, warning } = await withdrawalImpact(
    [{ pluginName: plugin.name, pluginVersion: plugin.version, imageDigest: plugin.imageDigest ?? null, ownerOrgId: plugin.orgId }],
    { viewerOrgId: plugin.orgId, label, kind },
  );
  let orgIds: string[] = [];
  try {
    orgIds = await pluginService.findOrgsUsingVersion(plugin);
  } catch (err) {
    logger.warn('Orgs using a withdrawn version not read', { label, error: errorMessage(err) });
  }
  void notifyWithdrawal({ label, kind, affected, orgIds, reason: opts.reason ?? null });
  return warning;
}
