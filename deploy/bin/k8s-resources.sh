#!/usr/bin/env bash
# Copyright 2026 Pipeline Builder Contributors
# SPDX-License-Identifier: Apache-2.0
#
# Shared Kubernetes bring-up for every k8s deploy target (deploy/local/minikube,
# deploy/aws/ec2, deploy/aws/eks): Secret/ConfigMap creation, the cluster add-on
# installs (KEDA, Istio ambient, Gateway API CRDs) and the manifest apply phase.
# SOURCE this file — it defines pb_* functions plus the add-on version defaults
# below, and has no other side effects.
#
# SHELL OPTIONS: this file is SOURCED, never executed, so it deliberately sets
# NO `set -euo pipefail`. `set` inside a sourced file mutates the CALLER's shell
# — it would silently turn on errexit for whatever sourced us (including an
# interactive shell, where a failed command would then close the terminal).
# Every caller already runs under `set -euo pipefail`; these functions therefore
# propagate failure the portable way, by RETURNING non-zero, so they behave the
# same whether or not the caller has errexit on.
#
# Caller contract — set these BEFORE calling, and source the target's .env first (the
# secret VALUES come from it):
#   PB_KUBECTL    the kubectl runner — "kubectl" (minikube, eks) or "mk kubectl" (ec2: runs
#                 kubectl as the minikube user via the caller's `mk` function, which must be
#                 in scope). Other cluster CLIs (istioctl, minikube) run the same way — see
#                 pb_as_owner.
#   PB_NAMESPACE  the target namespace
#
# Cluster add-on versions, pinned HERE once so the three k8s targets cannot drift.
# Each stays overridable from the environment. ISTIO_VERSION must be ambient-GA
# (>= 1.24); ensure_istioctl installs exactly this istioctl. KEDA_VERSION must be
# tested against the newest cluster any target runs (EKS_VERSION) per the KEDA
# compatibility matrix.
ISTIO_VERSION="${ISTIO_VERSION:-1.30.3}"
GATEWAY_API_VERSION="${GATEWAY_API_VERSION:-v1.3.0}"
KEDA_VERSION="${KEDA_VERSION:-2.20.2}"

# Every create is idempotent (render with --dry-run=client, then apply).

# Render-then-apply a `create …` so re-runs update rather than fail.
pb_kube_apply() { $PB_KUBECTL "$@" --dry-run=client -o yaml | $PB_KUBECTL apply -f - ; }

# `|| return 1` before the echo, because a function's status is its LAST
# command's: without it these ALWAYS returned 0 (the echo), so a caller that
# tests them — or that calls them from inside an `&&` list, where errexit is
# suppressed — was told a failed `kubectl apply` had succeeded.
pb_secret()    { local _n="$1"; shift; pb_kube_apply create secret generic "$_n" "$@" -n "$PB_NAMESPACE" || return 1; echo "  secret $_n"; }
pb_configmap() { local _n="$1"; shift; pb_kube_apply create configmap "$_n" "$@" -n "$PB_NAMESPACE" || return 1; echo "  configmap $_n"; }

# pb_split_app_env <clean_env> <config_out> <secret_out>
#
# Split a cleaned (comment/blank-stripped, envsubst'd) .env into what the app pods get:
#   <config_out>  non-secret settings  -> the `app-env` ConfigMap
#   <secret_out>  credentials/tokens   -> the `app-secrets` Secret
# Every workload that reads app-env via envFrom ALSO lists app-secrets (except frontend,
# which reads no secret), so the split changes where values live, not what apps see.
#
# ADMIN-ONLY keys are dropped from BOTH: the Postgres/Mongo/RustFS superusers and the
# admin-UI logins. Their consumers (postgres, mongodb, rustfs, pgbouncer, pgadmin,
# mongo-express, grafana, kiali, loki/thanos/registry, backup) read them from their own
# Secrets (postgres-secret, mongodb-secret, rustfs-secret, …) by key, so no application
# pod ever receives a credential that bypasses row-level security or tenant scoping.
#
# Secret detection is by NAME, so a newly added *_PASSWORD / *_SECRET / *_TOKEN / *_KEY /
# API key lands in the Secret without touching this function. Knobs that merely contain
# those words (…_TOKEN_EXPIRES_IN, …_TOKEN_URL, …_KEY_ID, PASSWORD_MIN_LENGTH,
# PASSWORD_BREACH_CHECK*) stay config.
# `…_PREVIOUS` is secret too — every rotation-overlap value
# (ALERT_WEBHOOK_INSTANCE_TOKEN_PREVIOUS, SECRET_ENCRYPTION_KEY_PREVIOUS, …) is the
# same credential as the key it supersedes, so it must never land in the ConfigMap.
#
# QUOTE STRIPPING. The .env is read two ways with DIFFERENT quoting rules: bash
# `source` strips surrounding quotes, `kubectl --from-env-file` does not. Values
# in .env.example are quoted because they must survive sourcing —
# `MONGODB_URI=mongodb://...?replicaSet=rs0&authSource=admin` unquoted would be
# split at the `&` and backgrounded — so without stripping here the Secret gets
# a literal leading quote and every consumer fails. That failure is quiet and
# confusing: mongodb-secret (built with --from-literal from the SOURCED value)
# is correct, so MongoDB itself is healthy while platform/billing/quota sit at
# 0/1 with "Invalid scheme, expected connection string to start with mongodb://".
pb_split_app_env() {
  local _src="$1" _cfg="$2" _sec="$3"
  : > "$_cfg"; : > "$_sec"
  awk -v cfg="$_cfg" -v sec="$_sec" '
    {
      line = $0
      # Only KEY=VALUE lines are rewritten; comments and blanks pass through
      # untouched (kubectl ignores them, and reconstructing them would corrupt them).
      if (line ~ /^[A-Za-z_][A-Za-z0-9_]*=/) {
        k = line; sub(/=.*/, "", k)
        v = line; sub(/^[^=]*=/, "", v)
        # Strip ONE layer of matching surrounding quotes, mirroring `source`.
        if ((v ~ /^".*"$/ || v ~ /^'"'"'.*'"'"'$/) && length(v) >= 2) v = substr(v, 2, length(v) - 2)
        line = k "=" v
      }
      key = $0; sub(/=.*/, "", key)
      if (key ~ /^(POSTGRES_USER|POSTGRES_PASSWORD|MONGO_INITDB_ROOT_USERNAME|MONGO_INITDB_ROOT_PASSWORD|RUSTFS_ROOT_ACCESS_KEY|RUSTFS_ROOT_SECRET_KEY|GRAFANA_ADMIN_USER|GRAFANA_ADMIN_PASSWORD|KIALI_SIGNING_KEY|GHCR_TOKEN)$/ \
          || key ~ /^(ME_CONFIG_|PGADMIN_|LOKI_S3_|THANOS_S3_|REGISTRY_S3_|REGISTRY_HTTP_)/) next
      # PASSWORD_BREACH_CHECK* are knobs, not credentials — a mode, a public
      # k-anonymity endpoint and a timeout. They only CONTAIN "PASSWORD", so the
      # by-name rule below would otherwise bury them in the Secret, where an
      # operator can neither see nor diff the outbound URL the platform calls.
      if (key ~ /^PASSWORD_BREACH_CHECK/) { print line > cfg; next }
      if (key ~ /(_EXPIRES_IN|_ISSUER|_SERVICE|_REALM|_TTL_MS|_TOKEN_URL|_KEY_ID|_LENGTH|_KMS|ATTRIBUTE_KEYS)$/) { print line > cfg; next }
      if (key ~ /(PASSWORD|_PASS|SECRET|TOKEN|_KEY|_KEYS|_URI|_PREVIOUS)$/ || key ~ /SECRET|PASSWORD|WEBHOOK_URL/ || key == "REDIS_URL") { print line > sec; next }
      print line > cfg
    }' "$_src"
}

