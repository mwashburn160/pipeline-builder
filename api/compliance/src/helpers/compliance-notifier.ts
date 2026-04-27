// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createLogger, errorMessage, getServiceAuthHeader } from '@pipeline-builder/api-core';
import { messageClient } from './message-client';
import type { Violation } from '../engine/rule-engine';

const logger = createLogger('compliance-notifier');

/**
 * Send a compliance violation notification to org admins via the message service.
 * Fire-and-forget: errors are logged but never thrown.
 *
 * Always uses a service token — the user's bearer (when present) doesn't have
 * cross-tenant write permission on the message service.
 */
export async function notifyComplianceBlock(
  orgId: string,
  target: string,
  entityName: string,
  violations: Violation[],
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
        'Authorization': getServiceAuthHeader({ serviceName: 'compliance', orgId: 'system' }),
        'x-org-id': 'system',
        'x-internal-service': 'true',
      },
    });
  } catch (err) {
    logger.warn('Failed to send compliance notification', {
      orgId,
      target,
      entityName,
      error: errorMessage(err),
    });
  }
}
