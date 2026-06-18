// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/** Per-org compliance notification preference as returned by the API. The
 *  webhook secret is never echoed back — only `hasWebhookSecret`. */
export interface ComplianceNotificationPreference {
  notifyOnBlock: boolean;
  notifyOnWarning: boolean;
  emailEnabled: boolean;
  digestMode: 'immediate' | 'daily' | 'weekly';
  /** Explicit user IDs to email; null = all org admins. */
  targetUsers: string[] | null;
  webhookUrl: string | null;
  hasWebhookSecret: boolean;
}

/** Body for PUT /compliance/notification-preferences. Only provided fields are
 *  written. Omit `webhookSecret` to keep the existing one; '' clears it. */
export interface ComplianceNotificationPreferenceWrite {
  notifyOnBlock?: boolean;
  notifyOnWarning?: boolean;
  emailEnabled?: boolean;
  digestMode?: 'immediate' | 'daily' | 'weekly';
  targetUsers?: string[] | null;
  webhookUrl?: string | null;
  webhookSecret?: string | null;
}
