// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from '@simplewebauthn/browser';
import type { ApiCore } from '../core';
import type { ApiResponse, MfaChallenge, Passkey, PasswordChangeChallenge, ReauthProvider, RecoveryCodeStatus, TotpEnrolment, TotpStatus, User, UserPreferences } from '@/types';

/**
 * One of the caller's sessions: a signed-in device (`interactive`) or a stored
 * machine credential minted by generate-token (`machine`).
 */
export interface SessionMeta {
  id: string;
  kind: 'interactive' | 'machine';
  createdAt: string;
  /** Last refresh / org switch — for a machine session, the last renewal. */
  lastUsedAt: string;
  /** When the sign-in behind the session happened (never reset by renewal). */
  signedInAt: string;
  /** Short client summary ("Chrome on macOS"), or null when unknown. */
  userAgent: string | null;
  /** Last IP the session was used from (kept only for the session's life). */
  lastIp: string | null;
  /** Capability scope of a machine credential (e.g. `reporting:ingest`). */
  scope: string | null;
  /** Permission subset of a machine credential; null = full permissions. */
  permissions: string[] | null;
  /** Authentication methods of the sign-in (`pwd`, `oauth`, `sso`). */
  amr: string[];
  /** True for the session making the request — it can't revoke itself. */
  current: boolean;
}

/** One entry of `GET /user/tokens`: when a token was issued, when it lapses,
 *  and its status now (`revoked` = a sign-out-everywhere bumped past it). */
export interface TokenHistoryEntry {
  id: string;
  createdAt: string;
  expiresAt: string;
  status: 'active' | 'expired' | 'revoked';
}

/**
 * Access-key metadata (never the secret — the key itself is shown once, at
 * creation, and only its hash is stored).
 *
 * `kind` is `personal` for a person's key (`pb_pat_…`) and `service_account`
 * for an org service account's (`pb_sa_…`); both land in the same list, which is
 * why the shape carries the discriminator rather than assuming one owner type.
 */
export interface AccessKeyMeta {
  /** Record id — the revoke handle, and the `jti` of tokens exchanged from it. */
  id: string;
  name: string;
  prefix: string;
  /** Display-only fragment, e.g. `pb_pat_…a1b2`. */
  display: string;
  kind: 'personal' | 'service_account';
  /** Owning service account (service-account keys only). */
  serviceAccountId: string | null;
  /** Owning service account's name, for labelling a mixed key list. */
  serviceAccountName: string | null;
  scope: string | null;
  /** "Selected permissions" — the key's catalog subset; null = "Full access"
   *  (the owner's current permissions). Never more than the owner holds. */
  permissions: string[] | null;
  organizationId: string | null;
  /** Addresses/CIDRs the key may be exchanged from; null = any. */
  ipAllowlist: string[] | null;
  createdAt: string;
  expiresAt: string;
  lastUsedAt: string | null;
  /** Where the key was created ("pipeline-manager CLI on macOS"), or null. */
  createdFrom: string | null;
  createdIp: string | null;
  revoked: boolean;
  status: 'active' | 'expired' | 'revoked';
  /** Never exchanged — a candidate to clean up. */
  neverUsed: boolean;
  /** Active, but expires within 14 days. */
  expiringSoon: boolean;
}

/**
 * A pending device-authorization request, as the approval page sees it. Never
 * carries the device code — only what the person needs to recognise the device
 * they are about to hand a session to.
 */
export interface DeviceAuthorizationRequest {
  /** The code as displayed, e.g. `BCDF-GHJK`. */
  userCode: string;
  /** Short client summary ("pipeline-manager CLI on macOS"), or null. */
  client: string | null;
  /** IP the device asked from, or null. */
  ip: string | null;
  requestedAt: string;
  expiresAt: string;
  /** The device also asked for a step-up token (it intends to create a key). */
  stepUpRequested: boolean;
}

