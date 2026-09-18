// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Org-scoped SERVICE ACCOUNTS (#2): non-human principals that belong to one org,
 * hold that org's Roles, and authenticate only with `pb_sa_…` keys.
 *
 * The design in one paragraph: an account is a row in `service_accounts`, its
 * Roles are ordinary `role_assignments` rows (so there is ONE Role model and ONE
 * ceiling for humans and machines alike), and its keys are ordinary access-key
 * records distinguished by `prefix: 'pb_sa'` + `serviceAccountId`. Nothing about
 * its authority is baked into a key: every exchange re-reads the account, its
 * Roles and its org, so a role change, a disable or an org tombstone reaches a
 * live key within one token lifetime (5 minutes).
 *
 * The rules this module enforces, and why:
 *   - **Role ceiling** — delegated to `roles-service.setServiceAccountRoles`,
 *     which applies the SAME ceiling as assigning a Role to a person: you cannot
 *     create a machine credential more powerful than yourself.
 *   - **No seat** — an account creates no `UserOrganization` row, and seats count
 *     distinct active humans, so a service account can never consume one.
 *     Asserted by `test/service-accounts.test.ts`.
 *   - **Its own quota** — each account has a per-period token-exchange budget,
 *     decremented atomically at exchange. That is its access rate, and it is the
 *     account's own, so automation can't drain the org's human API allowance.
 *   - **Key limits** — at most {@link MAX_ACTIVE_KEYS_PER_ACCOUNT} active keys,
 *     each at most 365 days, with an optional IP allowlist checked at exchange.
 *   - **Not orphaned, but purged with the org** — the creator is recorded for
 *     attribution only; `deleteServiceAccountsForOrg` is what removes accounts,
 *     and it runs from the org cascade.
 */

import { BlockList, isIPv4, isIPv6 } from 'net';
import { createLogger, TOKEN_SCOPES } from '@pipeline-builder/api-core';
import type { QuotaTier, TokenScope } from '@pipeline-builder/api-core';
import { Types } from 'mongoose';
import { apiKeyService, type AccessKeyView } from './api-key-service.js';
import { clearServiceAccountRoles, serviceAccountRoles, serviceAccountRolesFor, setServiceAccountRoles } from './roles-service.js';
import type { ServiceAccountRole, RoleAssignmentActor } from './roles-service.js';
import {
  SA_INVALID_BUDGET,
  SA_INVALID_NAME,
  SA_INVALID_IP_ALLOWLIST,
  SA_INVALID_SCOPE,
  SA_KEY_EXPIRY_INVALID,
  SA_KEY_LIMIT,
  SA_KEY_NOT_FOUND,
  SA_LIMIT,
  SA_NAME_TAKEN,
  SA_NOT_FOUND,
  SA_ORG_NOT_FOUND,
} from './service-account-errors.js';
// The org-teardown legs live in their own module so the ORG CASCADE can import
// them without dragging the key service and the token signer into its graph.
// Re-exported here so callers (and tests) still find the whole surface in one place.
export { deleteServiceAccountsForOrg, revokeServiceAccountKeysForOrg } from './service-account-cascade.js';
import { config } from '../config/index.js';
import type { ClientInfo } from '../helpers/client-info.js';
import { resolveOrgLineage } from '../helpers/org-hierarchy.js';
import { toOrgId } from '../helpers/org-id.js';
// Imported from their own modules rather than the models BARREL: the barrel
// re-exports every model, which drags unrelated collections (and their named
// exports) into the import graph of anything that touches a service account —
// including the org cascade, whose suites mock models file-by-file.
import Organization from '../models/organization.js';
import ServiceAccount from '../models/service-account.js';
import type { ServiceAccountDocument } from '../models/service-account.js';
import type { OrgMemberRole } from '../models/user-organization.js';
import type { ServiceAccountTokenContext } from '../utils/token.js';

const logger = createLogger('service-account-service');

