// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import type { ApiCore } from '../core';
import { organizationLifecycleApi } from './organizations-lifecycle';
import { organizationMembersApi } from './organizations-members';
import { organizationHierarchyApi } from './organizations-hierarchy';
import { organizationServiceAccountsApi } from './organizations-service-accounts';
import { organizationSettingsApi } from './organizations-settings';
import { organizationInvitationsApi } from './organizations-invitations';
import { organizationSsoApi } from './organizations-sso';
import { organizationPoliciesApi } from './organizations-policies';

/**
 * The organization domain client, composed of one sub-client per concern:
 * lifecycle, members & roles, hierarchy & seats, service accounts, settings,
 * invitations, SSO / domains, and security policies.
 */
export function organizationsApi(core: ApiCore) {
  return {
    ...organizationLifecycleApi(core),
    ...organizationMembersApi(core),
    ...organizationHierarchyApi(core),
    ...organizationServiceAccountsApi(core),
    ...organizationSettingsApi(core),
    ...organizationInvitationsApi(core),
    ...organizationSsoApi(core),
    ...organizationPoliciesApi(core),
  };
}
