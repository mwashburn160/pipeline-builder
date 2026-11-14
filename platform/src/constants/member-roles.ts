// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The membership roles platform alone needs on top of api-core's shared
 * vocabulary (`ORG_ROLES`, `ADMIN_ORG_ROLES`, `isOrgRole`, `isAdminOrgRole` in
 * `@pipeline-builder/api-core/wire-vocabulary`, which every caller imports
 * directly).
 *
 * Imports only that dependency-free subpath, for the reason
 * `constants/impersonation.ts` gives: middleware and the session services need
 * these, and many suites mock the models barrel (and api-core's root) with a
 * partial object — a constant reached through either breaks every such suite.
 */

import type { OrgRole } from '@pipeline-builder/api-core/wire-vocabulary';

/**
 * The roles an invitation or an add-member call may grant. `owner` is excluded:
 * ownership only moves via transferOwnership (a second `role:'owner'` insert
 * trips the partial-unique owner index and would surface as an unmapped 500).
 */
export const GRANTABLE_ORG_ROLES = ['admin', 'member'] as const satisfies readonly OrgRole[];