/** Most service accounts one org may hold. Bounds both the blast radius of a
 *  compromised admin session and the per-org listing cost. */
export const MAX_SERVICE_ACCOUNTS_PER_ORG = 50;

/** Most ACTIVE (non-revoked, unexpired) keys one account may hold. Five is
 *  enough to rotate without downtime across a few consumers, and no more. */
export const MAX_ACTIVE_KEYS_PER_ACCOUNT = 5;

/** Hard ceiling on a key's lifetime (the plan's "keys expire, maximum 365 days"). */
export const MAX_KEY_EXPIRES_IN_SECONDS = 365 * 24 * 60 * 60;

/** Default key lifetime when the caller doesn't say. */
export const DEFAULT_KEY_EXPIRES_IN_SECONDS = 90 * 24 * 60 * 60;

/** One service account as the API returns it. */
export interface ServiceAccountView {
  id: string;
  organizationId: string;
  name: string;
  description: string | null;
  /** Roles the account holds (id + name + granted permissions). */
  roles: Array<{ id: string; name: string; permissions: string[] }>;
  /** Effective permissions — the union of those Roles' permissions. */
  permissions: string[];
  /** Per-period token-exchange budget; -1 = unlimited. */
  tokenBudget: number;
  /** Exchanges consumed in the current period + when it rolls over. */
  usage: { exchanges: number; resetAt: string };
  disabled: boolean;
  createdBy: string | null;
  createdByEmail: string | null;
  createdAt: string;
  lastUsedAt: string | null;
  /** The account's keys (metadata only — a secret is returned once, at mint). */
  keys: AccessKeyView[];
  /** Always 0 — a service account takes NO seat. Returned so the UI can state
   *  the billing rule rather than implying one. */
  seatsConsumed: 0;
}

/** Input for {@link createServiceAccount}. */
export interface CreateServiceAccountInput {
  name: string;
  description?: string;
  /** Role ids to assign (subject to the creator's ceiling). */
  roleIds?: readonly string[];
  /** Per-period exchange budget; -1 unlimited (the default). */
  tokenBudget?: number;
}

/** Input for {@link createServiceAccountKey}. */
export interface CreateServiceAccountKeyInput {
  name: string;
  expiresInSeconds?: number;
  /** Exact addresses or CIDR blocks the key may be exchanged from. */
  ipAllowlist?: readonly string[];
  /**
   * Narrow capability scope (#12). When set, the exchanged token carries this
   * scope INSTEAD of the account's Roles — least privilege for a key that only
   * has to ingest events or push images.
   */
  scope?: TokenScope;
  client?: ClientInfo;
}

/** A name is a machine identifier, not a label: stable, lowercase, URL-safe. */
const NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{1,63}$/;

/**
 * Validate an IP-allowlist entry: a bare IPv4/IPv6 address, or one with a `/len`
 * CIDR suffix within range for its family. Anything else throws — a typo'd
 * allowlist that silently matched nothing would be a lockout, and one that
 * silently matched everything would be a false sense of security.
 */
function assertValidCidr(entry: string): void {
  const [addr, prefix] = entry.split('/');
  const v4 = isIPv4(addr);
  const v6 = isIPv6(addr);
  if (!v4 && !v6) throw new Error(SA_INVALID_IP_ALLOWLIST);
  if (prefix === undefined) return;
  const len = Number(prefix);
  if (!Number.isInteger(len) || len < 0 || len > (v4 ? 32 : 128)) throw new Error(SA_INVALID_IP_ALLOWLIST);
}

/** Normalize + validate an allowlist. An empty list means "any address". */
function normalizeIpAllowlist(list: readonly string[] | undefined): string[] {
  if (!list) return [];
  const out = [...new Set(list.map((e) => e.trim()).filter((e) => e.length > 0))];
  if (out.length > 32) throw new Error(SA_INVALID_IP_ALLOWLIST);
  for (const entry of out) assertValidCidr(entry);
  return out;
}

