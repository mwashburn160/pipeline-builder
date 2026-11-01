// GENERATED FROM docs/runbooks/access-key-cutover.md — DO NOT EDIT.
// Regenerate: npm run generate:help  (see frontend/scripts/generate-help.mjs)
// SOURCE-SHA256: 5ccffb7c72e8f4ac31d180792657ca8ee5b074d1f0f2956617ff68d2538480a6
// SPDX-License-Identifier: Apache-2.0
import { Lock } from 'lucide-react';
import type { HelpTopic } from '../types';

export const runbookAccessKeysTopic: HelpTopic = {
  "icon": Lock,
  "id": "runbook-access-keys",
  "title": "Runbook: Access Keys & Machine Credentials",
  "description": "Issue personal access keys and provision the stored machine credentials an install needs",
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
          "content": "Issuing the personal keys people need, and provisioning the three machine credentials an AWS deployment cannot run without."
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
            "Every credential is an opaque access key, traded at platform for a 5-minute token. Nothing here is a JWT, and there is no other shape a key can take.",
            "A key is shown once. Only its SHA-256 is stored, so a lost key is reissued, never recovered.",
            "Every step is repeatable. Re-running it rotates rather than duplicates.",
            "registry-push is not optional on AWS — synth wires it into every build image unconditionally.",
            "Redeploy the ingestion Lambda after storing its key, or it keeps running the old handler.",
            "Keys are per organization. The stored secrets live at pipeline-builder/{orgId}/…, so each org you onboard needs its own.",
            "audit tokens is the check that matters — it lists every stored credential, its expiry, and whether it is a key at all."
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
          "content": "This runbook is what an operator does on a fresh install. It assumes the platform is deployed and you can sign in."
        },
        {
          "type": "text",
          "content": "For why an opaque key is the only shape in which revocation actually works, see Authentication → Access keys. The key is a secret the server never had, so it can only be issued, never derived."
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
            "A key is minted — pb_pat_… for a person, pb_sa_… for a service account — and shown to you exactly once.",
            "Only its SHA-256 is stored. The platform can verify a presented key but can never reproduce one.",
            "The holder exchanges it at platform for a 5-minute token, which is what every service actually sees.",
            "Revocation is immediate at the exchange, which is the whole reason the key is opaque rather than a self-contained token.",
            "For machines, the key is stored in Secrets Manager under the org's path, and the consumer reads it there.",
            "Rotation is the same command again — issue, store, redeploy the consumer."
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
            "Issue the personal keys people need — see Issuing personal keys. Issuing is step-up gated, so it asks for your password.",
            "Provision the three machine credentials on an AWS target, in this order — see Machine credentials:",
            "the org's full-privilege automation credential, for synth, deploy and plugin lookup;",
            "the registry-push credential CodeBuild presents as Basic auth — required, because synth wires it into every build image unconditionally;",
            "the reporting:ingest credential the events Lambda reads.",
            "Redeploy the ingestion Lambda so it runs the key-exchanging handler.",
            "Verify with pipeline-manager audit tokens — every stored credential, its expiry, and whether it is a key at all.",
            "Repeat per organization. These secrets are org-scoped; onboarding another org means provisioning its keys too."
          ]
        }
      ]
    },
    {
      "id": "what-holds-a-key",
      "title": "What holds a key",
      "blocks": [
        {
          "type": "table",
          "headers": [
            "Credential",
            "Issued by",
            "Notes"
          ],
          "rows": [
            [
              "Personal access key",
              "POST /user/keys, pipeline-manager auth pat",
              "A person's own; step-up gated, listed at Dashboard → API Tokens"
            ],
            [
              "The reporting:ingest webhook token on the Incident Reporting page",
              "Settings → Incident reporting",
              "A scoped key, not a person's credential"
            ],
            [
              "Stored platform credential (pipeline-manager infra store-token)",
              "POST /organization/:id/service-accounts/:accountId/keys",
              "A service-account key. See Machine credentials below"
            ],
            [
              "CodeBuild's registry credential",
              "the …/registry-push secret",
              "registry:push scope, no Roles"
            ],
            [
              "The pipeline-events Lambda's credential",
              "the …/reporting-ingest secret",
              "reporting:ingest scope, exchanged per batch"
            ],
            [
              "Browser sessions",
              "sign-in",
              "Not keys — ES256 user tokens"
            ],
            [
              "Service-to-service tokens",
              "signServiceToken",
              "Not keys — minted per call, 5-minute life"
            ]
          ]
        },
        {
          "type": "text",
          "content": "The AWS secret schema is { username, password, platformUrl, … }, and password is the canonical field every consumer reads. Its value is an opaque pb_sa_… key."
        }
      ]
    },
    {
      "id": "issuing-personal-keys",
      "title": "Issuing personal keys",
      "blocks": [
        {
          "type": "list",
          "items": [
            "Each holder creates their own, either in the UI (**Dashboard → API Tokens"
          ]
        },
        {
          "type": "text",
          "content": "→ Access keys → Create key**, step-up gated) or from the CLI:"
        },
        {
          "type": "text",
          "content": "bash pipeline-manager auth pat --name ci-deploy # or, to export it directly: eval $(pipeline-manager auth pat --name ci --quiet)"
        },
        {
          "type": "text",
          "content": "Both open a browser to approve the sign-in and the step-up — there is no password flag on the CLI any more. That is not a convenience: the step-up is satisfied by the account's real factors (passkey, authenticator code), which live in the browser and not in a flag. --no-browser prints the verification URL instead, for a headless box."
        },
        {
          "type": "text",
          "content": "--name is required; --expires-days defaults to 90; --scope mints a least-privilege key carrying that one capability and no Roles."
        },
        {
          "type": "text",
          "content": "The printed pb_pat_… value is what PLATFORM_TOKEN and Authorization: Bearer … now expect. Copy it immediately — only its hash is stored, so it is never shown again."
        },
        {
          "type": "text",
          "content": "Two refusals to expect rather than debug. Creating a key needs a step-up, and a machine credential can never satisfy one, so a key cannot mint another key (403 HUMAN_SESSION_REQUIRED). And in an org that sets administrative actions require MFA, a session with no second factor is refused up front (401 MFA_REQUIRED, details.reason: org_admin_policy) — the org's policy asking, not the route."
        },
        {
          "type": "list",
          "items": [
            "Generate the incident webhook token on Settings → Incident reporting if"
          ]
        },
        {
          "type": "text",
          "content": "the org uses one, and paste the value into the incident tool."
        },
        {
          "type": "list",
          "items": [
            "Provision the stored machine credentials — see the section below. That is"
          ]
        },
        {
          "type": "text",
          "content": "the part with an ordering that matters, so do it from there rather than from memory."
        }
      ]
    },
    {
      "id": "machine-credentials-the-service-accounts",
      "title": "Machine credentials: the service accounts",
      "blocks": [
        {
          "type": "text",
          "content": "Automation never holds a person's credential here. Every job that needs to talk to platform gets an org service account holding a pb_sa_… key — one account per job, with the narrowest scope that job needs — so no automation inherits someone's authority, outlives their employment, or makes the audit trail read as if they had personally pushed every image:"
        },
        {
          "type": "table",
          "headers": [
            "Secret",
            "Service account",
            "Roles",
            "Key scope",
            "Read by"
          ],
          "rows": [
            [
              "pipeline-builder/{orgId}/platform",
              "platform-automation",
              "org admin",
              "none",
              "CDK synth/deploy (--store-tokens), the plugin-lookup Lambda"
            ],
            [
              "pipeline-builder/{orgId}/registry-push",
              "registry-push",
              "none",
              "registry:push",
              "CodeBuild's secretsManagerCredentials"
            ],
            [
              "pipeline-builder/{orgId}/reporting-ingest",
              "reporting-ingest",
              "none",
              "reporting:ingest",
              "the event-ingestion Lambda"
            ]
          ]
        },
        {
          "type": "text",
          "content": "store-token creates the account if it is missing, issues the key, writes the secret, and only then retires the key the previous run stored — so an interrupted run never leaves an empty secret."
        },
        {
          "type": "text",
          "content": "--scope takes exactly the two catalogued values above (registry:push, reporting:ingest); each selects its own service account. With no --scope the key is issued on the org's single full-privilege platform-automation account. --account <name> overrides the account a key lands on, and --dry-run shows what would be provisioned without calling platform or writing to Secrets Manager — worth doing once per AWS account before the real run."
        },
        {
          "type": "text",
          "content": "Provisioning, per AWS account"
        },
        {
          "type": "text",
          "content": "Both writes are step-up gated, so store-token needs the operator's password. Put it in the environment rather than on the command line (it shows in shell history and in provision plan output):"
        },
        {
          "type": "code",
          "content": "export PLATFORM_BASE_URL=https://<your-platform>\nexport PLATFORM_PASSWORD='…'          # the operator's own password\nexport AWS_REGION=<region>\n\npipeline-manager infra store-token --schedule\n\npipeline-manager infra store-token --scope registry:push --schedule\n\npipeline-manager infra store-token --scope reporting:ingest --schedule\n\npipeline-manager infra setup-events --scoped-ingest",
          "language": "bash"
        },
        {
          "type": "text",
          "content": "Then synth and deploy every pipeline (pipeline-manager pipeline synth --id <id> --store-tokens, then deploy) so each build wires …/registry-push into its build image. A pipeline synthesised before the registry-push secret existed falls back to …/platform, which works but hands CodeBuild a full-privilege credential — the whole point of the scoped account is unmet."
        },
        {
          "type": "text",
          "content": "What --schedule now installs"
        },
        {
          "type": "text",
          "content": "The daily Lambda is a key rotator, not a token re-minter. It no longer npm-installs the CLI at runtime; it calls two pre-auth platform endpoints where the key itself is the authorization, in this order:"
        },
        {
          "type": "list",
          "items": [
            "POST /auth/key/rotate — mint a sibling key. The current key stays live.",
            "PutSecretValue — the secret now names the new key.",
            "POST /auth/key/revoke — retire the predecessor, authenticated with the new key."
          ]
        },
        {
          "type": "text",
          "content": "A failure at step 1 leaves the secret untouched; at step 2, the secret still names the live old key; at step 3, both keys work and the stale one expires on its own (logged at ERROR, not retried — a retry would rotate again). There is no ordering in which the deployment is left without a working credential."
        },
        {
          "type": "text",
          "content": "Verifying"
        },
        {
          "type": "code",
          "content": "pipeline-manager infra audit-tokens --region <region>",
          "language": "bash"
        },
        {
          "type": "text",
          "content": "A secret that does not hold a key — empty, or holding anything JWT-shaped — is reported as UNUSABLE with the fix named, rather than being left to fail later as an opaque 401 from three different services. The same guard is built into the consumers: the events Lambda and the rotator both refuse a non-key at startup with a message naming store-token."
        },
        {
          "type": "text",
          "content": "In the UI, Settings → Service Accounts lists the three accounts, their Roles (two of them hold none) and their keys. Dashboard → API Tokens shows the same keys labelled with the owning account."
        },
        {
          "type": "text",
          "content": "Why none of these is a person"
        },
        {
          "type": "table",
          "headers": [
            "Job",
            "What it holds",
            "Why not a person's credential"
          ],
          "rows": [
            [
              "store-token",
              "service-account key on platform-automation",
              "a machine-session JWT would inherit the operator's authority and outlive them"
            ],
            [
              "the daily Lambda",
              "key rotator (rotate → store → revoke)",
              "re-minting under a person's session ties the fleet to one account"
            ],
            [
              "events Lambda",
              "a key it exchanges per batch",
              "it verifies nothing itself; the exchange is the check"
            ],
            [
              "CodeBuild",
              "registry:push-scoped key, no API permissions",
              "a full-privilege secret in a build container is the blast radius"
            ],
            [
              "deploy plugin/template/compliance loads",
              "the system-org setup service account",
              "an admin-password re-login puts a human password in a script"
            ]
          ]
        }
      ]
    },
    {
      "id": "after-provisioning",
      "title": "After provisioning",
      "blocks": [
        {
          "type": "list",
          "items": [
            "Watch the exchange metrics. On platform:"
          ]
        },
        {
          "type": "text",
          "content": "platform_api_key_exchange_total{result=\"success\"} should rise to roughly (number of live keys) × (pods using them) per 5 minutes, and platform_api_key_exchange_failed_total{reason=\"unknown\"} should be zero. A reason=\"unknown\" that keeps climbing is an automation pointed at a key that was never issued or has been revoked — find it in the audit log (user.key.exchange.failed, which records the client IP and user-agent) rather than waiting for a ticket."
        },
        {
          "type": "list",
          "items": [
            "On the services, api_key_exchange_failures_total{reason=\"unavailable\"}"
          ]
        },
        {
          "type": "text",
          "content": "should be flat. A sustained non-zero value means the services cannot reach platform; those requests are answering 503, not silently passing."
        },
        {
          "type": "list",
          "items": [
            "Sweep the leftovers. The keys page flags keys that have never been used"
          ]
        },
        {
          "type": "text",
          "content": "— after a week those are almost always a duplicate issued while someone was getting their setup working. Revoke them."
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
            "Authentication → Access keys",
            "Authentication → Scoped keys and Self-rotation",
            "Audit Events — user.key.create, user.key.revoke, user.key.exchange, user.key.exchange.failed, org.service-account.key.rotate",
            "Secret Rotation — the overlap-window pattern the other secrets rotate with (access keys deliberately have none: a key is revoked, not overlapped). Once the credentials above are provisioned, the steady-state procedure for them is Secret Rotation → Service-account keys."
          ]
        }
      ]
    }
  ],
  "sourceDoc": "docs/runbooks/access-key-cutover.md"
};
