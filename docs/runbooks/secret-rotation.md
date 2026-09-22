---
layout: default
title: Secret Rotation
---

# Secret Rotation Runbook

Every rotatable secret in Pipeline Builder rotates the same way: **add the new
value while the old one is still accepted, cut over, then remove the old one.**
The middle state — both values live — is the *overlap window*, and it is what
makes a rotation cost zero logouts, zero dropped alerts and zero unreadable
secrets.

The overlap value is usually the same key name with a `_PREVIOUS` suffix
(`SECRET_ENCRYPTION_KEY_PREVIOUS`, `ALERT_WEBHOOK_INSTANCE_TOKEN_PREVIOUS`,
`TOKEN_SIGNING_KEY_PREVIOUS_FILE`). Three secrets express the same idea
differently for the same reason: the **user-token signing key** keeps the
retiring key's `kid` PUBLISHED in `/.well-known/jwks.json`, the **per-service
signing keys** keep the retiring `kid` in the shared public bundle, and the
image-registry signing key uses a two-certificate trust bundle. Empty means "not rotating" — that is the steady
state, and every `.env.example` ships these keys empty.

**Two deliberately have no overlap at all.** A [service-account
key](#service-account-keys) is revoked rather than overlapped (the account simply
holds two live keys for a while, which is the same idea reached from the other
end), and the [SAML service-provider
keys](#saml-service-provider-keys-signing-encryption-test-marker) cannot have one,
because the trust they rely on lives in each customer's IdP rather than in our
config. Both are announced, coordinated events instead. The [plugin-signing
key](#plugin-signing-key) has none either: a signature cannot outlive the key
that made it, so rotating it means re-signing every plugin image.

**An unfinished rotation is not a rotation.** While a `_PREVIOUS` value is set,
the old credential still works — including the compromised one you may be
rotating away from. Every service exports

```
secret_rotation_previous_set{service="<svc>",secret="<KEY>"} 1
```

while its overlap value is set, and the `SecretRotationPreviousLingering` alert
(warning, `component: auth`) fires when that stays 1 for **24h**. Finish the
rotation or explain the alert; do not silence it.

---

## Where the values live, per target

| Target | Source of truth | How processes receive it | Recreate secrets with |
|---|---|---|---|
| `docker` | `deploy/local/docker/.env` | `docker-compose.yml` → `x-common-env` (`${SECRET_ENCRYPTION_KEY_PREVIOUS:-}` …) | nothing to recreate — recreate containers |
| `minikube` | `deploy/local/minikube/.env` | `app-env` ConfigMap + `app-secrets` Secret (`envFrom`), plus the `service-key-*` and `alertmanager-relay` Secrets | `deploy/local/minikube/bin/setup.sh` re-run, or the targeted `kubectl patch` below |
| `aws/ec2` | `deploy/aws/ec2/.env` (on the instance) | same Secrets as minikube, created by `deploy/bin/k8s-resources.sh` (`pb_create_app_secrets`, `pb_create_token_signing_secret`, `pb_create_plugin_signing_secrets`) | `kubectl patch` below, or re-run `bin/startup.sh` |
| `aws/eks` | `deploy/aws/eks/.env` | same as ec2 | `kubectl patch` below, or re-run `bin/setup.sh` |

The signing KEYS are not env values: they are files. The user-token key lives in
`deploy/<target>/certs/token-signing/` (bind-mounted into platform under compose,
mounted from the `token-signing-key` Secret on the cluster targets) or in KMS
under an alias; the per-service internal keys live in
`deploy/<target>/certs/service-keys/` (one bind mount / one `service-key-<name>`
Secret each, plus the public `bundle.json` everywhere). `.env` only says where.

Key-by-key:

| Secret | Held by | Lives in |
|---|---|---|
| **user-token signing key** (ES256) | **platform only** | `deploy/*/certs/token-signing/token-signing.key` → k8s `token-signing-key` Secret; or AWS KMS under `TOKEN_SIGNING_KMS_KEY_ID` |
| **per-service signing keys** (ES256) — internal service tokens | each service holds ONLY its own | `deploy/*/certs/service-keys/<svc>.key` → k8s `service-key-<svc>` Secret; public halves in `bundle.json` → `service-key-bundle` |
| `SECRET_ENCRYPTION_KEY` (+ `_PREVIOUS`) | platform only | `.env`; k8s `app-secrets` Secret |
| `ALERT_WEBHOOK_INSTANCE_TOKEN` (+ `_PREVIOUS`) | platform (verifier) + Alertmanager (sender) | `.env`; k8s `alertmanager-relay` Secret; platform's `ALERT_WEBHOOK_INSTANCES` JSON |
| image-registry signing key | image-registry (signs) + the Docker registry (verifies) | `deploy/*/certs/image-registry-jwt.{key,crt}` (docker); k8s `registry-token-secret` |
| **plugin-signing key** (cosign, EC P-256) — plugin images + SBOM attestations | **image-registry only** (signs); plugin holds the PUBLIC key (verifies) | `deploy/*/certs/plugin-signing/plugin-signing.key` → k8s `plugin-signing-key` Secret, or AWS KMS under `PLUGIN_SIGNING_KMS_KEY_ID`; public half `plugin-signing.pub` → `plugin-signing-public-key` |
| SAML **service-provider** keys (signing, encryption, test-marker) | platform only | Mongo, collection `saml_sp_keys` — private halves wrapped under `SECRET_ENCRYPTION_KEY`. Nothing on disk, nothing in `.env` |

### Shared mechanics

Two helpers in `deploy/bin/gen-env-secrets.sh` do the `.env` edits (source the
file first — it only defines functions):

```bash
cd deploy/<target>
. ../../bin/gen-env-secrets.sh            # path relative to the target dir
pb_rotate_env_secret .env SECRET_ENCRYPTION_KEY hex   # old → *_PREVIOUS, new generated
# … cut over …
pb_finish_env_rotation .env SECRET_ENCRYPTION_KEY     # clears *_PREVIOUS
```

`pb_rotate_env_secret` refuses to run when the key is absent or empty (it will
not blank a live secret on a typo) and takes `hex` as a third argument for
`SECRET_ENCRYPTION_KEY`, which must decode to exactly 32 bytes.

On the **k8s targets**, `.env` is only the input: the running pods read
Secrets. Either re-run the target's setup script (idempotent) or patch directly:

```bash
NS=pipeline-builder
kubectl -n $NS patch secret app-secrets -p \
  "{\"stringData\":{\"SECRET_ENCRYPTION_KEY\":\"$NEW\",\"SECRET_ENCRYPTION_KEY_PREVIOUS\":\"$OLD\"}}"
```

`app-secrets` carries the same values for the services that read it via
`envFrom` (`pb_split_app_env` routes every `*_PREVIOUS` key to the Secret, never
to the ConfigMap), so patch both when a key lives in both.

On **docker**, recreating a container is what re-reads `.env`:

```bash
cd deploy/local/docker
docker compose up -d --force-recreate platform nginx image-registry   # …or the services listed per-secret below
```

---

## User-token signing key (ES256, rotated by `kid`)

Signs **every token that speaks for a person**: access, refresh, step-up and the
short-lived token an opaque access key is exchanged for. **Platform is the only
holder.** Every other verifier — each service via api-core, the
pipeline-manager CLI, image-registry's `/token` mint path and the pipeline-events
Lambda — checks signatures against the public keys platform publishes at
`/.well-known/jwks.json` (unauthenticated, cached 10 minutes, refetched once on
an unknown `kid`).

There is no shared secret to distribute, so a rotation is a **key** rotation:
publish both keys, switch signing, then stop publishing the old one. Verifiers
need no restart and no config change — they pick the new `kid` up from the JWKS.

**Schedule.** Rotate on a **12-month** cadence at minimum, and immediately on
suspicion of exposure (see *Compromise response* below). Because the overlap
window has to outlive the longest refresh token, plan the whole rotation as
**~35 days**: cut over on day 0, finish after `REFRESH_TOKEN_EXPIRES_IN` (30
days) plus a few days of margin. A deployment that shortens
`REFRESH_TOKEN_EXPIRES_IN` shortens the window with it. Diary the finish step —
the `SecretRotationPreviousLingering` alert will be firing for the whole window,
which is expected, and the point of the diary entry is that it stops.

Two signers, chosen by `TOKEN_SIGNING_MODE`:

| Mode | Where the private key lives | Rotate with |
|---|---|---|
| `local` (docker, minikube, and the AWS default) | `deploy/<target>/certs/token-signing/token-signing.key`, mounted into platform at `/etc/pipeline-builder/keys` | `deploy/bin/token-signing-keys.sh <cert_dir> --rotate` |
| `kms` (recommended on AWS) | AWS KMS, asymmetric `ECC_NIST_P256`, `SIGN_VERIFY`; platform holds only `kms:Sign` + `kms:GetPublicKey` | create a second KMS key, swap the two env vars |

### Steps — `local` mode

1. Roll the key. The current key is retired to `token-signing-previous.key` and a
   fresh one takes its place:
   ```bash
   bash deploy/bin/token-signing-keys.sh deploy/<target>/certs --rotate
   ```
2. Point platform at the retiring key so it stays PUBLISHED (this is the overlap
   window — without it every live session dies at the cutover):
   ```bash
   # deploy/<target>/.env
   TOKEN_SIGNING_KEY_PREVIOUS_FILE=/etc/pipeline-builder/keys/token-signing-previous.key
   ```
3. Push the key material and restart **platform only** — no other service holds
   or reads it:
   ```bash
   # k8s targets
   . deploy/bin/k8s-resources.sh
   pb_create_token_signing_secret deploy/<target>/certs/token-signing/token-signing.key \
     deploy/<target>/certs/token-signing/token-signing-previous.key
   kubectl -n pipeline-builder rollout restart deploy/platform
   # docker
   cd deploy/local/docker && docker compose up -d --force-recreate platform
   ```
4. Confirm both keys are published, and that new tokens carry the new `kid`:
   ```bash
   curl -sk https://<host>/.well-known/jwks.json | jq '.keys[].kid'   # two entries
   ```
5. **AWS event ingestion / CodeBuild: nothing to do.** The stored credentials are
   opaque [service-account keys](../authentication.md#stored-machine-credentials-aws),
   not JWTs — they carry no signature, are exchanged for a fresh token every few
   minutes, and are therefore unaffected by a signing-key rotation. (That is one
   of the things the #12 / #N2 cutover bought: this step used to be mandatory and
   easy to forget.)
6. Wait out the longest-lived token signed with the old key. Access and step-up
   tokens are minutes; **refresh tokens live `REFRESH_TOKEN_EXPIRES_IN` (30 days
   by default)**, and they are signed with this key too — so ending the overlap
   earlier signs out every device that has not refreshed since the cutover. That
   is the trade-off to decide deliberately.
7. Finish: clear `TOKEN_SIGNING_KEY_PREVIOUS_FILE`, delete
   `token-signing-previous.key`, re-create the Secret and restart platform. The
   old `kid` disappears from the JWKS and tokens signed with it stop verifying
   everywhere within one JWKS refresh (10 minutes).

### Steps — `kms` mode

Same shape; only the key handling differs.

1. Create the incoming key and alias it:
   ```bash
   KEY=$(aws kms create-key --key-spec ECC_NIST_P256 --key-usage SIGN_VERIFY \
     --query KeyMetadata.KeyId --output text)
   aws kms create-alias --alias-name alias/pipeline-builder-token-signing-next \
     --target-key-id "$KEY"
   ```
   Grant platform's role `kms:Sign` + `kms:GetPublicKey` on it. **Always
   reference keys by alias, never by ARN** — an ARN embeds the AWS account id,
   which must never reach config, logs, a token or the JWKS.
2. Set `TOKEN_SIGNING_KMS_KEY_PREVIOUS_ID` to the CURRENT alias and
   `TOKEN_SIGNING_KMS_KEY_ID` to the incoming one, then restart platform. Both
   `kid`s are now published; the incoming key signs.
3. Steps 4–6 above, unchanged.
4. Finish: clear `TOKEN_SIGNING_KMS_KEY_PREVIOUS_ID`, restart platform, and
   schedule the old KMS key for deletion once you are certain (`aws kms
   schedule-key-deletion`). Deleting it early only affects signing, which has
   already moved — but the `kid` must be out of the JWKS first, or verifiers
   would keep accepting tokens whose key no longer exists.

### Compromise response

A leaked signing key means anyone can mint a token for any user, so do NOT use
the overlap window: rotate with **no** `*_PREVIOUS` value at all. Every session,
access key token and step-up token dies immediately, and everyone signs in again
— which is the correct outcome. Follow it with a fleet-wide `tokenVersion` bump
if the leak may have been used.

**Verify**

- `curl -sk https://<host>/.well-known/jwks.json` lists the expected `kid`s.
- `secret_rotation_previous_set{secret="TOKEN_SIGNING_KEY"}` → `1` during the
  window, `0` after the final step (platform reports this from the signer, not
  from an env var — it is 1 exactly while a retiring key is published).
- `jwks_fetch_total{result="success"}` keeps incrementing on the other services;
  a spike of `result="error"` means they cannot reach the key set, and the
  `JwksFetchFailing` alert (critical) fires after 10 minutes. Verifiers FAIL
  CLOSED with 503 once their cached set goes stale, so treat that as an outage.
- A user who signed in **before** step 1 can still call the API during the
  window, and is signed out only after the final step if they never refreshed.

**Rollback** — before the final step, swap the two key settings back (the
retiring key is still on disk / still in KMS) and restart platform. After it,
rolling back means another rotation, and every session signed with the new key is
invalidated.

**Proof** — `platform/test/token-signing.test.ts` (both signers, the JWKS
document, rotation overlap), `platform/test/jwt-options-parity.test.ts`
(platform ↔ api-core agreement, including the rotation),
`packages/api-core/test/jwt-rotation.test.ts` (verifier-side `kid` rotation,
unknown-`kid` refetch, fail-closed), `platform/test/refresh-token-rotation.test.ts`
(the refresh-token half), `api/image-registry/test/platform-jwt-rotation.test.ts`
(`/token` mint path).

---

## Internal service signing keys (ES256, per service)

Each service signs the short-lived (5-minute) `service:<name>` tokens it presents
to its peers with **its own** EC P-256 key (api-core's `signServiceToken`), and
verifies its peers against the shared PUBLIC bundle. There is no shared secret:
the `kid` selects the key and names its owner, and the token's `sub` must agree,
so one service cannot speak for another. Rotating a key affects inter-service
calls, not sessions — nobody is logged out.

The overlap is expressed in the bundle, not in an env value: while a rotation is
open, the bundle publishes TWO public keys for that service, so tokens signed
either side of the cutover verify. `deploy/bin/service-signing-keys.sh` handles
both halves.

**Steps** (one service at a time, or `--rotate-all`)

1. Generate the incoming key and republish the bundle. The retiring key is moved
   aside and its PUBLIC half stays in the bundle:
   ```bash
   bash deploy/bin/service-signing-keys.sh deploy/<target>/certs --rotate billing
   ```
2. **Roll the BUNDLE out everywhere FIRST.** It is public, and every service
   reads it — if the rotated service starts signing before its peers trust the
   new `kid`, every call it makes 401s.
   - docker: nothing to push (the file is bind-mounted); recreate the containers
     so they re-read it, or just wait — the bundle is re-read on mtime change and
     at least every 5 minutes, so a rolling pickup needs no restart at all.
   - k8s: re-run the target's setup script, or patch the one Secret:
     ```bash
     kubectl -n pipeline-builder create secret generic service-key-bundle \
       --from-file=bundle.json=deploy/<target>/certs/service-keys/bundle.json \
       --dry-run=client -o yaml | kubectl apply -f -
     ```
3. Now push the rotated service's PRIVATE key and restart only that service:
   ```bash
   kubectl -n pipeline-builder create secret generic service-key-billing \
     --from-file=service.key=deploy/<target>/certs/service-keys/billing.key \
     --dry-run=client -o yaml | kubectl apply -f -
   kubectl -n pipeline-builder rollout restart deploy/billing
   ```
   docker: `docker compose up -d --force-recreate billing`.
4. Wait 5 minutes (the service-token TTL) so no token signed with the old key is
   still in flight.
5. Finish — drop the retiring key from disk and from the bundle, then re-push the
   bundle as in step 2:
   ```bash
   bash deploy/bin/service-signing-keys.sh deploy/<target>/certs --finish billing
   ```

**Verify**

- `secret_rotation_previous_set{secret="SERVICE_SIGNING_KEY"}` → `1` on the
  rotated service during the window, `0` after step 5.
- No burst of 401/403 on internal routes; cross-service features (quota
  increments, compliance checks, entity events) keep working throughout.
- `internal_route_refused_total` does not climb.

**Rollback** — the retiring key is still on disk and still published until step 5:
move `<svc>-previous.key` back to `<svc>.key`, re-push that Secret and restart.

**Proof** — `packages/api-core/test/secret-rotation.test.ts` (the bundle-overlap
drill), `packages/api-core/test/jwt-rotation.test.ts` (retiring key accepted,
dropped key refused, wrong-signer refused),
`platform/test/jwt-options-parity.test.ts` (platform ↔ api-core agreement).

---

## `SECRET_ENCRYPTION_KEY`

The AES-256-GCM master key behind every encrypted-at-rest secret. Platform is
the only holder. **Four** stores are wrapped under it, and they do not all
migrate the same way:

| Store | What it holds | Migrated by |
|---|---|---|
| `Organization.aiProviderKeys.*` | org AI provider keys | `scripts/reencrypt-secrets.js` |
| `OrgIdpConfig.clientSecretEncrypted` | per-org SSO (OIDC) client secrets | `scripts/reencrypt-secrets.js` |
| `UserTotp.secret` | each account's authenticator-app secret | `scripts/reencrypt-secrets.js` |
| `saml_sp_keys.privateKeyEncrypted` | this deployment's SAML SP signing / encryption / test-marker keys | `scripts/reencrypt-secrets.js` |

The tool covers **all four**. It did not always: it swept orgs and IdP configs
only, and the other two stores are salted per USER (`user:<userId>`) and per
DEPLOYMENT (`saml-sp-keys`), so no org walk could reach them. A run then
reported `failures: 0` while leaving them wrapped under the outgoing key, and
clearing `SECRET_ENCRYPTION_KEY_PREVIOUS` bricked every authenticator enrolment
and the SAML SP identity at once. If you are rotating on a build from before
that fix, treat steps 4 and 5 as mandatory manual work; on a current build the
tool reports a count for each store and you verify the counts instead.

This one is different from every other secret here: the old key is needed to
**read** existing rows, so the overlap window is not about tokens in flight — it
is the time it takes to re-encrypt the stored data.
`SECRET_ENCRYPTION_KEY_PREVIOUS` is **decrypt-only**; new writes always use the
current key.

**Steps**

1. Rotate (hex — the key must decode to 32 bytes):
   ```bash
   . deploy/bin/gen-env-secrets.sh
   pb_rotate_env_secret deploy/<target>/.env SECRET_ENCRYPTION_KEY hex
   ```
2. Push `app-secrets` (k8s) and restart platform. Reads now fall back to the
   previous key; writes use the new one.
3. Re-encrypt every stored blob, **inside a platform container** so it inherits
   the same key material and per-org KMS setting:
   ```bash
   # k8s targets
   kubectl -n pipeline-builder exec deploy/platform -- node scripts/reencrypt-secrets.js
   # docker
   docker compose exec platform node scripts/reencrypt-secrets.js
   ```
   It walks every org, every IdP config, every authenticator enrolment and the
   SAML SP keys, decrypts each through the fallback and rewrites under the
   current key. It exits **non-zero** and lists each row it
   could not decrypt — such a row's secret was written under a key you no longer
   have and must be re-entered by the org admin (AI keys: Settings → AI
   providers; SSO: Admin → org → IdP). Re-run until it reports `failures: 0`.
4. **Check the SAML service-provider keys migrated.** Step 3 reports
   `samlSpKeysReencrypted` — expect one per generated purpose (signing,
   encryption, test-marker). The keys keep their identity, so no org has to
   re-import metadata. Only if a key is listed under `failures` do you fall back
   to regenerating it — see
   [SAML service-provider keys](#saml-service-provider-keys-signing-encryption-test-marker),
   which obliges each SSO org to re-import. Do that here, while the previous key
   is still set, so a failure is recoverable. A deployment with no SAML org
   configured has nothing to check: the documents are generated on first use.
5. **Check the authenticator enrolments migrated.** Step 3 reports
   `totpSecretsReencrypted`; it should equal the number of active enrolments.
   Any enrolment it could not read is listed under `failures` with the scope
   `user:<userId>` — that account must re-scan (Settings → Security →
   Authenticator app) before you clear the previous key, or sign in with a
   recovery code afterwards. Recovery codes are SHA-256 hashes rather than
   encrypted blobs, so they survive any rotation and are the way back in.
   Know the failure mode if an unreadable secret does reach production: the
   decrypt throws rather than returning a wrong answer, and that is not one of
   the TOTP sentinels, so the account sees a **500, not `TOTP_INVALID_CODE`** —
   a ticket reading "my authenticator broke the app", not "my code is wrong".

   A deployment whose second factors are all passkeys is unaffected: WebAuthn
   credentials store public keys, which are not encrypted at rest.
6. `pb_finish_env_rotation deploy/<target>/.env SECRET_ENCRYPTION_KEY`, re-push,
   restart platform.

**Verify**

- Step 3 prints `orgsScanned`, `aiKeysReencrypted`, `idpSecretsReencrypted`,
  `totpSecretsReencrypted`, `samlSpKeysReencrypted` and `failures: 0`. A zero
  count where rows exist is the tell that a store was skipped — check before
  step 6, not after.
- After step 6, exercise a decrypt path — e.g. an AI generation for an org with
  a stored provider key, an SSO login for an org with a client secret, a SAML
  sign-in for an org that uses signed requests or encrypted assertions, and a
  TOTP sign-in. A failure here means one of steps 3–5 missed something.
- `secret_rotation_previous_set{secret="SECRET_ENCRYPTION_KEY"}` back to 0.

**Rollback** — until step 6, restore the previous key as
`SECRET_ENCRYPTION_KEY` and restart; rows already rewritten under the new key
then need the new key as `_PREVIOUS` (i.e. swap the two values) to stay
readable. **After step 6 there is no rollback** — dropping the old key with rows
still wrapped under it makes those secrets unrecoverable, which is exactly why
step 3 gates on `failures: 0` and why steps 4 and 5 are decided before it.

**Per-org KMS.** Orgs with `SECRET_ENCRYPTION_PER_ORG_KMS` config are wrapped
under their own CMK, not this master, and their blobs carry a `kid`; the shared
previous key is never applied to them. Rotating an org's CMK is a separate flow
(`PUT /api/admin/orgs/:orgId/kms-config`, which re-encrypts that org inline).

**Proof** — `packages/api-core/test/secret-rotation.test.ts` (overlap → rewrite
→ old blob rejected), `platform/test/secret-reencrypt.test.ts` (the fleet-wide
tool, including the unreadable-row path).

---

## `ALERT_WEBHOOK_INSTANCE_TOKEN` (alert relay)

The bearer Alertmanager presents to platform's
`POST /observability/alert-webhook`, which fans alerts out to each org's
destinations. Two sides: platform verifies (`ALERT_WEBHOOK_INSTANCES`, one entry
per Alertmanager instance) and Alertmanager sends (a mounted `credentials_file`).
Platform accepts the entry's `previousToken` while it is non-empty.

**Order matters: teach the verifier the new token before the sender starts
sending it.**

1. `pb_rotate_env_secret deploy/<target>/.env ALERT_WEBHOOK_INSTANCE_TOKEN`
2. Push the `alertmanager-relay` Secret (both keys) and restart **platform**
   first. It now accepts old *and* new.
   ```bash
   kubectl -n pipeline-builder patch secret alertmanager-relay -p \
     "{\"stringData\":{\"ALERT_WEBHOOK_INSTANCE_TOKEN\":\"$NEW\",\"ALERT_WEBHOOK_INSTANCE_TOKEN_PREVIOUS\":\"$OLD\"}}"
   kubectl -n pipeline-builder rollout restart deploy/platform
   ```
3. Restart **Alertmanager** so it picks up the new token file
   (`rollout restart deploy/alertmanager`; docker:
   `docker compose up -d --force-recreate alertmanager platform`).
4. `pb_finish_env_rotation deploy/<target>/.env ALERT_WEBHOOK_INSTANCE_TOKEN`,
   re-push the Secret, restart platform.

**Verify** — fire a test alert (or watch the next real one) and confirm
`Alert relay processed` in the platform log with no `Alert webhook unknown
instance` / `Unauthorized` warnings. Between steps 2 and 3 **both** tokens must
work; after step 4 the old one must 401:

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://platform:3000/observability/alert-webhook \
  -H "Authorization: Bearer $OLD" -H 'X-Alertmanager-Instance: alertmanager' \
  -H 'Content-Type: application/json' -d '{"alerts":[]}'          # 401 after step 4
```

**Rollback** — restore the old token as the current one (it is still in
`_PREVIOUS` until step 4) and restart platform + Alertmanager. The only symptom
of getting this wrong is silently undelivered org alerts, so verify rather than
assume.

**Proof** — `platform/test/alert-webhook-token-rotation.test.ts`,
`platform/test/alert-webhook-instances.test.ts`.

---

## Image-registry signing key

image-registry mints RS256 Docker-Distribution tokens with
`REGISTRY_TOKEN_PRIVATE_KEY` and puts the certificate chain in the JWT's `x5c`
header; the registry verifies each token by chaining that leaf to a cert in its
`REGISTRY_AUTH_TOKEN_ROOTCERTBUNDLE` — which is the **same** certificate file
(`registry-token-secret` / `deploy/*/certs/image-registry-jwt.crt`).

So the overlap window is the **trust bundle**: run it holding two certs — **new
first, outgoing second**. The new cert must be first, because `x5c[0]` is the
leaf that must match the signing key; image-registry refuses to start otherwise
(`REGISTRY_TOKEN_PRIVATE_KEY does not match the FIRST certificate…`), which beats
minting tokens nothing can verify. While both certs are trusted,
`secret_rotation_previous_set{secret="REGISTRY_TOKEN_CERTIFICATE"}` is 1.

**Steps** (k8s; the docker target is the same with files under
`deploy/local/docker/certs/`)

1. Generate the new pair and build the two-cert bundle:
   ```bash
   cd "$(mktemp -d)"
   openssl genrsa -out new.key 4096
   openssl req -x509 -new -nodes -key new.key -sha256 -days 3650 \
     -subj "/CN=pipeline-image-registry-token-issuer" -out new.crt
   kubectl -n pipeline-builder get secret registry-token-secret \
     -o jsonpath='{.data.jwt-public\.pem}' | base64 -d > old.crt
   cat new.crt old.crt > bundle.crt        # NEW FIRST
   ```
2. Update the Secret with the new key + the bundle:
   ```bash
   kubectl -n pipeline-builder create secret generic registry-token-secret \
     --from-file=jwt-private.pem=new.key --from-file=jwt-public.pem=bundle.crt \
     --dry-run=client -o yaml | kubectl apply -f -
   ```
3. Restart the **registry** first so it trusts both certs, then
   **image-registry** so it starts signing with the new key:
   ```bash
   kubectl -n pipeline-builder rollout restart deploy/registry
   kubectl -n pipeline-builder rollout status  deploy/registry
   kubectl -n pipeline-builder rollout restart deploy/image-registry
   ```
   docker: `docker compose up -d --force-recreate registry` then
   `image-registry` (mount `certs/image-registry-jwt.crt` = the bundle,
   `…jwt.key` = the new key).
4. Wait out `REGISTRY_TOKEN_EXPIRES_IN` (default 300s) so no old-signed registry
   token is in flight.
5. Trim the bundle to the new cert only and restart both (registry first):
   ```bash
   kubectl -n pipeline-builder create secret generic registry-token-secret \
     --from-file=jwt-private.pem=new.key --from-file=jwt-public.pem=new.crt \
     --dry-run=client -o yaml | kubectl apply -f -
   ```
6. No credential re-issue is needed: the stored registry credential is an opaque
   service-account key, and the registry signing keypair only affects the tokens
   image-registry *mints*, not the credential presented to it.

**Verify** — a `docker login` + `docker pull` against the gateway succeeds after
step 3 and again after step 5; image-registry logs
`Initialized token service … certsInBundle: 2` during the window and `1` after.
A plugin build (which pushes to `org-<id>/…`) is the end-to-end check.

**Rollback** — before step 5 the old cert is still trusted: put the old key back
as `jwt-private.pem`, order the bundle `old.crt new.crt`, restart both. After
step 5, re-add the old cert to the bundle (the old key/cert pair must still
exist — keep them until the window closes).

**Proof** — `api/image-registry/test/token-signing-rotation.test.ts` (simulates
the registry's own `x5c`-against-bundle check).

---

## Plugin-signing key

Every plugin image the plugin service pushes is signed with cosign (key-based,
transparency log off) and gets a signed SPDX SBOM attestation, both stored in
the registry as cosign's `sha256-<digest>.sig` / `.att` tags. The plugin service
**verifies** that signature before it hands out an image-producing plugin, and
synth pins CodeBuild to the verified digest.

**Who holds what.** The PRIVATE key lives in **image-registry only**, which
signs at `POST /internal/plugin-signatures` (service token; the caller must be
`plugin`, and on the mesh targets the `image-registry-internal-plugin-signatures`
waypoint policy refuses everyone else too). The plugin service gets only the
PUBLIC key: its pod shares a network namespace with the buildkitd sidecar that
runs untrusted tenant Dockerfile `RUN` steps, so it must never hold the private
key or reach AWS credentials. Both halves come from
`deploy/bin/plugin-signing-keys.sh`, which every target's setup/startup runs.

Two signers, chosen by `PLUGIN_SIGNING_MODE` (read by image-registry):

| Mode | Where the private key lives | What setup does |
|---|---|---|
| `local` (default everywhere) | `deploy/<target>/certs/plugin-signing/plugin-signing.key`, mounted into image-registry at `/etc/pipeline-builder/plugin-signing` | generates the key once (never regenerates), derives `plugin-signing.pub` |
| `kms` (recommended on AWS) | AWS KMS, asymmetric `ECC_NIST_P256`, `SIGN_VERIFY`; image-registry holds only `kms:Sign` + `kms:GetPublicKey` | writes NO private key (deletes any stale `plugin-signing-key` Secret), exports `plugin-signing.pub` from KMS by alias |

**There is no overlap window.** Verification accepts exactly one public key, and
a signature cannot outlive the key that made it. Rotating — or switching
`local` ↔ `kms`, which is the same thing — is a hard cutover: from the moment
plugin mounts the new public key, **every existing plugin image fails
verification** until it is re-signed, and a failing plugin cannot be used in a
pipeline. Re-signing happens only on push, so the remedy is to **rebuild /
re-upload every image plugin** (system plugins via the deploy's plugin loader;
org plugins by their owners). Plan it as a maintenance window with the rebuild
list in hand. Rotate only on suspicion of exposure or a policy requirement —
there is no calendar cadence, and for exactly that reason `kms` is the right
home for this key in production. Keeping old signatures verifiable instead means
not rotating: leave the current key in place until the rebuilds are ready.

### Set up `kms` mode (AWS targets)

1. Create the key and alias it — **always by alias, never by ARN** (an ARN
   embeds the AWS account id, which must never reach config):
   ```bash
   KEY=$(aws kms create-key --key-spec ECC_NIST_P256 --key-usage SIGN_VERIFY \
     --description "pipeline-builder plugin-image signing" \
     --query KeyMetadata.KeyId --output text)
   aws kms create-alias --alias-name alias/pipeline-builder-plugin-signing \
     --target-key-id "$KEY"
   ```
2. Grant **image-registry's** role — never plugin's — `kms:Sign` +
   `kms:GetPublicKey` on that key:
   - **eks**: automatic. `bin/setup.sh` Phase 5 resolves the alias, creates
     `<cluster>-eks-plugin-signing` scoped to exactly that key, and associates
     it with the `image-registry` ServiceAccount via Pod Identity.
     `allow-image-registry-kms-egress` (k8s/networkpolicy.yaml) lets
     image-registry reach the Pod Identity agent and KMS.
   - **ec2**: manual. Attach a policy with those two actions on the key's ARN
     to the **instance role** (there is no per-pod identity on single-node
     minikube). `allow-image-registry-kms-egress` opens IMDS
     (`169.254.169.254:80`) and 443 to the KMS endpoint — in the private-VPC
     stack, the KMS interface VPC endpoint on 10.x.
3. Set in `deploy/<target>/.env`:
   ```bash
   PLUGIN_SIGNING_MODE=kms
   PLUGIN_SIGNING_KMS_KEY_ID=alias/pipeline-builder-plugin-signing
   ```
4. Re-run the target's setup/startup. The operator's credentials need
   `kms:GetPublicKey` (to export the public half for plugin). Because this
   switches signer, remove the old local key first —
   `plugin-signing-keys.sh` refuses to run in `kms` mode while
   `certs/plugin-signing/plugin-signing.key` exists, so a stale private key is
   never left behind by accident.
5. Rebuild every image plugin (see above), then verify.

### Rotate

- **`local`**: delete `deploy/<target>/certs/plugin-signing/plugin-signing.{key,pub}`,
  re-run setup (it generates a fresh pair and re-creates both Secrets), restart
  **image-registry and plugin** (`kubectl -n pipeline-builder rollout restart
  deploy/image-registry deploy/plugin`; docker: `docker compose up -d
  --force-recreate image-registry plugin`), then rebuild every image plugin.
- **`kms`**: create a new key, point the SAME alias at it (`aws kms
  update-alias --alias-name alias/pipeline-builder-plugin-signing
  --target-key-id <new>`), update image-registry's grant to the new key (eks:
  edit `<cluster>-eks-plugin-signing` — setup reuses an existing policy as-is),
  re-run setup so the new public key is exported and mounted, restart both
  services, rebuild every image plugin. Schedule the old key for deletion only
  after the rebuilds — until then it is your rollback.
- **Both modes — published plugins.** Rebuilding re-signs the images in each
  org's own namespace, but NOT the copies in the read-only `public/*`
  namespace that the plugin ecosystem publishes (listed versions are
  immutable and never rebuilt). After the restart, an Ecosystem Manager runs
  **Re-sign all published images** in the Ecosystem console
  (`POST /api/plugins/ecosystem/resign` with a reason; system org, aal2,
  step-up). It queues one re-sign job per publisher; the plugin service's
  maintenance scheduler signs every listed version with the new key and the
  current tier annotations, resuming after any failure. Keep the old key (or
  KMS key version) until the overview shows no re-sign jobs left. See
  [Ecosystem moderation](ecosystem-moderation.md#re-sign-job).

**Compromise response** — a leaked `local` key lets anyone produce an image the
platform will accept. Rotate immediately and treat every plugin image pushed
since the suspected exposure as untrusted until rebuilt; switch to `kms` while
you are at it.

**Verify** — a fresh plugin build succeeds end to end (image-registry signs,
plugin's `cosign verify` passes); every `public/*` image verifies again once the
re-sign jobs finish; a plugin that was not rebuilt fails with
`Plugin image signature did not verify` (or `has no signed image digest`) rather
than running unverified. image-registry must be able to write `/tmp` (the
`scratch-tmp` emptyDir) — a `cosign … failed` error mentioning a read-only file
system means that mount is missing.

**Rollback** — `local`: restore the previous `plugin-signing.{key,pub}` from
backup, re-run setup, restart both services; images re-signed with the new key
then need rebuilding again. `kms`: point the alias back at the old key and
re-run setup.

---

## IdP SAML signing certificates (per org)

Unlike every secret above, this one is **not ours** — it belongs to the
customer's identity provider, and their IdP administrator decides when it
changes. What we own is the **trust list**: the certificates an org's config says
may have signed an assertion. That list is what makes the rotation a non-event.

The overlap window is the list holding **two certificates** — the incoming one
and the outgoing one. While both are listed, assertions signed by either verify,
so the cutover costs nobody a failed sign-in and the order does not matter (every
listed certificate is tried). Up to three are accepted; more than that is a trust
list turning into a place old keys go to hide.

**Who does this:** an org admin holding `org:idp`, on **Settings → Single
Sign-On**, with a step-up confirmation — or a platform operator on their behalf
through `/admin/org-idp/:orgId`. There is no env value, no Secret and no
restart: the list is read per sign-in, so a change takes effect on the next one.

**Steps**

1. Get the new certificate from the IdP (its metadata document is the reliable
   source — in Okta *Sign On → SAML Signing Certificates*, in Entra
   *Single sign-on → SAML Certificates → Download Certificate (Base64)*).
2. **Open the window:** paste it into *Signing certificate(s)* **alongside** the
   current one (blank line between them; PEM or bare base64, both accepted) and
   save. The editor says how many certificates it detected and warns that a
   rotation window is open.
3. Tell the IdP administrator to cut over — activate the new certificate at the
   IdP. Sign-ins keep working throughout, whichever certificate signs them.
4. Verify: sign in through the IdP; the audit trail shows `user.login` with
   `details.method = 'saml'` and `platform_saml_signins_total{result="success"}`
   advances. A rejection here shows as `sso.saml.refused` with
   `details.reason = "invalid_assertion"`.
5. **Close the window:** remove the retired certificate and save. Leaving it
   listed means the old key can still sign a valid assertion — which is the
   whole point of rotating away from it.

Each save that changes the list is audited as `sso.saml.certificate.rotate`,
carrying the fingerprints before and after and whether an overlap window is now
`open`; `platform_saml_certificate_rotations_total{overlap}` counts them. An
unclosed window is visible as an `open` rotation with no `closed` one following.

**Rollback** — before step 5 the old certificate is still trusted, so reverting
is just telling the IdP to switch back. After step 5, re-add it (keep a copy
until the window is closed and verified).

**Compromise response** — if the IdP's signing key is compromised, do NOT open a
window: replace the list with the new certificate alone, in one save, so the
compromised key stops being trusted immediately. A handful of in-flight sign-ins
fail and are retried.

**Proof** — `platform/test/saml-service.test.ts` ("certificate rotation
overlap") verifies assertions signed by either certificate while both are
trusted, and refuses the retired one once the list is trimmed.

---

## SAML service-provider keys (signing, encryption, test-marker)

The mirror image of the section above: these are **ours**, not the IdP's. Three
keys, **one set for the whole deployment** — they identify *this service
provider* to every IdP, exactly as the user-token signing key identifies it to
every relying service. They are not per org; trust is still per org, because
each IdP pins the certificate it imported.

| Purpose (`_id` in `saml_sp_keys`) | What it is | Used for |
|---|---|---|
| `signing` | RSA-2048 + self-signed X.509 (10 years) | signs AuthnRequests when an org turns on *Sign AuthnRequests*, and **always** signs LogoutRequest/LogoutResponse |
| `encryption` | RSA-2048 + self-signed X.509 | the certificate an IdP encrypts assertions to, when the org turns on *Identity provider encrypts assertions* |
| `test-marker` | 32-byte HMAC secret, no certificate | signs the dry-run marker carried in the SSO `state` / `RelayState` on a **Test connection** |

They are **auto-generated on first use and persisted**, never supplied through
deploy config: there is no env var, no file, no Secret and nothing to mount on
any target. The private halves are stored only as `EncryptedBlob`s under
`SECRET_ENCRYPTION_KEY` (context `saml-sp-keys`); the certificates are public by
design and stored in clear. The `_id` is the purpose, so two replicas racing to
generate collide on the primary key and the loser re-reads the winner's row.

**There is no overlap window, and no `_PREVIOUS`.** A `saml_sp_keys` document is
current or absent. That is a deliberate consequence of where the trust lives:
the *IdP* holds our certificate, so an overlap would have to be expressed in
every customer's IdP configuration, not in ours. A rotation is therefore a
**coordinated, announced event** — and the keys are cached per process precisely
so it cannot happen underneath a live sign-in.

**Who this affects.** Only orgs that have turned on signed AuthnRequests,
single logout, or encrypted assertions. An org doing plain SP-initiated SAML with
an unsigned request and a plaintext assertion never sees our certificates, and a
rotation is invisible to it. Check before you schedule one — it is often nobody.

**Steps**

1. **Tell the affected orgs first.** Each one's IdP administrator must re-import
   the SP metadata, and until they do, signed requests / SLO / encrypted
   assertions fail for that org. Give them the window.
2. **Take a copy first** (see *Rollback*), then drop the documents you are
   rotating. Open a shell on the database — the credentials are the ones the
   container already holds, exactly as in its own readiness probe:
   ```bash
   # k8s targets
   kubectl -n pipeline-builder exec -it deploy/mongodb -- bash -c \
     'mongosh --host localhost:27017 --username "$MONGO_INITDB_ROOT_USERNAME" \
        --password "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin platform'
   # docker
   cd deploy/local/docker && docker compose exec mongodb bash -c \
     'mongosh --host localhost:27017 --username "$MONGO_INITDB_ROOT_USERNAME" \
        --password "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin platform'
   ```
   Then, at the `mongosh` prompt — all three, or just the purpose you are
   rotating. Dropping only `signing` leaves encryption and the test marker
   untouched:
   ```javascript
   db.saml_sp_keys.deleteMany({})                  // rotate all three
   db.saml_sp_keys.deleteOne({ _id: 'signing' })   // or just one purpose
   ```
3. Restart **platform only** — no other service holds or reads these. The
   per-process cache is what makes the restart mandatory; without it, replicas
   keep serving the deleted keys until they happen to recycle.
   ```bash
   kubectl -n pipeline-builder rollout restart deploy/platform
   # docker
   cd deploy/local/docker && docker compose up -d --force-recreate platform
   ```
4. Confirm a fresh key was minted — the platform log carries
   `Generated SAML service-provider key` once per purpose — and read the new
   certificate back:
   ```bash
   curl -sk "https://<host>/api/auth/sso/<orgId>/saml/metadata" | grep -c X509Certificate
   ```
5. **Each affected org re-imports the SP metadata at its IdP** — the metadata
   URL from step 4 *is* the document, and most IdPs import everything from it.
   The org's own administrator can read the same values from **Settings → Single
   Sign-On**, which serves them from `GET /organization/:id/idp/sp-info`.
6. Verify per org: a SAML sign-in succeeds, and a single logout round-trips for
   any org that has an SLO URL configured.

**Verify**

- `platform_saml_signins_total{result="success"}` advances for each affected org
  after its re-import.
- A `result` of `invalid_assertion` on an org with encrypted assertions means
  that org is still encrypting to the retired certificate — it has not
  re-imported. Same audit trail as any other refusal: `sso.saml.refused`.
- A stale **signing** certificate fails earlier and is *not* in this metric: the
  IdP rejects our AuthnRequest signature before an assertion exists, so the
  person never returns and the symptom is an error at the IdP. Ask the affected
  org's administrator what their IdP is reporting rather than looking here.
- An org that never enabled signing, SLO or encryption should show no change at
  all. If it does, the rotation touched more than it should have.

**Rollback** — only if you kept a copy. Deleting the document destroys the
private half, and the new key is minted before anyone asks for the old one, so
**take a `mongodump` of `saml_sp_keys` before step 2** if you want a way back.
Restoring the dump and restarting platform puts the previous certificates back
and un-does the re-import obligation.

**Coupling to `SECRET_ENCRYPTION_KEY`** — the private halves are wrapped under
the master key and the fleet re-encryption tool does **not** cover them, so a
master-key rotation must roll these too (step 4 of that section). The cheap
order is: roll these *during* the master-key overlap window, so a mistake is
still recoverable from the previous key.

**Compromise response** — a leaked SP signing key lets someone forge our logout
messages to an IdP, and a leaked encryption key exposes any assertion captured in
transit. Neither lets anyone sign in as a user (the IdP's signature is what
authenticates an assertion). So: rotate at once, in the order above, and accept
the failed sign-ins for orgs that have not yet re-imported — do not wait for a
comfortable window.

**Proof** — `platform/test/saml-sp-keys.test.ts` (generated once, private halves
stored ENCRYPTED, reused rather than regenerated, and the two-replica race
converging on one winner).

---

## Service-account keys

Service accounts are first-class principals — non-human members of an org —
whose keys are created and revoked per account. There is no `_PREVIOUS` value
and no overlap *window* in the sense used above; instead a service account may
legitimately hold **two live keys at once** during a rollout, which is the same
idea reached from the other end. A key is revoked, not overlapped.

1. `POST /organization/:id/service-accounts/:accountId/keys` → new key material
   (`pb_sa_…`), returned **once** — only a hash is stored. Pass `scope` for a
   least-privilege key. Requires `service_accounts:manage`, a second factor
   (`aal: 2`) and a step-up, and a service-account key can never satisfy step-up
   itself, so one key cannot mint another.
2. Roll the consumers (CI jobs, automation, the IdP's provisioning config) onto
   it. Both keys authenticate meanwhile.
3. `DELETE /organization/:id/service-accounts/:accountId/keys/:keyId` on the old
   key. **Not** step-up gated — revocation only ever removes access, and a
   compromise response must never be blocked on a second factor.
4. Verify: the consumer's next run succeeds, the old key 401s, and the account's
   `lastUsedAt` advances. In the UI, **Settings → Service Accounts** lists each
   account and its keys. Create and revoke are audited as
   `org.service-account.key.create` / `org.service-account.key.revoke`.

Rollback: before step 3, switch the consumer back; after step 3, create another
key. Compromise response is the same flow with step 3 first.

The stored AWS machine credentials rotate themselves on this mechanism —
`rotate → store → revoke`, audited as `org.service-account.key.rotate` — and
have their own runbook: [Access Key Cutover → Machine
credentials](access-key-cutover.md#machine-credentials-the-service-accounts).

### SCIM provisioning keys

A SCIM credential is not a separate kind of token: it is a **service-account key
carrying the `scim` capability scope**, issued under **Settings → Single Sign-On
→ SCIM provisioning** through the route above. The scope is the whole boundary —
a scoped key carries no permissions and no features, every SCIM route resolves
its org from the key's own `organizationId` claim rather than from a path or a
body, and a *person's* token is refused outright. So a stolen SCIM key can
provision members in one org and do nothing else anywhere.

Rotate it exactly as above, with step 2 being "paste it into the IdP's
provisioning config (Okta/Entra: *Provisioning → API token*) and run a test
sync". Verify with a successful sync after the revoke, and watch
`platform_scim_requests_total{result="denied"}` /
`platform_scim_errors_total{reason="wrong_credential"}` stay flat — a bump there
means the IdP is still presenting the revoked key.

---

## Auth material that is not a secret — and does not rotate

Every item above is a credential someone could steal. These are the auth-adjacent
things operators reach for this runbook expecting to find, which have **no secret
value, no `_PREVIOUS`, no probe and no `SecretRotationPreviousLingering`
coverage**. They are listed so a rotation review can tick them off rather than go
looking.

| Item | Why it never rotates |
|---|---|
| Passkey (WebAuthn) credentials | Only the **public** key is stored. There is nothing at rest to leak and nothing to re-encrypt. A credential is registered or revoked, never rotated. |
| The relying-party ID (`rpID`) | Derived from `PLATFORM_FRONTEND_URL` and validated at boot. A registered passkey is bound to it **permanently**, so changing it orphans every credential on the deployment. Treat it as immutable, not as a knob. |
| Recovery codes | SHA-256 hashes, single-use. Re-minted by the account holder; unaffected by a `SECRET_ENCRYPTION_KEY` rotation. |
| `PASSWORD_BREACH_CHECK`, `PASSWORD_BREACH_CHECK_URL`, `PASSWORD_BREACH_CHECK_TIMEOUT_MS` | Settings, not credentials. The HIBP range API is **unauthenticated** — there is no API key to hold — and only the first 5 hex characters of a password's SHA-1 ever leave the process. |
| `FIDO_MDS_URL`, `FIDO_MDS_FETCH_TIMEOUT_MS`, `FIDO_MDS_REFRESH_MS` | Settings. The MDS endpoint is public and unauthenticated; the blob's own signature chain is what makes it trustworthy, not a credential we hold. |
| `FIDO_MDS_BLOB_PATH` | Not a secret — but the **file behind it goes stale**, which is the one maintenance task in this table. See below. |

### Refreshing the FIDO MDS blob (`FIDO_MDS_BLOB_PATH`)

FIDO metadata is only consulted for orgs that set an approved-authenticator
(AAGUID) allowlist: those registrations request DIRECT attestation and verify it
against MDS, and are **refused while no metadata is loaded** — the policy asked
for provenance that cannot be checked, so it fails closed.

With `FIDO_MDS_URL` in use (the default), nothing to do: the blob is re-fetched
every `FIDO_MDS_REFRESH_MS` (24 h). The maintenance applies to the **air-gapped
path**, where `FIDO_MDS_BLOB_PATH` points at a blob JWT downloaded out of band —
that file wins over the URL, is the only source consulted, and **never updates
itself**. A stale file means new authenticator models are unknown (their
registrations are refused) and, worse, models revoked or marked compromised since
the download are still accepted.

**This path is opt-in and unwired.** `FIDO_MDS_BLOB_PATH` ships commented out in
every `.env.example` and no deploy target mounts a blob, so choosing it means
you also own getting the file into the container — a ConfigMap or Secret plus a
volume mount on the k8s targets, a bind mount under compose. The examples below
assume a `fido-mds` Secret you created; adapt them to whatever you mounted.

Refresh it on the FIDO Alliance's own cadence — monthly is comfortable, and any
time the platform log shows `FIDO metadata load failed`:

```bash
curl -fsS https://mds.fidoalliance.org/ -o /tmp/fido-mds.jwt
# k8s targets — replace the mounted object, then restart
kubectl -n pipeline-builder create secret generic fido-mds \
  --from-file=fido-mds.jwt=/tmp/fido-mds.jwt \
  --dry-run=client -o yaml | kubectl apply -f -
kubectl -n pipeline-builder rollout restart deploy/platform
# docker — replace the bind-mounted file, then recreate platform
cd deploy/local/docker && docker compose up -d --force-recreate platform
```

A restart is what picks it up: the snapshot is cached in memory for
`FIDO_MDS_REFRESH_MS` and the file is read only when that expires, so replacing
the file alone can leave a replica serving day-old metadata for up to a day.

**Verify** — `platform_fido_mds_loads_total{outcome="success",source="file"}`
increments after the restart, and the platform log records
`FIDO metadata loaded` with a `models` count and the blob's sequence number
(`blobNo`); compare that number with the previous load to confirm the file
actually changed. A registration into an allowlisted org is the end-to-end check.

**If it fails** — a failed load **keeps the previous snapshot**: stale signed
metadata is still signed metadata, and dropping it would refuse every
allowlisted registration until the next success. So a bad file is not an
immediate outage, and `platform_fido_mds_loads_total{outcome="failure"}` is the
only signal you get. A load is not retried for 5 minutes after a failure, so an
unreachable or malformed source costs one timeout per window, not one per
request. With **no** snapshot at all — a first boot with a bad file — allowlisted
registrations are refused; orgs with no allowlist are unaffected either way.

---

## Alert and metric reference

| Item | Value |
|---|---|
| Metric | `secret_rotation_previous_set{service,secret}` — gauge, 1 while the overlap value is set |
| Exported by | every service (`/metrics`), including platform; probes registered in api-core (`SERVICE_SIGNING_KEY`), platform (`TOKEN_SIGNING_KEY`, `SECRET_ENCRYPTION_KEY`, `ALERT_WEBHOOK_INSTANCE_TOKEN`) and image-registry (`REGISTRY_TOKEN_CERTIFICATE`) |
| Alert | `SecretRotationPreviousLingering` — `max by (service, secret) (secret_rotation_previous_set) == 1` `for: 24h`, `severity: warning`, `component: auth`, `tenancy: platform` |
| Defined in | `deploy/{local/docker,local/minikube,aws/ec2,aws/eks}/config/prometheus/alert-rules.yml` (unit-tested in `deploy/local/minikube/config/prometheus/alert-rules.test.yml`) |

The alert aggregates away `pod`/`instance` on purpose: a rolling restart during
the rotation would otherwise start a new series and reset the 24h timer.

**Arriving from the alert**, `{{ $labels.secret }}` names the section that
finishes the rotation, and `{{ $labels.service }}` names what to restart:

| `secret` label | Finish it here | What "finish" means for it |
|---|---|---|
| `TOKEN_SIGNING_KEY` | [User-token signing key](#user-token-signing-key-es256-rotated-by-kid) | clear `TOKEN_SIGNING_KEY_PREVIOUS_FILE` (or `TOKEN_SIGNING_KMS_KEY_PREVIOUS_ID`), re-create the Secret, restart platform |
| `SERVICE_SIGNING_KEY` | [Internal service signing keys](#internal-service-signing-keys-es256-per-service) | `service-signing-keys.sh … --finish <service>`, re-push `service-key-bundle`, restart that service |
| `SECRET_ENCRYPTION_KEY` | [`SECRET_ENCRYPTION_KEY`](#secret_encryption_key) | `pb_finish_env_rotation`, re-push `app-secrets`, restart platform — **only after** the re-encryption reports `failures: 0` and steps 4–5 are done |
| `ALERT_WEBHOOK_INSTANCE_TOKEN` | [`ALERT_WEBHOOK_INSTANCE_TOKEN`](#alert_webhook_instance_token-alert-relay) | `pb_finish_env_rotation`, re-push `alertmanager-relay`, restart platform |
| `REGISTRY_TOKEN_CERTIFICATE` | [Image-registry signing key](#image-registry-signing-key) | trim the trust bundle to the new cert, restart registry then image-registry |

`SECRET_ENCRYPTION_KEY` is the one label where "finish it" is not a 30-second
job — it gates on data being migrated first, and on a decision about
authenticator-app enrolments. A long-running one is expected; an *unexplained*
one is the problem.

If a rotation legitimately needs a longer window (the user-token signing key at a
30-day refresh TTL is the usual case), record it — the alert firing is the
expected signal that the window is open, and it should be closed as soon as the
tokens have aged out.

A second alert covers the verifier side of the signing key:

| Item | Value |
|---|---|
| Metric | `jwks_fetch_total{service,source,result}` — counter; `result` is `success`, `error` or `empty` |
| Alert | `JwksFetchFailing` — `sum by (service) (rate(jwks_fetch_total{result!="success"}[5m])) > 0` `for: 10m`, `severity: critical`, `component: auth` |
| Why critical | a verifier that cannot obtain the key set FAILS CLOSED (503) once its 10-minute cache goes stale, so sustained errors are a fleet-wide auth outage forming |

`jwks_unknown_kid_refetch_total{service,source}` counts the one-per-cooldown
refetch a verifier makes when it sees a `kid` it does not know — a small bump is
the expected signature of a rotation; a sustained rate means something is
presenting forged `kid`s.

`shared_secret_user_token_rejected_total{service,alg}` counts shared-secret
tokens that claimed to be a USER and were refused. It should be **flat at zero**
after the cutover: a non-zero rate means something is still minting the old token
shape — a stale client, or a service that should not be trying.