/**
 * Whether `ip` is covered by `allowlist`. An empty allowlist allows anything;
 * a NON-empty allowlist with an unknown/missing presenting address DENIES —
 * the control exists to bind a key to known addresses, so "we couldn't tell"
 * must not pass.
 *
 * Uses Node's `net.BlockList` (an allow-list built from the same primitive) so
 * CIDR maths is the platform's, not ours.
 */
export function ipAllowed(allowlist: readonly string[] | undefined | null, ip: string | undefined): boolean {
  if (!allowlist || allowlist.length === 0) return true;
  if (!ip) return false;
  // Express reports IPv4-mapped IPv6 for a v4 client on a dual-stack socket.
  const candidate = ip.startsWith('::ffff:') && isIPv4(ip.slice(7)) ? ip.slice(7) : ip;
  const family = isIPv4(candidate) ? 'ipv4' : isIPv6(candidate) ? 'ipv6' : null;
  if (!family) return false;
  const list = new BlockList();
  for (const entry of allowlist) {
    const [addr, prefix] = entry.split('/');
    const entryFamily = isIPv4(addr) ? 'ipv4' : 'ipv6';
    if (prefix === undefined) list.addAddress(addr, entryFamily);
    else list.addSubnet(addr, Number(prefix), entryFamily);
  }
  return list.check(candidate, family);
}

/** Validate a token budget: a positive integer, or -1 for unlimited. */
function normalizeBudget(budget: number | undefined): number {
  if (budget === undefined) return -1;
  if (!Number.isInteger(budget) || (budget !== -1 && budget < 1)) throw new Error(SA_INVALID_BUDGET);
  return budget;
}

/** The next budget-period boundary, on the deployment-wide quota period. */
function nextResetAt(): Date {
  return new Date(Date.now() + config.quota.resetDays * 24 * 60 * 60 * 1000);
}

type OrgFacts = {
  id: string;
  name?: string;
  tier?: QuotaTier;
  parentOrgId?: string | null;
  featureEntitlements?: string[];
};

/**
 * Read the owning org, refusing a missing or SOFT-DELETED one (`SA_ORG_NOT_FOUND`).
 * The tombstone check is the same chokepoint `resolveOrgMembership` applies to a
 * person's token: an org being torn down issues no new credentials.
 */
async function requireLiveOrg(orgId: string): Promise<OrgFacts> {
  const org = await Organization.findById(toOrgId(orgId))
    .select('name tier parentOrgId featureEntitlements deletedAt').lean();
  if (!org || (org as { deletedAt?: Date | null }).deletedAt) throw new Error(SA_ORG_NOT_FOUND);
  return {
    id: orgId,
    name: org.name,
    tier: org.tier as QuotaTier | undefined,
    parentOrgId: (org as { parentOrgId?: string | null }).parentOrgId ?? null,
    featureEntitlements: (org as { featureEntitlements?: string[] }).featureEntitlements ?? [],
  };
}

/**
 * Build the API view of one account. `roles` / `keys` may be supplied by a
 * caller that already fetched them in bulk ({@link listServiceAccounts}); when
 * they are not, they are read for this account alone.
 */
async function viewOf(
  doc: ServiceAccountDocument & { _id: unknown },
  prefetched?: { roles: ServiceAccountRole[]; keys: AccessKeyView[] },
): Promise<ServiceAccountView> {
  const id = String(doc._id);
  const orgId = String(doc.organizationId);
  const roles = prefetched?.roles ?? await serviceAccountRoles(toOrgId(orgId), id);
  const keys = prefetched?.keys ?? await apiKeyService.listForServiceAccount(id);
  const permissions = [...new Set(roles.flatMap((r) => r.permissions))].sort();
  return {
    id,
    organizationId: orgId,
    name: doc.name,
    description: doc.description ?? null,
    roles: roles.map((r) => ({ id: r.id, name: r.name, permissions: r.permissions })),
    permissions,
    tokenBudget: doc.tokenBudget,
    usage: {
      exchanges: doc.usage?.exchanges ?? 0,
      resetAt: new Date(doc.usage?.resetAt ?? Date.now()).toISOString(),
    },
    disabled: !!doc.disabled,
    createdBy: doc.createdBy ? String(doc.createdBy) : null,
    createdByEmail: doc.createdByEmail ?? null,
    createdAt: new Date(doc.createdAt).toISOString(),
    lastUsedAt: doc.lastUsedAt ? new Date(doc.lastUsedAt).toISOString() : null,
    keys,
    seatsConsumed: 0,
  };
}

