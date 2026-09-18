// GENERATED FROM docs/compliance.md — DO NOT EDIT.
// Regenerate: npm run generate:help  (see frontend/scripts/generate-help.mjs)
// SPDX-License-Identifier: Apache-2.0
import { ShieldCheck } from 'lucide-react';
import type { HelpTopic } from '../types';

export const complianceTopic: HelpTopic = {
  "icon": ShieldCheck,
  "id": "compliance",
  "title": "Compliance",
  "description": "Per-organization rule enforcement for plugins and pipelines",
  "sections": [
    {
      "id": "overview",
      "title": "Overview",
      "blocks": [
        {
          "type": "text",
          "content": "Per-organization rule enforcement for plugins and pipelines. Validates entity attributes against configurable rules, blocks operations that violate policies, and notifies org admins."
        },
        {
          "type": "text",
          "content": "Design: Fail-closed — if the compliance service is unreachable, plugin uploads and pipeline creates are rejected (HTTP 503)."
        }
      ]
    },
    {
      "id": "process-overview-validation-scan-lifecycle",
      "title": "Process overview (validation & scan lifecycle)",
      "blocks": [
        {
          "type": "list",
          "items": [
            "Inline check — a plugin upload or pipeline create calls /compliance/validate/... synchronously; error/critical violations block the operation (403).",
            "Rule merge — the engine evaluates the org's own rules plus its active subscribed published rules (a parent rule marked propagateToChildren also applies to nested teams).",
            "Async re-check — plugin/pipeline mutations enqueue a BullMQ event; a background worker re-evaluates the changed entity under its own tenant scope.",
            "Bulk / scheduled scans — POST /compliance/scans (or a cron scan-schedule) sweeps the org's full inventory through the same engine on demand or on a recurring basis.",
            "Record & notify — every result is written to the audit log; blocks (and, opt-in, warnings) fan out to the in-app inbox, email, and webhook per the org's notification preferences."
          ]
        }
      ]
    },
    {
      "id": "how-it-works",
      "title": "How It Works",
      "blocks": [
        {
          "type": "code",
          "content": "Plugin/Pipeline Service                  Compliance Service\n        │                                       │\n        │  POST /compliance/validate/plugin      │\n        ├──────────────────────────────────────►  │\n        │                                       ├── Fetch org rules + subscribed rules\n        │  { blocked: true, violations: [...] } │ ├── Evaluate rule engine\n        │◄──────────────────────────────────────┤ ├── Write audit log\n        │                                       │ └── Notify org admins\n        │  403 COMPLIANCE_VIOLATION              │"
        },
        {
          "type": "text",
          "content": "Each organization owns its compliance. The system org does not enforce rules on other organizations. Instead, it publishes recommended rules that any organization can browse, subscribe to, and customize. Independent organizations relate as peers via this catalog. The one exception is the org → team hierarchy: a parent organization's rule marked apply to child teams (propagateToChildren) is inherited and enforced on its nested teams."
        },
        {
          "type": "text",
          "content": "The system org is itself exempt from compliance enforcement — no rules are evaluated against its own entities, and scheduled/bulk scans skip it (unless SYSTEM_ORG_SCANS_ENABLED=true). Alongside its published rules, the system org also owns shared template policies and rules (isTemplate: true) that any org can clone into its own editable copy via the templates/clone endpoints."
        },
        {
          "type": "text",
          "content": "When validating an entity, the engine merges two rule sets:"
        },
        {
          "type": "list",
          "items": [
            "Org rules — rules the org created for itself",
            "Subscribed published rules — rules the org opted into from the published catalog"
          ]
        },
        {
          "type": "text",
          "content": "Results are cached per org+target (configurable TTL, default 60s). Caches are invalidated automatically on rule mutations and subscription changes."
        },
        {
          "type": "text",
          "content": "Inline validation (upload/create) is synchronous and blocking. Existing entities are re-evaluated asynchronously: plugin/pipeline mutations enqueue events on a Redis-backed (BullMQ) queue that a background worker drains under each event's own tenant scope, so already-deployed entities stay continuously checked without slowing down the request path. Bulk and scheduled scans reuse the same engine to sweep an org's entire inventory on demand or on a cron."
        }
      ]
    },
    {
      "id": "api-endpoints",
      "title": "API Endpoints",
      "blocks": [
        {
          "type": "text",
          "content": "Rules CRUD"
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
              "/compliance/rules",
              "List rules (filterable, paginated)"
            ],
            [
              "GET",
              "/compliance/rules/:id",
              "Get rule by ID"
            ],
            [
              "GET",
              "/compliance/rules/:id/history",
              "Rule change history"
            ],
            [
              "POST",
              "/compliance/rules",
              "Create rule — 409 CONFLICT if a rule with that name exists (live, or deleted: restore it instead)"
            ],
            [
              "PUT",
              "/compliance/rules/:id",
              "Update rule"
            ],
            [
              "DELETE",
              "/compliance/rules/:id",
              "Soft-delete rule"
            ]
          ]
        },
        {
          "type": "text",
          "content": "Published Catalog & Subscriptions"
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
              "/compliance/published-rules",
              "Browse published rules (filterable, includes subscribed flag)"
            ],
            [
              "GET",
              "/compliance/subscriptions",
              "List org's subscriptions (with rule details)"
            ],
            [
              "POST",
              "/compliance/subscriptions",
              "Subscribe to a published rule"
            ],
            [
              "POST",
              "/compliance/subscriptions/clone",
              "Clone a published rule into an editable org rule"
            ],
            [
              "POST",
              "/compliance/subscriptions/auto-subscribe",
              "Subscribe to all published rules (inactive; used at org onboarding)"
            ],
            [
              "PATCH",
              "/compliance/subscriptions/:ruleId",
              "Activate or deactivate a subscription ({ isActive: boolean })"
            ],
            [
              "POST",
              "/compliance/subscriptions/bulk",
              "Activate/deactivate many subscriptions at once ({ ruleIds, isActive })"
            ],
            [
              "GET",
              "/compliance/subscriptions/enforced",
              "Merged view of all currently-enforced rules (org + active subscriptions)"
            ],
            [
              "POST",
              "/compliance/subscriptions/preview/impact",
              "See how many of the org's existing entities a rule would fail, with samples — before enabling it"
            ],
            [
              "POST",
              "/compliance/subscriptions/preview",
              "Dry-run a rule against caller-supplied sample attributes"
            ],
            [
              "POST",
              "/compliance/subscriptions/:ruleId/pin",
              "Pin a subscription to the rule's current version"
            ],
            [
              "DELETE",
              "/compliance/subscriptions/:ruleId/pin",
              "Unpin (follow latest published version)"
            ],
            [
              "DELETE",
              "/compliance/subscriptions/:ruleId",
              "Unsubscribe (requires compliance:write, like deactivating)"
            ]
          ]
        },
        {
          "type": "text",
          "content": "Scans"
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
              "/compliance/scans",
              "List scans (filterable by target, status)"
            ],
            [
              "GET",
              "/compliance/scans/:id",
              "Get scan by ID"
            ],
            [
              "POST",
              "/compliance/scans",
              "Trigger a scan (`{ target: 'plugin' \\",
              "'pipeline' \\",
              "'all' }`)"
            ],
            [
              "POST",
              "/compliance/scans/:id/cancel",
              "Cancel a running scan"
            ]
          ]
        },
        {
          "type": "text",
          "content": "Scan Schedules"
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
              "/compliance/scan-schedules",
              "List recurring scan schedules"
            ],
            [
              "POST",
              "/compliance/scan-schedules",
              "Create schedule ({ target, cronExpression })"
            ],
            [
              "PUT",
              "/compliance/scan-schedules/:id",
              "Update schedule target or cron"
            ],
            [
              "PATCH",
              "/compliance/scan-schedules/:id/active",
              "Toggle active ({ isActive: boolean })"
            ],
            [
              "DELETE",
              "/compliance/scan-schedules/:id",
              "Deactivate schedule"
            ]
          ]
        },
        {
          "type": "text",
          "content": "Cron expressions use standard 5-field format (minute hour dayOfMonth month dayOfWeek). Examples: 0 * * * * (hourly), /15  * * * (every 15 min), 0 6 * * 1 (Monday 6am)."
        },
        {
          "type": "text",
          "content": "Validation"
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
              "/compliance/validate/plugin",
              "Validate plugin attributes (blocking)"
            ],
            [
              "POST",
              "/compliance/validate/pipeline",
              "Validate pipeline attributes (blocking)"
            ],
            [
              "POST",
              "/compliance/validate/plugin/dry-run",
              "Pre-flight check (no audit/notification)"
            ],
            [
              "POST",
              "/compliance/validate/pipeline/dry-run",
              "Pre-flight check (no audit/notification)"
            ]
          ]
        },
        {
          "type": "text",
          "content": "Policies"
        },
        {
          "type": "text",
          "content": "Policies are named groups of rules (e.g. SOC2, Security Baseline) so a team can manage a whole compliance standard as one unit."
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
              "/compliance/policies",
              "List policies (filterable, paginated)"
            ],
            [
              "GET",
              "/compliance/policies/:id",
              "Get policy by ID"
            ],
            [
              "POST",
              "/compliance/policies",
              "Create policy"
            ],
            [
              "PUT",
              "/compliance/policies/:id",
              "Update policy"
            ],
            [
              "DELETE",
              "/compliance/policies/:id",
              "Delete policy"
            ]
          ]
        },
        {
          "type": "text",
          "content": "Exemptions"
        },
        {
          "type": "text",
          "content": "Exemptions waive a specific rule for a specific entity, with an approval workflow so the waiver is auditable."
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
              "/compliance/exemptions",
              "List exemptions (filterable)"
            ],
            [
              "POST",
              "/compliance/exemptions",
              "Request an exemption for a rule + entity"
            ],
            [
              "POST",
              "/compliance/exemptions/bulk",
              "Request exemptions for multiple entities"
            ],
            [
              "PUT",
              "/compliance/exemptions/:id/review",
              "Approve or reject an exemption"
            ],
            [
              "DELETE",
              "/compliance/exemptions/:id",
              "Revoke an exemption"
            ]
          ]
        },
        {
          "type": "text",
          "content": "Templates & Audit"
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
              "/compliance/templates",
              "List built-in rule templates"
            ],
            [
              "POST",
              "/compliance/templates/apply",
              "Instantiate a template as an org rule"
            ],
            [
              "GET",
              "/compliance/audit",
              "Query the audit log (filterable by target, result, entity)"
            ]
          ]
        },
        {
          "type": "text",
          "content": "Notification Preferences"
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
              "/compliance/notification-preferences",
              "The calling org's notification preference (column defaults when unset)"
            ],
            [
              "PUT",
              "/compliance/notification-preferences",
              "Upsert the preference (org admin / owner only)"
            ]
          ]
        },
        {
          "type": "text",
          "content": "The webhook signing secret is never returned — reads expose only a hasWebhookSecret flag. On PUT, omit webhookSecret to keep the existing one; send \"\" to clear it."
        }
      ]
    },
    {
      "id": "rule-schema",
      "title": "Rule Schema",
      "blocks": [
        {
          "type": "table",
          "headers": [
            "Field",
            "Type",
            "Description"
          ],
          "rows": [
            [
              "name",
              "string",
              "Unique name within the org"
            ],
            [
              "target",
              "plugin \\",
              "pipeline",
              "Entity type"
            ],
            [
              "severity",
              "warning \\",
              "error \\",
              "critical",
              "warning = non-blocking; error/critical = blocking"
            ],
            [
              "field",
              "string",
              "Attribute to check (supports dot-notation and $count(), $length())"
            ],
            [
              "operator",
              "enum",
              "One of the operators below"
            ],
            [
              "value",
              "any",
              "Expected value"
            ],
            [
              "priority",
              "0–10000",
              "Higher = evaluated first"
            ],
            [
              "scope",
              "org \\",
              "published",
              "See Scopes"
            ],
            [
              "tags",
              "string[]",
              "Categorization (e.g. [\"security\"])"
            ],
            [
              "conditions",
              "array",
              "Multi-field rules (see Conditions)"
            ],
            [
              "conditionMode",
              "all \\",
              "any",
              "How conditions combine"
            ]
          ]
        },
        {
          "type": "text",
          "content": "Operators"
        },
        {
          "type": "table",
          "headers": [
            "Operator",
            "Description"
          ],
          "rows": [
            [
              "eq / neq",
              "Equals / not equals"
            ],
            [
              "gt / gte / lt / lte",
              "Numeric comparison"
            ],
            [
              "contains / notContains",
              "String or array contains"
            ],
            [
              "in / notIn",
              "Value in set"
            ],
            [
              "regex",
              "Pattern match (pattern length capped, default 100 chars; configurable via COMPLIANCE_MAX_REGEX_LENGTH)"
            ],
            [
              "exists / notExists",
              "Field presence"
            ],
            [
              "notEmpty",
              "Field present and not empty ('', 0, false count as empty)"
            ],
            [
              "countGt / countLt",
              "Array/object count"
            ],
            [
              "lengthGt / lengthLt",
              "String length"
            ]
          ]
        },
        {
          "type": "text",
          "content": "Computed Fields"
        },
        {
          "type": "table",
          "headers": [
            "Function",
            "Example"
          ],
          "rows": [
            [
              "$count(field)",
              "$count(stages) — array length"
            ],
            [
              "$length(field)",
              "$length(name) — string length"
            ],
            [
              "$keys(field)",
              "$keys(env) — object keys as array"
            ],
            [
              "$lines(field)",
              "$lines(dockerfile) — line count"
            ]
          ]
        },
        {
          "type": "text",
          "content": "Cross-Field Conditions"
        },
        {
          "type": "code",
          "content": "{\n  \"name\": \"codebuild-timeout-limit\",\n  \"target\": \"plugin\",\n  \"severity\": \"error\",\n  \"conditions\": [\n    { \"field\": \"pluginType\", \"operator\": \"eq\", \"value\": \"CodeBuildStep\" },\n    { \"field\": \"timeout\", \"operator\": \"lte\", \"value\": 900 }\n  ],\n  \"conditionMode\": \"all\"\n}",
          "language": "json"
        },
        {
          "type": "text",
          "content": "A condition can also depend on another rule via dependsOnRule — the rule is only evaluated when the referenced rule has passed, letting you chain rules conditionally."
        }
      ]
    },
    {
      "id": "scopes",
      "title": "Scopes",
      "blocks": [
        {
          "type": "table",
          "headers": [
            "Scope",
            "Created By",
            "Enforcement"
          ],
          "rows": [
            [
              "org",
              "Any org",
              "Owning org only"
            ],
            [
              "published",
              "System org",
              "Orgs that subscribe (opt-in)"
            ]
          ]
        },
        {
          "type": "text",
          "content": "Org rules: Any organization can create its own rules with scope: \"org\" (the default). These are private to that org — fully owned, editable, and deletable by the org. No other org can see or be affected by them."
        },
        {
          "type": "text",
          "content": "Published rules: Only the system org can create rules with scope: \"published\". These appear in the published catalog for teams to browse and subscribe to. Subscriptions start inactive — the team explicitly activates the ones they want enforced. Subscribed rules can be exempted per-entity, giving teams full control over their compliance posture."
        }
      ]
    },
    {
      "id": "curated-content-add-ons-standard-advanced",
      "title": "Curated content add-ons (Standard / Advanced)",
      "blocks": [
        {
          "type": "text",
          "content": "The published catalog includes two curated content libraries sold as billing add-ons. They monetize the content — expert-maintained rule sets — while rule authoring stays free for every tier (see below). Both are ordinary published rules under the system org, tagged by set (set:standard / set:advanced), gated by a feature flag."
        },
        {
          "type": "table",
          "headers": [
            "Add-on",
            "Feature flag",
            "Content",
            "Price",
            "Availability"
          ],
          "rows": [
            [
              "Standard Compliance",
              "compliance_standard",
              "One \"CI/CD Best Practices\" policy — a curated library (~20 rules) of CI/CD guardrails (require review stage, no hardcoded secrets, artifact retention, resource limits, pinned deps, …)",
              "$29.90 / mo · $299 / yr",
              "Buy on Developer / Pro / Team · included in Enterprise / Unlimited"
            ],
            [
              "Advanced Compliance",
              "compliance_advanced",
              "Three framework policies — SOC2, PCI-DSS, CIS (~75 rules total), each rule tagged with its framework control id — requires Standard",
              "$99.90 / mo · $999 / yr",
              "Buy on Developer / Pro / Team (requires Standard, or buy the Suite) · included in Enterprise / Unlimited"
            ],
            [
              "Compliance Suite (combo)",
              "both",
              "Standard + Advanced together, 30% off",
              "$90.86 / mo · $908.60 / yr",
              "Buy on Developer / Pro / Team (grants both at once)"
            ]
          ]
        },
        {
          "type": "text",
          "content": "Advanced requires Standard. Buy Standard, then add Advanced — or buy the Compliance Suite combo to get both in one action (also the way to obtain Advanced without a separate Standard line). Cancelling Standard while Advanced is held cascade-cancels Advanced. Enterprise / Unlimited include both, so nothing is purchased there. See Billing Add-on Bundles for pricing and the combo mechanics."
        },
        {
          "type": "text",
          "content": "Content is a shared reference, not a per-org copy"
        },
        {
          "type": "text",
          "content": "Buying an add-on adds zero content to your org — it grants access to the shared library:"
        },
        {
          "type": "list",
          "items": [
            "The curated rules exist once as system-org published rows, seeded at boot.",
            "An org holds a lightweight compliance_rule_subscriptions (orgId, ruleId) pointer — subscribing references the shared rule, it does not copy it. One library of 30 rules serves 10,000 orgs as 30 rules plus pointer rows, not 300,000 copies.",
            "Subscriptions start inactive; only active subscriptions are enforced. Enforcement (/compliance/validate) is entitlement-unaware — it reads the org's active subscriptions (plus the org's own authored rules) and never checks the feature flag directly. The lifecycle below keeps the active set in sync with entitlement.",
            "Fixing a shared rule once updates it for every subscriber (single source of truth). An org that wants to customize a shared rule forks it into an editable org-scoped copy — that's authoring, and it stays free."
          ]
        },
        {
          "type": "text",
          "content": "Entitlement lifecycle (auto-subscribe / deactivate)"
        },
        {
          "type": "text",
          "content": "Entitlement changes drive the subscriptions automatically via a billing → compliance sync leg (PUT /api/compliance/entitlements/:orgId, service-principal-authenticated, body { sets }). It runs on every entitlement change — purchase, cancel, renewal — and via the billing drift reconciler:"
        },
        {
          "type": "list",
          "items": [
            "On gain (purchase or tier inclusion) — the org is auto-subscribed and activated to every rule tagged for each entitled set, so the curated library begins enforcing immediately. No manual subscribe step is needed.",
            "On loss (cancel or downgrade) — the set's subscriptions are deactivated, so those rules stop enforcing. Pointers are retained, so re-buying reactivates them (no re-subscribe).",
            "Cancellation timing: cancel means \"don't renew\" — access persists until the paid period ends, then billing lapses the entitlement and the sync deactivates the set. No mid-cycle revocation, proration, or refund. Enterprise / Unlimited can't cancel an included set; losing it requires a tier downgrade (same deactivation, at the downgrade's effective time)."
          ]
        },
        {
          "type": "text",
          "content": "The reconcile is idempotent — re-pushing the same entitled sets is a no-op — and every activate / deactivate is written to the audit log."
        },
        {
          "type": "text",
          "content": "Authoring stays free"
        },
        {
          "type": "text",
          "content": "These add-ons gate only the curated libraries. Authoring your own rules (compliance:write) is ungated on every tier — any org can create, edit, fork, and enforce its own org-scoped rules regardless of which add-ons it holds. The paid content is the maintained curation and framework coverage, not the ability to write rules."
        }
      ]
    },
    {
      "id": "enforcement",
      "title": "Enforcement",
      "blocks": [
        {
          "type": "table",
          "headers": [
            "Trigger",
            "Behavior"
          ],
          "rows": [
            [
              "Plugin upload (POST /api/plugin/upload)",
              "Blocked (403) if error or critical violations"
            ],
            [
              "Pipeline create (POST /api/pipeline)",
              "Blocked (403) if error or critical violations"
            ]
          ]
        },
        {
          "type": "text",
          "content": "Warnings are logged and returned but do not block. Blocked responses include violation details:"
        },
        {
          "type": "code",
          "content": "{\n  \"success\": false,\n  \"status\": 403,\n  \"code\": \"COMPLIANCE_VIOLATION\",\n  \"details\": {\n    \"violations\": [{ \"ruleName\": \"block-latest-version\", \"severity\": \"error\", \"field\": \"version\" }]\n  }\n}",
          "language": "json"
        }
      ]
    },
    {
      "id": "notifications",
      "title": "Notifications",
      "blocks": [
        {
          "type": "text",
          "content": "When a check blocks an operation (and, opt-in, when it raises non-blocking warnings), the org is notified. Delivery is governed by the per-org compliance_notification_preferences row (see Notification Preferences); an org with no row uses the column defaults."
        },
        {
          "type": "text",
          "content": "Severity gating"
        },
        {
          "type": "list",
          "items": [
            "notifyOnBlock (default on) — notify when an operation is blocked.",
            "notifyOnWarning (default off, opt-in) — also notify on warnings. Warnings only fire when an operation was not blocked (a block notification already carries the actionable signal)."
          ]
        },
        {
          "type": "text",
          "content": "Channels (each delivered through the same fan-out, every attempt recorded in compliance_notification_log):"
        },
        {
          "type": "table",
          "headers": [
            "Channel",
            "When",
            "Notes"
          ],
          "rows": [
            [
              "In-app inbox",
              "Always (when the severity gate passes)",
              "Posted to the org's message inbox"
            ],
            [
              "Email",
              "When emailEnabled",
              "Sent to targetUsers, or all org admins when unset. The platform service owns delivery + recipient resolution (compliance has no mail transport)"
            ],
            [
              "Webhook",
              "When webhookUrl is set",
              "POSTs the notification JSON; signed X-PB-Signature: sha256=<hmac> when webhookSecret is set"
            ]
          ]
        },
        {
          "type": "text",
          "content": "Digest batching — digestMode is immediate (default), daily, or weekly. Under daily/weekly, notifications are parked and a background scheduler aggregates them into a single digest per window. The scheduler uses a Redis leader lock so that with multiple compliance replicas only one pod flushes per window (the scan scheduler is guarded the same way). Tune via DIGEST_SCHEDULER_INTERVAL_MS, DIGEST_LOCK_TTL_MS, and SCAN_LOCK_TTL_MS (see Environment Variables)."
        }
      ]
    },
    {
      "id": "examples",
      "title": "Examples",
      "blocks": [
        {
          "type": "text",
          "content": "Create an org-scoped rule"
        },
        {
          "type": "text",
          "content": "Any org can create its own rules. Scope defaults to \"org\" (private to the creating org):"
        },
        {
          "type": "code",
          "content": "curl -X POST https://localhost:8443/api/compliance/rules \\\n  -H \"Authorization: Bearer $TOKEN\" \\\n  -H \"Content-Type: application/json\" \\\n  -d '{\n    \"name\": \"no-public-plugins\",\n    \"target\": \"plugin\",\n    \"severity\": \"critical\",\n    \"field\": \"visibility\",\n    \"operator\": \"neq\",\n    \"value\": \"public\"\n  }'",
          "language": "bash"
        },
        {
          "type": "text",
          "content": "Dry-run validation"
        },
        {
          "type": "code",
          "content": "curl -X POST https://localhost:8443/api/compliance/validate/plugin/dry-run \\\n  -H \"Authorization: Bearer $TOKEN\" \\\n  -H \"Content-Type: application/json\" \\\n  -d '{\n    \"attributes\": { \"name\": \"my-plugin\", \"visibility\": \"public\", \"version\": \"latest\" }\n  }'",
          "language": "bash"
        },
        {
          "type": "text",
          "content": "Subscribe to a published rule"
        },
        {
          "type": "code",
          "content": "curl -X POST https://localhost:8443/api/compliance/subscriptions \\\n  -H \"Authorization: Bearer $TOKEN\" \\\n  -H \"Content-Type: application/json\" \\\n  -d '{ \"ruleId\": \"<published-rule-id>\" }'",
          "language": "bash"
        }
      ]
    },
    {
      "id": "sample-rules",
      "title": "Sample Rules",
      "blocks": [
        {
          "type": "text",
          "content": "10 sample rules are included in deploy/compliance/rules/, each with a rule.json and README.md:"
        },
        {
          "type": "table",
          "headers": [
            "Rule",
            "Target",
            "Severity"
          ],
          "rows": [
            [
              "require-plugin-description",
              "plugin",
              "warning"
            ],
            [
              "block-latest-image-tag",
              "plugin",
              "error"
            ],
            [
              "require-pipeline-naming-convention",
              "pipeline",
              "warning"
            ],
            [
              "max-pipeline-stages",
              "pipeline",
              "warning"
            ],
            [
              "require-plugin-version-semver",
              "plugin",
              "error"
            ],
            [
              "require-plugin-keywords",
              "plugin",
              "warning"
            ],
            [
              "enforce-pipeline-timeout",
              "pipeline",
              "error"
            ],
            [
              "recommended-compute-type",
              "pipeline",
              "warning"
            ],
            [
              "block-privileged-plugins",
              "plugin",
              "critical"
            ],
            [
              "restrict-public-access",
              "plugin",
              "error"
            ]
          ]
        },
        {
          "type": "text",
          "content": "All sample rules are published scope — teams browse the catalog and subscribe to the ones they want to enforce."
        },
        {
          "type": "text",
          "content": "Five starter policies (named rule groups) ship alongside them in deploy/compliance/policies/: security-baseline, production-readiness, quality-standards, naming-conventions, and cost-optimization. load-compliance.sh loads both the rules and these policy templates."
        },
        {
          "type": "text",
          "content": "Load them during init or standalone:"
        },
        {
          "type": "code",
          "content": "./deploy/bin/init-platform.sh docker                    # prompted during init\nPLATFORM_TOKEN=\"$JWT\" ./deploy/bin/load-compliance.sh   # standalone (rules + policies)",
          "language": "bash"
        },
        {
          "type": "text",
          "content": "Add your own by creating deploy/compliance/rules/<name>/rule.json + README.md."
        }
      ]
    },
    {
      "id": "database-tables",
      "title": "Database Tables",
      "blocks": [
        {
          "type": "table",
          "headers": [
            "Table",
            "Purpose"
          ],
          "rows": [
            [
              "compliance_rules",
              "Rule definitions"
            ],
            [
              "compliance_rule_subscriptions",
              "Org subscriptions to published rules"
            ],
            [
              "compliance_rule_history",
              "Rule change audit trail"
            ],
            [
              "compliance_policies",
              "Named rule groups (SOC2, Security Baseline)"
            ],
            [
              "compliance_audit_log",
              "Every check result (pass/warn/block)"
            ],
            [
              "compliance_exemptions",
              "Per-entity exemptions from rules"
            ],
            [
              "compliance_scans",
              "Bulk scan tracking"
            ],
            [
              "compliance_scan_schedules",
              "Recurring scan schedules"
            ],
            [
              "compliance_notification_preferences",
              "Per-org notification config"
            ],
            [
              "compliance_notification_log",
              "Notification delivery history"
            ],
            [
              "compliance_roles",
              "Compliance RBAC (viewer/editor/admin)"
            ],
            [
              "compliance_reports",
              "Generated reports"
            ],
            [
              "compliance_report_schedules",
              "Recurring report schedules"
            ]
          ]
        }
      ]
    },
    {
      "id": "environment-variables",
      "title": "Environment Variables",
      "blocks": [
        {
          "type": "table",
          "headers": [
            "Variable",
            "Default",
            "Description"
          ],
          "rows": [
            [
              "COMPLIANCE_SERVICE_HOST",
              "compliance",
              "Hostname (used by plugin/pipeline services to reach compliance)"
            ],
            [
              "COMPLIANCE_SERVICE_PORT",
              "3000",
              "Port"
            ],
            [
              "CACHE_TTL_COMPLIANCE_RULES",
              "60",
              "Active rules cache TTL (seconds)"
            ],
            [
              "COMPLIANCE_AUDIT_RETENTION_DAYS",
              "180",
              "Audit log retention (daily prune)"
            ],
            [
              "COMPLIANCE_MAX_REGEX_LENGTH",
              "100",
              "Max length of a user-supplied regex pattern"
            ],
            [
              "COMPLIANCE_MAX_ATTRIBUTE_DEPTH",
              "10",
              "Max nesting depth of entity attributes evaluated"
            ],
            [
              "COMPLIANCE_MAX_ATTRIBUTE_KEYS",
              "100",
              "Max number of attribute keys evaluated"
            ],
            [
              "COMPLIANCE_SCAN_CONCURRENCY",
              "10",
              "Concurrent entities evaluated per bulk scan"
            ],
            [
              "COMPLIANCE_SCAN_PROGRESS_BATCH_SIZE",
              "10",
              "Scan progress flush batch size"
            ],
            [
              "SCAN_SCHEDULER_INTERVAL_MS",
              "60000",
              "Scan scheduler interval (ms)"
            ],
            [
              "SCAN_LOCK_TTL_MS",
              "300000",
              "Scan scheduler cross-pod leader-lock TTL (ms)"
            ],
            [
              "COMPLIANCE_SCAN_STALE_TIMEOUT_MS",
              "7200000",
              "A scan still running after this long is marked failed by the next scheduler sweep (minimum 60000), so a crashed scan can't block rule-change re-scans"
            ],
            [
              "DIGEST_SCHEDULER_INTERVAL_MS",
              "3600000",
              "Notification digest scheduler interval (ms)"
            ],
            [
              "DIGEST_LOCK_TTL_MS",
              "300000",
              "Digest scheduler cross-pod leader-lock TTL (ms)"
            ],
            [
              "REDIS_URL / REDIS_SENTINELS",
              "—",
              "Redis for scheduler leader locks (see environment variables)"
            ],
            [
              "MESSAGE_SERVICE_HOST",
              "message",
              "Message service (in-app notifications)"
            ],
            [
              "PLATFORM_SERVICE_HOST",
              "platform",
              "Platform service (email delivery + recipient resolution)"
            ],
            [
              "PLUGIN_SERVICE_HOST",
              "plugin",
              "Plugin service (bulk scans)"
            ],
            [
              "PIPELINE_SERVICE_HOST",
              "pipeline",
              "Pipeline service (bulk scans)"
            ]
          ]
        }
      ]
    },
    {
      "id": "deployment",
      "title": "Deployment",
      "blocks": [
        {
          "type": "table",
          "headers": [
            "Environment",
            "Configuration"
          ],
          "rows": [
            [
              "Local",
              "deploy/local/docker/docker-compose.yml — compliance service"
            ],
            [
              "Minikube",
              "deploy/local/minikube/k8s/compliance.yaml"
            ],
            [
              "AWS EC2",
              "deploy/aws/ec2/k8s/compliance.yaml"
            ],
            [
              "AWS EKS",
              "deploy/aws/eks/k8s/compliance.yaml"
            ]
          ]
        },
        {
          "type": "text",
          "content": "Nginx proxies /api/compliance to the compliance service in all environments."
        }
      ]
    }
  ],
  "sourceDoc": "docs/compliance.md"
};
