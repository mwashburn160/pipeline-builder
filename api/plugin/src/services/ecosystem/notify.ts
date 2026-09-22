// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The W1 notices (docs/plans/plugin-ecosystem.md §5b: N6–N10, N24, N25, N28,
 * N29, and N8 for moderation actions) and the W5 anonymous-submission notices
 * (N1–N5) as thin wrappers over
 * {@link enqueueEcosystemNotification}. Recipients are RULES resolved by
 * platform at send time. A notice never fails the action that caused it: the
 * in-app copy is durable in the relay/queue, and a failure here is logged and
 * counted.
 */

import { emitCounter, createLogger, errorMessage, type EcosystemNotificationEventId, type EcosystemRecipientSpec } from '@pipeline-builder/api-core';

import type { PluginListing } from '@pipeline-builder/pipeline-data';

import { installingOrgs, sendToOrgs } from './install-notify.js';
import { listings, publishers } from './store.js';
import { enqueueEcosystemNotification, type EnqueueOptions } from '../ecosystem-notifications.js';

const logger = createLogger('ecosystem-notify');

const KIND_LABEL: Record<string, string> = {
  new_listing: 'New listing',
  new_version: 'New version',
  listing_update: 'Listing update',
  yank: 'Yank',
  unpause: 'Unpause',
  transfer: 'Ownership transfer',
  claim: 'Claim',
  profile_change: 'Publisher profile change',
  verify: 'Verified-publisher application',
  moderation: 'Moderation action',
  advisory: 'Security advisory',
  submission: 'Anonymous submission',
};

/** A human label for a request kind. */
export function kindLabel(kind: string): string {
  return KIND_LABEL[kind] ?? kind;
}

export const publisherManagers = (orgId: string): EcosystemRecipientSpec =>
  ({ kind: 'org_permission', orgId, permission: 'publishers:manage' });

export const moderators = (
  permission: 'plugins:moderate' | 'publishers:verify',
  exclude: { orgId?: string | null; userIds?: string[] } = {},
): EcosystemRecipientSpec => ({
  kind: 'moderators',
  permission,
  ...(exclude.orgId ? { excludeMembersOfOrgId: exclude.orgId } : {}),
  ...(exclude.userIds?.length ? { excludeUserIds: exclude.userIds } : {}),
});

async function send(
  event: EcosystemNotificationEventId,
  recipients: EcosystemRecipientSpec[],
  subject: string,
  text: string,
  opts: EnqueueOptions = {},
): Promise<void> {
  if (recipients.length === 0) return;
  try {
    await enqueueEcosystemNotification(event, recipients, { subject: subject.slice(0, 500), text: text.slice(0, 10_000) }, opts);
  } catch (err) {
    emitCounter('ecosystem_notification_failed_total', { event });
    logger.warn('Ecosystem notice not sent', { event, error: errorMessage(err) });
  }
}

/** A request's short title: `acme/lint 1.2.0 — New version`. */
export function requestTitle(r: { kind: string; handle: string; name: string | null; version?: string | null }): string {
  const what = r.name ? `${r.handle}/${r.name}${r.version ? ` ${r.version}` : ''}` : r.handle;
  return `${what} — ${kindLabel(r.kind)}`;
}

/**
 * N24 (N6 for a Verified application): a request is waiting for the system org.
 * Moderators with a conflict of interest (members of the requesting org) are
 * excluded. Yank and security-fix requests are immediate and can't be opted
 * out of; the rest ride the daily digest.
 */
export function notifyRequestSubmitted(input: {
  kind: string; lane: string; title: string; submittedOrgId: string | null; permission: 'plugins:moderate' | 'publishers:verify';
}): Promise<void> {
  const urgent = input.kind === 'yank' || input.lane === 'security';
  const recipients = [moderators(input.permission, { orgId: input.submittedOrgId })];
  if (input.kind === 'verify') {
    return send('N6', recipients, `Verified application: ${input.title}`,
      `${input.title} is waiting for a publisher review in the Ecosystem console.`);
  }
  return send('N24', recipients, `Publish request: ${input.title}`,
    `${input.title} is waiting for a decision in the Ecosystem console${input.lane === 'security' ? ' (security-fix lane, 4-hour SLA)' : ''}.`,
    urgent ? { immediate: true, mandatory: true } : {});
}

