#!/usr/bin/env bash
# Copyright 2026 Pipeline Builder Contributors
# SPDX-License-Identifier: Apache-2.0
#
# Shared .env secret generation for EVERY deploy target: ec2 (bootstrap.sh), eks,
# minikube and docker (each target's setup.sh) all source this.
# SOURCE this file (it only defines a function — no side effects).
#
# SHELL OPTIONS: this file is SOURCED, never executed, so it deliberately sets
# NO `set -euo pipefail`. `set` inside a sourced file mutates the CALLER's shell
# — it would silently turn on errexit for whatever sourced us (including an
# interactive shell, where a failed command would then close the terminal).
# Every caller already runs under `set -euo pipefail`; these functions therefore
# propagate failure the portable way, by RETURNING non-zero, so they behave the
# same whether or not the caller has errexit on.
#
#   pb_gen_env_secrets <env_file> [ghcr_user]
#
# Fills the secret CHANGE_ME placeholders common to EVERY target's .env.example with fresh
# random values, in an .env the CALLER has already copied from .env.example. The values are
# written into the file (the caller sources the file afterward); they are NOT exported.
# Target-specific keys — domain, region, email/SES wiring, deploy-mode/VPC, GHCR_TOKEN — are
# substituted by the caller, since they diverge across targets.
#
# Secrets are base64 with +/= stripped, so they contain no sed-delimiter or regex-special
# chars and embed safely in the s|…| substitutions below. Uses `sed -i.bak` (GNU + BSD/macOS).
#
# Also defines the ROTATION helpers pb_rotate_env_secret / pb_finish_env_rotation
# (see docs/runbooks/secret-rotation.md): they move a live secret's value into its
# <KEY>_PREVIOUS overlap slot and later clear it, which is how every secret rotates
# without an auth/alert/decrypt outage. Rotation is an operator step, never a
# permanent fallback — the SecretRotationPreviousLingering alert fires while a
# _PREVIOUS value stays set.
#
# NOTE: the MongoDB replica-set keyfile (deploy/*/mongodb-keyfile) is ALSO a per-deploy
# secret; it is managed separately by deploy/bin/mongo-keyfile.sh (pb_ensure_mongo_keyfile),
# which every target's setup calls (like jwt-keys.sh does for the registry keypair). It is
# gitignored and not tracked. This function only rewrites .env placeholders — it does not
# manage the keyfile.

# pb_sync_env_keys <env_file> <example_file>
#
# Append keys that exist in .env.example but not yet in an EXISTING .env, then
# fill any CHANGE_ME placeholders that were just added.
#
# Why this exists: each target seeds .env from .env.example only when .env is
# ABSENT, so a key added to the example later never reaches an existing install.
# The setup scripts then dereference it under `set -u` and die with a bare
#   setup.sh: line N: PLUGIN_S3_ACCESS_KEY: unbound variable
# which says nothing about the actual cause. (That is exactly how the MinIO
# credential rework broke provisioning on clusters whose .env predated it.)
#
# ADDITIVE ONLY — an existing key keeps its current value, always. Re-seeding the
# whole file instead would rotate POSTGRES_PASSWORD et al. against data volumes
# that survive a re-provision, which breaks the databases it was meant to protect.
pb_sync_env_keys() {
  local env_file="$1" example="$2" added=0 key line
  [ -f "$env_file" ] && [ -f "$example" ] || return 0
  while IFS= read -r line || [ -n "$line" ]; do
    # Uncommented KEY=value assignments only.
    case "$line" in
      [A-Z]*=*) key="${line%%=*}" ;;
      *) continue ;;
    esac
    grep -qE "^${key}=" "$env_file" && continue
    printf '%s\n' "$line" >> "$env_file"
    added=$((added + 1))
    echo "  + ${key} (new in .env.example)"
  done < "$example"
  [ "$added" -gt 0 ] && echo "  synced ${added} new key(s) into ${env_file}"

  # ALWAYS fill placeholders, not just when a key was appended. A .env created by
  # a plain `cp .env.example .env` (rather than through the seeding path, which
  # generates immediately) keeps literal CHANGE_ME values for POSTGRES_PASSWORD,
  # SECRET_ENCRYPTION_KEY and the rest — an install that comes
  # up with `CHANGE_ME` as a real credential. Substitution only rewrites
  # placeholder lines, so this is a no-op on an already-generated file, and the
  # guard inside pb_gen_env_secrets fails loudly if any required one survives.
  # SLACK_*_WEBHOOK_URL is operator-supplied — no generator can invent it — so
  # its placeholder must not trigger a pointless (and misleadingly-logged)
  # generation pass here. pb_check_alert_delivery is the gate for those.
  if grep -E '^[A-Z0-9_]+=CHANGE_ME' "$env_file" | grep -qv '^SLACK_'; then
    echo "  filling CHANGE_ME placeholders in ${env_file}"
    pb_gen_env_secrets "$env_file"
  fi
}

