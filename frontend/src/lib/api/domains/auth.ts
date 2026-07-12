// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import type { ApiCore } from '../core';
import type { ApiResponse, User } from '@/types';

export function authApi(core: ApiCore) {
  return {
    // ============================================
    // Config endpoints (public)
    // ============================================

    /** Get platform service feature flags (public, no auth required). */
    getConfig: async () => {
      return core.request<ApiResponse<{ serviceFeatures: Record<string, boolean> }>>('/api/config');
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
