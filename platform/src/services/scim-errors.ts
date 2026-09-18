// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * SCIM 2.0 error type (3b).
 *
 * Unlike the rest of the platform — where a service throws a string code and the
 * controller maps it through an `ErrorMap` — a SCIM failure has to carry THREE
 * things to the client: the HTTP status, the RFC 7644 §3.12 `scimType` keyword,
 * and a human `detail`. Identity providers branch on the first two (Okta retries
 * a 429 and stops on a 409 `uniqueness`; Entra surfaces `detail` verbatim in its
 * provisioning log), so they are part of the contract rather than presentation.
 * One error class carrying all three keeps them together, and keeps the mapping
 * from being re-derived at each of the ~12 SCIM routes.
 *
 * `scimType` is OPTIONAL by the RFC and the table of keywords is closed, so it is
 * omitted for the failures the spec has no keyword for (a seat refusal, a
 * downgraded entitlement) rather than mislabelled with one that means something
 * else. `reason` is ours: a stable, low-cardinality label for the metric and the
 * audit row, never sent to the client.
 */

/** RFC 7644 §3.12 detail-error keywords. Closed union — a typo is a compile error. */
export type ScimType =
  | 'invalidFilter'
  | 'tooMany'
  | 'uniqueness'
  | 'mutability'
  | 'invalidSyntax'
  | 'invalidPath'
  | 'invalidValue'
  | 'invalidVers'
  | 'sensitive'
  | 'noTarget';

/** A SCIM failure, rendered by the controller as an `…:2.0:Error` document. */
export class ScimError extends Error {
  readonly status: number;
  readonly scimType?: ScimType;
  /** Stable metric/audit label (e.g. `seat_limit`) — never sent to the client. */
  readonly reason: string;

  constructor(status: number, detail: string, opts: { scimType?: ScimType; reason: string }) {
    super(detail);
    this.name = 'ScimError';
    this.status = status;
    this.reason = opts.reason;
    if (opts.scimType) this.scimType = opts.scimType;
  }
}

/** Whether an unknown thrown value is one of ours. */
export function isScimError(err: unknown): err is ScimError {
  return err instanceof ScimError;
}

// -- Constructors, one per refusal the SCIM surface can produce ---------------
// Grouped here so the status/scimType pairing for a given situation is decided
// once. Each carries the `reason` label its metric and audit row use.

export const scimNotFound = (what: 'User' | 'Group'): ScimError =>
  new ScimError(404, `${what} not found in this organization`, { reason: 'not_found' });

export const scimUniqueness = (detail: string): ScimError =>
  new ScimError(409, detail, { scimType: 'uniqueness', reason: 'uniqueness' });

export const scimInvalidValue = (detail: string): ScimError =>
  new ScimError(400, detail, { scimType: 'invalidValue', reason: 'invalid_value' });

export const scimInvalidSyntax = (detail: string): ScimError =>
  new ScimError(400, detail, { scimType: 'invalidSyntax', reason: 'invalid_syntax' });

export const scimInvalidFilter = (detail: string): ScimError =>
  new ScimError(400, detail, { scimType: 'invalidFilter', reason: 'invalid_filter' });

export const scimMutability = (detail: string): ScimError =>
  new ScimError(400, detail, { scimType: 'mutability', reason: 'mutability' });

/**
 * The account is out of seats. There is no RFC keyword for "your plan is full",
 * so this is a bare 403 whose `detail` names the seat limit — the plan's "returns
 * a SCIM error with the seat reason". 403 (not 409) because the refusal is about
 * the CALLER's entitlement, not about a conflicting resource, and every IdP
 * treats it as terminal rather than retrying forever.
 */
export const scimSeatLimit = (limit: number): ScimError =>
  new ScimError(
    403,
    `Seat limit reached: this account is licensed for ${limit} seat(s) and every one is in use. `
    + 'Add seats (or deactivate an existing member) before provisioning another user. No user was created.',
    { reason: 'seat_limit' },
  );

/**
 * The org is not (or is no longer) `sso`-entitled, and the request is not one of
 * the two things a downgraded org may still do (deactivate, delete). See
 * `scim-service.ts` for the asymmetry this enforces.
 */
export const scimNotEntitled = (): ScimError =>
  new ScimError(
    403,
    'SCIM provisioning requires the SSO entitlement, which this organization no longer holds. '
    + 'Deactivating and deleting users still works, so removing someone in your directory still removes their access; '
    + 'creating and updating users or groups does not. Restore the entitlement to resume full provisioning.',
    { reason: 'not_entitled' },
  );

/** The target is the org owner — SCIM may never deactivate or remove them. */
export const scimOwnerProtected = (): ScimError =>
  new ScimError(
    403,
    'This user owns the organization. Transfer ownership in Pipeline Builder before removing them from your directory.',
    { reason: 'owner_protected' },
  );

/** The target is a platform administrator — a tenant directory never governs one. */
export const scimPlatformAdmin = (): ScimError =>
  new ScimError(
    403,
    'This account is a Pipeline Builder platform administrator and cannot be provisioned or deactivated through SCIM.',
    { reason: 'platform_admin' },
  );
