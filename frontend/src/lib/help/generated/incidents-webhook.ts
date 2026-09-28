// GENERATED FROM docs/incidents-webhook.md — DO NOT EDIT.
// Regenerate: npm run generate:help  (see frontend/scripts/generate-help.mjs)
// SOURCE-SHA256: 8cdbd38565e169d298ea8161324fb145651e33eb8f4ff4e01b3d58bf89afe230
// SPDX-License-Identifier: Apache-2.0
import { Siren } from 'lucide-react';
import type { HelpTopic } from '../types';

export const incidentsWebhookTopic: HelpTopic = {
  "icon": Siren,
  "id": "incidents-webhook",
  "title": "Incident Webhook",
  "description": "Point PagerDuty, Datadog or Alertmanager at the platform for automated CFR and MTTR",
  "sections": [
    {
      "id": "overview",
      "title": "Overview",
      "blocks": [
        {
          "type": "text",
          "content": "<!-- Copyright 2026 Pipeline Builder Contributors SPDX-License-Identifier: Apache-2.0 -->"
        },
        {
          "type": "text",
          "content": "Point your existing incident tooling at the platform once, and two DORA metrics fill themselves in."
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
            "Two metrics become automatic. A production incident correlated to a deploy makes that deploy a post-deploy failure (CFR); a resolved incident supplies the real recovery time (MTTR), not a hand-marked one.",
            "The org comes from the token, never the body. A token can only ever file incidents for its own organization.",
            "The webhook token is least-privilege by construction. The reporting:ingest scope forces role=member with no features or permissions, so even an admin's webhook token can only file incidents.",
            "Idempotent on (org, incidentId). The normal flow is two POSTs — open, then resolve — and retries or at-least-once deliveries are safe.",
            "Alertmanager has a native adapter. It posts a batched payload, so there is a second route that reshapes the batch into one incident per alert. No external relay needed.",
            "An incident with no eligible deploy in the window is not attributed — it contributes nothing to CFR or MTTR, because it can't be blamed on a specific deploy.",
            "The test button is a dry-run. It checks your wiring without writing an incident or moving a metric.",
            "environment must match the deploy stage. This is the single most common wiring mistake."
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
          "content": "The incident webhook turns PagerDuty, Datadog, Opsgenie, in-cluster Alertmanager — or any system that can POST JSON — into an automated source of Change Failure Rate and Mean Time To Restore."
        },
        {
          "type": "table",
          "headers": [
            "Metric",
            "What an incident supplies"
          ],
          "rows": [
            [
              "Change Failure Rate (CFR)",
              "A production incident correlated to a deploy makes that deploy a post-deploy failure."
            ],
            [
              "Mean Time To Restore (MTTR)",
              "A resolved incident gives the real recovery time (resolved_at − opened_at)."
            ]
          ]
        },
        {
          "type": "text",
          "content": "The manual post-deploy outcomes path still works and is deduped against incidents, so you can stop clicking Mark failed / Mark restored without losing what you already marked."
        },
        {
          "type": "note",
          "content": "Incident data only surfaces through DORA, which is an advanced_reporting feature (Enterprise, or the Advanced Reporting add-on). Ingesting incidents without the entitlement is harmless — they are stored but never shown."
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
            "Your tool POSTs an incident to /api/reports/incidents with a reporting:ingest bearer token, on incident open.",
            "The org is resolved from the token identity. The request body cannot name an organization.",
            "The incident is upserted on (org, incidentId). A second POST with the same id updates it in place rather than creating a duplicate.",
            "Your tool POSTs again on resolve, same incidentId, now carrying resolvedAt.",
            "Correlation runs. The incident is attributed to the most recent successful deploy to its environment whose completed_at ≤ openedAt, within the correlation window.",
            "DORA reads it. That deploy becomes a post-deploy failure, and a resolved incident supplies the MTTR gap."
          ]
        }
      ]
    },
    {
      "id": "configuration",
      "title": "Configuration",
      "blocks": [
        {
          "type": "text",
          "content": "1. Mint a token"
        },
        {
          "type": "text",
          "content": "The webhook token is an access key scoped to reporting:ingest — org-bound and least-privilege."
        },
        {
          "type": "text",
          "content": "Admin UI (recommended) — Settings → Incident Reporting → Webhook token → Generate webhook token."
        },
        {
          "type": "text",
          "content": "It asks you to re-confirm your identity, either with your password or a fresh sign-in with your provider (step-up), and shows the key once. Copy it immediately — only its hash is stored."
        },
        {
          "type": "text",
          "content": "To rotate: generate a new one and revoke the old key on the Security → Access keys settings page. The old one stops working within five minutes."
        },
        {
          "type": "text",
          "content": "Under the hood this is POST /api/user/keys with { scope: \"reporting:ingest\" }."
        },
        {
          "type": "text",
          "content": "CLI — for the in-AWS-account event forwarder credential, which is a service-account key stored in Secrets Manager with daily rotation:"
        },
        {
          "type": "code",
          "content": "pipeline-manager infra store-token --scope reporting:ingest",
          "language": "bash"
        },
        {
          "type": "text",
          "content": "See Onboarding → store the service-account keys."
        },
        {
          "type": "text",
          "content": "2. Set the correlation window, if the default doesn't fit"
        },
        {
          "type": "text",
          "content": "The window defaults to DORA_INCIDENT_WINDOW_HOURS (24) on the reporting service, and an org admin can override it per-org (1–720 hours) in the Admin UI or via the endpoint — see Per-org correlation window."
        },
        {
          "type": "text",
          "content": "3. Point your tool at the endpoint"
        },
        {
          "type": "text",
          "content": "Configure a webhook or notification integration that fires on incident open and resolve. See Point your tool here for per-vendor walkthroughs."
        },
        {
          "type": "text",
          "content": "Set an environment that matches the environment you declared on the deploy stage. This is what correlation joins on."
        },
        {
          "type": "text",
          "content": "4. Verify before relying on it"
        },
        {
          "type": "text",
          "content": "Use Send test incident in the Admin UI, or POST /api/reports/incidents/test. It is a non-persisting dry-run, so it proves the wiring without writing anything."
        }
      ]
    },
    {
      "id": "authentication",
      "title": "Authentication",
      "blocks": [
        {
          "type": "text",
          "content": "The endpoint is a machine endpoint, authorized by the reporting:ingest token scope — the same org-scoped credential the event forwarder holds. The org is taken from the token identity, never from the request body, so a token can only file incidents for its own organization."
        },
        {
          "type": "text",
          "content": "Send the token as a bearer credential:"
        },
        {
          "type": "code",
          "content": "Authorization: Bearer <reporting:ingest-scoped token>"
        },
        {
          "type": "text",
          "content": "Getting a token (self-serve)"
        },
        {
          "type": "text",
          "content": "See Configuration step 1 above for both the Admin UI and CLI paths."
        }
      ]
    },
    {
      "id": "contract",
      "title": "Contract",
      "blocks": [
        {
          "type": "code",
          "content": "POST /api/reports/incidents\nContent-Type: application/json\nAuthorization: Bearer <token>"
        },
        {
          "type": "table",
          "headers": [
            "Field",
            "Type",
            "Required",
            "Notes"
          ],
          "rows": [
            [
              "incidentId",
              "string (≤255)",
              "yes",
              "Your incident tool's stable id. Unique per org — the idempotency key."
            ],
            [
              "environment",
              "string (≤255)",
              "yes",
              "The affected deploy environment (e.g. production). Must match the environment you declared on the deploy stage."
            ],
            [
              "openedAt",
              "ISO 8601 (offset)",
              "yes",
              "When the incident opened. Used for deploy correlation."
            ],
            [
              "resolvedAt",
              "ISO 8601 (offset)",
              "no",
              "When it resolved. Omit for an open incident; send a follow-up POST to set it."
            ],
            [
              "severity",
              "string (≤50)",
              "yes",
              "Free-form (critical, P1, warning, …)."
            ]
          ]
        },
        {
          "type": "text",
          "content": "Example:"
        },
        {
          "type": "code",
          "content": "{\n  \"incidentId\": \"PD-4821\",\n  \"environment\": \"production\",\n  \"openedAt\": \"2026-08-20T14:05:00Z\",\n  \"resolvedAt\": \"2026-08-20T14:52:00Z\",\n  \"severity\": \"critical\"\n}",
          "language": "json"
        },
        {
          "type": "text",
          "content": "Response: 200 with { \"data\": { \"incidentId\": \"PD-4821\", \"ok\": true } }."
        },
        {
          "type": "table",
          "headers": [
            "Failure",
            "Response"
          ],
          "rows": [
            [
              "Validation failure",
              "400 VALIDATION_ERROR"
            ],
            [
              "Token without the reporting:ingest scope",
              "403"
            ]
          ]
        }
      ]
    },
    {
      "id": "idempotency",
      "title": "Idempotency",
      "blocks": [
        {
          "type": "text",
          "content": "Incidents are keyed on (org, incidentId). Posting the same incidentId again is an upsert, not a duplicate. The typical flow is two POSTs:"
        },
        {
          "type": "list",
          "items": [
            "On open — openedAt set, resolvedAt omitted.",
            "On resolve — the same incidentId with resolvedAt now populated."
          ]
        },
        {
          "type": "text",
          "content": "The resolve POST updates resolvedAt, and any other changed fields, in place. Retries and at-least-once webhook deliveries are therefore safe."
        }
      ]
    },
    {
      "id": "correlation-window",
      "title": "Correlation window",
      "blocks": [
        {
          "type": "text",
          "content": "Each incident is attributed to the most recent successful deploy to its environment whose completed_at ≤ openedAt, within DORA_INCIDENT_WINDOW_HOURS (default 24, configurable on the reporting service). That deploy becomes a post-deploy failure and, if the incident resolves, supplies the MTTR gap."
        },
        {
          "type": "list",
          "items": [
            "An incident with no eligible deploy in the window is not attributed, and contributes nothing to CFR or MTTR — it can't be blamed on a specific deploy.",
            "The window boundary is inclusive: exactly 24h correlates, one second past does not.",
            "Dedup. If a deploy is flagged by both an incident and a manual failed outcome, it counts as one post-deploy failure, and the incident takes precedence for MTTR."
          ]
        },
        {
          "type": "text",
          "content": "Per-org correlation window"
        },
        {
          "type": "text",
          "content": "An org admin can override the window per-org (1–720 hours), in the Admin UI or via the endpoint:"
        },
        {
          "type": "code",
          "content": "GET  /api/reports/settings/incidents      # read { incidentWindowHours, defaultWindowHours,\n                                          #        eventRetentionDays, doraRetentionDays,\n                                          #        defaultEventRetentionDays, defaultDoraRetentionDays }\nPUT  /api/reports/settings/incidents      # any subset of { \"incidentWindowHours\": 12,\n                                          #   \"eventRetentionDays\": 45, \"doraRetentionDays\": 200 }"
        },
        {
          "type": "text",
          "content": "Both require reports:read + advanced_reporting; the PUT additionally requires the org-admin org:settings permission."
        },
        {
          "type": "text",
          "content": "The PUT is a partial upsert — send any subset, and omitted fields are left unchanged. When set, the correlation-window override is used everywhere the correlation runs: DORA CFR/MTTR, the incidents list, and the test dry-run. When unset, the env default applies."
        },
        {
          "type": "text",
          "content": "The same endpoint carries the two retention overrides (eventRetentionDays / doraRetentionDays, 1–730 days) — see DORA Metrics → Retention."
        }
      ]
    },
    {
      "id": "alertmanager-adapter-native",
      "title": "Alertmanager adapter (native)",
      "blocks": [
        {
          "type": "text",
          "content": "In-cluster Prometheus Alertmanager posts a batched payload ({status, alerts:[…]}), a different shape from the generic contract. Point a webhook_config receiver at the native adapter instead, and it reshapes the batch into one incident per alert:"
        },
        {
          "type": "code",
          "content": "POST /api/reports/incidents/alertmanager\nAuthorization: Bearer <reporting:ingest token>"
        },
        {
          "type": "text",
          "content": "Mapping, per alert:"
        },
        {
          "type": "table",
          "headers": [
            "Incident field",
            "From"
          ],
          "rows": [
            [
              "incidentId",
              "alert fingerprint (falls back to the payload groupKey)"
            ],
            [
              "environment",
              "the environment label (override the label name with ?environmentLabel=<label>)"
            ],
            [
              "severity",
              "the severity label (defaults to unknown)"
            ],
            [
              "openedAt",
              "startsAt"
            ],
            [
              "resolvedAt",
              "endsAt, only when the alert status is resolved (Alertmanager's \"no end\" zero value is ignored)"
            ]
          ]
        },
        {
          "type": "text",
          "content": "Same reporting:ingest auth and idempotent (org, incidentId) upsert as the generic route."
        },
        {
          "type": "text",
          "content": "Alerts missing an environment label, a stable fingerprint, or a valid startsAt are skipped, and the response reports { received, ingested, skipped }. Set an environment label on your alerting rules that matches the environment you declared on the deploy stage."
        }
      ]
    },
    {
      "id": "point-your-tool-here",
      "title": "Point your tool here",
      "blocks": [
        {
          "type": "text",
          "content": "Every walkthrough below sets Authorization: Bearer <token> and Content-Type: application/json, targeting POST /api/reports/incidents and mapping the tool's fields to the contract."
        },
        {
          "type": "text",
          "content": "Alertmanager"
        },
        {
          "type": "text",
          "content": "Use the native adapter — point a receiver's webhook_configs.url at the adapter path. No body mapping is needed beyond the environment and severity labels, and firing/resolved is taken from Alertmanager's own status."
        },
        {
          "type": "text",
          "content": "PagerDuty"
        },
        {
          "type": "list",
          "items": [
            "Integrations → Generic Webhooks (v3) → New Webhook, or an Events/Webhook v3 subscription.",
            "Webhook URL = <PLATFORM_BASE_URL>/api/reports/incidents; add a Custom Header Authorization: Bearer <token>.",
            "Subscribe to incident.triggered and incident.resolved.",
            "Use a custom payload template to emit the contract: incident.id → incidentId, incident.created_at → openedAt, incident.resolved_at → resolvedAt (omit while open), incident.priority / urgency → severity, and a fixed or service-derived environment."
          ]
        },
        {
          "type": "text",
          "content": "Datadog"
        },
        {
          "type": "list",
          "items": [
            "Integrations → Webhooks → New — set URL = <PLATFORM_BASE_URL>/api/reports/incidents and add the Authorization: Bearer <token> header.",
            "Define the Payload with the contract fields using Datadog variables: $ALERT_ID → incidentId, $DATE / $LAST_UPDATED → openedAt / resolvedAt, and a literal environment or a tag template.",
            "On each monitor that represents production health, add @webhook-<name> to the message, and send resolvedAt only when $ALERT_TRANSITION is a recovery. Tag the monitor with the environment."
          ]
        },
        {
          "type": "text",
          "content": "Opsgenie"
        },
        {
          "type": "list",
          "items": [
            "Settings → Integrations → Add → Webhook.",
            "Webhook URL = <PLATFORM_BASE_URL>/api/reports/incidents; add the Authorization: Bearer <token> header; enable Add Alert Description to Payload as needed.",
            "Enable the Alert Created and Alert Closed notifications, and map the alert's stable id → incidentId, timestamps → openedAt / resolvedAt, priority → severity, plus an environment."
          ]
        },
        {
          "type": "text",
          "content": "Anything else"
        },
        {
          "type": "text",
          "content": "Any tool that can POST JSON works — map its stable alert id, open and resolve timestamps, environment and severity to the generic contract, and send the bearer token. Use the Send test incident button to verify the wiring before relying on it."
        }
      ]
    },
    {
      "id": "admin-ui",
      "title": "Admin UI",
      "blocks": [
        {
          "type": "text",
          "content": "Settings → Incident Reporting (org-admin; gated on advanced_reporting) is the self-serve setup surface. It shows:"
        },
        {
          "type": "list",
          "items": [
            "the webhook URLs — generic plus the Alertmanager adapter path;",
            "the generate/rotate flow for the per-org reporting:ingest token, shown once;",
            "provider presets (Alertmanager / PagerDuty / Datadog / generic) with copy-paste setup steps and the required environment mapping;",
            "the per-org correlation window input;",
            "the Retention inputs — standard-event and DORA-source windows; see DORA Metrics → Retention;",
            "a Send test incident button;",
            "the recent incidents list."
          ]
        },
        {
          "type": "text",
          "content": "Test + list endpoints"
        },
        {
          "type": "code",
          "content": "POST /api/reports/incidents/test            # { \"environment\"?: \"production\" }\nGET  /api/reports/incidents?limit=&offset=  # recent incidents + correlation, paginated"
        },
        {
          "type": "text",
          "content": "Both require reports:read + advanced_reporting, and are org-admin surfaces."
        },
        {
          "type": "list",
          "items": [
            "Test is a non-persisting dry-run: it reports whether a synthetic incident opening now for environment would correlate to a recent successful deploy under the org's window. A wiring and config check that does not write an incident or affect metrics. Returns { environment, openedAt, windowHours, correlated, executionId, deployCompletedAt }.",
            "List returns recent incidents newest-first, each with its resolved state and its correlated deploy (correlatedExecutionId / deployCompletedAt, or null)."
          ]
        }
      ]
    },
    {
      "id": "related",
      "title": "Related",
      "blocks": [
        {
          "type": "list",
          "items": [
            "DORA Metrics — how CFR and MTTR consume incidents",
            "Post-deploy outcomes — the manual mark-failed/restored path, deduped against incidents",
            "Onboarding — creating and storing the reporting:ingest service token",
            "Roles & Permissions — how permissions differ from the machine-token scopes this endpoint uses",
            "Billing Bundles — the Advanced Reporting add-on that surfaces this data"
          ]
        }
      ]
    }
  ],
  "sourceDoc": "docs/incidents-webhook.md"
};
