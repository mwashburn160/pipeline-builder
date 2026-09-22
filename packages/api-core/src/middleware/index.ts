// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

export {
  verifyUserJwt,
  verifyBearerToken,
  requireAuth,
  setTokenRevocationStore,
  isAccessTokenRevoked,
  isHumanPrincipal,
  requireAssurance,
  refuseWeakSession,
  orgAdminAssuranceRefusal,
  refuseForOrgAdminAssurance,
  requireOrgAdminAssurance,
  hasValidIdentityClaims,
  userHasPermission,
  setAuthzDenialAuditor,
  recordAuthzDenial,
  requirePermission,
  requireAllPermissions,
  requirePermissionOrService,
  requireServicePrincipal,
  requireInternalService,
  isSystemOrgId,
  isSystemAdmin,
  hasScope,
  requireSystemAdmin,
  requireFeature,
  serviceNameOf,
  isServiceTokenDenied,
  signServiceToken,
  getServiceAuthHeader,
  isServicePrincipal,
  isServiceAccountPrincipal,
  isServicePrincipalNamed,
  verifyServicePrincipal,
  type AssuranceOptions,
  ORG_ADMIN_MFA_REASON,
  type AuthzDenialInfo,
  SYSTEM_ORG_ID,
  SYSTEM_ORG_SLUG,
} from './auth.js';
export * from './ecosystem-guard.js';
export {
  mongoSanitize,
  MAX_SANITIZE_DEPTH,
} from './mongo-sanitize.js';
export {
  verifyStepUpToken,
  consumeStepUpJti,
  requireStepUp,
  type StepUpMethod,
  STRONG_STEP_UP_METHODS,
} from './step-up.js';
export {
  tagRouteGate,
  getRouteGates,
  audited,
  buildRouteTable,
  isWriteMethod,
  summarizeRouteTable,
  type RouteTableEntry,
} from './route-table.js';
