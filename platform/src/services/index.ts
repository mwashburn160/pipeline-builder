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
export { orgHierarchyService } from './org-hierarchy-service.js';
export type { DeletedTeam } from './org-hierarchy-service.js';
export type { MemberTeam, BulkAddResult, TeamSummary } from './org-members-service.js';
// RBAC: the built-in Role lifecycle (roles-service) plus the surfaces split out
// of it — see that file's header for the map.
export { seedDefaultRoles, recomputeUserOrgRole, ensureBaselineRole } from './roles-service.js';
export type { RoleWithMembers } from './roles-service.js';
export { permissionsForGrantsRole } from './role-authority.js';
export type { ActorPermissionCeiling, RoleAssignmentActor } from './role-authority.js';
export {
  listRolesWithMembers, addUserToRole, removeUserFromRole,
  createRole, updateRole, deleteRole, ecosystemRoleName,
} from './role-crud.js';
export { deliverEcosystemNotification, notifyEcosystemManagerChange } from './ecosystem-notifications.js';
export {
  serviceAccountRoles, serviceAccountRolesFor, setServiceAccountRoles, clearServiceAccountRoles,
} from './service-account-roles.js';
export { assertMappableRoleSet, syncMappedRoles } from './mapped-roles.js';
export type { MappableRole } from './mapped-roles.js';
export { idpGroupMappingService } from './idp-group-mapping-service.js';
export type { IdpGroupMappingDto } from './idp-group-mapping-service.js';
export { assertJitSeatAvailable, provisionJitMembership } from './sso-jit-service.js';
export type { JitProvisionResult, JitSkipReason } from './sso-jit-service.js';
export { backfillRbacRoles } from './rbac-backfill.js';
export type { RbacBackfillSummary } from './rbac-backfill.js';
export { impersonationService, BREAKGLASS_CAP, BREAKGLASS_WINDOW_DAYS } from './impersonation-service.js';
export type { FourEyesReason } from './impersonation-service.js';
export type { CreateImpersonationRequestInput } from './impersonation-service.js';
