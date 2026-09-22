// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { sendSystemNotification, type SystemNotification } from '@pipeline-builder/api-core';
import { config } from '../config/index.js';

/** A SYSTEM-authored in-app message for a recipient org, optionally one user. */
export type InAppNotification = SystemNotification;

/**
 * Post a SYSTEM-authored in-app message via the message service's internal
 * notify route (api-core `sendSystemNotification`). REPORTS whether it was
 * persisted.
 *
 * For a message whose non-delivery costs something — e.g. an impersonation
 * CHALLENGE, where a dropped message becomes a silent expiry that reads as a
 * refusal. Delivery is in-app only, with no email fallback, so the caller must
 * know when this failed.
 *
 * Never throws; every failed delivery (unreachable, non-2xx, error) is logged.
 * Returns false when the message service is disabled — with no other channel, a
 * disabled service means nobody can be reached.
 */
export async function sendInAppNotificationConfirmed(input: InAppNotification): Promise<boolean> {
  if (!config.message.enabled) return false;
  return sendSystemNotification(input, {
    service: { host: config.message.serviceHost, port: config.message.servicePort, timeout: config.message.serviceTimeout },
    serviceName: 'platform',
  });
}

/**
 * Fire-and-forget {@link sendInAppNotificationConfirmed}, for a courtesy notice
 * whose loss costs nothing. Never throws (callers `void` it); failures are
 * logged by the confirmed variant.
 */
export async function sendInAppNotification(input: InAppNotification): Promise<void> {
  await sendInAppNotificationConfirmed(input);
}
