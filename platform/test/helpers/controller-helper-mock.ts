// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared `helpers/controller-helper.js` mock for platform controller suites.
 *
 * WHY: ~50 suites replaced the whole module with a two-function stub —
 * `withController` plus whichever gate they wanted to drive. Because
 * `unstable_mockModule` swaps the ENTIRE namespace, every gate the stub did not
 * list silently became `undefined`, and every gate it DID list stopped enforcing
 * anything. Nine tenancy/authz gates (`requireAuth`, `requireSystemAdmin`,
 * `requireOrgMembership`, `requireAuthContext`, `requireAdminContext`,
 * `requireMemberManagementScope`, `canAdministerOrg`, `canManageOrgScope`,
 * `canAccessOrg`) were therefore NOT under test in the suites that look like they
 * test them.
 *
 * THE FIX: use the REAL module, in full. Nothing is faked by default — not even
 * `withController`. An earlier revision of this helper replaced `withController`
 * with a transparent pass-through, on the theory that the real wrapper "swallows"
 * a thrown error and hides it from the test. That was wrong: `withController` →
 * `handleControllerError` → `errorMap` IS production logic, and ~15 suites assert
 * exactly it (`OIDC_NOT_ENTITLED` → 403, `USER_OWNER_HAS_ORGS` → 400,
 * `SAML_INVALID_STATE` → 403, …). Faking it broke every one of them.
 *
 * So: the whole module runs for real, which means a suite must hand its handler a
 * `req` that would actually pass the gate — and a suite asserting an error
 * MAPPING gets the real mapping.
 *
 * A suite MAY still override something (pass it in `overrides`) — e.g. a unit
 * test that wants to observe a RAW throw rather than the mapped response can pass
 * `{ withController: rawThrowController }` below. Do that only when deliberately
 * isolating a different unit; the default is the real behaviour.
 *
 * NOTE: `jest.requireActual` (not `import`) is what reaches past the module mock;
 * jest 30's runtime has no `importActual`. It resolves the real module
 * synchronously, so the call site stays `() => controllerHelperMock(…)`.
 */
import { jest } from '@jest/globals';

/**
 * Opt-in `withController` replacement: runs the handler and lets a thrown error
 * propagate to the test instead of being mapped to an HTTP response. Pass it
 * explicitly — `controllerHelperMock({ withController: rawThrowController })` —
 * in a suite that asserts on the throw itself rather than on the mapped status.
 */
export const rawThrowController =
  (_label: string, handler: (req: never, res: never) => unknown) =>
    async (req: never, res: never) => handler(req, res);

/**
 * Build the controller-helper namespace: the REAL module, then `overrides`.
 */
export function controllerHelperMock(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const actual = jest.requireActual('../../src/helpers/controller-helper.js') as Record<string, unknown>;
  return { ...actual, ...overrides };
}
