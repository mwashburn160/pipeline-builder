// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Domain-based join error codes.
 *
 * Thrown by the services and mapped to HTTP status in each controller's
 * `errorMap`. Dependency-free on purpose (see `org-errors.ts`): controllers and
 * tests import the codes without loading a service and its models/config.
 */

export const DOMAIN_TAKEN = 'DOMAIN_TAKEN';
export const DOMAIN_NOT_FOUND = 'DOMAIN_NOT_FOUND';
export const DOMAIN_NOT_VERIFIED = 'DOMAIN_NOT_VERIFIED';
export const DOMAIN_VERIFY_FAILED = 'DOMAIN_VERIFY_FAILED';
export const DOMAIN_NOT_ENTITLED = 'DOMAIN_NOT_ENTITLED';
export const DOMAIN_LIMIT = 'DOMAIN_LIMIT';
export const DOMAIN_PUBLIC = 'DOMAIN_PUBLIC';
export const JOIN_NOT_ELIGIBLE = 'JOIN_NOT_ELIGIBLE';
export const JOIN_SEAT_LIMIT = 'JOIN_SEAT_LIMIT';
export const JOIN_REQUEST_NOT_FOUND = 'JOIN_REQUEST_NOT_FOUND';
/** The requesting user's account was deleted before the request was decided —
 *  approving it would mint a membership (and a seat) for no one. */
export const JOIN_REQUESTER_GONE = 'JOIN_REQUESTER_GONE';
