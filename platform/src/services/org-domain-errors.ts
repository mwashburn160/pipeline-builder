// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Domain-based join error codes.
 *
 * Thrown by the services; {@link DOMAIN_ERROR_MAP} maps them to HTTP status.
 * Dependency-free on purpose (see `org-errors.ts`): controllers and tests
 * import the codes without loading a service and its models/config.
 */

import type { ErrorMap } from '../helpers/controller-helper.js';

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

/** Shared error map for the domain/join-request admin endpoints. */
export const DOMAIN_ERROR_MAP: ErrorMap = {
  [DOMAIN_TAKEN]: { status: 409, message: 'That domain is already registered to an organization' },
  [DOMAIN_NOT_FOUND]: { status: 404, message: 'Domain not found' },
  [DOMAIN_NOT_VERIFIED]: { status: 409, message: 'Verify the domain before enabling join' },
  [DOMAIN_VERIFY_FAILED]: { status: 400, message: 'Could not find the verification DNS TXT record' },
  [DOMAIN_NOT_ENTITLED]: { status: 403, message: 'Domain-based join requires the Team or Enterprise tier' },
  [DOMAIN_LIMIT]: { status: 409, message: 'This organization has reached its domain limit' },
  [DOMAIN_PUBLIC]: { status: 400, message: 'Public email providers (e.g. gmail.com) cannot be used for domain-based join' },
  [JOIN_NOT_ELIGIBLE]: { status: 409, message: 'This domain is no longer configured for join — the request can’t be approved' },
  [JOIN_REQUEST_NOT_FOUND]: { status: 404, message: 'Join request not found' },
  [JOIN_REQUESTER_GONE]: { status: 410, message: 'The requesting user no longer exists' },
  [JOIN_SEAT_LIMIT]: { status: 409, message: 'Approving this request would exceed your seat limit' },
};
