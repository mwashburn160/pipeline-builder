---
layout: default
title: Access Keys and Machine Credentials
---

# Access Keys and Machine Credentials

Every credential a **person** or a **machine** presents to this platform is an
opaque access key (`pb_pat_…` for a person, `pb_sa_…` for a service account)
that the caller trades at platform for a 5-minute token — see
[Authentication → Access keys](../authentication.md#access-keys-opaque-verified-by-exchange)
for the design and why it is the only shape in which revocation actually works.
Nothing here is a JWT, and there is no other shape a key can take: the key is a
secret the server never had, so it can only be issued, never derived.

This runbook is what an operator does on a **fresh install**: issue the personal
keys people need, and provision the three machine credentials an AWS deployment
cannot run without. Every step is repeatable — re-running it rotates rather than
duplicates.

> A key is shown **once**. Only its SHA-256 is stored, so a lost key is reissued,
> never recovered.

---

## What holds a key

| Credential | Issued by | Notes |
|---|---|---|
| Personal access key | `POST /user/keys`, `pipeline-manager auth pat` | A person's own; step-up gated, listed at **Dashboard → API Tokens** |
| The `reporting:ingest` webhook token on the Incident Reporting page | Settings → Incident reporting | A scoped key, not a person's credential |
| Stored platform credential (`pipeline-manager infra store-token`) | `POST /organization/:id/service-accounts/:accountId/keys` | A service-account key. See [Machine credentials](#machine-credentials-the-service-accounts) below |
| CodeBuild's registry credential | the `…/registry-push` secret | `registry:push` scope, no Roles |
| The `pipeline-events` Lambda's credential | the `…/reporting-ingest` secret | `reporting:ingest` scope, exchanged per batch |
| Browser sessions | sign-in | Not keys — ES256 user tokens |
| Service-to-service tokens | `signServiceToken` | Not keys — minted per call, 5-minute life |

The AWS secret **schema** is `{ username, password, platformUrl, … }`, and
`password` is the canonical field every consumer reads. Its value is an opaque
`pb_sa_…` key.

---

## Issuing personal keys

1. **Each holder creates their own**, either in the UI (**Dashboard → API Tokens
   → Access keys → Create key**, step-up gated) or from the CLI:

   ```bash
   pipeline-manager auth pat --name ci-deploy
   # or, to export it directly:
   eval $(pipeline-manager auth pat --name ci --quiet)
   ```

   Both open a browser to approve the sign-in and the step-up — there is no
   password flag on the CLI any more. That is not a convenience: the step-up is
   satisfied by the account's **real** factors (passkey, authenticator code),
   which live in the browser and not in a flag. `--no-browser` prints the
   verification URL instead, for a headless box.

   `--name` is required; `--expires-days` defaults to 90; `--scope` mints a
   least-privilege key carrying that one capability and no Roles.

   The printed `pb_pat_…` value is what `PLATFORM_TOKEN` and
   `Authorization: Bearer …` now expect. **Copy it immediately** — only its hash
   is stored, so it is never shown again.

   Two refusals to expect rather than debug. Creating a key needs a step-up, and
   a **machine credential can never satisfy one**, so a key cannot mint another
   key (`403 HUMAN_SESSION_REQUIRED`). And in an org that sets *administrative
   actions require MFA*, a session with no second factor is refused up front
   (`401 MFA_REQUIRED`, `details.reason: org_admin_policy`) — the org's policy
   asking, not the route.
2. **Generate the incident webhook token** on Settings → Incident reporting if
   the org uses one, and paste the value into the incident tool.
3. **Provision the stored machine credentials** — see the section below. That is
   the part with an ordering that matters, so do it from there rather than from
   memory.

## Machine credentials: the service accounts

Automation never holds a **person's** credential here. Every job that needs to
talk to platform gets an org **service account** holding a `pb_sa_…` key — one
account per job, with the narrowest scope that job needs — so no automation
inherits someone's authority, outlives their employment, or makes the audit trail
read as if they had personally pushed every image:

| Secret | Service account | Roles | Key scope | Read by |
|---|---|---|---|---|
| `pipeline-builder/{orgId}/platform` | `platform-automation` | org admin | none | CDK synth/deploy (`--store-tokens`), the plugin-lookup Lambda |
| `pipeline-builder/{orgId}/registry-push` | `registry-push` | **none** | `registry:push` | CodeBuild's `secretsManagerCredentials` |
| `pipeline-builder/{orgId}/reporting-ingest` | `reporting-ingest` | **none** | `reporting:ingest` | the event-ingestion Lambda |

`store-token` creates the account if it is missing, issues the key, writes the
secret, and only then retires the key the previous run stored — so an
interrupted run never leaves an empty secret.

`--scope` takes exactly the two catalogued values above (`registry:push`,
`reporting:ingest`); each selects its own service account. With no `--scope` the
key is issued on the org's single full-privilege `platform-automation` account.
`--account <name>` overrides the account a key lands on, and `--dry-run` shows
what would be provisioned without calling platform or writing to Secrets
Manager — worth doing once per AWS account before the real run.

### Provisioning, per AWS account

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

Then **synth and deploy every pipeline** (`pipeline-manager pipeline synth --id
<id> --store-tokens`, then deploy) so each build wires `…/registry-push` into its
build image. A pipeline synthesised before the registry-push secret existed falls
back to `…/platform`, which works but hands CodeBuild a full-privilege
credential — the whole point of the scoped account is unmet.

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

### Verifying

```bash
# Every stored credential, its expiry, and whether it is a key at all.
pipeline-manager infra audit-tokens --region <region>
```

A secret that does not hold a key — empty, or holding anything JWT-shaped — is
reported as **UNUSABLE** with the fix named, rather than being left to fail later
as an opaque `401` from three different services. The same guard is built into
the consumers: the events Lambda and the rotator both refuse a non-key at startup
with a message naming `store-token`.

In the UI, **Settings → Service Accounts** lists the three accounts, their Roles
(two of them hold none) and their keys. `Dashboard → API Tokens` shows the same
keys labelled with the owning account.

### Why none of these is a person

| Job | What it holds | Why not a person's credential |
|---|---|---|
| `store-token` | service-account key on `platform-automation` | a machine-session JWT would inherit the operator's authority and outlive them |
| the daily Lambda | key rotator (rotate → store → revoke) | re-minting under a person's session ties the fleet to one account |
| events Lambda | a key it exchanges per batch | it verifies nothing itself; the exchange is the check |
| CodeBuild | `registry:push`-scoped key, no API permissions | a full-privilege secret in a build container is the blast radius |
| deploy plugin/template/compliance loads | the system-org `setup` service account | an admin-password re-login puts a human password in a script |

## After provisioning

- **Watch the exchange metrics.** On platform:
  `platform_api_key_exchange_total{result="success"}` should rise to roughly
  *(number of live keys) × (pods using them)* per 5 minutes, and
  `platform_api_key_exchange_failed_total{reason="unknown"}` should be zero. A
  `reason="unknown"` that keeps climbing is an automation pointed at a key that
  was never issued or has been revoked — find it in the audit log
  (`user.key.exchange.failed`, which records the client IP and user-agent)
  rather than waiting for a ticket.
- **On the services**, `api_key_exchange_failures_total{reason="unavailable"}`
  should be flat. A sustained non-zero value means the services cannot reach
  platform; those requests are answering `503`, not silently passing.
- **Sweep the leftovers.** The keys page flags keys that have **never been used**
  — after a week those are almost always a duplicate issued while someone was
  getting their setup working. Revoke them.

---

## See also

- [Authentication → Access keys](../authentication.md#access-keys-opaque-verified-by-exchange)
- [Authentication → Scoped keys](../authentication.md#scoped-keys--one-capability-no-roles) and [Self-rotation](../authentication.md#self-rotation--how-an-unattended-machine-replaces-its-own-key)
- [Audit Events](../audit-events.md) — `user.key.create`, `user.key.revoke`, `user.key.exchange`, `user.key.exchange.failed`, `org.service-account.key.rotate`
- [Secret Rotation](secret-rotation.md) — the overlap-window pattern the *other* secrets rotate with (access keys deliberately have none: a key is revoked, not overlapped). Once the credentials above are provisioned, the steady-state procedure for them is [Secret Rotation → Service-account keys](secret-rotation.md#service-account-keys).
