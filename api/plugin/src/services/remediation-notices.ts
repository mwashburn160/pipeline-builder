// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The nightly plugin CVE remediation notices (docs/plugin-publishing.md "Scan
 * gates"), sent through the ecosystem notification relay, in-app and email:
 *
 *  - **N36** a fixed version was published (or, in propose mode, is awaiting a
 *    plugins:write approval).
 *  - **N37** the rollout of a fix to pipelines finished or paused — or never
 *    started and is no longer retried (`startFailure`). Also to the
 *    pipeline writers of the orgs whose pipelines it moved or proposed to
 *    (each org's `notifyPipelineOwners`).
 *  - **N38** a pipeline was rolled back from a fix version (or could not be,
 *    because its previous version is gone), to that pipeline's org's pipeline
 *    writers (`notifyPipelineOwners`). Always immediate.
 *  - **N39** the remediation request to the owner: every finding the platform
 *    could not fix, with package, CVE, fixed version, why, and the upgrade
 *    level a fix would need.
 *  - **N40** a fix request to a third-party listing's publisher (the findings
 *    and their fixed versions), and, as a separate notice, its installers are
 *    told the request was sent. Always immediate.
 *
 * N36, N37 and N39 go to the org's plugin security recipients (the same rules
 * as N31: writers or the chosen members, plus the verified external address)
 * and honour the org's `digestMode`; the org's security webhook gets N36–N39
 * too. Every notice is deduplicated (the N31 dedupe store, failing open), so a
 * retried job or a redelivered rollout report notifies nobody twice.
 *
 * Content carries names, versions, advisory ids, package names and counts.
 * Never a source file, never a build log; the N40 patch is the diff the
 * platform suggests (manifest / Dockerfile lines), capped.
 *
 * Nothing is sent while the operator knob `PLUGIN_REMEDIATION_ENABLED` is off.
 * A notice never fails the job that caused it: this module catches, logs and
 * counts.
 */

import { createHash } from 'crypto';

import {
  createLogger,
  errorMessage,
  REMEDIATION_REMAINING_REASON_LABELS,
  remediationFindingsKey,
  rolloutStartFailureText,
  type EcosystemRecipientSpec,
  type RemediationClearedFinding,
  type RemediationProposeReason,
  type RemediationRemainingFinding,
  type RemediationRolloutPauseReason,
  type RemediationRolloutStartGiveUp,
  type RemediationRolloutSummary,
} from '@pipeline-builder/api-core';
import { incCounter } from '@pipeline-builder/api-server';
import { OFFICIAL_PUBLISHER_HANDLE } from '@pipeline-builder/pipeline-data';

import { config } from '../config.js';
import { notifyInstallers } from './ecosystem/install-notify.js';
import { listings, publishers } from './ecosystem/store.js';
import { frontendBaseUrl } from './ecosystem/submission-config.js';
import { enqueueEcosystemNotification, type EnqueueOptions } from './ecosystem-notifications.js';
import {
  claimNewNotices,
  defaultPrefs,
  digestOptions,
  pipelineOwnerRecipients,
  prefsStore,
  recipientsFor,
  releaseNotices,
  sendWebhook,
  type SecurityPrefs,
  type SecurityWebhookPayload,
} from './plugin-security-notifications.js';

const logger = createLogger('remediation-notices');

/** How long a sent remediation notice is remembered for dedupe. */
export const REMEDIATION_NOTICE_DEDUPE_TTL_MS = 90 * 24 * 60 * 60 * 1000;
/** At most this many findings are listed in one notice (the rest are counted). */
export const NOTICE_FINDINGS_MAX = 25;
/** Recipient rules per relay request (the relay caps a request at 50). */
const RECIPIENT_CHUNK = 50;

/** Fields every org-side remediation notice carries. */
interface RemediationNoticeBase {
  /** The org that owns the remediated version (the system org for an Official fix). */
  orgId: string;
  remediationId: string;
  pluginName: string;
  fromVersion: string;
  toVersion?: string | null;
}

