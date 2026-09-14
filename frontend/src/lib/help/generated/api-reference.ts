// GENERATED FROM docs/api-reference.md — DO NOT EDIT.
// Regenerate: npm run generate:help  (see frontend/scripts/generate-help.mjs)
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
          "content": "REST API for managing pipelines, plugins, and reporting. All services run behind an Nginx gateway that handles TLS termination and JWT validation."
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
          "content": "Access tokens are short-lived — 900 s (15 min) by default, set by JWT_EXPIRES_IN with optional per-tier overrides via JWT_EXPIRES_IN_<TIER>. The short TTL is what makes privilege changes take effect quickly; see Permissions → session invalidation. Use the refresh-token endpoint to obtain a new access token without re-authenticating."
        }
      ]
    },
    {
      "id": "endpoints",
      "title": "Endpoints",
      "blocks": [
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
              "Create pipeline"
            ],
            [
              "PUT",
              "/pipelines/:id",
              "Update pipeline"
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
              "Find one plugin by query"
            ],
            [
              "GET",
              "/plugins/:id",
              "Get by ID"
            ],
            [
              "POST",
              "/plugins",
              "Upload plugin (ZIP multipart)"
            ],
            [
              "POST",
              "/plugins/lookup",
              "Find plugin by validated filter body (POST for URL-length safety)"
            ],
            [
              "PUT",
              "/plugins/:id",
              "Update plugin"
            ],
            [
              "PUT",
              "/plugins/bulk/update",
              "Bulk-update plugins (strict whitelist of mutable fields)"
            ],
            [
              "DELETE",
              "/plugins/:id",
              "Delete plugin"
            ],
            [
              "GET",
              "/plugins/providers",
              "List AI providers"
            ],
            [
              "POST",
              "/plugins/generate",
              "AI-generate plugin from prompt (consumes aiCalls quota)"
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
              "Counts pipelines (in caller's org) referencing each plugin name"
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
              "All orgs' quotas (system admin only)"
            ],
            [
              "GET",
              "/quotas/at-risk?threshold=80",
              "Orgs ≥ threshold% on any quota dimension (system admin only)"
            ],
            [
              "GET",
              "/quotas/:orgId",
              "Specific org quotas (orgId in URL — auth scoped)"
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
              "Internal: increment usage (service-to-service, amount capped at 1000/call)"
            ]
          ]
        },
        {
          "type": "text",
          "content": "Message Service"
        },
        {
          "type": "text",
          "content": "Base path /api/messages. Reads require messages:read; writes require messages:write. Announcements (broadcast, recipientOrgId: \"*\") are system-admin only."
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
              "Get an organization",
              "— (own org / managed team / sysadmin)"
            ],
            [
              "PUT",
              "/organization/:id",
              "Update an organization",
              "system admin"
            ],
            [
              "DELETE",
              "/organization/:id",
              "Delete an organization (+ step-up)",
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
              "GDPR data export",
              "org:settings"
            ],
            [
              "PATCH",
              "/organization/:id/transfer-owner",
              "Transfer ownership (+ step-up)",
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
              "List descendant teams",
              "— (member)"
            ],
            [
              "GET",
              "/organization/:id/roles",
              "List Roles (permission sets) + members",
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
          "content": "curl -X PUT \"https://localhost:8443/api/plugins/<id>\" \\\n  -H \"Authorization: Bearer $TOKEN\" -H \"x-org-id: $ORG_ID\" \\\n  -H \"Content-Type: application/json\" \\\n  -d '{\"description\": \"Updated plugin\", \"computeType\": \"LARGE\", \"isDefault\": true}'",
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
          "content": "curl -X POST https://localhost:8443/api/pipelines \\\n  -H \"Authorization: Bearer $TOKEN\" -H \"x-org-id: $ORG_ID\" \\\n  -H \"Content-Type: application/json\" \\\n  -d '{\n    \"project\": \"my-app\",\n    \"organization\": \"my-org\",\n    \"pipelineName\": \"my-app-pipeline\",\n    \"visibility\": \"private\",\n    \"props\": {\n      \"project\": \"my-app\",\n      \"organization\": \"my-org\",\n      \"synth\": {\n        \"source\": {\n          \"type\": \"github\",\n          \"options\": { \"repo\": \"my-org/my-app\", \"branch\": \"main\" }\n        },\n        \"plugin\": { \"name\": \"cdk-synth\", \"version\": \"1.0.0\" }\n      }\n    }\n  }'",
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
          "type": "code",
          "content": "curl -X POST https://localhost:8443/api/plugins/generate \\\n  -H \"Authorization: Bearer $TOKEN\" -H \"x-org-id: $ORG_ID\" \\\n  -H \"Content-Type: application/json\" \\\n  -d '{\n    \"prompt\": \"A Node.js 20 build plugin that runs npm ci, npm test, and npm run build\",\n    \"provider\": \"anthropic\",\n    \"model\": \"claude-sonnet-5\"\n  }'\n\ncurl -X POST https://localhost:8443/api/plugins/deploy-generated \\\n  -H \"Authorization: Bearer $TOKEN\" -H \"x-org-id: $ORG_ID\" \\\n  -H \"Content-Type: application/json\" \\\n  -d '{\n    \"name\": \"nodejs-build\",\n    \"version\": \"1.0.0\",\n    \"commands\": [\"npm run build\"],\n    \"installCommands\": [\"npm ci\"],\n    \"dockerfile\": \"FROM node:20-slim\\n...\"\n  }'",
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
              "Mark a successful production deploy as failed/restored (feeds post-deploy CFR + real MTTR); reports:read + advanced_reporting"
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
            ]
          ]
        }
      ]
    }
  ],
  "sourceDoc": "docs/api-reference.md"
};
