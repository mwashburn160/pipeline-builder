// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

// Service singletons and helpers. Error codes are NOT re-exported: import them
// from their dependency-free `*-errors.ts` module.
export { apiKeyService } from './api-key-service.js';
export type { AccessKeyView, ExchangeResult, ExchangeRefusal } from './api-key-service.js';
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
  serviceAccountRoles, serviceAccountRolesFor, setServiceAccountRoles, clearServiceAccountRoles,
  assertMappableRoleSet, syncMappedRoles,
} from './roles-service.js';
export type { RoleWithMembers, ActorPermissionCeiling, RoleAssignmentActor, MappableRole } from './roles-service.js';
export { idpGroupMappingService, MAX_MAPPINGS_PER_ORG } from './idp-group-mapping-service.js';
export type { IdpGroupMappingDto } from './idp-group-mapping-service.js';
export { assertJitSeatAvailable, provisionJitMembership } from './sso-jit-service.js';
export type { JitProvisionResult, JitSkipReason } from './sso-jit-service.js';
export { backfillRbacRoles } from './rbac-backfill.js';
export type { RbacBackfillSummary } from './rbac-backfill.js';
export { impersonationService, BREAKGLASS_CAP, BREAKGLASS_WINDOW_DAYS } from './impersonation-service.js';
export type { FourEyesReason } from './impersonation-service.js';
export type { CreateImpersonationRequestInput } from './impersonation-service.js';
