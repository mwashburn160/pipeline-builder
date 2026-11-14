// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import type { OrgRole } from '@pipeline-builder/api-core/wire-vocabulary';
import type { RoleGrant } from '@/types';

export interface UserListItem {
  id: string;
  username: string;
  email: string;
  role: OrgRole;
  /** Global super-admin flag (Pipeline Builder operator). Cross-org. */
  isSuperAdmin?: boolean;
  isEmailVerified: boolean;
  organizationId?: string;
  organizationName?: string;
  createdAt?: string;
  /** Per-user feature-flag overrides. Absent on rows with no overrides.
   *  Edited via the FeatureOverridesEditor inside the user-edit modal. */
  featureOverrides?: Record<string, boolean>;
}

/** Draft state backing the create-user modal. */
export interface NewUserState {
  username: string;
  email: string;
  password: string;
  organizationId: string;
  role: OrgRole;
  isSuperAdmin: boolean;
}

/** An org-scoped Role option surfaced in the create-user assignment picker. */
export interface OrgRoleOption {
  id: string;
  name: string;
  grantsRole: RoleGrant;
}