/** N36: the fix was published, or (propose mode) it waits for approval. */
export interface FixPublishedNotice extends RemediationNoticeBase {
  code: 'N36';
  awaitingApproval: boolean;
  cleared: RemediationClearedFinding[];
  remaining: RemediationRemainingFinding[];
  proposeReasons?: RemediationProposeReason[];
  /** The flagged version's uploader (writers mode includes them while a member). */
  uploaderId?: string | null;
}

/** N37: the rollout finished or paused. */
export interface RolloutNotice extends RemediationNoticeBase {
  code: 'N37';
  summary: RemediationRolloutSummary;
  /** Orgs whose pipelines the rollout moved or proposed to (their pipeline writers hear it). */
  affectedOrgIds?: string[];
  /**
   * Set when the rollout never STARTED and the sweep gave up (the summary is
   * then a `paused` one with zero counts): why, after how many attempts.
   */
  startFailure?: { reason: RemediationRolloutStartGiveUp; attempts: number; lastStatus: string | null };
}

/** N38: one pipeline was rolled back (or the rollback was blocked). */
export interface RollbackNotice extends RemediationNoticeBase {
  code: 'N38';
  /** The org owning the pipeline (for an Official fix, an installing tenant). */
  pipelineOrgId: string;
  pipelineId: string;
  pipelineName?: string | null;
  kind: 'rolled_back' | 'rollback_blocked';
  /** The version the pipeline is back on (rolled_back). */
  rolledBackTo?: string | null;
  /** rollback_blocked: the live versions the owners can choose instead. */
  liveVersions?: string[];
  at: string;
}

/** N39: the remediation request to the owner. */
export interface OwnerRequestNotice extends RemediationNoticeBase {
  code: 'N39';
  remaining: RemediationRemainingFinding[];
  uploaderId?: string | null;
}

/** N40: the fix request to a third-party listing's publisher, and its installers. */
export interface PublisherFixRequestNotice {
  code: 'N40';
  listingId: string;
  version: string;
  remaining: RemediationRemainingFinding[];
}

export type RemediationNotice = FixPublishedNotice | RolloutNotice | RollbackNotice | OwnerRequestNotice | PublisherFixRequestNotice;

/** Whether the operator knob allows remediation (and so its notices). Read per call. */
export function remediationNoticesEnabled(): boolean {
  return config.operator.remediationEnabled;
}

/** The remediation card on the plugins page. */
export const remediationUrl = (remediationId: string): string =>
  `${frontendBaseUrl()}/dashboard/plugins?tab=security&section=remediations&remediation=${encodeURIComponent(remediationId)}`;

const sha = (s: string): string => createHash('sha256').update(s).digest('hex');
/** `1 finding` / `2 findings`; a consonant + `y` takes `-ies` (`2 vulnerabilities`). */
const plural = (n: number, word: string): string =>
  `${n} ${n === 1 ? word : /[^aeiou]y$/i.test(word) ? `${word.slice(0, -1)}ies` : `${word}s`}`;

/** One finding left for the owner, as a notice line. */
export function remainingLine(f: RemediationRemainingFinding): string {
  const fixed = f.fixedIn.length > 0 ? `fixed in ${f.fixedIn.join(', ')}` : 'no fixed version yet';
  const level = f.requiredLevel ? `; a fix needs a ${f.requiredLevel === 'owner' ? 'new module path (owner change)' : `${f.requiredLevel} upgrade`}` : '';
  return `- ${f.id} (${f.severity}${f.kev ? ', known exploited' : ''}) in ${f.packageName} ${f.packageVersion} [${f.packageType}]: ${fixed}. `
    + `Not fixed: ${REMEDIATION_REMAINING_REASON_LABELS[f.reason] ?? f.reason}${level}.`;
}

/** The findings left, capped at {@link NOTICE_FINDINGS_MAX} lines. */
export function remainingText(remaining: readonly RemediationRemainingFinding[]): string {
  const lines = remaining.slice(0, NOTICE_FINDINGS_MAX).map(remainingLine);
  if (remaining.length > NOTICE_FINDINGS_MAX) lines.push(`…and ${remaining.length - NOTICE_FINDINGS_MAX} more.`);
  return lines.join('\n');
}