/** N28: the first of two approvals is in; other eligible managers are asked for the second. */
export function notifySecondApprovalNeeded(input: {
  title: string; firstApprover: string; submittedOrgId: string | null; permission: 'plugins:moderate' | 'publishers:verify';
}): Promise<void> {
  return send('N28', [moderators(input.permission, { orgId: input.submittedOrgId, userIds: [input.firstApprover] })],
    `Second approval needed: ${input.title}`,
    `${input.title} has one approval and needs a second Ecosystem Manager (not the first approver) to confirm it.`);
}

/** N25 (N7 for a Verified application): the publisher learns the decision. Auto-approvals also go to moderators. */
export function notifyDecision(input: {
  kind: string; title: string; publisherOrgId: string | null; approved: boolean; reason?: string | null; auto?: boolean;
}): Promise<void> {
  if (!input.publisherOrgId) return Promise.resolve();
  const verb = input.approved ? (input.auto ? 'auto-approved' : 'approved') : 'rejected';
  const text = `${input.title} was ${verb}${input.reason ? `: ${input.reason}` : '.'}`;
  if (input.kind === 'verify') {
    return send('N7', [publisherManagers(input.publisherOrgId)], `Verified application ${verb}`, text);
  }
  const recipients = [publisherManagers(input.publisherOrgId)];
  if (input.auto) recipients.push(moderators('plugins:moderate'));
  return send('N25', recipients, `Publish request ${verb}: ${input.title}`, text);
}

/**
 * N8: a moderation action (suspend, yank, takedown, unmaintained) on a
 * publisher's listing — to the publisher's managers AND the installing orgs
 * (§5b). With `listing`, the orgs installing that listing (and, with
 * `version`, only those whose install reaches it); without, the orgs
 * installing ANY of the publisher's listings (a publisher-wide action such as
 * a suspension). Installers are told separately, per org — the publisher never
 * learns who they are.
 */
export async function notifyModerationAction(input: {
  publisherOrgId: string | null;
  subject: string;
  text: string;
  listing?: Pick<PluginListing, 'id' | 'name' | 'state' | 'publisherId'>;
  version?: string;
}): Promise<void> {
  if (input.publisherOrgId) await send('N8', [publisherManagers(input.publisherOrgId)], input.subject, input.text);
  try {
    const publisher = input.listing
      ? await publishers.byId(input.listing.publisherId)
      : input.publisherOrgId ? await publishers.byOrg(input.publisherOrgId) : null;
    if (!publisher) return;
    const affected = input.listing ? [input.listing] : await listings.list({ publisherId: publisher.id });
    const orgs = new Set<string>();
    for (const l of affected) {
      for (const o of await installingOrgs(publisher, l, input.version)) orgs.add(o.orgId);
    }
    // The publisher's own org already heard as the publisher.
    if (input.publisherOrgId) orgs.delete(input.publisherOrgId.toLowerCase());
    await sendToOrgs('N8', [...orgs], { subject: input.subject, text: `${input.text}\n\nYour organization has it installed.` });
  } catch (err) {
    emitCounter('ecosystem_notification_failed_total', { event: 'N8' });
    logger.warn('Installer fan-out of a moderation notice failed', { error: errorMessage(err) });
  }
}

/** N9: a transfer TO this org's publisher was requested. */
export function notifyTransferRequested(input: { receivingOrgId: string; title: string }): Promise<void> {
  return send('N9', [publisherManagers(input.receivingOrgId)], `Ownership transfer offered: ${input.title}`,
    `${input.title} is offered to your publisher. Accept or decline it on the Publisher page; the system org then decides.`);
}

