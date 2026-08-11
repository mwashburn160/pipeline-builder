// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import type { ApiCore } from '../core';
import type { ApiResponse, User } from '@/types';

/** Personal Access Token metadata (never includes the token secret). */
export interface PatMeta {
  id: string;
  jti: string;
  name: string;
  scope: string | null;
  createdAt: string;
  expiresAt: string;
  lastUsedAt: string | null;
  revoked: boolean;
  status: 'active' | 'expired' | 'revoked';
}

export function authApi(core: ApiCore) {
  return {
    // ============================================
    // Config endpoints (public)
    // ============================================

    /** Get platform service feature flags (public, no auth required). */
    getConfig: async () => {
      return core.request<ApiResponse<{ serviceFeatures: Record<string, boolean>; supportAlias?: string }>>('/api/config');
    },

    // ============================================
    // Auth endpoints
    // ============================================
    login: async (email: string, password: string) => {
      const response = await core.request<ApiResponse<{ accessToken: string; refreshToken: string }>>('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ identifier: email, password }),
      });
      core.applyTokens(response);
      return response;
    },

    register: async (username: string, email: string, password: string, organizationName?: string, planId?: string) => {
      return core.request<ApiResponse<{ user: User }>>('/api/auth/register', {
        method: 'POST',
        body: JSON.stringify({ username, email, password, organizationName, planId }),
      });
    },

    logout: async () => {
      try {
        await core.request('/api/auth/logout', { method: 'POST' });
      } finally {
        core.clearTokens();
      }
    },

    getProfile: async () => {
      return core.request<ApiResponse<{ user: User }>>('/api/user/profile');
    },

    /** Switch active organization and re-issue tokens. */
    switchOrganization: async (organizationId: string) => {
      const result = await core.request<ApiResponse<{ accessToken: string; refreshToken: string; expiresIn: number }>>('/api/auth/switch-org', {
        method: 'POST',
        body: JSON.stringify({ organizationId }),
      });
      if (result.data) {
        core.setTokens({ accessToken: result.data.accessToken, refreshToken: result.data.refreshToken });
      }
      return result;
    },

    /** List all organizations the current user belongs to. */
    getUserOrganizations: async () => {
      return core.request<ApiResponse<{ organizations: Array<{ organizationId: string; organizationName: string; slug?: string; role: string; joinedAt: string; parentOrgId?: string; tier?: string }> }>>('/api/user/organizations');
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

    changePassword: async (currentPassword: string, newPassword: string) => {
      return core.request<ApiResponse<{ message: string }>>('/api/user/change-password', {
        method: 'POST',
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
     * Generate a new token pair via POST /user/generate-token
     */
    generateNewToken: async () => {
      const response = await core.request<ApiResponse<{ accessToken: string; refreshToken: string }>>(
        '/api/user/generate-token',
        { method: 'POST' },
      );
      core.applyTokens(response);
      return response;
    },

    /** GET /user/tokens — recent token-issuance history with computed status. */
    listTokenHistory: async () => {
      return core.request<ApiResponse<{ tokens: Array<{ id: string; createdAt: string; expiresAt: string; status: 'active' | 'expired' | 'revoked' }> }>>(
        '/api/user/tokens',
      );
    },

    /** POST /user/pats — create a named Personal Access Token. Returns the token ONCE.
     *  Step-up gated: pass the token from a StepUpModal via `X-Step-Up-Token`. */
    createPat: async (body: { name: string; expiresIn?: number; scope?: string }, stepUpToken?: string) => {
      return core.request<ApiResponse<{ token: string; pat: PatMeta }>>('/api/user/pats', {
        method: 'POST',
        headers: core.stepUpHeader(stepUpToken),
        body: JSON.stringify(body),
      });
    },

    /** GET /user/pats — list the user's Personal Access Tokens (metadata only). */
    listPats: async () => {
      return core.request<ApiResponse<{ pats: PatMeta[] }>>('/api/user/pats');
    },

    /** DELETE /user/pats/:jti — revoke a single Personal Access Token immediately. */
    revokePat: async (jti: string) => {
      return core.request<ApiResponse<{ revoked: boolean }>>(`/api/user/pats/${encodeURIComponent(jti)}`, {
        method: 'DELETE',
      });
    },

    /** GET /user/preferences — server-persisted favorites/recents for the active org. */
    getPreferences: async () => {
      return core.request<ApiResponse<{ preferences: { favorites: string[]; recents: string[] } }>>('/api/user/preferences');
    },

    /** PUT /user/preferences — replace favorites and/or recents for the active org. */
    updatePreferences: async (patch: { favorites?: string[]; recents?: string[] }) => {
      return core.request<ApiResponse<{ preferences: { favorites: string[]; recents: string[] } }>>('/api/user/preferences', {
        method: 'PUT',
        body: JSON.stringify(patch),
      });
    },

    /** POST /user/tokens/revoke-all — sign out everywhere (bumps tokenVersion). Re-issues a fresh token for the active session.
     *  Step-up gated — a stolen session can otherwise lock the legitimate user out. */
    revokeAllTokens: async (stepUpToken?: string) => {
      const response = await core.request<ApiResponse<{ revoked: boolean; accessToken: string; refreshToken: string; expiresIn: number }>>(
        '/api/user/tokens/revoke-all',
        { method: 'POST', headers: core.stepUpHeader(stepUpToken) },
      );
      core.applyTokens(response);
      return response;
    },

    // ============================================
    // OAuth / SSO login
    //
    // Session establishment is IDENTICAL to password login: the callback
    // endpoint returns the same `{ accessToken, refreshToken }` pair issued by
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
     *  applied via `core.applyTokens` exactly like `login`. */
    completeOAuthCallback: async (provider: string, params: { code: string; state: string }) => {
      const response = await core.request<ApiResponse<{ accessToken: string; refreshToken: string; expiresIn?: number }>>(
        `/api/auth/oauth/${encodeURIComponent(provider)}/callback`,
        { method: 'POST', body: JSON.stringify({ code: params.code, state: params.state }) },
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
      return core.request<ApiResponse<{ ok: boolean; stepUpToken: string; expiresAt: number }>>('/api/auth/step-up', {
        method: 'POST',
        body: JSON.stringify({ password }),
      });
    },
  };
}