/**
 * Create a service account in `orgId` and assign its initial Roles.
 *
 * `actor` is the creator's ceiling: the Roles requested here go through the SAME
 * check as assigning a Role to a person, so the account can never exceed the
 * creator's own permissions. The creator is recorded (id + email snapshot) for
 * attribution ONLY — the account survives their departure.
 *
 * Throws `SA_NAME_TAKEN`, `SA_LIMIT`, `SA_INVALID_BUDGET`, `SA_ORG_NOT_FOUND`,
 * and any Role-ceiling error from `setServiceAccountRoles`.
 */
export async function createServiceAccount(
  orgId: string,
  input: CreateServiceAccountInput,
  actor: RoleAssignmentActor & { userId?: string; email?: string },
): Promise<ServiceAccountView> {
  await requireLiveOrg(orgId);
  const name = input.name.trim().toLowerCase();
  if (!NAME_PATTERN.test(name)) throw new Error(SA_INVALID_NAME);
  const tokenBudget = normalizeBudget(input.tokenBudget);

  const oid = toOrgId(orgId);
  const count = await ServiceAccount.countDocuments({ organizationId: oid });
  if (count >= MAX_SERVICE_ACCOUNTS_PER_ORG) throw new Error(SA_LIMIT);
  if (await ServiceAccount.exists({ organizationId: oid, name })) throw new Error(SA_NAME_TAKEN);

  let doc;
  try {
    doc = await ServiceAccount.create({
      organizationId: oid,
      name,
      description: input.description?.trim() || null,
      createdBy: actor.userId && Types.ObjectId.isValid(actor.userId) ? new Types.ObjectId(actor.userId) : null,
      createdByEmail: actor.email ?? null,
      tokenBudget,
      usage: { exchanges: 0, resetAt: nextResetAt() },
    });
  } catch (err) {
    // Unique (organizationId, name) — a concurrent create won the race.
    if ((err as { code?: number }).code === 11000) throw new Error(SA_NAME_TAKEN);
    throw err;
  }

  try {
    await setServiceAccountRoles(orgId, String(doc._id), input.roleIds ?? [], actor);
  } catch (err) {
    // A refused Role assignment must not leave a role-less account behind:
    // remove the row so the caller's retry (with a permitted Role set) is clean.
    await ServiceAccount.deleteOne({ _id: doc._id });
    throw err;
  }

  logger.info('Created service account', { organizationId: orgId, serviceAccountId: String(doc._id), name });
  return viewOf(doc as unknown as ServiceAccountDocument & { _id: unknown });
}

/**
 * Every service account of an org, newest first.
 *
 * Roles and keys are fetched in BULK (three queries for the whole page, not two
 * per account), so the settings page costs the same whether the org holds one
 * account or the full fifty.
 */
export async function listServiceAccounts(orgId: string): Promise<ServiceAccountView[]> {
  const docs = await ServiceAccount.find({ organizationId: toOrgId(orgId) }).sort({ createdAt: -1 }).lean();
  if (docs.length === 0) return [];
  const ids = docs.map((d) => String(d._id));
  const [rolesByAccount, keysByAccount] = await Promise.all([
    serviceAccountRolesFor(toOrgId(orgId), ids),
    apiKeyService.listForServiceAccounts(ids),
  ]);
  return Promise.all(docs.map((d) => viewOf(d as unknown as ServiceAccountDocument & { _id: unknown }, {
    roles: rolesByAccount.get(String(d._id)) ?? [],
    keys: keysByAccount.get(String(d._id)) ?? [],
  })));
}

