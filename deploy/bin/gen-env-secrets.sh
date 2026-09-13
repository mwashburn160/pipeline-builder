#!/usr/bin/env bash
# Copyright 2026 Pipeline Builder Contributors
# SPDX-License-Identifier: Apache-2.0
#
# Shared .env secret generation for EVERY deploy target: ec2 (bootstrap.sh), eks,
# minikube and docker (each target's setup.sh) all source this.
# SOURCE this file (it only defines a function — no side effects).
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
  # generates immediately) keeps literal CHANGE_ME values for JWT_SECRET,
  # POSTGRES_PASSWORD, SECRET_ENCRYPTION_KEY and the rest — an install that comes
  # up with `CHANGE_ME` as a real credential. Substitution only rewrites
  # placeholder lines, so this is a no-op on an already-generated file, and the
  # guard inside pb_gen_env_secrets fails loudly if any required one survives.
  if grep -qE '^[A-Z0-9_]+=CHANGE_ME' "$env_file"; then
    echo "  filling CHANGE_ME placeholders in ${env_file}"
    pb_gen_env_secrets "$env_file"
  fi
}

pb_gen_env_secrets() {
  local env_file="$1" ghcr_user="${2:-mwashburn160}"
  local jwt refresh pg mongo me pgadmin registry seckey minioroot s3msg s3reg s3loki s3thanos s3plugin
  jwt=$(openssl rand -base64 32 | tr -d '=+/')
  refresh=$(openssl rand -base64 32 | tr -d '=+/')
  # Secret-column master key (AES-256-GCM envelope encryption of aiProviderKeys
  # and IdP client secrets). Required now that every target sets
  # NODE_ENV=production — platform refuses to boot without it. Hex, because the
  # =+/-stripping below would corrupt a base64 key's length.
  seckey=$(openssl rand -hex 32)
  pg=$(openssl rand -base64 24 | tr -d '=+/')
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
  sed -i.bak \
    -e "s|JWT_SECRET=CHANGE_ME_generate_with_openssl_rand_base64_32|JWT_SECRET=${jwt}|" \
    -e "s|REFRESH_TOKEN_SECRET=CHANGE_ME_generate_with_openssl_rand_base64_32|REFRESH_TOKEN_SECRET=${refresh}|" \
    -e "s|SECRET_ENCRYPTION_KEY=CHANGE_ME_generate_with_openssl_rand_base64_32|SECRET_ENCRYPTION_KEY=${seckey}|" \
    -e "s|POSTGRES_PASSWORD=CHANGE_ME|POSTGRES_PASSWORD=${pg}|" \
    -e "s|DB_PASSWORD=CHANGE_ME|DB_PASSWORD=${pg}|" \
    -e "s|MONGO_INITDB_ROOT_PASSWORD=CHANGE_ME|MONGO_INITDB_ROOT_PASSWORD=${mongo}|" \
    -e "s|mongodb://mongo:CHANGE_ME@|mongodb://mongo:${mongo}@|g" \
    -e "s|ME_CONFIG_MONGODB_ADMINPASSWORD=CHANGE_ME|ME_CONFIG_MONGODB_ADMINPASSWORD=${mongo}|" \
    -e "s|ME_CONFIG_BASICAUTH_PASSWORD=CHANGE_ME|ME_CONFIG_BASICAUTH_PASSWORD=${me}|" \
    -e "s|PGADMIN_DEFAULT_PASSWORD=CHANGE_ME|PGADMIN_DEFAULT_PASSWORD=${pgadmin}|" \
    -e "s|IMAGE_REGISTRY_TOKEN=CHANGE_ME|IMAGE_REGISTRY_TOKEN=${registry}|" \
    -e "s|MINIO_ROOT_PASSWORD=CHANGE_ME|MINIO_ROOT_PASSWORD=${minioroot}|" \
    -e "s|MESSAGE_S3_SECRET_KEY=CHANGE_ME|MESSAGE_S3_SECRET_KEY=${s3msg}|" \
    -e "s|REGISTRY_S3_SECRET_KEY=CHANGE_ME|REGISTRY_S3_SECRET_KEY=${s3reg}|" \
    -e "s|LOKI_S3_SECRET_KEY=CHANGE_ME|LOKI_S3_SECRET_KEY=${s3loki}|" \
    -e "s|THANOS_S3_SECRET_KEY=CHANGE_ME|THANOS_S3_SECRET_KEY=${s3thanos}|" \
    -e "s|PLUGIN_S3_SECRET_KEY=CHANGE_ME|PLUGIN_S3_SECRET_KEY=${s3plugin}|" \
    -e "s|GHCR_USER=mwashburn160|GHCR_USER=${ghcr_user}|" \
    "$env_file"
  rm -f "$env_file.bak"

  # Guard against a drifted placeholder: if any REQUIRED secret this function
  # owns still reads CHANGE_ME, a placeholder string in .env.example was renamed
  # and the sed above silently matched nothing — shipping a literal `CHANGE_ME`
  # credential (a real security hole that would otherwise pass green). Scoped to
  # these keys so optional user-supplied CHANGE_ME placeholders aren't flagged.
  if grep -qE '^(JWT_SECRET|REFRESH_TOKEN_SECRET|SECRET_ENCRYPTION_KEY|POSTGRES_PASSWORD|DB_PASSWORD|MONGO_INITDB_ROOT_PASSWORD|ME_CONFIG_MONGODB_ADMINPASSWORD|ME_CONFIG_BASICAUTH_PASSWORD|PGADMIN_DEFAULT_PASSWORD|IMAGE_REGISTRY_TOKEN|MINIO_ROOT_PASSWORD|MESSAGE_S3_SECRET_KEY|REGISTRY_S3_SECRET_KEY|LOKI_S3_SECRET_KEY|THANOS_S3_SECRET_KEY|PLUGIN_S3_SECRET_KEY)=CHANGE_ME' "$env_file" \
     || grep -q 'mongodb://mongo:CHANGE_ME@' "$env_file"; then
    echo "ERROR: gen-env-secrets left an unsubstituted CHANGE_ME in a required secret in $env_file" >&2
    echo "  — a placeholder in .env.example drifted from this script's sed patterns." >&2
    return 1
  fi
}
