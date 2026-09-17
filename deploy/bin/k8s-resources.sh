#!/usr/bin/env bash
# Copyright 2026 Pipeline Builder Contributors
# SPDX-License-Identifier: Apache-2.0
#
# Shared Kubernetes Secret/ConfigMap creation for the AWS deploy targets
# (deploy/aws/ec2/bin/startup.sh + deploy/aws/eks/bin/setup.sh). SOURCE this file — it
# defines pb_* functions only (no side effects). The minikube target sources it too, but
# only for the kubectl-free `pb_split_app_env` (it has its own create helpers).
#
# Caller contract — set these BEFORE calling, and source the target's .env first (the
# secret VALUES come from it):
#   PB_KUBECTL    the kubectl runner — "kubectl" (eks) or "mk kubectl" (ec2: runs kubectl as
#                 the minikube user via the caller's `mk` function, which must be in scope)
#   PB_NAMESPACE  the target namespace
#
# Every create is idempotent (render with --dry-run=client, then apply).

# Render-then-apply a `create …` so re-runs update rather than fail.
pb_kube_apply() { $PB_KUBECTL "$@" --dry-run=client -o yaml | $PB_KUBECTL apply -f - ; }

pb_secret()    { local _n="$1"; shift; pb_kube_apply create secret generic "$_n" "$@" -n "$PB_NAMESPACE"; echo "  secret $_n"; }
pb_configmap() { local _n="$1"; shift; pb_kube_apply create configmap "$_n" "$@" -n "$PB_NAMESPACE"; echo "  configmap $_n"; }

# pb_split_app_env <clean_env> <config_out> <secret_out>
#
# Split a cleaned (comment/blank-stripped, envsubst'd) .env into what the app pods get:
#   <config_out>  non-secret settings  -> the `app-env` ConfigMap
#   <secret_out>  credentials/tokens   -> the `app-secrets` Secret
# Every workload that reads app-env via envFrom ALSO lists app-secrets (except frontend,
# which reads no secret), so the split changes where values live, not what apps see.
#
# ADMIN-ONLY keys are dropped from BOTH: the Postgres/Mongo/MinIO superusers and the
# admin-UI logins. Their consumers (postgres, mongodb, minio, pgbouncer, pgadmin,
# mongo-express, grafana, kiali, loki/thanos/registry, backup) read them from their own
# Secrets (postgres-secret, mongodb-secret, minio-secret, …) by key, so no application
# pod ever receives a credential that bypasses row-level security or tenant scoping.
#
# Secret detection is by NAME, so a newly added *_PASSWORD / *_SECRET / *_TOKEN / *_KEY /
# API key lands in the Secret without touching this function. Knobs that merely contain
# those words (…_TOKEN_EXPIRES_IN, …_TOKEN_URL, …_KEY_ID, PASSWORD_MIN_LENGTH) stay config.
pb_split_app_env() {
  local _src="$1" _cfg="$2" _sec="$3"
  : > "$_cfg"; : > "$_sec"
  awk -v cfg="$_cfg" -v sec="$_sec" '
    {
      key = $0; sub(/=.*/, "", key)
      if (key ~ /^(POSTGRES_USER|POSTGRES_PASSWORD|MONGO_INITDB_ROOT_USERNAME|MONGO_INITDB_ROOT_PASSWORD|MINIO_ROOT_USER|MINIO_ROOT_PASSWORD|GRAFANA_ADMIN_USER|GRAFANA_ADMIN_PASSWORD|KIALI_SIGNING_KEY|GHCR_TOKEN)$/ \
          || key ~ /^(ME_CONFIG_|PGADMIN_|LOKI_S3_|THANOS_S3_|REGISTRY_S3_)/) next
      if (key ~ /(_EXPIRES_IN|_ISSUER|_SERVICE|_REALM|_TTL_MS|_TOKEN_URL|_KEY_ID|_LENGTH|_KMS|ATTRIBUTE_KEYS)$/) { print > cfg; next }
      if (key ~ /(PASSWORD|_PASS|SECRET|TOKEN|_KEY|_KEYS|_URI)$/ || key ~ /SECRET|PASSWORD|WEBHOOK_URL/ || key == "REDIS_URL") { print > sec; next }
      print > cfg
    }' "$_src"
}

# app-env ConfigMap + app-secrets Secret from a cleaned .env file (see pb_split_app_env).
pb_app_env_resources() {
  local _cfg _sec
  _cfg=$(mktemp); _sec=$(mktemp)
  pb_split_app_env "$1" "$_cfg" "$_sec"
  # Same ownership as the source: ec2 runs kubectl as the minikube user.
  if [ -n "${PB_ENV_FILE_OWNER:-}" ]; then chown "$PB_ENV_FILE_OWNER" "$_cfg" "$_sec"; chmod 600 "$_cfg" "$_sec"; fi
  pb_configmap app-env --from-env-file="$_cfg"
  pb_secret app-secrets --from-env-file="$_sec"
  rm -f "$_cfg" "$_sec"
}

