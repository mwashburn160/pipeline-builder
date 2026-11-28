// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import type { ApiCore } from '../core';
import type { ApiResponse, OrgAIConfig } from '@/types';

/**
 * Org settings that are neither identity nor security policy: the AI
 * provider configuration, the setup-guide popup state, and the org's support
 * contacts.
 * Composed into `organizationsApi` (./organizations).
 */
export function organizationSettingsApi(core: ApiCore) {
  return {
    getOrgAIConfig: async (opts?: { signal?: AbortSignal }) => {
      return core.request<ApiResponse<OrgAIConfig>>('/api/organization/ai-config', { signal: opts?.signal });
    },

    /** Update org AI provider keys (`provider: key | null`) and/or the org's AI
     *  switch (`aiEnabled`). Step-up-gated server-side (persists provider secrets,
     *  and turns AI on/off for the whole org), so the caller forwards a
     *  `stepUpToken` obtained via StepUpModal. */
    updateOrgAIConfig: async (data: { aiEnabled?: boolean } & Record<string, string | boolean | null | undefined>, stepUpToken?: string) => {
      return core.request<ApiResponse<OrgAIConfig>>('/api/organization/ai-config', {
        method: 'PUT',
        body: JSON.stringify(data),
        headers: core.stepUpHeader(stepUpToken),
      });
    },

    /** GET /organization/:id/setup-guide — whether an admin has dismissed the
     *  "finish setting up" popup for this org (`org_settings:write`). */
    getSetupGuide: async (orgId: string, opts?: { signal?: AbortSignal }) => {
      return core.request<ApiResponse<OrgSetupGuideState>>(`/api/organization/${encodeURIComponent(orgId)}/setup-guide`, { signal: opts?.signal });
    },
    /** PATCH — `dismissed: true` stops the popup for every admin of the org;
     *  `false` re-arms it. A UI preference, so no step-up. */
    updateSetupGuide: async (orgId: string, body: { dismissed: boolean }) => {
      return core.request<ApiResponse<OrgSetupGuideState>>(`/api/organization/${encodeURIComponent(orgId)}/setup-guide`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      });
    },

    /**
     * The org's own support contacts, plus the ACCOUNT's allowance.
     *
     * Two scopes in one payload, deliberately: `contacts` is this org only
     * (ownership is own-org), while `limit`/`used` are the pooled account
     * figures (the allowance pools subtree-wide, like seats). A UI that showed
     * `used` as this org's own count would read as a cap that isn't there.
     */
    listSupportContacts: async (orgId: string, opts?: { signal?: AbortSignal }) => {
      return core.request<ApiResponse<SupportContactsDto>>(
        `/api/organization/${encodeURIComponent(orgId)}/support-contacts`,
        { signal: opts?.signal },
      );
    },
    addSupportContact: async (orgId: string, userId: string, premium = false) => {
      return core.request<ApiResponse<{ userId: string; isPremium: boolean }>>(
        `/api/organization/${encodeURIComponent(orgId)}/support-contacts`,
        { method: 'POST', body: JSON.stringify({ userId, premium }) },
      );
    },
    /**
     * Upgrade or downgrade an existing contact to premium.
     *
     * A separate call from designation because the two answer to different caps
     * and fail for different reasons: designation is bounded by
     * `supportContacts`, this by `supportPremiumContacts`. An admin at the
     * contact cap can still move an upgrade between the people they already
     * have, and conversely.
     */
    setSupportContactLevel: async (orgId: string, userId: string, premium: boolean) => {
      return core.request<ApiResponse<{ userId: string; isPremium: boolean }>>(
        `/api/organization/${encodeURIComponent(orgId)}/support-contacts/${encodeURIComponent(userId)}`,
        { method: 'PATCH', body: JSON.stringify({ premium }) },
      );
    },
    /**
     * Revoke a designation, freeing the slot.
     *
     * Returns the contact's still-OPEN cases rather than refusing the revoke:
     * blocking removal of a departed employee because they still own cases
     * would be worse than handing the cases on, so the caller gets the list to
     * reassign.
     */
    removeSupportContact: async (orgId: string, userId: string) => {
      return core.request<ApiResponse<{ userId: string; openCases: SupportContactOpenCase[] }>>(
        `/api/organization/${encodeURIComponent(orgId)}/support-contacts/${encodeURIComponent(userId)}`,
        { method: 'DELETE' },
      );
    },
  };
}

/** `GET/PATCH /organization/:id/setup-guide`. */
export interface OrgSetupGuideState {
  /** When an admin dismissed the setup popup; null = still to show. */
  dismissedAt: string | null;
  dismissedBy: string | null;
  /** No parent org. Teams share the parent's setup, so they never get the popup. */
  topLevel: boolean;
}

/** One live support contact, as the admin UI lists it. */
export interface SupportContactDto {
  userId: string;
  /** Upgraded to premium: 24×7, the 8-hour any-day target, and the only
   *  contacts who may declare `urgent` severity. */
  isPremium: boolean;
  /** Null when the account is gone — a revoked row is kept as the record that
   *  somebody once held the slot, so the user may no longer resolve. */
  username: string | null;
  email: string | null;
}

/** A case a revoked contact still owns, so the caller can reassign it. */
export interface SupportContactOpenCase {
  threadId: string;
  displayNumber: number;
  status: string;
}

/** The support-contact panel's whole payload. */
export interface SupportContactsDto {
  /** The level held, or null when the account has no support add-on at all. */
  level: string | null;
  /** The POOLED account allowance, and usage across the whole subtree. `-1` is
   *  unlimited. Not this org's own count — see `contacts` for that. */
  limit: number;
  used: number;
  canDesignate: boolean;
  /** Whether the account holds the premium UPGRADE, and for how many contacts.
   *  Separate from the baseline because premium is bought ON TOP of it: the
   *  account holds one baseline covering everyone and upgrades a subset. */
  premium: boolean;
  premiumLimit: number;
  /** Upgrades spent across the account — pooled, like the contact count. */
  premiumUsed: number;
  /** Whether another contact may be upgraded. The premium cap's counterpart to
   *  `canDesignate`. */
  canUpgrade: boolean;
  /** THIS org's contacts only. */
  contacts: SupportContactDto[];
}
