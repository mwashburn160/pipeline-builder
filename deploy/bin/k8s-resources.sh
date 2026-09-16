#!/usr/bin/env bash
# Copyright 2026 Pipeline Builder Contributors
# SPDX-License-Identifier: Apache-2.0
#
# Shared Kubernetes Secret/ConfigMap creation for the AWS deploy targets
# (deploy/aws/ec2/bin/startup.sh + deploy/aws/eks/bin/setup.sh). SOURCE this file — it
# defines pb_* functions only (no side effects).
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

# app-env ConfigMap from a cleaned (comment/blank-stripped, envsubst'd) .env file.
pb_app_env_configmap() { pb_configmap app-env --from-env-file="$1"; }

# Application secrets — names/keys must match the k8s manifests. Reads the sourced .env.
pb_create_app_secrets() {
  pb_secret jwt-secret           --from-literal=JWT_SECRET="$JWT_SECRET" --from-literal=REFRESH_TOKEN_SECRET="$REFRESH_TOKEN_SECRET"
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
