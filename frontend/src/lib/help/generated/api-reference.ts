// GENERATED FROM docs/api-reference.md — DO NOT EDIT.
// Regenerate: npm run generate:help  (see frontend/scripts/generate-help.mjs)
// SOURCE-SHA256: d362d94ad126c5839f4710f98df1e771e4604fc644addab74995ddad5f99034c
// SPDX-License-Identifier: Apache-2.0
import { Code } from 'lucide-react';
import type { HelpTopic } from '../types';

export const apiReferenceTopic: HelpTopic = {
  "icon": Code,
  "id": "api-reference",
  "title": "API Reference",
  "description": "REST API endpoints and usage examples",
  "sections": [
    {
      "id": "overview",
      "title": "Overview",
      "blocks": [
        {
          "type": "text",
          "content": "REST endpoints for pipelines, plugins, the Ask assistant, compliance, quota, organizations and reporting."
        }
      ]
    },
    {
      "id": "highlights",
      "title": "Highlights",
      "blocks": [
        {
          "type": "list",
          "items": [
            "Two headers on every request: Authorization: Bearer <JWT> and x-org-id.",
            "Paths here are service-relative. Every route is served through the gateway under /api, so /pipelines/:id is /api/pipelines/:id over the wire.",
            "The gateway does not validate tokens. Each service does; the gateway only decodes claims for its access log.",
            "Many routes consume quota as well as a permission, and the tables say which.",
            "Responses share one envelope — success, paginated and error — so a client parses one shape.",
            "find endpoints are the exact-match CLI surface; the dashboard filters the list endpoints instead.",
            "Reporting endpoints are split by entitlement. Build health is standard on every tier; DORA needs advanced_reporting."
          ]
        }
      ]
    },
    {
      "id": "overview",
      "title": "Overview",
      "blocks": [
        {
          "type": "text",
          "content": "This reference catalogs the REST endpoints exposed by the Pipeline Builder services, with each route's method, path, description and — where applicable — the fine-grained permission or quota it consumes."
        },
        {
          "type": "text",
          "content": "It is for API integrators and operators calling the platform directly. Endpoints are grouped by service, followed by common query parameters, worked curl examples, and the shared response envelope. For the permission names in the Organization table, see Roles & Permissions."
        }
      ]
    },
    {
      "id": "how-it-works",
      "title": "How it works",
      "blocks": [
        {
          "type": "list",
          "items": [
            "A request arrives at the Nginx gateway, which terminates TLS and routes by path prefix under /api.",
            "The gateway decodes the token's claims for its access log only — it does not validate them. See Authentication.",
            "The owning service validates the token and resolves the caller's permissions.",
            "x-org-id scopes the request to one tenant; a caller cannot reach another org's resources by changing it.",
            "The route's gate runs — permission, feature entitlement, scope or assurance level — and a refused write is audited.",
            "Quota is consumed where the route declares it, against the account root's pooled cap.",
            "The response comes back in the shared envelope, success or error."
          ]
        }
      ]
    },
    {
      "id": "configuration",
      "title": "Configuration",
      "blocks": [
        {
          "type": "list",
          "items": [
            "Get a credential. An access key from pipeline-manager auth pat or the dashboard, exchanged for a short-lived token; or a service-account key for automation. See Authentication.",
            "Send both headers on every call — the token and x-org-id.",
            "Prefix paths with /api when calling over the wire.",
            "Check the permission column before wiring a call, and grant it via a Role rather than a membership label.",
            "Handle the error envelope, not just the status: the machine-readable code is the stable contract. See Error Handling.",
            "Expect quota refusals (429) on the metered routes, and read the limit from the response."
          ]
        }
      ]
    },
    {
      "id": "authentication",
      "title": "Authentication",
      "blocks": [
        {
          "type": "text",
          "content": "All requests require two headers:"
        },
        {
          "type": "table",
          "headers": [
            "Header",
            "Description"
          ],
          "rows": [
            [
              "Authorization",
              "Bearer <JWT> -- obtained from the platform login endpoint"
            ],
            [
              "x-org-id",
              "Organization ID -- scopes the request to a specific tenant"
            ]
          ]
        },
        {
          "type": "note",
          "content": "Paths in this document are service-relative. Every route is served through the Nginx gateway under the /api prefix, so the table entry /pipelines/:id is called as https://<host>/api/pipelines/<id> — as the curl examples below show."
        },
        {
          "type": "text",
          "content": "Access tokens are ES256, signed only by platform, and carry a kid naming the signing key; every service verifies them against the key set at GET /.well-known/jwks.json (public, unauthenticated, cacheable). See Authentication → how tokens are signed."
        },
        {
          "type": "text",
          "content": "Access tokens are short-lived — 900 s (15 min) by default, set by JWT_EXPIRES_IN with optional per-tier overrides via JWT_EXPIRES_IN_<TIER>. The short TTL is what makes privilege changes take effect quickly; see Permissions → session invalidation. Use the refresh-token endpoint to obtain a new access token without re-authenticating."
        },
        {
          "type": "text",
          "content": "Routes marked + step-up additionally require a short-lived step-up token in X-Step-Up-Token, earned from one of the platform's step-up endpoints:"
        },
        {
          "type": "table",
          "headers": [
            "Method",
            "Endpoint",
            "Description"
          ],
          "rows": [
            [
              "POST",
              "/auth/step-up",
              "Re-verify the account password → { stepUpToken, expiresAt }"
            ],
            [
              "POST",
              "/auth/step-up/webauthn/options + /verify",
              "Re-verify with a passkey: /options returns { ceremonyId, options }, /verify takes { ceremonyId, response } → { stepUpToken, expiresAt, method: 'webauthn' }. 409 when the account has no passkey"
            ],
            [
              "POST",
              "/auth/step-up/totp",
              "Re-verify with an authenticator-app code, { code } → { stepUpToken, expiresAt, method: 'totp', via }. A recovery code works here too (via: 'recovery'); 409 when the account has no authenticator, 429 when it is locked out after repeated wrong codes"
            ],
            [
              "POST",
              "/auth/step-up/reauth",
              "Start a provider re-auth ({ type: 'oauth', provider } or { type: 'sso', orgId }) → { url, state }; the only step-up an account with no password has"
            ],
            [
              "POST",
              "/auth/step-up/reauth/callback",
              "Exchange that flow's { code, state } → { stepUpToken, expiresAt, method: 'reauth' }"
            ],
            [
              "POST",
              "/auth/device/code + /auth/device/token",
              "The CLI's step-up: ask with { step_up: true }, and the browser approval's own step-up is returned as step_up_token on the approved poll — so pipeline-manager auth pat needs no password"
            ]
          ]
        },
        {
          "type": "text",
          "content": "GET /user/profile reports which factors the account has (authFactors: hasPassword, passkeyCount, hasTotp, providers). All of them share ONE per-user budget of 5 attempts/minute; TOTP adds a per-account lockout on top, because a 6-digit code is small enough that a request limiter alone is not the real bound. See Authentication → step-up."
        },
        {
          "type": "text",
          "content": "Internal routes are not part of this API"
        },
        {
          "type": "text",
          "content": "A handful of endpoints exist ONLY for service-to-service calls and are closed to every user token, including a superadmin's: every internal contract (/internal/* and /<service>/internal/* — e.g. the entity-event ingest POST /compliance/internal/events/entity, the org-onboarding hook POST /compliance/internal/subscriptions/auto-subscribe, and the entitlement sync legs /compliance/internal/entitlements/:orgId and /reports/internal/retention-sync/:orgId), plus the quota usage counters (POST /quotas/:orgId/{increment,decrement}) and the audit ingest (POST /audit/events). The gateway does not route an internal path segment at all — /api/<service>/internal/* answers 404 from outside."
        },
        {
          "type": "text",
          "content": "They require a token signed by one of a named set of internal services, so there is no credential a client can hold that reaches them — a request with any user token or access key gets 403 INSUFFICIENT_PERMISSIONS. They are listed below only so the surface is complete. See Authentication → internal routes."
        }
      ]
    },
    {
      "id": "endpoints",
      "title": "Endpoints",
      "blocks": [
        {
          "type": "note",
          "content": "Every endpoint below is permission-gated. Reads need the resource's :read permission and writes its :write/:manage (operator endpoints need the super-admin flag instead) — a Role that drops a :read is refused at the API, not just in the UI. Each service publishes its resolved route table (method, path, permissions, step-up, feature flag, audit action) and a test fails on any route that lacks its gate; see Permissions → route coverage."
        },
        {
          "type": "text",
          "content": "The one exception is the public key set, which carries no tenant data and must answer before any credential exists:"
        },
        {
          "type": "table",
          "headers": [
            "Method",
            "Endpoint",
            "Description"
          ],
          "rows": [
            [
              "GET",
              "/.well-known/jwks.json",
              "The ES256 public keys user tokens are verified against. Unauthenticated, cacheable (10 min), served both at the root and under /api. Rotation adds a second kid for one overlap window."
            ]
          ]
        },
        {
          "type": "text",
          "content": "Pipeline Service"
        },
        {
          "type": "table",
          "headers": [
            "Method",
            "Endpoint",
            "Description"
          ],
          "rows": [
            [
              "GET",
              "/pipelines",
              "List pipelines (filterable, paginated)"
            ],
            [
              "GET",
              "/pipelines/find",
              "Find one pipeline by query"
            ],
            [
              "GET",
              "/pipelines/:id",
              "Get by ID"
            ],
            [
              "POST",
              "/pipelines",
              "Create pipeline. A plugin reference with publisher that isn't installed, is blocked by the org's consumption policy or can't resolve → 400 with the per-step reasons; the plugin contract is checked for listed versions too"
            ],
            [
              "PUT",
              "/pipelines/:id",
              "Update pipeline (same plugin-reference checks as create)"
            ],
            [
              "DELETE",
              "/pipelines/:id",
              "Delete pipeline"
            ],
            [
              "POST",
              "/pipelines/bulk/create",
              "Create up to the bulk cap in one request ({ pipelines: [...] }; ?upsert=true as single create). The status reflects the outcome: 201 every item saved, 207 some failed, 422 none saved. The per-item body { created, updated, failed, items, errors } is in data on 201/207 and in the error envelope's details on 422"
            ],
            [
              "GET",
              "/pipelines/providers",
              "List AI providers"
            ],
            [
              "POST",
              "/pipelines/generate",
              "AI-generate pipeline from prompt (consumes aiCalls quota). Every generate route's JSON response and done event also carry draftId, the single-use id the draft's outcome is reported under (POST /ask-agent/draft-outcome)"
            ],
            [
              "POST",
              "/pipelines/generate/stream",
              "Stream AI generation as SSE (consumes aiCalls quota)"
            ],
            [
              "POST",
              "/pipelines/generate/from-url",
              "Analyze Git URL + generate pipeline as one JSON response — no plugin auto-creation; used by the Ask agent's propose_pipeline_from_repo (consumes aiCalls quota)"
            ],
            [
              "POST",
              "/pipelines/analyze/from-url",
              "Repository analysis ONLY ({ gitUrl, repoToken? } → { analysis }): no model call, no aiCalls slot, persists nothing (pipelines:write + ai_generation). Used by the Ask agent's propose_plugin_from_repo"
            ],
            [
              "POST",
              "/pipelines/generate/from-url/stream",
              "Analyze Git URL + stream pipeline (consumes aiCalls quota); ends with a missing-plugins PROPOSAL — nothing is created by the stream"
            ],
            [
              "POST",
              "/pipelines/generate/missing-plugins",
              "Create the placeholder plugins the user confirmed from a missing-plugins proposal ({ plugins: string[] }; plugins:write; each name re-checked server-side; no AI call)"
            ],
            [
              "GET",
              "/pipelines/registry",
              "List deployed-stack registrations (pipelineId, stackName, region, lastDeployed) for the caller's org — no ARNs, no account id. ?limit= (default 10, max 1000) + ?offset= page it; the answer is { registry: [...], pagination: { total, limit, offset, hasMore } }, ordered lastDeployed desc then id, so page until hasMore is false. ?orgId= names the org: your own always works, another org only for a system admin (403 INSUFFICIENT_PERMISSIONS otherwise). This is what pipeline-manager audit stacks reads"
            ],
            [
              "POST",
              "/pipelines/registry",
              "Upsert registry entry (deploy hook; tenant-guarded)"
            ],
            [
              "GET",
              "/pipelines/:id/security-reports",
              "The latest scanner report per (tool, stage), their summed counts and latestAt; each report carries its own createdAt, so a slot the pipeline stopped refreshing is visible"
            ],
            [
              "DELETE",
              "/pipelines/:id/security-reports?tool=<tool>[&stage=<stage>]",
              "Remove ONE report slot — a scanner the pipeline dropped or a stage it renamed, whose last counts would otherwise feed the scorecard forever (pipelines:write; audited pipeline.security_report.delete; 404 when the slot is empty; an omitted stage names the stage-less slot)"
            ],
            [
              "GET",
              "/pipelines/scorecard",
              "Org maturity roll-up over a PAGE of the org's own pipelines (system samples and a parent's shared pipelines are not graded), most recently updated first. ?offset= (default 0), ?limit= (1..ORG_SCORECARD_MAX_PIPELINES, default that cap), ?project=, ?pipelineName=. rollup.pagination = { offset, limit, total, hasMore, nextOffset }; the aggregate stats cover the page. A computed page is reused for 5 minutes per viewer (computedAt says when)"
            ]
          ]
        },
        {
          "type": "text",
          "content": "Plugin Service"
        },
        {
          "type": "table",
          "headers": [
            "Method",
            "Endpoint",
            "Description"
          ],
          "rows": [
            [
              "GET",
              "/plugins",
              "List plugins (filterable, paginated)"
            ],
            [
              "GET",
              "/plugins/find",
              "Find one plugin by query, including publisher (verifies the image signature first — 409 IMAGE_VERIFICATION_FAILED if it doesn't verify). Same resolution and { plugin, warnings } answer as /plugins/lookup, but with the full plugin record"
            ],
            [
              "GET",
              "/plugins/:id",
              "Get by ID"
            ],
            [
              "GET",
              "/plugins/:id/sbom",
              "Download the plugin image's SPDX JSON SBOM, read from its signed attestation (404 no image, 409 IMAGE_VERIFICATION_FAILED)"
            ],
            [
              "POST",
              "/plugins",
              "Upload plugin (ZIP multipart). Optional metadata part: a JSON object of catalog edits (see Catalog metadata); absent ⇒ every detected value is accepted. Execution-contract keys in it → 400. Optional publishRequest=true (needs plugins:publish and visibility=public): once the build completes, submit a new-listing / new-version publish request for the version as the uploader (Plugin Publishing). Optional setupLoad=true (the setup catalog loader): for a system-org build, an image the scan gates refuse is kept for promotion instead of removed; ignored for any other org (Scan gates)"
            ],
            [
              "POST",
              "/plugins/inspect",
              "Dry-run parse of a plugin ZIP: every catalog field with its detected value, source (spec / readme / dockerfile / derived) and validation error. Builds and stores nothing; same zip limits as upload; rate limited; plugins:write"
            ],
            [
              "POST",
              "/plugins/lookup",
              "Find plugin by validated filter body (POST for URL-length safety). The endpoint synth resolves plugins through. Without publisher: own org → parent org's shared plugin → the Official listing pipeline-builder/<name> through the org's install (explicit, else implicit). With publisher: only that publisher's listing, only through an install (403 PLUGIN_NOT_INSTALLED / PLUGIN_BLOCKED_BY_POLICY, 409 PLUGIN_UNAVAILABLE otherwise). A listing's version range is the install's, narrowed by filter.version; yanked listing versions never resolve. Verifies the image signature (and, for a listing, the signed tier and publisher) and returns imageDigest, which synth pins CodeBuild to; 409 IMAGE_VERIFICATION_FAILED otherwise. Answer: { plugin, warnings } — plugin is the resolved record a pipeline build needs, without the fields no build reads (readmeMd, readmeHtml, changelog, scanSummary, dockerfile, icon, uploadedIcon; /plugins/find returns them), and carries publisher, publisherTier, listingId, imageRepository, source (org \\",
              "listing) and install (explicit \\",
              "implicit \\",
              "null); warnings may list PLUGIN_SHADOWS_LISTING, PLUGIN_SECRETS_WITHHELD, LISTING_UNMAINTAINED, PLUGIN_DEPRECATED, PLUGIN_YANKED, PLUGIN_ADVISORY and the vulnerability grades (VULN_KEV, VULN_FLAGGED, VULN_CRITICAL_FIXABLE, VULN_HIGH_FIXABLE, UNSCANNED, SCAN_STALE, COMPLIANCE_VULN_RULE, VULN_ACCEPTED), which synth prints; each warning carries a severity (info \\",
              "warning \\",
              "error \\",
              "critical) and the answer its loudest severity. Vulnerability state never refuses a lookup. An optional context: { pipelineId, stepKeys } (the step labels: synth or <stage>/<alias ?? name>) records the answer per step for the pipeline's security view, applies the pipeline's active risk acceptances (accepted findings drop to info VULN_ACCEPTED), and notifies its owners (N32) at error or louder"
            ],
            [
              "PUT",
              "/plugins/:id",
              "Update a version's descriptive catalog fields (summary, description, displayName, category, keywords, license, links, icon, changelog, readme) and operational flags (visibility, isActive, isDefault, lifecycle, criticality, labels, links, owner). Execution-contract keys (commands, env, secrets, computeType, …) → 400; they change only with a new version. Catalog edits on a frozen or listed version → 409 PLUGIN_VERSION_FROZEN. Deactivating (isActive: false) an in-use version answers 200 with warnings: [{ code: 'PLUGIN_VERSION_IN_USE', severity: 'warning', pipelineCount, orgCount, pipelines }] (never a refusal) and the affected orgs are notified (N14)"
            ],
            [
              "POST",
              "/plugins/:id/deprecate",
              "{ deprecated?: boolean, message?: string } — deprecate (or un-deprecate) a version: it keeps resolving with a warning and AI selection stops offering it"
            ],
            [
              "POST",
              "/plugins/:id/yank",
              "{ reason } — stop a version resolving for ranges, latest and the default (an exact pin still resolves, with a warning); yanking the default promotes the next. A listed version → 409 (yank it through the ecosystem). An in-use version answers 200 with warnings: [{ code: 'PLUGIN_VERSION_IN_USE', severity: 'warning', pipelineCount, orgCount, pipelines }] (never a refusal) and the affected orgs are notified (N14)."
            ],
            [
              "POST",
              "/plugins/:id/unyank",
              "{ reason?: string } — reverse a yank: the version resolves for ranges and latest again (its lifecycle returns to deprecated if it is deprecated, else production). It does NOT become the default again. A listed version → 409 PLUGIN_VERSION_FROZEN (unyank it through the ecosystem); a version that isn't yanked → 409"
            ],
            [
              "PUT",
              "/plugins/bulk/update",
              "Bulk-update plugins (strict whitelist of mutable fields)"
            ],
            [
              "POST",
              "/plugins/bulk/delete",
              "Bulk soft-delete; versions that are frozen, listed or in use are skipped (skipped: [{ id, reason }]), each deleted slot is refunded and deleted defaults are replaced"
            ],
            [
              "DELETE",
              "/plugins/:id",
              "Delete a version. Referenced by any pipeline → 409 PLUGIN_VERSION_IN_USE (reason: 'in_use', no override: the answer names the pipelines, the version's severity and suggestedVersion); published to a listing → 409 PLUGIN_VERSION_IN_USE (reason: 'listed') unless ?force=true with a step-up token; referenced by a pending publish request → 409 PLUGIN_VERSION_FROZEN. Deleting the default promotes the next default; the plugins quota slot is refunded while its period is current; the orgs using the version are notified (N14)"
            ],
            [
              "GET",
              "/plugins/providers",
              "List AI providers"
            ],
            [
              "POST",
              "/plugins/generate",
              "AI-generate plugin from prompt (consumes aiCalls quota). Also returns similarPlugins (see below). Every generate route's JSON response and done event also carry draftId, the single-use id the draft's outcome is reported under (POST /ask-agent/draft-outcome)"
            ],
            [
              "POST",
              "/plugins/generate/stream",
              "Stream AI plugin generation as SSE (consumes aiCalls quota)"
            ],
            [
              "POST",
              "/plugins/deploy-generated",
              "Build and deploy AI-generated plugin"
            ],
            [
              "GET",
              "/plugins/plugin-usage",
              "Counts pipelines (in caller's org) referencing each plugin: keyed by name for unqualified references and publisher/name for qualified ones"
            ],
            [
              "GET",
              "/plugins/queue/status",
              "Build queue counts (admin only)"
            ],
            [
              "GET",
              "/plugins/queue/failed",
              "Failed build jobs (every org's for a system-org plugin_queue:manage holder; otherwise the caller's own org's, needing plugins:write)"
            ],
            [
              "GET",
              "/plugins/queue/dlq",
              "Dead letter queue jobs (scoped like /plugins/queue/failed)"
            ],
            [
              "POST",
              "/plugins/queue/dlq/:jobId/replay",
              "Replay a single DLQ job (scoped like /plugins/queue/failed; another org's job reads as 404)"
            ],
            [
              "DELETE",
              "/plugins/queue/dlq",
              "Purge all DLQ jobs (plugin_queue:manage)"
            ]
          ]
        },
        {
          "type": "text",
          "content": "Plugin Ecosystem: publishers and publish requests"
        },
        {
          "type": "text",
          "content": "Tenant routes: each only submits a request or narrows the caller's own reach; every decision belongs to the system org (Plugin Publishing)."
        },
        {
          "type": "table",
          "headers": [
            "Method",
            "Endpoint",
            "Description"
          ],
          "rows": [
            [
              "GET",
              "/plugins/publisher",
              "The org's publisher (or null), isRootOrg, terms: { currentVersion, accepted }, verifiedEligible, listingsQuota: { used, limit }, publishingEnabled (plugins:read)"
            ],
            [
              "POST",
              "/plugins/publisher",
              "Claim a handle: { handle, displayName, description?, homepageUrl?, termsVersion } → 201. Reserved → 409 PUBLISHER_HANDLE_RESERVED; taken → 409 DUPLICATE_ENTRY; team org → 403 PUBLISHER_ROOT_ORG_REQUIRED (publishers:manage)"
            ],
            [
              "PATCH",
              "/plugins/publisher",
              "{ description?, homepageUrl? } — handle and display name change only through a profile_change request (publishers:manage)"
            ],
            [
              "POST",
              "/plugins/publisher/terms",
              "{ termsVersion } — accept the terms in force (publishers:manage)"
            ],
            [
              "GET",
              "/plugins/publisher/listings",
              "The publisher's listings with their versions and open-request counts (plugins:read)"
            ],
            [
              "POST",
              "/plugins/publisher/listings/:listingId/pause",
              "{ version? } — pause the listing (no new installs) or one version, at once; unpausing is a request (plugins:publish)"
            ],
            [
              "GET",
              "/plugins/publisher/incoming-transfers",
              "Open transfers offered to the org's publisher (publishers:manage)"
            ],
            [
              "GET",
              "/plugins/publish-requests",
              "The publisher's requests; `?status=open\\",
              "pending\\",
              "approved\\",
              "rejected\\",
              "withdrawn (plugins:read`)"
            ],
            [
              "GET",
              "/plugins/publish-requests/draft?pluginId=",
              "The request form for a version: kind (new_listing / new_version), the submit gates, the effective catalog metadata with each field's source (and, for a new version, the live listing's value), and the changed-fields listingUpdateOffer (plugins:publish)"
            ],
            [
              "POST",
              "/plugins/publish-requests",
              "Submit { kind, … }: new_listing / new_version { pluginId, metadata?, securityFixAdvisoryId?, breaking? }, listing_update { listingId, metadata, sources? }, yank { listingId, version, reason }, unpause { listingId, version? }, transfer { listingId, target: { targetPublisherHandle } }, claim `{ target: { handle } \\",
              "{ listingId } }, profile_change { target: { handle?, displayName? } }, verify { application: { domain?, notes? } } (eligibility checked automatically: 403 VERIFIED_PLAN_REQUIRED, 409 VERIFIED_DOMAIN_REQUIRED / VERIFIED_OWNER_MFA_REQUIRED, 503 when it can't be checked; details.checks) → 201 { request, autoApproved } (request.executing while an automatic approval is still publishing or retrying). Version kinds pin the image digest and freeze the version. Failing gates → 409 PUBLISH_GATE_FAILED (details.gates); listings limit → 429 QUOTA_EXCEEDED (details.quotaType: listings); stale terms → 403 PUBLISHER_TERMS_REQUIRED. Version / update / yank / unpause need plugins:publish; the rest publishers:manage`"
            ],
            [
              "POST",
              "/plugins/publish-requests/:id/withdraw",
              "Withdraw an open request (releases the version freeze)"
            ],
            [
              "POST",
              "/plugins/publish-requests/:id/transfer-response",
              "{ accept } — the receiving publisher accepts (then the system org decides) or declines a transfer (publishers:manage + step-up)"
            ]
          ]
        },
        {
          "type": "text",
          "content": "Plugin Ecosystem: installs and consumption policy"
        },
        {
          "type": "text",
          "content": "Org-local: each route acts only on the caller's org and decides only what its pipelines may use. Installing is free on every plan (Plugin Installing)."
        },
        {
          "type": "table",
          "headers": [
            "Method",
            "Endpoint",
            "Description"
          ],
          "rows": [
            [
              "GET",
              "/plugins/catalog",
              "The in-app catalog: every listing with the org's install state, resolved version, needsApproval, blocked, the pipeline reference and shadowedBy; ?q=&category=&installed= (plugins:read)"
            ],
            [
              "GET",
              "/plugins/listings/:publisher/:name/install-state",
              "One listing's catalog entry plus its versions (breaking, yanked, paused, deprecated, vulnerability counts) and the caller's canInstall / canManage (plugins:read)"
            ],
            [
              "GET",
              "/plugins/installs",
              "The org's installs (a team's include the root's, marked inherited); `?status=active\\",
              "pending_approval\\",
              "denied\\",
              "all&implicit=true adds the implicit Official installs (id: null) (plugins:read`)"
            ],
            [
              "POST",
              "/plugins/installs",
              "{ publisher, name, versionPolicy?, version? } → 201 with status active, or pending_approval when the policy requires approval for the tier and the caller lacks plugin_installs:manage. versionPolicy: pinned \\",
              "patch \\",
              "minor (default) \\",
              "latest. Paused listing → 409 PLUGIN_UNAVAILABLE; disallowed tier or blocked listing → 403 PLUGIN_BLOCKED_BY_POLICY (plugins:install)"
            ],
            [
              "PATCH",
              "/plugins/installs/:id",
              "{ versionPolicy?, version? } — upgrade or change the policy. Crossing a major or breaking version on an approval-required tier needs plugin_installs:manage (plugins:install)"
            ],
            [
              "DELETE",
              "/plugins/installs/:id",
              "Uninstall, or withdraw a pending request. An explicit Official install falls back to the implicit one. An in-use version answers 200 with warnings: [{ code: 'PLUGIN_VERSION_IN_USE', severity: 'warning', pipelineCount, pipelines }] (never a refusal) and the org's approvers are notified (N14). (plugins:install)"
            ],
            [
              "POST",
              "/plugins/installs/:id/approve",
              "Approve a pending request; the requester is told (N12) (plugin_installs:manage)"
            ],
            [
              "POST",
              "/plugins/installs/:id/deny",
              "Deny a pending request; the requester is told (N12) (plugin_installs:manage)"
            ],
            [
              "GET",
              "/plugins/install-policy",
              "The org's saved policy, the effective one (a team's merged with its root's), inheritsFromRoot and canEdit (plugins:read)"
            ],
            [
              "PUT",
              "/plugins/install-policy",
              "{ allowedTiers, requireApprovalTiers, secretsAllowedTiers, blockOnAdvisory, officialInstalls, blockedListings } — a team's policy can only be stricter than its root's (plugin_installs:manage + step-up)"
            ],
            [
              "GET",
              "/plugins/shadowing",
              "Own-org plugins whose name shadows an Official listing for unqualified references (plugins:read)"
            ]
          ]
        },
        {
          "type": "text",
          "content": "Install errors: 403 PLUGIN_NOT_INSTALLED (details.reason: not_installed / pending_approval / denied / official_explicit / version_outside_install), 403 PLUGIN_BLOCKED_BY_POLICY (tier / blocked_listing / advisory), 409 PLUGIN_UNAVAILABLE (yanked / suspended / paused), 409 PLUGIN_NAME_LISTED (an auto-created placeholder can't take a listed name). See Error Handling."
        },
        {
          "type": "text",
          "content": "Plugin security notifications"
        },
        {
          "type": "text",
          "content": "Org-local settings for the plugin security notices: N30 (a build blocked by a scan gate — IMAGE_SCAN_UNAVAILABLE / PLUGIN_VULN_GATE; immediate) and N31 (the nightly rescan found new Critical/High findings in a stored or installed version; follows digestMode, deduplicated per version and CVE). See Plugin Publishing."
        },
        {
          "type": "table",
          "headers": [
            "Method",
            "Endpoint",
            "Description"
          ],
          "rows": [
            [
              "GET",
              "/plugins/kept-setup-images",
              "System org (plugins:moderate, aal2): { images: [{ id, pluginName, pluginVersion, imageDigest, imageSource, refusalCode, refusalMessage, refusalFindings, visibility, publishRequest, keptBy, keptAt, expiresAt }] } — gate-refused images from the setup catalog load, kept for promotion, oldest first"
            ],
            [
              "POST",
              "/plugins/kept-setup-images/:id/promote",
              "System org (plugins:moderate, aal2): re-verify the image (signature, signed SBOM), refuse a stale vulnerability DB (503), re-run the floor with the CURRENT waivers / VEX / KEV rules and the post-build compliance rules, and store the version as a passing build would → 201 { plugin: { id, name, version, imageDigest }, messages }. Still refused → 409 with the gate's code and details.findings (the image stays kept); version already exists → 409 CONFLICT; unknown id → 404. Audited plugin.setup_image.promoted / plugin.setup_image.promote_refused"
            ],
            [
              "GET",
              "/plugins/retention/plan",
              "System org (plugins:moderate, aal2): the superseded-version retention DRY RUN — refreshes the declared resolutions of pipelines naming each candidate plugin, then answers { generatedAt, enabled, dryRun: true, keep, noticeDays, batch, maxFraction, plugins: [{ name, listed, marginalBytes, refusedReason?, versions: [{ version, digest, state, rule, deferred?, deprecatedAt?, yankAfter?, notifyOrgIds?, marginalBytes }] }], collected: [], totals: { retirable, deprecate, notice, yank, reverse, refused, refusedPlugins, deferred, marginalBytes, awaitingCollection, stuck }, storage: { measured, incomplete } }. state is keep / deprecate / notice / yank / reverse / refused; rule says why. Per plugin per pass at most floor(PLUGIN_RETENTION_MAX_FRACTION × live versions) (at least one) are newly deprecated, oldest first; the rest keep state: deprecate with deferred: true and wait for a later pass. refused (with refusedReason: resolution_refresh_incomplete) means the plugin's declared-resolution refresh did not finish, so nothing was decided for it. Bytes are null when image-registry could not measure. Changes no version"
            ],
            [
              "POST",
              "/plugins/retention/run",
              "System org (plugins:moderate, aal2, step-up): run one retention pass now, whatever PLUGIN_RETENTION_ENABLED says — deprecate, yank + soft-delete after the notice period, reverse, and hand purged rows' system/<name> images to image-registry — and answer the same report with dryRun: false, each acted-on version's action (deprecated / yanked / reversed / deferred / skipped / failed, with error), and collected: [{ name, version, digest, outcome, rule?, error? }]. Audited plugin.version.retire per stage"
            ],
            [
              "GET",
              "/plugins/tidy/preview",
              "Automatic plugin version tidying, the caller's org (plugins:read): { settings: { autoTidy, staleAfterDays, neverTidy, lastDigestAt }, report: { orgId, generatedAt, dryRun: true, operatorEnabled, mode, staleAfterDays, neverTidy, lastDigestAt, nextDigestAt, versions: [{ pluginId, name, version, state, reason?, lastUsedAt, staleAt, warnedAt?, deactivateAt?, retireAt?, nextDigestAt?, bytes }], totals: { warn, warnQueued, warned, deactivate, deactivated, retire, skipped, reactivate, bytesFreed }, storage: { measured } }, canEdit, canKeep }. state is warn / warn_queued / warned / deactivate / deactivated / retire / skipped / reactivate / clear; a skipped version's reason is managed / never_tidy / only_version / inactive_by_owner / default / latest / frozen / remediation_pending / install_pin / listed_in_use / kev_accepted / in_use. Versions not near stale are left out. Changes nothing"
            ],
            [
              "PUT",
              "/plugins/tidy/settings",
              "org_settings:write: `{ autoTidy?: 'off' \\",
              "'notify' \\",
              "'on', staleAfterDays?: 30–3650 } → { settings }. Audited plugin.tidy.settings.update`"
            ],
            [
              "POST",
              "/plugins/tidy/versions/:id/keep",
              "plugins:write: Keep one of the org's versions — restarts its clock and reactivates it when tidying had deactivated it → { plugin }; 404 for another org's or a deleted version. Audited plugin.tidy.kept"
            ],
            [
              "PUT",
              "/plugins/by-name/:name/never-tidy",
              "plugins:write: { neverTidy: boolean } → { name, neverTidy, settings }; turning it on reactivates the name's tidy-deactivated versions. Audited plugin.tidy.kept"
            ],
            [
              "GET",
              "/plugins/security-notifications",
              "`{ preferences: { recipientMode: 'writers'\\",
              "'users', targetUsers, notifyRescan, digestMode: 'immediate'\\",
              "'daily'\\",
              "'weekly', webhookUrl, hasWebhookSecret, externalEmail: { masked, verified, pendingExpiresAt } \\",
              "null, updatedBy, updatedAt, canEdit } } — defaults when the org never saved; the secret and the address are never returned (plugins:read`)"
            ],
            [
              "PUT",
              "/plugins/security-notifications",
              "Partial { recipientMode?, targetUsers?, notifyRescan?, digestMode?, webhookUrl? (https, SSRF-checked; '' / null clears it and its secret), webhookSecret? ('' / null clears; omit keeps), externalEmail? ('' / null clears), resendConfirmation? }. writers = the uploader + members holding plugins:write; users needs ≥ 1 of targetUsers (max 100; only active members receive). A new or changed externalEmail starts unverified and gets a single-use 24-hour link at /notifications/confirm?token=…; it receives nothing until confirmed. Answers { preferences }; 400 VALIDATION_ERROR otherwise. Audited plugin.security_notifications.update (org_settings:write)"
            ],
            [
              "POST",
              "/plugins/security-notifications/test",
              "One test notice on every configured channel → `{ result: { relay: 'sent'\\",
              "'queued'\\",
              "'retry_queued'\\",
              "'failed', webhook: { ok, code?, error? } \\",
              "null, externalEmail: 'sent'\\",
              "'pending'\\",
              "'none' } }; audited plugin.security_notifications.test; 5 a minute per org (org_settings:write`)"
            ],
            [
              "POST",
              "/public/plugin-security-notifications/confirm",
              "Anonymous (nginx: POST-only, credentials stripped). { token } → { confirmed: true }; an unknown, used or expired token → 400 VALIDATION_ERROR. Rate limited per IP; audited plugin.security_notifications.external_email.verify"
            ]
          ]
        },
        {
          "type": "text",
          "content": "The webhook receives { event: 'N30'\\|'N31'\\|'test', type, orgId, plugin, version, subject, text, code?, gated?, failOn?, critical?, high?, findings?, occurredAt }, signed X-PB-Signature: sha256=<hmac> when a secret is set. N30 carries gated (the findings at or above the gate's threshold that broke the floor) and failOn (present only when that threshold is high); N31 carries critical / high (its new findings)."
        },
        {
          "type": "text",
          "content": "Plugin Ecosystem: reviews and ratings"
        },
        {
          "type": "text",
          "content": "Signed-in users review listings; writes need a PERSON (requireAssurance({ minAssurance: 1 }): service accounts and access keys → 403 HUMAN_SESSION_REQUIRED), are throttled per user and per org (new reviews also 20 a day per org and per trusted client IP), and are refused with 403 PLUGIN_REVIEWS_DISABLED while PLUGIN_REVIEWS_ENABLED is off. Markdown is rendered server-side (no raw HTML, no images, links rel=\"nofollow ugc noopener\"). See Plugin Installing."
        },
        {
          "type": "table",
          "headers": [
            "Method",
            "Endpoint",
            "Description"
          ],
          "rows": [
            [
              "GET",
              "/public/plugins/:publisher/:name/reviews",
              "Anonymous: published reviews, `?sort=helpful\\",
              "recent\\",
              "highest\\",
              "lowest&rating=1..5&cursor=&limit= (≤ 50) → { reviews, total, nextCursor }; each review carries author.displayName only (null once anonymized), verifiedUse, helpfulCount, edited and the publisher reply`. 404 when the listing isn't public"
            ],
            [
              "GET",
              "/plugins/listings/:publisher/:name/review-state",
              "The caller's myReview (with its status and a removal's moderationReason), helpfulReviewIds, reportedReviewIds, canReview / reviewBlockedReason (own_publisher \\",
              "reviews_disabled \\",
              "machine_credential), canReply, verifiedUse (plugins:read)"
            ],
            [
              "POST",
              "/plugins/listings/:publisher/:name/reviews",
              "{ rating: 1..5, title? (≤ 120), body? (Markdown ≤ 5000), version? } → 201. One per user per listing (409 DUPLICATE_ENTRY); 403 REVIEW_SELF_PROMOTION from the publisher's own org or a team under it; 429 RATE_LIMIT_EXCEEDED (details.reason: org_daily_limit). Too many links or a burst of unverified reviews → saved as held (plugins:read + person)"
            ],
            [
              "PATCH",
              "/plugins/reviews/:id",
              "The author edits { rating?, title?, body?, version? }; the prior text goes to history; 409 CONFLICT once removed (plugins:read + person)"
            ],
            [
              "DELETE",
              "/plugins/reviews/:id",
              "The author deletes (plugins:read + person)"
            ],
            [
              "PUT / DELETE",
              "/plugins/reviews/:id/helpful",
              "Vote, or unvote, \"helpful\" → { helpfulCount, voted }; not on your own review or your own org's listing; not audited (plugins:read + person)"
            ],
            [
              "POST",
              "/plugins/reviews/:id/report",
              "`{ category: spam \\",
              "abuse \\",
              "off_topic \\",
              "security, reason? (≤ 2000) } → { reported: true }. Three reporters hold the review; a security report holds it at once, notifies the publisher's managers and the moderators privately (N19) and opens a private advisory draft (plugins:read` + person)"
            ],
            [
              "PUT / DELETE",
              "/plugins/reviews/:id/reply",
              "The publisher's one public reply { body } (Markdown ≤ 5000); only managers of the listing's own publisher org (publishers:manage + person)"
            ]
          ]
        },
        {
          "type": "text",
          "content": "The catalog (/plugins/catalog) and install state (/plugins/listings/:publisher/:name/install-state → entry) carry rating ({ score, count } or null) and installCount; the public listing detail adds recentRating (the score over the last two minor versions)."
        },
        {
          "type": "text",
          "content": "Plugin Ecosystem: Ecosystem console (system org only)"
        },
        {
          "type": "text",
          "content": "Every route: active org = the system org, plugins:moderate and/or publishers:verify, and an MFA-grade session (aal2); a tenant-org token → 403 SYSTEM_ORG_REQUIRED. See the moderation runbook."
        },
        {
          "type": "table",
          "headers": [
            "Method",
            "Endpoint",
            "Description"
          ],
          "rows": [
            [
              "GET",
              "/plugins/ecosystem/overview",
              "Approver standing (approvers.moderate / approvers.verify: Ecosystem Manager holders, eligible and superadmin counts, with belowMinimum < 3 and belowTwoPerson < 2; count: null when platform can't answer), pending counts by lane, bootstrap-exception state, OFFICIAL_AUTO_APPROVAL_ENABLED, terms version, queued re-sign jobs, and the review queue (reviews.held, reviews.reported)"
            ],
            [
              "GET",
              "/plugins/ecosystem/requests",
              "The queue: `?status=open\\",
              "pending\\",
              "pending_second_approval\\",
              "auto\\",
              "approved\\",
              "rejected\\",
              "withdrawn\\",
              "decided&kind=&lane=&limit=; each item carries its SLA, requiresTwoPerson, requiresStepUp, requiredPermission and the caller's conflictOfInterest`"
            ],
            [
              "GET",
              "/plugins/ecosystem/requests/:id",
              "The request plus its review diff: metadata with provenance (user-edited links highlighted), contract / vulnerability / Dockerfile / SBOM deltas against the previous approved version, gates, publisher history, auto-approval verdict. An open request adds approvers (who could still decide it, minus the requester's conflicts); an open Verified application adds eligibility, a live re-check of plan, verified domain and owner MFA"
            ],
            [
              "POST",
              "/plugins/ecosystem/requests/:id/approve",
              "{ note? } — first approval of a two-person request (→ pending_second_approval, N28) or the only approval (executes). Answers { request, executed }: an execution that outlasts about 20 s carries on in the background (executed: false, executing: \"publishing\"), and one that failed transiently (image-registry down, a timeout, a 5xx) keeps the approval and is retried (executing: \"retrying\", error); a refusal rolls the approval back and answers the error. Step-up for yank, transfer, claim, profile change, Verified and moderation requests. 403 SEPARATION_OF_DUTIES for your own org's request, your own upload or your own first approval"
            ],
            [
              "POST",
              "/plugins/ecosystem/requests/:id/second-approve",
              "The second approval, by a different manager; executes the request, answering as approve does"
            ],
            [
              "POST",
              "/plugins/ecosystem/requests/:id/reject",
              "{ reason } — reject (the publisher is told)"
            ],
            [
              "GET",
              "/plugins/ecosystem/publishers",
              "Publishers with listing counts; ?tier=&suspended=&q="
            ],
            [
              "POST",
              "/plugins/ecosystem/publishers/:id/suspend",
              "{ reason } — suspend at once and re-sign with the lowest trust. An in-use version answers 200 with warnings: [{ code: 'PLUGIN_VERSION_IN_USE', severity: 'warning', pipelineCount, orgCount, pipelines }] (never a refusal) and the affected orgs are notified (N14). (publishers:verify + step-up)"
            ],
            [
              "POST",
              "/plugins/ecosystem/publishers/:id/unsuspend",
              "Opens a two-person moderation request"
            ],
            [
              "POST",
              "/plugins/ecosystem/publishers/:id/tier",
              "`{ tier: verified \\",
              "community, reason }` — to Verified: two-person request; to Community: at once, with a re-sign"
            ],
            [
              "GET",
              "/plugins/ecosystem/listings",
              "Listings with versions; ?state=&publisherId=&q= (plugins:moderate)"
            ],
            [
              "POST",
              "/plugins/ecosystem/listings/:id/state",
              "`{ state: listed \\",
              "unmaintained \\",
              "suspended, reason } — lifting a suspension is a two-person request. Suspending: an in-use listing answers 200 with warnings: [{ code: 'PLUGIN_VERSION_IN_USE', severity: 'warning', pipelineCount, orgCount, pipelines }]` (never a refusal) and the affected orgs are notified (N14). (step-up)"
            ],
            [
              "POST",
              "/plugins/ecosystem/listings/:id/versions/:version/yank",
              "{ reason } — yank at once: stops resolving, removes the public/* tag, tells the publisher (step-up)"
            ],
            [
              "POST",
              "/plugins/ecosystem/listings/:id/versions/:version/unyank",
              "{ reason } — opens a two-person moderation request (step-up). 409 once the image GC collected the version's public/* image (imageCollectedAt) — at the request and again at execution"
            ],
            [
              "POST",
              "/plugins/ecosystem/resign",
              "{ reason } — queue a re-sign of every published image (after a plugin-signing key rotation) (step-up)"
            ],
            [
              "GET",
              "/plugins/ecosystem/rules",
              "Auto-approval rules with pending changes and today's approval counts"
            ],
            [
              "POST",
              "/plugins/ecosystem/rules",
              "{ name, conditions } — created disabled; its enable waits for a second manager (step-up)"
            ],
            [
              "PATCH",
              "/plugins/ecosystem/rules/:id",
              "{ name?, enabled?, conditions? } — narrowing applies at once; enabling or widening becomes the rule's pendingChange (step-up)"
            ],
            [
              "POST",
              "/plugins/ecosystem/rules/:id/approve-change",
              "{ requestedAt } — apply the pending change you reviewed (its pendingChange.requestedAt from the rule view; a manager other than the proposer; step-up). 409 CONFLICT (details.reviewedRequestedAt / currentRequestedAt) when the proposer replaced it after you read it: reload and review the current proposal"
            ],
            [
              "DELETE",
              "/plugins/ecosystem/rules/:id",
              "Delete a rule (step-up)"
            ],
            [
              "GET / PUT / DELETE",
              "/plugins/ecosystem/reserved-names[/:name]",
              "Reserved handles / listing names; PUT body { reason?, publisherId? }"
            ],
            [
              "GET",
              "/plugins/ecosystem/reviews",
              "The review moderation queue: ?queue=open (default: held reviews plus reviews with unresolved reports) or removed; each item has the listing, author display name and user id (never the org), holdReason (reports \\",
              "burst \\",
              "filter \\",
              "security \\",
              "moderator), its reports and the publisher reply (plugins:moderate)"
            ],
            [
              "POST",
              "/plugins/ecosystem/reviews/:id/hold",
              "{ reason } — take a published review out of the directory and the score"
            ],
            [
              "POST",
              "/plugins/ecosystem/reviews/:id/release",
              "{ note? } — publish a held review (N15 to the publisher) or clear a published one's reports; resolves its reports"
            ],
            [
              "POST",
              "/plugins/ecosystem/reviews/:id/remove",
              "{ reason } — remove for good; the author is told why (N18)"
            ],
            [
              "POST",
              "/plugins/ecosystem/reviews/:id/remove-reply",
              "{ reason } — delete the publisher's reply"
            ]
          ]
        },
        {
          "type": "text",
          "content": "Ask Agent Service"
        },
        {
          "type": "text",
          "content": "The docs-grounded assistant (how-to answers) and its agent (read tools plus reviewable drafts). Every route needs one of pipelines:read, plugins:read or templates:read; the answering routes also need the ai_generation feature and AI enabled for the org. Requests are rate limited per org (ASK_RATE_LIMIT_PER_MIN, default 30 a minute) and each costs one apiCalls. Each answer also reserves an aiCalls slot (the model's weight; nothing when the caller's or org's own key pays): kept once the request is sent to the provider (an abort, timeout or provider error afterwards does not refund), refunded only when the call failed before the send."
        },
        {
          "type": "text",
          "content": "The three answering routes take one body: { query (1–6000 chars), provider?, model?, apiKey?, history?: [{ role: 'user' | 'assistant', content (≤ 8000) }] (≤ 20 entries, ≤ 32000 chars in all), repoToken? (agent only, ≤ 500; handed to the repository tools, never shown to the model) }."
        },
        {
          "type": "table",
          "headers": [
            "Method",
            "Endpoint",
            "Description"
          ],
          "rows": [
            [
              "GET",
              "/ask-agent/providers",
              "{ providers } — the AI providers this deployment can answer with"
            ],
            [
              "GET",
              "/ask-agent/availability",
              "{ available: true }, or `{ available: false, reason: 'disabled' \\",
              "'not-configured' \\",
              "'scheduled-off', message, resumesAt?, window? }` — asked when the panel opens; reads no key"
            ],
            [
              "POST",
              "/ask-agent",
              "One JSON answer: { text, sources: [{ id, title?, url? }] } (the docs it cited). Audited ask.query"
            ],
            [
              "POST",
              "/ask-agent/stream",
              "The same answer as SSE: { type: 'sources' }, then { type: 'token', data } deltas, then { type: 'done', data: { servedBy: { provider, model, fallbackFrom? }, usage } } and [DONE]. A scheduled-off model mid-stream ends with { type: 'error', message }. Audited ask.query"
            ],
            [
              "POST",
              "/ask-agent/agent/stream",
              "One agent turn as SSE: token, tool-call ({ toolName }), sources, proposal (a draft pipeline, plugin or template for the user to review — the agent writes nothing; the client applies a draft through the owning service), then done and [DONE]. Tools run as the caller, with the caller's own token and permissions. Each generating tool reserves its own aiCalls slot on top of the turn's. Audited ask.agent.turn"
            ],
            [
              "POST",
              "/ask-agent/feedback",
              "`{ kind: 'answer' \\",
              "'help-search-miss', rating?: 'up' \\",
              "'down' (required for an answer), sources?: string[] (doc ids, ≤ 20) } → { recorded: true }. Carries no free text by construction. An answer rating is audited ask.feedback`"
            ],
            [
              "POST",
              "/ask-agent/draft-outcome",
              "`{ feature: 'agent' \\",
              "'pipeline-generate' \\",
              "'plugin-generate', outcome: 'accepted' \\",
              "'edited_accepted' \\",
              "'discarded', draftId } → { recorded } — counts what happened to a reviewable draft, per org and feature only. draftId is the single-use id the generation returned with the draft (~1 h, bound to org + user + feature): reused → 409, unknown / forged / expired / another user's → 400, store unavailable → 503. Not audited (it must never be attributable to a person). Free: outside the apiCalls quota and the per-org Ask rate limit; capped per user (ASK_DRAFT_OUTCOME_RATE_LIMIT_PER_MIN`, default 20 a minute)"
            ]
          ]
        },
        {
          "type": "text",
          "content": "Compliance Service"
        },
        {
          "type": "table",
          "headers": [
            "Method",
            "Endpoint",
            "Description"
          ],
          "rows": [
            [
              "POST",
              "/compliance/scans",
              "Trigger a scan of the caller's whole org: { target, dryRun? } (strict body — any other field, e.g. a filter, is a 400)"
            ],
            [
              "POST",
              "/compliance/exemptions",
              "Request an exemption"
            ],
            [
              "POST",
              "/compliance/exemptions/bulk",
              "Bulk-create up to 500 exemptions in one call"
            ],
            [
              "PUT",
              "/compliance/exemptions/:id/review",
              "Approve/reject an exemption (requester cannot self-approve)"
            ],
            [
              "PUT",
              "/compliance/exemptions/:id/expiry",
              "Extend an approved, unlapsed exemption: { expiresAt } later than the current one (requester cannot extend their own)"
            ],
            [
              "POST",
              "/compliance/scan-schedules",
              "Create a cron-driven scan schedule (cron validated at insert time)"
            ],
            [
              "POST",
              "`/compliance/validate/{plugin\\",
              "pipeline}`",
              "Live compliance check (5s timeout, fail-closed)"
            ],
            [
              "POST",
              "`/compliance/validate/{plugin\\",
              "pipeline}/dry-run`",
              "Same evaluation, no audit/notify side-effects"
            ],
            [
              "GET",
              "/compliance/notification-preferences",
              "Read the org's notification preference (defaults when unset)"
            ],
            [
              "PUT",
              "/compliance/notification-preferences",
              "Update notification preference (org admin; webhook secret never returned)"
            ]
          ]
        },
        {
          "type": "text",
          "content": "Quota Service"
        },
        {
          "type": "table",
          "headers": [
            "Method",
            "Endpoint",
            "Description"
          ],
          "rows": [
            [
              "GET",
              "/quotas",
              "Caller's org quotas (every type, incl. automationCalls) plus periodDays (QUOTA_RESET_DAYS)"
            ],
            [
              "GET",
              "/quotas/all",
              "All orgs' quotas (platform:read). ?limit= 1–1000 (default 100) and ?offset= 1-based, capped at 100 000 — deep paging past that is refused-by-clamp rather than turned into an unbounded collection scan"
            ],
            [
              "GET",
              "/quotas/at-risk?threshold=80",
              "Orgs ≥ threshold% on any quota dimension (platform:read)"
            ],
            [
              "GET",
              "/quotas/:orgId",
              "Specific org quotas (orgId in URL — auth scoped; the id is matched case-insensitively and canonicalized to lowercase for the lookup)"
            ],
            [
              "GET",
              "/quotas/:orgId/usage",
              "\"What used this\": the usage ledger grouped by `groupBy=principal\\",
              "route\\",
              "pipeline\\",
              "day\\",
              "feature\\",
              "model over from/to (ISO; default the current period, max 400 days), optional type; format=csv downloads it (quotas:read). Every group carries tokensIn/tokensOut (AI calls); feature groups add feature, model groups model + keySource` (one row per model × key source). A pool root sees its whole account, a team its own usage"
            ],
            [
              "GET",
              "/quotas/:orgId/own-usage",
              "Internal (callers: billing): the org's OWN, unpooled counters — the per-team usage breakdown"
            ],
            [
              "GET",
              "/quotas/:orgId/notice-settings",
              "The account's 80% / 100% quota-notice settings and its optional AI controls (aiCallsPerMemberPct, aiTokenBudget; null = off) (quotas:read; a team reads its root's)"
            ],
            [
              "PUT",
              "/quotas/:orgId/notice-settings",
              "{ enabled?, webhookUrl?, aiCallsPerMemberPct?, aiTokenBudget? } — opt out of notices / set the quota.threshold webhook / set or clear (null) the optional AI controls: per-member share of aiCalls (1–100 %) and per-period platform-key token budget (billing:manage, root org only). See API Quotas → AI calls"
            ],
            [
              "GET",
              "/quotas/:orgId/:type",
              "Single quota type status"
            ],
            [
              "PUT",
              "/quotas/:orgId",
              "Update tier/limits (quotas:manage, system org + MFA)"
            ],
            [
              "PUT",
              "/quotas/entitlement-sync/:orgId",
              "Internal (callers: billing): the billing → quota entitlement sync, same body as PUT /quotas/:orgId"
            ],
            [
              "POST",
              "/quotas/:orgId/reset",
              "Reset usage counters (quotas:manage; + step-up, service principals exempt)"
            ],
            [
              "POST",
              "/quotas/:orgId/increment",
              "Internal (service-to-service only, no user token): increment usage (amount capped at 1000/call)"
            ],
            [
              "POST",
              "/quotas/:orgId/decrement",
              "Internal (service-to-service only, no user token): roll back a reserve"
            ]
          ]
        },
        {
          "type": "text",
          "content": "Pooled (account) limits and the 503 refusal. For an org → team hierarchy the binding cap is the ROOT's, counted against the whole subtree; a team's own limits are seeded -1 precisely because only the root's pooled cap is meant to apply. So when the pooled cap cannot be resolved (a hierarchy read fails), the quota service does NOT fall back to the team's own row — that would be unlimited, not degraded. It serves the last-known root cap for up to QUOTA_POOL_FALLBACK_TTL_MS (default 60s) and otherwise answers 503 SERVICE_UNAVAILABLE (\"Quota is temporarily unenforceable for organization …\"), which reads and increments alike surface. A root or flat org is unaffected: its own row carries real limits, so enforcement continues there. Every such event increments quota_pool_resolution_failed_total{quotaType,outcome} with outcome = cached | denied | own_limits — alert on denied."
        },
        {
          "type": "text",
          "content": "Message Service"
        },
        {
          "type": "text",
          "content": "Base path /api/messages. Reads require messages:read; writes require messages:write — except contacting support, which every member may do with messages:read (see below). Announcements (broadcast, recipientOrgId: \"*\") are system-admin only."
        },
        {
          "type": "table",
          "headers": [
            "Method",
            "Endpoint",
            "Description",
            "Permission"
          ],
          "rows": [
            [
              "GET",
              "/messages",
              "Inbox (root messages), paginated + viewer-scoped. Filters (all three list routes): ?search= (subject/content), isRead, priority, channel, `sentBy=me\\",
              "org\\",
              "others, senderUserId, counterpartyOrgId, and hidden=true` for the rows this org removed from its inbox",
              "messages:read"
            ],
            [
              "GET",
              "/messages/conversations \\",
              "/announcements",
              "Conversations / announcements views",
              "messages:read"
            ],
            [
              "GET",
              "/messages/unread/count",
              "Unread count for the caller",
              "messages:read"
            ],
            [
              "GET",
              "/messages/:id \\",
              "/:id/thread",
              "A message / its full thread (viewer-scoped)",
              "messages:read"
            ],
            [
              "POST",
              "/messages",
              "Send a conversation or announcement",
              "messages:write"
            ],
            [
              "POST",
              "/messages/support",
              "Contact support: a conversation to the support desk. Body is subject, content, optional priority / attachmentIds — no recipient: the server forces recipientOrgId to the system support org and channel to support, and ignores any recipientOrgId / recipientUserId / messageType / channel in the body",
              "messages:read"
            ],
            [
              "POST",
              "/messages/:id/reply",
              "Reply to a thread. On an announcement it starts a new support conversation instead (see below)",
              "messages:write"
            ],
            [
              "POST",
              "/messages/attachments",
              "Upload one attachment (multipart file) → returns its id",
              "messages:write"
            ],
            [
              "GET",
              "/messages/attachments/:id",
              "Download an attachment (auth-gated, inherits message visibility); ?thumb=1 serves the downscaled image thumbnail, falling back to the original",
              "messages:read"
            ],
            [
              "GET",
              "/messages/:id/attachments",
              "List a message's attachment metadata",
              "messages:read"
            ],
            [
              "DELETE \\",
              "POST",
              "/messages/:id[/restore]",
              "Soft-delete / restore (restore + step-up)",
              "messages:write"
            ],
            [
              "POST",
              "/messages/delete",
              "Bulk soft-delete { ids } (≤ 200). Same per-row rule as DELETE /messages/:id — a non-admin's own root messages only — so refused / missing ids come back in refused / notFound rather than failing the call; one message.delete audit row per deleted message",
              "messages:write"
            ],
            [
              "POST",
              "/messages/hide",
              "Remove from THIS org's inbox — a view change, not a delete. Body is the list filters (an empty body = the whole tab) and/or ids (≤ 200), AND-ed with visibility",
              "messages:read"
            ],
            [
              "POST",
              "/messages/unhide",
              "Put { ids } back into this org's inbox (the undo of /hide)",
              "messages:read"
            ],
            [
              "POST",
              "/messages/read",
              "Set this org's read state on { ids, isRead }. true also marks each thread's replies read; false clears the root only",
              "messages:read"
            ]
          ]
        },
        {
          "type": "text",
          "content": "Contacting support: reaching support is self-service, so POST /messages/support is gated on messages:read — the same authority the inbox needs — rather than messages:write. A read-only member can therefore file a request although they cannot send ordinary messages. The route is safe at that floor because the recipient is not a caller input: it is always the system support org, on the reserved support channel. Everything else (validation, attachment linking, the SSE ping, the send rate limit) matches POST /messages; announcements, broadcasts and per-user targeting do not apply. Attachments must still be uploaded through POST /messages/attachments, which remains messages:write."
        },
        {
          "type": "text",
          "content": "Replying to an announcement: announcements are one-way. A member's POST /messages/:id/reply on an announcement does not add a row to the broadcast's thread, which every org can open. It starts a new conversation between the member's org and the system support org on the support channel, with the subject Re: <announcement subject>. The member's text comes first, and the announcement (its subject, when it went out, and an excerpt) is quoted below it. The 201 returns that new conversation, and its id is the thread to follow. Attachments link to it. No support case is opened. Support staff answer in that thread. A system-org reply on the announcement itself is refused with 400."
        },
        {
          "type": "text",
          "content": "Per-user direct messages: a conversation POST /messages may include recipientUserId (a member of recipientOrgId) to target a single user — only that user (plus the sender org and system org) can see the message and its replies/attachments. Omit it for an org-wide message. recipientUserId is rejected on announcements/broadcasts."
        },
        {
          "type": "text",
          "content": "Attachments flow: POST /messages/attachments first (one call per file, ≤ MESSAGE_ATTACHMENT_MAX_MB, MIME allow-listed), then pass the returned ids as attachmentIds on POST /messages or /:id/reply. Blobs live in S3-compatible storage (RustFS); see Environment Variables → Messaging & Attachments."
        },
        {
          "type": "text",
          "content": "Organization & Access Service"
        },
        {
          "type": "text",
          "content": "Base path /api/organization (and /api/invitation). Management endpoints enforce fine-grained permissions via requirePermission('resource:action') — a user passes if their effective permissions (the union of the Roles assigned to them) include it, or they're a super-admin. The required permission is in the last column; the few endpoints still marked system admin require the global super-admin flag instead, and Roles & Permissions says why each one does."
        },
        {
          "type": "text",
          "content": "Cross-tenant permissions such as orgs:manage are system-org-only: they cannot be granted inside a tenant, and the route additionally requires that the caller's active org be the system org and that their session be MFA-grade."
        },
        {
          "type": "table",
          "headers": [
            "Method",
            "Endpoint",
            "Description",
            "Permission"
          ],
          "rows": [
            [
              "GET",
              "/organization",
              "Caller's active organization",
              "— (auth)"
            ],
            [
              "POST",
              "/organization",
              "Create an organization or nested team",
              "org_settings:write"
            ],
            [
              "GET",
              "/organization/:id",
              "Get an organization, with a page of its member roster (?membersLimit= 1–500, default 100; ?membersOffset=) — memberCount is always the full total. For a sysadmin it also carries the hierarchy: parentOrgId, parentOrgName and teams: [{ orgId, orgName }] (live teams)",
              "— (own org / managed team / sysadmin)"
            ],
            [
              "PUT",
              "/organization/:id",
              "Update an organization's name, slug and/or description (+ step-up). The only route that edits the description",
              "orgs:manage"
            ],
            [
              "DELETE",
              "/organization/:id",
              "Soft-delete an organization (+ step-up): recovery snapshot, purgeAfter retention window, sessions cut → 202 { deletedAt, purgeAfter, snapshotId }. The window is max(ORG_DELETION_RETENTION_DAYS, SOFT_DELETE_RETENTION_DAYS) — the org must outlive the rows its cascade tombstones. At purge, platform removes its own data and hands every other service's share to its durable cascade outbox (one retried, dead-letter-alerted leg per service, written in the hard delete's own transaction). Refused (400) while it has live teams",
              "orgs:manage"
            ],
            [
              "POST",
              "/organization/:id/restore",
              "Restore a soft-deleted org inside its window (+ step-up). A parent admin may restore its own team; a team restore needs its parent live and still team-capable (409) and room in the account's pooled seats (409), and re-syncs the root's tier + entitlements",
              "org_settings:write (own org / managed team)"
            ],
            [
              "POST",
              "/organization/:id/move",
              "Reparent (+ step-up). Body `{ parentOrgId: string \\",
              "null }: a team to another eligible root (team/enterprise tier), a team out as a standalone root (null), or a root with no teams (live or pending deletion) in under a root. Refuses self-parenting, cycles, nesting two deep, an ineligible/missing destination and a no-op (400/404), a move over the destination's seat cap (409), a competing move that landed first (409 ORG_MOVE_CONFLICT — every structural check is re-asserted inside the transaction and the write is conditional on the parent this request read, so of two interleaved moves exactly one commits), and nesting a root that still has a billable subscription (409, cancel it first; 503 if billing can't confirm). Re-syncs tier, entitlements and quota seeding for the new account (a team takes the root's tier + entitlements with -1 quotas; a new root starts on the default tier, since no subscription follows it, with that tier's quota preset and no entitlements) and invalidates every session scoped to the org → { organization }` (the detail DTO with hierarchy)",
              "orgs:manage"
            ],
            [
              "PATCH",
              "/organization/:id/tier",
              "Change pricing tier (+ step-up)",
              "orgs:manage"
            ],
            [
              "GET",
              "/organization/:id/export",
              "GDPR data export (+ step-up) — a single JSON blob carrying every Postgres table and every Mongo collection the delete cascade removes (invitations, audit events, IdP config + group mappings, domains, join requests, SAML SLO sessions, service accounts + keys with the key hash stripped, memberships, Role assignments and Roles). The same artifact is captured as the recovery snapshot at soft-delete time; failed names any store that could not be read and truncated any that hit its cap",
              "org_settings:write"
            ],
            [
              "PATCH",
              "/organization/:id/transfer-owner",
              "Transfer ownership (+ step-up on an aal: 2 session)",
              "org_settings:write"
            ],
            [
              "GET",
              "/organization/:id/members",
              "List members",
              "— (member)"
            ],
            [
              "GET",
              "/organization/:id/members/:userId/exists",
              "Active-membership probe ({ isMember }) — internal, used by the message service to reject a per-user DM to a non-member",
              "— (service / member)"
            ],
            [
              "POST \\",
              "DELETE \\",
              "PATCH",
              "`/organization/:id/members[/:userId[/activate\\",
              "deactivate]]`",
              "Add / remove / change-role / (de)activate a member",
              "members:manage"
            ],
            [
              "GET",
              "/organization/:id/teams",
              "List live descendant teams (soft-deleted teams are excluded here, from /:id/member/:memberId/teams and from /:id/descendants)",
              "— (member)"
            ],
            [
              "GET",
              "/organization/:id/teams/deleted",
              "Soft-deleted teams of :id still inside their retention window → { teams: [{ orgId, orgName, deletedAt, purgeAfter }] }, newest first. Restore with POST /organization/:teamId/restore",
              "org_settings:write (admin of :id)"
            ],
            [
              "DELETE",
              "/organization/:id/teams/:teamId",
              "A parent admin soft-deletes one of its own teams (+ step-up) — the same snapshot + retention window as the sysadmin delete → 202 { deletedAt, purgeAfter, snapshotId }. 404 unless the team's direct parent is :id. The team leaves the live scope at once: its members stop counting against pooled seats and it drops out of team lists and rollups",
              "org_settings:write (admin of :id)"
            ],
            [
              "GET",
              "/organization/:id/roles",
              "List Roles (permission sets) + members. Every Role without ?limit=; with it (1–100, plus ?offset=) one page, members loaded for that page only. Always returns pagination.total",
              "— (member)"
            ],
            [
              "POST",
              "/organization/:id/roles",
              "Create a custom Role",
              "roles:manage"
            ],
            [
              "PUT \\",
              "DELETE",
              "/organization/:id/roles/:roleId",
              "Update / delete a custom Role",
              "roles:manage"
            ],
            [
              "POST \\",
              "DELETE",
              "/organization/:id/roles/:roleId/members[/:userId]",
              "Add / remove a Role member",
              "roles:manage"
            ],
            [
              "GET",
              "/organization/:id/service-accounts[/:accountId]",
              "List (or read) the org's service accounts with their roles + key metadata — never a secret",
              "service_accounts:manage"
            ],
            [
              "POST \\",
              "PATCH \\",
              "DELETE",
              "/organization/:id/service-accounts[/:accountId]",
              "Create / update (description, roles, token budget, disabled) / delete a service account. Delete removes every key with it",
              "service_accounts:manage + step-up"
            ],
            [
              "POST",
              "/organization/:id/service-accounts/:accountId/keys",
              "Issue a pb_sa_… key — returned once ({ key, accessKey }); optional ipAllowlist and scope (one capability instead of the account's Roles: reporting:ingest, registry:push, scim), max 365 days, 5 active keys per account",
              "service_accounts:manage + step-up"
            ],
            [
              "POST",
              "/organization/:id/service-accounts/provision-key",
              "Find-or-create an account by name, issue it a key, and retire its oldest key at the 5-key cap — one step-up for all of it (pipeline-manager infra store-token). Body { accountName, description?, role?, scope?, key: { name, expiresIn } }; role (a seed bundle, e.g. pipeline_automation) is granted only to a NEW account, never to an existing one. 201 { organizationId, serviceAccount: { id, name, created }, key, accessKey: { id, expiresAt, scope }, retiredKeyIds }; 409 SA_BUILTIN_ROLE_MISSING when the org lacks that built-in Role. Audited as the same create / key-create / key-revoke events the individual routes write (details)",
              "service_accounts:manage + step-up"
            ],
            [
              "DELETE",
              "/organization/:id/service-accounts/:accountId/keys/:keyId",
              "Revoke one key — it stops working fleet-wide within 5 minutes. Deliberately not step-up gated, so a compromised key can be killed immediately",
              "service_accounts:manage"
            ],
            [
              "GET \\",
              "POST",
              "/organization/:id/idp/group-mappings",
              "List / create an IdP group → Role mapping. SSO sign-in grants the mapped Roles (and creates the membership). Refused for a google config — Google issues no group claims",
              "roles:manage (+ sso entitlement)"
            ],
            [
              "PUT \\",
              "DELETE",
              "/organization/:id/idp/group-mappings/:mappingId",
              "Update / delete a mapping. Roles it granted fall away at each member's next sign-in; Roles assigned by hand are never removed",
              "roles:manage (+ sso entitlement)"
            ],
            [
              "GET \\",
              "PUT \\",
              "PATCH \\",
              "DELETE",
              "/organization/:id/idp",
              "Read / upsert / patch / remove the org's own SSO connection — OIDC or SAML, selected by protocol. A write that leaves the selected protocol unable to sign anyone in is refused (400). The client secret is write-only; the SAML entity ID, SSO/SLO URLs, signing certificates, attribute mapping and the samlSignAuthnRequests / samlEncryptAssertions switches are returned in full (all public), with ssoRequired and the lastTest result. allowedEmailDomains must be DNS-verified domains of the org (400 IDP_DOMAIN_NOT_VERIFIED). PATCH { ssoRequired: true } needs an enabled connection, a verified domain and a successful test of the current settings (409); any connection change clears lastTest. Writes require an MFA-grade session and a step-up earned by a passkey or authenticator code",
              "org_idp:write (+ sso entitlement)"
            ],
            [
              "GET",
              "/organization/:id/idp/sp-info",
              "The values to register AT the IdP, computed from the deployment's public URL and SP keys: { sp: { entityId, acsUrl, metadataUrl, sloUrl, oidcRedirectUri, signingCertificate, encryptionCertificate } }. Available before any connection exists",
              "org_idp:write (+ sso entitlement)"
            ],
            [
              "POST",
              "/organization/:id/idp/metadata/import",
              "Parse an IdP SAML metadata document — { xml } or { url } (fetched under the SSRF guard: https, no private addresses, no redirects, 5 s, 512 KB) — into { metadata: { entityId, ssoUrl, sloUrl?, certificates, wantsSignedRequests } }. Saves nothing",
              "org_idp:write (+ sso entitlement)"
            ],
            [
              "POST",
              "/organization/:id/idp/test",
              "Start a test connection (dry run) → { url, state } for a popup. Works before the connection is enabled",
              "org_idp:write (+ sso entitlement)"
            ],
            [
              "POST",
              "/organization/:id/idp/test/complete",
              "{ state, code?, error? } → { report }: ok / reason, asserted email / name / groups, the role mappings that would apply. Creates no session, user or membership; only the admin who started the test can collect it. Recorded as lastTest and audited sso.test",
              "org_idp:write (+ sso entitlement)"
            ],
            [
              "GET \\",
              "PATCH",
              "/organization/:id/mfa-policy",
              "Read / change the org's two-factor requirement: requireMfa, a graceDays count the deadline is computed from server-side (0–90, default 14), and idpEnforcesMfa — the org's statement that its own IdP requires a second factor, which is what makes an SSO sign-in count as aal: 2. Enforced when a token is ISSUED, not per route: past the grace period a single-factor session is refused with 401 MFA_REQUIRED. The read returns both the org's own setting and what a parent org imposes (inheritedFrom + inheritedFromName, the parent's id and name, when a parent's requirement applies), plus enrolment: { members, enrolled } — how many ACTIVE members hold a passkey or a confirmed authenticator app, so an admin choosing a grace period can see how many people it would refuse (someone holding both factors counts once). Also adminActionsRequireMfa — the separate \"administrative actions require MFA\" policy (read returns adminActionsRequireMfa, adminActionsOwn, adminActionsInheritedFrom[Name]); turning it ON signs every other member of the org and its teams out so the org_admin_aal claim applies at once, while turning it off lets each token pick it up at its next refresh (sessionsRefreshed in the response). The write is step-up gated; LOOSENING anything (requirement off, admin-actions policy off, idpEnforcesMfa on) also needs an aal: 2 session (401 MFA_REQUIRED otherwise), while tightening does not. Refused (409 MFA_BOOTSTRAP_STILL_OPEN) for the system org while the bootstrap-admin exception is still open",
              "org_settings:write"
            ],
            [
              "GET \\",
              "PATCH",
              "/organization/:id/setup-guide",
              "Read / change whether an org admin has dismissed the one-time \"finish setting up your org\" guide → { dismissedAt, dismissedBy, topLevel } (ISO timestamp / user id, null while the guide is still offered; topLevel is false for a team). PATCH { dismissed: boolean }: true stamps when and by whom (idempotent — dismissing again keeps the first stamp), false clears both so the guide is offered again. A UI preference, not a control: no step-up. Audited as org.setup_guide.update",
              "org_settings:write"
            ],
            [
              "GET \\",
              "POST",
              "/organization/:id/mfa-resets",
              "Two-person MFA reset. GET lists pending (first) and recent requests for the org and its teams. POST { userId, reason } requests a reset of an active member's second factors (owner/admin; aal: 2 + step-up). 409 MFA_RESET_SELF / MFA_RESET_ALREADY_PENDING, 403 MFA_RESET_PLATFORM_ADMIN, 404 MFA_RESET_NOT_MEMBER",
              "members:manage"
            ],
            [
              "POST",
              "/organization/:id/mfa-resets/:requestId/approve",
              "Approve, { graceHours? } (1–168, default 72): removes every passkey, the authenticator app and the recovery codes, ends every session, and grants the member a per-user enrolment grace. A DIFFERENT owner/admin of the org or an ancestor, or a sysadmin (403 MFA_RESET_SECOND_PERSON_REQUIRED for the requester or the member); 410 MFA_RESET_EXPIRED after 24h. aal: 2 + second-factor step-up",
              "members:manage"
            ],
            [
              "POST",
              "/organization/:id/mfa-resets/:requestId/deny",
              "Deny (or, by its requester, withdraw), { note? }. No step-up — it only removes a pending action",
              "members:manage"
            ],
            [
              "POST",
              "/admin/users/:id/mfa-reset",
              "A sysadmin's DIRECT MFA reset, { reason, graceHours? } — the single-person path for an org with no second admin; same effect as an approved request, audited as auth.mfa.direct_reset. aal: 2 + second-factor step-up",
              "sysadmin"
            ],
            [
              "GET \\",
              "PATCH",
              "/organization/:id/impersonation-policy",
              "Read / change whether platform operators may view as this org's members (open, consent, denied) and allowSelfApproval. Returns the EFFECTIVE policy (strictest across the org and its ancestors) with the org's own setting; when a parent's stricter policy applies, inheritedFrom + inheritedFromName name it. The write is step-up gated",
              "org_impersonation:write"
            ],
            [
              "GET",
              "/admin/orgs/:orgId/kms-config",
              "Whether the org has its own per-org KMS config (configured, keyId); the wrapped master is never returned",
              "org_kms:write + system admin"
            ],
            [
              "PUT \\",
              "DELETE",
              "/admin/orgs/:orgId/kms-config",
              "Set ({ keyId, ciphertextBase64 }) / clear the org's per-org KMS config — DELETE falls the org back to the shared master. Both re-encrypt the org's platform secrets under the incoming provider and re-wrap its runner signing keys → { configured, keyId?, …counts } (DELETE on an org with no config answers 200 { configured: false } and changes nothing). ?reencrypt=false skips only the platform-secret re-encrypt (those secrets become unreadable; the runner keys are still re-wrapped). 409 when a stored secret cannot be decrypted under the current provider — nothing is changed; 500 when the config was saved but the re-encrypt (or the runner-key re-wrap) failed mid-flight — audited as a failure. MFA session (aal2) + step-up by passkey or authenticator code",
              "org_kms:write + system admin"
            ],
            [
              "POST",
              "/admin/orgs/:orgId/kms-config/test",
              "Dry-run a proposed config (the CMK exists, the platform can decrypt it, the wrapped master is well-formed). Saves nothing",
              "org_kms:write + system admin"
            ]
          ]
        },
        {
          "type": "text",
          "content": "SCIM 2.0 (/api/scim/v2)"
        },
        {
          "type": "text",
          "content": "Base path /api/scim/v2 — driven by the customer's identity provider, not by the dashboard. Authenticated ONLY by a service-account key carrying the scim scope (Authorization: Bearer pb_sa_…); a user token is refused. No org id appears in any path: the org is the key's own. Media type application/scim+json; failures are RFC 7644 …:2.0:Error documents with a string status and, where the RFC defines one, a scimType. Rate-limited per organization in its own bucket. Full behaviour — seats, verified domains, session revocation, the post-downgrade asymmetry — in SCIM 2.0 provisioning."
        },
        {
          "type": "table",
          "headers": [
            "Method",
            "Endpoint",
            "Description"
          ],
          "rows": [
            [
              "GET",
              "/scim/v2/ServiceProviderConfig, /ResourceTypes, /Schemas",
              "Discovery documents (what a validator fetches first)"
            ],
            [
              "GET",
              "/scim/v2/Users",
              "List members. filter supports userName eq, externalId eq, active eq, emails.value eq; pages with startIndex (1-based) + count (default 100, max 200)"
            ],
            [
              "POST",
              "/scim/v2/Users",
              "Provision a member. 409 uniqueness if already a member; 400 invalidValue at an unverified email domain; 403 naming the seat limit when the account is full"
            ],
            [
              "GET \\",
              "PUT \\",
              "PATCH",
              "/scim/v2/Users/:id",
              "Read / replace / patch. active:false deactivates the membership, drops the roles the directory granted, and revokes every session immediately. userName is write-once (400 mutability)"
            ],
            [
              "DELETE",
              "/scim/v2/Users/:id",
              "Deactivate + revoke sessions (the membership row is kept). Idempotent; 204"
            ],
            [
              "GET",
              "/scim/v2/Groups",
              "List directory groups (the group → Role mapping rows). filter: displayName eq, externalId eq"
            ],
            [
              "POST \\",
              "PUT \\",
              "PATCH",
              "/scim/v2/Groups[/:id]",
              "Create / replace / patch a group and its members. SCIM never sets a group's roles — that stays a roles:manage decision in the dashboard"
            ],
            [
              "DELETE",
              "/scim/v2/Groups/:id",
              "Remove the group; its members lose the roles it mapped to (hand-granted roles stay). 204"
            ],
            [
              "POST",
              "/invitation/send",
              "Invite one or many addresses (emails[], max 100); reports each",
              "invitations:manage"
            ],
            [
              "GET",
              "/invitation",
              "List invitations",
              "invitations:manage"
            ],
            [
              "DELETE \\",
              "POST",
              "/invitation/:id[/resend]",
              "Revoke / resend an invitation",
              "invitations:manage"
            ]
          ]
        },
        {
          "type": "text",
          "content": "The full permission catalog (pipelines:write, pipelines:publish, plugins:publish, compliance:write, billing:manage, reports:rollup, org_settings:write, …) lives in @pipeline-builder/api-core (types/permissions.ts). Custom Roles grant a subset of the org-assignable permissions (registry:* are never org-assignable and are rejected — :read/:write are system-org-only, :purge is Super-Admin-only) that is also bounded by the author's own permissions (a permission ceiling — you can't grant what you don't hold); a member's effective permissions are the union of the Roles assigned to them, and :read permissions are enforced. Managing Roles is gated by roles:manage. See Roles & Permissions for the full catalog, built-in bundles, and enforcement."
        },
        {
          "type": "text",
          "content": "Account & Sessions"
        },
        {
          "type": "text",
          "content": "Base path /api/user (and /api/auth). These are the caller's own account — no capability applies; a few writes require a step-up token (X-Step-Up-Token, from POST /auth/step-up)."
        },
        {
          "type": "table",
          "headers": [
            "Method",
            "Endpoint",
            "Description",
            "Gate"
          ],
          "rows": [
            [
              "POST",
              "/auth/sso/discover",
              "Login-page hint: { email } → { sso: boolean, required: boolean } — does an enabled, entitled IdP serve the domain, and does its org require SSO. Deliberately reports nothing else (not the owner break-glass exemption either) — it is unauthenticated, so returning the org id or provider would make it a tenant-enumeration oracle. Answers on the DOMAIN, so an address with no account looks identical to one with; a bootstrap-admin address always answers false (SSO refuses superadmins, and hiding their password field would close both paths)",
              "— (pre-auth)"
            ],
            [
              "POST",
              "/auth/sso/start",
              "Start per-org SSO from an EMAIL: { email } → { url, state }, the same pair the by-org route returns. For the sign-in form, which knows the address and not the tenant — the serving org is resolved server-side, so discovery never has to hand out an org id. Works whether the org requires SSO or only offers it. 404 SSO_NOT_AVAILABLE when no enabled, entitled IdP serves the domain",
              "— (pre-auth)"
            ],
            [
              "POST",
              "/auth/sso/logout",
              "SP-initiated SAML single logout for the caller's OWN current session → { redirectUrl }: a signed LogoutRequest to the IdP's SLO URL when the session came from a SAML sign-in and the IdP has one, else null. Call before /auth/logout, follow after",
              "— (auth)"
            ],
            [
              "GET",
              "/auth/sso/:orgId/authorize",
              "Start per-org SSO → { url, state }. Serves both protocols: the org's protocol decides whether url is an OIDC authorization request or a SAML AuthnRequest, and the caller just redirects to it",
              "— (pre-auth; enabled + sso-entitled)"
            ],
            [
              "POST",
              "/auth/sso/:orgId/callback",
              "OIDC leg: { code, state } → the same { accessToken } + refresh cookie password login returns",
              "the IdP's code + the state"
            ],
            [
              "GET",
              "/auth/sso/:orgId/saml/metadata",
              "SAML service-provider metadata (XML) for the IdP administrator: entity ID, ACS URL (HTTP-POST), SLO URL (HTTP-Redirect + HTTP-POST), WantAssertionsSigned, AuthnRequestsSigned per the org's switch, the SP signing certificate and — only when the org enabled encrypted assertions — the encryption certificate. Works before the connection does and leaks nothing",
              "— (public)"
            ],
            [
              "GET \\",
              "POST",
              "/auth/sso/:orgId/saml/slo",
              "SAML single logout endpoint (HTTP-Redirect / HTTP-POST). A signed IdP LogoutRequest revokes that NameID's sessions in the org (in bounded batches, at most 1000 per request — the rest lapse with their refresh window and the cap is recorded on the audit event) and is answered with a signed LogoutResponse; a signed LogoutResponse to ours lands the browser on sign-in. Unsigned, forged, replayed or foreign-issuer messages are refused",
              "the IdP's signature"
            ],
            [
              "POST",
              "/auth/sso/:orgId/saml/acs",
              "SAML Assertion Consumer Service — the IdP posts SAMLResponse + RelayState here. Verifies the signature, issuer, audience and validity window, refuses IdP-initiated and replayed assertions, provisions JIT membership, then redirects to /auth/sso/:orgId/saml with a one-time handoff (or an error code). Never returns tokens",
              "the assertion + the RelayState"
            ],
            [
              "POST",
              "/auth/sso/:orgId/saml/complete",
              "Redeem that handoff, { handoff } → the same { accessToken } + refresh cookie password login returns. Single-use and org-bound; the session is minted here, so it records the redeeming browser",
              "the handoff itself"
            ],
            [
              "POST",
              "/auth/password/reset-request",
              "Forgot password, { email } → always 200 with the same message, whether or not an email went out (no account enumeration). Mints a single-use link (/auth/reset-password?token=<64 hex>, AUTH_PASSWORD_RESET_TOKEN_TTL_MS, 1 h) stored only as a SHA-256; a new request supersedes the previous link. No link for an unknown address, a password-less (social/SSO-only) account, or an identity under an org's \"SSO required\" policy. Limited to 3 per address and 20 per IP per 15 min (429 RATE_LIMIT_EXCEEDED). Audited user.password.reset.request",
              "— (pre-auth)"
            ],
            [
              "POST",
              "/auth/password/reset",
              "Set a new password with the emailed token, { token, newPassword } → 200 { accessKeysRevoked }. Ends every session (tokenVersion bump + every refresh slot) and revokes every access key; the next sign-in still asks for the second factor. 400 PASSWORD_RESET_TOKEN_INVALID (unknown, expired or used), 400 PASSWORD_UNCHANGED, 400 PASSWORD_TOO_SHORT_FOR_ORG / PASSWORD_BREACHED (the link stays usable), 403 SSO_REQUIRED. Audited user.password.reset",
              "the token itself"
            ],
            [
              "POST",
              "/auth/refresh",
              "Rotate a session's token pair — a device's, or a machine credential's (until its fixed end). The browser presents the pb_refresh cookie (empty body); a CLI/machine caller posts { refreshToken }. A concurrent refresh with the immediately-previous token within 30 s gets the current pair instead of revoking the session",
              "refresh cookie or body token, + X-Pb-Client"
            ],
            [
              "POST",
              "/auth/logout",
              "End the current session's slot and clear the refresh cookie",
              "— (auth), + X-Pb-Client"
            ],
            [
              "POST",
              "/auth/switch-org",
              "Re-scope the current session to { organizationId } (same slot, same assurance). Returns { accessToken, expiresIn } only — no refresh token, no cookie change: the slot records the org and its next refresh renews there. Allowed with a membership there or admin authority inherited from a parent org — a parent admin can open its teams as admin with no roster entry (see Authentication → parent-admin access). 403 otherwise",
              "— (auth)"
            ],
            [
              "GET",
              "/user/organizations",
              "Orgs the caller can switch into: membership rows (organizationId, organizationName, slug, role, isActive, joinedAt, parentOrgId, parentOrgName, tier, childOrgCount), then one viaAncestor: true row (role: 'admin') per live team of an org they administer but aren't a member of",
              "— (auth)"
            ],
            [
              "GET",
              "/user/password-policy",
              "The minimum length a NEW password of the caller's must meet — the strictest effective policy across every org they belong to (the bar /user/change-password enforces): { minLength, maxLength }. The org's own policy endpoint needs org_settings:write; this one is for the person changing their password",
              "— (auth)"
            ],
            [
              "POST",
              "/user/generate-token",
              "Mint a stored machine credential ({ expiresIn?, scope? }, max 365 d). From a person: opens a new machine session with that scope. From a machine token: renews that session in place under its stored scope. Returns { accessToken, expiresIn } — no refresh token",
              "— (auth)"
            ],
            [
              "GET",
              "/user/tokens",
              "The caller's token-issuance history, newest first: { tokens: [{ id, createdAt, expiresAt, status }] } where status is active, expired, or revoked (a later sign-out-everywhere)",
              "— (auth)"
            ],
            [
              "GET",
              "/user/sessions",
              "Signed-in devices (sessions) and stored machine credentials (machineSessions), each with client summary, last IP, amr, scope, created / last-used; the caller's own session is flagged current",
              "— (auth)"
            ],
            [
              "DELETE",
              "/user/sessions/:id",
              "Revoke one session — a device is signed out, a machine credential stops renewing. The current session is refused (use logout)",
              "+ step-up"
            ],
            [
              "GET",
              "/user/export",
              "The caller's own data as one JSON download: account (no secrets), memberships with org names, access-key and passkey metadata, sessions, per-org preferences, domain-join requests, and the audit events where they are actor or target (newest 10,000; truncated when capped). Audited user.export",
              "+ step-up"
            ],
            [
              "GET",
              "/user/account/deletion",
              "What deleting the account would do: `{ canDelete, orgsDeleted: [{ orgId, name }], blockedBy: [{ orgId, name, reason: 'other-members' \\",
              "'has-teams' \\",
              "'system-org', otherMembers }] }`",
              "— (auth)"
            ],
            [
              "DELETE",
              "/user/account",
              "Delete the account. An org the caller owns and is the only member of is soft-deleted with it (recovery snapshot, purge after the retention window) and named in { orgsDeleted: [{ orgId, name, purgeAfter }] }; an owned org with any other member, or with teams, refuses 400 USER_OWNER_HAS_ORGS (transfer first). 409 RL_LAST_PRIVILEGED_MEMBER, 502 when an org's snapshot fails (nothing deleted)",
              "+ step-up"
            ],
            [
              "PATCH",
              "/user/profile",
              "Update { username?, email? } → { user }. Changing the sign-in email needs a step-up (it is where a password reset is sent) and clears isEmailVerified; the old address is emailed a notice of the change. A username edit, or re-sending the current address, needs neither",
              "— (auth); + step-up when email changes"
            ],
            [
              "POST",
              "/user/change-password",
              "{ currentPassword, newPassword } → { accessKeysRevoked }: ends every session and revokes every access key",
              "+ step-up"
            ],
            [
              "POST",
              "/user/tokens/revoke-all",
              "Sign out everywhere: bump tokenVersion, clear every slot of both kinds, revoke the user's access keys",
              "+ step-up"
            ],
            [
              "POST \\",
              "GET \\",
              "DELETE",
              "/user/keys[/:id]",
              "Create / list / revoke an access key. Create returns the raw pb_pat_… key once ({ key, accessKey }); the listing only ever shows pb_pat_…last4, plus scope, expiry, last use, where it was created, and the never-used / expiring-soon flags",
              "create: + step-up"
            ],
            [
              "POST",
              "/auth/key/rotate",
              "Self-rotation for unattended machines: mint a sibling pb_sa_… key on the presented key's account ({ key, name?, expiresIn? } → { key, keyId, previousKeyId, expiresAt, scope, prunedKeyIds }), inheriting its scope, IP allowlist and lifetime. The presented key stays live — retire it afterwards. Pre-auth; same gates and limiters as the exchange; pb_pat_… keys refused",
              "the key itself"
            ],
            [
              "POST",
              "/auth/key/revoke",
              "Retire a sibling key ({ key, keyId }) with the live key that replaced it. Revoking the presented key is refused (400 SELF_REVOKE_REFUSED) so a rotator cannot destroy its own credential; revoking an already-revoked key is idempotent success",
              "the key itself"
            ],
            [
              "POST",
              "/auth/token/exchange",
              "Trade an access key ({ key }) — a person's pb_pat_… or a service account's pb_sa_… — for a 5-minute token_use: api_key JWT ({ accessToken, expiresIn, keyId }). Pre-auth — the key is the credential. A service-account key additionally checks the account is enabled, its org live, the presenting address within the key's IP allowlist, and its own exchange budget. Rate-limited per key and per IP; every outcome audited, and every refusal answers the same 401",
              "the key itself"
            ],
            [
              "POST",
              "/auth/device/code",
              "Open a device authorization (RFC 8628). Body { step_up?: true }. Returns the RFC shape: { device_code, user_code, verification_uri, verification_uri_complete, expires_in, interval }. Pre-auth — the caller has no identity yet",
              "— (rate-limited per IP)"
            ],
            [
              "POST",
              "/auth/device/token",
              "The waiting device's poll, { device_code }. Answers { access_token, refresh_token, token_type, expires_in } (plus step_up_token when the flow asked for one) once approved, else HTTP 400 with the RFC's { error }: authorization_pending, slow_down (with a widened interval), access_denied, expired_token. Single-use",
              "the device code itself"
            ],
            [
              "GET",
              "/auth/device/authorize?user_code=…",
              "What the signed-in user is being asked to approve: { request: { userCode, client, ip, requestedAt, expiresAt, stepUpRequested } } — never the device code. 404 unrecognised, 410 expired, 409 already decided",
              "— (auth, per-user limit)"
            ],
            [
              "POST",
              "/auth/device/approve",
              "Grant the waiting device a session, { userCode }. The CLI session inherits this session's org, amr, aal, auth_time and the passkey it was earned with. Only your own interactive session can approve: an access-key, scoped or impersonation token answers 403 INTERACTIVE_SESSION_REQUIRED",
              "+ step-up"
            ],
            [
              "POST",
              "/auth/device/deny",
              "Refuse the waiting device, { userCode }. Its next poll gets access_denied",
              "— (auth)"
            ],
            [
              "POST",
              "/auth/webauthn/register/options",
              "Begin enrolling a passkey → { ceremonyId, options } (residentKey: required, userVerification: required, existing credentials in excludeCredentials)",
              "+ step-up, interactive session"
            ],
            [
              "POST",
              "/auth/webauthn/register/verify",
              "Store it: { ceremonyId, response, name } → { passkey, recoveryCodes? } — the account's recovery codes ride along, once, when this passkey is its FIRST second factor. 409 when that authenticator is already registered. Not step-up gated again — the ceremony it consumes was minted by the gated call, bound to the user and single-use",
              "— (auth), interactive session"
            ],
            [
              "GET",
              "/auth/webauthn/credentials",
              "The caller's passkeys: name, added, last used, synced flag. Never the public key",
              "— (auth)"
            ],
            [
              "PATCH",
              "/auth/webauthn/credentials/:id",
              "Relabel one, { name } (≤ 64 chars)",
              "— (auth), interactive session"
            ],
            [
              "DELETE",
              "/auth/webauthn/credentials/:id",
              "Revoke one. 409 LAST_SIGN_IN_METHOD when it is the account's only way in (no password, no linked provider, no other passkey)",
              "+ step-up, interactive session"
            ],
            [
              "POST",
              "/auth/webauthn/login/options",
              "A sign-in challenge for a discoverable credential → { ceremonyId, options }. Public, names no user, and has its own per-IP limiter (browser autofill asks on every page load)",
              "— (pre-auth)"
            ],
            [
              "POST",
              "/auth/webauthn/login/verify",
              "Sign in, { ceremonyId, response } → the same { accessToken } + refresh cookie password login returns. Every failure answers one opaque 401, except an SSO-enforced account, which gets the same 403 SSO_REQUIRED password login gives (the assertion already proved who the caller is)",
              "the assertion itself"
            ],
            [
              "GET",
              "/auth/totp/status",
              "Whether the caller has an authenticator app: { enabled, pending, activatedAt, lastUsedAt, recoveryCodesRemaining, recoveryCodesTotal, recoveryGeneratedAt, lockedUntil }. Never the secret",
              "— (auth)"
            ],
            [
              "POST",
              "/auth/totp/enrol",
              "Mint a secret → { secret, otpauthUri } (SHA-1 / 6 digits / 30 s — fixed, for authenticator compatibility). The secret is returned once and stored encrypted at rest, HKDF-bound to the user. 409 when an enrolment is already active (disable first), 403 when the address is SSO-enforced — the org's IdP owns its factors",
              "+ step-up, interactive session"
            ],
            [
              "POST",
              "/auth/totp/activate",
              "Confirm it with a code, { code } → { recoveryCodes } — the account's ten recovery codes, shown once and stored only as hashes, when this is its FIRST second factor; an empty list when a passkey already minted the set. Not step-up gated again — it confirms the secret the gated call minted, and the code is the proof",
              "— (auth), interactive session"
            ],
            [
              "DELETE",
              "/auth/totp",
              "Turn it off — taking the recovery codes with it when no passkey remains. 409 when it would leave no way to sign in",
              "+ step-up, interactive session"
            ],
            [
              "GET \\",
              "POST",
              "/auth/recovery-codes",
              "The account's recovery codes — ONE set, shared by passkeys and the authenticator app. GET → { recoveryCodes: { remaining, total, generatedAt } }; POST replaces the whole set → { recoveryCodes } (every previous code stops working; 409 RECOVERY_CODES_NO_FACTOR without a second factor)",
              "POST: + step-up, interactive session"
            ],
            [
              "POST",
              "/auth/mfa/verify",
              "Second leg of a password sign-in, { challengeId, code } → the same { accessToken } + refresh cookie password login returns, with mfa added to amr. A recovery code works here too. A WRONG code does not burn the challenge (a typo must not cost a password entry); a correct one spends it, so one handle yields at most one session. Every failure answers one opaque 401, except an unknown or spent challenge (401 TOTP_INVALID_CHALLENGE, so the sign-in page can send the person back to the password field)",
              "the challenge + the code"
            ]
          ]
        },
        {
          "type": "text",
          "content": "Access tokens carry an explicit identity — principalType, token_use, amr, aal, auth_time — which services enforce; see Authentication → Token claims."
        },
        {
          "type": "text",
          "content": "X-Pb-Client names the calling client on every request: web (the browser app) receives its refresh token as an HttpOnly cookie and never in the body, any other value keeps the JSON body flow. /auth/refresh and /auth/logout reject a request that omits the header with 403 CLIENT_TYPE_REQUIRED — it is the CSRF proof that makes the ambient cookie safe. Every session-issuing endpoint (login, OAuth/SSO callback, tokens/revoke-all) applies the same split; switch-org issues no refresh token at all (access token only). See Authentication → Where the refresh token lives."
        },
        {
          "type": "text",
          "content": "Common Query Parameters"
        },
        {
          "type": "table",
          "headers": [
            "Parameter",
            "Type",
            "Default",
            "Description"
          ],
          "rows": [
            [
              "limit",
              "int",
              "10",
              "Page size (1-MAX_PAGE_LIMIT, default cap 1000)"
            ],
            [
              "offset",
              "int",
              "0",
              "Records to skip"
            ],
            [
              "sortBy",
              "string",
              "createdAt",
              "Sort field"
            ],
            [
              "sortOrder",
              "asc/desc",
              "desc",
              "Sort direction"
            ],
            [
              "visibility",
              "private/org/public",
              "—",
              "Narrow to one sharing rung (within what you can already see)"
            ],
            [
              "isActive",
              "boolean",
              "—",
              "Filter by active status"
            ],
            [
              "isDefault",
              "boolean",
              "—",
              "Filter by default status"
            ]
          ]
        }
      ]
    },
    {
      "id": "route-index",
      "title": "Route index",
      "blocks": [
        {
          "type": "text",
          "content": "Every route of the Pipeline, Plugin and Ask Agent services, generated from the route-table snapshots each service's route-coverage test writes — so no route can be missing here, even when the tables above don't describe it yet. Requires is everything the route demands of the caller (or = any one of; + = all of). Probes (/health, /ready, /metrics, /warmup) and the internal-only routes are left out. Regenerate with npm run generate:api-reference in frontend/; a test fails when it is stale."
        },
        {
          "type": "text",
          "content": "Pipeline Service — every route"
        },
        {
          "type": "text",
          "content": "66 routes, from frontend/src/generated/route-table/pipeline.json."
        },
        {
          "type": "table",
          "headers": [
            "Method",
            "Endpoint",
            "Requires",
            "Meters",
            "Audit action"
          ],
          "rows": [
            [
              "GET",
              "/pipeline-templates",
              "templates:read",
              "apiCalls",
              "—"
            ],
            [
              "POST",
              "/pipeline-templates",
              "templates:write",
              "apiCalls",
              "pipeline_template.create"
            ],
            [
              "DELETE",
              "/pipeline-templates/:id",
              "templates:write",
              "apiCalls",
              "pipeline_template.delete"
            ],
            [
              "GET",
              "/pipeline-templates/:id",
              "templates:read",
              "apiCalls",
              "—"
            ],
            [
              "PUT",
              "/pipeline-templates/:id",
              "templates:write",
              "apiCalls",
              "pipeline_template.update"
            ],
            [
              "POST",
              "/pipeline-templates/:id/instantiate",
              "templates:read",
              "apiCalls",
              "—"
            ],
            [
              "POST",
              "/pipeline-templates/:id/purge",
              "templates:write; step-up",
              "apiCalls",
              "pipeline_template.purge"
            ],
            [
              "POST",
              "/pipeline-templates/:id/restore",
              "templates:write; step-up",
              "apiCalls",
              "pipeline_template.restore"
            ],
            [
              "GET",
              "/pipeline-templates/deleted",
              "templates:read",
              "apiCalls",
              "—"
            ],
            [
              "GET",
              "/pipelines",
              "pipelines:read",
              "apiCalls",
              "—"
            ],
            [
              "POST",
              "/pipelines",
              "pipelines:write",
              "apiCalls",
              "pipeline.create, pipeline.update, pipeline.remediation-upgrades.update"
            ],
            [
              "DELETE",
              "/pipelines/:id",
              "pipelines:write",
              "apiCalls",
              "pipeline.delete"
            ],
            [
              "GET",
              "/pipelines/:id",
              "pipelines:read",
              "apiCalls",
              "—"
            ],
            [
              "PUT",
              "/pipelines/:id",
              "pipelines:write",
              "apiCalls",
              "pipeline.update, pipeline.remediation-upgrades.update"
            ],
            [
              "POST",
              "/pipelines/:id/plugin-upgrades/preview",
              "pipelines:read",
              "apiCalls",
              "—"
            ],
            [
              "POST",
              "/pipelines/:id/purge",
              "pipelines:write; step-up",
              "apiCalls",
              "pipeline.purge"
            ],
            [
              "GET",
              "/pipelines/:id/remediation-upgrades",
              "pipelines:read",
              "apiCalls",
              "—"
            ],
            [
              "POST",
              "/pipelines/:id/remediation-upgrades/:upgradeId/apply",
              "pipelines:write",
              "apiCalls",
              "pipeline.plugin.upgraded"
            ],
            [
              "POST",
              "/pipelines/:id/remediation-upgrades/:upgradeId/dismiss",
              "pipelines:write",
              "apiCalls",
              "—"
            ],
            [
              "POST",
              "/pipelines/:id/restore",
              "pipelines:write; step-up",
              "apiCalls",
              "pipeline.restore"
            ],
            [
              "GET",
              "/pipelines/:id/scorecard",
              "pipelines:read; feature advanced_reporting",
              "apiCalls",
              "—"
            ],
            [
              "GET",
              "/pipelines/:id/scorecard/history",
              "pipelines:read; feature advanced_reporting",
              "apiCalls",
              "—"
            ],
            [
              "DELETE",
              "/pipelines/:id/security-reports",
              "pipelines:write",
              "apiCalls",
              "pipeline.security_report.delete"
            ],
            [
              "GET",
              "/pipelines/:id/security-reports",
              "pipelines:read",
              "apiCalls",
              "—"
            ],
            [
              "POST",
              "/pipelines/:id/security-reports",
              "pipelines:write; scope reporting:ingest",
              "apiCalls",
              "pipeline.security_report.upload"
            ],
            [
              "POST",
              "/pipelines/:pipelineId/executions",
              "pipelines:write",
              "apiCalls",
              "pipeline.execution.start"
            ],
            [
              "POST",
              "/pipelines/:pipelineId/executions/:executionId/stop",
              "pipelines:write",
              "apiCalls",
              "pipeline.execution.cancel"
            ],
            [
              "GET",
              "/pipelines/:pipelineId/run-requests/:requestId",
              "pipelines:read",
              "apiCalls",
              "—"
            ],
            [
              "GET",
              "/pipelines/:pipelineId/runner-link",
              "pipelines:read",
              "apiCalls",
              "—"
            ],
            [
              "POST",
              "/pipelines/:pipelineId/runner-link/refresh",
              "pipelines:write; MFA session (aal2); step-up",
              "apiCalls",
              "pipeline.runner.link.refresh"
            ],
            [
              "POST",
              "/pipelines/admin/orgs/:orgId/runner-signing-key/revoke",
              "system org; orgs:manage; MFA session (aal2); step-up",
              "apiCalls",
              "pipeline.runner.key.system_revoke"
            ],
            [
              "GET",
              "/pipelines/admin/runner-deliveries",
              "system org; orgs:read; MFA session (aal2)",
              "apiCalls",
              "—"
            ],
            [
              "PUT",
              "/pipelines/admin/runner-deliveries",
              "system org; orgs:manage; MFA session (aal2); step-up",
              "apiCalls",
              "pipeline.runner.deliveries.pause, pipeline.runner.deliveries.resume"
            ],
            [
              "GET",
              "/pipelines/admin/runner-signing-keys",
              "system org; orgs:read; MFA session (aal2)",
              "apiCalls",
              "—"
            ],
            [
              "POST",
              "/pipelines/analyze/from-url",
              "pipelines:write; feature ai_generation",
              "apiCalls",
              "—"
            ],
            [
              "POST",
              "/pipelines/bulk/create",
              "pipelines:write; feature bulk_operations",
              "apiCalls",
              "pipeline.create, pipeline.update, pipeline.remediation-upgrades.update"
            ],
            [
              "POST",
              "/pipelines/bulk/delete",
              "pipelines:write; feature bulk_operations",
              "apiCalls",
              "pipeline.delete"
            ],
            [
              "PUT",
              "/pipelines/bulk/update",
              "pipelines:write; feature bulk_operations",
              "apiCalls",
              "pipeline.update, pipeline.remediation-upgrades.update"
            ],
            [
              "GET",
              "/pipelines/deleted",
              "pipelines:read",
              "apiCalls",
              "—"
            ],
            [
              "GET",
              "/pipelines/find",
              "pipelines:read",
              "apiCalls",
              "—"
            ],
            [
              "POST",
              "/pipelines/generate",
              "pipelines:write; feature ai_generation",
              "apiCalls",
              "pipeline.ai.generate"
            ],
            [
              "POST",
              "/pipelines/generate/from-url",
              "pipelines:write; feature ai_generation",
              "apiCalls",
              "pipeline.ai.generate"
            ],
            [
              "POST",
              "/pipelines/generate/from-url/stream",
              "pipelines:write; feature ai_generation",
              "apiCalls",
              "pipeline.ai.generate"
            ],
            [
              "POST",
              "/pipelines/generate/missing-plugins",
              "plugins:write; feature ai_generation",
              "apiCalls",
              "—"
            ],
            [
              "POST",
              "/pipelines/generate/stream",
              "pipelines:write; feature ai_generation",
              "apiCalls",
              "pipeline.ai.generate"
            ],
            [
              "POST",
              "/pipelines/plugin-upgrades/apply",
              "pipelines:write",
              "apiCalls",
              "pipeline.plugin.upgraded"
            ],
            [
              "GET",
              "/pipelines/providers",
              "pipelines:read; feature ai_generation",
              "apiCalls",
              "—"
            ],
            [
              "GET",
              "/pipelines/registry",
              "pipelines:read; decided per request",
              "apiCalls",
              "—"
            ],
            [
              "POST",
              "/pipelines/registry",
              "pipeline_registry:write",
              "apiCalls",
              "pipeline.registry.register"
            ],
            [
              "DELETE",
              "/pipelines/registry/:id",
              "pipeline_registry:write",
              "apiCalls",
              "pipeline.registry.deregister"
            ],
            [
              "GET",
              "/pipelines/runner/runners/:runnerId/jwks.json",
              "no bearer token",
              "—",
              "—"
            ],
            [
              "GET",
              "/pipelines/runners",
              "org_settings:write",
              "apiCalls",
              "—"
            ],
            [
              "POST",
              "/pipelines/runners",
              "org_settings:write; MFA session (aal2); step-up",
              "apiCalls",
              "pipeline.runner.register"
            ],
            [
              "DELETE",
              "/pipelines/runners/:id",
              "org_settings:write; MFA session (aal2); step-up",
              "apiCalls",
              "pipeline.runner.revoke"
            ],
            [
              "PATCH",
              "/pipelines/runners/:id",
              "org_settings:write; MFA session (aal2); step-up",
              "apiCalls",
              "pipeline.runner.update"
            ],
            [
              "GET",
              "/pipelines/runners/:id/pipelines",
              "org_settings:write",
              "apiCalls",
              "—"
            ],
            [
              "POST",
              "/pipelines/runners/:id/test",
              "org_settings:write; MFA session (aal2); step-up",
              "apiCalls",
              "pipeline.runner.test"
            ],
            [
              "POST",
              "/pipelines/runners/signing-key",
              "org_settings:write; MFA session (aal2); step-up",
              "apiCalls",
              "pipeline.runner.key.generate"
            ],
            [
              "POST",
              "/pipelines/runners/signing-key/finish",
              "org_settings:write; MFA session (aal2); step-up",
              "apiCalls",
              "pipeline.runner.key.finish"
            ],
            [
              "PUT",
              "/pipelines/runners/signing-key/mode",
              "org_settings:write; MFA session (aal2); step-up",
              "apiCalls",
              "pipeline.runner.key.mode"
            ],
            [
              "POST",
              "/pipelines/runners/signing-key/revoke",
              "org_settings:write; MFA session (aal2); step-up",
              "apiCalls",
              "pipeline.runner.key.revoke"
            ],
            [
              "DELETE",
              "/pipelines/runners/signing-key/rotate",
              "org_settings:write; MFA session (aal2); step-up",
              "apiCalls",
              "pipeline.runner.key.cancel"
            ],
            [
              "POST",
              "/pipelines/runners/signing-key/rotate",
              "org_settings:write; MFA session (aal2); step-up",
              "apiCalls",
              "pipeline.runner.key.rotate"
            ],
            [
              "GET",
              "/pipelines/scorecard",
              "reports:read; feature advanced_reporting",
              "apiCalls",
              "—"
            ],
            [
              "GET",
              "/pipelines/scorecard/history",
              "reports:read; feature advanced_reporting",
              "apiCalls",
              "—"
            ],
            [
              "POST",
              "/pipelines/validate",
              "pipelines:write",
              "apiCalls",
              "—"
            ]
          ]
        },
        {
          "type": "text",
          "content": "Plugin Service — every route"
        },
        {
          "type": "text",
          "content": "178 routes, from frontend/src/generated/route-table/plugin.json."
        },
        {
          "type": "table",
          "headers": [
            "Method",
            "Endpoint",
            "Requires",
            "Meters",
            "Audit action"
          ],
          "rows": [
            [
              "GET",
              "/logs/:requestId",
              "no bearer token; SSE build-log stream; authorized by a short-lived ?ticket= from POST /logs/ticket, not a bearer token",
              "—",
              "—"
            ],
            [
              "POST",
              "/logs/ticket",
              "signed in",
              "—",
              "—"
            ],
            [
              "GET",
              "/plugins",
              "plugins:read",
              "apiCalls",
              "—"
            ],
            [
              "POST",
              "/plugins",
              "plugins:write",
              "apiCalls",
              "plugin.upload"
            ],
            [
              "DELETE",
              "/plugins/:id",
              "plugins:write",
              "apiCalls",
              "plugin.delete"
            ],
            [
              "GET",
              "/plugins/:id",
              "plugins:read",
              "apiCalls",
              "—"
            ],
            [
              "PUT",
              "/plugins/:id",
              "plugins:write",
              "apiCalls",
              "plugin.update"
            ],
            [
              "POST",
              "/plugins/:id/deprecate",
              "plugins:write",
              "apiCalls",
              "plugin.version.deprecate"
            ],
            [
              "GET",
              "/plugins/:id/findings",
              "plugins:read",
              "apiCalls",
              "—"
            ],
            [
              "POST",
              "/plugins/:id/purge",
              "plugins:write; step-up",
              "apiCalls",
              "plugin.purge"
            ],
            [
              "POST",
              "/plugins/:id/restore",
              "plugins:write; step-up",
              "apiCalls",
              "plugin.restore"
            ],
            [
              "GET",
              "/plugins/:id/sbom",
              "plugins:read",
              "apiCalls",
              "—"
            ],
            [
              "POST",
              "/plugins/:id/unyank",
              "plugins:write",
              "apiCalls",
              "plugin.version.unyank"
            ],
            [
              "POST",
              "/plugins/:id/yank",
              "plugins:write",
              "apiCalls",
              "plugin.version.yank"
            ],
            [
              "POST",
              "/plugins/bulk/delete",
              "plugins:write; feature bulk_operations",
              "apiCalls",
              "plugin.bulk.delete"
            ],
            [
              "PUT",
              "/plugins/bulk/update",
              "plugins:write; feature bulk_operations",
              "apiCalls",
              "plugin.bulk.update"
            ],
            [
              "DELETE",
              "/plugins/by-name/:name",
              "plugins:write; step-up",
              "apiCalls",
              "plugin.delete-all"
            ],
            [
              "GET",
              "/plugins/by-name/:name/delete-jobs/:jobId",
              "plugins:read",
              "apiCalls",
              "—"
            ],
            [
              "GET",
              "/plugins/by-name/:name/delete-preview",
              "plugins:write",
              "apiCalls",
              "—"
            ],
            [
              "PUT",
              "/plugins/by-name/:name/never-tidy",
              "plugins:write",
              "apiCalls",
              "plugin.tidy.kept"
            ],
            [
              "POST",
              "/plugins/by-name/:name/purge",
              "plugins:write; step-up",
              "apiCalls",
              "plugin.purge-all"
            ],
            [
              "PUT",
              "/plugins/by-name/:name/remediation-level",
              "plugins:write",
              "apiCalls",
              "plugin.remediation_level.update"
            ],
            [
              "POST",
              "/plugins/by-name/:name/restore",
              "plugins:write; step-up",
              "apiCalls",
              "plugin.restore-all"
            ],
            [
              "GET",
              "/plugins/catalog",
              "plugins:read",
              "apiCalls",
              "—"
            ],
            [
              "GET",
              "/plugins/deleted",
              "plugins:read",
              "apiCalls",
              "—"
            ],
            [
              "POST",
              "/plugins/deploy-generated",
              "plugins:write",
              "apiCalls",
              "plugin.deploy"
            ],
            [
              "GET",
              "/plugins/ecosystem/advisories",
              "system org; plugins:moderate; MFA session (aal2)",
              "apiCalls",
              "—"
            ],
            [
              "POST",
              "/plugins/ecosystem/advisories",
              "system org; plugins:moderate; MFA session (aal2); step-up",
              "apiCalls",
              "plugin.advisory.create"
            ],
            [
              "PATCH",
              "/plugins/ecosystem/advisories/:id",
              "system org; plugins:moderate; MFA session (aal2); step-up",
              "apiCalls",
              "plugin.advisory.update"
            ],
            [
              "POST",
              "/plugins/ecosystem/advisories/:id/withdraw",
              "system org; plugins:moderate; MFA session (aal2); step-up",
              "apiCalls",
              "plugin.advisory.withdraw"
            ],
            [
              "GET",
              "/plugins/ecosystem/flagged-versions",
              "system org; plugins:moderate; MFA session (aal2)",
              "apiCalls",
              "—"
            ],
            [
              "GET",
              "/plugins/ecosystem/listings",
              "system org; plugins:moderate; MFA session (aal2)",
              "apiCalls",
              "—"
            ],
            [
              "POST",
              "/plugins/ecosystem/listings/:id/state",
              "system org; plugins:moderate; MFA session (aal2); step-up",
              "apiCalls",
              "plugin.listing.state.change, plugin.request.submit, plugin.request.approve"
            ],
            [
              "POST",
              "/plugins/ecosystem/listings/:id/versions/:version/deprecate",
              "system org; plugins:moderate; MFA session (aal2); step-up",
              "apiCalls",
              "plugin.version.deprecate"
            ],
            [
              "POST",
              "/plugins/ecosystem/listings/:id/versions/:version/unyank",
              "system org; plugins:moderate; MFA session (aal2); step-up",
              "apiCalls",
              "plugin.request.submit, plugin.request.approve"
            ],
            [
              "POST",
              "/plugins/ecosystem/listings/:id/versions/:version/yank",
              "system org; plugins:moderate; MFA session (aal2); step-up",
              "apiCalls",
              "plugin.version.yank"
            ],
            [
              "GET",
              "/plugins/ecosystem/overview",
              "system org; plugins:moderate or publishers:verify; MFA session (aal2)",
              "apiCalls",
              "—"
            ],
            [
              "GET",
              "/plugins/ecosystem/publishers",
              "system org; plugins:moderate or publishers:verify; MFA session (aal2)",
              "apiCalls",
              "—"
            ],
            [
              "POST",
              "/plugins/ecosystem/publishers/:id/suspend",
              "system org; publishers:verify; MFA session (aal2); step-up",
              "apiCalls",
              "publisher.suspend"
            ],
            [
              "POST",
              "/plugins/ecosystem/publishers/:id/tier",
              "system org; publishers:verify; MFA session (aal2); step-up",
              "apiCalls",
              "publisher.tier.change, plugin.request.submit, plugin.request.approve"
            ],
            [
              "POST",
              "/plugins/ecosystem/publishers/:id/unsuspend",
              "system org; publishers:verify; MFA session (aal2); step-up",
              "apiCalls",
              "plugin.request.submit, plugin.request.approve"
            ],
            [
              "GET",
              "/plugins/ecosystem/requests",
              "system org; plugins:moderate or publishers:verify; MFA session (aal2)",
              "apiCalls",
              "—"
            ],
            [
              "GET",
              "/plugins/ecosystem/requests/:id",
              "system org; plugins:moderate or publishers:verify; MFA session (aal2)",
              "apiCalls",
              "—"
            ],
            [
              "POST",
              "/plugins/ecosystem/requests/:id/approve",
              "system org; plugins:moderate or publishers:verify; MFA session (aal2)",
              "apiCalls",
              "plugin.request.approve, plugin.listing.publish, plugin.listing.update, plugin.listing.unpause, plugin.version.yank, publisher.verify.approve, publisher.tier.change, publisher.transfer.approve, publisher.profile-change.approve, plugin.advisory.publish, plugin.submission.claim"
            ],
            [
              "POST",
              "/plugins/ecosystem/requests/:id/reject",
              "system org; plugins:moderate or publishers:verify; MFA session (aal2)",
              "apiCalls",
              "plugin.request.reject, publisher.verify.reject, publisher.transfer.reject, publisher.profile-change.reject, plugin.submission.reject"
            ],
            [
              "POST",
              "/plugins/ecosystem/requests/:id/second-approve",
              "system org; plugins:moderate or publishers:verify; MFA session (aal2)",
              "apiCalls",
              "plugin.request.second-approve, plugin.listing.publish, plugin.version.unyank, publisher.unsuspend, publisher.tier.change, plugin.listing.state.change, plugin.submission.approve"
            ],
            [
              "GET",
              "/plugins/ecosystem/requests/:id/submission-sbom",
              "system org; plugins:moderate; MFA session (aal2)",
              "apiCalls",
              "—"
            ],
            [
              "GET",
              "/plugins/ecosystem/requests/:id/submission-scan",
              "system org; plugins:moderate; MFA session (aal2)",
              "apiCalls",
              "—"
            ],
            [
              "GET",
              "/plugins/ecosystem/reserved-names",
              "system org; plugins:moderate; MFA session (aal2)",
              "apiCalls",
              "—"
            ],
            [
              "DELETE",
              "/plugins/ecosystem/reserved-names/:name",
              "system org; plugins:moderate; MFA session (aal2); step-up",
              "apiCalls",
              "ecosystem.reserved-name.update"
            ],
            [
              "PUT",
              "/plugins/ecosystem/reserved-names/:name",
              "system org; plugins:moderate; MFA session (aal2); step-up",
              "apiCalls",
              "ecosystem.reserved-name.update"
            ],
            [
              "POST",
              "/plugins/ecosystem/resign",
              "system org; plugins:moderate; MFA session (aal2); step-up",
              "apiCalls",
              "registry.image.resign"
            ],
            [
              "GET",
              "/plugins/ecosystem/reviews",
              "system org; plugins:moderate; MFA session (aal2)",
              "apiCalls",
              "—"
            ],
            [
              "POST",
              "/plugins/ecosystem/reviews/:id/hold",
              "system org; plugins:moderate; MFA session (aal2)",
              "apiCalls",
              "plugin.review.hold"
            ],
            [
              "POST",
              "/plugins/ecosystem/reviews/:id/release",
              "system org; plugins:moderate; MFA session (aal2)",
              "apiCalls",
              "plugin.review.release"
            ],
            [
              "POST",
              "/plugins/ecosystem/reviews/:id/remove",
              "system org; plugins:moderate; MFA session (aal2); step-up",
              "apiCalls",
              "plugin.review.remove"
            ],
            [
              "POST",
              "/plugins/ecosystem/reviews/:id/remove-reply",
              "system org; plugins:moderate; MFA session (aal2); step-up",
              "apiCalls",
              "plugin.review.reply.delete"
            ],
            [
              "GET",
              "/plugins/ecosystem/rules",
              "system org; plugins:moderate; MFA session (aal2)",
              "apiCalls",
              "—"
            ],
            [
              "POST",
              "/plugins/ecosystem/rules",
              "system org; plugins:moderate; MFA session (aal2); step-up",
              "apiCalls",
              "ecosystem.auto-approval-rule.create"
            ],
            [
              "DELETE",
              "/plugins/ecosystem/rules/:id",
              "system org; plugins:moderate; MFA session (aal2); step-up",
              "apiCalls",
              "ecosystem.auto-approval-rule.delete"
            ],
            [
              "PATCH",
              "/plugins/ecosystem/rules/:id",
              "system org; plugins:moderate; MFA session (aal2); step-up",
              "apiCalls",
              "ecosystem.auto-approval-rule.update"
            ],
            [
              "POST",
              "/plugins/ecosystem/rules/:id/approve-change",
              "system org; plugins:moderate; MFA session (aal2); step-up",
              "apiCalls",
              "ecosystem.auto-approval-rule.update"
            ],
            [
              "GET",
              "/plugins/find",
              "plugins:read",
              "apiCalls",
              "—"
            ],
            [
              "POST",
              "/plugins/generate",
              "plugins:write; feature ai_generation",
              "apiCalls",
              "plugin.ai.generate"
            ],
            [
              "POST",
              "/plugins/generate/stream",
              "plugins:write; feature ai_generation",
              "apiCalls",
              "plugin.ai.generate"
            ],
            [
              "POST",
              "/plugins/inspect",
              "plugins:write",
              "apiCalls",
              "—"
            ],
            [
              "GET",
              "/plugins/install-policy",
              "plugins:read",
              "apiCalls",
              "—"
            ],
            [
              "PUT",
              "/plugins/install-policy",
              "plugin_installs:manage; step-up",
              "apiCalls",
              "org.plugin-install-policy.update"
            ],
            [
              "GET",
              "/plugins/installs",
              "plugins:read",
              "apiCalls",
              "—"
            ],
            [
              "POST",
              "/plugins/installs",
              "plugins:install",
              "apiCalls",
              "plugin.install.create, plugin.install.request"
            ],
            [
              "DELETE",
              "/plugins/installs/:id",
              "plugins:install",
              "apiCalls",
              "plugin.install.remove"
            ],
            [
              "PATCH",
              "/plugins/installs/:id",
              "plugins:install",
              "apiCalls",
              "plugin.install.upgrade"
            ],
            [
              "POST",
              "/plugins/installs/:id/approve",
              "plugin_installs:manage",
              "apiCalls",
              "plugin.install.approve"
            ],
            [
              "POST",
              "/plugins/installs/:id/change-requests",
              "plugins:install",
              "apiCalls",
              "plugin.install.change-request"
            ],
            [
              "POST",
              "/plugins/installs/:id/change-requests/approve",
              "plugin_installs:manage",
              "apiCalls",
              "plugin.install.change-approve, plugin.install.upgrade"
            ],
            [
              "POST",
              "/plugins/installs/:id/change-requests/reject",
              "plugin_installs:manage",
              "apiCalls",
              "plugin.install.change-reject"
            ],
            [
              "POST",
              "/plugins/installs/:id/deny",
              "plugin_installs:manage",
              "apiCalls",
              "plugin.install.deny"
            ],
            [
              "GET",
              "/plugins/installs/change-requests",
              "plugin_installs:manage",
              "apiCalls",
              "—"
            ],
            [
              "GET",
              "/plugins/kept-setup-images",
              "system org; plugins:moderate; MFA session (aal2)",
              "apiCalls",
              "—"
            ],
            [
              "POST",
              "/plugins/kept-setup-images/:id/promote",
              "system org; plugins:moderate; MFA session (aal2)",
              "apiCalls",
              "plugin.setup_image.promoted, plugin.setup_image.promote_refused"
            ],
            [
              "GET",
              "/plugins/listings/:publisher/:name/install-state",
              "plugins:read",
              "apiCalls",
              "—"
            ],
            [
              "GET",
              "/plugins/listings/:publisher/:name/review-state",
              "plugins:read",
              "apiCalls",
              "—"
            ],
            [
              "POST",
              "/plugins/listings/:publisher/:name/reviews",
              "plugins:read; a person (no service account or access key)",
              "apiCalls",
              "plugin.review.create"
            ],
            [
              "POST",
              "/plugins/lookup",
              "plugins:read",
              "apiCalls",
              "—"
            ],
            [
              "GET",
              "/plugins/pipelines/:pipelineId/exposures",
              "pipelines:read",
              "apiCalls",
              "—"
            ],
            [
              "POST",
              "/plugins/pipelines/:pipelineId/exposures/:exposureId/triage",
              "pipelines:write",
              "apiCalls",
              "pipeline.vuln.accepted, pipeline.vuln.false_positive, pipeline.vuln.reopened"
            ],
            [
              "GET",
              "/plugins/pipelines/:pipelineId/security",
              "pipelines:read",
              "apiCalls",
              "—"
            ],
            [
              "GET",
              "/plugins/plugin-usage",
              "plugins:read",
              "apiCalls",
              "—"
            ],
            [
              "GET",
              "/plugins/providers",
              "plugins:read; feature ai_generation",
              "apiCalls",
              "—"
            ],
            [
              "GET",
              "/plugins/publish-requests",
              "plugins:read",
              "apiCalls",
              "—"
            ],
            [
              "POST",
              "/plugins/publish-requests",
              "plugins:publish or publishers:manage",
              "apiCalls",
              "plugin.request.submit, publisher.verify.request, publisher.transfer.request, plugin.advisory.create"
            ],
            [
              "POST",
              "/plugins/publish-requests/:id/transfer-response",
              "publishers:manage; step-up",
              "apiCalls",
              "publisher.transfer.accept, publisher.transfer.decline"
            ],
            [
              "POST",
              "/plugins/publish-requests/:id/withdraw",
              "plugins:publish or publishers:manage",
              "apiCalls",
              "plugin.request.withdraw"
            ],
            [
              "GET",
              "/plugins/publish-requests/draft",
              "plugins:publish",
              "apiCalls",
              "—"
            ],
            [
              "GET",
              "/plugins/publisher",
              "plugins:read",
              "apiCalls",
              "—"
            ],
            [
              "PATCH",
              "/plugins/publisher",
              "publishers:manage",
              "apiCalls",
              "publisher.update"
            ],
            [
              "POST",
              "/plugins/publisher",
              "publishers:manage",
              "apiCalls",
              "publisher.create, publisher.terms.accept"
            ],
            [
              "GET",
              "/plugins/publisher/advisories",
              "plugins:read",
              "apiCalls",
              "—"
            ],
            [
              "GET",
              "/plugins/publisher/incoming-transfers",
              "publishers:manage",
              "apiCalls",
              "—"
            ],
            [
              "GET",
              "/plugins/publisher/insights",
              "plugins:read",
              "apiCalls",
              "—"
            ],
            [
              "GET",
              "/plugins/publisher/listings",
              "plugins:read",
              "apiCalls",
              "—"
            ],
            [
              "POST",
              "/plugins/publisher/listings/:listingId/deprecate",
              "plugins:publish",
              "apiCalls",
              "plugin.version.deprecate"
            ],
            [
              "POST",
              "/plugins/publisher/listings/:listingId/pause",
              "plugins:publish",
              "apiCalls",
              "plugin.listing.pause, plugin.version.pause"
            ],
            [
              "POST",
              "/plugins/publisher/terms",
              "publishers:manage",
              "apiCalls",
              "publisher.terms.accept"
            ],
            [
              "DELETE",
              "/plugins/queue/dlq",
              "system org; plugin_queue:manage; MFA session (aal2); step-up",
              "apiCalls",
              "plugin.dlq.purge"
            ],
            [
              "GET",
              "/plugins/queue/dlq",
              "decided per request",
              "apiCalls",
              "—"
            ],
            [
              "POST",
              "/plugins/queue/dlq/:jobId/replay",
              "decided per request",
              "apiCalls",
              "plugin.dlq.replay"
            ],
            [
              "GET",
              "/plugins/queue/failed",
              "decided per request",
              "apiCalls",
              "—"
            ],
            [
              "DELETE",
              "/plugins/queue/failed/:jobId",
              "decided per request",
              "apiCalls",
              "plugin.build.dismiss"
            ],
            [
              "POST",
              "/plugins/queue/failed/:jobId/retry",
              "decided per request",
              "apiCalls",
              "plugin.build.retry"
            ],
            [
              "GET",
              "/plugins/queue/status",
              "system org; plugin_queue:manage; MFA session (aal2)",
              "apiCalls",
              "—"
            ],
            [
              "GET",
              "/plugins/queue/triage",
              "decided per request",
              "apiCalls",
              "—"
            ],
            [
              "GET",
              "/plugins/remediation-settings",
              "plugins:read",
              "apiCalls",
              "—"
            ],
            [
              "PUT",
              "/plugins/remediation-settings",
              "org_settings:write",
              "apiCalls",
              "plugin.remediation_settings.update"
            ],
            [
              "GET",
              "/plugins/remediations",
              "plugins:read",
              "apiCalls",
              "—"
            ],
            [
              "GET",
              "/plugins/remediations/:id",
              "plugins:read",
              "apiCalls",
              "—"
            ],
            [
              "POST",
              "/plugins/remediations/:id/approve",
              "plugins:write; step-up",
              "apiCalls",
              "plugin.remediation.approved"
            ],
            [
              "GET",
              "/plugins/remediations/:id/export",
              "system org; plugins:write",
              "apiCalls",
              "—"
            ],
            [
              "GET",
              "/plugins/remediations/:id/patch",
              "plugins:read",
              "apiCalls",
              "—"
            ],
            [
              "POST",
              "/plugins/remediations/:id/reject",
              "plugins:write; step-up",
              "apiCalls",
              "plugin.remediation.rejected"
            ],
            [
              "POST",
              "/plugins/remediations/:id/retry",
              "plugins:write; step-up",
              "apiCalls",
              "plugin.remediation.retried, plugin.remediation.started"
            ],
            [
              "GET",
              "/plugins/retention/plan",
              "system org; plugins:moderate; MFA session (aal2)",
              "apiCalls",
              "—"
            ],
            [
              "POST",
              "/plugins/retention/run",
              "system org; plugins:moderate; MFA session (aal2); step-up",
              "apiCalls",
              "plugin.version.retire"
            ],
            [
              "DELETE",
              "/plugins/reviews/:id",
              "plugins:read; a person (no service account or access key)",
              "apiCalls",
              "plugin.review.delete"
            ],
            [
              "PATCH",
              "/plugins/reviews/:id",
              "plugins:read; a person (no service account or access key)",
              "apiCalls",
              "plugin.review.update"
            ],
            [
              "DELETE",
              "/plugins/reviews/:id/helpful",
              "plugins:read; a person (no service account or access key)",
              "apiCalls",
              "—"
            ],
            [
              "PUT",
              "/plugins/reviews/:id/helpful",
              "plugins:read; a person (no service account or access key)",
              "apiCalls",
              "—"
            ],
            [
              "DELETE",
              "/plugins/reviews/:id/reply",
              "publishers:manage; a person (no service account or access key)",
              "apiCalls",
              "plugin.review.reply.delete"
            ],
            [
              "PUT",
              "/plugins/reviews/:id/reply",
              "publishers:manage; a person (no service account or access key)",
              "apiCalls",
              "plugin.review.reply.create, plugin.review.reply.update"
            ],
            [
              "POST",
              "/plugins/reviews/:id/report",
              "plugins:read; a person (no service account or access key)",
              "apiCalls",
              "plugin.review.report, plugin.review.hold"
            ],
            [
              "POST",
              "/plugins/runtime-check",
              "plugins:read",
              "apiCalls",
              "pipeline.runtime_check.flagged"
            ],
            [
              "GET",
              "/plugins/security-notifications",
              "plugins:read",
              "apiCalls",
              "—"
            ],
            [
              "PUT",
              "/plugins/security-notifications",
              "org_settings:write",
              "apiCalls",
              "plugin.security_notifications.update"
            ],
            [
              "POST",
              "/plugins/security-notifications/test",
              "org_settings:write",
              "apiCalls",
              "plugin.security_notifications.test"
            ],
            [
              "GET",
              "/plugins/shadowing",
              "plugins:read",
              "apiCalls",
              "—"
            ],
            [
              "GET",
              "/plugins/storage",
              "plugins:read",
              "apiCalls",
              "—"
            ],
            [
              "POST",
              "/plugins/storage/prune",
              "plugins:write",
              "apiCalls",
              "plugin.version.prune"
            ],
            [
              "GET",
              "/plugins/tidy/preview",
              "plugins:read",
              "apiCalls",
              "—"
            ],
            [
              "PUT",
              "/plugins/tidy/settings",
              "org_settings:write",
              "apiCalls",
              "plugin.tidy.settings.update"
            ],
            [
              "POST",
              "/plugins/tidy/versions/:id/keep",
              "plugins:write",
              "apiCalls",
              "plugin.tidy.kept"
            ],
            [
              "GET",
              "/plugins/toolchain-fixes",
              "system org; plugins:write",
              "apiCalls",
              "—"
            ],
            [
              "POST",
              "/plugins/toolchain-fixes/:id/approve",
              "system org; plugins:write; step-up",
              "apiCalls",
              "toolchain.fix.approved"
            ],
            [
              "GET",
              "/plugins/toolchain-fixes/:id/export",
              "system org; plugins:write",
              "apiCalls",
              "—"
            ],
            [
              "POST",
              "/plugins/toolchain-fixes/:id/reject",
              "system org; plugins:write; step-up",
              "apiCalls",
              "toolchain.fix.rejected"
            ],
            [
              "GET",
              "/plugins/toolchain/affected",
              "system org; toolchain:operate; MFA session (aal2)",
              "apiCalls",
              "—"
            ],
            [
              "POST",
              "/plugins/toolchain/affected/notify",
              "system org; toolchain:operate; MFA session (aal2); step-up",
              "apiCalls",
              "toolchain.recovery.notify"
            ],
            [
              "GET",
              "/plugins/toolchain/cleanup",
              "system org; toolchain:operate; MFA session (aal2)",
              "apiCalls",
              "—"
            ],
            [
              "GET",
              "/plugins/toolchain/eligible",
              "pipelines:read",
              "apiCalls",
              "—"
            ],
            [
              "GET",
              "/plugins/toolchain/history",
              "system org; toolchain:operate; MFA session (aal2)",
              "apiCalls",
              "—"
            ],
            [
              "DELETE",
              "/plugins/toolchain/org-default",
              "toolchain:manage; step-up",
              "apiCalls",
              "toolchain.org_default.clear"
            ],
            [
              "GET",
              "/plugins/toolchain/org-default",
              "pipelines:read",
              "apiCalls",
              "—"
            ],
            [
              "PUT",
              "/plugins/toolchain/org-default",
              "toolchain:manage; step-up",
              "apiCalls",
              "toolchain.org_default.set"
            ],
            [
              "GET",
              "/plugins/toolchain/org-default/history",
              "pipelines:read",
              "apiCalls",
              "—"
            ],
            [
              "GET",
              "/plugins/toolchain/releases",
              "system org; toolchain:operate; MFA session (aal2)",
              "apiCalls",
              "—"
            ],
            [
              "DELETE",
              "/plugins/toolchain/releases/:v",
              "system org; toolchain:operate; MFA session (aal2); step-up",
              "apiCalls",
              "toolchain.release.delete"
            ],
            [
              "PATCH",
              "/plugins/toolchain/releases/:v",
              "system org; toolchain:operate; MFA session (aal2); step-up",
              "apiCalls",
              "toolchain.release.notes"
            ],
            [
              "GET",
              "/plugins/toolchain/releases/:v/adoption",
              "system org; toolchain:operate; MFA session (aal2)",
              "apiCalls",
              "—"
            ],
            [
              "GET",
              "/plugins/toolchain/releases/:v/canary",
              "system org; toolchain:operate; MFA session (aal2)",
              "apiCalls",
              "—"
            ],
            [
              "POST",
              "/plugins/toolchain/releases/:v/default",
              "system org; toolchain:operate; MFA session (aal2); step-up",
              "apiCalls",
              "toolchain.default.set"
            ],
            [
              "GET",
              "/plugins/toolchain/releases/:v/default-preview",
              "system org; toolchain:operate; MFA session (aal2)",
              "apiCalls",
              "—"
            ],
            [
              "POST",
              "/plugins/toolchain/releases/:v/deprecate",
              "system org; toolchain:operate; MFA session (aal2); step-up",
              "apiCalls",
              "toolchain.release.deprecate"
            ],
            [
              "PUT",
              "/plugins/toolchain/releases/:v/rollout",
              "system org; toolchain:operate; MFA session (aal2); step-up",
              "apiCalls",
              "toolchain.rollout.update"
            ],
            [
              "POST",
              "/plugins/toolchain/releases/:v/yank",
              "system org; toolchain:operate; MFA session (aal2); step-up",
              "apiCalls",
              "toolchain.release.yank, toolchain.default.restore"
            ],
            [
              "GET",
              "/plugins/vuln-waivers",
              "plugins:read",
              "apiCalls",
              "—"
            ],
            [
              "GET",
              "/plugins/vulnerabilities/:advisoryId",
              "plugins:read",
              "apiCalls",
              "—"
            ],
            [
              "GET",
              "/plugins/vulnerabilities/fleet",
              "system org; platform:read or plugins:moderate; MFA session (aal2)",
              "apiCalls",
              "—"
            ],
            [
              "POST",
              "/public/plugin-security-notifications/confirm",
              "no bearer token",
              "—",
              "plugin.security_notifications.external_email.verify"
            ],
            [
              "POST",
              "/public/plugin-submissions",
              "no bearer token",
              "—",
              "plugin.submission.create"
            ],
            [
              "GET",
              "/public/plugin-submissions/challenge",
              "no bearer token",
              "—",
              "—"
            ],
            [
              "POST",
              "/public/plugin-submissions/inspect",
              "no bearer token",
              "—",
              "—"
            ],
            [
              "GET",
              "/public/plugin-submissions/status",
              "no bearer token",
              "—",
              "—"
            ],
            [
              "POST",
              "/public/plugin-submissions/verify",
              "no bearer token",
              "—",
              "plugin.submission.verify"
            ],
            [
              "GET",
              "/public/plugins",
              "no bearer token",
              "—",
              "—"
            ],
            [
              "GET",
              "/public/plugins/:publisher/:name",
              "no bearer token",
              "—",
              "—"
            ],
            [
              "GET",
              "/public/plugins/:publisher/:name/reviews",
              "no bearer token",
              "—",
              "—"
            ],
            [
              "GET",
              "/public/plugins/:publisher/:name/versions/:version/sbom",
              "no bearer token",
              "—",
              "—"
            ],
            [
              "GET",
              "/public/plugins/categories",
              "no bearer token",
              "—",
              "—"
            ],
            [
              "GET",
              "/public/plugins/sitemap",
              "no bearer token",
              "—",
              "—"
            ]
          ]
        },
        {
          "type": "text",
          "content": "Ask Agent Service — every route"
        },
        {
          "type": "text",
          "content": "7 routes, from frontend/src/generated/route-table/ask-agent.json."
        },
        {
          "type": "table",
          "headers": [
            "Method",
            "Endpoint",
            "Requires",
            "Meters",
            "Audit action"
          ],
          "rows": [
            [
              "POST",
              "/ask-agent",
              "pipelines:read or plugins:read or templates:read; feature ai_generation",
              "apiCalls",
              "ask.query"
            ],
            [
              "POST",
              "/ask-agent/agent/stream",
              "pipelines:read or plugins:read or templates:read; feature ai_generation",
              "apiCalls",
              "ask.agent.turn"
            ],
            [
              "GET",
              "/ask-agent/availability",
              "pipelines:read or plugins:read or templates:read; feature ai_generation",
              "apiCalls",
              "—"
            ],
            [
              "POST",
              "/ask-agent/draft-outcome",
              "pipelines:read or plugins:read or templates:read; feature ai_generation",
              "—",
              "—"
            ],
            [
              "POST",
              "/ask-agent/feedback",
              "pipelines:read or plugins:read or templates:read",
              "apiCalls",
              "ask.feedback"
            ],
            [
              "GET",
              "/ask-agent/providers",
              "pipelines:read or plugins:read or templates:read; feature ai_generation",
              "apiCalls",
              "—"
            ],
            [
              "POST",
              "/ask-agent/stream",
              "pipelines:read or plugins:read or templates:read; feature ai_generation",
              "apiCalls",
              "ask.query"
            ]
          ]
        }
      ]
    },
    {
      "id": "examples",
      "title": "Examples",
      "blocks": [
        {
          "type": "text",
          "content": "Plugins"
        },
        {
          "type": "text",
          "content": "Upload:"
        },
        {
          "type": "code",
          "content": "curl -X POST https://localhost:8443/api/plugins \\\n  -H \"Authorization: Bearer $TOKEN\" \\\n  -H \"x-org-id: $ORG_ID\" \\\n  -F \"plugin=@./my-plugin.zip\" \\\n  -F \"visibility=private\"",
          "language": "bash"
        },
        {
          "type": "text",
          "content": "List / Find:"
        },
        {
          "type": "code",
          "content": "curl \"https://localhost:8443/api/plugins?name=node-build&limit=10\" \\\n  -H \"Authorization: Bearer $TOKEN\" -H \"x-org-id: $ORG_ID\"\n\ncurl \"https://localhost:8443/api/plugins/find?name=node-build&version=1.0.0\" \\\n  -H \"Authorization: Bearer $TOKEN\" -H \"x-org-id: $ORG_ID\"",
          "language": "bash"
        },
        {
          "type": "text",
          "content": "Update:"
        },
        {
          "type": "code",
          "content": "curl -X PUT \"https://localhost:8443/api/plugins/<id>\" \\\n  -H \"Authorization: Bearer $TOKEN\" -H \"x-org-id: $ORG_ID\" \\\n  -H \"Content-Type: application/json\" \\\n  -d '{\"summary\": \"Scans images for CVEs.\", \"homepageUrl\": \"https://trivy.dev\", \"isDefault\": true}'",
          "language": "bash"
        },
        {
          "type": "text",
          "content": "Delete:"
        },
        {
          "type": "code",
          "content": "curl -X DELETE \"https://localhost:8443/api/plugins/<id>\" \\\n  -H \"Authorization: Bearer $TOKEN\" -H \"x-org-id: $ORG_ID\"",
          "language": "bash"
        },
        {
          "type": "text",
          "content": "Pipelines"
        },
        {
          "type": "text",
          "content": "Create:"
        },
        {
          "type": "code",
          "content": "curl -X POST https://localhost:8443/api/pipelines \\\n  -H \"Authorization: Bearer $TOKEN\" -H \"x-org-id: $ORG_ID\" \\\n  -H \"Content-Type: application/json\" \\\n  -d '{\n    \"project\": \"my-app\",\n    \"organization\": \"my-org\",\n    \"pipelineName\": \"my-app-pipeline\",\n    \"visibility\": \"private\",\n    \"props\": {\n      \"project\": \"my-app\",\n      \"organization\": \"my-org\",\n      \"synth\": {\n        \"source\": {\n          \"type\": \"github\",\n          \"options\": { \"repo\": \"my-org/my-app\", \"branch\": \"main\" }\n        },\n        \"plugin\": { \"name\": \"cdk-synth\", \"filter\": { \"version\": \"1.0.0\" } }\n      }\n    }\n  }'",
          "language": "bash"
        },
        {
          "type": "text",
          "content": "List / Find:"
        },
        {
          "type": "code",
          "content": "curl \"https://localhost:8443/api/pipelines?project=my-app&limit=10\" \\\n  -H \"Authorization: Bearer $TOKEN\" -H \"x-org-id: $ORG_ID\"\n\ncurl \"https://localhost:8443/api/pipelines/find?project=my-app&organization=my-org\" \\\n  -H \"Authorization: Bearer $TOKEN\" -H \"x-org-id: $ORG_ID\"",
          "language": "bash"
        },
        {
          "type": "text",
          "content": "AI Generation"
        },
        {
          "type": "text",
          "content": "Generate pipeline:"
        },
        {
          "type": "code",
          "content": "curl -X POST https://localhost:8443/api/pipelines/generate \\\n  -H \"Authorization: Bearer $TOKEN\" -H \"x-org-id: $ORG_ID\" \\\n  -H \"Content-Type: application/json\" \\\n  -d '{\n    \"prompt\": \"Build a Node.js app from GitHub, run tests, and deploy with CDK\",\n    \"provider\": \"anthropic\",\n    \"model\": \"claude-sonnet-5\"\n  }'",
          "language": "bash"
        },
        {
          "type": "text",
          "content": "Generate + deploy plugin:"
        },
        {
          "type": "text",
          "content": "Before generating, the service looks up the closest existing plugins the caller can already see (up to 5, matched on name, keywords, category and description; deprecated and yanked versions are skipped). The model is told not to duplicate them. The response returns them as similarPlugins: [{ id, name, version, category, summary, keywords }], and on the stream they arrive in the done event's data. This is only a hint: if the lookup fails, generation still runs and similarPlugins is []."
        },
        {
          "type": "text",
          "content": "The model is told to follow the catalog's Dockerfile rules: FROM a plugin-<eco>-base image, downloads only through fetch-verified with pinned digests, no pipe-to-shell installers, and a final USER 1000:1000. The generated Dockerfile is then checked with the same static lint as pipeline-manager plugin validate --lint, and the response (and the stream's done event) carries dockerfileViolations: string[]: every rule it breaks, empty when it complies. Review and fix them before deploying."
        },
        {
          "type": "code",
          "content": "curl -X POST https://localhost:8443/api/plugins/generate \\\n  -H \"Authorization: Bearer $TOKEN\" -H \"x-org-id: $ORG_ID\" \\\n  -H \"Content-Type: application/json\" \\\n  -d '{\n    \"prompt\": \"A Node.js 20 build plugin that runs npm ci, npm test, and npm run build\",\n    \"provider\": \"anthropic\",\n    \"model\": \"claude-sonnet-5\"\n  }'\n\ncurl -X POST https://localhost:8443/api/plugins/deploy-generated \\\n  -H \"Authorization: Bearer $TOKEN\" -H \"x-org-id: $ORG_ID\" \\\n  -H \"Content-Type: application/json\" \\\n  -d '{\n    \"name\": \"nodejs-build\",\n    \"version\": \"1.0.0\",\n    \"commands\": [\"npm run build\"],\n    \"installCommands\": [\"npm ci\"],\n    \"dockerfile\": \"FROM plugin-node-base:1.0\\nWORKDIR /app\\nUSER 1000:1000\\n\"\n  }'",
          "language": "bash"
        }
      ]
    },
    {
      "id": "response-format",
      "title": "Response Format",
      "blocks": [
        {
          "type": "text",
          "content": "All API responses follow a consistent format:"
        },
        {
          "type": "text",
          "content": "Success:"
        },
        {
          "type": "code",
          "content": "{\n  \"success\": true,\n  \"statusCode\": 200,\n  \"data\": { ... }\n}",
          "language": "json"
        },
        {
          "type": "text",
          "content": "Paginated: list endpoints return their items under a named key (pipelines, plugins, registry, etc.) alongside a pagination object:"
        },
        {
          "type": "code",
          "content": "{\n  \"success\": true,\n  \"statusCode\": 200,\n  \"pipelines\": [ ... ],\n  \"pagination\": {\n    \"total\": 42,\n    \"limit\": 10,\n    \"offset\": 0,\n    \"hasMore\": true\n  }\n}",
          "language": "json"
        },
        {
          "type": "text",
          "content": "Error: the error code and message are returned at the top level (not nested), with an optional details field:"
        },
        {
          "type": "code",
          "content": "{\n  \"success\": false,\n  \"statusCode\": 404,\n  \"code\": \"NOT_FOUND\",\n  \"message\": \"Pipeline not found\"\n}",
          "language": "json"
        }
      ]
    },
    {
      "id": "reporting-endpoints",
      "title": "Reporting Endpoints",
      "blocks": [
        {
          "type": "text",
          "content": "Pipeline execution and plugin build analytics. Time ranges default to the last 30 days. See AWS Deployment -- Report API Endpoints for the full endpoint list with query parameters."
        },
        {
          "type": "table",
          "headers": [
            "Method",
            "Endpoint",
            "Description"
          ],
          "rows": [
            [
              "GET",
              "/reports/execution/count",
              "Execution count per pipeline with status breakdown"
            ],
            [
              "GET",
              "/reports/execution/success-rate",
              "Pass/fail rate over time (interval; optional tz IANA name and weekStart monday\\",
              "sunday bucket it like the stakeholder report — invalid → 400)"
            ],
            [
              "GET",
              "/reports/execution/duration",
              "Avg/min/max/p95 execution duration"
            ],
            [
              "GET",
              "/reports/execution/stage-failures",
              "Stage failure heatmap — failures over terminal stage outcomes (lifecycle rows such as STARTED / IN_PROGRESS are not attempts)"
            ],
            [
              "GET",
              "/reports/execution/stage-bottlenecks",
              "Slowest stages per pipeline"
            ],
            [
              "GET",
              "/reports/execution/errors",
              "Error categorization (top N) across every org — the platform operator's view. Cross-org error TEXT, so the system-org-only orgs:read (plus aal2) rather than reports:read; no includeDescendants, and the retention floor does not apply"
            ],
            [
              "GET",
              "/reports/execution/dora",
              "Per-environment DORA metrics (headline production) with performance-level bands: deploy-basis frequency, measured lead time (commit→deploy; unknown when unresolved — no proxy), two-class change-failure rate, production median time to restore (meanTimeToRestore), coverage; a band on fewer than 5 observations is insufficient with its n (reports:read + advanced_reporting feature — Enterprise, or the Advanced Reporting add-on; from, to, includeDescendants needs reports:rollup; optional pipelineId, environment). See DORA Metrics"
            ],
            [
              "GET",
              "/reports/execution/dora/trend",
              "DORA deployment-frequency + two-class change-failure trend (failed, postDeployFailures, total sum to the headline) bucketed by interval, optional tz / weekStart (same gates/scoping as /dora)"
            ],
            [
              "GET",
              "/reports/execution/build-health",
              "Per-pipeline build health — per-stage success rate + p50/p90/p99 timing (reports:read; not advanced_reporting — standard on every tier; pipelineId, from, to)"
            ],
            [
              "POST",
              "/reports/deployments/:executionId/outcome",
              "Mark a successful production deploy as failed/restored (feeds post-deploy CFR + median time to restore, measured from the failed marker); pipelines:write + advanced_reporting"
            ],
            [
              "POST",
              "/reports/incidents",
              "Ingest a production incident {incidentId, environment, openedAt, resolvedAt?, severity} from your monitoring → automated post-deploy CFR/MTTR. Machine reporting:ingest scope, idempotent on (org, incidentId). See Incident Webhook"
            ],
            [
              "POST",
              "/reports/ingest-health",
              "The ingestion Lambda's delivery-health heartbeat {forwarded, dropped, lastEventAt}. Machine reporting:ingest scope"
            ],
            [
              "GET",
              "/reports/ingest-health",
              "Read that heartbeat back — {health, now}, where health is null when the deployment has never reported ingestion (not the same as stale) and now is the server clock. Drives the Reports freshness strip, which separates \"no deploys in range\" from \"nothing has reached the ingest pipeline since X\". User-facing: org-scoped, reports:read (not the reporting:ingest scope, and not advanced_reporting — it applies to the execution reports every tier sees)"
            ],
            [
              "GET",
              "/reports/retention",
              "The org's effective retention, read-only — {eventRetentionDays, doraRetentionDays, eventMaxRangeDays, doraMaxRangeDays} (-1 = unlimited; *MaxRangeDays is the horizon clamped to the 730-day report ceiling). Drives the Reports date-range cap. reports:read only (not advanced_reporting — the Retention Pack is sold to every tier)"
            ],
            [
              "GET",
              "/reports/plugins/summary",
              "Plugin inventory stats"
            ],
            [
              "GET",
              "/reports/plugins/build-success-rate",
              "Docker build success rate over time (optional tz / weekStart, as /reports/execution/success-rate)"
            ],
            [
              "GET",
              "/reports/plugins/build-duration",
              "Build time per plugin"
            ],
            [
              "GET",
              "/reports/plugins/build-failures",
              "Build failure reasons (top N) across every org — the platform operator's view. Cross-org failure TEXT, so the system-org-only orgs:read (plus aal2) rather than reports:read; no includeDescendants"
            ],
            [
              "GET",
              "/reports/plugins/runtime-success-rate",
              "Runtime success rate per plugin version, from pipeline runs"
            ],
            [
              "GET",
              "/reports/plugins/runtime-duration",
              "Runtime p50/p95 duration per plugin version"
            ]
          ]
        }
      ]
    }
  ],
  "sourceDoc": "docs/api-reference.md"
};
