// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import type { AccessKeyMeta } from './auth';
import type { ApiCore } from '../core';
import type { ApiResponse } from '@/types';

/**
 * Org service accounts and their `pb_sa_…` keys.
 * Composed into `organizationsApi` (./organizations).
 */
export function organizationServiceAccountsApi(core: ApiCore) {
  return {
    // ============================================
    // Service accounts: org-owned non-human principals. They hold the org's
    // roles, authenticate with `pb_sa_…` keys, take NO seat, and carry their own
    // token-exchange budget. Every write is step-up gated, like PAT creation.
    // ============================================

    /** List the org's service accounts (each with its roles + key metadata). */
    listServiceAccounts: async (orgId: string, opts?: { signal?: AbortSignal }) => {
      return core.request<ApiResponse<{ serviceAccounts: ServiceAccount[]; billing: ServiceAccountBilling }>>(
        `/api/organization/${encodeURIComponent(orgId)}/service-accounts`,
        { signal: opts?.signal },
      );
    },

    /** GET /organization/:id/service-accounts/:accountId — one account with its
     *  roles, usage and key metadata (never a secret). */
    getServiceAccount: async (orgId: string, accountId: string, opts?: { signal?: AbortSignal }) => {
      return core.request<ApiResponse<{ serviceAccount: ServiceAccount }>>(
        `/api/organization/${encodeURIComponent(orgId)}/service-accounts/${encodeURIComponent(accountId)}`,
        { signal: opts?.signal },
      );
    },

    /** Create a service account. Its roles can't exceed the creator's own permissions. */
    createServiceAccount: async (
      orgId: string,
      data: { name: string; description?: string; roleIds?: string[]; tokenBudget?: number },
      stepUpToken?: string,
    ) => {
      return core.request<ApiResponse<{ serviceAccount: ServiceAccount }>>(`/api/organization/${encodeURIComponent(orgId)}/service-accounts`, {
        method: 'POST',
        headers: core.stepUpHeader(stepUpToken),
        body: JSON.stringify(data),
      });
    },

    /** Update an account. `roleIds` REPLACES the role set; `disabled` is the reversible off-switch. */
    updateServiceAccount: async (
      orgId: string,
      accountId: string,
      data: { description?: string | null; roleIds?: string[]; tokenBudget?: number; disabled?: boolean },
      stepUpToken?: string,
    ) => {
      return core.request<ApiResponse<{ serviceAccount: ServiceAccount }>>(
        `/api/organization/${encodeURIComponent(orgId)}/service-accounts/${encodeURIComponent(accountId)}`,
        { method: 'PATCH', headers: core.stepUpHeader(stepUpToken), body: JSON.stringify(data) },
      );
    },

    /** Delete an account and every key it holds. */
    deleteServiceAccount: async (orgId: string, accountId: string, stepUpToken?: string) => {
      return core.request<ApiResponse<undefined>>(`/api/organization/${encodeURIComponent(orgId)}/service-accounts/${encodeURIComponent(accountId)}`, {
        method: 'DELETE',
        headers: core.stepUpHeader(stepUpToken),
      });
    },

    /**
     * Issue a key. The raw `pb_sa_…` key comes back ONCE and is never retrievable again.
     *
     * `scope` narrows the key to a single capability INSTEAD of the account's
     * roles — `scim` for an identity provider's provisioning client, and the
     * ingest/registry scopes for the machine surfaces that use them. A scoped key
     * carries no permissions at all, so it can do that one thing and nothing else.
     */
    createServiceAccountKey: async (
      orgId: string,
      accountId: string,
      data: { name: string; expiresIn?: number; ipAllowlist?: string[]; scope?: string },
      stepUpToken?: string,
    ) => {
      return core.request<ApiResponse<{ key: string; accessKey: AccessKeyMeta }>>(
        `/api/organization/${encodeURIComponent(orgId)}/service-accounts/${encodeURIComponent(accountId)}/keys`,
        // The key is shown once: never replayed by the global dialog.
        { method: 'POST', replayOnStepUp: false, headers: core.stepUpHeader(stepUpToken), body: JSON.stringify(data) },
      );
    },

    /** Revoke one key immediately — it stops working everywhere within 5 minutes. */
    revokeServiceAccountKey: async (orgId: string, accountId: string, keyId: string) => {
      return core.request<ApiResponse<{ revoked: boolean }>>(
        `/api/organization/${encodeURIComponent(orgId)}/service-accounts/${encodeURIComponent(accountId)}/keys/${encodeURIComponent(keyId)}`,
        { method: 'DELETE' },
      );
    },
  };
}

/**
 * An org SERVICE ACCOUNT: a non-human principal owned by the org. It holds the
 * org's roles, signs in with nothing (only `pb_sa_…` keys), consumes NO seat,
 * and has its own per-period token-exchange budget.
 */
export interface ServiceAccount {
  id: string;
  organizationId: string;
  name: string;
  description: string | null;
  roles: Array<{ id: string; name: string; permissions: string[] }>;
  /** Effective permissions — the union of its roles'. */
  permissions: string[];
  /** Token exchanges allowed per period; -1 = unlimited. */
  tokenBudget: number;
  usage: { exchanges: number; resetAt: string };
  disabled: boolean;
  createdBy: string | null;
  createdByEmail: string | null;
  createdAt: string;
  lastUsedAt: string | null;
  keys: AccessKeyMeta[];
  /** Always 0 — service accounts take no seat. */
  seatsConsumed: 0;
}

/** Org-level service-account facts the settings page states explicitly. */
export interface ServiceAccountBilling {
  accounts: number;
  maxAccounts: number;
  /** Always 0 — service accounts never consume seats. */
  seatsConsumed: 0;
  /** Length of the token-exchange budget period, in days. */
  budgetPeriodDays: number;
}
