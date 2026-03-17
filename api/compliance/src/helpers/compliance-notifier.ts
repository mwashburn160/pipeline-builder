import { InternalHttpClient, type ServiceConfig, createLogger } from '@mwashburn160/api-core';
import type { Violation } from '../engine/rule-engine';

const logger = createLogger('compliance-notifier');

const messageServiceConfig: ServiceConfig = {
  host: process.env.MESSAGE_SERVICE_HOST ?? 'message',
  port: parseInt(process.env.MESSAGE_SERVICE_PORT ?? '3000', 10),
};

const messageClient = new InternalHttpClient(messageServiceConfig);

/**
 * Send a compliance violation notification to org admins via the message service.
 * Fire-and-forget: errors are logged but never thrown.
 */
export async function notifyComplianceBlock(
  orgId: string,
  _userId: string,
  target: string,
  entityName: string,
  violations: Violation[],
  authHeader: string,
): Promise<void> {
  // Filter out violations with suppressNotification
  const notifiableViolations = violations.filter((v) => !v.suppressNotification);
  if (notifiableViolations.length === 0) return;

  const violationSummary = notifiableViolations
    .map((v) => `- ${v.ruleName}: ${v.message} (${v.severity})`)
    .join('\n');

  try {
    await messageClient.post('/messages', {
      recipientOrgId: orgId,
      messageType: 'conversation',
      subject: `Compliance violation: ${target} "${entityName}" blocked`,
      content: `A ${target} operation was blocked by compliance rules.\n\n**Entity:** ${entityName}\n**Violations:**\n${violationSummary}`,
      priority: 'high',
    }, {
      headers: {
        Authorization: authHeader,
        'x-org-id': 'system',
        'x-internal-service': 'true',
      },
    });
  } catch (err) {
    logger.warn('Failed to send compliance notification', {
      orgId,
      target,
      entityName,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
