// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Impersonation request and challenge error codes.
 *
 * Thrown by the services and mapped to HTTP status in each controller's
 * `errorMap`. Dependency-free on purpose (see `org-errors.ts`): controllers and
 * tests import the codes without loading a service and its models/config.
 */

/** The request is not in a state that can be redeemed for a token. */
export const IMP_NOT_APPROVED = 'IMP_NOT_APPROVED';
/** The approval window elapsed before the request was redeemed. */
export const IMP_EXPIRED = 'IMP_EXPIRED';
/** No such request. */
export const IMP_NOT_FOUND = 'IMP_NOT_FOUND';
/** Someone already approved or denied this request. */
export const IMP_ALREADY_DECIDED = 'IMP_ALREADY_DECIDED';
/** There is no live session to end — never redeemed, or already revoked. */
export const IMP_NOT_LIVE = 'IMP_NOT_LIVE';
/** The org forbids the impersonated user from approving their own session. */
export const CHALLENGE_SELF_APPROVAL_FORBIDDEN = 'IMPERSONATION_SELF_APPROVAL_FORBIDDEN';