function clearedText(cleared: readonly RemediationClearedFinding[]): string {
  const byPkg = new Map<string, RemediationClearedFinding[]>();
  for (const c of cleared) byPkg.set(c.purl || c.packageName, [...(byPkg.get(c.purl || c.packageName) ?? []), c]);
  const lines = [...byPkg.values()].slice(0, NOTICE_FINDINGS_MAX).map((cs) => {
    const c = cs[0]!;
    const to = c.toVersion ? `${c.fromVersion} → ${c.toVersion}` : `${c.fromVersion} (removed by the rebuild)`;
    return `- ${c.packageName} ${to} [${c.method.replace('_', ' ')}]: ${[...new Set(cs.map((x) => x.id))].join(', ')}`;
  });
  if (byPkg.size > NOTICE_FINDINGS_MAX) lines.push(`…and ${byPkg.size - NOTICE_FINDINGS_MAX} more packages.`);
  return lines.join('\n');
}

const PROPOSE_REASON_TEXT: Record<RemediationProposeReason, string> = {
  org_mode: 'your organization reviews fixes before they are published',
  major_upgrade: 'a library crosses a major version',
  no_smoke_test: 'the plugin declares no smokeTest, so the fix could not be run',
  ask_agent_patch: 'the patch was drafted by the Ask agent',
};

/** Why a rollout paused, as the N37 notice says it. */
const PAUSE_REASON_TEXT: Record<RemediationRolloutPauseReason, string> = {
  canary_failed: 'a canary pipeline failed on a step using the new version',
  rollbacks: 'two pipelines were rolled back',
  rollback_target_deleted: 'a pipeline could not be rolled back because its previous version was deleted',
};

async function relay(event: 'N36' | 'N37' | 'N38' | 'N39' | 'N40', recipients: EcosystemRecipientSpec[], content: { subject: string; text: string }, opts: EnqueueOptions): Promise<boolean> {
  if (recipients.length === 0) return false;
  for (let i = 0; i < recipients.length; i += RECIPIENT_CHUNK) {
    await enqueueEcosystemNotification(event, recipients.slice(i, i + RECIPIENT_CHUNK), { subject: content.subject.slice(0, 500), text: content.text.slice(0, 10_000) }, opts);
  }
  return true;
}

/** The dedupe claims one send made, given back when the send fails ({@link sendRemediationNotice}). */
type Claims = Array<{ key: string; member: string }>;

/** Whether `member` under `key` is new (and claims it, recording the claim in `claims`). */
async function firstTime(claims: Claims, key: string, member: string): Promise<boolean> {
  const fresh = (await claimNewNotices(key, [member], REMEDIATION_NOTICE_DEDUPE_TTL_MS)).length > 0;
  if (fresh) claims.push({ key, member });
  return fresh;
}

function webhookBase(n: RemediationNoticeBase, prefs: SecurityPrefs, content: { subject: string; text: string }): Omit<SecurityWebhookPayload, 'event' | 'type'> {
  return {
    orgId: prefs.orgId,
    plugin: n.pluginName,
    version: n.fromVersion,
    subject: content.subject,
    text: content.text,
    occurredAt: new Date().toISOString(),
  };
}

// -----------------------------------------------------------------------------
// Renderers (pure, exported for tests and for the dashboard's preview copy)
// -----------------------------------------------------------------------------

export function renderFixPublished(n: FixPublishedNotice): { subject: string; text: string } {
  const ref = `${n.pluginName}@${n.fromVersion}`;
  const to = n.toVersion ?? 'a new version';
  const ids = [...new Set(n.cleared.map((c) => c.id))];
  const subject = n.awaitingApproval
    ? `Fix ready for approval: ${n.pluginName} ${to} clears ${plural(ids.length, 'finding')} in ${ref}`
    : `Fix published: ${n.pluginName} ${to} clears ${plural(ids.length, 'finding')} in ${ref}`;
  const why = n.awaitingApproval && n.proposeReasons?.length
    ? ` It waits for approval because ${n.proposeReasons.map((r) => PROPOSE_REASON_TEXT[r] ?? r).join(', and ')}.`
    : '';
  const text = (n.awaitingApproval
    ? `Remediation built ${n.pluginName} ${to}, a fixed version of ${ref}. Review the patch and approve or reject it (plugins:write, step-up).${why}`
    : `Remediation published ${n.pluginName} ${to}, a fixed version of ${ref}. Pipelines on ${n.fromVersion} are moved or offered the upgrade under your organization's rollout setting.`)
    + (ids.length ? `\n\nCleared:\n${clearedText(n.cleared)}` : '')
    + (n.remaining.length ? `\n\nStill open (${n.remaining.length}; a remediation request lists them):\n${remainingText(n.remaining)}` : '')
    + `\n\n${remediationUrl(n.remediationId)}`;
  return { subject, text };
}