# app-env ConfigMap + app-secrets Secret from a cleaned .env file (see pb_split_app_env).
pb_app_env_resources() {
  local _cfg _sec _rc=0
  _cfg=$(mktemp) || return 1
  _sec=$(mktemp) || { rm -f "$_cfg"; return 1; }
  # mktemp already creates 0600, but say it unconditionally: $_sec holds EVERY
  # application credential in the clear for the life of this function, and on
  # ec2 the chown below hands it to another user.
  chmod 600 "$_cfg" "$_sec"
  # One `&&` chain, then an UNCONDITIONAL rm. A failing kubectl used to abort
  # the function through the caller's `set -e` with the rm still ahead of it,
  # leaving the whole app-secrets set sitting in /tmp on a failed provision.
  # (Commands in an && list are exempt from errexit, so the chain runs to its
  # first failure and $_rc carries it out of the function.)
  pb_split_app_env "$1" "$_cfg" "$_sec" \
    && { [ -z "${PB_ENV_FILE_OWNER:-}" ] || chown "$PB_ENV_FILE_OWNER" "$_cfg" "$_sec"; } \
    && pb_configmap app-env --from-env-file="$_cfg" \
    && pb_secret app-secrets --from-env-file="$_sec" || _rc=$?
  rm -f "$_cfg" "$_sec"
  return "$_rc"
}

# Application secrets — names/keys must match the k8s manifests. Reads the sourced .env.
pb_create_app_secrets() {
  # The *_PREVIOUS keys always exist (empty outside a rotation) so the manifests
  # can secretKeyRef them unconditionally; an empty value reads as "not
  # rotating". docs/runbooks/secret-rotation.md
  # postgres-secret is read BY KEY only (postgres, its exporter, pgbouncer, backup): the
  # superuser pair for init/backup, the DB_USER app-role pair for postgres-init.sql and
  # pgbouncer's userlist, and the view-only ecosystem_public_reader password (the public
  # plugin directory's pooled login; postgres-init.sql creates the role from it, and
  # pgbouncer's userlist only admits it when the key is non-empty). App pods get
  # DB_USER/DB_PASSWORD from app-env/app-secrets and must never envFrom this Secret
  # (it would hand them the RLS-bypassing superuser).
  pb_secret postgres-secret      --from-literal=POSTGRES_USER="$POSTGRES_USER" --from-literal=POSTGRES_PASSWORD="$POSTGRES_PASSWORD" --from-literal=DB_USER="$DB_USER" --from-literal=DB_PASSWORD="$DB_PASSWORD" \
    --from-literal=ECOSYSTEM_PUBLIC_READER_PASSWORD="${ECOSYSTEM_PUBLIC_READER_PASSWORD:-}"
  pb_secret mongodb-secret       --from-literal=MONGO_INITDB_ROOT_USERNAME="$MONGO_INITDB_ROOT_USERNAME" --from-literal=MONGO_INITDB_ROOT_PASSWORD="$MONGO_INITDB_ROOT_PASSWORD" --from-literal=MONGODB_URI="$MONGODB_URI"
  pb_secret mongo-express-secret --from-literal=ME_CONFIG_BASICAUTH_USERNAME="$ME_CONFIG_BASICAUTH_USERNAME" --from-literal=ME_CONFIG_BASICAUTH_PASSWORD="$ME_CONFIG_BASICAUTH_PASSWORD"
  pb_secret pgadmin-secret       --from-literal=PGADMIN_DEFAULT_EMAIL="$PGADMIN_DEFAULT_EMAIL" --from-literal=PGADMIN_DEFAULT_PASSWORD="$PGADMIN_DEFAULT_PASSWORD"
  # Grafana's own admin login — nginx applies no auth to /grafana/, and Grafana
  # reads Prometheus with no org scoping, so this password is the only thing
  # between a visitor and every tenant's metrics.
  pb_secret grafana-secret       --from-literal=GRAFANA_ADMIN_USER="$GRAFANA_ADMIN_USER" --from-literal=GRAFANA_ADMIN_PASSWORD="$GRAFANA_ADMIN_PASSWORD"
  # Kiali session-signing key, mounted as the override-secret file Kiali reads
  # (/kiali-override-secrets/login-token-signing-key/value.txt). Kiali v2 ignores a
  # LOGIN_TOKEN_SIGNING_KEY env var, and with no key it crashloops at startup.
  pb_secret kiali-signing-key    --from-literal=value.txt="$KIALI_SIGNING_KEY"
  # Per-org alert relay bearer: mounted as a file into alertmanager (credentials_file
  # in alertmanager.yml) and injected into platform's ALERT_WEBHOOK_INSTANCES.
  pb_secret alertmanager-relay   --from-literal=ALERT_WEBHOOK_INSTANCE_TOKEN="$ALERT_WEBHOOK_INSTANCE_TOKEN" \
    --from-literal=ALERT_WEBHOOK_INSTANCE_TOKEN_PREVIOUS="${ALERT_WEBHOOK_INSTANCE_TOKEN_PREVIOUS:-}"
  # Ops-team Slack webhook URLs for the platform-wide critical/warning receivers,
  # mounted as FILES into alertmanager (api_url_file) — a webhook URL is a bearer
  # credential, so it belongs here and not in the alertmanager-config ConfigMap.
  # Created unconditionally (never `optional:`) so a missing value is a loud
  # FailedMount; the values themselves are pre-flighted by
  # pb_check_alert_delivery, which the caller runs before this.
  pb_secret alertmanager-slack \
    --from-literal=SLACK_CRITICAL_WEBHOOK_URL="${SLACK_CRITICAL_WEBHOOK_URL:-}" \
    --from-literal=SLACK_WARNING_WEBHOOK_URL="${SLACK_WARNING_WEBHOOK_URL:-}"
  # RustFS: root creds (server + rustfs-init bootstrap) plus the per-service,
  # bucket-scoped keys. Created HERE from .env, never shipped as a literal
  # Secret in k8s/rustfs.yaml: a committed Secret would make the
  # RUSTFS_*/*_S3_* values in .env inert (the Deployment reads this Secret)
  # and leave pb_gen_env_secrets nothing to randomise. Key names must match
  # the secretKeyRef entries in k8s/rustfs.yaml, k8s/plugin.yaml,
  # k8s/loki.yaml, k8s/registry.yaml and k8s/message.yaml.
  #
  # Per-service IAM users themselves are created DYNAMICALLY at bootstrap by
  # rustfs-init (`rc admin user add`, the same design MinIO's old minio-init
  # used — `rc` is MinIO's `mc` renamed almost verbatim), reading these same
  # values, so there is no separate identity-file Secret to build here the
  # way a coarser-IAM backend would need.
  pb_secret rustfs-secret \
    --from-literal=root-user="$RUSTFS_ROOT_ACCESS_KEY"           --from-literal=root-password="$RUSTFS_ROOT_SECRET_KEY" \
    --from-literal=message-access-key="$MESSAGE_S3_ACCESS_KEY"   --from-literal=message-secret-key="$MESSAGE_S3_SECRET_KEY" \
    --from-literal=registry-access-key="$REGISTRY_S3_ACCESS_KEY" --from-literal=registry-secret-key="$REGISTRY_S3_SECRET_KEY" \
    --from-literal=loki-access-key="$LOKI_S3_ACCESS_KEY"         --from-literal=loki-secret-key="$LOKI_S3_SECRET_KEY" \
    --from-literal=thanos-access-key="$THANOS_S3_ACCESS_KEY"     --from-literal=thanos-secret-key="$THANOS_S3_SECRET_KEY" \
    --from-literal=plugin-access-key="$PLUGIN_S3_ACCESS_KEY"     --from-literal=plugin-secret-key="$PLUGIN_S3_SECRET_KEY" \
    --from-literal=audit-heads-access-key="$AUDIT_HEAD_EXPORT_S3_ACCESS_KEY_ID" --from-literal=audit-heads-secret-key="$AUDIT_HEAD_EXPORT_S3_SECRET_ACCESS_KEY" \
    --from-literal=backup-access-key="$BACKUP_S3_ACCESS_KEY"     --from-literal=backup-secret-key="$BACKUP_S3_SECRET_KEY"
}

