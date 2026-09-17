// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

// Service singletons and helpers. Error codes are NOT re-exported: import them
// from their dependency-free `*-errors.ts` module.
export { auditService } from './audit-service.js';
export type { AuditFilter, AuditCreateInput, PaginatedAuditResult } from './audit-service.js';
export { organizationService } from './organization-service.js';
export { changedAiProviderFields } from './organization-ai-secrets.js';
export { authService } from './auth-service.js';
export { userProfileService, type PreferencesPatch, type UserPreferencesView } from './user-profile-service.js';
export { userAdminService } from './user-admin-service.js';
export { invitationService } from './invitation-service.js';
export { orgMembersService } from './org-members-service.js';
export type { MemberTeam, BulkAddResult, TeamSummary } from './org-members-service.js';
export {
  seedDefaultRoles, recomputeUserOrgRole, ensureBaselineRole, getUserRolePermissions,
  permissionsForGrantsRole,
  listRolesWithMembers, addUserToRole, removeUserFromRole,
  createRole, updateRole, deleteRole,
} from './roles-service.js';
export type { RoleWithMembers, ActorPermissionCeiling, RoleAssignmentActor } from './roles-service.js';
export { backfillRbacRoles } from './rbac-backfill.js';
export type { RbacBackfillSummary } from './rbac-backfill.js';
export { impersonationService, BREAKGLASS_CAP, BREAKGLASS_WINDOW_DAYS } from './impersonation-service.js';
export type { FourEyesReason } from './impersonation-service.js';
export type { CreateImpersonationRequestInput } from './impersonation-service.js';