export function renderRollout(n: RolloutNotice): { subject: string; text: string } {
  const s = n.summary;
  const ref = `${n.pluginName} ${s.toVersion}`;
  if (n.startFailure) {
    const f = n.startFailure;
    return {
      subject: `Rollout paused: ${ref}`,
      text: `The rollout of ${ref} (fixing ${n.pluginName}@${n.fromVersion}) did not start: ${rolloutStartFailureText(f.lastStatus)}`
        + `${f.reason === 'exhausted' ? ` (${plural(f.attempts, 'attempt')})` : ''}. It is no longer retried automatically. `
        + 'The version stays published, so owners can still choose it; Retry on the remediation starts the rollout again.'
        + `\n\n${remediationUrl(n.remediationId)}`,
    };
  }
  const paused = s.status === 'paused';
  const why = s.pausedReason ? PAUSE_REASON_TEXT[s.pausedReason] ?? null : null;
  const subject = paused ? `Rollout paused: ${ref}` : `Rollout finished: ${ref}`;
  const c = s.counts;
  const text = (paused
    ? `The rollout of ${ref} (fixing ${n.pluginName}@${n.fromVersion}) paused${why ? ` because ${why}` : ''}. The version stays published, so owners can still choose it; the remediation needs review.`
    : `The rollout of ${ref} (fixing ${n.pluginName}@${n.fromVersion}) finished.`)
    + `\n\nPipelines: ${c.moved} moved, ${c.proposed} offered the upgrade, ${c.changeRequested} change requests, ${c.failed} failed, `
    + `${c.rolledBack} rolled back, ${c.skippedOptOut} opted out, ${c.skippedRunner} skipped (runner unhealthy), of ${c.eligible} eligible.`
    + `\n\n${remediationUrl(n.remediationId)}`;
  return { subject, text };
}

export function renderRollback(n: RollbackNotice): { subject: string; text: string } {
  const name = n.pipelineName ? `"${n.pipelineName}"` : n.pipelineId;
  if (n.kind === 'rollback_blocked') {
    return {
      subject: `Pipeline ${name} could not be rolled back from ${n.pluginName} ${n.toVersion ?? ''}`.trim(),
      text: `A run of pipeline ${name} failed on a step using ${n.pluginName} ${n.toVersion ?? ''} within 24 hours of the upgrade, `
        + `but its previous version ${n.fromVersion} is no longer available, so it was not moved back. Its rollout is paused.`
        + (n.liveVersions?.length ? `\n\nLive versions you can choose: ${n.liveVersions.slice(0, 20).join(', ')}.` : ''),
    };
  }
  return {
    subject: `Pipeline ${name} rolled back to ${n.pluginName} ${n.rolledBackTo ?? n.fromVersion}`,
    text: `A run of pipeline ${name} failed on a step using ${n.pluginName} ${n.toVersion ?? ''} within 24 hours of the upgrade, `
      + `so it was moved back to ${n.rolledBackTo ?? n.fromVersion} and redeployed. The fix version stays published; `
      + 'investigate the failure before choosing it again.',
  };
}

export function renderOwnerRequest(n: OwnerRequestNotice): { subject: string; text: string } {
  const ref = `${n.pluginName}@${n.fromVersion}`;
  const kev = n.remaining.filter((f) => f.kev).length;
  return {
    subject: `Remediation request: ${plural(n.remaining.length, 'finding')} in ${ref} need${n.remaining.length === 1 ? 's' : ''} your fix`,
    text: `Nightly remediation could not fix ${plural(n.remaining.length, 'finding')} in ${ref}`
      + `${kev ? ` (${kev} known exploited)` : ''}. The version stays flagged until a fixed version is uploaded.`
      + `${n.toVersion ? ` ${n.pluginName} ${n.toVersion} fixes the rest.` : ''}\n\n${remainingText(n.remaining)}\n\n${remediationUrl(n.remediationId)}`,
  };
}

