// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Capability scopes a credential may carry INSTEAD of its holder's roles (#12).
 * A scoped credential exchanges to a token with no permissions at all, so it can
 * do the one thing named here and nothing else — which is what every automation
 * that does exactly one thing should hold.
 *
 * Mirrors api-core's `TOKEN_SCOPES` (the set both `POST /user/generate-token`
 * and the service-account key route validate against); a value outside it is
 * refused by the API. Kept here rather than imported because api-core's root
 * entry is server-side code.
 */
export const TOKEN_SCOPE_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: 'reporting:ingest', label: 'reporting:ingest — post pipeline events / incidents' },
  { value: 'registry:push', label: 'registry:push — push images to this org’s namespace' },
  { value: 'scim', label: 'scim — provision members from your identity provider (SCIM 2.0)' },
];

/** Longest lifetime the API accepts for a machine token or key, in days. */
export const MAX_CREDENTIAL_DAYS = 365;
