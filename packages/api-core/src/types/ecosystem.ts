// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { PUBLISH_REQUEST_KINDS, type PublishRequestKind } from './wire-vocabulary.js';

/**
 * Plugin-ecosystem constants shared by the plugin service (publishers, the
 * publish-request queue, auto-approval) and its callers
 * (docs/plugin-publishing.md). Dependency-free so
 * the frontend and the CLI can import it too.
 */

import { isBillingEnabled } from './quota-tiers.js';

/**
 * The name of the system-org SERVICE ACCOUNT the Official catalog loader
 * (`deploy/bin/load-plugins.sh`, driven by `init-platform.sh`) runs as. Only a
 * request submitted by this identity, from the system org, can ride the
 * bootstrap exception or the Official catalog auto-approval rule —
 * never a person, which keeps "a superadmin uploads and approves alone" closed.
 * Service-account names are unique per org and only system-org admins
 * can create one there.
 */
export const OFFICIAL_CATALOG_LOADER_ACCOUNT = 'official-catalog-loader';

/** The publisher terms version in force when the operator sets none. Bumping it
 *  (`PUBLISHER_TERMS_VERSION`) makes every publisher re-accept before its next
 *  request; existing listings are unaffected. */
export const DEFAULT_PUBLISHER_TERMS_VERSION = '2026-09-21';

/** The publisher terms version in force on this instance. */
export function publisherTermsVersion(): string {
  const v = (process.env.PUBLISHER_TERMS_VERSION ?? '').trim();
  return v !== '' ? v.slice(0, 50) : DEFAULT_PUBLISHER_TERMS_VERSION;
}

/**
 * A publisher handle: one lowercase registry path component, because it names
 * the `public/<handle>/<name>` repository — letters, digits and single
 * hyphens between them, 2–39 characters.
 */
export const PUBLISHER_HANDLE_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const PUBLISHER_HANDLE_MIN = 2;
export const PUBLISHER_HANDLE_MAX = 39;

/** Why `handle` isn't a valid publisher handle, or null when it is. */
export function publisherHandleProblem(handle: string): string | null {
  if (handle.length < PUBLISHER_HANDLE_MIN || handle.length > PUBLISHER_HANDLE_MAX) {
    return `must be ${PUBLISHER_HANDLE_MIN}-${PUBLISHER_HANDLE_MAX} characters`;
  }
  if (!PUBLISHER_HANDLE_PATTERN.test(handle)) {
    return 'must be lowercase letters and digits, optionally separated by single hyphens';
  }
  return null;
}

/**
 * Handles no tenant may claim directly, on top of the system org's
 * `ecosystem_reserved_names` table: the platform's own publishers, words that
 * would read as an endorsement, and infrastructure names. A reserved handle can
 * still be requested through a `claim` request, decided by the system org.
 */
export const BUILTIN_RESERVED_HANDLES: readonly string[] = [
  'pipeline-builder', 'community', 'official', 'verified', 'system', 'admin', 'administrator',
  'root', 'support', 'security', 'staff', 'moderator', 'ecosystem', 'public', 'library',
  'anonymous', 'unverified', 'platform', 'registry', 'plugins', 'plugin', 'api', 'www',
  // Static segments of the public directory's `/plugins/<publisher>/<name>` URL space.
  'submit', 'category',
];

/**
 * Request kinds a TENANT may submit (`moderation` is system-org-created). An
 * `advisory` request carries a security-advisory DRAFT; only the system org
 * publishes it (approving the request) or withdraws it.
 */
/**
 * DERIVED from `PUBLISH_REQUEST_KINDS` by exclusion, not hand-copied.
 *
 * This is the TENANT submit gate (`requests.ts` checks membership before
 * accepting a request), and it was a transcription of the canonical list minus
 * two entries. A kind added to the canonical list therefore needed a second,
 * entirely un-enforced edit here before a publisher could submit it — the kind
 * would exist, be decidable in the console, and be rejected at the door.
 *
 * Stating the EXCLUSIONS instead makes the relationship the code: `moderation`
 * and `submission` are opened by the system org on a tenant's behalf, never
 * submitted by the tenant, so they are the two that do not belong here.
 */
const SYSTEM_OPENED_REQUEST_KINDS = ['moderation', 'submission'] as const;

export const TENANT_REQUEST_KINDS = PUBLISH_REQUEST_KINDS
  .filter((k): k is Exclude<PublishRequestKind, typeof SYSTEM_OPENED_REQUEST_KINDS[number]> =>
    !(SYSTEM_OPENED_REQUEST_KINDS as readonly string[]).includes(k));

/** Kinds submitted under `plugins:publish` (the rest need `publishers:manage`). */
export const PUBLISH_PERMISSION_REQUEST_KINDS: readonly string[] = [
  'new_listing', 'new_version', 'listing_update', 'yank', 'unpause',
];

/** Kinds DECIDED with `publishers:verify` (the rest need `plugins:moderate`). */
export const VERIFY_REQUEST_KINDS: readonly string[] = ['transfer', 'claim', 'profile_change', 'verify'];

/** Kinds whose decision requires a step-up (suspend/yank/takedown, and every `publishers:verify` decision). */
export const STEP_UP_REQUEST_KINDS: readonly string[] = ['yank', 'transfer', 'claim', 'profile_change', 'verify', 'moderation'];

/** Moderation-queue SLA per lane, in hours (2 business days ≈ 48 h; security lane 4 h). */
export const REQUEST_SLA_HOURS = { standard: 48, security: 4 } as const;

function flag(name: string, dflt: boolean): boolean {
  const raw = (process.env[name] ?? '').trim().toLowerCase();
  if (raw === '') return dflt;
  return raw !== 'false' && raw !== '0' && raw !== 'off' && raw !== 'no';
}

/**
 * `OFFICIAL_AUTO_APPROVAL_ENABLED` (default ON): when off, the seeded
 * Official catalog auto-approval rule never fires and every Official update
 * waits for two-person approval.
 */
export function isOfficialAutoApprovalEnabled(): boolean {
  return flag('OFFICIAL_AUTO_APPROVAL_ENABLED', true);
}

/**
 * `PLUGIN_PUBLISHING_ENABLED`: whether TENANT orgs may submit publish
 * requests. Defaults on for the hosted instance (billing on) and off for a
 * self-hosted one (billing off). The system org's Official catalog is never
 * affected — it is the instance's own catalog.
 */
export function isPluginPublishingEnabled(): boolean {
  return flag('PLUGIN_PUBLISHING_ENABLED', isBillingEnabled());
}

/**
 * `ANONYMOUS_SUBMISSIONS_ENABLED` (default OFF): whether the
 * not-logged-in plugin submission API is served. Even when on, submissions
 * stay unavailable while outbound email is not configured (the magic link is
 * the submitter's only verification) — the plugin service checks that too.
 */
export function isAnonymousSubmissionsEnabled(): boolean {
  return flag('ANONYMOUS_SUBMISSIONS_ENABLED', false);
}

/**
 * `PLUGIN_REVIEWS_ENABLED` (default ON): when off, reviews are READ-ONLY —
 * writing, editing, voting, reporting and replying answer
 * `PLUGIN_REVIEWS_DISABLED`; moderation keeps working.
 */
export function isPluginReviewsEnabled(): boolean {
  return flag('PLUGIN_REVIEWS_ENABLED', true);
}