export function renderPublisherFixRequest(ref: string, n: PublisherFixRequestNotice): { publisher: { subject: string; text: string }; installers: { subject: string; text: string } } {
  return {
    publisher: {
      subject: `Fix request: ${plural(n.remaining.length, 'vulnerability')} in ${ref} ${n.version}`,
      text: `The platform's nightly rescan found ${plural(n.remaining.length, 'fixable Critical/High finding')} in your listed version ${ref} ${n.version}. `
        + 'Listed plugins are never rebuilt by the platform: please publish a fixed version.\n\n'
        + remainingText(n.remaining),
    },
    installers: {
      subject: `Fix requested from the publisher of ${ref}`,
      text: `${ref} ${n.version}, installed in your organization, has ${plural(n.remaining.length, 'Critical/High finding')} with a fix available. `
        + 'The platform sent its publisher a fix request. Your install moves to a fixed version once the publisher ships one.\n\n'
        + remainingText(n.remaining),
    },
  };
}

// -----------------------------------------------------------------------------
// Senders
// -----------------------------------------------------------------------------

async function sendFixPublished(n: FixPublishedNotice, claims: Claims): Promise<void> {
  const stage = n.awaitingApproval ? 'awaiting_approval' : 'published';
  if (!(await firstTime(claims, `plugin-security:n36:${n.remediationId}`, `${stage}|${n.toVersion ?? ''}`))) return deduped('N36');
  const prefs = await prefsStore.get(n.orgId);
  const content = renderFixPublished(n);
  await relay('N36', await recipientsFor(prefs, n.uploaderId), content, digestOptions(prefs, 'N36'));
  await sendWebhook(prefs, {
    ...webhookBase(n, prefs, content),
    event: 'N36',
    type: 'plugin.remediation.published',
    remediation: {
      id: n.remediationId,
      fromVersion: n.fromVersion,
      toVersion: n.toVersion ?? null,
      stage,
      advisoryIds: [...new Set(n.cleared.map((c) => c.id))].slice(0, 500),
      cleared: n.cleared.length,
      remaining: n.remaining.length,
    },
  });
  incCounter('plugin_security_notifications_total', { event: 'N36' });
}

async function sendRollout(n: RolloutNotice, claims: Claims): Promise<void> {
  if (n.summary.status !== 'done' && n.summary.status !== 'paused') return;
  if (!(await firstTime(claims, `plugin-security:n37:${n.remediationId}`, `${n.summary.status}|${n.summary.updatedAt}`))) return deduped('N37');
  const others = [...new Set((n.affectedOrgIds ?? []).map((o) => o.toLowerCase()))];
  const prefsByOrg = await prefsStore.many([n.orgId, ...others]);
  const prefs = prefsByOrg.get(n.orgId) ?? defaultPrefs(n.orgId);
  const content = renderRollout(n);
  await relay('N37', await recipientsFor(prefs), content, digestOptions(prefs, 'N37'));
  // The pipeline writers of each affected org (their own digest setting and verified address).
  for (const orgId of others) {
    const p = prefsByOrg.get(orgId) ?? defaultPrefs(orgId);
    if (!p.notifyPipelineOwners) continue;
    await relay('N37', await pipelineOwnerRecipients(p), content, digestOptions(p, 'N37'));
  }
  await sendWebhook(prefs, {
    ...webhookBase(n, prefs, content),
    event: 'N37',
    type: 'plugin.remediation.rollout',
    remediation: { id: n.remediationId, fromVersion: n.fromVersion, toVersion: n.summary.toVersion, rolloutStatus: n.summary.status },
  });
  incCounter('plugin_security_notifications_total', { event: 'N37' });
}

