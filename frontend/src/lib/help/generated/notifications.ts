// GENERATED FROM docs/notifications.md — DO NOT EDIT.
// Regenerate: npm run generate:help  (see frontend/scripts/generate-help.mjs)
// SOURCE-SHA256: eab71afd8b79a6df88b2de6129883d6fff0d408cea14f31748434f5209f1701e
// SPDX-License-Identifier: Apache-2.0
import { Bell } from 'lucide-react';
import type { HelpTopic } from '../types';

export const notificationsTopic: HelpTopic = {
  "icon": Bell,
  "id": "notifications",
  "title": "Notifications",
  "description": "Email, Slack, webhooks and the in-app inbox — what an operator enables and what an organization configures",
  "sections": [
    {
      "id": "overview",
      "title": "Overview",
      "blocks": [
        {
          "type": "text",
          "content": "Every way Pipeline Builder tells a human something: email, Slack, outbound webhooks, and the in-app inbox."
        },
        {
          "type": "text",
          "content": "Two people configure this and they configure different halves of it. The operator decides whether the instance can send email at all and where platform-wide alerts land. The organization admin decides who in their org hears about what, and on which channel."
        },
        {
          "type": "note",
          "content": "Read this first. The two halves are not connected in the product. An org admin can fill in every notification setting in the UI — recipients, digests, an external security address — and have all of it deliver nothing, because EMAIL_ENABLED is false on the instance. Nothing in the org-facing UI says so. The one place the platform switch surfaces is the Send test button on an email alert destination, which reports email-disabled. If you operate an instance, tell your org admins which channels actually work."
        }
      ]
    },
    {
      "id": "the-channels",
      "title": "The channels",
      "blocks": [
        {
          "type": "table",
          "headers": [
            "Channel",
            "Who configures it",
            "Gated by"
          ],
          "rows": [
            [
              "Email",
              "operator (whether) + org admin (who)",
              "EMAIL_ENABLED on the platform service"
            ],
            [
              "Ops-team Slack (platform-wide alerts)",
              "operator only",
              "SLACK_CRITICAL_WEBHOOK_URL / SLACK_WARNING_WEBHOOK_URL"
            ],
            [
              "Per-org Slack / HTTPS webhook / in-app / email (alerts)",
              "org admin",
              "ALERT_WEBHOOK_INSTANCE_TOKEN wired on both sides"
            ],
            [
              "Per-org HTTPS webhook (plugin security, compliance)",
              "org admin",
              "nothing platform-level — sent by the plugin / compliance service directly"
            ],
            [
              "In-app inbox (/dashboard/messages)",
              "nobody — always on",
              "the message service (MESSAGE_ENABLED, defaults on)"
            ],
            [
              "SNS email (SES bounces/complaints)",
              "operator, AWS targets only",
              "ALERT_EMAIL"
            ]
          ]
        },
        {
          "type": "text",
          "content": "In-app is the source of truth for ecosystem notices; email is the courtesy copy. Turning email off never loses an in-app message."
        }
      ]
    },
    {
      "id": "platform-outbound-email",
      "title": "Platform: outbound email",
      "blocks": [
        {
          "type": "text",
          "content": "One switch, one sender identity, one provider. All of it is read by the platform service only — no other service holds SMTP or SES credentials. Compliance and plugin send through platform's internal relay (POST /internal/notify-email), which is service-token-only and accepts exactly two callers, compliance and plugin."
        },
        {
          "type": "table",
          "headers": [
            "Variable",
            "Default (code)",
            "Notes"
          ],
          "rows": [
            [
              "EMAIL_ENABLED",
              "false",
              "The master switch. Anything but the literal string true is off."
            ],
            [
              "EMAIL_PROVIDER",
              "smtp",
              "smtp or ses. An unrecognized value logs a warning and falls back to SMTP."
            ],
            [
              "EMAIL_FROM",
              "noreply@example.com",
              "Envelope sender. On the AWS targets this must match the address the IAM policy allows."
            ],
            [
              "EMAIL_FROM_NAME",
              "Platform",
              "Display name. Every shipped .env.example overrides it to pipeline-builder."
            ],
            [
              "SMTP_HOST / SMTP_PORT / SMTP_SECURE",
              "localhost / 587 / false",
              ""
            ],
            [
              "SMTP_USER / SMTP_PASS",
              "empty",
              "An empty SMTP_USER means the transport is built with no auth rather than with empty credentials."
            ],
            [
              "SES_REGION",
              "AWS_REGION, else us-east-1",
              "SES identities are regional."
            ],
            [
              "SES_ACCESS_KEY_ID / SES_SECRET_ACCESS_KEY",
              "empty",
              "Leave these blank on AWS. A non-empty access key id makes the SES client use static credentials, overriding the instance role or Pod Identity association — sending then fails with InvalidClientTokenId. deploy/aws/ec2/bin/bootstrap.sh blanks them defensively for exactly this reason."
            ],
            [
              "SES_CONFIGURATION_SET",
              "empty",
              "Applied to every SES send. Empty means no configuration set; sends still work, but bounces and complaints go nowhere you can see."
            ]
          ]
        },
        {
          "type": "text",
          "content": "Where it is off, and where it is on"
        },
        {
          "type": "table",
          "headers": [
            "Target",
            "EMAIL_ENABLED in .env.example",
            "SLACK_*_WEBHOOK_URL in .env.example"
          ],
          "rows": [
            [
              "deploy/local/docker",
              "false",
              "empty — the deliberate \"no ops Slack\" choice"
            ],
            [
              "deploy/local/minikube",
              "false",
              "empty"
            ],
            [
              "deploy/aws/ec2",
              "true",
              "CHANGE_ME — the provision fails until you decide"
            ],
            [
              "deploy/aws/eks",
              "true",
              "CHANGE_ME"
            ]
          ]
        },
        {
          "type": "text",
          "content": "So on a laptop install, email is off out of the box. Invitations, email verification and anonymous plugin submissions behave accordingly — see Symptoms."
        },
        {
          "type": "text",
          "content": "SES_CONFIGURATION_SET is only present in the ec2 and eks .env.example files. The docker target neither ships the key nor passes it to the platform container in docker-compose.yml, so it cannot be set there at all. On minikube it is absent from .env.example but would be picked up if added, because the k8s targets build the app-env ConfigMap from the whole .env."
        },
        {
          "type": "text",
          "content": "SES on the AWS targets"
        },
        {
          "type": "text",
          "content": "setup.sh --email (the default on both AWS targets; --no-email opts out) provisions the sending path and wires the app to it in one step:"
        },
        {
          "type": "list",
          "items": [
            "A domain identity with Easy DKIM. EKS calls"
          ]
        },
        {
          "type": "text",
          "content": "sesv2 create-email-identity for the deploy domain and UPSERTs the three <token>._domainkey.<domain> CNAMEs into the public hosted zone. EC2 does the same through AWS::SES::EmailIdentity in deploy/aws/ec2/template.yaml, with the DKIM CNAMEs going to the public HostedZoneId. Pass CREATE_SES_IDENTITY=false (EKS) / CreateSesIdentity=false (EC2) when the domain is already a verified identity in the account."
        },
        {
          "type": "list",
          "items": [
            "A configuration set plus an SNS topic for BOUNCE, COMPLAINT and"
          ]
        },
        {
          "type": "text",
          "content": "REJECT events — <cluster>-email-events on EKS, <stack>-email-events on EC2. SES enforces reputation at the account level, so this is how you find out before SES throttles you rather than after."
        },
        {
          "type": "list",
          "items": [
            "ALERT_EMAIL, when given, is subscribed to that SNS topic by email. It is"
          ]
        },
        {
          "type": "text",
          "content": "not an application setting and the platform never reads it — it is a human address for SES reputation warnings. You must confirm the subscription email AWS sends, or the subscription stays pending and delivers nothing."
        },
        {
          "type": "list",
          "items": [
            "A scoped IAM grant. ses:SendEmail on that one identity, with a condition"
          ]
        },
        {
          "type": "text",
          "content": "on ses:FromAddress equal to EMAIL_FROM (EC2 falls back to noreply@<domain> when EmailFrom is empty). EKS binds it to the platform ServiceAccount via Pod Identity; EC2 attaches it to the instance role. A mismatch between EMAIL_FROM and the address in the policy is an AccessDenied at send time, not at deploy time."
        },
        {
          "type": "list",
          "items": [
            "The .env edits. EMAIL_ENABLED, EMAIL_PROVIDER=ses, EMAIL_FROM,"
          ]
        },
        {
          "type": "text",
          "content": "EMAIL_FROM_NAME, SES_CONFIGURATION_SET and a SES_REGION pinned to the actual deploy region."
        },
        {
          "type": "text",
          "content": "Two things the deploy cannot do for you:"
        },
        {
          "type": "list",
          "items": [
            "DKIM verification is asynchronous — minutes to hours after the CNAMEs"
          ]
        },
        {
          "type": "text",
          "content": "publish. The stack reaches CREATE_COMPLETE first."
        },
        {
          "type": "list",
          "items": [
            "A new SES account is sandboxed: 200 messages a day, and only to verified"
          ]
        },
        {
          "type": "text",
          "content": "recipients, until you request production access. Smoke-testing in the sandbox means verifying a real recipient address — admin@internal, the default bootstrap identifier, is not one."
        },
        {
          "type": "text",
          "content": "EKS re-runs of setup.sh reuse an existing IAM policy rather than rewriting it. If you change EMAIL_FROM later, the old ses:FromAddress condition stays and sending breaks; delete the <cluster>-eks-ses policy and re-run."
        },
        {
          "type": "text",
          "content": "Verifying it"
        },
        {
          "type": "text",
          "content": "deploy/bin/post-provision-smoke.sh sends a real message through the running platform pod:"
        },
        {
          "type": "code",
          "content": "SMOKE_EMAIL_TO=you@example.com bash deploy/bin/post-provision-smoke.sh k8s --aws",
          "language": "bash"
        },
        {
          "type": "text",
          "content": "It skips when EMAIL_ENABLED is not true, and skips when neither SMOKE_EMAIL_TO nor ALERT_EMAIL is set. A failure points at EMAIL_* in .env and at the platform egress NetworkPolicy."
        }
      ]
    },
    {
      "id": "platform-alertmanager-and-ops-team-slack",
      "title": "Platform: Alertmanager and ops-team Slack",
      "blocks": [
        {
          "type": "text",
          "content": "Platform-wide alerts (tenancy: platform, or no tenancy label) go to the ops-team Slack channels — #ops-pager for severity: critical, #ops-warnings for severity: warning. Per-org alerts (tenancy: org + an org_id label) are relayed to the platform service instead and never reach the ops channels; the route sets continue: false."
        },
        {
          "type": "text",
          "content": "The two Slack webhooks"
        },
        {
          "type": "text",
          "content": "SLACK_CRITICAL_WEBHOOK_URL and SLACK_WARNING_WEBHOOK_URL live in .env. They are never written into config/alertmanager/alertmanager.yml. The receivers use api_url_file, reading the URL from a mounted file per notification:"
        },
        {
          "type": "table",
          "headers": [
            "Mounted path",
            "Source"
          ],
          "rows": [
            [
              "/etc/alertmanager-slack/critical-url",
              "SLACK_CRITICAL_WEBHOOK_URL"
            ],
            [
              "/etc/alertmanager-slack/warning-url",
              "SLACK_WARNING_WEBHOOK_URL"
            ],
            [
              "/etc/alertmanager-secrets/relay-token",
              "ALERT_WEBHOOK_INSTANCE_TOKEN"
            ]
          ]
        },
        {
          "type": "text",
          "content": "On the k8s targets those are the alertmanager-slack and alertmanager-relay Secrets, created by pb_secret in deploy/bin/k8s-resources.sh; on docker they are compose secrets. A Slack incoming-webhook URL is bearer-equivalent — anyone holding it can post to the channel — so it belongs in a Secret, not in a ConfigMap that anyone with namespace read access can read. Rotating a URL is a Secret update plus a pod restart, with no config change, because Alertmanager re-reads the file."
        },
        {
          "type": "text",
          "content": "The provision fails on a placeholder webhook — on purpose"
        },
        {
          "type": "text",
          "content": "Every target's setup runs pb_check_alert_delivery (deploy/bin/gen-env-secrets.sh) before it creates the Alertmanager Secret/ConfigMap, and treats a non-zero return as fatal:"
        },
        {
          "type": "list",
          "items": [
            "deploy/local/docker/bin/setup.sh",
            "deploy/local/minikube/bin/setup.sh",
            "deploy/aws/ec2/bin/startup.sh",
            "deploy/aws/eks/bin/setup.sh"
          ]
        },
        {
          "type": "text",
          "content": "It fails the deploy when either URL is still CHANGE_ME or otherwise malformed, and it also fails when alertmanager.yml itself contains api_url:, CHANGE_ME or T00000000 — i.e. when somebody pasted a credential back into the world-readable ConfigMap."
        },
        {
          "type": "text",
          "content": "The reason it is a deploy gate and not a runtime warning: alerting that reaches nobody is the worst kind of green. Prometheus fires, Alertmanager routes, Slack answers 404 for a placeholder webhook id, and the only trace is one line in a pod log nobody reads. The monitoring looks healthy precisely when it is not. So the failure is moved to the one moment a human is watching."
        },
        {
          "type": "text",
          "content": "The check goes further than syntax: unless SKIP_ALERT_TEST_SEND=1 is set, it posts a labelled test message to each webhook. Slack answering 403/404/410 — a revoked webhook, an archived channel, an uninstalled app — is indistinguishable from a placeholder at alert time, so a definitive rejection fails the deploy. Not being able to reach Slack from the machine running setup (no egress, a proxy) only warns; the cluster's own path is proven afterwards by post-provision-smoke.sh, which fires a real test alert and watches Alertmanager's alertmanager_notifications_total / _failed_total counters."
        },
        {
          "type": "text",
          "content": "Running without ops-team Slack is a supported choice. Set both keys to an empty value. The check then prints a banner naming exactly what stops working — platform-wide alerts fire into Alertmanager and go no further, visible only in Alertmanager's own UI and API; per-org destinations are unaffected — and succeeds. What it will not do is let a placeholder through silently. The local targets ship both keys empty for this reason; the AWS targets ship CHANGE_ME, because a production deploy has to make the call explicitly."
        },
        {
          "type": "text",
          "content": "pb_gen_env_secrets skips SLACK_* when filling CHANGE_ME placeholders (you cannot generate someone else's webhook URL), which is why they are the one pair of CHANGE_ME values that survives secret generation."
        },
        {
          "type": "text",
          "content": "The alert relay token"
        },
        {
          "type": "text",
          "content": "ALERT_WEBHOOK_INSTANCE_TOKEN is generated by gen-env-secrets and wired into both ends:"
        },
        {
          "type": "list",
          "items": [
            "Alertmanager reads it from /etc/alertmanager-secrets/relay-token"
          ]
        },
        {
          "type": "text",
          "content": "(credentials_file) and presents it as a Bearer token, together with an X-Alertmanager-Instance: alertmanager header, on POST http://platform:3000/observability/alert-webhook."
        },
        {
          "type": "list",
          "items": [
            "Platform receives it as"
          ]
        },
        {
          "type": "text",
          "content": "ALERT_WEBHOOK_INSTANCES=[{\"id\":\"alertmanager\",\"token\":\"…\",\"previousToken\":\"…\"}], built from the same value by docker-compose.yml / k8s/platform.yaml."
        },
        {
          "type": "text",
          "content": "With no instances configured the relay answers 503 and no per-org alert destination ever fires. An unknown instance id or a mismatched token is rejected. ALERT_WEBHOOK_INSTANCE_TOKEN_PREVIOUS exists only for a rotation overlap — platform accepts both while it is set, so Alertmanager can be restarted on the new token without dropping alerts. See Secret Rotation."
        }
      ]
    },
    {
      "id": "organization-alert-destinations",
      "title": "Organization: alert destinations",
      "blocks": [
        {
          "type": "text",
          "content": "Dashboard → Observability → Alert destinations (/dashboard/observability/alert-destinations; the alert pages are palette-only in the sidebar). Viewing needs observability:read, which the built-in Member role holds. Creating, editing, deleting and Send test all need observability:write, enforced on the route as well as in the UI."
        },
        {
          "type": "text",
          "content": "Four channels:"
        },
        {
          "type": "table",
          "headers": [
            "Channel",
            "Target",
            "Behaviour"
          ],
          "rows": [
            [
              "slack",
              "Slack incoming-webhook URL",
              "Rendered as a coloured attachment — red critical, yellow warning, plus a ✅ on resolve"
            ],
            [
              "webhook",
              "any HTTPS endpoint",
              "Receives the Alertmanager payload unchanged"
            ],
            [
              "in-app",
              "none",
              "Appends a row to the org's /dashboard/messages inbox, authored by the system org"
            ],
            [
              "email",
              "an address",
              "Goes through platform's EmailService — only works when EMAIL_ENABLED=true"
            ]
          ]
        },
        {
          "type": "text",
          "content": "Each destination carries a minSeverity and an enabled flag. Targets are masked on read-back (•••• plus the last 12 characters, or the last 4 for a very short target) because a webhook URL is itself a credential; the API never returns the raw value after creation. Both webhook transports resolve and pin the target address and refuse redirects."
        },
        {
          "type": "text",
          "content": "Send test delivers a real info-severity test alert to one destination with a bounded timeout (ALERT_DELIVERY_TIMEOUT_MS, 5 s). This is the only place in the product where the platform email switch is visible to an org admin: an email destination reports the skip reason email-disabled rather than claiming success."
        },
        {
          "type": "text",
          "content": "What actually fires per-org"
        },
        {
          "type": "text",
          "content": "Out of the box, four shipped rules in deploy/*/config/prometheus/alert-rules.yml carry tenancy: org and an org_id label, and therefore reach org destinations: LokiRateCapBreach, PluginBuildFailureRateHigh, PipelineDeployFailed and PipelineStageFailureRateHigh."
        },
        {
          "type": "text",
          "content": "Dashboard → Observability → Alert rules lets an org author its own rules (observability:read to view, observability:write to change). A PromQL matcher walk pins every selector to the authoring org's org_id, so a rule cannot span tenants, and the rendered rule carries tenancy: org so the relay routes it."
        },
        {
          "type": "text",
          "content": "Be aware of the gap: those authored rules are rendered by GET /observability/alert-rules/materialized.yml (sysadmin-only), and no shipped deploy target fetches that document into Prometheus. Every target's prometheus.yml lists exactly one rule_files entry, /etc/prometheus/alert-rules.yml. Until an operator wires the materialized document in, org-authored rules are stored and previewable but never evaluated."
        }
      ]
    },
    {
      "id": "organization-plugin-security-notifications",
      "title": "Organization: plugin security notifications",
      "blocks": [
        {
          "type": "text",
          "content": "Dashboard → Settings → Organization → \"Plugin security notifications\" (/dashboard/settings?tab=organization)."
        },
        {
          "type": "text",
          "content": "The card is visible with org:settings or plugins:read; the write controls and Send test need org:settings. The routes match: GET is plugins:read, PUT and POST …/test are org:settings, and the test is rate-limited to 5 per minute per org because it can reach people and an external endpoint."
        },
        {
          "type": "text",
          "content": "Two notices are routed here:"
        },
        {
          "type": "list",
          "items": [
            "N30 — a plugin version was blocked. The build failed a scan gate"
          ]
        },
        {
          "type": "text",
          "content": "(IMAGE_SCAN_UNAVAILABLE, or fixable Critical findings over the platform floor) and nothing was stored. Always sent immediately, regardless of the digest setting."
        },
        {
          "type": "list",
          "items": [
            "N31 — a rescan found new Critical/High findings in a version already"
          ]
        },
        {
          "type": "text",
          "content": "stored. Honours the org's Rescan findings toggle and digest mode, and is deduplicated per (version, CVE) for 180 days."
        },
        {
          "type": "text",
          "content": "Settings, stored one row per org in plugin_security_notification_prefs (absent = the defaults below):"
        },
        {
          "type": "table",
          "headers": [
            "Setting",
            "Column",
            "Default",
            "Meaning"
          ],
          "rows": [
            [
              "Recipients",
              "recipient_mode",
              "writers",
              "writers = the uploader (while still a member) plus every member holding plugins:write; users = only the members you pick"
            ],
            [
              "Chosen members",
              "target_users",
              "{}",
              "Resolved at send time against active membership — a stale id, or someone who left, receives nothing"
            ],
            [
              "Rescan findings",
              "notify_rescan",
              "true",
              "Turns N31 off entirely"
            ],
            [
              "Rescan delivery",
              "digest_mode",
              "immediate",
              "immediate, daily or weekly. Applies to N31 only"
            ],
            [
              "Webhook URL",
              "webhook_url",
              "none",
              "https only, validated in the browser and again on the server"
            ],
            [
              "Webhook signing secret",
              "webhook_secret",
              "none",
              "Encrypted under the org's key, never returned — the UI shows only \"set\" / \"not set\". Each delivery is signed X-PB-Signature: sha256=…"
            ],
            [
              "External address",
              "external_email_enc",
              "none",
              "One address outside the org, encrypted at rest and shown only masked"
            ]
          ]
        },
        {
          "type": "text",
          "content": "The external address is verify-on-add. Saving a new address emails a single-use link, valid 24 hours, to that address. It receives nothing until its owner opens /notifications/confirm and presses the button — an explicit click, so a mail scanner following the link cannot burn the token. Until then the badge reads Pending confirmation (or Confirmation link expired), and Resend confirmation issues a fresh link. The catalog permits a raw address recipient on N30 and N31 only; the relay rejects it on every other event."
        },
        {
          "type": "text",
          "content": "The webhook is sent by the plugin service itself, not through the platform relay, so it keeps working when outbound email is off. The in-app + email leg goes through the relay, and email is subject to EMAIL_ENABLED like everything else."
        },
        {
          "type": "text",
          "content": "Send test fires one notice on every configured channel and reports per channel: the relay (in-app + email), the webhook (with the HTTP code on failure), and the external address — which is reported as pending, and skipped, when it has not been confirmed. The button is disabled while you have unsaved changes."
        }
      ]
    },
    {
      "id": "organization-compliance-notifications",
      "title": "Organization: compliance notifications",
      "blocks": [
        {
          "type": "text",
          "content": "Dashboard → Compliance → Settings → Notifications (/dashboard/compliance). The page needs compliance:read; the form is read-only without compliance:write, and the PUT is gated on it."
        },
        {
          "type": "table",
          "headers": [
            "Setting",
            "Default",
            "Meaning"
          ],
          "rows": [
            [
              "Notify on block",
              "on",
              "A compliance rule blocked a plugin or pipeline"
            ],
            [
              "Notify on warning",
              "off",
              "A non-blocking violation"
            ],
            [
              "Email",
              "off",
              "Off by default. Turning it on is what adds the email leg"
            ],
            [
              "Recipients",
              "all org admins",
              "Pick specific members, or leave empty for every admin/owner"
            ],
            [
              "Digest mode",
              "immediate",
              "immediate, daily or weekly"
            ],
            [
              "Webhook URL",
              "none",
              "https only, rejected at save time rather than silently failing on every future send"
            ],
            [
              "Webhook secret",
              "none",
              "HMAC-signed deliveries; never echoed back, only hasWebhookSecret"
            ]
          ]
        },
        {
          "type": "text",
          "content": "In-app is always delivered and is the primary channel. The webhook is added when a URL is set, email when it is enabled. A digest batch is marked sent only when every enabled channel delivered, so a flaky channel leaves the batch pending rather than losing its content — at the cost of a possible duplicate on retry."
        },
        {
          "type": "text",
          "content": "Compliance owns no SMTP or SES stack. Its email channel posts to platform's /internal/notify-email with a service token scoped to the tenant the email is for; platform resolves targetUsers (intersected with active membership) or falls back to every active admin/owner, and sends."
        }
      ]
    },
    {
      "id": "per-user-preferences",
      "title": "Per-user preferences",
      "blocks": [
        {
          "type": "text",
          "content": "Dashboard → Notifications (/dashboard/notifications) — no permission required; it is the signed-in user's own page, saved per user and per organization on the server, so it follows them across devices."
        },
        {
          "type": "text",
          "content": "Three things live there:"
        },
        {
          "type": "list",
          "items": [
            "In-app preferences — currently one: Mute quota warnings, which hides the"
          ]
        },
        {
          "type": "text",
          "content": "approaching-limit banner. It still appears once a limit is exceeded, because requests are being rejected at that point."
        },
        {
          "type": "list",
          "items": [
            "Plugin ecosystem emails — four opt-outs, each of which stops only the"
          ]
        },
        {
          "type": "text",
          "content": "email for that kind of notice:"
        },
        {
          "type": "table",
          "headers": [
            "Toggle",
            "Stored field",
            "Covers"
          ],
          "rows": [
            [
              "Review emails",
              "reviewsEmail",
              "N15, N16"
            ],
            [
              "Upgrade and deprecation emails",
              "upgradesEmail",
              "N13, N14, N26, N27"
            ],
            [
              "Install request emails",
              "installsEmail",
              "N11, N12"
            ],
            [
              "Daily moderation digest email",
              "moderationDigestEmail",
              "N2, N6, N17, N24 — shown only to members of the system org"
            ]
          ]
        },
        {
          "type": "text",
          "content": "All four default to on. In-app messages are always delivered, and transactional or security notices ignore these entirely."
        },
        {
          "type": "list",
          "items": [
            "Links out to the two org-level surfaces, Alert destinations and the"
          ]
        },
        {
          "type": "text",
          "content": "Organization settings tab, rather than duplicating them."
        },
        {
          "type": "text",
          "content": "The ecosystem notice catalog"
        },
        {
          "type": "text",
          "content": "packages/api-core/src/types/ecosystem-notifications.ts is the single table both the sender (plugin) and the relay (platform) read. Each of N1–N31 declares its channels (in_app | email), its opt-out key or null for transactional, an optional digest cadence, and whether a raw email address may be addressed."
        },
        {
          "type": "text",
          "content": "Transactional and cannot be turned off: N1, N3, N4, N5, N7, N8, N9, N10, N18, N19, N20, N21, N22, N23, N25, N28, N29, N30, N31."
        },
        {
          "type": "text",
          "content": "Digest cadences: hourly flushes at the top of the hour; daily at 09:00 UTC; weekly on Monday 09:00 UTC. Several queued notices of the same event coalesce into one email with a count-bearing subject and one line per item."
        },
        {
          "type": "text",
          "content": "Two design points worth knowing as an admin:"
        },
        {
          "type": "list",
          "items": [
            "Recipients travel as rules, never as lists. The plugin service names a rule"
          ]
        },
        {
          "type": "text",
          "content": "(org_permission, org_members, moderators, superadmins, user, address); platform resolves it against the directory at send time. A digest that flushes tomorrow reaches tomorrow's approvers, the plugin service never handles an email address, and a publisher can never learn who installed their plugin."
        },
        {
          "type": "list",
          "items": [
            "One message per recipient. Nobody ever sees another recipient's address in a"
          ]
        },
        {
          "type": "text",
          "content": "To: line."
        }
      ]
    },
    {
      "id": "order-of-operations",
      "title": "Order of operations",
      "blocks": [
        {
          "type": "text",
          "content": "For an operator standing up an instance:"
        },
        {
          "type": "list",
          "items": [
            "Decide the sender identity before the deploy. On AWS, EMAIL_FROM is"
          ]
        },
        {
          "type": "text",
          "content": "baked into an IAM condition; changing it later means editing or deleting the policy."
        },
        {
          "type": "list",
          "items": [
            "Deploy with --email (default) or --no-email, and with `--alert-email"
          ]
        },
        {
          "type": "text",
          "content": "<address>` if you want SES reputation warnings. Confirm the SNS subscription email AWS sends."
        },
        {
          "type": "list",
          "items": [
            "Create the two Slack incoming webhooks and put them in .env — or set both to"
          ]
        },
        {
          "type": "text",
          "content": "empty deliberately. The deploy will not proceed on CHANGE_ME."
        },
        {
          "type": "list",
          "items": [
            "Let DKIM verify. Until it does, SES sends can fail even though the stack is"
          ]
        },
        {
          "type": "text",
          "content": "complete."
        },
        {
          "type": "list",
          "items": [
            "If the SES account is still sandboxed, request production access, or accept"
          ]
        },
        {
          "type": "text",
          "content": "that only verified recipients receive anything."
        },
        {
          "type": "list",
          "items": [
            "Run post-provision-smoke.sh with SMOKE_EMAIL_TO set and confirm both the"
          ]
        },
        {
          "type": "text",
          "content": "email test and the alert-delivery test."
        },
        {
          "type": "list",
          "items": [
            "Tell your org admins which channels work. Nothing in the product will."
          ]
        },
        {
          "type": "text",
          "content": "For an org admin, once the operator says email works:"
        },
        {
          "type": "list",
          "items": [
            "Observability → Alert destinations: add a Slack or webhook destination,"
          ]
        },
        {
          "type": "text",
          "content": "press Send test, and confirm it arrived before relying on it."
        },
        {
          "type": "list",
          "items": [
            "Settings → Organization → Plugin security notifications: choose"
          ]
        },
        {
          "type": "text",
          "content": "recipients, add the security team's external address, confirm it from the link, then Send test."
        },
        {
          "type": "list",
          "items": [
            "Compliance → Settings → Notifications: turn on email if you want it — it is"
          ]
        },
        {
          "type": "text",
          "content": "off by default even when the platform can send."
        },
        {
          "type": "list",
          "items": [
            "Tell members that Notifications is their own page, and that turning off an"
          ]
        },
        {
          "type": "text",
          "content": "ecosystem email never turns off the in-app copy."
        }
      ]
    },
    {
      "id": "symptoms",
      "title": "Symptoms",
      "blocks": [
        {
          "type": "table",
          "headers": [
            "Symptom",
            "Cause",
            "Fix"
          ],
          "rows": [
            [
              "Invitation says \"Invitation sent successfully\", invitee gets nothing",
              "EMAIL_ENABLED=false. The send is a no-op that returns success, so the API answers 201 and the UI reports delivery. The invitation row really exists; only the email is missing, and the token is not shown to the admin.",
              "Enable email, then Resend the invitation. (resend does return a 500 when a send genuinely fails — but only when EMAIL_ENABLED is true.)"
            ],
            [
              "\"Verification email sent\", nothing arrives",
              "Same no-op. POST /auth/send-verification reports success regardless.",
              "Enable email and re-send. A superadmin can instead mark their own address verified directly from Settings → Account (the \"unverified\" callout), which is the no-outbound-email operator convenience; it is superadmin-only, because every user owns their personal org and a broader gate would reduce to \"anyone can self-verify\"."
            ],
            [
              "Anonymous plugin submissions 404 with SUBMISSIONS_DISABLED",
              "The path refuses unless ANONYMOUS_SUBMISSIONS_ENABLED=true, and SUBMISSION_POW_SECRET, SUBMISSION_EMAIL_HASH_SECRET and PLUGIN_QUARANTINE_BUILDKIT_ADDR are all set, and platform reports outbound email on. The magic link is the anonymous submitter's only identity, so email is not optional here. The email status is cached 60 s and fails closed — an unreachable platform counts as off.",
              "Turn on email; allow up to 60 s for the cached answer to expire. Check the plugin log for ANONYMOUS_SUBMISSIONS_ENABLED is on but the path is not configured, which names the missing secrets."
            ],
            [
              "External security address stuck on Pending confirmation",
              "The confirmation link is itself an email (an N30 address notice). With email off it never arrives; the link also expires after 24 h.",
              "Enable email, then Resend confirmation."
            ],
            [
              "Org has email notifications configured, nothing is delivered",
              "The platform switch is off. Nothing in the org UI shows this.",
              "Ask the operator. Meanwhile, Send test on an email alert destination returns email-disabled — that is the diagnostic."
            ],
            [
              "An alert destination test succeeds but real alerts never arrive",
              "The destination is fine; the alert is not routed. Either the rule has no tenancy: org + org_id labels, or it is an org-authored rule that Prometheus is not loading (see What actually fires per-org).",
              "Check the rule's labels, and check that Prometheus' rule_files actually includes the document holding your rule."
            ],
            [
              "Per-org destinations dead everywhere, relay logs 503",
              "ALERT_WEBHOOK_INSTANCES is empty on platform — usually ALERT_WEBHOOK_INSTANCE_TOKEN was never generated into .env, or the k8s Secret was not updated.",
              "Re-run gen-env-secrets, recreate the alertmanager-relay Secret, restart platform and alertmanager."
            ],
            [
              "Deploy aborts on SLACK_CRITICAL_WEBHOOK_URL",
              "Deliberate. A placeholder webhook 404s into nothing at 03:00 and looks exactly like a healthy pipeline.",
              "Set both to real webhooks, or set both to empty to run without ops Slack. SKIP_ALERT_TEST_SEND=1 skips only the live test post, not the format check."
            ],
            [
              "Deploy aborts saying alertmanager.yml carries an inline webhook URL",
              "Somebody pasted a URL into the ConfigMap, which is readable by anyone with namespace read access.",
              "Remove it; the receivers read api_url_file from the alertmanager-slack Secret."
            ],
            [
              "SES returns AccessDenied on send",
              "EMAIL_FROM does not match the ses:FromAddress condition in the IAM policy — commonly after changing the sender on an EKS re-run, which reuses the existing policy.",
              "Align the two, or delete the <cluster>-eks-ses policy and re-run setup."
            ],
            [
              "SES returns InvalidClientTokenId",
              "SES_ACCESS_KEY_ID is non-empty, so static credentials override the instance role / Pod Identity.",
              "Blank SES_ACCESS_KEY_ID and SES_SECRET_ACCESS_KEY on the AWS targets."
            ],
            [
              "SES accepts only some recipients",
              "The account is still in the SES sandbox: verified recipients only, 200/day.",
              "Request production access."
            ],
            [
              "Bounces and complaints are invisible",
              "SES_CONFIGURATION_SET is empty, so sends do not route through the configuration set. Not settable at all on the docker target.",
              "Set it on the AWS targets (the deploy does this for you with --email), and subscribe ALERT_EMAIL to the SNS topic."
            ],
            [
              "Webhook destination rejected at save",
              "Both the browser and the server require https://. Compliance rejects a non-https URL at save time precisely so it does not fail silently on every later send.",
              "Use https."
            ]
          ]
        }
      ]
    },
    {
      "id": "limits-worth-knowing",
      "title": "Limits worth knowing",
      "blocks": [
        {
          "type": "list",
          "items": [
            "A disabled email send reports success. EmailService.send returns true"
          ]
        },
        {
          "type": "text",
          "content": "when EMAIL_ENABLED is not true. Callers that surface an emailSent flag — invitations, ecosystem delivery reports — therefore count messages as sent that were never attempted. The per-org alert destination email channel is the exception: it reports skipped with email-disabled."
        },
        {
          "type": "list",
          "items": [
            "Recipient addresses are never written to operational logs. The audit trail"
          ]
        },
        {
          "type": "text",
          "content": "carries the recipient where it genuinely matters."
        },
        {
          "type": "list",
          "items": [
            "In-app delivery depends on the message service. MESSAGE_ENABLED defaults"
          ]
        },
        {
          "type": "text",
          "content": "to on and is not listed in any .env.example; set to false it disables in-app notices, which have no email fallback."
        },
        {
          "type": "list",
          "items": [
            "The ops-team Slack channel names are fixed in config — #ops-pager and"
          ]
        },
        {
          "type": "text",
          "content": "#ops-warnings in alertmanager.yml. Change them there, not in .env."
        },
        {
          "type": "list",
          "items": [
            "Alertmanager batching — group_wait 30 s, group_interval 5 m,"
          ]
        },
        {
          "type": "text",
          "content": "repeat_interval 4 h. A test alert can take up to two minutes to appear."
        }
      ]
    },
    {
      "id": "see-also",
      "title": "See also",
      "blocks": [
        {
          "type": "list",
          "items": [
            "Incident Webhook — the inbound direction: pointing"
          ]
        },
        {
          "type": "text",
          "content": "PagerDuty, Datadog or your own Alertmanager at the platform so firing alerts become DORA incidents. Distinct from the relay described here."
        },
        {
          "type": "list",
          "items": [
            "Plugin Publishing — what N30 and N31 mean.",
            "Compliance — what generates a compliance notification.",
            "Environment Variables — the raw variable"
          ]
        },
        {
          "type": "text",
          "content": "tables."
        },
        {
          "type": "list",
          "items": [
            "Secret Rotation — rotating the alert relay"
          ]
        },
        {
          "type": "text",
          "content": "bearer with an overlap window."
        }
      ]
    }
  ],
  "sourceDoc": "docs/notifications.md"
};