/** One account of `orgId`, or `SA_NOT_FOUND`. */
async function requireAccount(orgId: string, id: string): Promise<ServiceAccountDocument & { _id: unknown }> {
  if (!Types.ObjectId.isValid(id)) throw new Error(SA_NOT_FOUND);
  const doc = await ServiceAccount.findOne({ _id: new Types.ObjectId(id), organizationId: toOrgId(orgId) }).lean();
  if (!doc) throw new Error(SA_NOT_FOUND);
  return doc as unknown as ServiceAccountDocument & { _id: unknown };
}

/** One account of `orgId` as the API returns it. */
export async function getServiceAccount(orgId: string, id: string): Promise<ServiceAccountView> {
  return viewOf(await requireAccount(orgId, id));
}

/**
 * Update an account's description, budget, disabled flag and/or Role set.
 * `roleIds` REPLACES the Role set (through the ceiling); omit it to leave Roles
 * untouched. Disabling stops every exchange immediately without destroying the
 * keys, so a suspected-compromise can be contained and then reversed.
 */
export async function updateServiceAccount(
  orgId: string,
  id: string,
  patch: { description?: string | null; tokenBudget?: number; disabled?: boolean; roleIds?: readonly string[] },
  actor: RoleAssignmentActor,
): Promise<ServiceAccountView> {
  const existing = await requireAccount(orgId, id);

  const set: Record<string, unknown> = {};
  if (patch.description !== undefined) set.description = patch.description?.trim() || null;
  if (patch.tokenBudget !== undefined) set.tokenBudget = normalizeBudget(patch.tokenBudget);
  if (patch.disabled !== undefined) set.disabled = patch.disabled;

  // Roles first: if the ceiling refuses, nothing at all changed.
  if (patch.roleIds !== undefined) {
    await setServiceAccountRoles(orgId, String(existing._id), patch.roleIds, actor);
  }
  if (Object.keys(set).length > 0) {
    await ServiceAccount.updateOne({ _id: existing._id }, { $set: set });
  }
  logger.info('Updated service account', { organizationId: orgId, serviceAccountId: id, fields: Object.keys(set) });
  return viewOf(await requireAccount(orgId, id));
}

/**
 * Delete an account: its Role assignments and every key go with it, so no
 * credential outlives the principal. Idempotent for the caller (a missing
 * account is `SA_NOT_FOUND`).
 */
export async function deleteServiceAccount(orgId: string, id: string): Promise<ServiceAccountView> {
  const existing = await requireAccount(orgId, id);
  const view = await viewOf(existing);
  await apiKeyService.deleteForServiceAccounts([existing._id as Types.ObjectId]);
  await clearServiceAccountRoles(existing._id as Types.ObjectId);
  await ServiceAccount.deleteOne({ _id: existing._id });
  logger.info('Deleted service account', { organizationId: orgId, serviceAccountId: id, name: view.name });
  return view;
}

/**
 * Mint a key for an account. The RAW key is returned ONCE.
 *
 * Enforces the plan's key rules: at most {@link MAX_ACTIVE_KEYS_PER_ACCOUNT}
 * active keys, a lifetime of at most 365 days, and a validated optional IP
 * allowlist. The key inherits NO human assurance (`amr: []`, `aal: 1`).
 */