# The ES256 user-token signing key, mounted (read-only) into PLATFORM ONLY — it
# is the one credential in the fleet that can mint a token for a person, so no
# other Deployment references this Secret. Args: <key_file> [previous_key_file].
# Skipped entirely under TOKEN_SIGNING_MODE=kms, where the private key never
# leaves AWS and there is nothing to mount.
pb_create_token_signing_secret() {
  [ "${TOKEN_SIGNING_MODE:-local}" = "local" ] || { echo "  token signing: KMS mode, no key Secret"; return 0; }
  local _args=(--from-file=token-signing.key="$1")
  # The retiring key, when a rotation is mid-flight: published in the JWKS so
  # tokens it signed keep verifying, never used to sign. The manifest mounts the
  # whole Secret, so an absent second key simply means an absent file.
  [ -n "${2:-}" ] && [ -f "${2:-}" ] && _args+=(--from-file=token-signing-previous.key="$2")
  pb_secret token-signing-key "${_args[@]}"
}

# The plugin-IMAGE signing keypair (cosign), as TWO Secrets because its halves
# go to different pods. Args: <plugin_signing_dir> (the `plugin-signing/`
# directory deploy/bin/plugin-signing-keys.sh writes).
#
#   plugin-signing-key         PRIVATE key — mounted by image-registry ONLY. It
#                              signs at POST /internal/plugin-signatures on the
#                              plugin service's behalf. Created in local mode
#                              only: under PLUGIN_SIGNING_MODE=kms the key never
#                              leaves AWS, so any Secret left by an earlier local
#                              run is DELETED rather than left lying around (the
#                              manifest mounts it `optional: true`, so image-
#                              registry still schedules without it).
#   plugin-signing-public-key  PUBLIC key — mounted by plugin, which only runs
#                              `cosign verify`. Always created (in kms mode it is
#                              the key exported from KMS). Plugin must never get
#                              the private Secret: its pod shares a network
#                              namespace with the buildkitd sidecar that runs
#                              untrusted tenant Dockerfile RUN steps.
pb_create_plugin_signing_secrets() {
  local _dir="${1:?pb_create_plugin_signing_secrets needs the plugin-signing dir}"
  [ -f "$_dir/plugin-signing.pub" ] || { echo "ERROR: no plugin signing public key at $_dir/plugin-signing.pub (run deploy/bin/plugin-signing-keys.sh)" >&2; return 1; }
  if [ "${PLUGIN_SIGNING_MODE:-local}" = "local" ]; then
    pb_secret plugin-signing-key --from-file=plugin-signing.key="$_dir/plugin-signing.key"
  else
    $PB_KUBECTL delete secret plugin-signing-key -n "$PB_NAMESPACE" --ignore-not-found >/dev/null
    echo "  plugin signing: KMS mode, no private key Secret"
  fi
  pb_secret plugin-signing-public-key --from-file=plugin-signing.pub="$_dir/plugin-signing.pub"
}

