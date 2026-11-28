// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import type { ApiCore } from '../core';
import type { ApiResponse, OrgIdpConfigDto, OrgIdpConfigCreate, IdpSaveWarning, IdpGroupMappingDto, ParsedIdpMetadata, SsoSpInfo, SsoTestReport } from '@/types';

/**
 * SSO / IdP: the sysadmin IdP roster, the org's own IdP config, its test
 * connection and metadata import, IdP group → Role mappings, verified domains
 * and the domain-join requests they produce.
 * Composed into `organizationsApi` (./organizations).
 */
export function organizationSsoApi(core: ApiCore) {
  return {
    // ============================================
    // IdP / SSO roster (sysadmin only)
    // ============================================

    /** GET /admin/org-idp — every org's IdP config in one shot (sysadmin only).
     *  Powers the IdP roster page. Per-org CRUD lives on the org-detail page's
     *  IdP editor; this is the read-only fleet view of who has SSO configured. */
    listOrgIdpConfigs: async (opts?: { signal?: AbortSignal }) => {
      return core.request<ApiResponse<{ configs: OrgIdpConfigDto[] }>>('/api/admin/org-idp', { signal: opts?.signal });
    },

    // ============================================
    // Own-org IdP / SSO self-service (org owner/admin)
    // ============================================

    /** GET /organization/:id/idp — the caller's own org IdP config. Gated on the
     *  `org_idp:write` permission and own-org only; `sso` entitlement enforced
     *  server-side. `config` is null when no IdP is configured (a normal 200). */
    getOwnOrgIdpConfig: async (orgId: string, opts?: { signal?: AbortSignal }) => {
      return core.request<ApiResponse<{ config: OrgIdpConfigDto | null }>>(`/api/organization/${encodeURIComponent(orgId)}/idp`, { signal: opts?.signal });
    },

    /** PUT /organization/:id/idp — CREATE the caller's own org IdP config (the
     *  full body the protocol requires). Edits to an existing config go through
     *  {@link patchOwnOrgIdpConfig}. Every write needs an MFA-grade session and a
     *  strong-factor step-up: the editor confirms in a `StepUpModal`
     *  (`requireStrongFactor`) and forwards its token here. */
    putOwnOrgIdpConfig: async (orgId: string, data: Partial<OrgIdpConfigCreate>, stepUpToken?: string) => {
      // `warnings` rides only when there are any (see IdpSaveWarning).
      return core.request<ApiResponse<{ config: OrgIdpConfigDto; warnings?: IdpSaveWarning[] }>>(`/api/organization/${encodeURIComponent(orgId)}/idp`, {
        method: 'PUT',
        body: JSON.stringify(data),
        headers: core.stepUpHeader(stepUpToken),
      });
    },

    /** PATCH /organization/:id/idp — change only the fields sent on an EXISTING
     *  config (404 when none exists). An omitted/empty `clientSecret` keeps the
     *  stored one. */
    patchOwnOrgIdpConfig: async (orgId: string, data: Partial<OrgIdpConfigCreate>, stepUpToken?: string) => {
      // `warnings` rides only when there are any (see IdpSaveWarning).
      return core.request<ApiResponse<{ config: OrgIdpConfigDto; warnings?: IdpSaveWarning[] }>>(`/api/organization/${encodeURIComponent(orgId)}/idp`, {
        method: 'PATCH',
        body: JSON.stringify(data),
        headers: core.stepUpHeader(stepUpToken),
      });
    },

    /** DELETE /organization/:id/idp — disconnect the org's SSO entirely. Members
     *  fall back to their other sign-in methods; group → Role mappings stop firing. */
    deleteOwnOrgIdpConfig: async (orgId: string, stepUpToken?: string) => {
      return core.request<ApiResponse<Record<string, never>>>(`/api/organization/${encodeURIComponent(orgId)}/idp`, {
        method: 'DELETE',
        headers: core.stepUpHeader(stepUpToken),
      });
    },

    /** GET /organization/:id/idp/sp-info — the values to register AT the IdP
     *  (SAML entity ID / ACS / metadata / SLO URLs, OIDC redirect URI, SP
     *  certificates), computed by the server from its public URL. */
    getOwnOrgIdpSpInfo: async (orgId: string, opts?: { signal?: AbortSignal }) => {
      return core.request<ApiResponse<{ sp: SsoSpInfo }>>(`/api/organization/${encodeURIComponent(orgId)}/idp/sp-info`, { signal: opts?.signal });
    },

    /** POST /organization/:id/idp/metadata/import — parse an IdP metadata
     *  document (pasted/uploaded XML, or an https URL the server fetches under its
     *  SSRF guard) into SAML form fields. Saves nothing. */
    importIdpMetadata: async (orgId: string, source: { xml: string } | { url: string }) => {
      return core.request<ApiResponse<{ metadata: ParsedIdpMetadata }>>(`/api/organization/${encodeURIComponent(orgId)}/idp/metadata/import`, {
        method: 'POST', body: JSON.stringify(source),
      });
    },

    /** POST /organization/:id/idp/test — start a TEST CONNECTION (dry run):
     *  `{ url, state }`; open `url` in a popup. Works before SSO is enabled. */
    startSsoTest: async (orgId: string) => {
      return core.request<ApiResponse<{ url: string; state: string }>>(`/api/organization/${encodeURIComponent(orgId)}/idp/test`, { method: 'POST' });
    },

    /** POST /organization/:id/idp/test/complete — collect the dry-run report.
     *  OIDC passes the IdP's `code` (or `error`); SAML only the `state`. */
    completeSsoTest: async (orgId: string, params: { state: string; code?: string; error?: string }) => {
      return core.request<ApiResponse<{ report: SsoTestReport }>>(`/api/organization/${encodeURIComponent(orgId)}/idp/test/complete`, {
        method: 'POST', body: JSON.stringify(params),
      });
    },

    // -- IdP group → Role mappings (3a) --
    // What the IdP's groups are worth inside the org. Gated on `roles:manage`
    // (a mapping grants Roles), own-org only, `sso` entitlement server-side.

    /** GET /organization/:id/idp/group-mappings — this org's mapping rules,
     *  each hydrated with the Roles it grants. */
    listIdpGroupMappings: async (orgId: string) => {
      return core.request<ApiResponse<{ mappings: IdpGroupMappingDto[] }>>(`/api/organization/${encodeURIComponent(orgId)}/idp/group-mappings`);
    },

    /** POST /organization/:id/idp/group-mappings — map one group to a Role set. */
    createIdpGroupMapping: async (orgId: string, data: { group: string; roleIds: string[] }) => {
      return core.request<ApiResponse<{ mapping: IdpGroupMappingDto }>>(`/api/organization/${encodeURIComponent(orgId)}/idp/group-mappings`, {
        method: 'POST', body: JSON.stringify(data),
      });
    },

    /** PUT /organization/:id/idp/group-mappings/:mappingId — edit group/Roles. */
    updateIdpGroupMapping: async (orgId: string, mappingId: string, data: { group?: string; roleIds?: string[] }) => {
      return core.request<ApiResponse<{ mapping: IdpGroupMappingDto }>>(`/api/organization/${encodeURIComponent(orgId)}/idp/group-mappings/${encodeURIComponent(mappingId)}`, {
        method: 'PUT', body: JSON.stringify(data),
      });
    },

    /** DELETE /organization/:id/idp/group-mappings/:mappingId — drop a rule.
     *  Roles it granted fall away at each member's next sign-in. */
    deleteIdpGroupMapping: async (orgId: string, mappingId: string) => {
      return core.request<ApiResponse<Record<string, never>>>(`/api/organization/${encodeURIComponent(orgId)}/idp/group-mappings/${encodeURIComponent(mappingId)}`, {
        method: 'DELETE',
      });
    },

    // -- Domain-based join (P2b): admin domain management + join-request review --

    listOrgDomains: async (orgId: string, opts?: { signal?: AbortSignal }) => {
      return core.request<ApiResponse<{ domains: OrgDomainDto[]; entitled: boolean }>>(`/api/organization/${encodeURIComponent(orgId)}/domains`, { signal: opts?.signal });
    },
    addOrgDomain: async (orgId: string, domain: string) => {
      return core.request<ApiResponse<{ domain: OrgDomainDto }>>(`/api/organization/${encodeURIComponent(orgId)}/domains`, {
        method: 'POST', body: JSON.stringify({ domain }),
      });
    },
    verifyOrgDomain: async (orgId: string, domainId: string) => {
      return core.request<ApiResponse<{ domain: OrgDomainDto }>>(`/api/organization/${encodeURIComponent(orgId)}/domains/${encodeURIComponent(domainId)}/verify`, { method: 'POST' });
    },
    setOrgDomainMode: async (orgId: string, domainId: string, autoJoin: 'off' | 'request' | 'auto') => {
      return core.request<ApiResponse<{ domain: OrgDomainDto }>>(`/api/organization/${encodeURIComponent(orgId)}/domains/${encodeURIComponent(domainId)}`, {
        method: 'PATCH', body: JSON.stringify({ autoJoin }),
      });
    },
    /**
     * PATCH /organization/:id/domains/:domainId/team-sharing — a ROOT org shares
     * (or stops sharing) a VERIFIED domain with the account's teams, letting
     * their own IdPs / SCIM vouch for addresses at it. Gated `org_settings:write`
     * plus step-up: the caller confirms in a `StepUpModal` and forwards its
     * token, so the global dialog never replays it (`replayOnStepUp: false`).
     * Refused 409 `DOMAIN_SHARE_NOT_ROOT` on a team and
     * `DOMAIN_SHARE_UNVERIFIED` when turning it on for an unverified domain.
     */
    setOrgDomainSharing: async (orgId: string, domainId: string, sharedWithTeams: boolean, stepUpToken?: string) => {
      return core.request<ApiResponse<{ domain: OrgDomainDto }>>(`/api/organization/${encodeURIComponent(orgId)}/domains/${encodeURIComponent(domainId)}/team-sharing`, {
        method: 'PATCH',
        replayOnStepUp: false,
        headers: core.stepUpHeader(stepUpToken),
        body: JSON.stringify({ sharedWithTeams }),
      });
    },
    deleteOrgDomain: async (orgId: string, domainId: string) => {
      return core.request<ApiResponse<{ deleted: boolean }>>(`/api/organization/${encodeURIComponent(orgId)}/domains/${encodeURIComponent(domainId)}`, { method: 'DELETE' });
    },

    /** GET /organization/:id/join-requests — one page of PENDING (default) or
     *  DENIED domain-join requests, newest first; `hasMore` says another page
     *  exists at `offset + limit`. */
    listOrgJoinRequests: async (
      orgId: string,
      opts?: { status?: 'pending' | 'denied'; limit?: number; offset?: number; signal?: AbortSignal },
    ) => {
      const qs = new URLSearchParams();
      if (opts?.status) qs.set('status', opts.status);
      if (opts?.limit !== undefined) qs.set('limit', String(opts.limit));
      if (opts?.offset) qs.set('offset', String(opts.offset));
      const query = qs.toString();
      return core.request<ApiResponse<{ requests: OrgJoinRequestDto[]; hasMore: boolean }>>(
        `/api/organization/${encodeURIComponent(orgId)}/join-requests${query ? `?${query}` : ''}`,
        { signal: opts?.signal },
      );
    },
    /** DELETE /organization/:id/join-requests/:reqId — clear a DENIED request so
     *  the person may ask again (404 unless it is a denial). */
    clearOrgJoinRequest: async (orgId: string, reqId: string) => {
      return core.request<ApiResponse<{ userId: string }>>(`/api/organization/${encodeURIComponent(orgId)}/join-requests/${encodeURIComponent(reqId)}`, { method: 'DELETE' });
    },
    decideOrgJoinRequest: async (orgId: string, reqId: string, decision: 'approve' | 'deny') => {
      return core.request<ApiResponse<{ userId: string; status: 'approved' | 'denied' }>>(`/api/organization/${encodeURIComponent(orgId)}/join-requests/${encodeURIComponent(reqId)}/${encodeURIComponent(decision)}`, { method: 'POST' });
    },
  };
}

/** A registered org domain as returned to the admin UI. */
export interface OrgDomainDto {
  id: string;
  domain: string;
  verified: boolean;
  autoJoin: 'off' | 'request' | 'auto';
  /** A ROOT org's verified domain shared with its teams: their IdPs / SCIM may
   *  vouch for addresses at it. Off by default; always false on a team. */
  sharedWithTeams: boolean;
  /** DNS TXT record to publish — present only while unverified. */
  verification?: { host: string; type: string; value: string };
}

/** A pending domain-join request as returned to the admin UI. */
export interface OrgJoinRequestDto {
  id: string;
  userId: string;
  email: string;
  status: 'pending' | 'denied';
  requestedAt: string;
  /** When an admin denied it (denied rows only). */
  decidedAt?: string;
}
