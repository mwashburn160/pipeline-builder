// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import type { ApiCore } from '../core';
import type { ApiResponse, OrgMfaPolicy, OrgPasswordPolicy, OrgAuthenticatorPolicy, OrgSessionPolicy, MfaResetRequest } from '@/types';

/**
 * Org security policies: impersonation, two-factor (and the two-person MFA
 * reset), password, session lifetime and the passkey-model allowlist.
 * Composed into `organizationsApi` (./organizations).
 */
export function organizationPoliciesApi(core: ApiCore) {
  return {
    /** The org's impersonation policy: its OWN setting and the EFFECTIVE one. A
     *  team's policy can be tightened by its parent (strictest wins), so the UI
     *  must show both or an admin who set `open` can't tell why it isn't. */
    getImpersonationPolicy: async (orgId: string, opts?: { signal?: AbortSignal }) => {
      return core.request<ApiResponse<EffectiveImpersonationPolicyDto>>(`/api/organization/${encodeURIComponent(orgId)}/impersonation-policy`, { signal: opts?.signal });
    },
    /** Change the policy. Step-up gated: loosening it widens who can see the org's data. */
    updateImpersonationPolicy: async (
      orgId: string,
      body: { impersonationPolicy?: ImpersonationPolicy; allowSelfApproval?: boolean },
      stepUpToken?: string,
    ) => {
      return core.request<ApiResponse<EffectiveImpersonationPolicyDto>>(`/api/organization/${encodeURIComponent(orgId)}/impersonation-policy`, {
        method: 'PATCH',
        body: JSON.stringify(body),
        headers: core.stepUpHeader(stepUpToken),
      });
    },

    /** The org's two-factor requirement: its OWN setting and what actually
     *  governs, since a parent org's requirement also applies to its teams. */
    getMfaPolicy: async (orgId: string, opts?: { signal?: AbortSignal }) => {
      return core.request<ApiResponse<OrgMfaPolicy>>(`/api/organization/${encodeURIComponent(orgId)}/mfa-policy`, { signal: opts?.signal });
    },

    /** GET /organization/:id/password-policy — the org's minimum password length
     *  (own and effective, with the platform floor and ceiling). */
    getPasswordPolicy: async (orgId: string, opts?: { signal?: AbortSignal }) => {
      return core.request<ApiResponse<OrgPasswordPolicy>>(`/api/organization/${encodeURIComponent(orgId)}/password-policy`, { signal: opts?.signal });
    },
    /** PATCH — `minLength: null` clears the org's own minimum. Step-up gated;
     *  LOWERING it also needs a session opened with a second factor. */
    updatePasswordPolicy: async (orgId: string, body: { minLength: number | null }, stepUpToken?: string) => {
      return core.request<ApiResponse<OrgPasswordPolicy>>(`/api/organization/${encodeURIComponent(orgId)}/password-policy`, {
        method: 'PATCH',
        body: JSON.stringify(body),
        headers: core.stepUpHeader(stepUpToken),
      });
    },

    /** GET /organization/:id/session-policy — the interactive-session lifetime
     *  (maximum age in days / idle timeout in minutes): effective, the org's own, the
     *  platform ceiling, and any stricter ancestor. */
    getSessionPolicy: async (orgId: string, opts?: { signal?: AbortSignal }) => {
      return core.request<ApiResponse<OrgSessionPolicy>>(`/api/organization/${encodeURIComponent(orgId)}/session-policy`, { signal: opts?.signal });
    },
    /** PATCH — `maxAgeDays` 1–365 days, `idleTimeoutMinutes` whole minutes from
     *  5 up to the platform ceiling; `null` clears a field, absent = unchanged (at
     *  least one must be sent). Step-up gated; LENGTHENING (a bound raised or
     *  cleared) also needs a session opened with a second factor. */
    updateSessionPolicy: async (
      orgId: string,
      body: { maxAgeDays?: number | null; idleTimeoutMinutes?: number | null },
      stepUpToken?: string,
    ) => {
      return core.request<ApiResponse<OrgSessionPolicy>>(`/api/organization/${encodeURIComponent(orgId)}/session-policy`, {
        method: 'PATCH',
        body: JSON.stringify(body),
        headers: core.stepUpHeader(stepUpToken),
      });
    },

    /** GET /organization/:id/authenticator-policy — the passkey-model allowlist,
     *  the FIDO MDS catalog for naming models, and members' compliance. */
    getAuthenticatorPolicy: async (orgId: string, opts?: { signal?: AbortSignal }) => {
      return core.request<ApiResponse<OrgAuthenticatorPolicy>>(`/api/organization/${encodeURIComponent(orgId)}/authenticator-policy`, { signal: opts?.signal });
    },
    /** PATCH — an empty list clears it (any model). Step-up gated; WIDENING or
     *  clearing an existing list also needs a session opened with a second factor. */
    updateAuthenticatorPolicy: async (orgId: string, body: { allowedAaguids: string[] }, stepUpToken?: string) => {
      return core.request<ApiResponse<OrgAuthenticatorPolicy>>(`/api/organization/${encodeURIComponent(orgId)}/authenticator-policy`, {
        method: 'PATCH',
        body: JSON.stringify(body),
        headers: core.stepUpHeader(stepUpToken),
      });
    },
    /**
     * Turn the requirement on or off, set the grace period, or record that the
     * org's identity provider enforces MFA.
     *
     * `graceDays` only applies while turning the requirement ON — the deadline is
     * computed server-side from it, so the client never posts a date. Step-up
     * gated. LOOSENING (requirement off, admin-actions policy off, "our IdP
     * enforces MFA" on) also needs a session opened with a second factor — a
     * single-factor session gets 401 `MFA_REQUIRED`, which the shell turns into
     * the enrol / sign-in-again dialog. Changing `adminActionsRequireMfa` ends
     * every other member's session so the change applies at once.
     */
    updateMfaPolicy: async (
      orgId: string,
      body: { requireMfa?: boolean; graceDays?: number; idpEnforcesMfa?: boolean; adminActionsRequireMfa?: boolean },
      stepUpToken?: string,
    ) => {
      return core.request<ApiResponse<OrgMfaPolicy>>(`/api/organization/${encodeURIComponent(orgId)}/mfa-policy`, {
        method: 'PATCH',
        body: JSON.stringify(body),
        headers: core.stepUpHeader(stepUpToken),
      });
    },

    // -- MFA recovery: the two-person reset -------------------------------------

    /** Pending (first) and recently decided MFA reset requests for the org and
     *  its teams. Owner/admin only. */
    listMfaResets: async (orgId: string, opts?: { signal?: AbortSignal }) => {
      return core.request<ApiResponse<{ requests: MfaResetRequest[] }>>(`/api/organization/${encodeURIComponent(orgId)}/mfa-resets`, { signal: opts?.signal });
    },
    /** Ask for a member's second factors to be reset. Needs a session opened
     *  with a second factor and a step-up; ANOTHER admin must approve it. */
    requestMfaReset: async (orgId: string, body: { userId: string; reason: string }, stepUpToken?: string) => {
      return core.request<ApiResponse<{ request: MfaResetRequest }>>(`/api/organization/${encodeURIComponent(orgId)}/mfa-resets`, {
        method: 'POST',
        body: JSON.stringify(body),
        headers: core.stepUpHeader(stepUpToken),
      });
    },
    /** Approve someone else's request — removes the member's factors and recovery
     *  codes, ends their sessions and grants an enrolment grace. Needs a step-up
     *  earned with a passkey or an authenticator code. */
    approveMfaReset: async (orgId: string, requestId: string, body: { graceHours?: number }, stepUpToken?: string) => {
      return core.request<ApiResponse<{ request: MfaResetRequest }>>(`/api/organization/${encodeURIComponent(orgId)}/mfa-resets/${encodeURIComponent(requestId)}/approve`, {
        method: 'POST',
        body: JSON.stringify(body),
        headers: core.stepUpHeader(stepUpToken),
      });
    },
    /** Deny a request (or, as its requester, withdraw it). */
    denyMfaReset: async (orgId: string, requestId: string, body: { note?: string } = {}) => {
      return core.request<ApiResponse<{ request: MfaResetRequest }>>(`/api/organization/${encodeURIComponent(orgId)}/mfa-resets/${encodeURIComponent(requestId)}/deny`, {
        method: 'POST',
        body: JSON.stringify(body),
      });
    },
  };
}

export type ImpersonationPolicy = 'open' | 'consent' | 'denied';

/** Resolved impersonation policy — never re-derive defaults or inheritance client-side. */
export interface EffectiveImpersonationPolicyDto {
  policy: ImpersonationPolicy;
  allowSelfApproval: boolean;
  /** The org's own stored setting, before a parent's policy is applied. */
  own: { policy: ImpersonationPolicy; allowSelfApproval: boolean };
  /** Set when a parent org forces a stricter policy than `own`. */
  inheritedFrom?: string;
  /** Display name of `inheritedFrom`, when resolvable. */
  inheritedFromName?: string;
  /** False when the parent couldn't be read; the policy is then the strictest. */
  resolved: boolean;
}
