// GENERATED FROM docs/incidents-webhook.md — DO NOT EDIT.
// Regenerate: npm run generate:help  (see frontend/scripts/generate-help.mjs)
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
          "content": "The incident webhook turns your existing incident tooling (PagerDuty, Datadog, Opsgenie, in-cluster Alertmanager, or any system that can POST JSON) into an automated source of two DORA metrics:"
        },
        {
          "type": "list",
          "items": [
            "Change Failure Rate (CFR) — a production incident correlated to a deploy makes that deploy a post-deploy failure.",
            "Mean Time To Restore (MTTR) — a resolved incident supplies the real recovery time (resolved_at − opened_at), rather than a manually-marked one."
          ]
        },
        {
          "type": "text",
          "content": "Point your incident tool at POST /api/reports/incidents once, and DORA fills in CFR + MTTR automatically — no more clicking Mark failed / Mark restored by hand (the manual post-deploy outcomes path still works and is deduped against incidents)."
        },
        {
          "type": "note",
          "content": "Incident data only surfaces through DORA, which is an advanced_reporting feature (Enterprise, or the Advanced Reporting add-on). Ingesting incidents without the entitlement is harmless — they're stored but never shown."
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
          "content": "The webhook token is an access key scoped to reporting:ingest — org-bound and least-privilege (the scope forces role=member with no features/permissions, so even an admin's webhook token can only file incidents). Two ways to mint one:"
        },
        {
          "type": "list",
          "items": [
            "Admin UI (recommended) — **Settings → Incident Reporting → Webhook token →"
          ]
        },
        {
          "type": "text",
          "content": "Generate webhook token. It asks you to re-confirm your identity — password, or a fresh sign-in with your provider (step-up) — and shows the key once — copy it immediately, since only its hash is stored. To rotate: generate a new one and revoke the old key on the Security → Access keys** settings page; the old one stops working within five minutes. (Under the hood this is POST /api/user/keys with { scope: \"reporting:ingest\" }.)"
        },
        {
          "type": "list",
          "items": [
            "CLI — for the in-AWS-account event forwarder credential (a"
          ]
        },
        {
          "type": "text",
          "content": "service-account key stored in Secrets Manager with daily rotation), use pipeline-manager infra store-token --scope reporting:ingest. See Onboarding → store the service-account keys."
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
          "content": "Response: 200 { \"data\": { \"incidentId\": \"PD-4821\", \"ok\": true } }. Validation failures return 400 VALIDATION_ERROR; a token without the reporting:ingest scope returns 403."
        }
      ]
    },
    {
      "id": "idempotency",
      "title": "Idempotency",
      "blocks": [
        {
          "type": "text",
          "content": "Incidents are keyed on (org, incidentId). Posting the same incidentId again is an upsert, not a duplicate — the typical flow is two POSTs:"
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
          "content": "The resolve POST updates resolvedAt (and any changed fields) in place. Retries and at-least-once webhook deliveries are therefore safe."
        }
      ]
    },
    {
      "id": "correlation-window",
      "title": "Correlation window",
      "blocks": [
        {
          "type": "text",
          "content": "Each incident is attributed to the most recent successful deploy to its environment whose completed_at ≤ openedAt, within DORA_INCIDENT_WINDOW_HOURS (default 24, configurable on the reporting service). That deploy becomes a post-deploy failure, and — if the incident resolves — supplies the MTTR gap."
        },
        {
          "type": "list",
          "items": [
            "An incident with no eligible deploy in the window is not attributed (it contributes nothing to CFR/MTTR) — it can't be blamed on a specific deploy.",
            "The window boundary is inclusive (exactly 24h correlates; one second past does not).",
            "Dedup: if a deploy is flagged by both an incident and a manual failed outcome, it counts as one post-deploy failure, and the incident takes precedence for MTTR."
          ]
        },
        {
          "type": "text",
          "content": "Per-org correlation window"
        },
        {
          "type": "text",
          "content": "The window defaults to DORA_INCIDENT_WINDOW_HOURS (24) on the reporting service, but an org admin can override it per-org (1–720 hours) — in the Admin UI or via the endpoint:"
        },
        {
          "type": "code",
          "content": "GET  /api/reports/settings/incidents      # read { incidentWindowHours, defaultWindowHours,\n                                          #        eventRetentionDays, doraRetentionDays,\n                                          #        defaultEventRetentionDays, defaultDoraRetentionDays }\nPUT  /api/reports/settings/incidents       # any subset of { \"incidentWindowHours\": 12,\n                                          #   \"eventRetentionDays\": 45, \"doraRetentionDays\": 200 }"
        },
        {
          "type": "text",
          "content": "Both require reports:read + advanced_reporting; the PUT additionally requires the org-admin org:settings permission. The PUT is a partial upsert — send any subset; omitted fields are left unchanged. When set, the correlation-window override is used everywhere the correlation runs (DORA CFR/MTTR, the incidents list, and the test dry-run); when unset, the env default applies. The same endpoint carries the two retention overrides (eventRetentionDays / doraRetentionDays, 1–730 days) — see DORA Metrics → Retention."
        }
      ]
    },
    {
      "id": "alertmanager-adapter-native",
      "title": "Alertmanager adapter (native)",
      "blocks": [
        {
          "type": "text",
          "content": "In-cluster Prometheus Alertmanager posts a batched payload ({status, alerts:[…]}) — a different shape than the generic contract. Point a webhook_config receiver at the native adapter instead, and it reshapes the batch into one incident per alert:"
        },
        {
          "type": "code",
          "content": "POST /api/reports/incidents/alertmanager\nAuthorization: Bearer <reporting:ingest token>"
        },
        {
          "type": "text",
          "content": "Mapping (per alert):"
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
          "content": "Same reporting:ingest auth + idempotent (org, incidentId) upsert as the generic route. Alerts missing an environment label, a stable fingerprint, or a valid startsAt are skipped (the response reports { received, ingested, skipped }). Set an environment label on your alerting rules that matches the environment you declared on the deploy stage. No external relay is needed."
        }
      ]
    },
    {
      "id": "point-your-tool-here",
      "title": "Point your tool here",
      "blocks": [
        {
          "type": "text",
          "content": "Configure a webhook / notification integration that fires on incident open and resolve, targeting POST /api/reports/incidents with the reporting:ingest bearer token and mapping your tool's fields to the contract. The walkthroughs below all set Authorization: Bearer <token> and Content-Type: application/json."
        },
        {
          "type": "text",
          "content": "Alertmanager"
        },
        {
          "type": "text",
          "content": "Use the native adapter — point a receiver's webhook_configs.url at the adapter path; no body mapping is needed beyond the environment/severity labels, and firing/resolved is taken from Alertmanager's own status."
        },
        {
          "type": "text",
          "content": "PagerDuty"
        },
        {
          "type": "list",
          "items": [
            "Integrations → Generic Webhooks (v3) → New Webhook (or an Events/Webhook v3 subscription).",
            "Webhook URL = <PLATFORM_BASE_URL>/api/reports/incidents; add a Custom Header Authorization: Bearer <token>.",
            "Subscribe to incident.triggered and incident.resolved events.",
            "Use a custom payload template to emit the contract: incident.id → incidentId, incident.created_at → openedAt, incident.resolved_at → resolvedAt (omit while open), incident.priority/urgency → severity, and a fixed/service-derived environment."
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
            "Define the Payload with the contract fields using Datadog variables: $ALERT_ID → incidentId, $DATE/$LAST_UPDATED → openedAt/resolvedAt, and a literal environment (or a tag template).",
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
            "Enable the Alert Created and Alert Closed notifications, and map the alert's stable id → incidentId, timestamps → openedAt/resolvedAt, priority → severity, plus an environment."
          ]
        },
        {
          "type": "text",
          "content": "Anything else"
        },
        {
          "type": "text",
          "content": "Any tool that can POST JSON works — map its stable alert id, open/resolve timestamps, environment, and severity to the generic contract and send the bearer token. Use the Send test incident button to verify the wiring before relying on it."
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
            "the webhook URLs (generic + the Alertmanager adapter path);",
            "the generate/rotate flow for the per-org reporting:ingest token (shown once);",
            "provider presets (Alertmanager / PagerDuty / Datadog / generic) with copy-paste setup steps + the required environment mapping;",
            "the per-org correlation window input;",
            "the Retention inputs (standard-event + DORA-source windows — see DORA Metrics → Retention);",
            "a Send test incident button (see below);",
            "the recent incidents list."
          ]
        },
        {
          "type": "text",
          "content": "Test + list endpoints"
        },
        {
          "type": "code",
          "content": "POST /api/reports/incidents/test           # { \"environment\"?: \"production\" }\nGET  /api/reports/incidents?limit=&offset=  # recent incidents + correlation, paginated"
        },
        {
          "type": "text",
          "content": "Both require reports:read + advanced_reporting (org-admin surfaces)."
        },
        {
          "type": "list",
          "items": [
            "Test is a non-persisting dry-run: it reports whether a synthetic incident"
          ]
        },
        {
          "type": "text",
          "content": "opening now for environment would correlate to a recent successful deploy under the org's window — a wiring/config check that does not write an incident or affect metrics. Returns { environment, openedAt, windowHours, correlated, executionId, deployCompletedAt }."
        },
        {
          "type": "list",
          "items": [
            "List returns recent incidents newest-first, each with its resolved state and"
          ]
        },
        {
          "type": "text",
          "content": "its correlated deploy (correlatedExecutionId / deployCompletedAt, or null)."
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
            "DORA Metrics — how CFR + MTTR consume incidents",
            "Post-deploy outcomes — the manual mark-failed/restored path (deduped against incidents)",
            "Onboarding — creating + storing the reporting:ingest service token",
            "Roles & Permissions — how permissions differ from the machine-token scopes (reporting:ingest) this endpoint uses"
          ]
        }
      ]
    }
  ],
  "sourceDoc": "docs/incidents-webhook.md"
};
