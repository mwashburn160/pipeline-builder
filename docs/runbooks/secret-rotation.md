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
| `aws/ec2` | `deploy/aws/ec2/.env` (on the instance) | same Secrets as minikube, created by `deploy/bin/k8s-resources.sh` (`pb_create_app_secrets`, `pb_create_token_signing_secret`) | `kubectl patch` below, or re-run `bin/startup.sh` |
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

The AES-256-GCM master key behind every encrypted-at-rest column: org AI
provider keys (`Organization.aiProviderKeys.*`) and per-org SSO client secrets
(`OrgIdpConfig.clientSecretEncrypted`). Platform is the only holder.

This one is different: the old key is needed to **read** existing rows, so the
overlap window is not about tokens in flight — it is the time it takes to
re-encrypt the stored data. `SECRET_ENCRYPTION_KEY_PREVIOUS` is **decrypt-only**;
new writes always use the current key.

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
   It walks every org and every IdP config, decrypts through the fallback and
   rewrites under the current key. It exits **non-zero** and lists each row it
   could not decrypt — such a row's secret was written under a key you no longer
   have and must be re-entered by the org admin (AI keys: Settings → AI
   providers; SSO: Admin → org → IdP). Re-run until it reports `failures: 0`.
4. `pb_finish_env_rotation deploy/<target>/.env SECRET_ENCRYPTION_KEY`, re-push,
   restart platform.

**Verify**

- Step 3 prints `orgsScanned`, `aiKeysReencrypted`, `idpSecretsReencrypted`,
  `failures: 0`.
- After step 4, exercise a decrypt path — e.g. an AI generation for an org with
  a stored provider key, and an SSO login for an org with a client secret. A
  failure here means step 3 missed a row.
- `secret_rotation_previous_set{secret="SECRET_ENCRYPTION_KEY"}` back to 0.

**Rollback** — until step 4, restore the previous key as
`SECRET_ENCRYPTION_KEY` and restart; rows already rewritten under the new key
then need the new key as `_PREVIOUS` (i.e. swap the two values) to stay
readable. **After step 4 there is no rollback** — dropping the old key with rows
still wrapped under it makes those secrets unrecoverable, which is exactly why
step 3 gates on `failures: 0`.

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

## SCIM tokens — *applies once SCIM provisioning ships (roadmap #3b)*

SCIM bearer tokens are per-org, created and revoked through the org's SSO admin
API, so they rotate by **create-new, switch, revoke-old** rather than by a
`_PREVIOUS` env value:

1. `POST /api/organization/:id/scim/tokens` → returns the new token once (only a
   hash is stored). Both tokens are now valid — the overlap window.
2. Paste it into the IdP's provisioning config (Okta/Entra: *Provisioning → API
   token*) and run a test sync.
3. `DELETE /api/organization/:id/scim/tokens/:tokenId` to revoke the old one.
4. Verify: a provisioning sync succeeds after step 3, and the old token returns
   401. The revoke is audited (`scim.token.revoked`).

Rollback: before step 3, re-point the IdP at the old token; after step 3, issue a
fresh one (a revoked token is never reinstated).

## Service-account keys — *applies once service accounts ship (roadmap #2)*

Service accounts are first-class principals whose keys are created and revoked
per account, so the same create-new/revoke-old shape applies — and unlike the
shared secrets above, a service account may legitimately hold **two** live keys
during a rollout:

1. `POST /api/service-accounts/:id/keys` → new key material, returned once.
2. Roll the consumers (CI jobs, automation) onto it; both keys authenticate
   meanwhile.
3. `DELETE /api/service-accounts/:id/keys/:keyId` on the old key.
4. Verify: the consumer's next run succeeds, the old key 401s, and the service
   account's `lastUsedAt` advances. Key create/revoke are audited.

Rollback: before step 3, switch the consumer back; after step 3, create another
key. Compromise response is the same flow with step 3 first.

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
