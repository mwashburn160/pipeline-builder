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
 * How each publish-request kind is gated, keyed by kind — exhaustive, so a kind
 * added to `PUBLISH_REQUEST_KINDS` does not compile until it is placed here, and
 * every kind list below is DERIVED from this one table rather than transcribed
 * (a hand-copied list once left a new kind decidable in the console yet rejected
 * at the tenant's door).
 *
 * - `submit` — the tenant permission that submits it, or `null` when the system
 *   org opens it on a tenant's behalf (`moderation`, `submission`). An
 *   `advisory` request carries a security-advisory DRAFT; only the system org
 *   publishes it (approving the request) or withdraws it.
 * - `decide` — the system-org permission that decides it.
 * - `stepUp` — whether the decision requires a step-up (suspend/yank/takedown,
 *   and every `publishers:verify` decision).
 */
const PUBLISH_REQUEST_KIND_GATES = {
  new_listing: { submit: 'plugins:publish', decide: 'plugins:moderate', stepUp: false },
  new_version: { submit: 'plugins:publish', decide: 'plugins:moderate', stepUp: false },
  listing_update: { submit: 'plugins:publish', decide: 'plugins:moderate', stepUp: false },
  yank: { submit: 'plugins:publish', decide: 'plugins:moderate', stepUp: true },
  unpause: { submit: 'plugins:publish', decide: 'plugins:moderate', stepUp: false },
  transfer: { submit: 'publishers:manage', decide: 'publishers:verify', stepUp: true },
  claim: { submit: 'publishers:manage', decide: 'publishers:verify', stepUp: true },
  profile_change: { submit: 'publishers:manage', decide: 'publishers:verify', stepUp: true },
  advisory: { submit: 'publishers:manage', decide: 'plugins:moderate', stepUp: false },
  verify: { submit: 'publishers:manage', decide: 'publishers:verify', stepUp: true },
  moderation: { submit: null, decide: 'plugins:moderate', stepUp: true },
  submission: { submit: null, decide: 'plugins:moderate', stepUp: false },
} as const satisfies Record<PublishRequestKind, {
  submit: 'plugins:publish' | 'publishers:manage' | null;
  decide: 'plugins:moderate' | 'publishers:verify';
  stepUp: boolean;
}>;

type KindGates = typeof PUBLISH_REQUEST_KIND_GATES;
const kindsWhere = (pred: (g: KindGates[PublishRequestKind]) => boolean): PublishRequestKind[] =>
  PUBLISH_REQUEST_KINDS.filter((k) => pred(PUBLISH_REQUEST_KIND_GATES[k]));

/** Request kinds a TENANT may submit (the rest are system-org-opened). */
export const TENANT_REQUEST_KINDS = PUBLISH_REQUEST_KINDS
  .filter((k): k is { [K in PublishRequestKind]: KindGates[K]['submit'] extends null ? never : K }[PublishRequestKind] =>
    PUBLISH_REQUEST_KIND_GATES[k].submit !== null);

/** Kinds submitted under `plugins:publish` (the rest need `publishers:manage`). */
export const PUBLISH_PERMISSION_REQUEST_KINDS: readonly string[] = kindsWhere((g) => g.submit === 'plugins:publish');

/** Kinds DECIDED with `publishers:verify` (the rest need `plugins:moderate`). */
export const VERIFY_REQUEST_KINDS: readonly string[] = kindsWhere((g) => g.decide === 'publishers:verify');

/** Kinds whose decision requires a step-up (suspend/yank/takedown, and every `publishers:verify` decision). */
export const STEP_UP_REQUEST_KINDS: readonly string[] = kindsWhere((g) => g.stepUp);

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