async function sendRollback(n: RollbackNotice, claims: Claims): Promise<void> {
  if (!(await firstTime(claims, `plugin-security:n38:${n.remediationId}`, `${n.pipelineId}|${n.kind}|${n.at}`))) return deduped('N38');
  const prefs = await prefsStore.get(n.pipelineOrgId);
  if (!prefs.notifyPipelineOwners) return;
  const content = renderRollback(n);
  await relay('N38', await pipelineOwnerRecipients(prefs), content, { immediate: true });
  await sendWebhook(prefs, {
    ...webhookBase(n, prefs, content),
    event: 'N38',
    type: 'pipeline.remediation.rolled_back',
    pipeline: { id: n.pipelineId, name: n.pipelineName ?? null },
    remediation: { id: n.remediationId, fromVersion: n.fromVersion, toVersion: n.toVersion ?? null, stage: n.kind },
  });
  incCounter('plugin_security_notifications_total', { event: 'N38' });
}

async function sendOwnerRequest(n: OwnerRequestNotice, claims: Claims): Promise<void> {
  if (n.remaining.length === 0) return;
  if (!(await firstTime(claims, `plugin-security:n39:${n.remediationId}`, sha(remediationFindingsKey(n.remaining))))) return deduped('N39');
  const prefs = await prefsStore.get(n.orgId);
  const content = renderOwnerRequest(n);
  await relay('N39', await recipientsFor(prefs, n.uploaderId), content, digestOptions(prefs, 'N39'));
  await sendWebhook(prefs, {
    ...webhookBase(n, prefs, content),
    event: 'N39',
    type: 'plugin.remediation.owner_request',
    remediation: {
      id: n.remediationId,
      fromVersion: n.fromVersion,
      toVersion: n.toVersion ?? null,
      stage: 'needs_owner',
      advisoryIds: [...new Set(n.remaining.map((f) => f.id))].slice(0, 500),
      remaining: n.remaining.length,
    },
  });
  incCounter('plugin_security_notifications_total', { event: 'N39' });
}

async function sendPublisherFixRequestNotice(n: PublisherFixRequestNotice, claims: Claims): Promise<void> {
  if (n.remaining.length === 0) return;
  const listing = await listings.byId(n.listingId);
  const publisher = listing ? await publishers.byId(listing.publisherId) : null;
  if (!listing || !publisher) {
    logger.warn('Fix request for an unknown listing', { listingId: n.listingId });
    return;
  }
  // Official fixes go through remediation, never a fix request; an owner-less
  // (community) publisher has nobody to ask.
  if (publisher.handle === OFFICIAL_PUBLISHER_HANDLE || !publisher.ownerOrgId) return;
  if (!(await firstTime(claims, `plugin-security:n40:${n.listingId}:${n.version}`, sha(remediationFindingsKey(n.remaining))))) return deduped('N40');
  const content = renderPublisherFixRequest(`${publisher.handle}/${listing.name}`, n);
  await relay('N40', [{ kind: 'org_permission', orgId: publisher.ownerOrgId, permission: 'publishers:manage' }], content.publisher, { immediate: true });
  await notifyInstallers('N40', publisher, listing, content.installers, { version: n.version, immediate: true });
  incCounter('plugin_security_notifications_total', { event: 'N40' });
}

function deduped(event: string): void {
  incCounter('plugin_security_notifications_deduplicated_total', { event });
}

/**
 * Send one remediation notice (N36–N40). The org's plugin security settings
 * pick the recipients and the digest; nothing is sent while remediation is
 * turned off by the operator. Never throws.
 */
export async function sendRemediationNotice(n: RemediationNotice): Promise<void> {
  if (!remediationNoticesEnabled()) return;
  const claims: Claims = [];
  try {
    switch (n.code) {
      case 'N36': return await sendFixPublished(n, claims);
      case 'N37': return await sendRollout(n, claims);
      case 'N38': return await sendRollback(n, claims);
      case 'N39': return await sendOwnerRequest(n, claims);
      case 'N40': return await sendPublisherFixRequestNotice(n, claims);
    }
  } catch (err) {
    // Not sent: give the dedupe claim back, so the retried job (or the next
    // report) sends it instead of reading it as a duplicate for 90 days.
    for (const c of claims) await releaseNotices(c.key, [c.member]);
    incCounter('plugin_security_notification_failed_total', { event: n.code });
    logger.warn('Remediation notice not sent', {
      event: n.code,
      ...('remediationId' in n ? { remediationId: n.remediationId } : { listingId: n.listingId }),
      error: errorMessage(err),
    });
  }
}
