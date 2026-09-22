// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Who is acting, and how an ecosystem refusal travels back to the route.
 */

import {
  AppError,
  ErrorCode,
  getStatusForErrorCode,
  hasPermission,
  isSystemOrgId,
  OFFICIAL_CATALOG_LOADER_ACCOUNT,
  type Permission,
  type QuotaService,
} from '@pipeline-builder/api-core';
import type { Request } from 'express';

/** An ecosystem refusal with a typed code and optional structured `details` (e.g. the failing gates). */
export class EcosystemError extends AppError {
  constructor(code: ErrorCode, message: string, readonly details?: Record<string, unknown>) {
    super(getStatusForErrorCode(code), code, message);
    this.name = 'EcosystemError';
  }
}

/** The acting principal, captured from a request (or snapshotted into a build job). */
export interface Caller {
  userId: string;
  /** The active org (lowercase). */
  orgId: string;
  /** Set when the active org is a team. */
  parentOrgId?: string;
  /** `user` or `service_account`. */
  principalType: string;
  /** The username — for a service account, its name. */
  name?: string;
  /** The account email and whether platform verified it (claim matching, E10). */
  email?: string;
  emailVerified?: boolean;
  isSuperAdmin: boolean;
  permissions: readonly string[];
  features: readonly string[];
}

/** Whether the caller holds `permission` (superadmins hold everything). */
export function can(caller: Caller, permission: Permission): boolean {
  return hasPermission(caller.permissions as Permission[], permission, caller.isSuperAdmin);
}

/** Capture the caller from an authenticated request. */
export function callerFromRequest(req: Request): Caller {
  const u = (req.user ?? {}) as Record<string, unknown>;
  const orgId = String(u.organizationId ?? '').toLowerCase();
  const parent = typeof u.parentOrganizationId === 'string' && u.parentOrganizationId ? u.parentOrganizationId.toLowerCase() : undefined;
  return {
    userId: String(u.sub ?? ''),
    orgId,
    ...(parent && parent !== orgId ? { parentOrgId: parent } : {}),
    principalType: typeof u.principalType === 'string' ? u.principalType : 'user',
    ...(typeof u.username === 'string' ? { name: u.username } : {}),
    ...(typeof u.email === 'string' ? { email: u.email } : {}),
    ...(u.isEmailVerified === true ? { emailVerified: true } : {}),
    isSuperAdmin: u.isSuperAdmin === true,
    permissions: Array.isArray(u.permissions) ? (u.permissions as string[]) : [],
    features: Array.isArray(u.features) ? (u.features as string[]) : [],
  };
}

/**
 * Whether the caller is the Official catalog loader: the dedicated SERVICE
 * ACCOUNT of that name, acting in the system org (§3.0.3). A person — even a
 * superadmin — never is.
 */
export function isOfficialLoader(caller: Pick<Caller, 'principalType' | 'name' | 'orgId'>): boolean {
  return caller.principalType === 'service_account'
    && caller.name === OFFICIAL_CATALOG_LOADER_ACCOUNT
    && isSystemOrgId(caller.orgId);
}

/** The submitter tag a request's payload carries (rules match on it). */
export function submitterTag(caller: Caller): { principalType: string; name?: string } {
  return { principalType: caller.principalType, ...(caller.principalType === 'service_account' && caller.name ? { name: caller.name } : {}) };
}

/** Service dependencies the ecosystem logic needs. */
export interface EcosystemDeps {
  quotaService: QuotaService;
}

let deps: EcosystemDeps | null = null;

/** Wire the dependencies once at boot (mountRoutes). */
export function initEcosystem(d: EcosystemDeps): void {
  deps = d;
}

/** The wired dependencies; throws when the service was never initialised. */
export function ecosystemDeps(): EcosystemDeps {
  if (!deps) throw new Error('Plugin ecosystem service not initialised (initEcosystem)');
  return deps;
}
