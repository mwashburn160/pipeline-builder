// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

export { auditService } from './audit-service.js';
export type { AuditFilter, AuditCreateInput, PaginatedAuditResult } from './audit-service.js';
export { organizationService, ORG_NOT_FOUND, SYSTEM_ORG_DELETE_FORBIDDEN } from './organization-service.js';
export { authService, DUPLICATE_CREDENTIALS } from './auth-service.js';
export { userProfileService, PROFILE_USER_NOT_FOUND, PROFILE_EMAIL_TAKEN, PROFILE_INVALID_CREDENTIALS, PROFILE_OWNER_HAS_ORGS } from './user-profile-service.js';
export { userAdminService, UA_USER_NOT_FOUND, UA_USERNAME_TAKEN, UA_EMAIL_TAKEN, UA_OWNER_HAS_ORGS, UA_ORG_NOT_FOUND } from './user-admin-service.js';
export {
  invitationService,
  INV_ORG_NOT_FOUND, INV_UNAUTHORIZED, INV_ALREADY_MEMBER, INV_ALREADY_SENT, INV_MAX_REACHED,
  INV_INVITER_NOT_FOUND, INV_NOT_FOUND, INV_ACCEPTED, INV_EXPIRED, INV_REVOKED,
  INV_USER_NOT_FOUND, INV_EMAIL_MISMATCH, INV_OAUTH_NOT_ALLOWED, INV_EMAIL_NOT_ALLOWED, INV_NOT_PENDING,
} from './invitation-service.js';
export {
  orgMembersService,
  OM_ORG_NOT_FOUND, OM_USER_NOT_FOUND, OM_ALREADY_MEMBER, OM_NOT_A_MEMBER,
  OM_CANNOT_REMOVE_OWNER, OM_CANNOT_CHANGE_OWNER, OM_OWNER_MEMBERSHIP_NOT_FOUND,
  OM_NEW_OWNER_MUST_BE_MEMBER, OM_MEMBERSHIP_NOT_FOUND, OM_ALREADY_INACTIVE, OM_ALREADY_ACTIVE,
  OM_TARGETS_OUT_OF_SCOPE,
} from './org-members-service.js';
export type { MemberTeam, BulkAddResult, TeamSummary } from './org-members-service.js';
export {
  seedDefaultGroups, recomputeUserOrgRole,
  listGroupsWithMembers, addUserToGroup, removeUserFromGroup,
  GRP_GROUP_NOT_FOUND, GRP_USER_NOT_FOUND, GRP_NOT_ORG_MEMBER,
  GRP_CANNOT_REMOVE_SELF, GRP_LAST_PRIVILEGED_MEMBER, GRP_REQUIRES_SUPERADMIN,
} from './groups-service.js';
export type { GroupWithMembers } from './groups-service.js';
