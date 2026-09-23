// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

export {
  verifyUserJwt,
  verifyBearerToken,
  hasValidIdentityClaims,
} from './jwt-verify.js';
export {
  requireAuth,
} from './auth.js';
export {
  setTokenRevocationStore,
  isAccessTokenRevoked,
} from './revocation.js';
export {
  requireAssurance,
  refuseWeakSession,
  refuseForOrgAdminAssurance,
  requireOrgAdminAssurance,
  type AssuranceOptions,
} from './assurance.js';
export {
  userHasPermission,
  setAuthzDenialAuditor,
  recordAuthzDenial,
  requirePermission,
  requireAllPermissions,
  requirePermissionOrService,
  requireServicePrincipal,
  requireInternalService,
  isSystemAdmin,
  hasScope,
  requireSystemAdmin,
  requireFeature,
  type AuthzDenialInfo,
} from './permission-gates.js';
export {
  isSystemOrgId,
  SYSTEM_ORG_ID,
  SYSTEM_ORG_SLUG,
} from './system-org.js';
export {
  serviceNameOf,
  isServiceTokenDenied,
  signServiceToken,
  getServiceAuthHeader,
  isServicePrincipal,
  isServiceAccountPrincipal,
  isServicePrincipalNamed,
  verifyServicePrincipal,
} from './service-tokens.js';
export { requireSystemOrg, requireEcosystemPermission } from './ecosystem-guard.js';
export {
  mongoSanitize,
  MAX_SANITIZE_DEPTH,
} from './mongo-sanitize.js';
export {
  proposable,
  ASK_PROVENANCE_REFUSED_COUNTER,
} from './ask-provenance.js';
export {
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
