// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

export { auditService } from './audit-service.js';
export type { AuditFilter, AuditCreateInput, PaginatedAuditResult } from './audit-service.js';
export { organizationService, ORG_NOT_FOUND, SYSTEM_ORG_DELETE_FORBIDDEN, ORG_AI_KEY_TOO_LONG } from './organization-service.js';
export { authService, DUPLICATE_CREDENTIALS } from './auth-service.js';
export { userProfileService, PROFILE_USER_NOT_FOUND, PROFILE_EMAIL_TAKEN, PROFILE_INVALID_CREDENTIALS, PROFILE_OWNER_HAS_ORGS } from './user-profile-service.js';
export { userAdminService, UA_USER_NOT_FOUND, UA_USERNAME_TAKEN, UA_EMAIL_TAKEN, UA_OWNER_HAS_ORGS, UA_ORG_NOT_FOUND, UA_SEAT_LIMIT, UA_CANNOT_CHANGE_OWNER, UA_ROLES_NEED_ORG } from './user-admin-service.js';
export {
  invitationService,
  INV_ORG_NOT_FOUND, INV_UNAUTHORIZED, INV_ALREADY_MEMBER, INV_ALREADY_SENT, INV_MAX_REACHED, INV_SEAT_LIMIT,
  INV_INVITER_NOT_FOUND, INV_NOT_FOUND, INV_ACCEPTED, INV_EXPIRED, INV_REVOKED,
  INV_USER_NOT_FOUND, INV_EMAIL_MISMATCH, INV_OAUTH_NOT_ALLOWED, INV_EMAIL_NOT_ALLOWED, INV_NOT_PENDING,
} from './invitation-service.js';
export {
  orgMembersService,
  OM_ORG_NOT_FOUND, OM_USER_NOT_FOUND, OM_ALREADY_MEMBER, OM_NOT_A_MEMBER,
  OM_CANNOT_REMOVE_OWNER, OM_OWNER_MEMBERSHIP_NOT_FOUND,
  OM_NEW_OWNER_MUST_BE_MEMBER, OM_MEMBERSHIP_NOT_FOUND, OM_ALREADY_INACTIVE, OM_ALREADY_ACTIVE,
  OM_TARGETS_OUT_OF_SCOPE, OM_SEAT_LIMIT,
} from './org-members-service.js';
export type { MemberTeam, BulkAddResult, TeamSummary } from './org-members-service.js';
export {
  seedDefaultRoles, recomputeUserOrgRole, ensureBaselineRole, getUserRolePermissions,
  permissionsForGrantsRole,
  listRolesWithMembers, addUserToRole, removeUserFromRole,
  createRole, updateRole, deleteRole,
  RL_ROLE_NOT_FOUND, RL_USER_NOT_FOUND, RL_NOT_ORG_MEMBER,
  RL_CANNOT_REMOVE_SELF, RL_LAST_PRIVILEGED_MEMBER, RL_REQUIRES_SUPERADMIN,
  RL_SYSTEM_IMMUTABLE, RL_NAME_TAKEN, RL_INVALID_PERMISSION,
} from './roles-service.js';
export type { RoleWithMembers } from './roles-service.js';
export { backfillRbacRoles } from './rbac-backfill.js';
export type { RbacBackfillSummary } from './rbac-backfill.js';