export async function createServiceAccountKey(
  orgId: string,
  id: string,
  input: CreateServiceAccountKeyInput,
): Promise<{ key: string; view: AccessKeyView }> {
  const account = await requireAccount(orgId, id);
  const expiresInSeconds = input.expiresInSeconds ?? DEFAULT_KEY_EXPIRES_IN_SECONDS;
  if (!Number.isInteger(expiresInSeconds) || expiresInSeconds < 1 || expiresInSeconds > MAX_KEY_EXPIRES_IN_SECONDS) {
    throw new Error(SA_KEY_EXPIRY_INVALID);
  }
  const ipAllowlist = normalizeIpAllowlist(input.ipAllowlist);

  const active = await apiKeyService.countActiveForServiceAccount(String(account._id));
  if (active >= MAX_ACTIVE_KEYS_PER_ACCOUNT) throw new Error(SA_KEY_LIMIT);

  if (input.scope !== undefined && !TOKEN_SCOPES.includes(input.scope)) throw new Error(SA_INVALID_SCOPE);

  return apiKeyService.createForServiceAccount({
    serviceAccountId: account._id as Types.ObjectId,
    organizationId: orgId,
    name: input.name,
    expiresInSeconds,
    ipAllowlist,
    ...(input.scope ? { scope: input.scope } : {}),
    client: input.client,
  });
}

/** Revoke one of an account's keys immediately (`SA_KEY_NOT_FOUND` otherwise). */
export async function revokeServiceAccountKey(orgId: string, id: string, keyId: string): Promise<AccessKeyView> {
  const account = await requireAccount(orgId, id);
  const revoked = await apiKeyService.revokeForServiceAccount(String(account._id), keyId);
  if (!revoked) throw new Error(SA_KEY_NOT_FOUND);
  return revoked;
}

/** Why an exchange of a `pb_sa_` key was refused (audited, never returned). */
export type ServiceAccountExchangeRefusal =
  | 'account_gone'
  | 'account_disabled'
  | 'authority_revoked'
  | 'ip_not_allowed'
  | 'budget_exhausted';

/** A resolved service-account exchange: the claims context plus the account name. */
export interface ServiceAccountExchangeContext {
  ok: true;
  context: ServiceAccountTokenContext;
}

export type ServiceAccountExchangeResult =
  | ServiceAccountExchangeContext
  | { ok: false; reason: ServiceAccountExchangeRefusal };

/**
 * Resolve — and METER — one exchange of a service-account key.
 *
 * Fails CLOSED at every step, in this order: the account exists, is enabled, its
 * org is live, the presenting address is allowed, and the account's own
 * token-exchange budget has room. Only then are the claims derived (Roles →
 * permissions, org → tier/features/hierarchy).
 *
 * The budget consume is a SINGLE atomic pipeline update guarded on the same
 * document, so concurrent exchanges cannot both pass the last slot — the same
 * shape the quota service uses for `incrementUsage`. `$$NOW` makes the period
 * rollover server-side, so a key that idles past the period boundary starts the
 * next one at zero without any sweep.
 */
