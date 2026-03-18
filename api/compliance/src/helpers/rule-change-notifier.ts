import { InternalHttpClient, type ServiceConfig, createLogger } from '@mwashburn160/api-core';
import { subscriptionService } from '../services/subscription-service';

const logger = createLogger('rule-change-notifier');

const messageServiceConfig: ServiceConfig = {
  host: process.env.MESSAGE_SERVICE_HOST ?? 'message',
  port: parseInt(process.env.MESSAGE_SERVICE_PORT ?? '3000', 10),
};

const messageClient = new InternalHttpClient(messageServiceConfig);

/**
 * Feature #8: Notify subscriber orgs when a published rule is modified or deleted.
 * Fire-and-forget: errors are logged but never thrown.
 */
export async function notifyPublishedRuleChange(
  ruleId: string,
  ruleName: string,
  changeType: 'updated' | 'deleted',
): Promise<void> {
  try {
    const subscribers = await subscriptionService.findSubscribers(ruleId);
    if (subscribers.length === 0) return;

    const subject = changeType === 'deleted'
      ? `Published rule "${ruleName}" has been removed`
      : `Published rule "${ruleName}" has been updated`;

    const content = changeType === 'deleted'
      ? `The published compliance rule "${ruleName}" has been deleted by the system administrator. Your subscription has been automatically removed.`
      : `The published compliance rule "${ruleName}" has been updated by the system administrator. If you have pinned a specific version, your pinned version will continue to be used. Otherwise, the updated rule will take effect after cache refresh.`;

    for (const sub of subscribers) {
      try {
        await messageClient.post('/messages', {
          recipientOrgId: sub.orgId,
          messageType: 'conversation',
          subject,
          content,
          priority: 'normal',
        }, {
          headers: {
            'x-org-id': 'system',
            'x-internal-service': 'true',
          },
        });
      } catch {
        // Individual notification failures are non-fatal
      }
    }

    logger.info('Notified subscribers of published rule change', { ruleId, ruleName, changeType, subscribers: subscribers.length });
  } catch (err) {
    logger.warn('Failed to notify subscribers of rule change', {
      ruleId,
      ruleName,
      changeType,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
