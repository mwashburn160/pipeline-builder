#!/usr/bin/env bash
# Copyright 2026 Pipeline Builder Contributors
# SPDX-License-Identifier: Apache-2.0
#
# Shared .env secret generation for the AWS deploy targets (ec2 bootstrap + eks setup).
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

pb_gen_env_secrets() {
  local env_file="$1" ghcr_user="${2:-mwashburn160}"
  local jwt refresh pg mongo me pgadmin registry
  jwt=$(openssl rand -base64 32 | tr -d '=+/')
  refresh=$(openssl rand -base64 32 | tr -d '=+/')
  pg=$(openssl rand -base64 24 | tr -d '=+/')
  mongo=$(openssl rand -base64 24 | tr -d '=+/')
  me=$(openssl rand -base64 16 | tr -d '=+/')
  pgadmin=$(openssl rand -base64 16 | tr -d '=+/')
  registry=$(openssl rand -base64 24 | tr -d '=+/')
  sed -i.bak \
    -e "s|JWT_SECRET=CHANGE_ME_generate_with_openssl_rand_base64_32|JWT_SECRET=${jwt}|" \
    -e "s|REFRESH_TOKEN_SECRET=CHANGE_ME_generate_with_openssl_rand_base64_32|REFRESH_TOKEN_SECRET=${refresh}|" \
    -e "s|POSTGRES_PASSWORD=CHANGE_ME|POSTGRES_PASSWORD=${pg}|" \
    -e "s|DB_PASSWORD=CHANGE_ME|DB_PASSWORD=${pg}|" \
    -e "s|MONGO_INITDB_ROOT_PASSWORD=CHANGE_ME|MONGO_INITDB_ROOT_PASSWORD=${mongo}|" \
    -e "s|mongodb://mongo:CHANGE_ME@|mongodb://mongo:${mongo}@|g" \
    -e "s|ME_CONFIG_MONGODB_ADMINPASSWORD=CHANGE_ME|ME_CONFIG_MONGODB_ADMINPASSWORD=${mongo}|" \
    -e "s|ME_CONFIG_BASICAUTH_PASSWORD=CHANGE_ME|ME_CONFIG_BASICAUTH_PASSWORD=${me}|" \
    -e "s|PGADMIN_DEFAULT_PASSWORD=CHANGE_ME|PGADMIN_DEFAULT_PASSWORD=${pgadmin}|" \
    -e "s|IMAGE_REGISTRY_TOKEN=CHANGE_ME|IMAGE_REGISTRY_TOKEN=${registry}|" \
    -e "s|GHCR_USER=mwashburn160|GHCR_USER=${ghcr_user}|" \
    "$env_file"
  rm -f "$env_file.bak"

  # Guard against a drifted placeholder: if any REQUIRED secret this function
  # owns still reads CHANGE_ME, a placeholder string in .env.example was renamed
  # and the sed above silently matched nothing — shipping a literal `CHANGE_ME`
  # credential (a real security hole that would otherwise pass green). Scoped to
  # these keys so optional user-supplied CHANGE_ME placeholders aren't flagged.
  if grep -qE '^(JWT_SECRET|REFRESH_TOKEN_SECRET|POSTGRES_PASSWORD|DB_PASSWORD|MONGO_INITDB_ROOT_PASSWORD|ME_CONFIG_MONGODB_ADMINPASSWORD|ME_CONFIG_BASICAUTH_PASSWORD|PGADMIN_DEFAULT_PASSWORD|IMAGE_REGISTRY_TOKEN)=CHANGE_ME' "$env_file" \
     || grep -q 'mongodb://mongo:CHANGE_ME@' "$env_file"; then
    echo "ERROR: gen-env-secrets left an unsubstituted CHANGE_ME in a required secret in $env_file" >&2
    echo "  — a placeholder in .env.example drifted from this script's sed patterns." >&2
    return 1
  fi
}
