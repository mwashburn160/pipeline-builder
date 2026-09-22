// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Review notices N15–N19 (docs/plans/plugin-ecosystem.md §5b). Recipients are
 * RULES resolved by platform at send time; every notice carries the
 * reviewer's DISPLAY NAME only — never their org (G15) — and never tells a
 * reviewer or a publisher who reported what. A notice never fails the action
 * that caused it (logged + counted, like notify.ts).
 *
 *  - N15 new or edited review → publisher managers; in-app now, email batched
 *    HOURLY per listing (`digestKey` = the listing).
 *  - N16 publisher replied → the review author.
 *  - N17 review held (reports, burst, filter, security) → moderators; daily digest.
 *  - N18 your review was removed → the author (transactional).
 *  - N19 security report → publisher managers AND moderators, immediate and
 *    mandatory, private.
 */

import { createLogger, emitCounter, errorMessage, type EcosystemNotificationEventId, type EcosystemRecipientSpec } from '@pipeline-builder/api-core';
import type { PluginListing, PluginReview, Publisher, ReviewHoldReason } from '@pipeline-builder/pipeline-data';

import { moderators, publisherManagers } from './notify.js';
import { enqueueEcosystemNotification, type EnqueueOptions } from '../ecosystem-notifications.js';

const logger = createLogger('ecosystem-review-notify');

const HOLD_LABEL: Record<ReviewHoldReason, string> = {
  reports: 'several reports',
  burst: 'a burst of new reviews on the listing',
  filter: 'the link filter',
  security: 'a security report',
  moderator: 'a moderator',
};

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
    logger.warn('Review notice not sent', { event, error: errorMessage(err) });
  }
}

const ref = (publisher: Pick<Publisher, 'handle'>, listing: Pick<PluginListing, 'name'>) => `${publisher.handle}/${listing.name}`;
const stars = (n: number) => `${'★'.repeat(n)}${'☆'.repeat(5 - n)}`;
const author = (r: Pick<PluginReview, 'authorDisplayName'>) => r.authorDisplayName ?? 'A former user';

/** N15: a review was posted (or edited, or released from a hold) on the publisher's listing. */
export function notifyReviewPosted(
  publisher: Pick<Publisher, 'handle' | 'ownerOrgId'>,
  listing: Pick<PluginListing, 'id' | 'name'>,
  review: Pick<PluginReview, 'rating' | 'title' | 'authorDisplayName'>,
  edited: boolean,
): Promise<void> {
  if (!publisher.ownerOrgId) return Promise.resolve();
  const what = ref(publisher, listing);
  return send('N15', [publisherManagers(publisher.ownerOrgId)],
    `${edited ? 'Review updated' : 'New review'} on ${what}: ${stars(review.rating)}`,
    `${author(review)} ${edited ? 'updated their review of' : 'reviewed'} ${what}: ${stars(review.rating)}${review.title ? ` — "${review.title}"` : ''}. `
      + 'Reply from the plugin\'s public page.',
    { digestKey: `N15:${listing.id}` });
}

/** N16: the publisher replied to the author's review. */
export function notifyReplied(
  publisher: Pick<Publisher, 'handle' | 'displayName'>,
  listing: Pick<PluginListing, 'name'>,
  review: Pick<PluginReview, 'authorUserId' | 'authorOrgId'>,
): Promise<void> {
  if (!review.authorUserId) return Promise.resolve();
  const what = ref(publisher, listing);
  return send('N16', [{ kind: 'user', userId: review.authorUserId, ...(review.authorOrgId ? { orgId: review.authorOrgId } : {}) }],
    `${publisher.displayName} replied to your review of ${what}`,
    `${publisher.displayName} replied to your review of ${what}. Read it on the plugin's page.`);
}

/** N17: a review went into the moderation queue. */
export function notifyReviewHeld(
  publisher: Pick<Publisher, 'handle'>,
  listing: Pick<PluginListing, 'name'>,
  reason: ReviewHoldReason,
): Promise<void> {
  const what = ref(publisher, listing);
  return send('N17', [moderators('plugins:moderate')], `Review held on ${what}`,
    `A review of ${what} was held by ${HOLD_LABEL[reason]} and is waiting in the Ecosystem console's review moderation queue.`);
}

/** N18: a moderator removed the author's review. */
export function notifyReviewRemoved(
  publisher: Pick<Publisher, 'handle'>,
  listing: Pick<PluginListing, 'name'>,
  review: Pick<PluginReview, 'authorUserId' | 'authorOrgId'>,
  reason: string,
): Promise<void> {
  if (!review.authorUserId) return Promise.resolve();
  const what = ref(publisher, listing);
  return send('N18', [{ kind: 'user', userId: review.authorUserId, ...(review.authorOrgId ? { orgId: review.authorOrgId } : {}) }],
    `Your review of ${what} was removed`,
    `A moderator removed your review of ${what}: ${reason}`);
}

/** N19: a review was flagged as a security issue — private, immediate, can't be opted out of. */
export function notifySecurityReport(
  publisher: Pick<Publisher, 'handle' | 'ownerOrgId'>,
  listing: Pick<PluginListing, 'name'>,
  version: string | null,
  details: string | null,
): Promise<void> {
  const what = `${ref(publisher, listing)}${version ? ` ${version}` : ''}`;
  const recipients: EcosystemRecipientSpec[] = [moderators('plugins:moderate')];
  if (publisher.ownerOrgId) recipients.unshift(publisherManagers(publisher.ownerOrgId));
  return send('N19', recipients, `Security issue reported: ${what}`,
    `A signed-in user reported a possible security issue in ${what} through a review. The report is private: it is not shown on the `
      + 'public page, and the review is held until a moderator looks at it. A private advisory draft is opened for the publisher and the platform moderators.'
      + `${details ? `\n\nReport details:\n${details}` : ''}`,
    { immediate: true, mandatory: true });
}