/** N10: a transfer was accepted, declined, approved or rejected — both orgs hear. */
export function notifyTransferUpdate(input: { orgIds: Array<string | null>; title: string; outcome: string }): Promise<void> {
  const recipients = [...new Set(input.orgIds.filter((o): o is string => !!o))].map(publisherManagers);
  return send('N10', recipients, `Ownership transfer ${input.outcome}: ${input.title}`, `${input.title}: the transfer was ${input.outcome}.`);
}

/** N29: a plan change affects publishing (over the listings limit; Verified grace started/reminder/ended). */
export function notifyPlanEffect(input: { publisherOrgId: string; subject: string; text: string }): Promise<void> {
  return send('N29', [publisherManagers(input.publisherOrgId)], input.subject, input.text);
}

// -----------------------------------------------------------------------------
// Anonymous submissions (§4, N1–N5). The submitter is a raw ADDRESS (they have
// no account): decrypted only to send, only for these transactional notices.
// Every submitter email carries the status link — the submitter's only handle.
// -----------------------------------------------------------------------------

const submitter = (email: string): EcosystemRecipientSpec => ({ kind: 'address', email });

/** N1: the magic link that verifies the submission (single use, 30 minutes). */
export function notifySubmissionReceived(input: { email: string; name: string; version: string; verifyUrl: string; statusUrl: string }): Promise<void> {
  return send('N1', [submitter(input.email)], `Confirm your plugin submission: ${input.name} ${input.version}`,
    `Someone (hopefully you) submitted the plugin ${input.name} ${input.version} to the public plugin directory with this address.\n\n`
    + `Confirm the submission within 30 minutes: ${input.verifyUrl}\n\n`
    + `Track it any time: ${input.statusUrl}\n\n`
    + 'If this wasn\'t you, ignore this email: an unconfirmed submission is deleted automatically.');
}

/** N2: a submission passed every automated gate and waits in the moderation queue. */
export function notifySubmissionQueued(input: { name: string; version: string; newListing: boolean }): Promise<void> {
  return send('N2', [moderators('plugins:moderate')], `Anonymous submission to review: community/${input.name} ${input.version}`,
    `community/${input.name} ${input.version} (${input.newListing ? 'new listing' : 'new version'}) passed every automated gate and is waiting for two-person review in the Ecosystem console.`);
}

/** N3: a submission failed one or more automated gates (the failed checks listed). */
export function notifySubmissionGateFailed(input: { email: string; name: string; version: string; failures: string[]; statusUrl: string }): Promise<void> {
  const lines = input.failures.slice(0, 20).map((f) => `- ${f}`).join('\n');
  return send('N3', [submitter(input.email)], `Plugin submission failed its checks: ${input.name} ${input.version}`,
    `Your submission ${input.name} ${input.version} failed these automated checks and was not sent to moderation:\n\n${lines}\n\n`
    + `Fix them and submit again. Details: ${input.statusUrl}`);
}

/** N4: moderation approved (with the listing URL) or rejected (with the reason) a submission. */
export function notifySubmissionDecision(input: {
  email: string; name: string; version: string; approved: boolean; reason?: string | null; listingUrl?: string; statusUrl: string;
}): Promise<void> {
  const text = input.approved
    ? `Your plugin ${input.name} ${input.version} was approved and is listed as community/${input.name}: ${input.listingUrl ?? ''}\n\n`
      + 'To manage it from an account, sign up with this email address and claim the listing.'
    : `Your plugin submission ${input.name} ${input.version} was rejected${input.reason ? `: ${input.reason}` : '.'}\n\nDetails: ${input.statusUrl}`;
  return send('N4', [submitter(input.email)], `Plugin submission ${input.approved ? 'approved' : 'rejected'}: ${input.name} ${input.version}`, text);
}

/** N5: the claiming account now owns the listing its anonymous submissions created. */
export function notifySubmissionClaimed(input: { userId: string; orgId: string | null; listing: string }): Promise<void> {
  return send('N5', [{ kind: 'user', userId: input.userId, ...(input.orgId ? { orgId: input.orgId } : {}) }],
    `Listing claimed: ${input.listing}`,
    `Your claim was approved: ${input.listing} now belongs to your publisher, and the anonymous submissions that created it are linked to your account.`);
}