# The PER-SERVICE internal-token signing keys, as one Secret per service
# plus one shared PUBLIC bundle. Args: <service_keys_dir> (the `service-keys/`
# directory deploy/bin/service-signing-keys.sh writes).
#
# The split is the whole point: each Deployment mounts `service-key-<name>` and
# NOTHING else, so a compromised pod holds exactly one identity and cannot sign
# as any other service. `service-key-bundle` is public (verification only) and is
# mounted everywhere. `deploy-bootstrap` gets a Secret too, but no Deployment
# mounts it — push-base-images.sh reads it out to sign its registry pushes.
pb_create_service_key_secrets() {
  local _dir="${1:?pb_create_service_key_secrets needs the service-keys dir}"
  local _key _svc _args
  [ -f "$_dir/bundle.json" ] || { echo "ERROR: no service key bundle at $_dir/bundle.json (run deploy/bin/service-signing-keys.sh)" >&2; return 1; }
  pb_secret service-key-bundle --from-file=bundle.json="$_dir/bundle.json"
  for _key in "$_dir"/*.key; do
    _svc="$(basename "$_key" .key)"
    # `<svc>-previous.key` is the retiring half of a rotation: its PUBLIC key is
    # in the bundle so tokens it signed still verify, but it never signs again,
    # so it is not mounted anywhere.
    case "$_svc" in *-previous) continue ;; esac
    _args=(--from-file=service.key="$_key")
    pb_secret "service-key-$_svc" "${_args[@]}"
  done
}

# Optional GHCR pull secret, attached to the namespace's default ServiceAccount. The token
# is GHCR_TOKEN, else the GitHub Packages token in the operator's ~/.npmrc (the one a
# developer already has for the @pipeline-builder npm scope); no-op when neither is set.
# (docker-registry secret type → not via pb_secret, which is generic-only.)
pb_create_ghcr_secret() {
  local _token="${GHCR_TOKEN:-}"
  if [ -z "$_token" ] && [ -f "$HOME/.npmrc" ]; then
    _token=$(grep '//npm.pkg.github.com/:_authToken=' "$HOME/.npmrc" 2>/dev/null | sed 's/.*_authToken=//' || true)
  fi
  [ -n "$_token" ] || return 0
  pb_kube_apply create secret docker-registry ghcr-secret --docker-server=ghcr.io \
    --docker-username="${GHCR_USER:-mwashburn160}" --docker-password="$_token" -n "$PB_NAMESPACE"
  $PB_KUBECTL patch sa default -n "$PB_NAMESPACE" -p '{"imagePullSecrets":[{"name":"ghcr-secret"}]}'
  echo "  secret ghcr-secret"
}

# image-registry token-signing keypair secret (<key_file> <crt_file>) + the build-svc Basic-auth
# creds the proxy uses to reach the underlying registry. (No htpasswd/registry-auth-secret —
# the registry uses token auth; nothing mounts it.)
pb_create_registry_secrets() {
  # http-secret: the registry replicas' shared upload-session signing secret.
  pb_secret registry-token-secret --from-file=jwt-private.pem="$1" --from-file=jwt-public.pem="$2" \
    --from-literal=http-secret="$REGISTRY_HTTP_SECRET"
  pb_secret image-registry-build-svc-secret \
    --from-literal=IMAGE_REGISTRY_USERNAME="$IMAGE_REGISTRY_USER" --from-literal=IMAGE_REGISTRY_PASSWORD="$IMAGE_REGISTRY_TOKEN"
}

# The nginx-config ConfigMap. On the AWS targets it carries two deploy-time
# pieces next to nginx.conf (a target whose nginx dir/conf has neither — minikube —
# gets nginx.conf alone):
#   admin-uis.conf  the admin-console routes (pgAdmin / mongo-express / Grafana /
#                   Kiali, each behind platform's superadmin auth_request) when
#                   ADMIN_UIS_ENABLED=true — otherwise admin-uis-disabled.conf,
#                   which 404s them. OFF unless the operator opts in.
#   rustfs-console.conf
#                   the RustFS object-store console's own `server { listen 9001; }`,
#                   swapped by the SAME ADMIN_UIS_ENABLED flag (or its 404 stub).
#                   A separate file because it is a `server`, not a `location`:
#                   nginx.conf includes it at http level, whereas admin-uis.conf is
#                   included inside the :8080 server. The console needs its own
#                   origin — its UI resolves the S3/admin API from window.location
#                   and calls ROOT paths, so it cannot live under a path on 8080.
#                   BOTH keys are always written when the file exists: nginx.conf
#                   includes them unconditionally and a missing include file is a
#                   FATAL nginx error, not a warning.
#   real-ip.conf    one `set_real_ip_from` per PB_TRUSTED_PROXY_CIDRS entry (the
#                   ALB subnets), so nginx takes the client IP from
#                   X-Forwarded-For only when the TCP peer is the load balancer.
# Refuses (non-zero) when nginx.conf includes real-ip.conf and no CIDR is set,
# or a CIDR is malformed — an empty trust list would silently make every
# client look like the ALB again. Args: <nginx_dir>.
pb_nginx_config() {
  local _nginx="$1" _realip="" _c
  local _args=(--from-file=nginx.conf="$_nginx/nginx.conf")
  if [ -f "$_nginx/admin-uis.conf" ]; then
    if [ "${ADMIN_UIS_ENABLED:-false}" = true ]; then
      _args+=(--from-file=admin-uis.conf="$_nginx/admin-uis.conf")
      _args+=(--from-file=rustfs-console.conf="$_nginx/rustfs-console.conf")
      echo "  admin consoles ENABLED (superadmin-gated): /pgadmin/ /mongo-express/ /grafana/ /kiali/"
      echo "    plus the RustFS object-store console on its own port :9001 (it cannot be"
      echo "    served under a path — see nginx/rustfs-console.conf)"
    else
      _args+=(--from-file=admin-uis.conf="$_nginx/admin-uis-disabled.conf")
      _args+=(--from-file=rustfs-console.conf="$_nginx/rustfs-console-disabled.conf")
    fi
  fi
  if grep -q 'include /etc/nginx/real-ip.conf' "$_nginx/nginx.conf"; then
    if [ -z "${PB_TRUSTED_PROXY_CIDRS:-}" ]; then
      echo "ERROR: PB_TRUSTED_PROXY_CIDRS is empty — nginx needs the load balancer's CIDRs to trust X-Forwarded-For" >&2
      return 1
    fi
    for _c in $PB_TRUSTED_PROXY_CIDRS; do
      case "$_c" in
        *[!0-9./]*|'') echo "ERROR: PB_TRUSTED_PROXY_CIDRS entry '$_c' is not an IPv4 CIDR" >&2; return 1 ;;
      esac
      _realip="${_realip}set_real_ip_from ${_c};
"
    done
    _args+=(--from-literal=real-ip.conf="$_realip")
  fi
  # ask-upstream.conf  the `upstream pb_ask` block, from ASK_SERVICE_HOST /
  # ASK_SERVICE_PORT. These two were DOCUMENTED knobs that nothing read: the
  # convention elsewhere is that `<NAME>_SERVICE_HOST/PORT` is consumer-side
  # discovery honoured by the api-core service clients, and nothing in the fleet
  # calls ask — the browser reaches it through nginx, which had the address
  # hard-coded. So nginx is ask's only caller, and this is where the knobs become
  # real. Defaults match the documented ones, so an install that sets neither
  # produces exactly the literal that was there before.
  if grep -q 'include /etc/nginx/ask-upstream.conf' "$_nginx/nginx.conf"; then
    local _ask_host="${ASK_SERVICE_HOST:-ask.${PB_NAMESPACE:-pipeline-builder}.svc.cluster.local}"
    local _ask_port="${ASK_SERVICE_PORT:-3000}"
    case "$_ask_port" in
      ''|*[!0-9]*) echo "ERROR: ASK_SERVICE_PORT='$_ask_port' is not a port number" >&2; return 1 ;;
    esac
    # A host with a space / quote / semicolon would inject nginx directives.
    case "$_ask_host" in
      ''|*[!a-zA-Z0-9.-]*) echo "ERROR: ASK_SERVICE_HOST='$_ask_host' is not a bare hostname" >&2; return 1 ;;
    esac
    _args+=(--from-literal=ask-upstream.conf="upstream pb_ask { server ${_ask_host}:${_ask_port}; }
")
  fi
  pb_configmap nginx-config "${_args[@]}"
}

# Config-file ConfigMaps + the MongoDB keyfile secret. Args: <deploy_dir> <config_dir> <nginx_dir>.
# EVERY file comes from the target being provisioned — each target owns a full
# copy of its config tree, and the copies that must not drift are guarded by
# test/deploy-contracts (bringup-contract.test.ts), not by a shared directory.
# registry-auth.js is optional: only the AWS gateways import it (minikube's nginx.conf
# does not), so a target without one gets just jwt.js + metrics.js.
pb_create_config_maps() {
  local _deploy="$1" _config="$2" _nginx="$3"
  local _njs=(--from-file=jwt.js="$_nginx/jwt.js" --from-file=metrics.js="$_nginx/metrics.js")
  [ -f "$_nginx/registry-auth.js" ] && _njs+=(--from-file=registry-auth.js="$_nginx/registry-auth.js")
  pb_secret    mongodb-keyfile     --from-file=mongodb-keyfile="$_deploy/mongodb-keyfile"
  pb_configmap postgres-init       --from-file=init.sql="$_deploy/postgres-init.sql"
  pb_configmap mongodb-init        --from-file=mongo-init.js="$_deploy/mongodb-init.js"
  pb_nginx_config "$_nginx" || return 1
  pb_configmap nginx-njs           "${_njs[@]}"
  pb_configmap loki-config         --from-file=loki-config.yml="$_config/loki/loki-config.yml"
  pb_configmap prometheus-config   --from-file=prometheus.yml="$_config/prometheus/prometheus.yml" --from-file=alert-rules.yml="$_config/prometheus/alert-rules.yml"
  pb_configmap thanos-objstore     --from-file=objstore.yml="$_config/thanos/objstore.yml"
  pb_configmap alertmanager-config --from-file=alertmanager.yml="$_config/alertmanager/alertmanager.yml"
  pb_configmap promtail-config     --from-file=promtail-config.yml="$_config/promtail/promtail-config.yml"
  pb_configmap grafana-dashboards  --from-file=dashboards.yaml="$_config/grafana/dashboards/dashboards.yaml" --from-file=plugin-ecosystem.json="$_config/grafana/dashboards/plugin-ecosystem.json"
}

# pb_as_owner <cmd…> — run a cluster CLI (istioctl, minikube) the way PB_KUBECTL
# runs kubectl: through the `mk` wrapper on ec2 (as the minikube user who owns
# the cluster), directly everywhere else.
pb_as_owner() { ${PB_KUBECTL%kubectl} "$@"; }

# pb_install_keda [wait_timeout] — KEDA CRDs + operator, pinned to KEDA_VERSION.
# plugin.yaml ships a keda.sh/v1alpha1 ScaledObject, so KEDA must exist before
# the manifest apply or it fails with "no matches for kind ScaledObject". The
# wait is advisory: the ScaledObject reconciles once the operator is up.
pb_install_keda() {
  $PB_KUBECTL apply --server-side -f "https://github.com/kedacore/keda/releases/download/v${KEDA_VERSION}/keda-${KEDA_VERSION}.yaml" || return 1
  $PB_KUBECTL wait --for=condition=Available deployment/keda-operator -n keda --timeout="${1:-120s}" 2>/dev/null \
    || echo "  KEDA not ready yet (the ScaledObject reconciles once it is)"
}

# pb_install_istio_ambient [extra istioctl args…] — the Istio ambient mesh
# (istiod + ztunnel + istio-cni in istio-system) plus the Gateway API CRDs.
#
# Installed BEFORE the app manifests so istio-cni + ztunnel are ready when pods
# start (ambient enrolls a pod at CREATE time). The namespace is enrolled by the
# `istio.io/dataplane-mode: ambient` label on namespace.yaml; STRICT mTLS and the
# AuthorizationPolicies live in k8s/istio.yaml. Sidecar-less, so the hardened pod
# securityContexts are untouched. The Jaeger extensionProvider is pre-wired (inert
# at L4) so a waypoint can emit mesh traces. See docs/service-mesh.md.
#
# The waits are advisory (`|| echo`) — pb_apply_manifests holds the hard gate.
# PB_MESH_ROLLOUT_TIMEOUT (default 120s) bounds the ztunnel/istio-cni rollouts;
# multi-node clusters need longer. The caller runs ensure_istioctl first.
#
# The `pb-waypoint` Gateway (k8s/istio-internal-routes.yaml) is a Gateway API
# resource and `istioctl install` does not ship those CRDs, so the standard
# channel is installed once (pinned, idempotent) — without it the manifest apply
# dies on an unknown kind.
# `reconcileIptablesOnStartup` is PINNED, not defaulted. It feeds
# `AMBIENT_RECONCILE_POD_RULES_ON_STARTUP` into istio-cni's ConfigMap, which is
# how its `Reconcile` flag gets set for BOTH the pod and host rule paths (the
# name says "pod"; cni/pkg/cmd/root.go:335 -> :129 -> nodeagent/server_linux.go:49
# feeds the one shared field). Without it, istio-cni logs
#   "reconcile is needed but no-reconcile flag is set. Unexpected behavior may
#    occur due to preexisting iptables rules  component=host"
# and leaves whatever the VPC CNI / kube-proxy wrote in place. true IS the chart
# default today (manifests/charts/istio-cni/values.yaml), so this changes nothing
# now — it is pinned so a chart-default flip cannot silently turn it off.
#
# DO NOT try to pass this as a CLI arg on the DaemonSet. It is read through
# viper's AutomaticEnv ONLY (root.go:213-215 sets the "-"->"_" key replacer) and
# is NOT registered with registerBooleanParameter, so
# `--ambient-reconcile-pod-rules-on-startup=true` is an UNKNOWN FLAG and crashes
# istio-cni on boot. Env (this value) is the only way in.
#
# `dnsCapture` is PINNED TRUE, and must STAY true. It is the obvious-looking thing
# to switch off when DNS misbehaves inside the mesh, and switching it off is
# strictly WORSE. Measured both ways on an EKS Auto Mode cluster:
#   true  -> ClusterIP names resolve; external names and per-pod StatefulSet
#            records SERVFAIL, because ztunnel's DNS proxy has no upstream
#            resolver to forward the names it cannot synthesize.
#   false -> pods send :53 straight at the kube-dns ClusterIP, which Auto Mode
#            backs with NO Service object, so ambient has no destination for that
#            address and EVERY name times out — ClusterIP names included.
# The fix is to give the cluster a real, API-visible resolver (the `coredns` EKS
# addon in deploy/aws/eks/cluster/addons.yaml), NOT this flag. Pinned so a
# chart-default flip cannot silently change the DNS path either.
#
# `outboundTrafficPolicy.mode=ALLOW_ANY` is PINNED, and it is the Istio default —
# pinned so a chart-default flip to REGISTRY_ONLY cannot silently turn every
# undeclared external host into a connection error. Note what it does NOT do:
# ALLOW_ANY governs whether a connection is allowed, not whether a NAME resolves.
# Under ambient, ztunnel answers DNS from the mesh registry, so an external host
# still needs a ServiceEntry (k8s/serviceentry.yaml) or it fails at DNS with
# SERVFAIL long before any egress policy is consulted. Verified on EKS: with
# ALLOW_ANY in force and no ServiceEntry, kms.<region>.amazonaws.com returned
# EAI_AGAIN; adding the ServiceEntry alone fixed it.
pb_install_istio_ambient() {
  local _rollout="${PB_MESH_ROLLOUT_TIMEOUT:-120s}"
  pb_as_owner istioctl install --skip-confirmation \
    --set profile=ambient \
    "$@" \
    --set values.cni.ambient.reconcileIptablesOnStartup=true \
    --set values.cni.ambient.dnsCapture=true \
    --set meshConfig.outboundTrafficPolicy.mode=ALLOW_ANY \
    --set "meshConfig.extensionProviders[0].name=jaeger" \
    --set "meshConfig.extensionProviders[0].opentelemetry.service=jaeger.${PB_NAMESPACE}.svc.cluster.local" \
    --set "meshConfig.extensionProviders[0].opentelemetry.port=4317" || return 1
  $PB_KUBECTL wait --for=condition=Available deployment/istiod -n istio-system --timeout=180s 2>/dev/null || echo "  istiod not ready yet"
  $PB_KUBECTL rollout status daemonset/ztunnel -n istio-system --timeout="$_rollout" 2>/dev/null || echo "  ztunnel not ready yet"
  $PB_KUBECTL rollout status daemonset/istio-cni-node -n istio-system --timeout="$_rollout" 2>/dev/null || echo "  istio-cni not ready yet"
  if ! $PB_KUBECTL get crd gateways.gateway.networking.k8s.io >/dev/null 2>&1; then
    echo "  installing Gateway API CRDs ($GATEWAY_API_VERSION) for the ambient waypoint"
    $PB_KUBECTL apply -f "https://github.com/kubernetes-sigs/gateway-api/releases/download/${GATEWAY_API_VERSION}/standard-install.yaml" || return 1
  fi
}

# pb_lean_filter <lean> [extra-names] — with <lean>=1, drop the optional
# observability/admin workloads from a rendered manifest stream so no pods
# schedule for them, and collapse every workload/HPA/ScaledObject to one replica
# (on a small node the core stack + mesh already fills it, so 2nd replicas sit
# Pending). Anything else is a pass-through (cat).
#
# Dropped: the Deployment/StatefulSet/DaemonSet/CronJob/Job/Service/PV/PVC/HPA/
# PDB/ServiceAccount/ConfigMap/RBAC docs of prometheus, loki, thanos,
# alertmanager, promtail, jaeger, mongo-express, pgadmin, grafana, kiali — plus
# [extra-names] (an awk alternation, e.g. "ask-model"). Kept: everything else,
# including the AuthZ/NetworkPolicy docs that merely reference them (harmless,
# no pod). The spec-level replica fields are 2-space indented; the ScaledObject
# `fallback` replicas is deeper and intentionally left alone.
#
# CronJob/Job are in that kind list because the name pattern is
# `^(names)(-.*)?$` — a SUFFIX match, so "ask-model" also selects the
# `ask-model-up`/`ask-model-down` scalers and the `ask-model-scaler` RBAC. With
# CronJob missing, ec2's `LEAN=1 ... ask-model` dropped the Deployment and the
# ServiceAccount but KEPT both CronJobs, which then fired daily against a
# ServiceAccount that no longer existed to scale a Deployment that was never
# applied: pure noise in a cluster the operator had deliberately slimmed.
#
# When ask-model is dropped, ask.yaml's two env vars that POINT at it go too: a
# set OPENAI_COMPATIBLE_BASE_URL registers a provider, so every Ask turn would
# dial a Service that no longer exists instead of falling back to a cloud key
# (or reporting "AI is not configured"). Unambiguous at that point in the pipe —
# ask-model.yaml, the only other file naming them, has already been dropped.
#
# The filter shapes the APPLY, which does not prune: flipping a provisioned
# cluster from LEAN=0 to LEAN=1 leaves the dropped workloads running — delete
# them by hand when downsizing in place.
pb_lean_filter() {
  if [ "${1:-0}" != "1" ]; then cat; return; fi
  local _names="prometheus|loki|thanos-query|thanos-store-gateway|thanos-compact|alertmanager|promtail|jaeger|mongo-express|pgadmin|grafana|kiali${2:+|$2}"
  local _strip_ask_env=0
  case "|${2:-}|" in *"|ask-model|"*) _strip_ask_env=1 ;; esac
  awk -v names="^(${_names})(-.*)?$" '
    function emit(  o,d) {
      o = (nm ~ names)
      d = (kd ~ /^(Deployment|StatefulSet|DaemonSet|CronJob|Job|Service|PersistentVolume|PersistentVolumeClaim|HorizontalPodAutoscaler|PodDisruptionBudget|ServiceAccount|ConfigMap|ClusterRole|ClusterRoleBinding|Role|RoleBinding)$/)
      if (buf != "" && !(o && d)) printf "---\n%s", buf
      buf=""; kd=""; nm=""
    }
    /^---$/ { emit(); next }
    { buf = buf $0 "\n"; if ($1=="kind:") kd=$2; if ($0 ~ /^  name: / && nm=="") nm=$2 }
    END { emit() }
  ' | sed -E 's/^(  replicas:) [0-9]+/\1 1/; s/^(  (min|max)Replicas:) [0-9]+/\1 1/; s/^(  (min|max)ReplicaCount:) [0-9]+/\1 1/' \
    | if [ "$_strip_ask_env" = 1 ]; then
        awk '
          /- name: OPENAI_COMPATIBLE_(BASE_URL|MODELS)/ { skip=1; next }
          skip && /^[[:space:]]*value:/               { skip=0; next }
          { skip=0; print }
        '
      else cat; fi
}

# pb_ask_schedule_env — resolve + VALIDATE the ask-model business-hours window
# from .env, and export the three tokens k8s/ask-model-schedule.yaml carries.
#
# Why a helper and not three `: "${X:=...}"` lines per target: one of the three
# tokens cannot be substituted straight from .env. The operator-facing knob is
# ASK_SCHEDULE_ENABLED (true = run the window), but the CronJob field is
# `suspend`, whose polarity is INVERTED — and sed cannot negate. So the negation
# happens here, once, instead of being re-derived (and eventually re-derived
# wrongly) in each target's setup script.
#
# Validation is the other reason, and it is not pedantry:
#
#   * ASK_SCHEDULE_ENABLED must be exactly true|false. A plausible-looking
#     `yes` would make the ternary take the false branch and silently SUSPEND
#     both CronJobs — the operator would have typed something meaning "on" and
#     got a permanently-off schedule, with ask-model then stuck at whatever
#     replica count it happened to have. Worse, it fails in the safe-looking
#     direction (nothing crashes), so nobody looks.
#
#   * The cron expressions are checked for FIVE fields here rather than left to
#     the API server. Kubernetes does reject a malformed schedule, but by then
#     it is one failed doc inside a `kubectl apply -f -` of the whole stream:
#     the apply reports the rejection and pb_apply_manifests fails the deploy,
#     having already applied an arbitrary prefix. Catching it before the apply
#     keeps a typo in a cron field from being a half-applied cluster.
#     Deliberately a FIELD-COUNT check only — validating cron ranges properly
#     means reimplementing the parser, and the API server does that correctly.
#
# Exports PB_ASK_SCHEDULE_{UP,DOWN,SUSPEND}, prefixed because they are derived
# deploy state rather than operator input (same convention as PB_DNS_CLUSTER_IP).
# pb__cron_fields <expr> — the field count of a cron expression.
#
# Counted with awk, NOT with `set -- $expr`. A cron expression is mostly
# asterisks, and word-splitting an unquoted one also PATHNAME-EXPANDS it:
# "0 2 * * *" becomes the file list of the current directory, so every valid
# schedule is rejected with a nonsense count that varies by where the script was
# run from. awk counts fields without touching the filesystem.
pb__cron_fields() { printf '%s\n' "$1" | awk '{print NF}'; }

# pb__cron_check <VAR_NAME> <expr> <example> — reject anything but 5 fields.
#
# Checked HERE rather than left to the API server: Kubernetes does reject a
# malformed schedule, but by then it is one failed document inside a
# `kubectl apply -f -` of the whole stream, which fails the deploy having
# already applied an arbitrary prefix. A FIELD-COUNT check only — validating
# cron ranges properly means reimplementing the parser, and the API server
# already does that correctly.
pb__cron_check() {
  [ "$(pb__cron_fields "$2")" = 5 ] && return 0
  echo "ERROR: $1 must be a 5-field cron expression (got '$2')." >&2
  echo "       Example: $3" >&2
  return 1
}

# pb__enabled_to_suspend <VAR_NAME> <value> <consequence> — echo the INVERSE of
# an on/off flag, for a CronJob's `suspend` field.
#
# The operator-facing knob is ENABLED (true = run it); the CronJob field is
# `suspend`, whose polarity is inverted — and sed cannot negate, so the flip
# happens in the shell. Strict on purpose: a plausible-looking `yes` would take
# the false branch and SILENTLY suspend the job, which fails in the direction
# nobody checks.
pb__enabled_to_suspend() {
  case "$2" in
    true)  echo false; return 0 ;;
    false) echo true;  return 0 ;;
  esac
  echo "ERROR: $1 must be exactly 'true' or 'false' (got '$2')." >&2
  echo "       Anything else would be read as 'false' and silently suspend the job: $3" >&2
  return 1
}

pb_ask_schedule_env() {
  local _name _expr
  : "${ASK_SCHEDULE_ENABLED:=true}"
  # Mon-Fri 07:45-17:00 UTC, matching every target's .env.example. These are
  # the LAST resort (an old .env with none of the keys); keeping them in step
  # with the examples is what stops a deploy running a schedule nobody wrote.
  : "${ASK_SCHEDULE_UP:=45 7 * * 1-5}"
  : "${ASK_SCHEDULE_DOWN:=0 17 * * 1-5}"
  PB_ASK_SCHEDULE_SUSPEND=$(pb__enabled_to_suspend ASK_SCHEDULE_ENABLED "$ASK_SCHEDULE_ENABLED" \
    "ask-model would stay at whatever replica count it already had") || return 1
  for _name in UP DOWN; do
    case "$_name" in UP) _expr="$ASK_SCHEDULE_UP" ;; *) _expr="$ASK_SCHEDULE_DOWN" ;; esac
    pb__cron_check "ASK_SCHEDULE_$_name" "$_expr" \
      "'45 7 * * 1-5' = 07:45 UTC Mon-Fri (the default); '45 7 * * *' = every day" || return 1
  done
  PB_ASK_SCHEDULE_UP="$ASK_SCHEDULE_UP"
  PB_ASK_SCHEDULE_DOWN="$ASK_SCHEDULE_DOWN"
  export PB_ASK_SCHEDULE_UP PB_ASK_SCHEDULE_DOWN PB_ASK_SCHEDULE_SUSPEND
  if [ "$PB_ASK_SCHEDULE_SUSPEND" = true ]; then
    echo "  ask-model schedule: DISABLED (both CronJobs applied suspended; replicas left as-is)"
  else
    echo "  ask-model schedule: up '$PB_ASK_SCHEDULE_UP' / down '$PB_ASK_SCHEDULE_DOWN' (UTC)"
  fi
}

# pb_backup_schedule_env — resolve + VALIDATE the nightly backup schedule and
# export the tokens k8s/backup-cronjob.yaml carries.
#
# ONE CRON IMPLEMENTATION FOR BOTH AWS TARGETS. ec2 used to carry a second,
# separate one: bootstrap.sh installed a host `pipeline-backup.timer` at 03:30
# UTC running deploy/bin/backup.sh over kubectl port-forwards, while the
# in-cluster CronJob ran at 03:00. Two triggers, two times, neither aware of the
# other — applying the CronJob on a box whose timer was enabled gave two full
# dumps a night against the same destination. eks only ever had the CronJob, so
# the two targets also could not be reasoned about together. The timer is gone;
# the CronJob is the schedule on both.
#
# Same shape as pb_ask_schedule_env, sharing pb__cron_check and
# pb__enabled_to_suspend: `schedule` and `suspend` are CronJob SPEC fields, so
# no ConfigMap or Secret can reach them and the values are substituted at apply
# time instead.
#
# DEFAULTS TO ENABLED. The consequence is worth stating plainly: until
# BACKUP_IMAGE names an image that exists, the job will fail every night on an
# image pull and CronJobRunFailed will fire. That is the intended signal — a
# deploy with no working backup should be RED, not quietly green — but it does
# mean a fresh install alerts until the image is built. Set
# BACKUP_ENABLED=false to suspend it deliberately instead; a suspended CronJob
# never pulls, and CronJobNotScheduled ignores suspended jobs by design.
pb_backup_schedule_env() {
  : "${BACKUP_ENABLED:=true}"
  # 02:00 UTC daily. Early enough to be well clear of the 07:45 ask-model
  # scale-up and of business hours in every timezone this runs in.
  : "${BACKUP_SCHEDULE:=0 2 * * *}"
  : "${BACKUP_IMAGE:=REPLACE_ME/backup:latest}"
  # Retention is by AGE, not by archive count: the job prunes objects older than
  # this, so a daily schedule leaves roughly this many per database. 0 disables
  # the prune. Matches deploy/bin/backup.sh's own default, which reads the same
  # variable — the CronJob used to hardcode 30 in the manifest, so the two paths
  # could disagree and only one of them was configurable.
  : "${BACKUP_RETENTION_DAYS:=7}"
  case "$BACKUP_RETENTION_DAYS" in
    ''|*[!0-9]*)
      echo "ERROR: BACKUP_RETENTION_DAYS must be a non-negative integer (got '$BACKUP_RETENTION_DAYS')." >&2
      echo "       0 disables the prune; 7 keeps a week of daily dumps." >&2
      return 1 ;;
  esac
  PB_BACKUP_SUSPEND=$(pb__enabled_to_suspend BACKUP_ENABLED "$BACKUP_ENABLED" \
    "the nightly database backup would not run, and nothing would say so") || return 1
  pb__cron_check BACKUP_SCHEDULE "$BACKUP_SCHEDULE" \
    "'0 2 * * *' = 02:00 UTC daily (the default); '0 2 * * 1-5' = weekdays only" || return 1
  PB_BACKUP_SCHEDULE="$BACKUP_SCHEDULE"
  PB_BACKUP_IMAGE="$BACKUP_IMAGE"
  PB_BACKUP_RETENTION_DAYS="$BACKUP_RETENTION_DAYS"
  export PB_BACKUP_SCHEDULE PB_BACKUP_SUSPEND PB_BACKUP_IMAGE PB_BACKUP_RETENTION_DAYS
  if [ "$PB_BACKUP_SUSPEND" = true ]; then
    echo "  db-backup schedule: DISABLED (CronJob applied suspended)"
  else
    echo "  db-backup schedule: '$PB_BACKUP_SCHEDULE' (UTC), retention ${PB_BACKUP_RETENTION_DAYS}d, image $PB_BACKUP_IMAGE"
    # SAY IT AT DEPLOY TIME, not at 02:00. An enabled CronJob pointing at the
    # placeholder image fails every night on the image pull and fires
    # CronJobRunFailed — correct behaviour (a deploy with no working backup
    # should be red), but an operator should learn it here rather than from a
    # 3am page. Not fatal: refusing the whole deploy over it would be worse.
    case "$PB_BACKUP_IMAGE" in
      *REPLACE_ME*)
        echo "  WARNING: BACKUP_ENABLED=true but BACKUP_IMAGE is still the placeholder" >&2
        echo "           ($PB_BACKUP_IMAGE). The job will fail nightly on the image pull until" >&2
        echo "           you build it (needs pg_dump, mongodump, aws, rclone, openssl, curl," >&2
        echo "           non-root). Until then the working path is the manual one:" >&2
        echo "             deploy/<target>/bin/backup.sh" >&2
        echo "           Or set BACKUP_ENABLED=false to suspend the schedule deliberately." >&2 ;;
    esac
  fi
  # AND SAY WHERE THE BACKUPS LIVE. With S3_BACKUP_TARGET_URL unset, every dump
  # stays in the in-cluster object store — the same cluster, and on ec2 the same
  # DISK, as the databases it protects. That covers a dropped table or a bad
  # migration and covers nothing else. It is a legitimate choice; it should just
  # never be an accidental one.
  if [ -z "${S3_BACKUP_TARGET_URL:-}" ]; then
    echo "  NOTE: S3_BACKUP_TARGET_URL is unset — backups stay in-cluster only (no off-site copy)." >&2
  fi
}

# pb_apply_manifests <k8s_dir> <sed-expr> <lean> [lean-extra-names] — the
# manifest apply phase every k8s target shares:
#
#   1. HARD GATE on istiod. The stream carries AuthorizationPolicy docs, and
#      CREATING one calls istiod's validating webhook — with istiod still
#      starting the apply dies on `failed calling webhook "validation.istio.io"`
#      after applying an arbitrary PREFIX of the manifests. The install-time
#      waits are advisory, so this is the second, longer chance: a slow-but-
#      healthy istiod still succeeds, a broken mesh fails HERE naming the cause.
#   2. kustomize | sed <sed-expr> | pb_lean_filter | apply. <sed-expr> expands
#      ONLY the deploy tokens (${BUILDKIT_MEMORY_LIMIT}, …) — sed, not envsubst,
#      so runtime `$` tokens in inline configs (nginx ${NS}/$s, the rustfs-init
#      `$b` loop) survive.
#   3. Restart every Deployment/StatefulSet. istio-cni enrolls a pod's netns at
#      pod CREATE only, and `apply` does not recreate pods whose spec is
#      unchanged — so a workload created in a prior run (or while the mesh was
#      still coming up) can stay un-enrolled, and a STRICT-mTLS peer (postgres,
#      redis, …) silently drops its traffic: an app-level connection TIMEOUT,
#      not a refusal. A `while read` loop, not xargs, so PB_KUBECTL's `mk`
#      shell function stays callable — and it reads from a here-string, not a
#      pipe, so the loop runs in THIS shell and a failed restart can actually
#      fail the function instead of being swallowed in a subshell.
pb_apply_manifests() {
  local _dir="$1" _sed="$2" _lean="${3:-0}" _extra="${4:-}" _wl _wls _failed=""
  if ! $PB_KUBECTL wait --for=condition=Available deployment/istiod -n istio-system --timeout=300s >/dev/null 2>&1; then
    echo "ERROR: istiod is not Available — the manifests include Istio AuthorizationPolicy" >&2
    echo "       resources whose admission webhook it serves, so this apply cannot succeed." >&2
    echo "       Check: kubectl -n istio-system get pods,deploy" >&2
    return 1
  fi
  [ "$_lean" = "1" ] && echo "  LEAN=1 — omitting optional observability + admin services (prometheus/thanos/loki/promtail/jaeger/alertmanager/mongo-express/pgadmin/grafana/kiali${_extra:+/$_extra})"
  $PB_KUBECTL kustomize "$_dir" | sed "$_sed" | pb_lean_filter "$_lean" "$_extra" | $PB_KUBECTL apply -f - || return 1
  echo ""; echo "=== Restarting workloads to (re)enroll in the ambient mesh ==="
  _wls=$($PB_KUBECTL get deploy,statefulset -n "$PB_NAMESPACE" -o name) || return 1
  while IFS= read -r _wl; do
    [ -n "$_wl" ] || continue
    # Keep going so every workload is attempted, but remember the misses: a
    # workload that never restarts stays un-enrolled in the mesh and its
    # STRICT-mTLS peers silently time it out — the exact failure this step
    # exists to prevent, so it must not be reported as a clean apply.
    $PB_KUBECTL rollout restart -n "$PB_NAMESPACE" "$_wl" || _failed="${_failed} ${_wl}"
  done <<EOF
$_wls
EOF
  if [ -n "$_failed" ]; then
    echo "ERROR: rollout restart failed for:${_failed}" >&2
    echo "       Those workloads keep their pre-mesh pods and will be dropped by their" >&2
    echo "       STRICT-mTLS peers. Restart them by hand, then re-check." >&2
    return 1
  fi
}

# pb_registry_hosts_fixup <minikube_profile> — map the in-cluster `registry`
# Service's ClusterIP to the name `registry` in the minikube node's /etc/hosts,
# so the node's container runtime can pull the plugin images pushed there
# (kubelet resolves image hosts with the NODE's resolver, not cluster DNS).
# Rewrites an existing entry rather than appending a second one.
#
# Fails (non-zero) rather than reporting "registry -> unknown" and carrying on:
# without this entry kubelet cannot resolve the image host, so EVERY plugin
# image pull fails later with an obscure DNS error — a `registry -> unknown`
# line scrolling past during bring-up is not where that gets noticed.
pb_registry_hosts_fixup() {
  local _profile="$1" _ip
  _ip=$($PB_KUBECTL get svc registry -n "$PB_NAMESPACE" -o jsonpath='{.spec.clusterIP}' 2>/dev/null || true)
  if [ -z "$_ip" ]; then
    echo "ERROR: the 'registry' Service has no ClusterIP in namespace $PB_NAMESPACE —" >&2
    echo "       the node's /etc/hosts cannot be pointed at it, so plugin image pulls will fail." >&2
    return 1
  fi
  pb_as_owner minikube ssh --profile="$_profile" -- \
    "T=\$(mktemp); grep -q '\\sregistry\$' /etc/hosts && { grep -v '\\sregistry\$' /etc/hosts > \"\$T\"; echo '$_ip registry' >> \"\$T\"; sudo cp \"\$T\" /etc/hosts; rm -f \"\$T\"; } || echo '$_ip registry' | sudo tee -a /etc/hosts >/dev/null" \
    || { echo "ERROR: could not write the 'registry' entry into the minikube node's /etc/hosts" >&2; return 1; }
  echo "  registry -> ${_ip}"
}

# pb_port_forward <label> <service> <host:container> — background a
# `kubectl port-forward` to a Service and report whether it stayed up.
pb_port_forward() {
  local _label="$1" _svc="$2" _ports="$3" _pid
  $PB_KUBECTL port-forward "svc/$_svc" "$_ports" -n "$PB_NAMESPACE" >/dev/null 2>&1 &
  _pid=$!; sleep 1
  if kill -0 "$_pid" 2>/dev/null; then
    echo "  $_label → $_ports (PID $_pid)"
  else
    echo "  WARNING: $_label port-forward failed"
  fi
}

# ---------------------------------------------------------------------------
# pb_console_port_forwards — the host port-forwards a minikube operator expects:
# the gateway, plus every admin/observability console that is actually deployed.
#
# ONE definition because setup.sh (provision) and startup.sh (resume) must leave
# the operator with the IDENTICAL set. They were two copies differing only in
# comments, and the risk is not theoretical: adding the RustFS console and Jaeger
# meant editing both, and a miss would have meant a console reachable after a
# fresh provision but not after a resume — which looks like a broken resume.
#
# Each console is gated on `get svc`, not on $LEAN: a LEAN provision simply has
# no Service, and gating on the flag would also have to be duplicated (and kept
# in step) in both callers.
#
# Clears existing forwards first — re-running either script must not pile up a
# second set fighting for the same local ports.
# ---------------------------------------------------------------------------
pb_console_port_forwards() {
  pkill -f "kubectl port-forward.*-n $PB_NAMESPACE" 2>/dev/null || true
  sleep 1

  # Gateway: 8443 (HTTPS) ONLY. Binding 8080 in the same invocation made the
  # WHOLE forward fail whenever either port was busy (a leftover bind from a
  # local stack), silently killing the gateway while the single-port forwards
  # below survived — leaving https://localhost:8443 unreachable. The HTTP→HTTPS
  # redirect on 8080 is not needed for the API/UI; use the NodePort for that.
  pb_port_forward "Nginx" nginx "8443:8443"

  if $PB_KUBECTL get svc mongo-express -n "$PB_NAMESPACE" >/dev/null 2>&1; then
    pb_port_forward "Mongo Express" mongo-express "8081:8081"
  fi
  if $PB_KUBECTL get svc pgadmin -n "$PB_NAMESPACE" >/dev/null 2>&1; then
    pb_port_forward "pgAdmin" pgadmin "5480:80"
  fi
  if $PB_KUBECTL get svc grafana -n "$PB_NAMESPACE" >/dev/null 2>&1; then
    pb_port_forward "Grafana" grafana "3001:3000"
  fi
  if $PB_KUBECTL get svc kiali -n "$PB_NAMESPACE" >/dev/null 2>&1; then
    pb_port_forward "Kiali" kiali "20001:20001"
  fi
  if $PB_KUBECTL get svc rustfs-console -n "$PB_NAMESPACE" >/dev/null 2>&1; then
    # Through nginx's dedicated :9001, not straight at rustfs-console:9001, so
    # this path matches the AWS targets where the same port carries the
    # superadmin auth_request. The console needs its own ORIGIN — its UI resolves
    # the S3/admin API from window.location — which is why it is a port and not a
    # /rustfs/ path on 8443.
    pb_port_forward "RustFS console" nginx "9001:9001"
  fi
  if $PB_KUBECTL get svc jaeger -n "$PB_NAMESPACE" >/dev/null 2>&1; then
    pb_port_forward "Jaeger" jaeger "16686:16686"
  fi
  # The registry UI is served by the platform frontend at /dashboard/registry
  # (sysadmin only) — there is no separate registry console to forward.
}
