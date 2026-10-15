// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Invitation error codes.
 *
 * Thrown by the services and mapped to HTTP status in each controller's
 * `errorMap`. Dependency-free on purpose (see `org-errors.ts`): controllers and
 * tests import the codes without loading a service and its models/config.
 */

export const INV_ORG_NOT_FOUND = 'INV_ORG_NOT_FOUND';
export const INV_UNAUTHORIZED = 'INV_UNAUTHORIZED';
export const INV_ALREADY_MEMBER = 'INV_ALREADY_MEMBER';
export const INV_ALREADY_SENT = 'INV_ALREADY_SENT';
export const INV_MAX_REACHED = 'INV_MAX_REACHED';
export const INV_SEAT_LIMIT = 'INV_SEAT_LIMIT';
export const INV_INVITER_NOT_FOUND = 'INV_INVITER_NOT_FOUND';
export const INV_NOT_FOUND = 'INV_NOT_FOUND';
export const INV_ACCEPTED = 'INV_ACCEPTED';
export const INV_EXPIRED = 'INV_EXPIRED';
export const INV_REVOKED = 'INV_REVOKED';
export const INV_USER_NOT_FOUND = 'INV_USER_NOT_FOUND';
export const INV_EMAIL_MISMATCH = 'INV_EMAIL_MISMATCH';
export const INV_OAUTH_NOT_ALLOWED = 'INV_OAUTH_NOT_ALLOWED';
export const INV_EMAIL_NOT_ALLOWED = 'INV_EMAIL_NOT_ALLOWED';
export const INV_NOT_PENDING = 'INV_NOT_PENDING';

/**
 * HTTP mapping for invitation-accept refusals. Shared by POST /invitation/accept
 * and POST /auth/register, which accepts an invitation inline when it carries an
 * `invitationToken` — both must answer the same refusal the same way.
 */
export const INVITATION_ACCEPT_ERRORS = {
  [INV_NOT_FOUND]: { status: 404, message: 'Invitation not found' },
  [INV_ACCEPTED]: { status: 400, message: 'Invitation has already been accepted' },
  [INV_EXPIRED]: { status: 400, message: 'Invitation has expired' },
  [INV_REVOKED]: { status: 400, message: 'Invitation has been revoked' },
  [INV_USER_NOT_FOUND]: { status: 404, message: 'User not found' },
  [INV_EMAIL_MISMATCH]: { status: 403, message: 'This invitation was sent to a different email address' },
  [INV_ORG_NOT_FOUND]: { status: 404, message: 'Organization not found' },
  [INV_ALREADY_MEMBER]: { status: 400, message: 'You are already a member of this organization' },
  [INV_OAUTH_NOT_ALLOWED]: { status: 403, message: 'This invitation cannot be accepted via OAuth' },
  [INV_EMAIL_NOT_ALLOWED]: { status: 403, message: 'This invitation can only be accepted via OAuth' },
  [INV_SEAT_LIMIT]: { status: 409, message: 'That organization has no seats available' },
};