export async function resolveServiceAccountExchange(
  serviceAccountId: string,
  presentedIp: string | undefined,
  keyIpAllowlist: readonly string[] | undefined | null,
): Promise<ServiceAccountExchangeResult> {
  if (!Types.ObjectId.isValid(serviceAccountId)) return { ok: false, reason: 'account_gone' };
  const account = await ServiceAccount.findById(serviceAccountId).lean();
  if (!account) return { ok: false, reason: 'account_gone' };
  if (account.disabled) return { ok: false, reason: 'account_disabled' };

  if (!ipAllowed(keyIpAllowlist, presentedIp)) return { ok: false, reason: 'ip_not_allowed' };

  const orgId = String(account.organizationId);
  let org: OrgFacts;
  try {
    org = await requireLiveOrg(orgId);
  } catch {
    // Org gone or tombstoned: the account's authority is gone with it.
    return { ok: false, reason: 'authority_revoked' };
  }

  const metered = await consumeExchangeBudget(serviceAccountId);
  if (!metered) return { ok: false, reason: 'budget_exhausted' };

  const roles = await serviceAccountRoles(toOrgId(orgId), serviceAccountId);
  const grants = new Set(roles.map((r) => r.grantsRole));
  const isSuperAdmin = grants.has('superadmin');
  const role: OrgMemberRole = (isSuperAdmin || grants.has('admin')) ? 'admin' : 'member';
  const rolePermissions = [...new Set(roles.flatMap((r) => r.permissions))];

  // Hierarchy + account-level entitlements, resolved exactly as a member's token
  // resolves them (the ROOT is authoritative for a parented team).
  let parentOrganizationId: string | undefined;
  let rootOrganizationId: string | undefined;
  let featureEntitlements = org.featureEntitlements ?? [];
  if (org.parentOrgId) {
    try {
      const lineage = await resolveOrgLineage(orgId);
      if (lineage.parentOrgId) parentOrganizationId = lineage.parentOrgId;
      if (lineage.rootOrgId !== orgId) rootOrganizationId = lineage.rootOrgId;
      const root = await Organization.findById(toOrgId(lineage.rootOrgId)).select('featureEntitlements').lean();
      featureEntitlements = (root as { featureEntitlements?: string[] } | null)?.featureEntitlements ?? featureEntitlements;
    } catch (error) {
      // Degrade to the team doc's own copy rather than collapsing the exchange —
      // same trade-off `accountContext` documents for a member's login.
      logger.warn('Service-account exchange: lineage read failed; using the team doc entitlements', { orgId, error: String(error) });
    }
  }

  return {
    ok: true,
    context: {
      id: serviceAccountId,
      name: account.name,
      organizationId: orgId,
      ...(org.name ? { organizationName: org.name } : {}),
      ...(parentOrganizationId ? { parentOrganizationId } : {}),
      ...(rootOrganizationId ? { rootOrganizationId } : {}),
      tier: org.tier,
      featureEntitlements,
      rolePermissions,
      role,
      isSuperAdmin,
    },
  };
}

/**
 * Atomically consume one unit of an account's exchange budget, rolling the
 * period over when it has lapsed. Returns false when the budget is exhausted
 * (or the account vanished mid-exchange). `-1` is unlimited and still stamps
 * `lastUsedAt` + the usage counter, so the UI can show real traffic.
 */
async function consumeExchangeBudget(serviceAccountId: string): Promise<boolean> {
  const resetDays = config.quota.resetDays;
  const expired = { $lte: ['$usage.resetAt', '$$NOW'] };
  const updated = await ServiceAccount.findOneAndUpdate(
    {
      _id: new Types.ObjectId(serviceAccountId),
      disabled: false,
      $expr: {
        $or: [
          { $eq: ['$tokenBudget', -1] },
          // Period lapsed → this exchange is the first of a fresh period.
          expired,
          { $lt: [{ $ifNull: ['$usage.exchanges', 0] }, '$tokenBudget'] },
        ],
      },
    },
    [{
      $set: {
        'usage.exchanges': { $cond: { if: expired, then: 1, else: { $add: [{ $ifNull: ['$usage.exchanges', 0] }, 1] } } },
        'usage.resetAt': {
          $cond: {
            if: expired,
            then: { $dateAdd: { startDate: '$$NOW', unit: 'day', amount: resetDays } },
            else: '$usage.resetAt',
          },
        },
        'lastUsedAt': '$$NOW',
      },
    }],
    { returnDocument: 'after', updatePipeline: true, projection: { _id: 1 } },
  );
  return !!updated;
}

/**
 * The org-level summary the settings page shows: how many accounts exist, and
 * the explicit statement of the billing rule — service accounts consume NO
 * seats and carry their own exchange budget.
 */
export async function serviceAccountBillingSummary(orgId: string): Promise<{
  accounts: number;
  maxAccounts: number;
  seatsConsumed: 0;
  budgetPeriodDays: number;
}> {
  return {
    accounts: await ServiceAccount.countDocuments({ organizationId: toOrgId(orgId) }),
    maxAccounts: MAX_SERVICE_ACCOUNTS_PER_ORG,
    seatsConsumed: 0,
    budgetPeriodDays: config.quota.resetDays,
  };
}
