// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import type { ApiCore } from '../core';
import { buildQuery } from '../util';
import type { ApiResponse, Invitation, InvitationDelivery } from '@/types';
import type { OrgRole } from '@pipeline-builder/api-core/wire-vocabulary';

/**
 * Invitations: listing, the public token preview, accepting (session or
 * OAuth), sending, revoking and resending.
 * Composed into `organizationsApi` (./organizations).
 */
export function organizationInvitationsApi(core: ApiCore) {
  return {
    // ============================================
    // Invitation endpoints
    // ============================================
    listInvitations: async (params?: {
      status?: string; invitationType?: string; role?: 'admin' | 'member'; search?: string; offset?: number; limit?: number;
      /** A team in the active org's subtree, to list THAT team's invitations. */
      targetOrgId?: string;
    }, opts?: { signal?: AbortSignal }) => {
      return core.request<ApiResponse<{ invitations: Invitation[]; pagination?: { total: number; offset: number; limit: number; hasMore: boolean } }>>(`/api/invitation${buildQuery(params)}`, { signal: opts?.signal });
    },

    /** Public preview of an invitation by its token (GET /invitation/:token).
     *  No auth required — powers the accept page before the user signs in.
     *  `organization` and `invitedBy` arrive POPULATED (the service populates
     *  `organizationId` with name/slug and `invitedBy` with username) — objects,
     *  not ids; `null` once the referenced org or user is gone. */
    getInvitationByToken: async (token: string) => {
      return core.request<ApiResponse<{ invitation: {
        email: string;
        role: OrgRole;
        status: 'pending' | 'accepted' | 'expired' | 'revoked';
        expiresAt: string;
        organization: { _id: string; name: string; slug?: string } | null;
        invitedBy: { _id: string; username?: string } | null;
        isValid: boolean;
        invitationType?: string;
        allowedOAuthProviders?: string[];
        canAcceptViaEmail: boolean;
        /** Enabled sign-in providers this invitation can be accepted with; empty
         *  for an email-only (or no longer valid) invitation. */
        acceptProviders: string[];
      } }>>(`/api/invitation/${encodeURIComponent(token)}`);
    },

    /** Accept an invitation as the currently logged-in user (POST /invitation/accept).
     *  Body is just `{ token }`; the backend matches the invite email against the
     *  authenticated user, and an OAuth-only invitation against the account's
     *  LINKED identities — never a client-asserted provider. */
    acceptInvitation: async (token: string) => {
      return core.request<ApiResponse<undefined>>('/api/invitation/accept', {
        method: 'POST',
        body: JSON.stringify({ token }),
      });
    },

    /** First-time OAuth-based accept (POST /invitation/accept-oauth, public). Creates
     *  the user if needed. Requires the OAuth authorization `code` + `state` obtained
     *  from the provider redirect (the identity is verified server-side) — NOT a
     *  client-supplied profile. Reachable only after completing the OAuth dance. */
    acceptInvitationOAuth: async (data: { token: string; oauthProvider: string; code: string; state: string }) => {
      return core.request<ApiResponse<undefined>>('/api/invitation/accept-oauth', {
        method: 'POST',
        body: JSON.stringify(data),
      });
    },

    /** Invite one or many addresses. The per-address outcome comes back in the
     *  body, so a partial failure needs no client-side reassembly. */
    sendInvitations: async (data: {
      emails: string[]; role?: 'admin' | 'member'; invitationType?: string; targetOrgId?: string;
      /** Roles assigned on acceptance — bounded server-side by the inviter's ceiling. */
      roleIds?: string[];
    }) => {
      return core.request<ApiResponse<{
        sent: Array<{ email: string; delivery: InvitationDelivery; acceptUrl?: string }>;
        failed: Array<{ email: string; reason: string }>;
      }>>('/api/invitation/send', {
        method: 'POST',
        body: JSON.stringify(data),
      });
    },

    revokeInvitation: async (invitationId: string) => {
      return core.request<ApiResponse<{ message: string }>>(`/api/invitation/${encodeURIComponent(invitationId)}`, {
        method: 'DELETE',
      });
    },

    /** POST /invitation/:id/resend — mints a NEW link (the old one stops working),
     *  renews the expiry and mails it. When no email went out, `acceptUrl` carries
     *  the new link ONCE.
     *  `delivery: 'not-configured'` is a 200 too: the invitation was renewed but
     *  NO email went out (a refused transport is the 500). */
    resendInvitation: async (invitationId: string) => {
      return core.request<ApiResponse<{ expiresAt: string; delivery: InvitationDelivery; acceptUrl?: string }>>(`/api/invitation/${encodeURIComponent(invitationId)}/resend`, {
        method: 'POST',
      });
    },
  };
}