# pb_set_env_value <env_file> <KEY> <value>
#
# Rewrite (or append) a single KEY= line. awk -v, not sed: a secret value may
# contain characters sed would treat as part of the s||| expression.
pb_set_env_value() {
  local env_file="$1" key="$2" value="$3" tmp
  tmp=$(mktemp)
  awk -v k="$key" -v v="$value" '
    { if (!done && index($0, k "=") == 1) { print k "=" v; done = 1 } else print }
    END { if (!done) print k "=" v }
  ' "$env_file" > "$tmp"
  # `cat >` (not mv) so the .env keeps its existing owner/mode.
  cat "$tmp" > "$env_file"
  rm -f "$tmp"
}

# pb_rotate_env_secret <env_file> <KEY> [hex|base64]
#
# Step 1 of a secret rotation (docs/runbooks/secret-rotation.md): move KEY's
# CURRENT value into KEY_PREVIOUS and generate a fresh KEY. Both values are then
# live, so the overlap window costs no logouts / no unreadable secrets. The
# caller re-creates the target's Secrets/containers, then later calls
# pb_finish_env_rotation to end the window.
#
# `hex` for SECRET_ENCRYPTION_KEY (it must decode to exactly 32 bytes);
# base64-with-+/=-stripped (the default) for the token/bearer secrets.
pb_rotate_env_secret() {
  local env_file="$1" key="$2" kind="${3:-base64}" current new
  if [ ! -f "$env_file" ]; then
    echo "ERROR: $env_file not found" >&2; return 1
  fi
  if ! grep -qE "^${key}=" "$env_file"; then
    echo "ERROR: ${key} is not set in $env_file — nothing to rotate" >&2; return 1
  fi
  if ! grep -qE "^${key}_PREVIOUS=" "$env_file"; then
    echo "ERROR: ${key}_PREVIOUS is missing from $env_file (run the target's setup once to sync new .env.example keys)" >&2; return 1
  fi
  current=$(grep -E "^${key}=" "$env_file" | tail -1 | cut -d= -f2-)
  if [ -z "$current" ]; then
    echo "ERROR: ${key} is empty in $env_file — refusing to rotate an unset secret" >&2; return 1
  fi
  case "$kind" in
    hex)    new=$(openssl rand -hex 32) ;;
    base64) new=$(openssl rand -base64 32 | tr -d '=+/') ;;
    *)      echo "ERROR: unknown generator '$kind' (want hex|base64)" >&2; return 1 ;;
  esac
  pb_set_env_value "$env_file" "${key}_PREVIOUS" "$current"
  pb_set_env_value "$env_file" "$key" "$new"
  echo "  rotated ${key} — previous value kept in ${key}_PREVIOUS"
  echo "  now re-create the target's secrets + restart the services, THEN run: pb_finish_env_rotation $env_file $key"
}

# pb_finish_env_rotation <env_file> <KEY>
#
# Last step of a rotation: clear KEY_PREVIOUS so the old value stops being
# accepted. Until this runs, `secret_rotation_previous_set{secret="<KEY>"}` is 1
# and the SecretRotationPreviousLingering alert fires.
pb_finish_env_rotation() {
  local env_file="$1" key="$2"
  if [ ! -f "$env_file" ]; then
    echo "ERROR: $env_file not found" >&2; return 1
  fi
  pb_set_env_value "$env_file" "${key}_PREVIOUS" ""
  echo "  cleared ${key}_PREVIOUS — re-create the target's secrets + restart to end the overlap window"
}

# pb_env_value <env_file> <KEY>
#
# The raw value of one KEY, read from the FILE rather than the environment (so
# it works before the caller has sourced it, and is not shadowed by an inherited
# export). Last assignment wins, one layer of surrounding quotes stripped —
# matching what `source` would produce.
pb_env_value() {
  grep -E "^$2=" "$1" 2>/dev/null | tail -1 | cut -d= -f2- \
    | sed -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'\$/\1/"
}

