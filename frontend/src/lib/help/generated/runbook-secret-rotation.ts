// GENERATED FROM docs/runbooks/secret-rotation.md — DO NOT EDIT.
// Regenerate: npm run generate:help  (see frontend/scripts/generate-help.mjs)
// SOURCE-SHA256: 5f33002c61e6f29cc4caaf9a611bb78140944d0d0de577bde8c1c2c952f16110
// SPDX-License-Identifier: Apache-2.0
import { KeyRound } from 'lucide-react';
import type { HelpTopic } from '../types';

export const runbookSecretRotationTopic: HelpTopic = {
  "icon": KeyRound,
  "id": "runbook-secret-rotation",
  "title": "Runbook: Secret Rotation",
  "description": "Rotate any secret with zero downtime — overlap windows, restart order, verification, rollback",
  "sections": [
    {
      "id": "overview",
      "title": "Overview",
      "blocks": [
        {
          "type": "text",
          "content": "Every rotatable secret rotates the same way: add the new value while the old one is still accepted, cut over, then remove the old one."
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
            "The overlap window is the whole point. Both values live at once, which is what makes a rotation cost zero logouts, zero dropped alerts and zero unreadable secrets.",
            "An unfinished rotation is not a rotation. While a _PREVIOUS value is set, the old credential still works — including the compromised one you are rotating away from.",
            "SecretRotationPreviousLingering fires after 24h of a lingering overlap. Finish the rotation or explain the alert; do not silence it.",
            "Empty means \"not rotating\". That is the steady state, and every .env.example ships these keys empty.",
            "Three secrets express overlap differently — the user-token key keeps the retiring kid published in JWKS, the per-service keys keep it in the shared bundle, and image-registry uses a two-certificate trust bundle.",
            "Four have no overlap window, by nature: service-account keys, SAML service-provider keys, the plugin-signing key, and DB_REPLICATION_PASSWORD.",
            "The user-token overlap must outlive the longest refresh token (REFRESH_TOKEN_EXPIRES_IN, 30 days by default) or devices that have not refreshed get signed out.",
            "Roll a public bundle out BEFORE its private key, never the other way around."
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
          "content": "This runbook is for operators. Each section below is one secret: what it protects, how its overlap works, the exact steps, how to verify, and how to roll back."
        },
        {
          "type": "text",
          "content": "The overlap value is usually the same key name with a _PREVIOUS suffix — SECRET_ENCRYPTION_KEY_PREVIOUS, ALERT_WEBHOOK_INSTANCE_TOKEN_PREVIOUS, TOKEN_SIGNING_KEY_PREVIOUS_FILE."
        },
        {
          "type": "text",
          "content": "The datastore credentials — Postgres, Mongo, the Mongo keyfile — have no overlap mechanism and are covered in Deploy Operations instead."
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
            "Add the new value alongside the old one. The old stays accepted; nothing has changed for any caller yet.",
            "Roll the consumers so they all hold both values. For a public/private pair, the public bundle goes first.",
            "Cut over — start signing, encrypting or authenticating with the new value.",
            "Wait out the longest-lived artifact made with the old one. For the user-token key that is the longest refresh token.",
            "Remove the old value and roll again. The rotation is now finished.",
            "Confirm the metric cleared. Every service exports secret_rotation_previous_set{service,secret} 1 while its overlap value is set."
          ]
        },
        {
          "type": "text",
          "content": "The four without an overlap window"
        },
        {
          "type": "table",
          "headers": [
            "Secret",
            "Why not, and what happens instead"
          ],
          "rows": [
            [
              "Service-account key",
              "Revoked rather than overlapped — the account simply holds two live keys for a while, which is the same idea reached from the other end"
            ],
            [
              "SAML service-provider keys",
              "The trust lives in each customer's IdP, not in our config, so it is an announced, coordinated event"
            ],
            [
              "Plugin-signing key",
              "A signature cannot outlive the key that made it, so rotating means re-signing every plugin image"
            ],
            [
              "DB_REPLICATION_PASSWORD",
              "A Postgres role holds exactly one password, and each standby has the old one baked into its primary_conninfo. There is nowhere to put a second value, so the standbys are re-seeded instead"
            ]
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
            "Use the helpers, not an editor. pb_rotate_env_secret and pb_finish_env_rotation from deploy/bin/gen-env-secrets.sh — hand-editing .env is how half-finished rotations happen.",
            "Know where the value lives for your target before you start — see Where the values live, per target.",
            "On the k8s targets, update the Secret, not just .env, then kubectl rollout restart the affected Deployments.",
            "Follow that secret's own section below. Each has its own ordering constraint, and getting the order wrong is the failure mode.",
            "Watch secret_rotation_previous_set and finish within 24h, or SecretRotationPreviousLingering will fire.",
            "Back up .env, certs/ and mongodb-keyfile first. They are not in any database backup — see Deploy Operations → What is NOT backed up."
          ]
        }
      ]
    },
    {
      "id": "where-the-values-live-per-target",
      "title": "Where the values live, per target",
      "blocks": [
        {
          "type": "table",
          "headers": [
            "Target",
            "Source of truth",
            "How processes receive it",
            "Recreate secrets with"
          ],
          "rows": [
            [
              "docker",
              "deploy/local/docker/.env",
              "docker-compose.yml → x-common-env (${SECRET_ENCRYPTION_KEY_PREVIOUS:-} …)",
              "nothing to recreate — recreate containers"
            ],
            [
              "minikube",
              "deploy/local/minikube/.env",
              "app-env ConfigMap + app-secrets Secret (envFrom), plus the service-key-* and alertmanager-relay Secrets",
              "deploy/local/minikube/bin/setup.sh re-run, or the targeted kubectl patch below"
            ],
            [
              "aws/ec2",
              "deploy/aws/ec2/.env (on the instance)",
              "same Secrets as minikube, created by deploy/bin/k8s-resources.sh (pb_create_app_secrets, pb_create_token_signing_secret, pb_create_plugin_signing_secrets)",
              "kubectl patch below, or re-run bin/startup.sh"
            ],
            [
              "aws/eks",
              "deploy/aws/eks/.env",
              "same as ec2",
              "kubectl patch below, or re-run bin/setup.sh"
            ]
          ]
        },
        {
          "type": "text",
          "content": "The signing KEYS are not env values: they are files. The user-token key lives in deploy/<target>/certs/token-signing/ (bind-mounted into platform under compose, mounted from the token-signing-key Secret on the cluster targets) or in KMS under an alias; the per-service internal keys live in deploy/<target>/certs/service-keys/ (one bind mount / one service-key-<name> Secret each, plus the public bundle.json everywhere). .env only says where."
        },
        {
          "type": "text",
          "content": "Key-by-key:"
        },
        {
          "type": "table",
          "headers": [
            "Secret",
            "Held by",
            "Lives in"
          ],
          "rows": [
            [
              "user-token signing key (ES256)",
              "platform only",
              "deploy/*/certs/token-signing/token-signing.key → k8s token-signing-key Secret; or AWS KMS under TOKEN_SIGNING_KMS_KEY_ID"
            ],
            [
              "per-service signing keys (ES256) — internal service tokens",
              "each service holds ONLY its own",
              "deploy/*/certs/service-keys/<svc>.key → k8s service-key-<svc> Secret; public halves in bundle.json → service-key-bundle"
            ],
            [
              "SECRET_ENCRYPTION_KEY (+ _PREVIOUS)",
              "platform, and pipeline (per-org runner signing keys)",
              ".env; k8s app-secrets Secret"
            ],
            [
              "ALERT_WEBHOOK_INSTANCE_TOKEN (+ _PREVIOUS)",
              "ops-center (verifier) + Alertmanager (sender)",
              ".env; k8s alertmanager-relay Secret; ops-center's ALERT_WEBHOOK_INSTANCES JSON"
            ],
            [
              "image-registry signing key",
              "image-registry (signs) + the Docker registry (verifies)",
              "deploy/*/certs/image-registry-jwt.{key,crt} (docker); k8s registry-token-secret"
            ],
            [
              "plugin-signing key (cosign, EC P-256) — plugin images + SBOM attestations",
              "image-registry only (signs); plugin holds the PUBLIC key (verifies)",
              "deploy/*/certs/plugin-signing/plugin-signing.key → k8s plugin-signing-key Secret, or AWS KMS under PLUGIN_SIGNING_KMS_KEY_ID; public half plugin-signing.pub → plugin-signing-public-key"
            ],
            [
              "SAML service-provider keys (signing, encryption, test-marker)",
              "platform only",
              "Mongo, collection saml_sp_keys — private halves wrapped under SECRET_ENCRYPTION_KEY. Nothing on disk, nothing in .env"
            ]
          ]
        },
        {
          "type": "text",
          "content": "Shared mechanics"
        },
        {
          "type": "text",
          "content": "Two helpers in deploy/bin/gen-env-secrets.sh do the .env edits (source the file first — it only defines functions):"
        },
        {
          "type": "code",
          "content": "cd deploy/<target>\n. ../../bin/gen-env-secrets.sh            # path relative to the target dir\npb_rotate_env_secret .env SECRET_ENCRYPTION_KEY hex   # old → *_PREVIOUS, new generated\npb_finish_env_rotation .env SECRET_ENCRYPTION_KEY     # clears *_PREVIOUS",
          "language": "bash"
        },
        {
          "type": "text",
          "content": "pb_rotate_env_secret refuses to run when the key is absent or empty (it will not blank a live secret on a typo) and takes hex as a third argument for SECRET_ENCRYPTION_KEY, which must decode to exactly 32 bytes."
        },
        {
          "type": "text",
          "content": "On the k8s targets, .env is only the input: the running pods read Secrets. Either re-run the target's setup script (idempotent) or patch directly:"
        },
        {
          "type": "code",
          "content": "NS=pipeline-builder\nkubectl -n $NS patch secret app-secrets -p \\\n  \"{\\\"stringData\\\":{\\\"SECRET_ENCRYPTION_KEY\\\":\\\"$NEW\\\",\\\"SECRET_ENCRYPTION_KEY_PREVIOUS\\\":\\\"$OLD\\\"}}\"",
          "language": "bash"
        },
        {
          "type": "text",
          "content": "app-secrets is what the services read via envFrom (pb_split_app_env routes every *_PREVIOUS key to the Secret, never to the app-env ConfigMap). A key can also live in a dedicated Secret — ALERT_WEBHOOK_INSTANCE_TOKEN is in both app-secrets and alertmanager-relay — so patch both when it does."
        },
        {
          "type": "text",
          "content": "On docker, recreating a container is what re-reads .env:"
        },
        {
          "type": "code",
          "content": "cd deploy/local/docker\ndocker compose up -d --force-recreate platform nginx image-registry   # …or the services listed per-secret below",
          "language": "bash"
        }
      ]
    },
    {
      "id": "user-token-signing-key-es256-rotated-by-kid",
      "title": "User-token signing key (ES256, rotated by kid)",
      "blocks": [
        {
          "type": "text",
          "content": "Signs every token that speaks for a person: access, refresh, step-up and the short-lived token an opaque access key is exchanged for. Platform is the only holder. Every other verifier — each service via api-core, the pipeline-manager CLI, image-registry's /token mint path and the pipeline-events Lambda — checks signatures against the public keys platform publishes at /.well-known/jwks.json (unauthenticated, cached 10 minutes, refetched once on an unknown kid)."
        },
        {
          "type": "text",
          "content": "There is no shared secret to distribute, so a rotation is a key rotation: publish both keys, switch signing, then stop publishing the old one. Verifiers need no restart and no config change — they pick the new kid up from the JWKS."
        },
        {
          "type": "text",
          "content": "Schedule. Rotate on a 12-month cadence at minimum, and immediately on suspicion of exposure (see Compromise response below). Because the overlap window has to outlive the longest refresh token, plan the whole rotation as ~35 days: cut over on day 0, finish after REFRESH_TOKEN_EXPIRES_IN (30 days) plus a few days of margin. A deployment that shortens REFRESH_TOKEN_EXPIRES_IN shortens the window with it. Diary the finish step — the SecretRotationPreviousLingering alert will be firing for the whole window, which is expected, and the point of the diary entry is that it stops."
        },
        {
          "type": "text",
          "content": "Two signers, chosen by TOKEN_SIGNING_MODE:"
        },
        {
          "type": "table",
          "headers": [
            "Mode",
            "Where the private key lives",
            "Rotate with"
          ],
          "rows": [
            [
              "local (docker, minikube, and the AWS default)",
              "deploy/<target>/certs/token-signing/token-signing.key, mounted into platform at /etc/pipeline-builder/keys",
              "deploy/bin/token-signing-keys.sh <cert_dir> --rotate"
            ],
            [
              "kms (recommended on AWS)",
              "AWS KMS, asymmetric ECC_NIST_P256, SIGN_VERIFY; platform holds only kms:Sign + kms:GetPublicKey",
              "create a second KMS key, swap the two env vars"
            ]
          ]
        },
        {
          "type": "text",
          "content": "Steps — local mode"
        },
        {
          "type": "list",
          "items": [
            "Roll the key. The current key is retired to token-signing-previous.key and a"
          ]
        },
        {
          "type": "text",
          "content": "fresh one takes its place: bash bash deploy/bin/token-signing-keys.sh deploy/<target>/certs --rotate"
        },
        {
          "type": "list",
          "items": [
            "Point platform at the retiring key so it stays PUBLISHED (this is the overlap"
          ]
        },
        {
          "type": "text",
          "content": "window — without it every live session dies at the cutover): bash # deploy/<target>/.env TOKEN_SIGNING_KEY_PREVIOUS_FILE=/etc/pipeline-builder/keys/token-signing-previous.key"
        },
        {
          "type": "list",
          "items": [
            "Push the key material and restart platform only — no other service holds"
          ]
        },
        {
          "type": "text",
          "content": "or reads it: bash # k8s targets . deploy/bin/k8s-resources.sh pb_create_token_signing_secret deploy/<target>/certs/token-signing/token-signing.key \\ deploy/<target>/certs/token-signing/token-signing-previous.key kubectl -n pipeline-builder rollout restart deploy/platform # docker cd deploy/local/docker && docker compose up -d --force-recreate platform"
        },
        {
          "type": "list",
          "items": [
            "Confirm both keys are published, and that new tokens carry the new kid:"
          ]
        },
        {
          "type": "text",
          "content": "bash curl -sk https://<host>/.well-known/jwks.json | jq '.keys[].kid' # two entries"
        },
        {
          "type": "list",
          "items": [
            "AWS event ingestion / CodeBuild: nothing to do. The stored credentials are"
          ]
        },
        {
          "type": "text",
          "content": "opaque service-account keys, not JWTs — they carry no signature, are exchanged for a fresh token every few minutes, and are therefore unaffected by a signing-key rotation."
        },
        {
          "type": "list",
          "items": [
            "Wait out the longest-lived token signed with the old key. Access and step-up"
          ]
        },
        {
          "type": "text",
          "content": "tokens are minutes; refresh tokens live REFRESH_TOKEN_EXPIRES_IN (30 days by default), and they are signed with this key too — so ending the overlap earlier signs out every device that has not refreshed since the cutover. That is the trade-off to decide deliberately."
        },
        {
          "type": "list",
          "items": [
            "Finish: clear TOKEN_SIGNING_KEY_PREVIOUS_FILE, delete"
          ]
        },
        {
          "type": "text",
          "content": "token-signing-previous.key, re-create the Secret and restart platform. The old kid disappears from the JWKS and tokens signed with it stop verifying everywhere within one JWKS refresh (10 minutes)."
        },
        {
          "type": "text",
          "content": "Steps — kms mode"
        },
        {
          "type": "text",
          "content": "Same shape; only the key handling differs."
        },
        {
          "type": "list",
          "items": [
            "Create the incoming key and alias it:"
          ]
        },
        {
          "type": "text",
          "content": "bash KEY=$(aws kms create-key --key-spec ECC_NIST_P256 --key-usage SIGN_VERIFY \\ --query KeyMetadata.KeyId --output text) aws kms create-alias --alias-name alias/pipeline-builder-token-signing-next \\ --target-key-id \"$KEY\"  Grant platform's role kms:Sign + kms:GetPublicKey on it. Always reference keys by alias, never by ARN — an ARN embeds the AWS account id, which must never reach config, logs, a token or the JWKS."
        },
        {
          "type": "list",
          "items": [
            "Set TOKEN_SIGNING_KMS_KEY_PREVIOUS_ID to the CURRENT alias and"
          ]
        },
        {
          "type": "text",
          "content": "TOKEN_SIGNING_KMS_KEY_ID to the incoming one, then restart platform. Both kids are now published; the incoming key signs."
        },
        {
          "type": "list",
          "items": [
            "Steps 4–6 above, unchanged.",
            "Finish: clear TOKEN_SIGNING_KMS_KEY_PREVIOUS_ID, restart platform, and"
          ]
        },
        {
          "type": "text",
          "content": "schedule the old KMS key for deletion once you are certain (aws kms schedule-key-deletion). Deleting it early only affects signing, which has already moved — but the kid must be out of the JWKS first, or verifiers would keep accepting tokens whose key no longer exists."
        },
        {
          "type": "text",
          "content": "Compromise response"
        },
        {
          "type": "text",
          "content": "A leaked signing key means anyone can mint a token for any user, so do NOT use the overlap window: rotate with no *_PREVIOUS value at all. Every session, access key token and step-up token dies immediately, and everyone signs in again — which is the correct outcome. Follow it with a fleet-wide tokenVersion bump if the leak may have been used."
        },
        {
          "type": "text",
          "content": "Verify"
        },
        {
          "type": "list",
          "items": [
            "curl -sk https://<host>/.well-known/jwks.json lists the expected kids.",
            "secret_rotation_previous_set{secret=\"TOKEN_SIGNING_KEY\"} → 1 during the"
          ]
        },
        {
          "type": "text",
          "content": "window, 0 after the final step (platform reports this from the signer, not from an env var — it is 1 exactly while a retiring key is published)."
        },
        {
          "type": "list",
          "items": [
            "jwks_fetch_total{result=\"success\"} keeps incrementing on the other services;"
          ]
        },
        {
          "type": "text",
          "content": "a spike of result=\"error\" means they cannot reach the key set, and the JwksFetchFailing alert (critical) fires after 10 minutes. Verifiers FAIL CLOSED with 503 once their cached set goes stale, so treat that as an outage."
        },
        {
          "type": "list",
          "items": [
            "A user who signed in before step 1 can still call the API during the"
          ]
        },
        {
          "type": "text",
          "content": "window, and is signed out only after the final step if they never refreshed."
        },
        {
          "type": "text",
          "content": "Rollback — before the final step, swap the two key settings back (the retiring key is still on disk / still in KMS) and restart platform. After it, rolling back means another rotation, and every session signed with the new key is invalidated."
        },
        {
          "type": "text",
          "content": "Proof — platform/test/token-signing.test.ts (both signers, the JWKS document, rotation overlap), platform/test/jwt-options-parity.test.ts (platform ↔ api-core agreement, including the rotation), packages/api-core/test/jwt-rotation.test.ts (verifier-side kid rotation, unknown-kid refetch, fail-closed), platform/test/refresh-token-rotation.test.ts (the refresh-token half), api/image-registry/test/platform-jwt-rotation.test.ts (/token mint path)."
        }
      ]
    },
    {
      "id": "internal-service-signing-keys-es256-per-service",
      "title": "Internal service signing keys (ES256, per service)",
      "blocks": [
        {
          "type": "text",
          "content": "Each service signs the short-lived (5-minute) service:<name> tokens it presents to its peers with its own EC P-256 key (api-core's signServiceToken), and verifies its peers against the shared PUBLIC bundle. There is no shared secret: the kid selects the key and names its owner, and the token's sub must agree, so one service cannot speak for another. Rotating a key affects inter-service calls, not sessions — nobody is logged out."
        },
        {
          "type": "text",
          "content": "The overlap is expressed in the bundle, not in an env value: while a rotation is open, the bundle publishes TWO public keys for that service, so tokens signed either side of the cutover verify. deploy/bin/service-signing-keys.sh handles both halves."
        },
        {
          "type": "text",
          "content": "Steps (one service at a time, or --rotate-all)"
        },
        {
          "type": "list",
          "items": [
            "Generate the incoming key and republish the bundle. The retiring key is moved"
          ]
        },
        {
          "type": "text",
          "content": "aside and its PUBLIC half stays in the bundle: bash bash deploy/bin/service-signing-keys.sh deploy/<target>/certs --rotate billing"
        },
        {
          "type": "list",
          "items": [
            "Roll the BUNDLE out everywhere FIRST. It is public, and every service"
          ]
        },
        {
          "type": "text",
          "content": "reads it — if the rotated service starts signing before its peers trust the new kid, every call it makes 401s."
        },
        {
          "type": "list",
          "items": [
            "docker: nothing to push (the file is bind-mounted); recreate the containers"
          ]
        },
        {
          "type": "text",
          "content": "so they re-read it, or just wait — the bundle is re-read on mtime change and at least every 5 minutes, so a rolling pickup needs no restart at all."
        },
        {
          "type": "list",
          "items": [
            "k8s: re-run the target's setup script, or patch the one Secret:"
          ]
        },
        {
          "type": "text",
          "content": "bash kubectl -n pipeline-builder create secret generic service-key-bundle \\ --from-file=bundle.json=deploy/<target>/certs/service-keys/bundle.json \\ --dry-run=client -o yaml | kubectl apply -f -"
        },
        {
          "type": "list",
          "items": [
            "Now push the rotated service's PRIVATE key and restart only that service:"
          ]
        },
        {
          "type": "text",
          "content": "bash kubectl -n pipeline-builder create secret generic service-key-billing \\ --from-file=service.key=deploy/<target>/certs/service-keys/billing.key \\ --dry-run=client -o yaml | kubectl apply -f - kubectl -n pipeline-builder rollout restart deploy/billing  docker: docker compose up -d --force-recreate billing."
        },
        {
          "type": "list",
          "items": [
            "Wait 5 minutes (the service-token TTL) so no token signed with the old key is"
          ]
        },
        {
          "type": "text",
          "content": "still in flight."
        },
        {
          "type": "list",
          "items": [
            "Finish — drop the retiring key from disk and from the bundle, then re-push the"
          ]
        },
        {
          "type": "text",
          "content": "bundle as in step 2: bash bash deploy/bin/service-signing-keys.sh deploy/<target>/certs --finish billing"
        },
        {
          "type": "text",
          "content": "Verify"
        },
        {
          "type": "list",
          "items": [
            "secret_rotation_previous_set{secret=\"SERVICE_SIGNING_KEY\"} → 1 on the"
          ]
        },
        {
          "type": "text",
          "content": "rotated service during the window, 0 after step 5."
        },
        {
          "type": "list",
          "items": [
            "No burst of 401/403 on internal routes; cross-service features (quota"
          ]
        },
        {
          "type": "text",
          "content": "increments, compliance checks, entity events) keep working throughout."
        },
        {
          "type": "list",
          "items": [
            "internal_route_refused_total does not climb."
          ]
        },
        {
          "type": "text",
          "content": "Rollback — the retiring key is still on disk and still published until step 5: move <svc>-previous.key back to <svc>.key, re-push that Secret and restart."
        },
        {
          "type": "text",
          "content": "Proof — packages/api-core/test/secret-rotation.test.ts (the bundle-overlap drill), packages/api-core/test/jwt-rotation.test.ts (retiring key accepted, dropped key refused, wrong-signer refused), platform/test/jwt-options-parity.test.ts (platform ↔ api-core agreement)."
        }
      ]
    },
    {
      "id": "secret-encryption-key",
      "title": "SECRET_ENCRYPTION_KEY",
      "blocks": [
        {
          "type": "text",
          "content": "The AES-256-GCM master key behind every encrypted-at-rest secret. Platform and pipeline hold it (pipeline for the per-org runner signing keys). Five stores are wrapped under it, and they do not all migrate the same way:"
        },
        {
          "type": "table",
          "headers": [
            "Store",
            "What it holds",
            "Migrated by"
          ],
          "rows": [
            [
              "Organization.aiProviderKeys.*",
              "org AI provider keys",
              "scripts/reencrypt-secrets.js"
            ],
            [
              "OrgIdpConfig.clientSecretEncrypted",
              "per-org SSO (OIDC) client secrets",
              "scripts/reencrypt-secrets.js"
            ],
            [
              "UserTotp.secret",
              "each account's authenticator-app secret",
              "scripts/reencrypt-secrets.js"
            ],
            [
              "saml_sp_keys.privateKeyEncrypted",
              "this deployment's SAML SP signing / encryption / test-marker keys",
              "scripts/reencrypt-secrets.js"
            ],
            [
              "pipeline_runner_signing_keys.private_key_enc (Postgres)",
              "every org's runner signing keys",
              "the pipeline re-encrypt job, which scripts/reencrypt-secrets.js calls — see Runner signing keys"
            ]
          ]
        },
        {
          "type": "text",
          "content": "The tool covers all five; the fifth through the pipeline service. Two stores are not per-org — UserTotp is salted per USER (user:<userId>) and the SAML SP keys per DEPLOYMENT (saml-sp-keys) — so the tool walks them separately and reports a count for each store; verify those counts (steps 4 and 5) before clearing SECRET_ENCRYPTION_KEY_PREVIOUS."
        },
        {
          "type": "text",
          "content": "This one is different from every other secret here: the old key is needed to read existing rows, so the overlap window is not about tokens in flight — it is the time it takes to re-encrypt the stored data. SECRET_ENCRYPTION_KEY_PREVIOUS is decrypt-only; new writes always use the current key."
        },
        {
          "type": "text",
          "content": "Steps"
        },
        {
          "type": "list",
          "items": [
            "Rotate (hex — the key must decode to 32 bytes):"
          ]
        },
        {
          "type": "text",
          "content": "bash . deploy/bin/gen-env-secrets.sh pb_rotate_env_secret deploy/<target>/.env SECRET_ENCRYPTION_KEY hex"
        },
        {
          "type": "list",
          "items": [
            "Push app-secrets (k8s) and restart platform and pipeline. Reads now"
          ]
        },
        {
          "type": "text",
          "content": "fall back to the previous key; writes use the new one."
        },
        {
          "type": "list",
          "items": [
            "Re-encrypt every stored blob, inside a platform container so it inherits"
          ]
        },
        {
          "type": "text",
          "content": "the same key material and per-org KMS setting: bash # k8s targets kubectl -n pipeline-builder exec deploy/platform -- node scripts/reencrypt-secrets.js # docker docker compose exec platform node scripts/reencrypt-secrets.js  It walks every org, every IdP config, every authenticator enrolment and the SAML SP keys, decrypts each through the fallback and rewrites under the current key, then calls the pipeline service's runner-signing-key re-encrypt (a runner-key failure also makes it exit 1). It exits non-zero and lists each row it could not decrypt — such a row's secret was written under a key you no longer have and must be re-entered by the org admin (AI keys: Settings → AI providers; SSO: Admin → org → IdP). Re-run until it reports failures: 0."
        },
        {
          "type": "list",
          "items": [
            "Check the SAML service-provider keys migrated. Step 3 reports"
          ]
        },
        {
          "type": "text",
          "content": "samlSpKeysReencrypted — expect one per generated purpose (signing, encryption, test-marker). The keys keep their identity, so no org has to re-import metadata. Only if a key is listed under failures do you fall back to regenerating it — see SAML service-provider keys, which obliges each SSO org to re-import. Do that here, while the previous key is still set, so a failure is recoverable. A deployment with no SAML org configured has nothing to check: the documents are generated on first use."
        },
        {
          "type": "list",
          "items": [
            "Check the authenticator enrolments migrated. Step 3 reports"
          ]
        },
        {
          "type": "text",
          "content": "totpSecretsReencrypted; it should equal the number of active enrolments. Any enrolment it could not read is listed under failures with the scope user:<userId> — that account must re-scan (Settings → Security → Authenticator app) before you clear the previous key, or sign in with a recovery code afterwards. Recovery codes are SHA-256 hashes rather than encrypted blobs, so they survive any rotation and are the way back in. Know the failure mode if an unreadable secret does reach production: the decrypt throws rather than returning a wrong answer, and that is not one of the TOTP sentinels, so the account sees a 500, not TOTP_INVALID_CODE — a ticket reading \"my authenticator broke the app\", not \"my code is wrong\"."
        },
        {
          "type": "text",
          "content": "A deployment whose second factors are all passkeys is unaffected: WebAuthn credentials store public keys, which are not encrypted at rest."
        },
        {
          "type": "list",
          "items": [
            "pb_finish_env_rotation deploy/<target>/.env SECRET_ENCRYPTION_KEY, re-push,"
          ]
        },
        {
          "type": "text",
          "content": "restart platform and pipeline."
        },
        {
          "type": "text",
          "content": "Verify"
        },
        {
          "type": "list",
          "items": [
            "Step 3 prints orgsScanned, aiKeysReencrypted, idpSecretsReencrypted,"
          ]
        },
        {
          "type": "text",
          "content": "totpSecretsReencrypted, samlSpKeysReencrypted and failures: 0. A zero count where rows exist is the tell that a store was skipped — check before step 6, not after."
        },
        {
          "type": "list",
          "items": [
            "After step 6, exercise a decrypt path — e.g. an AI generation for an org with"
          ]
        },
        {
          "type": "text",
          "content": "a stored provider key, an SSO login for an org with a client secret, a SAML sign-in for an org that uses signed requests or encrypted assertions, and a TOTP sign-in. A failure here means one of steps 3–5 missed something."
        },
        {
          "type": "list",
          "items": [
            "secret_rotation_previous_set{secret=\"SECRET_ENCRYPTION_KEY\"} back to 0."
          ]
        },
        {
          "type": "text",
          "content": "Rollback — until step 6, restore the previous key as SECRET_ENCRYPTION_KEY and restart; rows already rewritten under the new key then need the new key as _PREVIOUS (i.e. swap the two values) to stay readable. After step 6 there is no rollback — dropping the old key with rows still wrapped under it makes those secrets unrecoverable, which is exactly why step 3 gates on failures: 0 and why steps 4 and 5 are decided before it."
        },
        {
          "type": "text",
          "content": "Per-org KMS. Orgs with SECRET_ENCRYPTION_PER_ORG_KMS config are wrapped under their own CMK, not this master, and their blobs carry a kid; the shared previous key is never applied to them. Rotating an org's CMK is a separate flow (PUT /api/admin/orgs/:orgId/kms-config, which re-encrypts that org inline, including its runner signing keys through the pipeline re-encrypt job; a runner-key failure answers 500 — see the recovery below). Clearing it is the same migration: DELETE /api/admin/orgs/:orgId/kms-config falls the org back to the shared master, and since the org's platform secrets were wrapped under a key derived from its CMK — which the shared provider cannot open — the DELETE re-encrypts them under the shared provider exactly as a PUT does, runner signing keys included. Both mutations behave identically on failure. If a stored platform secret can't be decrypted under the current provider the PUT/DELETE refuses with 409 and changes nothing. Repair that row, or retry with ?reencrypt=false: that skips only the platform (MongoDB) secret re-encrypt, so the org's existing AI provider keys and SSO client secret become unreadable and must be re-entered. The runner signing key re-wrap still runs (it does not depend on the platform pass), and a failure there still answers 500. A failure mid-flight — the config already saved, the re-encrypt partly done — answers 500 and is audited as a failure: the change is NOT rolled back, so re-enter the affected secrets through their admin endpoints. If the message names the runner signing keys, the outgoing config is recorded on the org: once the cause is fixed (pipeline service reachable, CMK grant restored), call POST /api/admin/orgs/:orgId/kms-config/runner-keys/reencrypt (system admin, MFA session, step-up by passkey or authenticator code). It re-wraps the org's runner keys reading them under the current config, then the recorded outgoing one, then the shared provider; it is safe to repeat, answers 409 when nothing is pending, and clears the record on success. Re-sending the same PUT, or reencrypt-runner-keys --org, cannot do this: neither knows the outgoing config. While a re-wrap is pending, further PUT/DELETE of the org's KMS config are refused with 409 CONFLICT until the retry succeeds."
        },
        {
          "type": "text",
          "content": "One change at a time. The PUT/DELETE saves the new config only if the config it read (keyId and wrapped ciphertext) is still the org's current one. When two changes to the same org overlap, the first one to save wins. The other gets 409 CONFLICT before it re-encrypts anything and writes nothing. Re-read the config (GET) and retry if you still want that change."
        },
        {
          "type": "text",
          "content": "Secrets edited during the change are kept. Each re-encrypted AI provider key and the SSO client secret is written only if the stored value is still the one captured before the change. A secret that was set, replaced or deleted in the meantime is left exactly as that writer left it (never overwritten, never brought back), and its field name is listed in concurrentlyChanged in the response and audit row. If that concurrent value cannot be decrypted under the new config, it is also listed in unreadableConcurrentWrites and the audit row is marked as a failure. That happens when it was written by a replica that still had the old key cached (before the eviction reached it, or within the 5-minute TTL without Redis). Re-enter each listed secret through its admin endpoint."
        },
        {
          "type": "text",
          "content": "Every replica picks the change up without a restart. Each platform and pipeline process caches the org's unwrapped master. A PUT/DELETE evicts it on the platform replica that served the request and broadcasts the eviction over Redis pub/sub (the cache-invalidation channel, namespace per-org-kms:), so every other platform and pipeline replica drops it too and re-reads the org's config on the next secret read. A Redis reconnect clears the whole cache, because broadcasts may have been missed. As a backstop, with Redis down or not configured, a cached per-org key is trusted for at most 5 minutes, after which the next read re-resolves the config. If that refresh fails (the config source is unreachable), the cached key keeps serving and the refresh is retried 30 seconds later; an explicit eviction is never served stale. So without Redis, allow up to 5 minutes after a change before trusting reads on other replicas, or restart platform and pipeline."
        },
        {
          "type": "text",
          "content": "Post-change verification. The eviction closes the old-key window only on the replicas it reaches. A replica that misses it keeps encrypting new secrets under the outgoing key until its cached entry lapses, and those writes land after the change's own re-encrypt pass, so unreadableConcurrentWrites cannot see them. To catch them, every PUT/DELETE that saves a config also stamps a verification marker on the org (Organization.kmsVerifyDueAt) in the same write, due 6 minutes later (the 5-minute cache TTL plus a 1-minute margin). The platform sweep kms-config-verify (runs every minute, one replica at a time) then tries to decrypt each of the org's AI provider keys and its SSO client secret under the current config:"
        },
        {
          "type": "list",
          "items": [
            "Every secret opens: the marker is cleared and nothing is reported.",
            "Some do not: their field names only (aiProviderKeys.<provider>,"
          ]
        },
        {
          "type": "text",
          "content": "idpClientSecret, never values) are logged as an error, recorded as an admin.org.kms-config.verify audit row with outcome: failure and details.unreadableSecrets, counted in platform_kms_secret_verify_failed_total{field} (alert KmsSecretVerifyFailed), and sent to the org's owners and admins, in-app and by email, with a request to re-enter them. Nothing can recover these values; re-entry is the fix. If no admin can, re-enter them yourself through the same admin endpoints."
        },
        {
          "type": "list",
          "items": [
            "The provider cannot encrypt for the org at all (a KMS outage or a revoked"
          ]
        },
        {
          "type": "text",
          "content": "kms:Decrypt grant): that is not counted as unreadable secrets. The check fails, the sweep reports a failed cycle, and the check runs again after a 5-minute lease. Fix KMS access first (POST .../kms-config/test)."
        },
        {
          "type": "text",
          "content": "The marker survives a restart, and it is claimed by a conditional update, so only one replica runs each check. A crash mid-check leaves the lease, which comes due again. A second change before the check runs moves the marker, so only the newer change's check runs. A change that lands while a check is running makes that check drop its result unreported, because the newer change has its own check."
        },
        {
          "type": "text",
          "content": "A partial config (a stored keyId with no wrapped ciphertext, or the reverse) counts as no config: secrets are under the shared provider. DELETE removes it without migrating anything, conditionally on the org still having no complete config, and audits admin.org.kms-config.delete with details.partialConfigCleared: true. A PUT that completed the config meanwhile makes it answer 409 instead."
        },
        {
          "type": "text",
          "content": "Proof — packages/api-core/test/secret-rotation.test.ts (overlap → rewrite → old blob rejected), platform/test/secret-reencrypt.test.ts (the fleet-wide tool, including the unreadable-row path), packages/api-core/test/secret-encryption.test.ts (cross-replica eviction and the TTL backstop), platform/test/kms-config-verify.test.ts (the post-change verification: claim, supersede, KMS outage, report)."
        }
      ]
    },
    {
      "id": "db-replication-password-read-replicas",
      "title": "DB_REPLICATION_PASSWORD (read replicas)",
      "blocks": [
        {
          "type": "text",
          "content": "The login the read replicas use: pg_basebackup when a standby is seeded, and the standby's walreceiver to stream WAL afterwards. postgres-init.sql creates it as LOGIN REPLICATION and nothing else — no CREATEDB, no CREATEROLE, no BYPASSRLS, no table grants."
        },
        {
          "type": "text",
          "content": "Why it is not DB_PASSWORD. Replication streams WAL, and WAL sits below row-level security — a role that can replicate can read every org's rows regardless of policy. The application role is created NOREPLICATION deliberately, and postgres-init.sql raises if DB_REPLICATION_USER equals DB_USER rather than silently granting the services a way around tenant isolation."
        },
        {
          "type": "text",
          "content": "No overlap window, and the reason is structural. A Postgres role has exactly one password. Worse, each standby was seeded with pg_basebackup -R, which writes the credential into primary_conninfo in that standby's postgresql.auto.conf — so the old value is inside each standby's data directory, not in any config this repo manages. There is no second slot to put a new value in."
        },
        {
          "type": "text",
          "content": "So rotation is: change the password, then rebuild the standbys. They are disposable by design — they hold no unique data and reads fall back to the primary while they are gone."
        },
        {
          "type": "text",
          "content": "Steps"
        },
        {
          "type": "list",
          "items": [
            "Set the new value, on every target that has a replica. There is no"
          ]
        },
        {
          "type": "text",
          "content": "DB_REPLICATION_PASSWORD_PREVIOUS key, so pb_rotate_env_secret refuses this one; write the value directly:"
        },
        {
          "type": "text",
          "content": "bash . deploy/bin/gen-env-secrets.sh pb_set_env_value deploy/<target>/.env DB_REPLICATION_PASSWORD \"$(openssl rand -base64 32 | tr -d '=+/')\""
        },
        {
          "type": "list",
          "items": [
            "Apply it to the primary. On the k8s targets update postgres-secret and"
          ]
        },
        {
          "type": "text",
          "content": "restart nothing — the role's password is changed with SQL, not by a restart:"
        },
        {
          "type": "text",
          "content": "bash kubectl exec -n pipeline-builder deploy/postgres -c postgres -- \\ psql -U \"$POSTGRES_USER\" -d postgres -c \\ \"ALTER ROLE \\\"$DB_REPLICATION_USER\\\" WITH PASSWORD '$DB_REPLICATION_PASSWORD'\""
        },
        {
          "type": "text",
          "content": "postgres-init.sql would also do this, but only on a first init — it does not run against an existing data directory, so do not rely on it here."
        },
        {
          "type": "list",
          "items": [
            "Expect the standbys to break, and let them. Their walreceiver now"
          ]
        },
        {
          "type": "text",
          "content": "authenticates with the old password and will log password authentication failed for user \"...\". Reads fall back to the primary automatically (the lag circuit sees replay stop advancing), so this is a throughput event, not an outage."
        },
        {
          "type": "list",
          "items": [
            "Re-seed each standby. Delete the pod and its volume so the init"
          ]
        },
        {
          "type": "text",
          "content": "container clones again with the new credential:"
        },
        {
          "type": "text",
          "content": "bash kubectl delete pvc -n pipeline-builder postgres-replica-data-postgres-replica-0 kubectl delete pod -n pipeline-builder postgres-replica-0"
        },
        {
          "type": "text",
          "content": "Repeat per ordinal. One at a time if more than one replica is configured — each clone loads the primary, which is the thing being protected."
        },
        {
          "type": "list",
          "items": [
            "Drop the orphaned replication slots on the primary. A re-seeded standby"
          ]
        },
        {
          "type": "text",
          "content": "creates a new slot; the old one stays and retains WAL forever, which is the failure mode max_slot_wal_keep_size and PostgresReplicationSlotRetainedBytes exist for:"
        },
        {
          "type": "text",
          "content": "bash kubectl exec -n pipeline-builder deploy/postgres -c postgres -- \\ psql -U \"$POSTGRES_USER\" -d postgres -c \\ \"SELECT slot_name, active, pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn)) AS retained FROM pg_replication_slots\""
        },
        {
          "type": "text",
          "content": "Drop any slot that is active = f and not claimed by a running standby: SELECT pg_drop_replication_slot('<name>')."
        },
        {
          "type": "list",
          "items": [
            "Confirm replication resumed before considering it done — a standby that"
          ]
        },
        {
          "type": "text",
          "content": "is Ready is not necessarily streaming:"
        },
        {
          "type": "text",
          "content": "bash kubectl exec -n pipeline-builder deploy/postgres -c postgres -- \\ psql -U \"$POSTGRES_USER\" -d postgres -c \"SELECT client_addr, state, sync_state FROM pg_stat_replication\""
        },
        {
          "type": "text",
          "content": "On docker, the equivalent is docker compose rm -sf postgres-replica plus deleting deploy/local/docker/data/db-data/postgres-replica/, then docker compose up -d postgres-replica."
        }
      ]
    },
    {
      "id": "alert-webhook-instance-token-alert-relay",
      "title": "ALERT_WEBHOOK_INSTANCE_TOKEN (alert relay)",
      "blocks": [
        {
          "type": "text",
          "content": "The bearer Alertmanager presents to ops-center's POST /observability/alert-webhook (and its other webhook receivers), which fans alerts out to each org's destinations. Two sides: ops-center verifies (ALERT_WEBHOOK_INSTANCES, one entry per Alertmanager instance) and Alertmanager sends (a mounted credentials_file). ops-center accepts the entry's previousToken while it is non-empty."
        },
        {
          "type": "text",
          "content": "Order matters: teach the verifier the new token before the sender starts sending it."
        },
        {
          "type": "list",
          "items": [
            "pb_rotate_env_secret deploy/<target>/.env ALERT_WEBHOOK_INSTANCE_TOKEN",
            "Push the alertmanager-relay Secret (both keys) and restart ops-center"
          ]
        },
        {
          "type": "text",
          "content": "first. It now accepts old and new. bash kubectl -n pipeline-builder patch secret alertmanager-relay -p \\ \"{\\\"stringData\\\":{\\\"ALERT_WEBHOOK_INSTANCE_TOKEN\\\":\\\"$NEW\\\",\\\"ALERT_WEBHOOK_INSTANCE_TOKEN_PREVIOUS\\\":\\\"$OLD\\\"}}\" kubectl -n pipeline-builder rollout restart deploy/ops-center"
        },
        {
          "type": "list",
          "items": [
            "Restart Alertmanager so it picks up the new token file"
          ]
        },
        {
          "type": "text",
          "content": "(rollout restart deploy/alertmanager; docker: docker compose up -d --force-recreate alertmanager ops-center)."
        },
        {
          "type": "list",
          "items": [
            "pb_finish_env_rotation deploy/<target>/.env ALERT_WEBHOOK_INSTANCE_TOKEN,"
          ]
        },
        {
          "type": "text",
          "content": "re-push the Secret, restart ops-center."
        },
        {
          "type": "text",
          "content": "Verify — fire a test alert (or watch the next real one) and confirm Alert relay processed in the ops-center log with no Alert webhook unknown instance / Unauthorized warnings. Between steps 2 and 3 both tokens must work; after step 4 the old one must 401:"
        },
        {
          "type": "code",
          "content": "curl -s -o /dev/null -w '%{http_code}\\n' -X POST http://ops-center:3000/observability/alert-webhook \\\n  -H \"Authorization: Bearer $OLD\" -H 'X-Alertmanager-Instance: alertmanager' \\\n  -H 'Content-Type: application/json' -d '{\"alerts\":[]}'          # 401 after step 4",
          "language": "bash"
        },
        {
          "type": "text",
          "content": "Rollback — restore the old token as the current one (it is still in _PREVIOUS until step 4) and restart ops-center + Alertmanager. The only symptom of getting this wrong is silently undelivered org alerts, so verify rather than assume."
        },
        {
          "type": "text",
          "content": "Proof — api/ops-center/test/alert-webhook-token-rotation.test.ts and api/ops-center/test/alert-webhook-instances.test.ts."
        }
      ]
    },
    {
      "id": "image-registry-signing-key",
      "title": "Image-registry signing key",
      "blocks": [
        {
          "type": "text",
          "content": "image-registry mints RS256 Docker-Distribution tokens with REGISTRY_TOKEN_PRIVATE_KEY and puts the certificate chain in the JWT's x5c header; the registry verifies each token by chaining that leaf to a cert in its REGISTRY_AUTH_TOKEN_ROOTCERTBUNDLE — which is the same certificate file (registry-token-secret / deploy/*/certs/image-registry-jwt.crt)."
        },
        {
          "type": "text",
          "content": "So the overlap window is the trust bundle: run it holding two certs — new first, outgoing second. The new cert must be first, because x5c[0] is the leaf that must match the signing key; image-registry refuses to start otherwise (REGISTRY_TOKEN_PRIVATE_KEY does not match the FIRST certificate…), which beats minting tokens nothing can verify. While both certs are trusted, secret_rotation_previous_set{secret=\"REGISTRY_TOKEN_CERTIFICATE\"} is 1."
        },
        {
          "type": "text",
          "content": "Steps (k8s; the docker target is the same with files under deploy/local/docker/certs/)"
        },
        {
          "type": "list",
          "items": [
            "Generate the new pair and build the two-cert bundle:"
          ]
        },
        {
          "type": "text",
          "content": "bash cd \"$(mktemp -d)\" openssl genrsa -out new.key 4096 openssl req -x509 -new -nodes -key new.key -sha256 -days 3650 \\ -subj \"/CN=pipeline-image-registry-token-issuer\" -out new.crt kubectl -n pipeline-builder get secret registry-token-secret \\ -o jsonpath='{.data.jwt-public\\.pem}' | base64 -d > old.crt cat new.crt old.crt > bundle.crt # NEW FIRST"
        },
        {
          "type": "list",
          "items": [
            "Update the Secret with the new key + the bundle:"
          ]
        },
        {
          "type": "text",
          "content": "bash kubectl -n pipeline-builder create secret generic registry-token-secret \\ --from-file=jwt-private.pem=new.key --from-file=jwt-public.pem=bundle.crt \\ --dry-run=client -o yaml | kubectl apply -f -"
        },
        {
          "type": "list",
          "items": [
            "Restart the registry first so it trusts both certs, then"
          ]
        },
        {
          "type": "text",
          "content": "image-registry so it starts signing with the new key: bash kubectl -n pipeline-builder rollout restart deploy/registry kubectl -n pipeline-builder rollout status deploy/registry kubectl -n pipeline-builder rollout restart deploy/image-registry  docker: docker compose up -d --force-recreate registry then image-registry (mount certs/image-registry-jwt.crt = the bundle, …jwt.key = the new key)."
        },
        {
          "type": "list",
          "items": [
            "Wait out REGISTRY_TOKEN_EXPIRES_IN (default 300s) so no old-signed registry"
          ]
        },
        {
          "type": "text",
          "content": "token is in flight."
        },
        {
          "type": "list",
          "items": [
            "Trim the bundle to the new cert only and restart both (registry first):"
          ]
        },
        {
          "type": "text",
          "content": "bash kubectl -n pipeline-builder create secret generic registry-token-secret \\ --from-file=jwt-private.pem=new.key --from-file=jwt-public.pem=new.crt \\ --dry-run=client -o yaml | kubectl apply -f -"
        },
        {
          "type": "list",
          "items": [
            "No credential re-issue is needed: the stored registry credential is an opaque"
          ]
        },
        {
          "type": "text",
          "content": "service-account key, and the registry signing keypair only affects the tokens image-registry mints, not the credential presented to it."
        },
        {
          "type": "text",
          "content": "Verify — a docker login + docker pull against the gateway succeeds after step 3 and again after step 5; image-registry logs Initialized token service … certsInBundle: 2 during the window and 1 after. A plugin build (which pushes to org-<id>/…) is the end-to-end check."
        },
        {
          "type": "text",
          "content": "Rollback — before step 5 the old cert is still trusted: put the old key back as jwt-private.pem, order the bundle old.crt new.crt, restart both. After step 5, re-add the old cert to the bundle (the old key/cert pair must still exist — keep them until the window closes)."
        },
        {
          "type": "text",
          "content": "Proof — api/image-registry/test/token-signing-rotation.test.ts (simulates the registry's own x5c-against-bundle check)."
        }
      ]
    },
    {
      "id": "plugin-signing-key",
      "title": "Plugin-signing key",
      "blocks": [
        {
          "type": "text",
          "content": "Every plugin image the plugin service pushes is signed with cosign (key-based, transparency log off) and gets a signed SPDX SBOM attestation, both stored in the registry as cosign's sha256-<digest>.sig / .att tags. The plugin service verifies that signature before it hands out an image-producing plugin, and synth pins CodeBuild to the verified digest."
        },
        {
          "type": "text",
          "content": "Both services run cosign v3, compiled from source at its pinned release tag in their own images. v3 defaults to Sigstore bundles over the OCI referrers API and to a TUF-fetched signing config, so every call pins --new-bundle-format=false --use-signing-config=false --tlog-upload=false (signing) and --new-bundle-format=false --insecure-ignore-tlog=true (verification). Signing silently moving to the referrers API, or a cosign sign that fails with \"--tlog-upload=false is not supported with --use-signing-config\", means one of those pins was lost in a cosign bump — see api/image-registry/src/services/plugin-signing.ts."
        },
        {
          "type": "text",
          "content": "Who holds what. The PRIVATE key lives in image-registry only, which signs at POST /internal/plugin-signatures (service token; the caller must be plugin, and on the mesh targets the image-registry-internal-plugin-signatures waypoint policy refuses everyone else too). The plugin service gets only the PUBLIC key: its pod shares a network namespace with the buildkitd sidecar that runs untrusted tenant Dockerfile RUN steps, so it must never hold the private key or reach AWS credentials. Both halves come from deploy/bin/plugin-signing-keys.sh, which every target's setup/startup runs."
        },
        {
          "type": "text",
          "content": "Two signers, chosen by PLUGIN_SIGNING_MODE (read by image-registry):"
        },
        {
          "type": "table",
          "headers": [
            "Mode",
            "Where the private key lives",
            "What setup does"
          ],
          "rows": [
            [
              "local (default everywhere)",
              "deploy/<target>/certs/plugin-signing/plugin-signing.key, mounted into image-registry at /etc/pipeline-builder/plugin-signing",
              "generates the key once (never regenerates), derives plugin-signing.pub"
            ],
            [
              "kms (recommended on AWS)",
              "AWS KMS, asymmetric ECC_NIST_P256, SIGN_VERIFY; image-registry holds only kms:Sign + kms:GetPublicKey",
              "writes NO private key (deletes any stale plugin-signing-key Secret), exports plugin-signing.pub from KMS by alias"
            ]
          ]
        },
        {
          "type": "text",
          "content": "There is no overlap window. Verification accepts exactly one public key, and a signature cannot outlive the key that made it. Rotating — or switching local ↔ kms, which is the same thing — is a hard cutover: from the moment plugin mounts the new public key, every existing plugin image fails verification until it is re-signed, and a failing plugin cannot be used in a pipeline. Re-signing happens only on push, so the remedy is to rebuild / re-upload every image plugin (system plugins via the deploy's plugin loader; org plugins by their owners). Plan it as a maintenance window with the rebuild list in hand. Rotate only on suspicion of exposure or a policy requirement — there is no calendar cadence, and for exactly that reason kms is the right home for this key in production. Keeping old signatures verifiable instead means not rotating: leave the current key in place until the rebuilds are ready."
        },
        {
          "type": "text",
          "content": "Set up kms mode (AWS targets)"
        },
        {
          "type": "list",
          "items": [
            "Create the key and alias it — always by alias, never by ARN (an ARN"
          ]
        },
        {
          "type": "text",
          "content": "embeds the AWS account id, which must never reach config): bash KEY=$(aws kms create-key --key-spec ECC_NIST_P256 --key-usage SIGN_VERIFY \\ --description \"pipeline-builder plugin-image signing\" \\ --query KeyMetadata.KeyId --output text) aws kms create-alias --alias-name alias/pipeline-builder-plugin-signing \\ --target-key-id \"$KEY\""
        },
        {
          "type": "list",
          "items": [
            "Grant image-registry's role — never plugin's — kms:Sign +"
          ]
        },
        {
          "type": "text",
          "content": "kms:GetPublicKey on that key:"
        },
        {
          "type": "list",
          "items": [
            "eks: automatic. bin/setup.sh Phase 5 resolves the alias, creates"
          ]
        },
        {
          "type": "text",
          "content": "<cluster>-eks-plugin-signing scoped to exactly that key, and associates it with the image-registry ServiceAccount via Pod Identity. allow-image-registry-kms-egress (k8s/networkpolicy.yaml) lets image-registry reach the Pod Identity agent and KMS."
        },
        {
          "type": "list",
          "items": [
            "ec2: manual. Attach a policy with those two actions on the key's ARN"
          ]
        },
        {
          "type": "text",
          "content": "to the instance role (there is no per-pod identity on single-node minikube). allow-image-registry-kms-egress opens IMDS (169.254.169.254:80) and 443 to the KMS endpoint — in the private-VPC stack, the KMS interface VPC endpoint on 10.x."
        },
        {
          "type": "list",
          "items": [
            "Set in deploy/<target>/.env:"
          ]
        },
        {
          "type": "text",
          "content": "bash PLUGIN_SIGNING_MODE=kms PLUGIN_SIGNING_KMS_KEY_ID=alias/pipeline-builder-plugin-signing"
        },
        {
          "type": "list",
          "items": [
            "Re-run the target's setup/startup. The operator's credentials need"
          ]
        },
        {
          "type": "text",
          "content": "kms:GetPublicKey (to export the public half for plugin). Because this switches signer, remove the old local key first — plugin-signing-keys.sh refuses to run in kms mode while certs/plugin-signing/plugin-signing.key exists, so a stale private key is never left behind by accident."
        },
        {
          "type": "list",
          "items": [
            "Rebuild every image plugin (see above), then verify."
          ]
        },
        {
          "type": "text",
          "content": "Rotate"
        },
        {
          "type": "list",
          "items": [
            "local: delete deploy/<target>/certs/plugin-signing/plugin-signing.{key,pub},"
          ]
        },
        {
          "type": "text",
          "content": "re-run setup (it generates a fresh pair and re-creates both Secrets), restart image-registry and plugin (kubectl -n pipeline-builder rollout restart deploy/image-registry deploy/plugin; docker: docker compose up -d --force-recreate image-registry plugin), then rebuild every image plugin."
        },
        {
          "type": "list",
          "items": [
            "kms: create a new key, point the SAME alias at it (`aws kms"
          ]
        },
        {
          "type": "text",
          "content": "update-alias --alias-name alias/pipeline-builder-plugin-signing --target-key-id <new>), update image-registry's grant to the new key (eks: edit <cluster>-eks-plugin-signing` — setup reuses an existing policy as-is), re-run setup so the new public key is exported and mounted, restart both services, rebuild every image plugin. Schedule the old key for deletion only after the rebuilds — until then it is your rollback."
        },
        {
          "type": "list",
          "items": [
            "Both modes — published plugins. Rebuilding re-signs the images in each"
          ]
        },
        {
          "type": "text",
          "content": "org's own namespace, but NOT the copies in the read-only public/* namespace that the plugin ecosystem publishes (listed versions are immutable and never rebuilt). After the restart, an Ecosystem Manager runs Re-sign all published images in the Ecosystem console (POST /api/plugins/ecosystem/resign with a reason; system org, aal2, step-up). It queues one re-sign job per publisher; the plugin service's maintenance scheduler signs every listed version with the new key and the current tier annotations, resuming after any failure. Keep the old key (or KMS key version) until the overview shows no re-sign jobs left. See Ecosystem moderation."
        },
        {
          "type": "text",
          "content": "Compromise response — a leaked local key lets anyone produce an image the platform will accept. Rotate immediately and treat every plugin image pushed since the suspected exposure as untrusted until rebuilt; switch to kms while you are at it."
        },
        {
          "type": "text",
          "content": "Verify — a fresh plugin build succeeds end to end (image-registry signs, plugin's cosign verify passes); every public/* image verifies again once the re-sign jobs finish; a plugin that was not rebuilt fails with Plugin image signature did not verify (or has no signed image digest) rather than running unverified. image-registry must be able to write /tmp (the scratch-tmp emptyDir) — a cosign … failed error mentioning a read-only file system means that mount is missing."
        },
        {
          "type": "text",
          "content": "Rollback — local: restore the previous plugin-signing.{key,pub} from backup, re-run setup, restart both services; images re-signed with the new key then need rebuilding again. kms: point the alias back at the old key and re-run setup."
        }
      ]
    },
    {
      "id": "runner-signing-keys-per-org-ed25519",
      "title": "Runner signing keys (per org, Ed25519)",
      "blocks": [
        {
          "type": "text",
          "content": "Every organization has its own Ed25519 runner signing key. The pipeline service signs each run request it sends to a pipeline runner (a Lambda in the customer's own AWS account) with the key of the org that OWNS the runner: a compact JWS, alg: EdDSA, typ: pb-run+jwt, valid for 600 seconds. A leaked or rotated key therefore affects that org's runners only. There is no deployment-wide key, no key file, no Secret and no env setting for it."
        },
        {
          "type": "list",
          "items": [
            "Where keys live. One row per key in pipeline_runner_signing_keys. The"
          ]
        },
        {
          "type": "text",
          "content": "private half is a PKCS#8 PEM generated inside the pipeline service and stored encrypted with the per-org secret encryption: AES-256-GCM under an HKDF per-org key derived from SECRET_ENCRYPTION_KEY, or under the org's own KMS key when SECRET_ENCRYPTION_PER_ORG_KMS=true (the pipeline service resolves that config through platform's GET /internal/kms-config/:orgId). No route, log, audit entry or metric ever carries the private key, its ciphertext or the PEM: only key ids (RFC 7638 thumbprints) and dates leave the service."
        },
        {
          "type": "list",
          "items": [
            "Where runners read them. Each runner fetches"
          ]
        },
        {
          "type": "text",
          "content": "GET /api/pipelines/runner/runners/<runnerId>/jwks.json (public, no token, max-age=60, rate-limited per runner id), built from its own RUNNER_ID. It publishes the next, active and retiring keys of the runner owner's effective key org. A runner caches it for 10 minutes and re-fetches on an unknown kid at most once a minute. An unknown, revoked or malformed runner id gets 404, which the runner treats as \"no keys\" and refuses everything."
        },
        {
          "type": "list",
          "items": [
            "Who owns the key. A root org always uses its own key. A sub-organization"
          ]
        },
        {
          "type": "text",
          "content": "either inherits its nearest own-mode ancestor's key (the default) or switches to its own. Runners a parent shares with its teams always use the parent's key. A parent's rotation therefore covers every team that inherits from it; its dialogs name those teams."
        },
        {
          "type": "list",
          "items": [
            "States. next (published, not signing yet) → active (signs) →"
          ]
        },
        {
          "type": "text",
          "content": "retiring (published only) → retired (gone from the JWKS; the row is kept for audit with its private key wiped). At most one of each published state per org, enforced by partial unique indexes."
        },
        {
          "type": "text",
          "content": "The first key is created active when the first runner is registered under an effective key org that has none (or from the card, or --generate-key, before that). For a root org that is its own first runner. A team switching to its own key gets its key at the switch (below), so it never has none. When a registration (POST /pipelines/runners) comes from a team that inherits, the API creates the inherited-from org's key, audited as pipeline.runner.key.generate on that org by the system actor, with details.auto: true and details.onBehalfOfOrgId the team; the team's user is not recorded as its creator. setup-runner is stricter: it refuses an inheriting team whose parent has no key before it registers anything, and tells it to ask the parent's admins or switch to its own key. An org with no effective key gets 409 RUNNER_KEY_MISSING; nothing falls back to a shared key."
        },
        {
          "type": "text",
          "content": "Signing flow at a glance"
        },
        {
          "type": "code",
          "content": "flowchart TD\n    REG[\"Runner registered<br/>POST /pipelines/runners\"] --> HAS{\"Effective key org<br/>has a key?\"}\n    HAS -- \"no\" --> GEN[\"Generate Ed25519 key, state active<br/>top-level org, or the org an<br/>inheriting team inherits from\"]\n    HAS -- \"yes\" --> DB\n    GEN --> DB[(\"pipeline_runner_signing_keys<br/>private key encrypted per org:<br/>HKDF of SECRET_ENCRYPTION_KEY,<br/>or the org's own KMS key\")]\n    REWRAP[\"SECRET_ENCRYPTION_KEY rotation<br/>or per-org KMS change\"] -- \"re-encrypt job re-wraps\" --> DB\n    DB --> SIGN[\"Each delivery: active key of the<br/>runner OWNER's effective key org<br/>signs a pb-run+jwt, 10 min max\"]\n    PAUSE[\"Operator: Pause all pipeline runs\"] -. \"nothing signed or sent\" .-> SIGN\n    SIGN --> RUNNER[\"Runner Lambda\"]\n    RUNNER --> JWKS[\"GET /api/pipelines/runner/runners/:runnerId/jwks.json<br/>next + active + retiring keys<br/>runner caches 10 min\"]\n    JWKS --> OK{\"kid published, signature,<br/>iss, aud, exp valid?\"}\n    OK -- \"yes\" --> ACT[\"Act on the tagged pipeline\"]\n    OK -- \"no\" --> DENY[\"401 SIGNATURE_INVALID\"]\n    subgraph Lifecycle[\"Key lifecycle, per org\"]\n        ROT[\"Rotate\"] --> NEXT[\"new key: next<br/>published, not signing\"]\n        NEXT -- \"sweep at activates_at, +10 min\" --> PROMO[\"next becomes active,<br/>old active becomes retiring\"]\n        PROMO -- \"sweep at retire_after, +1 h<br/>or Finish now\" --> GONE[\"retired: private key wiped,<br/>off the JWKS\"]\n        REV[\"Revoke: org admin or operator\"] --> NOW[\"active retired now,<br/>next promoted or a new active key\"]\n    end\n    Lifecycle -.-> DB",
          "language": "mermaid"
        },
        {
          "type": "text",
          "content": "The key that signs is chosen from the runner row's owning org, never from the request: its effective key org is the org itself in own mode (every top-level org), else its nearest own-mode ancestor. Every replica caches the decrypted signer per owning org and drops it on a runner-keys:invalidate pub/sub message, re-checking the org's key version every 60 seconds in case a message was missed. The runner sweep (every 15 seconds, one replica at a time under a leader lock) promotes and retires keys, so each step lands up to 15 seconds after its time. The pause stops runs, not key changes: key writes and the sweep keep running while it is on."
        },
        {
          "type": "text",
          "content": "Rotate an org's key (org admins)"
        },
        {
          "type": "text",
          "content": "Org admins do this themselves, in Settings → Organization → Pipelines → Pipeline runners → Signing key, or with pipeline-manager runner signing-key rotate. Every key write needs org_settings:write, an MFA-grade session and a step-up, and is limited to 5 per org per hour. The limit fails closed: while its Redis store is unreachable key writes answer 503 rather than go unlimited. Key writes work while Pause all pipeline runs is on (the pause stops deliveries, not key changes), so an admin can rotate or revoke during an incident. The server enforces the timing, not the operator."
        },
        {
          "type": "list",
          "items": [
            "Rotate. A new next key is published at once with"
          ]
        },
        {
          "type": "text",
          "content": "activates_at = now + 10 minutes, which covers the runner's 10-minute JWKS cache and the route's 60-second cache. Cancel it (Cancel rotation, or DELETE …/signing-key/rotate) any time before it activates."
        },
        {
          "type": "list",
          "items": [
            "Promote (automatic). The runner sweep, every 15 seconds under its"
          ]
        },
        {
          "type": "text",
          "content": "leader lock, makes the new key active and the old one retiring with retire_after = now + 1 hour, at most 15 seconds after activates_at."
        },
        {
          "type": "list",
          "items": [
            "Finish (automatic, or Finish now). The sweep retires the old key once"
          ]
        },
        {
          "type": "text",
          "content": "retire_after has passed; every request signed with it expired long before. Finish now is refused (409 RUNNER_KEY_RETIRE_TOO_EARLY) before that time."
        },
        {
          "type": "text",
          "content": "A rotation while another is pending or overlapping answers 409 RUNNER_KEY_TRANSITION_IN_PROGRESS (so does the loser of two concurrent rotations). Rotate and promote each send an org notice to the org's admins and to admins of every inheriting team (retire, cancel and finish send none), and the steps write pipeline.runner.key.rotate, .promote and .retire audit entries carrying key ids only."
        },
        {
          "type": "text",
          "content": "Verify — the runner's JWKS lists the old and new key between steps 1 and 3 and only the new one after; Test on the runner card answers pong throughout; deploy/bin/runner-smoke.sh checks the per-runner JWKS end to end."
        },
        {
          "type": "text",
          "content": "Rollback — cancel before step 2. After promotion, rotate again."
        },
        {
          "type": "text",
          "content": "Age reminders. An active key older than RUNNER_KEY_MAX_AGE_DAYS (365) earns an org notice, a \"consider rotating\" badge, and a second notice 30 days later. Rotation stays manual; pipeline_runner_signing_keys_over_age counts the keys past that age."
        },
        {
          "type": "text",
          "content": "Switch a team between inherit and own"
        },
        {
          "type": "text",
          "content": "PUT /pipelines/runners/signing-key/mode (Use our own key / Inherit from … on the card) is refused for a root org (409 RUNNER_KEY_MODE_ROOT_ORG). Both directions overlap like a rotation:"
        },
        {
          "type": "list",
          "items": [
            "Inherit → own. The team's first key is created next and published next"
          ]
        },
        {
          "type": "text",
          "content": "to the parent's keys; it signs after 10 minutes, and the parent's keys leave the team's runners' JWKS 1 hour later."
        },
        {
          "type": "list",
          "items": [
            "Own → inherit. The parent's keys are published for the team's runners for"
          ]
        },
        {
          "type": "text",
          "content": "10 minutes, then signing switches to the parent; the team's keys go retiring and are retired after 1 hour."
        },
        {
          "type": "list",
          "items": [
            "Ancestry change (a team moved under another parent, or its parent"
          ]
        },
        {
          "type": "text",
          "content": "deleted) is handled by the sweep as a switch, with the same windows."
        },
        {
          "type": "text",
          "content": "Emergency revoke"
        },
        {
          "type": "list",
          "items": [
            "One org, by its admins. Revoke (danger zone on the card; type the last 6"
          ]
        },
        {
          "type": "text",
          "content": "characters of the key id) retires the active key at once and promotes the next key, or creates a new active one. Every replica drops the cached key at once through Redis pub/sub (runner-keys:invalidate), with a 60-second version poll as the backstop, and signs every later delivery with the new key. A runner keeps trusting the revoked key until it next fetches its JWKS: on the first request signed with the new (unknown) key id, or at the latest when its 10-minute cache expires. That refetch happens at most once a minute, so a request reaching a runner within a minute of its previous fetch fails with SIGNATURE_INVALID, which is not retried (and a health ping refused that way marks the runner unhealthy until the next ping succeeds)."
        },
        {
          "type": "list",
          "items": [
            "One org, by an operator. POST /api/pipelines/admin/orgs/<orgId>/runner-signing-key/revoke"
          ]
        },
        {
          "type": "text",
          "content": "(system org, orgs:manage, MFA-grade, step-up; audited as pipeline.runner.key.system_revoke naming the operator) does the same for any org. It also reaches a team switching own → inherit whose own key still signs (before switch_at): that key is retired at once, no new team key is made, and signing moves to the inherited key immediately (the answer's activeKid is the inherited key's). An org admin can't revoke a key of an org in inherit mode (409 RUNNER_KEY_INHERITED). The ops-center Runner signing keys page lists every org's mode, active key id, age, rotation state and whether its key is unreadable."
        },
        {
          "type": "list",
          "items": [
            "Every org at once. The system-org Pause all pipeline runs toggle"
          ]
        },
        {
          "type": "text",
          "content": "(PUT /api/pipelines/admin/runner-deliveries, audited) stops all runner traffic without a restart. Runners are the only execution path, so this pauses every pipeline run on the deployment: nothing is signed or delivered, runs answer 409 RUNNERS_UNAVAILABLE (details.reason: paused), and pipeline pages show a banner. A run request is good for only 10 minutes, so nothing queued before the pause is delivered late. Use it while you revoke the affected orgs' keys, then turn it off."
        },
        {
          "type": "text",
          "content": "Master-key rotation and the re-encrypt job"
        },
        {
          "type": "text",
          "content": "The runner keys are wrapped under the same secret encryption as platform's stores, so a SECRET_ENCRYPTION_KEY rotation or an org's per-org KMS change must re-wrap them too. Platform's Mongo re-encrypt does not reach Postgres, so the pipeline service has its own job, POST /pipelines/internal/runner-signing-keys/reencrypt (platform service token only)."
        },
        {
          "type": "list",
          "items": [
            "You normally run nothing extra. Platform's"
          ]
        },
        {
          "type": "text",
          "content": "scripts/reencrypt-secrets.js (step 3 of the SECRET_ENCRYPTION_KEY steps) calls it after its own re-encrypt, and so do the org KMS config PUT/DELETE /api/admin/orgs/:orgId/kms-config mutations. A runner-key failure fails them: the script exits 1 and the PUT/DELETE answer 500. Fix it and re-run before clearing SECRET_ENCRYPTION_KEY_PREVIOUS or the old KMS grant."
        },
        {
          "type": "list",
          "items": [
            "To run it by hand, inside a pipeline container (so it has the same key"
          ]
        },
        {
          "type": "text",
          "content": "material and per-org KMS setting): bash # k8s targets kubectl -n pipeline-builder exec deploy/pipeline -- node scripts/reencrypt-runner-keys.js # docker docker compose exec pipeline node scripts/reencrypt-runner-keys.js # one org only docker compose exec pipeline node scripts/reencrypt-runner-keys.js --org <orgId>  (The image puts lib/ at /app, so the repo's lib/scripts/ is scripts/ in the container.) Without --org it re-wraps every non-retired row under the current master, decrypting through SECRET_ENCRYPTION_KEY_PREVIOUS where needed. --org reads with the org's current provider, then the shared one. It does not know the org's previous KMS config, so it can't read rows still wrapped under an old CMK; only the org KMS config PUT/DELETE passes that config to the job. It reports scanned, reencrypted and failures (org id and key id per failed row; a failed row is left untouched), rewrites each row in its own transaction, and audits pipeline.runner.key.reencrypt."
        },
        {
          "type": "text",
          "content": "The pipeline service must therefore carry the same SECRET_ENCRYPTION_KEY, SECRET_ENCRYPTION_KEY_PREVIOUS and KMS secret-encryption settings as platform: restart pipeline as well as platform in steps 2 and 6 of the master-key rotation."
        },
        {
          "type": "text",
          "content": "Unreadable key"
        },
        {
          "type": "text",
          "content": "If an org's effective key can't be decrypted (a master changed without the re-encrypt job, a rotated or disabled per-org KMS key, a lost kms:Decrypt grant), that org's runner registrations, endpoint changes, tests and deliveries fail closed with 409 RUNNER_KEY_UNREADABLE (a delivery fails the run request) and its card tells its admins to contact you. Key writes never read the old key, so a revoke still works (step 3); they fail the same way only when the new key can't be encrypted either. Other orgs are unaffected. pipeline_runner_signing_keys_unreadable goes above zero and RunnerSigningKeyUnreadable (critical) fires."
        },
        {
          "type": "text",
          "content": "A transient key-service failure is not an unreadable key: when platform can't answer the org's per-org KMS config lookup, or KMS itself is unreachable, throttled or answers 5xx, runner writes, key writes and runs answer 409 RUNNERS_UNAVAILABLE with details.reason: key_service (\"Runs can't be signed right now because the key service is unreachable. Queued runs retry automatically.\" — never the operator-pause message, which only the pause toggle gives, as details.reason: paused), queued runs stay queued (and expire after their 10 minutes if it lasts), and neither the gauge nor the operator notice fires. Only a real decrypt failure of the stored ciphertext (a wrong master, a tampered or wrong-org blob, or KMS refusing the ciphertext or the grant) is RUNNER_KEY_UNREADABLE."
        },
        {
          "type": "list",
          "items": [
            "Find the org: ops-center → Runner signing keys, filter unreadable.",
            "If the old master or KMS key still exists, put it back as"
          ]
        },
        {
          "type": "text",
          "content": "SECRET_ENCRYPTION_KEY_PREVIOUS (or restore the org's KMS grant), restart pipeline and run the re-encrypt job until failures is empty."
        },
        {
          "type": "list",
          "items": [
            "If it is gone, revoke the org's key from the system org. A fresh key is"
          ]
        },
        {
          "type": "text",
          "content": "created active; the org's runners pick it up from their JWKS, so nothing changes in the customer's account."
        },
        {
          "type": "text",
          "content": "Deploy grants and sessions"
        },
        {
          "type": "text",
          "content": "A deploy through a runner uses two platform credentials, neither of which is rotated, because neither lives long enough to need it:"
        },
        {
          "type": "table",
          "headers": [
            "Credential",
            "Lifetime",
            "Where it is"
          ],
          "rows": [
            [
              "Deploy grant (pb_dg_…, 32 random bytes)",
              "Single use, and expires after the deploy project's queue timeout (30 min) plus a 15-minute provisioning margin, never less than the 10-minute delivery lifetime.",
              "Minted when the deploy is queued; the platform stores its sha256 and a copy encrypted with the org's secret key (for re-signing on redelivery), wiped at the exchange or at any terminal status. It rides inside the signed request; the runner Lambda KMS-encrypts it (key DeployGrantKey in the runner stack, context {runnerId, purpose: deploy-grant, requestId}, so it decrypts only for its own request) before StartBuild, so the account only ever sees ciphertext. The job decrypts it, exchanges it and scrubs it from its environment."
            ],
            [
              "Deploy session (pb_ds_…)",
              "Until the deploy's deadline (RUNNER_DEPLOY_DEADLINE_MINUTES), and revoked at any terminal status (its hash is nulled).",
              "Returned once by the exchange (Cache-Control: no-store, body only). It reaches only that deploy's facade under /api/pipelines/runner/deploys/:requestId/… (the path id must match)."
            ]
          ]
        },
        {
          "type": "text",
          "content": "Nothing to rotate: a leaked grant is useless once exchanged or expired, and a leaked session dies with its deploy. An exchange after expiry is refused as DEPLOY_GRANT_EXPIRED (reason=\"expired\"), which is a slow queue, not an attack."
        },
        {
          "type": "text",
          "content": "Responding to RunnerDeployGrantReuse (critical: a grant was presented again after its exchange, pipeline_runner_deploy_grant_rejections_total{reason=\"reused\"}):"
        },
        {
          "type": "list",
          "items": [
            "Find the deploy: the pipeline.deploy.grant_reuse audit event names the pipeline, request and runner (system actor)."
          ]
        },
        {
          "type": "text",
          "content": "The original exchange already succeeded, so the deploy itself ran under its own session."
        },
        {
          "type": "list",
          "items": [
            "Cancel the deploy if it is still running (pipeline page → Cancel deploy, or POST /pipelines/:id/deploys/:requestId/cancel):"
          ]
        },
        {
          "type": "text",
          "content": "that revokes its session. A finished deploy's session is already revoked."
        },
        {
          "type": "list",
          "items": [
            "In the runner's account, treat the replay as a sign that something other than the job decrypted the grant:"
          ]
        },
        {
          "type": "text",
          "content": "check CloudTrail for kms:Decrypt on DeployGrantKey by any principal other than the stack's DeployRole (the key policy allows only it), for edits to the key policy, the DeployRole or the DeployProject, and for StartBuild calls not made by the RunnerRole."
        },
        {
          "type": "list",
          "items": [
            "If the account is suspect, turn deploys off for that runner (re-run pipeline-manager infra setup-runner without"
          ]
        },
        {
          "type": "text",
          "content": "--enable-deploy) or revoke it from Settings → Organization → Pipelines → Pipeline runners, and review the stacks its deploys created (pb.pipeline-id tags)."
        },
        {
          "type": "list",
          "items": [
            "A job that ran twice (a CodeBuild retry) also triggers it: its second exchange is refused and it fails"
          ]
        },
        {
          "type": "text",
          "content": "DEPLOY_GRANT_REJECTED without deploying. Confirm with the build history of pipeline-builder-runner-deploy-<runnerId>."
        },
        {
          "type": "text",
          "content": "Accepted runner URL hosts"
        },
        {
          "type": "text",
          "content": "A runner's URL must be https:// with no user-info, no port and no fragment, and its host must match one of:"
        },
        {
          "type": "table",
          "headers": [
            "Kind",
            "Host pattern"
          ],
          "rows": [
            [
              "Lambda Function URL",
              "<id>.lambda-url.<region>.on.aws"
            ],
            [
              "API Gateway",
              "<id>.execute-api.<region>.amazonaws.com"
            ],
            [
              "API Gateway (China regions)",
              "<id>.execute-api.<region>.amazonaws.com.cn"
            ]
          ]
        },
        {
          "type": "text",
          "content": "Anything else is refused at registration (and the address is SSRF-checked at delivery), so a runner cannot be pointed at an in-cluster or arbitrary host."
        }
      ]
    },
    {
      "id": "idp-saml-signing-certificates-per-org",
      "title": "IdP SAML signing certificates (per org)",
      "blocks": [
        {
          "type": "text",
          "content": "Unlike every secret above, this one is not ours — it belongs to the customer's identity provider, and their IdP administrator decides when it changes. What we own is the trust list: the certificates an org's config says may have signed an assertion. That list is what makes the rotation a non-event."
        },
        {
          "type": "text",
          "content": "The overlap window is the list holding two certificates — the incoming one and the outgoing one. While both are listed, assertions signed by either verify, so the cutover costs nobody a failed sign-in and the order does not matter (every listed certificate is tried). Up to three are accepted; more than that is a trust list turning into a place old keys go to hide."
        },
        {
          "type": "text",
          "content": "Who does this: an org admin holding org_idp:write, on Settings → Single Sign-On, with a step-up confirmation — or a platform operator on their behalf through /admin/org-idp/:orgId. There is no env value, no Secret and no restart: the list is read per sign-in, so a change takes effect on the next one."
        },
        {
          "type": "text",
          "content": "Steps"
        },
        {
          "type": "list",
          "items": [
            "Get the new certificate from the IdP (its metadata document is the reliable"
          ]
        },
        {
          "type": "text",
          "content": "source — in Okta Sign On → SAML Signing Certificates, in Entra Single sign-on → SAML Certificates → Download Certificate (Base64))."
        },
        {
          "type": "list",
          "items": [
            "Open the window: paste it into Signing certificate(s) alongside the"
          ]
        },
        {
          "type": "text",
          "content": "current one (blank line between them; PEM or bare base64, both accepted) and save. The editor says how many certificates it detected and warns that a rotation window is open."
        },
        {
          "type": "list",
          "items": [
            "Tell the IdP administrator to cut over — activate the new certificate at the"
          ]
        },
        {
          "type": "text",
          "content": "IdP. Sign-ins keep working throughout, whichever certificate signs them."
        },
        {
          "type": "list",
          "items": [
            "Verify: sign in through the IdP; the audit trail shows user.login with"
          ]
        },
        {
          "type": "text",
          "content": "details.method = 'saml' and platform_saml_signins_total{result=\"success\"} advances. A rejection here shows as sso.saml.refused with details.reason = \"invalid_assertion\"."
        },
        {
          "type": "list",
          "items": [
            "Close the window: remove the retired certificate and save. Leaving it"
          ]
        },
        {
          "type": "text",
          "content": "listed means the old key can still sign a valid assertion — which is the whole point of rotating away from it."
        },
        {
          "type": "text",
          "content": "Each save that changes the list is audited as sso.saml.certificate.rotate, carrying the fingerprints before and after and whether an overlap window is now open; platform_saml_certificate_rotations_total{overlap} counts them. An unclosed window is visible as an open rotation with no closed one following."
        },
        {
          "type": "text",
          "content": "Rollback — before step 5 the old certificate is still trusted, so reverting is just telling the IdP to switch back. After step 5, re-add it (keep a copy until the window is closed and verified)."
        },
        {
          "type": "text",
          "content": "Compromise response — if the IdP's signing key is compromised, do NOT open a window: replace the list with the new certificate alone, in one save, so the compromised key stops being trusted immediately. A handful of in-flight sign-ins fail and are retried."
        },
        {
          "type": "text",
          "content": "Proof — platform/test/saml-service.test.ts (\"certificate rotation overlap\") verifies assertions signed by either certificate while both are trusted, and refuses the retired one once the list is trimmed."
        }
      ]
    },
    {
      "id": "saml-service-provider-keys-signing-encryption-test-marker",
      "title": "SAML service-provider keys (signing, encryption, test-marker)",
      "blocks": [
        {
          "type": "text",
          "content": "The mirror image of the section above: these are ours, not the IdP's. Three keys, one set for the whole deployment — they identify this service provider to every IdP, exactly as the user-token signing key identifies it to every relying service. They are not per org; trust is still per org, because each IdP pins the certificate it imported."
        },
        {
          "type": "table",
          "headers": [
            "Purpose (_id in saml_sp_keys)",
            "What it is",
            "Used for"
          ],
          "rows": [
            [
              "signing",
              "RSA-2048 + self-signed X.509 (10 years)",
              "signs AuthnRequests when an org turns on Sign AuthnRequests, and always signs LogoutRequest/LogoutResponse"
            ],
            [
              "encryption",
              "RSA-2048 + self-signed X.509",
              "the certificate an IdP encrypts assertions to, when the org turns on Identity provider encrypts assertions"
            ],
            [
              "test-marker",
              "32-byte HMAC secret, no certificate",
              "signs the dry-run marker carried in the SSO state / RelayState on a Test connection"
            ]
          ]
        },
        {
          "type": "text",
          "content": "They are auto-generated on first use and persisted, never supplied through deploy config: there is no env var, no file, no Secret and nothing to mount on any target. The private halves are stored only as EncryptedBlobs under SECRET_ENCRYPTION_KEY (context saml-sp-keys); the certificates are public by design and stored in clear. The _id is the purpose, so two replicas racing to generate collide on the primary key and the loser re-reads the winner's row."
        },
        {
          "type": "text",
          "content": "There is no overlap window, and no _PREVIOUS. A saml_sp_keys document is current or absent. That is a deliberate consequence of where the trust lives: the IdP holds our certificate, so an overlap would have to be expressed in every customer's IdP configuration, not in ours. A rotation is therefore a coordinated, announced event — and the keys are cached per process precisely so it cannot happen underneath a live sign-in."
        },
        {
          "type": "text",
          "content": "Who this affects. Only orgs that have turned on signed AuthnRequests, single logout, or encrypted assertions. An org doing plain SP-initiated SAML with an unsigned request and a plaintext assertion never sees our certificates, and a rotation is invisible to it. Check before you schedule one — it is often nobody."
        },
        {
          "type": "text",
          "content": "Steps"
        },
        {
          "type": "list",
          "items": [
            "Tell the affected orgs first. Each one's IdP administrator must re-import"
          ]
        },
        {
          "type": "text",
          "content": "the SP metadata, and until they do, signed requests / SLO / encrypted assertions fail for that org. Give them the window."
        },
        {
          "type": "list",
          "items": [
            "Take a copy first (see Rollback), then drop the documents you are"
          ]
        },
        {
          "type": "text",
          "content": "rotating. Open a shell on the database — the credentials are the ones the container already holds, exactly as in its own readiness probe: bash # k8s targets kubectl -n pipeline-builder exec -it deploy/mongodb -- bash -c \\ 'mongosh --host localhost:27017 --username \"$MONGO_INITDB_ROOT_USERNAME\" \\ --password \"$MONGO_INITDB_ROOT_PASSWORD\" --authenticationDatabase admin platform' # docker cd deploy/local/docker && docker compose exec mongodb bash -c \\ 'mongosh --host localhost:27017 --username \"$MONGO_INITDB_ROOT_USERNAME\" \\ --password \"$MONGO_INITDB_ROOT_PASSWORD\" --authenticationDatabase admin platform'  Then, at the mongosh prompt — all three, or just the purpose you are rotating. Dropping only signing leaves encryption and the test marker untouched: javascript db.saml_sp_keys.deleteMany({}) // rotate all three db.saml_sp_keys.deleteOne({ _id: 'signing' }) // or just one purpose"
        },
        {
          "type": "list",
          "items": [
            "Restart platform only — no other service holds or reads these. The"
          ]
        },
        {
          "type": "text",
          "content": "per-process cache is what makes the restart mandatory; without it, replicas keep serving the deleted keys until they happen to recycle. bash kubectl -n pipeline-builder rollout restart deploy/platform # docker cd deploy/local/docker && docker compose up -d --force-recreate platform"
        },
        {
          "type": "list",
          "items": [
            "Confirm a fresh key was minted — the platform log carries"
          ]
        },
        {
          "type": "text",
          "content": "Generated SAML service-provider key once per purpose — and read the new certificate back: bash curl -sk \"https://<host>/api/auth/sso/<orgId>/saml/metadata\" | grep -c X509Certificate"
        },
        {
          "type": "list",
          "items": [
            "Each affected org re-imports the SP metadata at its IdP — the metadata"
          ]
        },
        {
          "type": "text",
          "content": "URL from step 4 is the document, and most IdPs import everything from it. The org's own administrator can read the same values from Settings → Single Sign-On, which serves them from GET /organization/:id/idp/sp-info."
        },
        {
          "type": "list",
          "items": [
            "Verify per org: a SAML sign-in succeeds, and a single logout round-trips for"
          ]
        },
        {
          "type": "text",
          "content": "any org that has an SLO URL configured."
        },
        {
          "type": "text",
          "content": "Verify"
        },
        {
          "type": "list",
          "items": [
            "platform_saml_signins_total{result=\"success\"} advances for each affected org"
          ]
        },
        {
          "type": "text",
          "content": "after its re-import."
        },
        {
          "type": "list",
          "items": [
            "A result of invalid_assertion on an org with encrypted assertions means"
          ]
        },
        {
          "type": "text",
          "content": "that org is still encrypting to the retired certificate — it has not re-imported. Same audit trail as any other refusal: sso.saml.refused."
        },
        {
          "type": "list",
          "items": [
            "A stale signing certificate fails earlier and is not in this metric: the"
          ]
        },
        {
          "type": "text",
          "content": "IdP rejects our AuthnRequest signature before an assertion exists, so the person never returns and the symptom is an error at the IdP. Ask the affected org's administrator what their IdP is reporting rather than looking here."
        },
        {
          "type": "list",
          "items": [
            "An org that never enabled signing, SLO or encryption should show no change at"
          ]
        },
        {
          "type": "text",
          "content": "all. If it does, the rotation touched more than it should have."
        },
        {
          "type": "text",
          "content": "Rollback — only if you kept a copy. Deleting the document destroys the private half, and the new key is minted before anyone asks for the old one, so take a mongodump of saml_sp_keys before step 2 if you want a way back. Restoring the dump and restarting platform puts the previous certificates back and un-does the re-import obligation."
        },
        {
          "type": "text",
          "content": "Coupling to SECRET_ENCRYPTION_KEY — the private halves are wrapped under the master key. The fleet re-encryption tool re-wraps them in place (it reports samlSpKeysReencrypted), so a master-key rotation does not oblige a rotation here — see step 4 of that section. Only a key listed under failures has to be regenerated, and doing it during the master-key overlap window keeps a mistake recoverable from the previous key."
        },
        {
          "type": "text",
          "content": "Compromise response — a leaked SP signing key lets someone forge our logout messages to an IdP, and a leaked encryption key exposes any assertion captured in transit. Neither lets anyone sign in as a user (the IdP's signature is what authenticates an assertion). So: rotate at once, in the order above, and accept the failed sign-ins for orgs that have not yet re-imported — do not wait for a comfortable window."
        },
        {
          "type": "text",
          "content": "Proof — platform/test/saml-sp-keys.test.ts (generated once, private halves stored ENCRYPTED, reused rather than regenerated, and the two-replica race converging on one winner)."
        }
      ]
    },
    {
      "id": "service-account-keys",
      "title": "Service-account keys",
      "blocks": [
        {
          "type": "text",
          "content": "Service accounts are first-class principals — non-human members of an org — whose keys are created and revoked per account. There is no _PREVIOUS value and no overlap window in the sense used above; instead a service account may legitimately hold two live keys at once during a rollout, which is the same idea reached from the other end. A key is revoked, not overlapped."
        },
        {
          "type": "list",
          "items": [
            "POST /organization/:id/service-accounts/:accountId/keys → new key material"
          ]
        },
        {
          "type": "text",
          "content": "(pb_sa_…), returned once — only a hash is stored. Pass scope for a least-privilege key. Requires service_accounts:manage, a second factor (aal: 2) and a step-up, and a service-account key can never satisfy step-up itself, so one key cannot mint another."
        },
        {
          "type": "list",
          "items": [
            "Roll the consumers (CI jobs, automation, the IdP's provisioning config) onto"
          ]
        },
        {
          "type": "text",
          "content": "it. Both keys authenticate meanwhile."
        },
        {
          "type": "list",
          "items": [
            "DELETE /organization/:id/service-accounts/:accountId/keys/:keyId on the old"
          ]
        },
        {
          "type": "text",
          "content": "key. Not step-up gated — revocation only ever removes access, and a compromise response must never be blocked on a second factor."
        },
        {
          "type": "list",
          "items": [
            "Verify: the consumer's next run succeeds, the old key 401s, and the account's"
          ]
        },
        {
          "type": "text",
          "content": "lastUsedAt advances. In the UI, Dashboard → Security → Service accounts lists each account and its keys. Create and revoke are audited as org.service-account.key.create / org.service-account.key.revoke."
        },
        {
          "type": "text",
          "content": "Rollback: before step 3, switch the consumer back; after step 3, create another key. Compromise response is the same flow with step 3 first."
        },
        {
          "type": "text",
          "content": "The stored AWS machine credentials rotate themselves on this mechanism — rotate → store → revoke, audited as org.service-account.key.rotate — and have their own runbook: Access Key Cutover → Machine credentials."
        },
        {
          "type": "text",
          "content": "SCIM provisioning keys"
        },
        {
          "type": "text",
          "content": "A SCIM credential is not a separate kind of token: it is a service-account key carrying the scim capability scope, issued under Settings → Single Sign-On → SCIM provisioning through the route above. The scope is the whole boundary — a scoped key carries no permissions and no features, every SCIM route resolves its org from the key's own organizationId claim rather than from a path or a body, and a person's token is refused outright. So a stolen SCIM key can provision members in one org and do nothing else anywhere."
        },
        {
          "type": "text",
          "content": "Rotate it exactly as above, with step 2 being \"paste it into the IdP's provisioning config (Okta/Entra: Provisioning → API token) and run a test sync\". Verify with a successful sync after the revoke, and watch platform_scim_requests_total{result=\"denied\"} / platform_scim_errors_total{reason=\"wrong_credential\"} stay flat — a bump there means the IdP is still presenting the revoked key."
        }
      ]
    },
    {
      "id": "auth-material-that-is-not-a-secret-and-does-not-rotate",
      "title": "Auth material that is not a secret — and does not rotate",
      "blocks": [
        {
          "type": "text",
          "content": "Every item above is a credential someone could steal. These are the auth-adjacent things operators reach for this runbook expecting to find, which have no secret value, no _PREVIOUS, no probe and no SecretRotationPreviousLingering coverage. They are listed so a rotation review can tick them off rather than go looking."
        },
        {
          "type": "table",
          "headers": [
            "Item",
            "Why it never rotates"
          ],
          "rows": [
            [
              "Passkey (WebAuthn) credentials",
              "Only the public key is stored. There is nothing at rest to leak and nothing to re-encrypt. A credential is registered or revoked, never rotated."
            ],
            [
              "The relying-party ID (rpID)",
              "Derived from PLATFORM_FRONTEND_URL and validated at boot. A registered passkey is bound to it permanently, so changing it orphans every credential on the deployment. Treat it as immutable, not as a knob."
            ],
            [
              "Recovery codes",
              "SHA-256 hashes, single-use. Re-minted by the account holder; unaffected by a SECRET_ENCRYPTION_KEY rotation."
            ],
            [
              "PASSWORD_BREACH_CHECK, PASSWORD_BREACH_CHECK_URL, PASSWORD_BREACH_CHECK_TIMEOUT_MS",
              "Settings, not credentials. The HIBP range API is unauthenticated — there is no API key to hold — and only the first 5 hex characters of a password's SHA-1 ever leave the process."
            ],
            [
              "FIDO_MDS_URL, FIDO_MDS_FETCH_TIMEOUT_MS, FIDO_MDS_REFRESH_MS",
              "Settings. The MDS endpoint is public and unauthenticated; the blob's own signature chain is what makes it trustworthy, not a credential we hold."
            ],
            [
              "FIDO_MDS_BLOB_PATH",
              "Not a secret — but the file behind it goes stale, which is the one maintenance task in this table. See below."
            ]
          ]
        },
        {
          "type": "text",
          "content": "Refreshing the FIDO MDS blob (FIDO_MDS_BLOB_PATH)"
        },
        {
          "type": "text",
          "content": "FIDO metadata is only consulted for orgs that set an approved-authenticator (AAGUID) allowlist: those registrations request DIRECT attestation and verify it against MDS, and are refused while no metadata is loaded — the policy asked for provenance that cannot be checked, so it fails closed."
        },
        {
          "type": "text",
          "content": "With FIDO_MDS_URL in use (the default), nothing to do: the blob is re-fetched every FIDO_MDS_REFRESH_MS (24 h). The maintenance applies to the air-gapped path, where FIDO_MDS_BLOB_PATH points at a blob JWT downloaded out of band — that file wins over the URL, is the only source consulted, and never updates itself. A stale file means new authenticator models are unknown (their registrations are refused) and, worse, models revoked or marked compromised since the download are still accepted."
        },
        {
          "type": "text",
          "content": "This path is opt-in and unwired. FIDO_MDS_BLOB_PATH ships commented out in every .env.example and no deploy target mounts a blob, so choosing it means you also own getting the file into the container — a ConfigMap or Secret plus a volume mount on the k8s targets, a bind mount under compose. The examples below assume a fido-mds Secret you created; adapt them to whatever you mounted."
        },
        {
          "type": "text",
          "content": "Refresh it on the FIDO Alliance's own cadence — monthly is comfortable, and any time the platform log shows FIDO metadata load failed:"
        },
        {
          "type": "code",
          "content": "curl -fsS https://mds.fidoalliance.org/ -o /tmp/fido-mds.jwt\nkubectl -n pipeline-builder create secret generic fido-mds \\\n  --from-file=fido-mds.jwt=/tmp/fido-mds.jwt \\\n  --dry-run=client -o yaml | kubectl apply -f -\nkubectl -n pipeline-builder rollout restart deploy/platform\ncd deploy/local/docker && docker compose up -d --force-recreate platform",
          "language": "bash"
        },
        {
          "type": "text",
          "content": "A restart is what picks it up: the snapshot is cached in memory for FIDO_MDS_REFRESH_MS and the file is read only when that expires, so replacing the file alone can leave a replica serving day-old metadata for up to a day."
        },
        {
          "type": "text",
          "content": "Verify — platform_fido_mds_loads_total{outcome=\"success\",source=\"file\"} increments after the restart, and the platform log records FIDO metadata loaded with a models count and the blob's sequence number (blobNo); compare that number with the previous load to confirm the file actually changed. A registration into an allowlisted org is the end-to-end check."
        },
        {
          "type": "text",
          "content": "If it fails — a failed load keeps the previous snapshot: stale signed metadata is still signed metadata, and dropping it would refuse every allowlisted registration until the next success. So a bad file is not an immediate outage, and platform_fido_mds_loads_total{outcome=\"failure\"} is the only signal you get. A load is not retried for 5 minutes after a failure, so an unreachable or malformed source costs one timeout per window, not one per request. With no snapshot at all — a first boot with a bad file — allowlisted registrations are refused; orgs with no allowlist are unaffected either way."
        }
      ]
    },
    {
      "id": "alert-and-metric-reference",
      "title": "Alert and metric reference",
      "blocks": [
        {
          "type": "table",
          "headers": [
            "Item",
            "Value"
          ],
          "rows": [
            [
              "Metric",
              "secret_rotation_previous_set{service,secret} — gauge, 1 while the overlap value is set"
            ],
            [
              "Exported by",
              "every service (/metrics), including platform; probes registered in api-core (SERVICE_SIGNING_KEY), platform (TOKEN_SIGNING_KEY, SECRET_ENCRYPTION_KEY), ops-center (ALERT_WEBHOOK_INSTANCE_TOKEN) and image-registry (REGISTRY_TOKEN_CERTIFICATE)"
            ],
            [
              "Alert",
              "SecretRotationPreviousLingering — max by (service, secret) (secret_rotation_previous_set) == 1 for: 24h, severity: warning, component: auth, tenancy: platform"
            ],
            [
              "Defined in",
              "deploy/{local/docker,local/minikube,aws/ec2,aws/eks}/config/prometheus/alert-rules.yml (unit-tested in deploy/local/minikube/config/prometheus/alert-rules.test.yml)"
            ]
          ]
        },
        {
          "type": "text",
          "content": "The alert aggregates away pod/instance on purpose: a rolling restart during the rotation would otherwise start a new series and reset the 24h timer."
        },
        {
          "type": "text",
          "content": "Arriving from the alert, {{ $labels.secret }} names the section that finishes the rotation, and {{ $labels.service }} names what to restart:"
        },
        {
          "type": "table",
          "headers": [
            "secret label",
            "Finish it here",
            "What \"finish\" means for it"
          ],
          "rows": [
            [
              "TOKEN_SIGNING_KEY",
              "User-token signing key",
              "clear TOKEN_SIGNING_KEY_PREVIOUS_FILE (or TOKEN_SIGNING_KMS_KEY_PREVIOUS_ID), re-create the Secret, restart platform"
            ],
            [
              "SERVICE_SIGNING_KEY",
              "Internal service signing keys",
              "service-signing-keys.sh … --finish <service>, re-push service-key-bundle, restart that service"
            ],
            [
              "SECRET_ENCRYPTION_KEY",
              "SECRET_ENCRYPTION_KEY",
              "pb_finish_env_rotation, re-push app-secrets, restart platform and pipeline — only after the re-encryption reports failures: 0 and steps 4–5 are done"
            ],
            [
              "ALERT_WEBHOOK_INSTANCE_TOKEN",
              "ALERT_WEBHOOK_INSTANCE_TOKEN",
              "pb_finish_env_rotation, re-push alertmanager-relay, restart ops-center"
            ],
            [
              "REGISTRY_TOKEN_CERTIFICATE",
              "Image-registry signing key",
              "trim the trust bundle to the new cert, restart registry then image-registry"
            ]
          ]
        },
        {
          "type": "text",
          "content": "SECRET_ENCRYPTION_KEY is the one label where \"finish it\" is not a 30-second job — it gates on data being migrated first, and on a decision about authenticator-app enrolments. A long-running one is expected; an unexplained one is the problem."
        },
        {
          "type": "text",
          "content": "If a rotation legitimately needs a longer window (the user-token signing key at a 30-day refresh TTL is the usual case), record it — the alert firing is the expected signal that the window is open, and it should be closed as soon as the tokens have aged out."
        },
        {
          "type": "text",
          "content": "A second alert covers the verifier side of the signing key:"
        },
        {
          "type": "table",
          "headers": [
            "Item",
            "Value"
          ],
          "rows": [
            [
              "Metric",
              "jwks_fetch_total{service,source,result} — counter; result is success, error or empty"
            ],
            [
              "Alert",
              "JwksFetchFailing — sum by (service) (rate(jwks_fetch_total{result!=\"success\"}[5m])) > 0 for: 10m, severity: critical, component: auth"
            ],
            [
              "Why critical",
              "a verifier that cannot obtain the key set FAILS CLOSED (503) once its 10-minute cache goes stale, so sustained errors are a fleet-wide auth outage forming"
            ]
          ]
        },
        {
          "type": "text",
          "content": "jwks_unknown_kid_refetch_total{service,source} counts the one-per-cooldown refetch a verifier makes when it sees a kid it does not know — a small bump is the expected signature of a rotation; a sustained rate means something is presenting forged kids."
        }
      ]
    }
  ],
  "sourceDoc": "docs/runbooks/secret-rotation.md"
};
