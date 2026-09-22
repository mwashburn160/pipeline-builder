// GENERATED FROM docs/api-reference.md — DO NOT EDIT.
// Regenerate: npm run generate:help  (see frontend/scripts/generate-help.mjs)
// SOURCE-SHA256: 4d2cf1dd40867eee609aec3b204e1519fbfebe865e44b64454426fb341880463
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
          "content": "REST API for managing pipelines, plugins, and reporting. All services run behind an Nginx gateway that handles TLS termination and routing; token validation is done by each service (the gateway only decodes claims for its access log — see Authentication)."
        },
        {
          "type": "text",
          "content": "Related docs: Environment Variables | Plugin Catalog | AWS Deployment"
        }
      ]
    },
    {
      "id": "overview",
      "title": "Overview",
      "blocks": [
        {
          "type": "text",
          "content": "This reference catalogs the REST endpoints exposed by the Pipeline Builder services — pipeline, plugin, compliance, quota, organization/access, and reporting — with each route's method, path, description, and (where applicable) the fine-grained permission or quota it consumes. It's for API integrators and operators calling the platform directly: every request goes through the Nginx gateway and needs a Bearer JWT plus an x-org-id tenant header. Endpoints are grouped by service, followed by common query parameters, worked curl examples, and the shared success / paginated / error response envelope. For the permission names in the Organization table, see Roles & Permissions."
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
          "content": "A handful of endpoints exist ONLY for service-to-service calls and are closed to every user token, including a superadmin's: /internal/*, the quota usage counters (POST /quotas/:orgId/{increment,decrement}), the entity-event ingest (POST /compliance/events/entity), the audit ingest (POST /audit/events), the org-onboarding hook (POST /compliance/subscriptions/auto-subscribe) and the entitlement sync legs (/compliance/entitlements/:orgId, PUT /reports/retention-sync/:orgId)."
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
              "GET",
              "/pipelines/providers",
              "List AI providers"
            ],
            [
              "POST",
              "/pipelines/generate",
              "AI-generate pipeline from prompt (consumes aiCalls quota)"
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
              "/pipelines/generate/from-url/stream",
              "Analyze Git URL + stream pipeline (consumes aiCalls quota)"
            ],
            [
              "GET",
              "/pipelines/registry",
              "List deployed-stack registrations (pipelineId, stackName, region, lastDeployed) for the caller's org — no ARNs, no account id"
            ],
            [
              "POST",
              "/pipelines/registry",
              "Upsert registry entry (deploy hook; tenant-guarded)"
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
              "Find one plugin by query, including publisher (verifies the image signature first — 409 IMAGE_VERIFICATION_FAILED if it doesn't verify). Same resolution and { plugin, warnings } answer as /plugins/lookup"
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
              "Upload plugin (ZIP multipart). Optional metadata part: a JSON object of catalog edits (see Catalog metadata); absent ⇒ every detected value is accepted. Execution-contract keys in it → 400. Optional publishRequest=true (needs plugins:publish and visibility=public): once the build completes, submit a new-listing / new-version publish request for the version as the uploader (Plugin Publishing)"
            ],
            [
              "POST",
              "/plugins/inspect",
              "Dry-run parse of a plugin ZIP: every catalog field with its detected value, source (spec / readme / dockerfile / derived) and validation error. Builds and stores nothing; same zip limits as upload; rate limited; plugins:write"
            ],
            [
              "POST",
              "/plugins/lookup",
              "Find plugin by validated filter body (POST for URL-length safety). The endpoint synth resolves plugins through. Without publisher: own org → parent org's shared plugin → the Official listing pipeline-builder/<name> through the org's install (explicit, else implicit). With publisher: only that publisher's listing, only through an install (403 PLUGIN_NOT_INSTALLED / PLUGIN_BLOCKED_BY_POLICY, 409 PLUGIN_UNAVAILABLE otherwise). A listing's version range is the install's, narrowed by filter.version; yanked listing versions never resolve. Verifies the image signature (and, for a listing, the signed tier and publisher) and returns imageDigest, which synth pins CodeBuild to; 409 IMAGE_VERIFICATION_FAILED otherwise. Answer: { plugin, warnings } — plugin carries publisher, publisherTier, listingId, imageRepository, source (org \\",
              "listing) and install (explicit \\",
              "implicit \\",
              "null); warnings may list PLUGIN_SHADOWS_LISTING, PLUGIN_SECRETS_WITHHELD, LISTING_UNMAINTAINED, PLUGIN_DEPRECATED, PLUGIN_YANKED, which synth prints"
            ],
            [
              "PUT",
              "/plugins/:id",
              "Update a version's descriptive catalog fields (summary, description, displayName, category, keywords, license, links, icon, changelog, readme) and operational flags (visibility, isActive, isDefault, lifecycle, criticality, labels, links, owner). Execution-contract keys (commands, env, secrets, computeType, …) → 400; they change only with a new version. Catalog edits on a frozen or listed version → 409 PLUGIN_VERSION_FROZEN"
            ],
            [
              "POST",
              "/plugins/:id/deprecate",
              "{ deprecated?: boolean, message?: string } — deprecate (or un-deprecate) a version: it keeps resolving with a warning and AI selection stops offering it"
            ],
            [
              "POST",
              "/plugins/:id/yank",
              "{ reason } — stop a version resolving for ranges, latest and the default (an exact pin still resolves, with a warning); yanking the default promotes the next. A listed version → 409 (yank it through the ecosystem)"
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
              "Delete a version. In use by the org's pipelines or listed → 409 PLUGIN_VERSION_IN_USE unless ?force=true with a step-up token; referenced by a pending publish request → 409 PLUGIN_VERSION_FROZEN. Deleting the default promotes the next default; the plugins quota slot is refunded while its period is current"
            ],
            [
              "GET",
              "/plugins/providers",
              "List AI providers"
            ],
            [
              "POST",
              "/plugins/generate",
              "AI-generate plugin from prompt (consumes aiCalls quota). Also returns similarPlugins (see below)"
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
              "Failed build jobs (org-scoped for non-system admins)"
            ],
            [
              "GET",
              "/plugins/queue/dlq",
              "Dead letter queue jobs (org-scoped for non-system admins)"
            ],
            [
              "POST",
              "/plugins/queue/dlq/:jobId/replay",
              "Replay a single DLQ job (admin only, tenant-checked)"
            ],
            [
              "DELETE",
              "/plugins/queue/dlq",
              "Purge all DLQ jobs (system admin only)"
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
              "{ listingId } }, profile_change { target: { handle?, displayName? } }, verify { application: { domain?, notes? } } (eligibility checked automatically: 403 VERIFIED_PLAN_REQUIRED, 409 VERIFIED_DOMAIN_REQUIRED / VERIFIED_OWNER_MFA_REQUIRED, 503 when it can't be checked; details.checks) → 201 { request, autoApproved }. Version kinds pin the image digest and freeze the version. Failing gates → 409 PUBLISH_GATE_FAILED (details.gates); listings limit → 429 QUOTA_EXCEEDED (details.quotaType: listings); stale terms → 403 PUBLISHER_TERMS_REQUIRED. Version / update / yank / unpause need plugins:publish; the rest publishers:manage`"
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
              "The in-app catalog: every listing with the org's install state, resolved version, requiresApproval, blocked, the pipeline reference and shadowedBy; ?q=&category=&installed= (plugins:read)"
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
              "Uninstall, or withdraw a pending request. An explicit Official install falls back to the implicit one (plugins:install)"
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
              "{ note? } — first approval of a two-person request (→ pending_second_approval, N28) or the only approval (executes). Step-up for yank, transfer, claim, profile change, Verified and moderation requests. 403 SEPARATION_OF_DUTIES for your own org's request, your own upload or your own first approval"
            ],
            [
              "POST",
              "/plugins/ecosystem/requests/:id/second-approve",
              "The second approval, by a different manager; executes the request"
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
              "{ reason } — suspend at once and re-sign with the lowest trust (publishers:verify + step-up)"
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
              "suspended, reason }` — lifting a suspension is a two-person request (step-up)"
            ],
            [
              "POST",
              "/plugins/ecosystem/listings/:id/versions/:version/yank",
              "{ reason } — yank at once: stops resolving, removes the public/* tag, tells the publisher (step-up)"
            ],
            [
              "POST",
              "/plugins/ecosystem/listings/:id/versions/:version/unyank",
              "{ reason } — opens a two-person moderation request (step-up)"
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
              "Apply a pending change (a manager other than the proposer) (step-up)"
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
              "Trigger a scan (caller-supplied filter.orgId is server-overwritten)"
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
              "Caller's org quotas (plugins/pipelines/apiCalls/aiCalls)"
            ],
            [
              "GET",
              "/quotas/all",
              "All orgs' quotas (system admin only). ?limit= 1–1000 (default 100) and ?offset= 1-based, capped at 100 000 — deep paging past that is refused-by-clamp rather than turned into an unbounded collection scan"
            ],
            [
              "GET",
              "/quotas/at-risk?threshold=80",
              "Orgs ≥ threshold% on any quota dimension (system admin only)"
            ],
            [
              "GET",
              "/quotas/:orgId",
              "Specific org quotas (orgId in URL — auth scoped; the id is matched case-insensitively and canonicalized to lowercase for the lookup)"
            ],
            [
              "GET",
              "/quotas/:orgId/:type",
              "Single quota type status"
            ],
            [
              "PUT",
              "/quotas/:orgId",
              "Update tier/limits (system admin only)"
            ],
            [
              "POST",
              "/quotas/:orgId/reset",
              "Reset usage counters (system admin only; + step-up, service principals exempt)"
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
              "Inbox (root messages), paginated + viewer-scoped; ?search= matches subject/content",
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
              "Reply to a thread",
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
            ]
          ]
        },
        {
          "type": "text",
          "content": "Contacting support: reaching support is self-service, so POST /messages/support is gated on messages:read — the same authority the inbox needs — rather than messages:write. A read-only member can therefore file a request although they cannot send ordinary messages. The route is safe at that floor because the recipient is not a caller input: it is always the system support org, on the reserved support channel. Everything else (validation, attachment linking, the SSE ping, the send rate limit) matches POST /messages; announcements, broadcasts and per-user targeting do not apply. Attachments must still be uploaded through POST /messages/attachments, which remains messages:write."
        },
        {
          "type": "text",
          "content": "Per-user direct messages: a conversation POST /messages may include recipientUserId (a member of recipientOrgId) to target a single user — only that user (plus the sender org and system org) can see the message and its replies/attachments. Omit it for an org-wide message. recipientUserId is rejected on announcements/broadcasts."
        },
        {
          "type": "text",
          "content": "Attachments flow: POST /messages/attachments first (one call per file, ≤ MESSAGE_ATTACHMENT_MAX_MB, MIME allow-listed), then pass the returned ids as attachmentIds on POST /messages or /:id/reply. Blobs live in S3-compatible storage (MinIO); see Environment Variables → Messaging & Attachments."
        },
        {
          "type": "text",
          "content": "Organization & Access Service"
        },
        {
          "type": "text",
          "content": "Base path /api/organization (and /api/invitation). Management endpoints enforce fine-grained permissions via requirePermission('resource:action') — a user passes if their effective permissions (the union of the Roles assigned to them) include it, or they're a super-admin. The required permission is in the last column; endpoints marked system admin require the global super-admin flag instead."
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
              "org:settings"
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
              "system admin"
            ],
            [
              "DELETE",
              "/organization/:id",
              "Soft-delete an organization (+ step-up): recovery snapshot, purgeAfter retention window, sessions cut → 202 { deletedAt, purgeAfter, snapshotId }. The window is max(ORG_DELETION_RETENTION_DAYS, SOFT_DELETE_RETENTION_DAYS) — the org must outlive the rows its cascade tombstones. Refused (400) while it has live teams",
              "system admin"
            ],
            [
              "POST",
              "/organization/:id/restore",
              "Restore a soft-deleted org inside its window (+ step-up). A parent admin may restore its own team; a team restore needs its parent live and still team-capable (409) and room in the account's pooled seats (409), and re-syncs the root's tier + entitlements",
              "org:settings (own org / managed team)"
            ],
            [
              "POST",
              "/organization/:id/move",
              "Reparent (+ step-up). Body `{ parentOrgId: string \\",
              "null }: a team to another eligible root (team/enterprise tier), a team out as a standalone root (null), or a root with no teams (live or pending deletion) in under a root. Refuses self-parenting, cycles, nesting two deep, an ineligible/missing destination and a no-op (400/404), a move over the destination's seat cap (409), a competing move that landed first (409 ORG_MOVE_CONFLICT — every structural check is re-asserted inside the transaction and the write is conditional on the parent this request read, so of two interleaved moves exactly one commits), and nesting a root that still has a billable subscription (409, cancel it first; 503 if billing can't confirm). Re-syncs tier, entitlements and quota seeding for the new account (a team takes the root's tier + entitlements with -1 quotas; a new root starts on the default tier, since no subscription follows it, with that tier's quota preset and no entitlements) and invalidates every session scoped to the org → { organization }` (the detail DTO with hierarchy)",
              "system admin"
            ],
            [
              "PATCH",
              "/organization/:id/tier",
              "Change pricing tier (+ step-up)",
              "system admin"
            ],
            [
              "GET",
              "/organization/:id/export",
              "GDPR data export — a single JSON blob carrying every Postgres table and every Mongo collection the delete cascade removes (invitations, audit events, IdP config + group mappings, domains, join requests, SAML SLO sessions, service accounts + keys with the key hash stripped, memberships, Role assignments and Roles). The same artifact is captured as the recovery snapshot at soft-delete time; failed names any store that could not be read and truncated any that hit its cap",
              "org:settings"
            ],
            [
              "PATCH",
              "/organization/:id/transfer-owner",
              "Transfer ownership (+ step-up on an aal: 2 session)",
              "org:settings"
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
              "org:settings (admin of :id)"
            ],
            [
              "DELETE",
              "/organization/:id/teams/:teamId",
              "A parent admin soft-deletes one of its own teams (+ step-up) — the same snapshot + retention window as the sysadmin delete → 202 { deletedAt, purgeAfter, snapshotId }. 404 unless the team's direct parent is :id. The team leaves the live scope at once: its members stop counting against pooled seats and it drops out of team lists and rollups",
              "org:settings (admin of :id)"
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
              "org:idp (+ sso entitlement)"
            ],
            [
              "GET",
              "/organization/:id/idp/sp-info",
              "The values to register AT the IdP, computed from the deployment's public URL and SP keys: { sp: { entityId, acsUrl, metadataUrl, sloUrl, oidcRedirectUri, signingCertificate, encryptionCertificate } }. Available before any connection exists",
              "org:idp (+ sso entitlement)"
            ],
            [
              "POST",
              "/organization/:id/idp/metadata/import",
              "Parse an IdP SAML metadata document — { xml } or { url } (fetched under the SSRF guard: https, no private addresses, no redirects, 5 s, 512 KB) — into { metadata: { entityId, ssoUrl, sloUrl?, certificates, wantsSignedRequests } }. Saves nothing",
              "org:idp (+ sso entitlement)"
            ],
            [
              "POST",
              "/organization/:id/idp/test",
              "Start a test connection (dry run) → { url, state } for a popup. Works before the connection is enabled",
              "org:idp (+ sso entitlement)"
            ],
            [
              "POST",
              "/organization/:id/idp/test/complete",
              "{ state, code?, error? } → { report }: ok / reason, asserted email / name / groups, the role mappings that would apply. Creates no session, user or membership; only the admin who started the test can collect it. Recorded as lastTest and audited sso.test",
              "org:idp (+ sso entitlement)"
            ],
            [
              "GET \\",
              "PATCH",
              "/organization/:id/mfa-policy",
              "Read / change the org's two-factor requirement: requireMfa, a graceDays count the deadline is computed from server-side (0–90, default 14), and idpEnforcesMfa — the org's statement that its own IdP requires a second factor, which is what makes an SSO sign-in count as aal: 2. Enforced when a token is ISSUED, not per route: past the grace period a single-factor session is refused with 401 MFA_REQUIRED. The read returns both the org's own setting and what a parent org imposes (inheritedFrom + inheritedFromName, the parent's id and name, when a parent's requirement applies), plus enrolment: { members, enrolled } — how many ACTIVE members hold a passkey or a confirmed authenticator app, so an admin choosing a grace period can see how many people it would refuse (someone holding both factors counts once). Also adminActionsRequireMfa — the separate \"administrative actions require MFA\" policy (read returns adminActionsRequireMfa, adminActionsOwn, adminActionsInheritedFrom[Name]); turning it ON signs every other member of the org and its teams out so the org_admin_aal claim applies at once, while turning it off lets each token pick it up at its next refresh (sessionsRefreshed in the response). The write is step-up gated; LOOSENING anything (requirement off, admin-actions policy off, idpEnforcesMfa on) also needs an aal: 2 session (401 MFA_REQUIRED otherwise), while tightening does not. Refused (409 MFA_BOOTSTRAP_STILL_OPEN) for the system org while the bootstrap-admin exception is still open",
              "org:settings"
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
              "org:impersonation"
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
              "Send an invitation",
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
          "content": "The full permission catalog (pipelines:write, pipelines:publish, plugins:publish, compliance:write, billing:manage, reports:rollup, org:settings, …) lives in @pipeline-builder/api-core (types/permissions.ts). Custom Roles grant a subset of the org-assignable permissions (registry:read/write are Super-Admin-only and rejected) that is also bounded by the author's own permissions (a permission ceiling — you can't grant what you don't hold); a member's effective permissions are the union of the Roles assigned to them, and :read permissions are enforced. Managing Roles is gated by roles:manage. See Roles & Permissions for the full catalog, built-in bundles, and enforcement."
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
              "/auth/refresh",
              "Rotate an interactive session's token pair. The browser presents the pb_refresh cookie (empty body); a CLI caller posts { refreshToken }. Machine sessions are refused (they renew through /user/generate-token)",
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
              "Re-scope the current session to { organizationId } (same slot, same assurance). Allowed with a membership there or admin authority inherited from a parent org — a parent admin can open its teams as admin with no roster entry (see Authentication → parent-admin access). 403 otherwise",
              "— (auth)"
            ],
            [
              "GET",
              "/user/organizations",
              "Orgs the caller can switch into: membership rows (organizationId, organizationName, slug, role, isActive, joinedAt, parentOrgId, parentOrgName, tier, childOrgCount), then one viaAncestor: true row (role: 'admin') per live team of an org they administer but aren't a member of",
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
              "Grant the waiting device a session, { userCode }. The CLI session inherits this session's org, amr, aal and auth_time",
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
          "content": "X-Pb-Client names the calling client on every request: web (the browser app) receives its refresh token as an HttpOnly cookie and never in the body, any other value keeps the JSON body flow. /auth/refresh and /auth/logout reject a request that omits the header with 403 CLIENT_TYPE_REQUIRED — it is the CSRF proof that makes the ambient cookie safe. Every session-issuing endpoint (login, OAuth/SSO callback, switch-org, tokens/revoke-all) applies the same split. See Authentication → Where the refresh token lives."
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
          "content": "The model is told to follow the catalog's Dockerfile rules: FROM a pipeline-<eco>-base image, downloads only through fetch-verified with pinned digests, no pipe-to-shell installers, and a final USER 1000:1000. The generated Dockerfile is then checked with the same static lint as pipeline-manager plugin validate --lint, and the response (and the stream's done event) carries dockerfileViolations: string[]: every rule it breaks, empty when it complies. Review and fix them before deploying."
        },
        {
          "type": "code",
          "content": "curl -X POST https://localhost:8443/api/plugins/generate \\\n  -H \"Authorization: Bearer $TOKEN\" -H \"x-org-id: $ORG_ID\" \\\n  -H \"Content-Type: application/json\" \\\n  -d '{\n    \"prompt\": \"A Node.js 20 build plugin that runs npm ci, npm test, and npm run build\",\n    \"provider\": \"anthropic\",\n    \"model\": \"claude-sonnet-5\"\n  }'\n\ncurl -X POST https://localhost:8443/api/plugins/deploy-generated \\\n  -H \"Authorization: Bearer $TOKEN\" -H \"x-org-id: $ORG_ID\" \\\n  -H \"Content-Type: application/json\" \\\n  -d '{\n    \"name\": \"nodejs-build\",\n    \"version\": \"1.0.0\",\n    \"commands\": [\"npm run build\"],\n    \"installCommands\": [\"npm ci\"],\n    \"dockerfile\": \"FROM pipeline-node-base:1.0\\nWORKDIR /app\\nUSER 1000:1000\\n\"\n  }'",
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
              "Pass/fail rate over time"
            ],
            [
              "GET",
              "/reports/execution/duration",
              "Avg/min/max/p95 execution duration"
            ],
            [
              "GET",
              "/reports/execution/stage-failures",
              "Stage failure heatmap"
            ],
            [
              "GET",
              "/reports/execution/stage-bottlenecks",
              "Slowest stages per pipeline"
            ],
            [
              "GET",
              "/reports/execution/errors",
              "Error categorization (top N)"
            ],
            [
              "GET",
              "/reports/execution/dora",
              "Per-environment DORA metrics (headline production) with performance-level bands: deploy-basis frequency, measured lead time (commit→deploy; unknown when unresolved — no proxy), two-class change-failure rate, production MTTR, coverage (reports:read + advanced_reporting feature — Enterprise, or the Advanced Reporting add-on; from, to, includeDescendants needs reports:rollup; optional pipelineId, environment). See DORA Metrics"
            ],
            [
              "GET",
              "/reports/execution/dora/trend",
              "DORA deployment-frequency + change-failure trend bucketed by interval (same gates/scoping as /dora)"
            ],
            [
              "GET",
              "/reports/execution/build-health",
              "Per-pipeline build health — per-stage success rate + p50/p90/p99 timing (reports:read; not advanced_reporting — standard on every tier; pipelineId, from, to)"
            ],
            [
              "POST",
              "/reports/deployments/:executionId/outcome",
              "Mark a successful production deploy as failed/restored (feeds post-deploy CFR + real MTTR); pipelines:write + advanced_reporting"
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
              "Docker build success rate over time"
            ],
            [
              "GET",
              "/reports/plugins/build-duration",
              "Build time per plugin"
            ],
            [
              "GET",
              "/reports/plugins/build-failures",
              "Build failure reasons (top N)"
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