# Internal: validate one Slack incoming-webhook URL. Not called directly.
_pb_check_slack_url() {
  case "$2" in
    '')
      echo "ERROR: $1 is empty while the other Slack webhook URL is set." >&2
      echo "       Set BOTH to deliver, or clear BOTH to run without ops-team Slack." >&2
      return 1 ;;
    CHANGE_ME*|*T00000000*|*CHANGE_ME*)
      echo "ERROR: $1 is still the shipped placeholder — alerts would 404 into nothing." >&2
      return 1 ;;
    https://hooks.slack.com/services/*)
      return 0 ;;
    *)
      echo "ERROR: $1 is not a Slack incoming-webhook URL (expected https://hooks.slack.com/services/...)." >&2
      return 1 ;;
  esac
}

# pb_check_alert_delivery <env_file> [alertmanager_yml]
#
# Pre-flight for the ALERT DELIVERY path. Every target's setup calls this BEFORE
# it creates the alertmanager Secret/ConfigMap, and treats a non-zero return as
# fatal.
#
# Why it is a deploy-time gate and not a runtime warning: alerting that reaches
# nobody is the worst kind of green. Prometheus fires, Alertmanager routes, Slack
# answers 404 for the placeholder webhook id, and the only trace is one line in a
# pod log nobody reads — the monitoring looks healthy precisely when it isn't.
# So an unset/placeholder webhook fails the DEPLOY instead.
#
# This is the `CHANGE_ME` guard from pb_gen_env_secrets extended past .env to the
# one CONFIG file that could carry a credential: alertmanager.yml must carry no
# webhook URL at all (the receivers read `api_url_file` out of the
# alertmanager-slack Secret), so any `hooks.slack.com` / CHANGE_ME / T00000000
# left in it means someone re-introduced a world-readable ConfigMap credential.
#
# Running WITHOUT ops-team Slack is a legitimate choice — set BOTH keys to an
# EMPTY value and this prints a banner naming exactly what stops working, then
# succeeds. What it will not do is let a placeholder through silently.
pb_check_alert_delivery() {
  local env_file="$1" am_yml="${2:-}" crit warn bad=0
  crit=$(pb_env_value "$env_file" SLACK_CRITICAL_WEBHOOK_URL)
  warn=$(pb_env_value "$env_file" SLACK_WARNING_WEBHOOK_URL)

  if [ -n "$am_yml" ] && [ -f "$am_yml" ] && grep -qE 'CHANGE_ME|T00000000|api_url:' "$am_yml"; then
    echo "ERROR: $am_yml carries an inline webhook URL or placeholder." >&2
    echo "       Slack URLs belong in the alertmanager-slack Secret, read via" >&2
    echo "       api_url_file — a ConfigMap is world-readable to anyone with" >&2
    echo "       namespace read access." >&2
    bad=1
  fi

  if [ -z "$crit" ] && [ -z "$warn" ]; then
    echo ""
    echo "  ##########################################################################"
    echo "  #  ops-team Slack alerting is DISABLED — both SLACK_*_WEBHOOK_URL are"
    echo "  #  empty in $env_file."
    echo "  #"
    echo "  #  Platform-wide critical/warning alerts will fire into Alertmanager and"
    echo "  #  go NO FURTHER: no page, no channel, no mail. They are visible only at"
    echo "  #  Alertmanager's own UI/API. PER-ORG destinations are unaffected (they"
    echo "  #  go through the platform relay)."
    echo "  #"
    echo "  #  To deliver, set both keys to https://hooks.slack.com/services/... URLs."
    echo "  ##########################################################################"
    echo ""
    [ "$bad" -eq 0 ] || return 1
    return 0
  fi

  _pb_check_slack_url SLACK_CRITICAL_WEBHOOK_URL "$crit" || bad=1
  _pb_check_slack_url SLACK_WARNING_WEBHOOK_URL  "$warn" || bad=1
  if [ "$bad" -ne 0 ]; then
    echo "" >&2
    echo "  Fix in $env_file — create two Slack incoming webhooks" >&2
    echo "  (https://api.slack.com/messaging/webhooks), then either:" >&2
    echo "    SLACK_CRITICAL_WEBHOOK_URL=https://hooks.slack.com/services/T…/B…/…" >&2
    echo "    SLACK_WARNING_WEBHOOK_URL=https://hooks.slack.com/services/T…/B…/…" >&2
    echo "  or, to run deliberately without ops-team Slack, set BOTH to empty." >&2
    echo "" >&2
    return 1
  fi
  # LIVE check: a URL can be well-formed and still dead (webhook revoked,
  # channel archived, app removed) — Slack then answers 403/404/410 and every
  # alert vanishes exactly as with a placeholder. Post one clearly-labelled test
  # message to each. A definitive rejection fails the deploy; not being able to
  # reach Slack from THIS host (no egress, proxy) only warns — the cluster's
  # own path is proven after the deploy by post-provision-smoke.sh.
  # SKIP_ALERT_TEST_SEND=1 skips the send (e.g. re-running setup repeatedly).
  if [ "${SKIP_ALERT_TEST_SEND:-0}" != 1 ]; then
    _pb_send_slack_test SLACK_CRITICAL_WEBHOOK_URL "$crit" || bad=1
    _pb_send_slack_test SLACK_WARNING_WEBHOOK_URL  "$warn" || bad=1
    [ "$bad" -eq 0 ] || return 1
  fi
  echo "  alert delivery: ops-team Slack configured (critical + warning)"
  return 0
}