export function authApi(core: ApiCore) {
  return {
    // ============================================
    // Config endpoints (public)
    // ============================================

    /** Get platform service feature flags (public, no auth required). */
    getConfig: async () => {
      return core.request<ApiResponse<{
        serviceFeatures: Record<string, boolean>;
        supportAlias?: string;
        supportAliases?: string[];
        deployTarget?: string;
        /** Effective per-tier quota presets (honors QUOTA_TIER_* env overrides).
         *  Keyed by tier → the four displayed flow dimensions. */
        tierPresets?: Record<string, { plugins: number; pipelines: number; apiCalls: number; aiCalls: number }>;
      }>>('/api/config');
    },

    // ============================================
    // Auth endpoints
    // ============================================
    /**
     * POST /auth/login.
     *
     * Two outcomes share one response: the usual `{ accessToken }`, or — for an
     * account with an authenticator app — `{ mfaRequired: true, challengeId }`
     * and NO token. `applyTokens` ignores the second (there is nothing to
     * apply), so the caller must branch on `mfaRequired` and follow up with
     * `verifyMfaLogin` rather than assume a session exists.
     *
     * A third, rare shape carries `mfaEnrollmentPending: true` ALONGSIDE a real
     * token (#8): the install's bootstrap administrator, who has no factor yet.
     * The session is genuine but reaches only enrolment, sign-out and the setup
     * routes, so the caller sends them straight to enrolment rather than to a
     * dashboard that would answer 403 on every panel.
     */
    login: async (email: string, password: string) => {
      const response = await core.request<ApiResponse<{ accessToken?: string; expiresIn?: number; mfaEnrollmentPending?: boolean } & Partial<MfaChallenge> & Partial<PasswordChangeChallenge>>>('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ identifier: email, password }),
      });
      core.applyTokens(response as ApiResponse<{ accessToken: string; expiresIn?: number }>);
      return response;
    },

    /** POST /auth/mfa/verify — second leg of a password sign-in: the challenge
     *  handle plus a code from the authenticator app (or a recovery code).
     *  Establishes exactly the session `login` would have. */
    verifyMfaLogin: async (body: { challengeId: string; code: string }) => {
      const response = await core.request<ApiResponse<{ accessToken?: string; expiresIn?: number; recoveryCodesRemaining?: number } & Partial<PasswordChangeChallenge>>>(
        '/api/auth/mfa/verify',
        { method: 'POST', body: JSON.stringify(body) },
      );
      core.applyTokens(response as ApiResponse<{ accessToken: string; expiresIn?: number }>);
      return response;
    },

    /**
     * POST /auth/password/change-required — the last leg of a password sign-in
     * whose password no longer meets the org password policy: the challenge
     * handle plus a NEW password → the session the sign-in would have opened.
     */
    completeRequiredPasswordChange: async (body: { challengeId: string; newPassword: string }) => {
      const response = await core.request<ApiResponse<{ accessToken: string; expiresIn?: number; mfaEnrollmentPending?: boolean }>>(
        '/api/auth/password/change-required',
        { method: 'POST', body: JSON.stringify(body) },
      );
      core.applyTokens(response);
      return response;
    },

    /** `invitationToken` when registering to accept an invitation: the inviting
     *  org's password policy then applies to the new password. */
    register: async (username: string, email: string, password: string, organizationName?: string, planId?: string, invitationToken?: string) => {
      return core.request<ApiResponse<{ user: User }>>('/api/auth/register', {
        method: 'POST',
        body: JSON.stringify({ username, email, password, organizationName, planId, ...(invitationToken ? { invitationToken } : {}) }),
      });
    },

    /** POST /auth/onboarding/complete — finish first-run onboarding for a
     *  social-signup user: name the auto-created org and optionally pick a plan,
     *  clearing the `needsOnboarding` flag. */
    completeOnboarding: async (params: { organizationName?: string; planId?: string } = {}) => {
      return core.request<ApiResponse<{ organizationId: string; organizationName: string }>>('/api/auth/onboarding/complete', {
        method: 'POST',
        body: JSON.stringify(params),
      });
    },

    /** GET /auth/onboarding/domain-orgs — orgs the user could join by verified email domain. */
    getDomainOrgs: async () => {
      return core.request<ApiResponse<{ orgs: Array<{ orgId: string; orgName: string; autoJoin: 'off' | 'request' | 'auto' }> }>>('/api/auth/onboarding/domain-orgs');
    },

    /** POST /auth/onboarding/join — auto-join or request to join a domain-discovered org. */
    joinDomainOrg: async (orgId: string) => {
      return core.request<ApiResponse<{ status: 'joined' | 'requested' | 'already-member' | 'denied' }>>('/api/auth/onboarding/join', {
        method: 'POST',
        body: JSON.stringify({ orgId }),
      });
    },

    /**
     * Sign out. When the session came from a SAML sign-in and the org's IdP has
     * a Single Logout URL, the platform returns a signed LogoutRequest redirect
     * (`POST /auth/sso/logout`, asked BEFORE the session ends — it needs it);
     * after the local sign-out the browser is sent there, so the person is also
     * signed out of their identity provider, which then returns them to the
     * sign-in page. Otherwise sign-out stays local. Best-effort: a failed SLO
     * lookup never blocks signing out.
     */
    logout: async () => {
      let sloUrl: string | null = null;
      try {
        const slo = await core.request<ApiResponse<{ redirectUrl: string | null }>>('/api/auth/sso/logout', { method: 'POST' });
        sloUrl = slo.data?.redirectUrl ?? null;
      } catch {
        sloUrl = null;
      }
      try {
        await core.request('/api/auth/logout', { method: 'POST' });
      } finally {
        core.clearTokens();
      }
      if (sloUrl && typeof window !== 'undefined') window.location.assign(sloUrl);
    },

    getProfile: async () => {
      return core.request<ApiResponse<{ user: User }>>('/api/user/profile');
    },

    /** Switch active organization and re-issue tokens. */
    switchOrganization: async (organizationId: string) => {
      const result = await core.request<ApiResponse<{ accessToken: string; expiresIn: number }>>('/api/auth/switch-org', {
        method: 'POST',
        body: JSON.stringify({ organizationId }),
      });
      // A 2xx without a token would leave the session in the OLD org while the
      // caller reports a switch — fail loudly instead.
      if (!result.data?.accessToken) throw new Error(result.message || 'Could not switch organization');
      core.setTokens({ accessToken: result.data.accessToken, expiresIn: result.data.expiresIn });
      return result;
    },

    /** List all organizations the current user belongs to. */
    getUserOrganizations: async () => {
      return core.request<ApiResponse<{ organizations: Array<{ organizationId: string; organizationName: string; slug?: string; role: string; joinedAt: string; parentOrgId?: string; parentOrgName?: string; tier?: string; childOrgCount: number; viaAncestor?: boolean }> }>>('/api/user/organizations');
    },

    /**
     * Create a new organization. The authenticated user becomes the owner.
     * Pass `parentOrgId` to create it as a team nested under that org (the caller
     * must be an admin/owner of the parent).
     */
    createOrganization: async (data: { name: string; description?: string; tier?: 'developer' | 'pro' | 'team' | 'enterprise'; parentOrgId?: string }) => {
      return core.request<ApiResponse<{ organization: { id: string; name: string; slug: string; description: string; tier: string; parentOrgId?: string } }>>('/api/organization', {
        method: 'POST',
        body: JSON.stringify(data),
      });
    },

    updateProfile: async (data: { username?: string; email?: string }) => {
      return core.request<ApiResponse<{ user: User }>>('/api/user/profile', {
        method: 'PATCH',
        body: JSON.stringify(data),
      });
    },

    /** Send (or re-send) an email-verification link to the current user
     *  (POST /auth/send-verification, authenticated, no body). The link points
     *  at `/auth/verify-email?token=…`. Returns 200 even when already verified. */
    sendVerificationEmail: async () => {
      return core.request<ApiResponse<undefined>>('/api/auth/send-verification', {
        method: 'POST',
      });
    },

    /** Directly mark the current user's email verified WITHOUT the emailed link
     *  (POST /auth/mark-email-verified, authenticated). Server-gated to
     *  admin/owner/superadmin; a non-privileged caller gets 403. */
    markEmailVerified: async () => {
      return core.request<ApiResponse<undefined>>('/api/auth/mark-email-verified', {
        method: 'POST',
      });
    },

    /** Verify an email address with the token from the emailed link
     *  (POST /auth/verify-email, public). Body is `{ token }`. */
    verifyEmail: async (token: string) => {
      return core.request<ApiResponse<undefined>>('/api/auth/verify-email', {
        method: 'POST',
        body: JSON.stringify({ token }),
      });
    },

    /** POST /user/change-password. Step-up gated server-side (changing the
     *  password of a left-open session is exactly the takeover step-up exists to
     *  stop), so the UI confirms in a StepUpModal and forwards its token. */
    changePassword: async (currentPassword: string, newPassword: string, stepUpToken?: string) => {
      return core.request<ApiResponse<{ message: string }>>('/api/user/change-password', {
        method: 'POST',
        headers: core.stepUpHeader(stepUpToken),
        body: JSON.stringify({ currentPassword, newPassword }),
      });
    },

    deleteAccount: async (stepUpToken?: string) => {
      const response = await core.request<ApiResponse<{ message: string }>>('/api/user/account', {
        method: 'DELETE',
        headers: core.stepUpHeader(stepUpToken),
      });
      core.clearTokens();
      return response;
    },

    /**
     * POST /user/generate-token — mint a stored MACHINE credential (CLI / CI /
     * automation). It opens its own machine session, so it never replaces or
     * disturbs the caller's browser session; the token is returned once and is
     * renewed by calling this endpoint with the token itself (there is no
     * refresh token — machine sessions are not refreshable).
     */
    generateNewToken: async (body?: { expiresIn?: number; scope?: string; permissions?: string[] }) => {
      return core.request<ApiResponse<{ accessToken: string; expiresIn: number }>>(
        '/api/user/generate-token',
        { method: 'POST', body: JSON.stringify(body ?? {}) },
      );
    },

    /** GET /user/sessions — signed-in devices + stored machine credentials. */
    listSessions: async () => {
      return core.request<ApiResponse<{ sessions: SessionMeta[]; machineSessions: SessionMeta[] }>>('/api/user/sessions');
    },

    /** DELETE /user/sessions/:id — sign one device out, or stop a machine
     *  credential from renewing. Step-up gated; the current session is refused. */
    revokeSession: async (id: string, stepUpToken?: string) => {
      return core.request<ApiResponse<{ revoked: boolean }>>(`/api/user/sessions/${encodeURIComponent(id)}`, {
        method: 'DELETE',
        headers: core.stepUpHeader(stepUpToken),
      });
    },

    /** GET /user/tokens — recent token-issuance history with computed status. */
    listTokenHistory: async (opts?: { signal?: AbortSignal }) => {
      return core.request<ApiResponse<{ tokens: TokenHistoryEntry[] }>>('/api/user/tokens', { signal: opts?.signal });
    },

    /** POST /user/keys — create a named access key. The raw `pb_pat_…` key comes
     *  back ONCE and is never retrievable again (only its hash is stored).
     *  Step-up gated: pass the token from a StepUpModal via `X-Step-Up-Token`. */
    createAccessKey: async (body: { name: string; expiresIn?: number; scope?: string; permissions?: string[] }, stepUpToken?: string) => {
      return core.request<ApiResponse<{ key: string; accessKey: AccessKeyMeta }>>('/api/user/keys', {
        method: 'POST',
        headers: core.stepUpHeader(stepUpToken),
        body: JSON.stringify(body),
      });
    },

    /** GET /user/keys — list the user's access keys (metadata only). */
    listAccessKeys: async () => {
      return core.request<ApiResponse<{ keys: AccessKeyMeta[] }>>('/api/user/keys');
    },

    /** DELETE /user/keys/:id — revoke a single access key immediately. Its next
     *  exchange fails, so it stops working on every service within 5 minutes. */
    revokeAccessKey: async (id: string) => {
      return core.request<ApiResponse<{ revoked: boolean }>>(`/api/user/keys/${encodeURIComponent(id)}`, {
        method: 'DELETE',
      });
    },

    /** GET /user/preferences — server-persisted favorites/recents for the active org. */
    getPreferences: async () => {
      return core.request<ApiResponse<{ preferences: UserPreferences }>>('/api/user/preferences');
    },

    /** PUT /user/preferences — update favorites, recents and/or notification preferences for the active org. */
    updatePreferences: async (patch: { favorites?: string[]; recents?: string[]; notifications?: Partial<UserPreferences['notifications']> }) => {
      return core.request<ApiResponse<{ preferences: UserPreferences }>>('/api/user/preferences', {
        method: 'PUT',
        body: JSON.stringify(patch),
      });
    },

    /** POST /user/tokens/revoke-all — sign out everywhere (bumps tokenVersion). Re-issues a fresh token for the active session.
     *  Step-up gated — a stolen session can otherwise lock the legitimate user out. */
    revokeAllTokens: async (stepUpToken?: string) => {
      const response = await core.request<ApiResponse<{ revoked: boolean; accessToken: string; expiresIn: number }>>(
        '/api/user/tokens/revoke-all',
        { method: 'POST', headers: core.stepUpHeader(stepUpToken) },
      );
      core.applyTokens(response);
      return response;
    },

    // ============================================
    // Device authorization (RFC 8628) — the browser half of `pipeline-manager
    // auth login`. The CLI never sees a credential: it shows a code, the person
    // approves it here in a normal (SSO-, step-up- and later MFA-protected)
    // browser session, and the CLI collects a session on its next poll.
    // ============================================

    /** GET /auth/device/authorize — what the waiting device is asking for.
     *  404 = unrecognised code, 410 = expired, 409 = already decided. */
    getDeviceAuthorization: async (userCode: string) => {
      return core.request<ApiResponse<{ request: DeviceAuthorizationRequest }>>(
        `/api/auth/device/authorize?user_code=${encodeURIComponent(userCode)}`,
      );
    },

    /** POST /auth/device/approve — grant the device a session. Step-up gated:
     *  pass the token from a StepUpModal via `X-Step-Up-Token`. */
    approveDeviceAuthorization: async (userCode: string, stepUpToken?: string) => {
      return core.request<ApiResponse<{ approved: boolean; request: DeviceAuthorizationRequest }>>(
        '/api/auth/device/approve',
        { method: 'POST', headers: core.stepUpHeader(stepUpToken), body: JSON.stringify({ userCode }) },
      );
    },

    /** POST /auth/device/deny — refuse the device. No step-up: refusing is the
     *  safe direction, and a code you did not start must be easy to shut down. */
    denyDeviceAuthorization: async (userCode: string) => {
      return core.request<ApiResponse<{ denied: boolean }>>('/api/auth/device/deny', {
        method: 'POST',
        body: JSON.stringify({ userCode }),
      });
    },

    // ============================================
    // OAuth / SSO login
    //
    // Session establishment is IDENTICAL to password login: the callback
    // endpoint returns the same session `{ accessToken }` (plus refresh cookie) issued by
    // `issueTokens`, so `completeOAuthCallback` funnels it through the same
    // `core.applyTokens(...)` used by `login`. There is no parallel auth path.
    //
    // CSRF `state` is minted + stored server-side by `getOAuthUrl`; the provider
    // echoes it back on the redirect and the callback simply forwards it. There
    // is no PKCE and the `/url` endpoint accepts no query params (the redirect_uri
    // is fixed server-side to `{frontend}/auth/callback/:provider`).
    // ============================================

    /** GET /auth/oauth/providers — list enabled OAuth providers (public). Returns
     *  `{ providers: [] }` (or 404) when none are configured; callers render nothing. */
    listOAuthProviders: async () => {
      return core.request<ApiResponse<{ providers: string[] }>>('/api/auth/oauth/providers');
    },

    /** GET /auth/oauth/:provider/url — get the provider authorize URL to redirect the
     *  browser to. The backend mints + stores the CSRF `state` and returns it alongside
     *  the URL. `opts` is reserved: the endpoint takes no query params today (redirect_uri
     *  is fixed server-side), so nothing is forwarded. */
    getOAuthUrl: async (provider: string, _opts?: Record<string, string>) => {
      return core.request<ApiResponse<{ url: string; state: string }>>(
        `/api/auth/oauth/${encodeURIComponent(provider)}/url`,
      );
    },

    /** POST /auth/oauth/:provider/callback — exchange the provider's `code`/`state`
     *  for a session. Returns the SAME token shape as password login; tokens are
     *  applied via `core.applyTokens` exactly like `login` (refresh token: cookie). */
    completeOAuthCallback: async (provider: string, params: { code: string; state: string }) => {
      const response = await core.request<ApiResponse<{ accessToken: string; expiresIn?: number }>>(
        `/api/auth/oauth/${encodeURIComponent(provider)}/callback`,
        { method: 'POST', body: JSON.stringify({ code: params.code, state: params.state }) },
      );
      core.applyTokens(response);
      return response;
    },

    // ============================================
    // Per-org enterprise SSO (OIDC and SAML 2.0).
    //
    // ONE entry point for both protocols: `getSsoUrl` returns the URL to
    // redirect to whichever the org federates over. Where the browser comes
    // BACK to is what differs — OIDC returns to `/auth/sso/:orgId/callback`
    // with a code, SAML posts its assertion to a server-side ACS which then
    // redirects to `/auth/sso/:orgId/saml` with a one-time handoff. That
    // handoff is redeemed below, and the session it produces is the SAME shape
    // password login returns, applied through the same `core.applyTokens`.
    // ============================================

    /** POST /auth/sso/discover — does an enabled, entitled org IdP SERVE this
     *  email's DOMAIN (`sso`), and does the org REQUIRE it (`required`)? Two
     *  booleans and nothing else: it is unauthenticated, so it deliberately
     *  reveals neither the org behind the domain nor whether the address has an
     *  account (nor whether it belongs to an owner, who is exempt). The sign-in
     *  form asks it while the person is typing, so callers debounce and treat a
     *  failure as "no SSO" — the password path still refuses a covered account. */
    discoverSso: async (email: string) => {
      return core.request<ApiResponse<{ sso: boolean; required: boolean }>>('/api/auth/sso/discover', {
        method: 'POST',
        body: JSON.stringify({ email }),
      });
    },

    /** POST /auth/sso/start — begin the flow from an EMAIL, for the sign-in form,
     *  which knows the address and not the org. Same `{ url, state }` as the
     *  by-org route below; resolving the org happens server-side so discovery
     *  never has to hand out an org id. 404 `SSO_NOT_AVAILABLE` when no org
     *  federates the domain. */
    startSsoByEmail: async (email: string) => {
      return core.request<ApiResponse<{ url: string; state: string }>>('/api/auth/sso/start', {
        method: 'POST',
        body: JSON.stringify({ email }),
      });
    },

    /** GET /auth/sso/:orgId/authorize — the IdP redirect URL for this org, on
     *  whichever protocol it uses. The CSRF `state` is minted + stored
     *  server-side and is single-use. Used where the org is already known: a
     *  password attempt refused with `SSO_REQUIRED` names it, as does a step-up. */
    getSsoUrl: async (orgId: string) => {
      return core.request<ApiResponse<{ url: string; state: string }>>(
        `/api/auth/sso/${encodeURIComponent(orgId)}/authorize`,
      );
    },

    /** POST /auth/sso/:orgId/callback — OIDC leg: exchange the IdP's code for a
     *  session. */
    completeSsoCallback: async (orgId: string, params: { code: string; state: string }) => {
      const response = await core.request<ApiResponse<{ accessToken: string; expiresIn?: number }>>(
        `/api/auth/sso/${encodeURIComponent(orgId)}/callback`,
        { method: 'POST', body: JSON.stringify(params) },
      );
      core.applyTokens(response);
      return response;
    },

    /** POST /auth/sso/:orgId/saml/complete — SAML leg: redeem the one-time
     *  handoff the ACS put in the landing URL. The assertion was already
     *  verified server-side; this call is what mints the session, so it carries
     *  this browser's client info and the refresh-cookie transport. */
    completeSamlLogin: async (orgId: string, handoff: string) => {
      const response = await core.request<ApiResponse<{ accessToken: string; expiresIn?: number }>>(
        `/api/auth/sso/${encodeURIComponent(orgId)}/saml/complete`,
        { method: 'POST', body: JSON.stringify({ handoff }) },
      );
      core.applyTokens(response);
      return response;
    },

    // ============================================
    // Step-up auth — re-verify password before destructive admin actions.
    // Returns a 60s-TTL token bound to the user's sub. Callers forward it
    // via `X-Step-Up-Token` on the next destructive request; backend
    // `requireStepUp` middleware enforces it.
    // ============================================
    stepUpVerify: async (password: string) => {
      return core.request<ApiResponse<{ ok: boolean; stepUpToken: string; expiresAt: number; method: 'password' }>>('/api/auth/step-up', {
        method: 'POST',
        body: JSON.stringify({ password }),
      });
    },

    /** POST /auth/step-up/reauth — start a step-up by signing in again with one of
     *  the user's own providers (the only step-up an account with no password has).
     *  Returns the provider authorize URL to open; the CSRF `state` is stored
     *  server-side, bound to the caller and single-use. */
    startStepUpReauth: async (option: ReauthProvider) => {
      const body = option.type === 'oauth'
        ? { type: 'oauth', provider: option.provider }
        : { type: 'sso', orgId: option.orgId };
      return core.request<ApiResponse<{ url: string; state: string; expiresAt: number }>>('/api/auth/step-up/reauth', {
        method: 'POST',
        body: JSON.stringify(body),
      });
    },

    /** POST /auth/step-up/reauth/callback — hand back the provider's `code`/`state`
     *  and receive the same step-up token the password path issues. */
    completeStepUpReauth: async (params: { code: string; state: string }) => {
      return core.request<ApiResponse<{ ok: boolean; stepUpToken: string; expiresAt: number; method: 'reauth' }>>(
        '/api/auth/step-up/reauth/callback',
        { method: 'POST', body: JSON.stringify(params) },
      );
    },

    // ============================================
    // Passkeys (WebAuthn)
    //
    // Every ceremony is two calls: `/options` mints a single-use challenge the
    // browser signs, `/verify` hands the authenticator's reply back. The
    // `ceremonyId` is the server-side handle for that challenge — it is what
    // binds the two halves and it can be redeemed exactly once.
    //
    // These are the RAW endpoints; `lib/passkeys.ts` wraps them with the
    // browser calls so components never touch @simplewebauthn directly.
    // ============================================

    /** POST /auth/webauthn/register/options — a registration challenge.
     *  Step-up gated: pass the token from a StepUpModal. */
    getPasskeyRegistrationOptions: async (stepUpToken?: string) => {
      return core.request<ApiResponse<{ ceremonyId: string; options: PublicKeyCredentialCreationOptionsJSON }>>(
        '/api/auth/webauthn/register/options',
        { method: 'POST', headers: core.stepUpHeader(stepUpToken), body: JSON.stringify({}) },
      );
    },

    /** POST /auth/webauthn/register/verify — store the newly created passkey.
     *  When it is the account's FIRST second factor the response also carries the
     *  account's recovery codes, shown once. */
    verifyPasskeyRegistration: async (body: { ceremonyId: string; response: RegistrationResponseJSON; name: string }) => {
      return core.request<ApiResponse<{ passkey: Passkey; recoveryCodes?: string[] }>>('/api/auth/webauthn/register/verify', {
        method: 'POST',
        body: JSON.stringify(body),
      });
    },

    /** GET /auth/webauthn/credentials — the caller's registered passkeys. */
    listPasskeys: async () => {
      return core.request<ApiResponse<{ passkeys: Passkey[] }>>('/api/auth/webauthn/credentials');
    },

    /** PATCH /auth/webauthn/credentials/:id — relabel a passkey. */
    renamePasskey: async (id: string, name: string) => {
      return core.request<ApiResponse<{ passkey: Passkey }>>(`/api/auth/webauthn/credentials/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: JSON.stringify({ name }),
      });
    },

    /** DELETE /auth/webauthn/credentials/:id — revoke a passkey. Step-up gated;
     *  refused with `409` when it is the account's only way to sign in. */
    deletePasskey: async (id: string, stepUpToken?: string) => {
      return core.request<ApiResponse<{ removed: boolean; passkey: Passkey }>>(
        `/api/auth/webauthn/credentials/${encodeURIComponent(id)}`,
        { method: 'DELETE', headers: core.stepUpHeader(stepUpToken) },
      );
    },

    /** POST /auth/step-up/webauthn/options — a step-up challenge for the
     *  caller's own passkeys. `409` when the account has none. */
    getPasskeyStepUpOptions: async () => {
      return core.request<ApiResponse<{ ceremonyId: string; options: PublicKeyCredentialRequestOptionsJSON }>>(
        '/api/auth/step-up/webauthn/options',
        { method: 'POST', body: JSON.stringify({}) },
      );
    },

    /** POST /auth/step-up/webauthn/verify — the same step-up token the password
     *  and provider-re-auth paths issue. */
    verifyPasskeyStepUp: async (body: { ceremonyId: string; response: AuthenticationResponseJSON }) => {
      return core.request<ApiResponse<{ ok: boolean; stepUpToken: string; expiresAt: number; method: 'webauthn' }>>(
        '/api/auth/step-up/webauthn/verify',
        { method: 'POST', body: JSON.stringify(body) },
      );
    },

    /** POST /auth/webauthn/login/options — a sign-in challenge (public). Names
     *  no user: the browser picks whichever discoverable credential it holds. */
    getPasskeyLoginOptions: async () => {
      return core.request<ApiResponse<{ ceremonyId: string; options: PublicKeyCredentialRequestOptionsJSON }>>(
        '/api/auth/webauthn/login/options',
        { method: 'POST', body: JSON.stringify({}) },
      );
    },

    /** POST /auth/webauthn/login/verify — sign in with a passkey. Returns the
     *  SAME token shape as password login and is applied the same way. */
    completePasskeyLogin: async (body: { ceremonyId: string; response: AuthenticationResponseJSON }) => {
      const response = await core.request<ApiResponse<{ accessToken: string; expiresIn?: number }>>(
        '/api/auth/webauthn/login/verify',
        { method: 'POST', body: JSON.stringify(body) },
      );
      core.applyTokens(response);
      return response;
    },

    // ============================================
    // Authenticator app (TOTP)
    //
    // Enrolment is two calls for the same reason a passkey ceremony is: `/enrol`
    // mints a secret that has to reach the person's app, and `/activate` proves
    // it actually got there before the account starts depending on it. Both the
    // secret and the recovery codes are returned ONCE and never again — only
    // hashes and an encrypted blob exist server-side.
    // ============================================

    /** GET /auth/totp/status — whether the caller has an authenticator app, and
     *  how many recovery codes are left. Never the secret. */
    getTotpStatus: async () => {
      return core.request<ApiResponse<{ totp: TotpStatus }>>('/api/auth/totp/status');
    },

    /** POST /auth/totp/enrol — a fresh secret + `otpauth://` URI. Step-up gated;
     *  refused with `409` when an enrolment is already active. */
    enrolTotp: async (stepUpToken?: string) => {
      return core.request<ApiResponse<TotpEnrolment>>('/api/auth/totp/enrol', {
        method: 'POST',
        headers: core.stepUpHeader(stepUpToken),
        body: JSON.stringify({}),
      });
    },

    /** POST /auth/totp/activate — confirm the enrolment with a code from the app.
     *  Returns the account's recovery codes, shown once, when this is its FIRST
     *  second factor — an account that already has a set (from a passkey) keeps
     *  it and gets an empty list. */
    activateTotp: async (code: string) => {
      return core.request<ApiResponse<{ recoveryCodes: string[] }>>('/api/auth/totp/activate', {
        method: 'POST',
        body: JSON.stringify({ code }),
      });
    },

    /** DELETE /auth/totp — turn the authenticator off. Step-up gated; refused
     *  with `409` when it would leave no way to sign in. */
    disableTotp: async (stepUpToken?: string) => {
      return core.request<ApiResponse<{ disabled: boolean }>>('/api/auth/totp', {
        method: 'DELETE',
        headers: core.stepUpHeader(stepUpToken),
      });
    },

    /** GET /auth/recovery-codes — how many of the account's recovery codes are
     *  left (one set, shared by passkeys and the authenticator app). */
    getRecoveryCodeStatus: async () => {
      return core.request<ApiResponse<{ recoveryCodes: RecoveryCodeStatus }>>('/api/auth/recovery-codes');
    },

    /** POST /auth/recovery-codes — replace the whole set. Step-up gated; every
     *  previously issued code stops working. Needs a second factor to back up. */
    regenerateRecoveryCodes: async (stepUpToken?: string) => {
      return core.request<ApiResponse<{ recoveryCodes: string[] }>>('/api/auth/recovery-codes', {
        method: 'POST',
        headers: core.stepUpHeader(stepUpToken),
        body: JSON.stringify({}),
      });
    },

    /** POST /auth/step-up/totp — the same step-up token every other factor
     *  issues, earned with an authenticator (or recovery) code. */
    stepUpWithTotp: async (code: string) => {
      return core.request<ApiResponse<{
        ok: boolean; stepUpToken: string; expiresAt: number;
        method: 'totp'; via: 'totp' | 'recovery'; recoveryCodesRemaining: number;
      }>>('/api/auth/step-up/totp', {
        method: 'POST',
        body: JSON.stringify({ code }),
      });
    },
  };
}
