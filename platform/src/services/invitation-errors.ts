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