# Internal: POST one test message to a Slack incoming webhook. Returns non-zero
# only when Slack definitively REJECTED it (the URL is dead); a transport
# failure from this host is a warning. Not called directly.
_pb_send_slack_test() {
  local name="$1" url="$2" code
  command -v curl >/dev/null 2>&1 || { echo "  WARN: curl not found — skipping the $name test send" >&2; return 0; }
  code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 15 -X POST \
    -H 'Content-Type: application/json' \
    --data "{\"text\":\"Pipeline Builder deploy pre-flight: ${name} delivery test from $(hostname 2>/dev/null || echo setup) — safe to ignore.\"}" \
    "$url" 2>/dev/null) || code=000
  case "$code" in
    2??) echo "  alert delivery: $name accepted a test message" ; return 0 ;;
    000) echo "  WARN: could not reach Slack from this host to test $name (no egress?) — the post-deploy smoke check tests it from inside the cluster" >&2; return 0 ;;
    400|403|404|410)
      echo "ERROR: Slack REJECTED the test message for $name (HTTP $code) — the webhook is revoked, its channel archived, or the URL is wrong." >&2
      return 1 ;;
    *) echo "  WARN: unexpected HTTP $code from Slack for $name — check the webhook" >&2; return 0 ;;
  esac
}

pb_gen_env_secrets() {
  local env_file="$1" ghcr_user="${2:-mwashburn160}"
  local pg pgapp mongo me pgadmin registry seckey minioroot s3msg s3reg s3loki s3thanos s3plugin grafana kiali alerttoken
  local powsecret emailhash auditkey reghttp auditheads
  # No token secret is generated here any more: every token is asymmetrically
  # signed and its private key is a FILE, never an env value — the user-token key
  # from deploy/bin/token-signing-keys.sh (or KMS), and the per-service internal
  # keys from deploy/bin/service-signing-keys.sh.
  # Secret-column master key (AES-256-GCM envelope encryption of aiProviderKeys
  # and IdP client secrets). Required now that every target sets
  # NODE_ENV=production — platform refuses to boot without it. Hex, because the
  # =+/-stripping below would corrupt a base64 key's length.
  seckey=$(openssl rand -hex 32)
  pg=$(openssl rand -base64 24 | tr -d '=+/')
  # The services' Postgres login (DB_USER, a NOSUPERUSER NOBYPASSRLS role that
  # postgres-init.sql creates) gets its OWN password — never the superuser's.
  pgapp=$(openssl rand -base64 24 | tr -d '=+/')
  # The anonymous public plugin directory's Postgres login (ecosystem_public_reader,
  # view-only on public_listings / public_listed_versions; created by
  # postgres-init.sql and seeded into pgbouncer's userlist). Its own password —
  # never DB_PASSWORD's — so the public read path holds no tenant-capable login.
  pgreader=$(openssl rand -base64 24 | tr -d '=+/')
  # Bearer token for the Alertmanager -> platform per-org alert relay.
  alerttoken=$(openssl rand -base64 32 | tr -d '=+/')
  mongo=$(openssl rand -base64 24 | tr -d '=+/')
  me=$(openssl rand -base64 16 | tr -d '=+/')
  pgadmin=$(openssl rand -base64 16 | tr -d '=+/')
  registry=$(openssl rand -base64 24 | tr -d '=+/')
  # MinIO: the server root password plus one distinct secret per bucket-scoped
  # service key. These back the `minio-secret` Secret that bin/k8s-resources.sh
  # builds — previously a literal in k8s/minio.yaml with shipped defaults, which
  # is why they were not generated here before.
  minioroot=$(openssl rand -base64 24 | tr -d '=+/')
  s3msg=$(openssl rand -base64 24 | tr -d '=+/')
  s3reg=$(openssl rand -base64 24 | tr -d '=+/')
  s3loki=$(openssl rand -base64 24 | tr -d '=+/')
  s3thanos=$(openssl rand -base64 24 | tr -d '=+/')
  s3plugin=$(openssl rand -base64 24 | tr -d '=+/')
  grafana=$(openssl rand -base64 24 | tr -d '=+/')
  # Kiali's session-signing key must be EXACTLY 16/24/32 bytes; hex 16 = 32 chars.
  kiali=$(openssl rand -hex 16)
  # Anonymous plugin submissions: the
  # HMAC key that signs proof-of-work challenges, and the HMAC key the submitter
  # email is hashed under (rate limits + update ownership without storing the
  # address in the clear). Generated even while ANONYMOUS_SUBMISSIONS_ENABLED is
  # off, so flipping the flag never boots the plugin service on a placeholder —
  # it refuses to (fail closed) when the flag is on and either is missing.
  # Audit hash-chain HMAC key (platform refuses to boot without it; >= 32
  # chars). Lives only in .env / the app-secrets Secret, never in the database.
  auditkey=$(openssl rand -base64 48 | tr -d '=+/')
  # Registry upload-session signing secret, shared by every registry replica.
  reghttp=$(openssl rand -base64 32 | tr -d '=+/')
  # The audit-heads MinIO user (bucket-scoped Put/Get on the Object-Lock bucket).
  auditheads=$(openssl rand -base64 24 | tr -d '=+/')
  powsecret=$(openssl rand -base64 32 | tr -d '=+/')
  emailhash=$(openssl rand -base64 32 | tr -d '=+/')
  sed -i.bak \
    -e "s|SECRET_ENCRYPTION_KEY=CHANGE_ME_generate_with_openssl_rand_base64_32|SECRET_ENCRYPTION_KEY=${seckey}|" \
    -e "s|POSTGRES_PASSWORD=CHANGE_ME|POSTGRES_PASSWORD=${pg}|" \
    -e "s|^DB_PASSWORD=CHANGE_ME$|DB_PASSWORD=${pgapp}|" \
    -e "s|^ECOSYSTEM_PUBLIC_READER_PASSWORD=CHANGE_ME$|ECOSYSTEM_PUBLIC_READER_PASSWORD=${pgreader}|" \
    -e "s|^ALERT_WEBHOOK_INSTANCE_TOKEN=CHANGE_ME$|ALERT_WEBHOOK_INSTANCE_TOKEN=${alerttoken}|" \
    -e "s|MONGO_INITDB_ROOT_PASSWORD=CHANGE_ME|MONGO_INITDB_ROOT_PASSWORD=${mongo}|" \
    -e "s|mongodb://mongo:CHANGE_ME@|mongodb://mongo:${mongo}@|g" \
    -e "s|ME_CONFIG_BASICAUTH_PASSWORD=CHANGE_ME|ME_CONFIG_BASICAUTH_PASSWORD=${me}|" \
    -e "s|PGADMIN_DEFAULT_PASSWORD=CHANGE_ME|PGADMIN_DEFAULT_PASSWORD=${pgadmin}|" \
    -e "s|IMAGE_REGISTRY_TOKEN=CHANGE_ME|IMAGE_REGISTRY_TOKEN=${registry}|" \
    -e "s|MINIO_ROOT_PASSWORD=CHANGE_ME|MINIO_ROOT_PASSWORD=${minioroot}|" \
    -e "s|MESSAGE_S3_SECRET_KEY=CHANGE_ME|MESSAGE_S3_SECRET_KEY=${s3msg}|" \
    -e "s|REGISTRY_S3_SECRET_KEY=CHANGE_ME|REGISTRY_S3_SECRET_KEY=${s3reg}|" \
    -e "s|LOKI_S3_SECRET_KEY=CHANGE_ME|LOKI_S3_SECRET_KEY=${s3loki}|" \
    -e "s|THANOS_S3_SECRET_KEY=CHANGE_ME|THANOS_S3_SECRET_KEY=${s3thanos}|" \
    -e "s|PLUGIN_S3_SECRET_KEY=CHANGE_ME|PLUGIN_S3_SECRET_KEY=${s3plugin}|" \
    -e "s|GRAFANA_ADMIN_PASSWORD=CHANGE_ME|GRAFANA_ADMIN_PASSWORD=${grafana}|" \
    -e "s|KIALI_SIGNING_KEY=CHANGE_ME|KIALI_SIGNING_KEY=${kiali}|" \
    -e "s|^AUDIT_CHAIN_HMAC_KEY=CHANGE_ME$|AUDIT_CHAIN_HMAC_KEY=${auditkey}|" \
    -e "s|^REGISTRY_HTTP_SECRET=CHANGE_ME$|REGISTRY_HTTP_SECRET=${reghttp}|" \
    -e "s|^AUDIT_HEAD_EXPORT_S3_SECRET_ACCESS_KEY=CHANGE_ME$|AUDIT_HEAD_EXPORT_S3_SECRET_ACCESS_KEY=${auditheads}|" \
    -e "s|^SUBMISSION_POW_SECRET=CHANGE_ME$|SUBMISSION_POW_SECRET=${powsecret}|" \
    -e "s|^SUBMISSION_EMAIL_HASH_SECRET=CHANGE_ME$|SUBMISSION_EMAIL_HASH_SECRET=${emailhash}|" \
    -e "s|GHCR_USER=mwashburn160|GHCR_USER=${ghcr_user}|" \
    "$env_file"
  rm -f "$env_file.bak"

  # Guard against a drifted placeholder: if any REQUIRED secret this function
  # owns still reads CHANGE_ME, a placeholder string in .env.example was renamed
  # and the sed above silently matched nothing — shipping a literal `CHANGE_ME`
  # credential (a real security hole that would otherwise pass green). Scoped to
  # these keys so optional user-supplied CHANGE_ME placeholders aren't flagged.
  if grep -qE '^(SECRET_ENCRYPTION_KEY|POSTGRES_PASSWORD|DB_PASSWORD|ECOSYSTEM_PUBLIC_READER_PASSWORD|MONGO_INITDB_ROOT_PASSWORD|ME_CONFIG_BASICAUTH_PASSWORD|PGADMIN_DEFAULT_PASSWORD|IMAGE_REGISTRY_TOKEN|MINIO_ROOT_PASSWORD|MESSAGE_S3_SECRET_KEY|REGISTRY_S3_SECRET_KEY|LOKI_S3_SECRET_KEY|THANOS_S3_SECRET_KEY|PLUGIN_S3_SECRET_KEY|GRAFANA_ADMIN_PASSWORD|KIALI_SIGNING_KEY|ALERT_WEBHOOK_INSTANCE_TOKEN|AUDIT_CHAIN_HMAC_KEY|AUDIT_HEAD_EXPORT_S3_SECRET_ACCESS_KEY|REGISTRY_HTTP_SECRET|SUBMISSION_POW_SECRET|SUBMISSION_EMAIL_HASH_SECRET)=CHANGE_ME' "$env_file" \
     || grep -q 'mongodb://mongo:CHANGE_ME@' "$env_file"; then
    echo "ERROR: gen-env-secrets left an unsubstituted CHANGE_ME in a required secret in $env_file" >&2
    echo "  — a placeholder in .env.example drifted from this script's sed patterns." >&2
    return 1
  fi

  # CATCH-ALL. The named guard above only protects keys someone remembered to
  # list there; a NEW secret added to .env.example as `FOO_SECRET=CHANGE_ME`
  # with no sed rule here matches neither the substitutions nor that list, so it
  # would ship a literal `CHANGE_ME` credential and still exit 0 — the precise
  # hole the named guard was written to close, one key later. So fail on ANY
  # remaining placeholder that is not operator-supplied.
  #
  # SLACK_* is the one legitimate exception: no generator can invent an
  # incoming-webhook URL. pb_check_alert_delivery is its gate (and pb_sync_env_keys
  # excludes it the same way), so leaving it as CHANGE_ME here is expected.
  local _left
  _left=$(grep -E '^[A-Za-z_][A-Za-z0-9_]*=CHANGE_ME' "$env_file" | grep -v '^SLACK_' | cut -d= -f1 | tr '\n' ' ') || true
  if [ -n "$_left" ]; then
    echo "ERROR: these secrets are still CHANGE_ME in $env_file: ${_left}" >&2
    echo "  — they are new in .env.example and have no generator in pb_gen_env_secrets." >&2
    echo "  Add a sed substitution (and the key to the guard list) in deploy/bin/gen-env-secrets.sh." >&2
    return 1
  fi
}
