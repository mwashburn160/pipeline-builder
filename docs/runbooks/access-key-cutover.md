---
layout: default
title: Access Key Cutover
---

# Access Key Cutover Runbook

Personal access tokens were JWTs. They are now **opaque access keys**
(`pb_pat_…`) that a caller trades at platform for a 5-minute token — see
[Authentication → Access keys](../authentication.md#access-keys-opaque-verified-by-exchange)
for the design and why it is the only shape in which revocation actually works.

**There is no backward compatibility, and no migration.** A JWT PAT cannot be
turned into a key: the key is a secret the server never had, so it cannot be
derived from an existing record. At the release, **every existing personal access
token stops working.** This runbook is the one-time reissue that follows.

> This is a **one-way** cutover. Once the release is deployed, the old tokens are
> refused everywhere; the only remedy is to issue new keys.

---

## What breaks, exactly

| Credential | Created by | Survives the release? |
|---|---|---|
| Personal access token (JWT) | `POST /user/pats`, `pipeline-manager auth pat` | **No** — reissue as an access key |
| The `reporting:ingest` webhook token on the Incident Reporting page | Settings → Incident reporting | **No** — regenerate (it is now a scoped key) |
| Stored platform credential (`pipeline-manager infra store-token`) | `POST /user/generate-token` | **No** — it is a service-account key now, not a person's JWT. See [Machine credentials](#machine-credentials-the-service-account-cutover) below |
| CodeBuild's registry credential | the `.../platform` secret | **No** — it moves to a new `.../registry-push` secret |
| The `pipeline-events` Lambda's credential | the `.../reporting-ingest` secret | **No** — it stores a key and exchanges it per batch |
| Browser sessions | sign-in | No — everyone signs in once more |
| Service-to-service tokens | `signServiceToken` | Yes (minted per call) |

The secret **schema** is unchanged — `{ username, password, platformUrl, … }`,
and `password` is still the canonical field every consumer reads. What changed is
its **value**: an opaque `pb_sa_…` key instead of a JWT.

---

## Before the release

1. **Announce it.** Name the date and tell holders that every PAT will stop
   working at that moment, and that the replacement is copy-once.
2. **Inventory who holds one.** From the audit log:

   ```
   action = user.pat.create        # the historical create events
   ```

   and, per account, **Dashboard → API Tokens → Access keys** lists what that
   user holds. There is no fleet-wide listing endpoint — keys belong to people.
3. **Find every place a PAT is stored**: CI secrets, `PLATFORM_TOKEN` exports in
   automation, incident-tool webhook configuration, and any AWS Secrets Manager
   entry a team created by hand.

## At the release

1. Deploy. Every PAT is now refused (`401`, `ACCESS_KEY_INVALID` on the exchange
   endpoint).
2. **Each holder reissues**, either in the UI (**Dashboard → API Tokens → Access
   keys → Create key**, step-up gated) or from the CLI:

   ```bash
   pipeline-manager auth pat --name ci-deploy
   # or, to export it directly:
   eval $(pipeline-manager auth pat --name ci --quiet)
   ```

   Both open a browser to approve the sign-in and the step-up — there is no
   password flag on the CLI any more.

   The printed `pb_pat_…` value is what `PLATFORM_TOKEN` and
   `Authorization: Bearer …` now expect. **Copy it immediately** — only its hash
   is stored, so it is never shown again.
3. **Re-generate the incident webhook token** on Settings → Incident reporting if
   the org uses one, and paste the new value into the incident tool.
4. **Reissue every stored machine credential** — see the section below. This is
   the part with an ordering that matters, so do it from there rather than from
   memory.

## Machine credentials: the service-account cutover

Everything automation used to store was a **person's** credential: `store-token`
minted a machine-session JWT under whoever ran it, and a second Lambda re-minted
it daily under that same session. It inherited their authority, it outlived their
employment, and the audit trail read as if they had personally pushed every image.

That is replaced, forward-only, by org **service accounts** holding `pb_sa_…`
keys — one account per job, with the narrowest scope that job needs:

| Secret | Service account | Roles | Key scope | Read by |
|---|---|---|---|---|
| `pipeline-builder/{orgId}/platform` | `platform-automation` | org admin | none | CDK synth/deploy (`--store-tokens`), the plugin-lookup Lambda |
| `pipeline-builder/{orgId}/registry-push` | `registry-push` | **none** | `registry:push` | CodeBuild's `secretsManagerCredentials` |
| `pipeline-builder/{orgId}/reporting-ingest` | `reporting-ingest` | **none** | `reporting:ingest` | the event-ingestion Lambda |

`store-token` creates the account if it is missing, issues the key, writes the
secret, and only then retires the key the previous run stored — so an
interrupted run never leaves an empty secret.

### Reissue, per AWS account

Both writes are step-up gated, so `store-token` needs the operator's password.
Put it in the environment rather than on the command line (it shows in shell
history and in `provision` plan output):

```bash
export PLATFORM_BASE_URL=https://<your-platform>
export PLATFORM_PASSWORD='…'          # the operator's own password
export AWS_REGION=<region>

# 1. The org's full-privilege automation credential (synth/deploy, plugin lookup)
pipeline-manager infra store-token --schedule

# 2. The CI registry credential CodeBuild presents as Basic auth. REQUIRED:
#    synth wires `.../registry-push` into every build image unconditionally.
pipeline-manager infra store-token --scope registry:push --schedule

# 3. The event-ingestion credential the Lambda reads
pipeline-manager infra store-token --scope reporting:ingest --schedule

# 4. Redeploy the ingestion Lambda so it runs the key-exchanging handler
pipeline-manager infra setup-events --scoped-ingest
```

Then **re-synth and redeploy every pipeline** (`pipeline-manager pipeline synth
--id <id> --store-tokens`, then deploy). Until you do, CodeBuild still points at
`.../platform` for its build-image pull and will keep working — but the new
registry-push secret is not in use, and the point of the cutover is unmet.

### What `--schedule` now installs

The daily Lambda is a **key rotator**, not a token re-minter. It no longer
npm-installs the CLI at runtime; it calls two pre-auth platform endpoints where
the key itself is the authorization, in this order:

1. `POST /auth/key/rotate` — mint a sibling key. The current key stays live.
2. `PutSecretValue` — the secret now names the new key.
3. `POST /auth/key/revoke` — retire the predecessor, authenticated with the new key.

A failure at step 1 leaves the secret untouched; at step 2, the secret still names
the live old key; at step 3, both keys work and the stale one expires on its own
(logged at ERROR, not retried — a retry would rotate again). There is no ordering
in which the deployment is left without a working credential.

### Verifying the cutover

```bash
# Every stored credential, its expiry, and whether it is a key at all.
pipeline-manager infra audit-tokens --region <region>
```

A secret still holding a pre-cutover JWT is reported as **UNUSABLE** with the fix
named, rather than being left to fail later as an opaque `401` from three
different services. The same guard is built into the consumers: the events Lambda
and the rotator both refuse a JWT at startup with a message naming `store-token`.

In the UI, **Settings → Service Accounts** lists the three accounts, their Roles
(two of them hold none) and their keys. `Dashboard → API Tokens` shows the same
keys labelled with the owning account.

### Where the person-shaped credentials went

| Was | Is |
|---|---|
| `store-token` → machine-session JWT under the operator | service-account key on `platform-automation` |
| token-renew Lambda → re-mint under the same session | key rotator (rotate → store → revoke) |
| events Lambda → reads a JWT, verifies it against JWKS | reads a KEY, exchanges it per batch, verifies nothing |
| CodeBuild → the org's full-privilege platform secret | `registry:push`-scoped key, no API permissions |
| deploy plugin/template/compliance loads → admin password re-login | the system-org `setup` service account (already shipped with #2) |

## After the release

- **Watch the exchange metrics.** On platform:
  `platform_api_key_exchange_total{result="success"}` should rise to roughly
  *(number of live keys) × (pods using them)* per 5 minutes, and
  `platform_api_key_exchange_failed_total{reason="unknown"}` should fall to zero
  once the last stale credential is retired. A `reason="unknown"` that keeps
  climbing after the cutover window is an automation nobody reissued — find it in
  the audit log (`user.key.exchange.failed`, which records the client IP and
  user-agent) rather than waiting for a ticket.
- **On the services**, `api_key_exchange_failures_total{reason="unavailable"}`
  should be flat. A sustained non-zero value means the services cannot reach
  platform; those requests are answering `503`, not silently passing.
- **Sweep the leftovers.** The keys page flags keys that have **never been used**
  — after a week those are almost always a duplicate issued during the cutover.
  Revoke them.

---

## Rolling back

There is no rollback that keeps the new keys working: a previous build has no
key collection to check, so it would fall back to verifying JWTs and refuse every
`pb_pat_…`. If you must roll back, expect to reissue in the other direction too —
which is why the announce step above is not optional.

---

## See also

- [Authentication → Access keys](../authentication.md#access-keys-opaque-verified-by-exchange)
- [Authentication → Scoped keys](../authentication.md#scoped-keys--one-capability-no-roles) and [Self-rotation](../authentication.md#self-rotation--how-an-unattended-machine-replaces-its-own-key)
- [Audit Events](../audit-events.md) — `user.key.create`, `user.key.revoke`, `user.key.exchange`, `user.key.exchange.failed`, `org.service-account.key.rotate`
- [Secret Rotation](secret-rotation.md) — the overlap-window pattern the *other* secrets rotate with (access keys deliberately have none: a key is revoked, not overlapped)
