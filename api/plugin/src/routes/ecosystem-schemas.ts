// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Request-body schemas of the ecosystem write routes (publisher, installs,
 * console, anonymous submissions), parsed at the route by `bodyFrom`.
 *
 * They own the SHAPE of a body: which fields exist (`.strict()` refuses any
 * other), their JSON types, and which are required. The services keep the
 * meaning — trimming, length caps, semver and handle syntax, enum vocabularies
 * whose refusal names the allowed values — so a field the service already
 * refuses with its own code or message (e.g. `termsVersion` →
 * `PUBLISHER_TERMS_REQUIRED`) is optional here and left to it.
 *
 * Each field set is the set its service reads, cross-checked against what the
 * frontend sends (`frontend/src/lib/api/domains/ecosystem.ts`,
 * `plugin-installs.ts`, `plugin-reviews.ts`, `plugin-submissions.ts`).
 */

import { DEFAULT_CONSUMPTION_POLICY } from '@pipeline-builder/pipeline-data';
import { z } from 'zod';

/** A required free-text field: present and not blank (the service trims and caps it). */
const requiredText = z.string().trim().min(1);
/** An optional free-text field; null / blank mean "none". */
const optionalText = z.string().nullable().optional();
/** A version-policy / version field of an install write (null = keep the current one). */
const nullableString = z.string().nullable().optional();

/** `{ reason }` — the one-field body of most moderation writes. */
export const ReasonBody = z.object({ reason: requiredText }).strict();
/** `{ reason? }` */
export const OptionalReasonBody = z.object({ reason: optionalText }).strict();

// -----------------------------------------------------------------------------
// Console (/plugins/ecosystem)
// -----------------------------------------------------------------------------

/** Approve / second-approve: an optional note, trimmed and capped (null when blank). */
export const DecisionNoteBody = z.object({
  note: z.string().nullable().optional()
    .transform((v) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 1000) : null)),
}).strict();

/** Reject: a reason is required (trimmed, capped at 1000). */
export const RejectBody = z.object({ reason: requiredText.transform((v) => v.slice(0, 1000)) }).strict();

export const PublisherTierBody = z.object({
  reason: requiredText,
  tier: z.enum(['verified', 'community'], { error: 'tier must be verified or community' }),
}).strict();

export const ListingStateBody = z.object({
  reason: requiredText,
  state: z.enum(['listed', 'unmaintained', 'suspended'], { error: 'state must be listed, unmaintained or suspended' }),
}).strict();

/** Console deprecate (`deprecated: false` clears it). */
export const SetDeprecationBody = z.object({
  deprecated: z.boolean().optional(),
  message: optionalText,
}).strict();

/** The editable advisory fields (`parseAdvisoryFields` checks the values and names what is missing). */
const advisoryFields = {
  affectedRange: z.string().optional(),
  severity: z.string().optional(),
  summary: z.string().optional(),
  detailsMd: z.string().nullable().optional(),
  // An array of ids, or one comma/space separated string.
  cveIds: z.union([z.array(z.string()), z.string()]).nullable().optional(),
  fixedVersion: z.string().nullable().optional(),
};

export const AdvisoryCreateBody = z.object({ listingId: z.string().min(1), ...advisoryFields }).strict();
export const AdvisoryPatchBody = z.object(advisoryFields).strict();

/** Rule conditions are checked against `AutoRuleConditionsSchema` by the service (its message names the field). */
const ruleConditions = z.record(z.string(), z.unknown());

export const RuleCreateBody = z.object({ name: z.string(), conditions: ruleConditions }).strict();
export const RulePatchBody = z.object({
  name: z.string().optional(),
  enabled: z.boolean().optional(),
  conditions: ruleConditions.optional(),
}).strict();
/** The pending change the approver reviewed. */
export const RuleApproveBody = z.object({ requestedAt: z.string().min(1) }).strict();

export const ReservedNameBody = z.object({
  reason: optionalText,
  publisherId: z.string().nullable().optional(),
}).strict();

