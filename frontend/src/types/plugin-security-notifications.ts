// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Per-org plugin security notifications (`/plugins/security-notifications`):
 * who hears about a plugin version the scan gates block (N30) and about a
 * rescan that finds new Critical / High findings in a stored version (N31).
 *
 * Write-only fields: the webhook secret and the external address are never
 * returned — the read carries `hasWebhookSecret` and a masked address instead.
 */

/** `writers` = the uploader plus members holding `plugins:write`; `users` = `targetUsers` only. */
export type PluginSecurityRecipientMode = 'writers' | 'users';

export type PluginSecurityDigestMode = 'immediate' | 'daily' | 'weekly';

/** The external address as the server shows it: masked, and whether it is confirmed yet. */
export interface PluginSecurityExternalEmail {
  masked: string;
  /** False until the confirmation link sent to the address is used; unverified addresses get nothing. */
  verified: boolean;
  /** While unverified: when the outstanding confirmation link expires (null once expired or verified). */
  pendingExpiresAt?: string | null;
}

export interface PluginSecurityNotificationPrefs {
  recipientMode: PluginSecurityRecipientMode;
  /** User ids, used when `recipientMode` is `users`. */
  targetUsers: string[];
  /** Send N31 (rescan findings). Blocked versions (N30) are always sent. */
  notifyRescan: boolean;
  /** Rescan notices honor the digest; blocks go out immediately. */
  digestMode: PluginSecurityDigestMode;
  webhookUrl: string | null;
  hasWebhookSecret: boolean;
  externalEmail: PluginSecurityExternalEmail | null;
  updatedBy?: string | null;
  updatedAt?: string | null;
  /** The caller holds `org:settings` (the server's view; the UI gates on the same permission). */
  canEdit?: boolean;
}

/**
 * Body of `PUT /plugins/security-notifications`. Only provided fields are
 * written. `webhookSecret`: omit to keep, `null` to clear. `externalEmail`:
 * a new address sends it a confirmation link; `null` removes it.
 */
export interface PluginSecurityNotificationPrefsWrite {
  recipientMode?: PluginSecurityRecipientMode;
  targetUsers?: string[];
  notifyRescan?: boolean;
  digestMode?: PluginSecurityDigestMode;
  webhookUrl?: string | null;
  webhookSecret?: string | null;
  externalEmail?: string | null;
  /** Send the pending (unverified) address a fresh confirmation link. */
  resendConfirmation?: boolean;
}

/** What `POST /plugins/security-notifications/test` did, per channel. */
export interface PluginSecurityTestResult {
  /** In-app + email to the resolved recipients. */
  relay: 'sent' | 'queued' | 'retry_queued' | 'failed';
  /** The webhook, when one is configured. */
  webhook: { ok: boolean; code?: number; error?: string } | null;
  /** The external address: sent (verified), pending (unconfirmed, so not sent) or none. */
  externalEmail: 'sent' | 'pending' | 'none';
}