# Application secrets — names/keys must match the k8s manifests. Reads the sourced .env.
pb_create_app_secrets() {
  pb_secret jwt-secret           --from-literal=JWT_SECRET="$JWT_SECRET" --from-literal=REFRESH_TOKEN_SECRET="$REFRESH_TOKEN_SECRET"
  # postgres-secret is read BY KEY only (postgres, its exporter, pgbouncer, backup): the
  # superuser pair for init/backup, the DB_USER app-role pair for postgres-init.sql and
  # pgbouncer's userlist. App pods get DB_USER/DB_PASSWORD from app-env/app-secrets and
  # must never envFrom this Secret (it would hand them the RLS-bypassing superuser).
  pb_secret postgres-secret      --from-literal=POSTGRES_USER="$POSTGRES_USER" --from-literal=POSTGRES_PASSWORD="$POSTGRES_PASSWORD" --from-literal=DB_USER="$DB_USER" --from-literal=DB_PASSWORD="$DB_PASSWORD"
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
  pb_secret alertmanager-relay   --from-literal=ALERT_WEBHOOK_INSTANCE_TOKEN="$ALERT_WEBHOOK_INSTANCE_TOKEN"
  # MinIO: root creds (server + minio-init bootstrap) plus the per-service,
  # bucket-scoped keys. Created HERE from .env rather than shipped as a literal
  # Secret in k8s/minio.yaml — which is what it used to be, with working
  # `minioadmin`/`minioadmin` defaults committed to the repo. That made the
  # MINIO_* values in .env silently inert on these targets: the Deployment reads
  # this Secret, so an operator who changed .env (as .env.example tells them to)
  # still got the shipped defaults, and pb_gen_env_secrets had nothing to
  # randomise. Key names must match the secretKeyRef entries in k8s/minio.yaml,
  # k8s/plugin.yaml, k8s/loki.yaml, k8s/registry.yaml and k8s/message.yaml.
  pb_secret minio-secret \
    --from-literal=root-user="$MINIO_ROOT_USER"              --from-literal=root-password="$MINIO_ROOT_PASSWORD" \
    --from-literal=message-access-key="$MESSAGE_S3_ACCESS_KEY"   --from-literal=message-secret-key="$MESSAGE_S3_SECRET_KEY" \
    --from-literal=registry-access-key="$REGISTRY_S3_ACCESS_KEY" --from-literal=registry-secret-key="$REGISTRY_S3_SECRET_KEY" \
    --from-literal=loki-access-key="$LOKI_S3_ACCESS_KEY"         --from-literal=loki-secret-key="$LOKI_S3_SECRET_KEY" \
    --from-literal=thanos-access-key="$THANOS_S3_ACCESS_KEY"     --from-literal=thanos-secret-key="$THANOS_S3_SECRET_KEY" \
    --from-literal=plugin-access-key="$PLUGIN_S3_ACCESS_KEY"     --from-literal=plugin-secret-key="$PLUGIN_S3_SECRET_KEY"
}

# Optional GHCR pull secret, attached to the namespace's default ServiceAccount. No-op unless
# GHCR_TOKEN is set. (docker-registry secret type → not via pb_secret, which is generic-only.)
pb_create_ghcr_secret() {
  [ -n "${GHCR_TOKEN:-}" ] || return 0
  pb_kube_apply create secret docker-registry ghcr-secret --docker-server=ghcr.io \
    --docker-username="${GHCR_USER:-mwashburn160}" --docker-password="$GHCR_TOKEN" -n "$PB_NAMESPACE"
  $PB_KUBECTL patch sa default -n "$PB_NAMESPACE" -p '{"imagePullSecrets":[{"name":"ghcr-secret"}]}'
  echo "  secret ghcr-secret"
}

# image-registry token-signing keypair secret (<key_file> <crt_file>) + the build-svc Basic-auth
# creds the proxy uses to reach the underlying registry. (No htpasswd/registry-auth-secret —
# the registry uses token auth; nothing mounts it.)
pb_create_registry_secrets() {
  pb_secret registry-token-secret --from-file=jwt-private.pem="$1" --from-file=jwt-public.pem="$2"
  pb_secret image-registry-build-svc-secret \
    --from-literal=IMAGE_REGISTRY_USERNAME="$IMAGE_REGISTRY_USER" --from-literal=IMAGE_REGISTRY_PASSWORD="$IMAGE_REGISTRY_TOKEN"
}

# Config-file ConfigMaps + the MongoDB keyfile secret. Args: <deploy_dir> <config_dir> <nginx_dir>.
pb_create_config_maps() {
  local _deploy="$1" _config="$2" _nginx="$3"
  pb_secret    mongodb-keyfile     --from-file=mongodb-keyfile="$_deploy/mongodb-keyfile"
  pb_configmap postgres-init       --from-file=init.sql="$_deploy/postgres-init.sql"
  pb_configmap mongodb-init        --from-file=mongo-init.js="$_deploy/mongodb-init.js"
  pb_configmap nginx-config        --from-file=nginx.conf="$_nginx/nginx.conf"
  pb_configmap nginx-njs           --from-file=jwt.js="$_nginx/jwt.js" --from-file=metrics.js="$_nginx/metrics.js" --from-file=registry-auth.js="$_nginx/registry-auth.js"
  pb_configmap loki-config         --from-file=loki-config.yml="$_config/loki/loki-config.yml"
  pb_configmap prometheus-config   --from-file=prometheus.yml="$_config/prometheus/prometheus.yml" --from-file=alert-rules.yml="$_config/prometheus/alert-rules.yml"
  pb_configmap thanos-objstore     --from-file=objstore.yml="$_config/thanos/objstore.yml"
  pb_configmap alertmanager-config --from-file=alertmanager.yml="$_config/alertmanager/alertmanager.yml"
  pb_configmap promtail-config     --from-file=promtail-config.yml="$_config/promtail/promtail-config.yml"
}