/** Review moderation: hold / remove / remove-reply need a reason; release takes a note. */
export const ReviewNoteBody = z.object({ note: optionalText }).strict();
/** The reason's limits are the service's (`reasonOf`); blank is refused there as missing. */
export const ReviewReasonBody = z.object({ reason: z.string() }).strict();

// -----------------------------------------------------------------------------
// Tenant publisher (/plugins/publisher, /plugins/publish-requests)
// -----------------------------------------------------------------------------

export const PublisherClaimBody = z.object({
  handle: z.string(),
  displayName: z.string(),
  description: optionalText,
  homepageUrl: optionalText,
  // Optional here: a missing / stale version is PUBLISHER_TERMS_REQUIRED (the service).
  termsVersion: z.string().optional(),
}).strict();

export const PublisherProfileBody = z.object({
  description: optionalText,
  homepageUrl: optionalText,
  // Accepted only so the service can answer with WHY they are refused here
  // (they change through a `profile_change` request).
  handle: z.unknown().optional(),
  displayName: z.unknown().optional(),
}).strict();

export const TermsBody = z.object({ termsVersion: z.string().optional() }).strict();

/** Pause the listing (no version) or one version (an empty string = the listing). */
export const PauseBody = z.object({ version: z.string().optional() }).strict();

/** A publisher deprecates its own version; the service requires the message (and says why). */
export const OwnDeprecateBody = z.object({ version: z.string().min(1), message: optionalText }).strict();

/**
 * A publish request. One object for every kind: `buildRequest` reads a
 * different subset per `kind` and refuses what a kind lacks; this fixes the
 * vocabulary (any other field is refused) and the top-level types.
 */
export const PublishRequestBody = z.object({
  kind: z.string().optional(),
  pluginId: z.string().optional(),
  listingId: z.string().optional(),
  version: z.string().nullable().optional(),
  securityFixAdvisoryId: z.string().nullable().optional(),
  breaking: z.boolean().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  sources: z.record(z.string(), z.unknown()).optional(),
  reason: optionalText,
  target: z.record(z.string(), z.unknown()).optional(),
  application: z.record(z.string(), z.unknown()).optional(),
  advisory: z.record(z.string(), z.unknown()).optional(),
}).strict();

/** Accept or decline an incoming transfer: an explicit boolean (a missing field no longer declines). */
export const TransferResponseBody = z.object({ accept: z.boolean() }).strict();

// -----------------------------------------------------------------------------
// Installs (/plugins/installs, /plugins/install-policy)
// -----------------------------------------------------------------------------

/** The publisher handle / name syntax and the version + policy values are the service's checks. */
export const InstallCreateBody = z.object({
  publisher: z.string(),
  name: z.string(),
  versionPolicy: nullableString,
  version: nullableString,
}).strict();

export const InstallPatchBody = z.object({ versionPolicy: nullableString, version: nullableString }).strict();
export const InstallChangeRequestBody = InstallPatchBody.extend({ note: optionalText }).strict();

/**
 * The consumption-policy fields (a partial update). Their values are checked by
 * `applyPolicyUpdate` (pipeline-data); the key set follows the policy itself.
 */
export const InstallPolicyBody = z.object(
  Object.fromEntries(Object.keys(DEFAULT_CONSUMPTION_POLICY).map((k) => [k, z.unknown().optional()])),
).strict();

// -----------------------------------------------------------------------------
// Anonymous routes (submissions, security-address confirmation)
// -----------------------------------------------------------------------------

/** A one-time token; a missing or malformed one is the service's refusal. */
export const TokenBody = z.object({ token: z.string().optional() }).strict();

/** Multipart text fields: the PoW solution is a JSON string (the service parses it). */
export const InspectFields = z.object({ pow: z.unknown().optional() }).strict();
export const SubmissionFields = z.object({
  email: z.unknown().optional(),
  pow: z.unknown().optional(),
  metadata: z.unknown().optional(),
  acceptTerms: z.unknown().optional(),
}).strict();
