// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createLogger, errorMessage } from '@pipeline-builder/api-core';
import { inAppChannel, type ComplianceNotification } from './notification-channels.js';
import { subscriptionService, type ComplianceRuleSubscription } from '../services/subscription-service.js';

const logger = createLogger('rule-change-notifier');

/**
 * Feature #8: Notify subscriber orgs when a published rule is modified or deleted.
 * Fire-and-forget: errors are logged but never thrown.
 *
 * Routed through the shared in-app channel for consistency with the block
 * notifier. Rule-change events are informational broadcasts (not org violations),
 * so they don't consult `notifyOnBlock` or the org webhook.
 */
export async function notifyPublishedRuleChange(
  ruleId: string,
  ruleName: string,
  changeType: 'updated' | 'deleted',
  /**
   * Optional pre-fetched subscriber list. The delete path MUST pass this: by
   * the time the notifier runs the rule is already soft-deleted, and
   * `findSubscribers` inner-joins on `isNull(deletedAt)` → it would return zero
   * rows and no one would be notified. Callers on the update path can omit it
   * and let the notifier fetch the current subscribers itself.
   */
  subscribers?: ComplianceRuleSubscription[],
): Promise<void> {
  try {
    const recipients = subscribers ?? await subscriptionService.findSubscribers(ruleId);
    if (recipients.length === 0) return;

    const subject = changeType === 'deleted'
      ? `Published rule "${ruleName}" has been removed`
      : `Published rule "${ruleName}" has been updated`;

    const content = changeType === 'deleted'
      ? `The published compliance rule "${ruleName}" has been deleted by the system administrator. It is no longer enforced. Your subscription remains in your list and can be removed at your convenience.`
      : `The published compliance rule "${ruleName}" has been updated by the system administrator. If you have pinned a specific version, your pinned version will continue to be used. Otherwise, the updated rule will take effect after cache refresh.`;

    for (const sub of recipients) {
      const notification: ComplianceNotification = {
        recipientOrgId: sub.orgId,
        messageType: 'conversation',
        priority: 'normal',
        subject,
        content,
        payload: { event: 'compliance.rule-change', ruleId, ruleName, changeType },
      };
      // Channel swallows its own errors → one failed subscriber doesn't abort the rest.
      await inAppChannel.deliver(notification, {});
    }

    logger.info('Notified subscribers of published rule change', { ruleId, ruleName, changeType, subscribers: recipients.length });
  } catch (err) {
    logger.warn('Failed to notify subscribers of rule change', {
      ruleId,
      ruleName,
      changeType,
      error: errorMessage(err),
    });
  }
}
