// GENERATED FROM docs/oncall-paging.md — DO NOT EDIT.
// Regenerate: npm run generate:help  (see frontend/scripts/generate-help.mjs)
// SOURCE-SHA256: de34947bf185e41d7e74a88876a68473420225a5c77972e14049c6ddd6e426b6
// SPDX-License-Identifier: Apache-2.0
import { BellRing } from 'lucide-react';
import type { HelpTopic } from '../types';

export const oncallPagingTopic: HelpTopic = {
  "icon": BellRing,
  "id": "oncall-paging",
  "title": "On-call Paging",
  "description": "Wake a human for support criticals — PagerDuty Events v2, the enable knob, and the alerts about alert delivery itself",
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
          "content": "Wakes a human when support criticals fire, through PagerDuty's Events API v2. Off by default (ONCALL_ENABLED)."
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
            "It exists for one promise. Premium support sells a first response \"within 8 hours, any day\" — the only response target with no business-hours exemption, so its clock runs through nights and weekends. Everything else critical is an availability problem a Slack channel handles well enough until Monday.",
            "Narrow on purpose. Only severity: critical + component: support, plus the alerts about alert delivery itself. The fastest way to make a pager ignored is to let it fire for things nobody is contractually on the hook for.",
            "Alertmanager points at the product, not at PagerDuty. That is what lets the feature be switched off without a second copy of the config, and it is why a disabled deployment accumulates no notification failures.",
            "No rota lives here. PagerDuty owns the schedule, escalation, contact methods and their verification. The product owns the trigger, because it knows something PagerDuty cannot: a case's exact response_due_at.",
            "The credential is a per-service integration key, not a REST API key — it can create events on one service and nothing else. Reading the rota needs a REST token, which is account-wide, so that is a second, separate, optional credential.",
            "Accepted is not acknowledged. The outbound half can only ever report a 202. The inbound webhook is the only thing that knows a human was reached, and who."
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
          "content": "Three legs reach the pager, and they converge on one endpoint."
        },
        {
          "type": "text",
          "content": "The per-case leg is a sweep in the message service, and it is the valuable one. It reads the exact response_due_at a customer was given and pages two hours before it, naming the case."
        },
        {
          "type": "text",
          "content": "The fleet leg is SupportPremiumFirstResponseAtRisk: p90 first response over six hours exceeding six hours, against a target of eight. It fires early on purpose, to leave two hours to act."
        },
        {
          "type": "text",
          "content": "The meta leg is the alerts about delivery itself — AlertmanagerNotificationsFailing, AlertDeliveryDisabled, OnCallEnabledButUnconfigured — labelled delivery_meta: \"true\" on the rule."
        },
        {
          "type": "text",
          "content": "The last two route through Alertmanager to platform's POST /observability/oncall-webhook, which re-checks the labels and forwards a matching alert to Events v2. The first calls the same client directly."
        },
        {
          "type": "text",
          "content": "The legs overlap deliberately. The per-case trigger is precise but depends on the product's own sweep being alive; the fleet leg is coarse but depends only on Prometheus. If the sweep dies, the fleet leg still fires — which is why oncall_pages_total carries a trigger label, so a dead sweep is visible rather than hidden behind an alert that still works."
        }
      ]
    },
    {
      "id": "how-it-works",
      "title": "How it works",
      "blocks": [
        {
          "type": "text",
          "content": "Alertmanager routes to the product"
        },
        {
          "type": "text",
          "content": "The obvious wiring is pagerduty_configs in alertmanager.yml, and it cannot be built here. That file is in the deploy contract's REQUIRED_IDENTICAL set and asserted byte-identical across targets, and Alertmanager has no templating — so a route that existed only when paging is enabled would need a second copy of the whole config, in the shape of admin-consoles-disabled.conf."
        },
        {
          "type": "text",
          "content": "Pointing at the product instead means the route is always present and ONCALL_ENABLED is honoured on the receiving side, where a disabled client accepts and drops. Alertmanager sees a 200 either way, so a deployment that does not page collects no alertmanager_notifications_failed_total."
        },
        {
          "type": "text",
          "content": "It also costs nothing to reach: the same service, port and relay-token the existing per-org relay already uses — no new Secret, no NetworkPolicy rule, no istio-internal-routes.yaml entry."
        },
        {
          "type": "text",
          "content": "Both destinations fire, deliberately"
        },
        {
          "type": "text",
          "content": "The pager route carries continue: true, so a support critical reaches both the pager and critical-slack. The pager wakes somebody; the channel carries the full annotation, the thread and the handover. A phone notification is a few lines and must not be the only record."
        },
        {
          "type": "text",
          "content": "Route order is load-bearing: the pager route precedes the severity routes, which end continue: false. If severity = \"critical\" matched first, evaluation would stop and the pager would never be reached."
        },
        {
          "type": "text",
          "content": "The meta-alerts receiver breaks a circularity"
        },
        {
          "type": "text",
          "content": "An alert reporting that delivery is broken must not depend on delivery working. With the Slack receivers unconfigured, AlertmanagerNotificationsFailing fires, is sent to the Slack receiver, fails, and increments the very counter it watches — retrying forever while nobody reads it. Its own description admits the trap: \"You are reading THIS one only because some other receiver still works.\""
        },
        {
          "type": "text",
          "content": "So delivery_meta alerts also route to meta-alerts, which is platform's webhook and answers 200 whatever the knobs say. With paging configured they page, because alerting being broken is the one condition that makes every other alert meaningless. With paging off they are logged and counted — still strictly more than vanishing into a failing webhook."
        },
        {
          "type": "text",
          "content": "The per-case sweep keeps no state"
        },
        {
          "type": "text",
          "content": "Every tick re-derives the whole set from support_cases and re-sends trigger on the key case:<id>. There is no paged_at column, no ledger and no per-tick memory, because PagerDuty collapses repeats of a key onto one incident — so a case inside the window is re-sent every five minutes and stays one page."
        },
        {
          "type": "text",
          "content": "That idempotence decides two things that would otherwise need building. Replicas: two pods running the same tick produce the same keys, so the leader lock is an efficiency measure and not a correctness one — and when Redis is absent the sweep runs on every pod rather than failing closed, because a pager that stops when its cache stops is not a pager. Resolution: a resolve for a key that never triggered is a provider-side no-op, so the sweep never has to know whether a case ever reached the window."
        },
        {
          "type": "text",
          "content": "The resolve is emitted where stampFirstResponse succeeds, not by the sweep. That call already returns whether this reply stopped the clock, which is the one edge in the system; finding it from the sweep would mean polling for the absence of a row the reply just wrote."
        },
        {
          "type": "text",
          "content": "The query is backed by a partial index — (response_due_at) WHERE level = 'support_premium' AND first_response_at IS NULL AND deleted_at IS NULL — because the tick runs forever. Note level and not is_premium: that column is on support contacts and marks an upgraded contact, while a case freezes the opening contact's level at open, so the case's own promise is its level and upgrading a contact later must not move a deadline already published to a customer."
        },
        {
          "type": "text",
          "content": "It runs whatever ONCALL_ENABLED says. Paging is dropped when off, but oncall_cases_due is published either way — so a deployment selling premium support with no pager can see the obligation it has taken on, which previously meant reading the table by hand."
        },
        {
          "type": "text",
          "content": "What PagerDuty owns, and why"
        },
        {
          "type": "text",
          "content": "dedup_key plus event_action means PagerDuty holds the incident state, which hands over three things outright:"
        },
        {
          "type": "list",
          "items": [
            "deduplication — fifty cases breaching together, the normal shape after an outage, is one incident rather than fifty pages. Fifty pages and no pages are the same thing.",
            "resolution — resolve on the same key closes it, so no local state machine is needed.",
            "contact methods, verification, the rota and escalation."
          ]
        },
        {
          "type": "text",
          "content": "One thing it does not give: a dead-man switch. PagerDuty heartbeat monitoring is an Event Orchestration pattern rather than a native Events v2 feature and is documented as AIOps-powered, so that gap is still open."
        },
        {
          "type": "text",
          "content": "The inbound leg answers the two questions the outbound one cannot"
        },
        {
          "type": "text",
          "content": "PagerDuty posts incident state changes back to POST /observability/oncall-ack, signed with X-PagerDuty-Signature: v1=<hex> — an HMAC-SHA256 over the raw body, which is why that path mounts express.raw: verifying a re-serialized object fails every time, and the obvious way out of that is to stop verifying. The header can carry several comma-separated v1= values, which is how a secret rotates without downtime, so any match is accepted. With no secret configured the route refuses everything — fail closed, because an unverified webhook that writes an audit row and a latency metric lets anyone who learns the URL assert that a page was handled."
        },
        {
          "type": "text",
          "content": "That buys two facts. Who picked it up, recorded as pagerduty:<agent id> and deliberately not resolved to a local user — the provider owns contact methods and their verification, and inventing that mapping would assert an identity this system cannot attest to. And that the first responder did not, which is a separate audit action because it is the fact a rota gets adjusted on."
        },
        {
          "type": "text",
          "content": "oncall_page_ack_seconds is observed only when both timestamps arrive. A missing one is omitted rather than recorded as 0: a 0 lands in the first bucket and reads as an instant acknowledgement, which is the most flattering possible lie about response time."
        },
        {
          "type": "text",
          "content": "Nobody rostered is a state, and it needs its own credential"
        },
        {
          "type": "text",
          "content": "oncall_schedule_uncovered_seconds answers \"is anyone scheduled over the next 48 hours\", read from GET /oncalls rather than from a rota this product owns. It is the one check the rest of the feature cannot perform on itself — everything else reports that something happened, while a hole next Tuesday produces no signal at all until 02:00 Tuesday."
        },
        {
          "type": "text",
          "content": "It needs PAGERDUTY_API_TOKEN, and that is separate from the routing key on purpose: an integration key can only create events on one service, while a REST token reads incidents, schedules and users account-wide. So the check is opt-in on the stronger credential and is never inferred from the weaker one."
        },
        {
          "type": "text",
          "content": "The gauge is not written when the answer is unknown. A failed call, a revoked token or an expired plan all mean \"I do not know\", and a 0 there would publish \"fully covered\" — exactly the reassurance this check exists to withhold. An absent series makes OnCallScheduleGap not fire, which is correct; OnCallRotaUnreadable is the separate alert for a blind check, because conflating the two makes an expired token read either as a false page or as silence."
        },
        {
          "type": "text",
          "content": "What it claims is narrow and exact. GET /oncalls returns the entries overlapping a window, not the holes, and an always-on policy has null start/end — so reconstructing partial gaps would be arithmetic that is wrong in the common case. This reports only whether the window is covered at all, which is the failure a rota maintainer actually makes, and under-reports rather than guesses."
        },
        {
          "type": "text",
          "content": "Accepted is not delivered"
        },
        {
          "type": "text",
          "content": "A 202 means PagerDuty has the event. It says nothing about whether a phone rang. oncall_pages_total{outcome=\"accepted\"} records exactly that and no more; the only honest evidence of coverage is a human acknowledging."
        }
      ]
    },
    {
      "id": "configuration",
      "title": "Configuration",
      "blocks": [
        {
          "type": "table",
          "headers": [
            "variable",
            "default",
            "notes"
          ],
          "rows": [
            [
              "ONCALL_ENABLED",
              "false",
              "Opt-in, against the usual opt-out grain — like BILLING_METERING_ENABLED, a feature needing an external credential defaults off. A pager with no key would page nobody while reporting success."
            ],
            [
              "PAGERDUTY_ROUTING_KEY",
              "—",
              "Per-service integration key. Not a REST API key. Classified into the app Secret automatically by the _KEY suffix rule, never the world-readable ConfigMap."
            ],
            [
              "ONCALL_EVENTS_URL",
              "https://events.pagerduty.com/v2/enqueue",
              "Overridable for Opsgenie's compatible endpoint, which keeps the provider swappable without touching four alertmanager.yml copies."
            ],
            [
              "ONCALL_EVENTS_TIMEOUT_MS",
              "5000",
              "A hung pager must not hold an Alertmanager connection open."
            ],
            [
              "SLACK_ALERTS_ENABLED",
              "false",
              "Whether ops-team Slack is declared on. Opt-in, matching ONCALL_ENABLED, so a deployment states which destinations it wants rather than inheriting a channel it may not have."
            ],
            [
              "SLACK_ALERTS_CONFIGURED",
              "false",
              "Derived at deploy time, not authored: pb_check_alert_delivery sets it from whether the webhook URLs are real. It exists because the URLs never enter the platform process, and it is what keeps AlertDeliveryDisabled keyed on reality rather than on the declaration."
            ],
            [
              "ONCALL_CASE_LEAD_MINUTES",
              "120",
              "How long before response_due_at the per-case trigger starts paging."
            ],
            [
              "ONCALL_SWEEP_INTERVAL_MS",
              "300000",
              "Sweep cadence. A tick is idempotent, so a missed one costs lead time and nothing else."
            ],
            [
              "ONCALL_PROVIDER",
              "pagerduty",
              "pagerduty \\",
              "custom. custom requires ONCALL_EVENTS_URL and does not fall back. There is no opsgenie value: nothing documents Opsgenie accepting the Events v2 shape, and naming a provider this client cannot talk to would be discovered at 3am."
            ],
            [
              "PAGERDUTY_WEBHOOK_SECRET",
              "—",
              "Verifies the inbound leg. Empty ⇒ the ack route refuses everything."
            ],
            [
              "PAGERDUTY_API_TOKEN",
              "—",
              "REST token for the rota check. Account-wide, so deliberately separate from the routing key. Empty ⇒ no coverage gauge."
            ],
            [
              "ONCALL_SCHEDULE_GAP_LOOKAHEAD_HOURS",
              "48",
              "How far ahead the coverage check looks."
            ]
          ]
        },
        {
          "type": "text",
          "content": "On-call requires support. With SUPPORT_ENABLED=false paging stays off whatever ONCALL_ENABLED says, because there is then no case, no response target and nothing to page about — only a per-seat bill for a pager wired to nothing. The conflict is reported once and only when paging was actually asked for: a validator that checked inactive features is what once crashed billing at boot."
        },
        {
          "type": "text",
          "content": "oncall:manage is a system-org-only permission in no built-in Role, so Super Admins are its only holders. It reads the posture (GET /observability/oncall-status, booleans only — never a credential, since reading a routing key back would turn a read permission into a credential grant) and sends a test page (POST /observability/oncall-test, audited because it rings a phone, keyed test:<timestamp> so it can never collapse onto or resolve a real incident)."
        },
        {
          "type": "text",
          "content": "ONCALL_ENABLED=true with an empty routing key is refused at deploy time, not warned: somebody asked for paging and would not be getting it. Setting both SLACK_ALERTS_ENABLED=false and ONCALL_ENABLED=false is permitted and fires AlertDeliveryDisabled — reachable today by setting two booleans, with nothing else objecting."
        },
        {
          "type": "text",
          "content": "What the Slack knob can and cannot do"
        },
        {
          "type": "text",
          "content": "It cannot remove the Slack receivers, for the same byte-identical reason above. With the knob off and the URLs empty, Alertmanager still attempts delivery and the failure counter climbs. What the knob does is make the decision explicit — empty URLs with the knob on read as an oversight — stop the deploy check demanding credentials for a channel nobody asked for, and drive alert_delivery_enabled{channel=\"slack\"}."
        },
        {
          "type": "text",
          "content": "Ops Slack is deliberately not routed through the product the way the pager is. Today Slack delivery survives a platform outage; routing it through the product would mean a platform outage silences all alerting, including the alert that platform is down."
        }
      ]
    },
    {
      "id": "observability",
      "title": "Observability",
      "blocks": [
        {
          "type": "text",
          "content": "alert_delivery_enabled{channel} and alert_delivery_configured{channel} are published once per process at platform boot. Before them, answering \"does this deployment tell anyone when something breaks?\" meant reading .env, two Secrets and four copies of alertmanager.yml."
        },
        {
          "type": "text",
          "content": "Both are gauges because they are states of the deployment, and both posture alerts read them through max_over_time(...[1h]) rather than instantaneously — the gauge is set once at boot, so a rolling restart would otherwise blink it absent and resolve the alert while nothing had changed."
        },
        {
          "type": "text",
          "content": "oncall_pages_total{action,trigger,outcome} separates accepted, rejected, redirected, error, unconfigured and disabled. The last is what keeps an always-present Alertmanager route from reading as a failure, and trigger separates the per-case sweep from the Alertmanager leg — without it a dead sweep is invisible for as long as the fleet alert still fires."
        },
        {
          "type": "text",
          "content": "oncall_cases_due is a gauge, written on every tick including the ticks that find nothing: a gauge reports a state only if it is written when the state is zero. OnCallCasesBreachingUnpaged reads it against alert_delivery_configured{channel=\"pager\"} and fires when cases are inside the window and nothing is configured to page — the obligation existing without the coverage, which is the failure this whole feature is about."
        },
        {
          "type": "text",
          "content": "All of it is on the Product health dashboard, under Alert delivery."
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
            "Deploy Operations — alert routing, inhibition, and the operator consoles",
            "Environment Variables — the full table",
            "Billing Bundles — the support levels and the response targets being defended"
          ]
        }
      ]
    }
  ],
  "sourceDoc": "docs/oncall-paging.md"
};
