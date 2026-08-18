#!/usr/bin/env bash
set -euo pipefail

# Resolve script directory so this works from any working directory
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DEPLOY_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
BIN_DIR="$(cd "$SCRIPT_DIR/../../../bin" && pwd)"   # deploy/bin (shared helpers)

# Shared deploy helpers: common.sh provides preflight(); gen-env-secrets.sh
# provides pb_gen_env_secrets() (fills the .env CHANGE_ME secret placeholders).
# NOTE: sourcing common.sh changes cwd to /tmp (its macOS portability
# workaround), so we cd into DEPLOY_DIR *after* sourcing.
# shellcheck source=/dev/null
source "$BIN_DIR/common.sh"
# shellcheck source=/dev/null
source "$BIN_DIR/gen-env-secrets.sh"

# Assert the tools the steps below need: docker for the stack, openssl for the
# .env secret + MongoDB keyfile generation.
preflight docker openssl

cd "$DEPLOY_DIR"

# -----------------------------------------------------------------------
# Verify prerequisites (presence already asserted by `preflight docker` above;
# this checks the daemon is actually reachable).
# -----------------------------------------------------------------------
if ! docker info >/dev/null 2>&1; then
  echo "ERROR: Docker daemon is not running" >&2
  exit 1
fi

# Prefer Compose v2 (the `docker compose` plugin); fall back to legacy
# `docker-compose` (v1), still common on older Linux. Use "${DC[@]}" below.
if docker compose version >/dev/null 2>&1; then
  DC=(docker compose)
elif command -v docker-compose >/dev/null 2>&1; then
  DC=(docker-compose)
else
  echo "ERROR: requires 'docker compose' (v2 plugin) or 'docker-compose' (v1)" >&2
  exit 1
fi

# yq — required by build-plugin-images.sh. Check
# only (don't auto-install) so we don't silently mutate the user's brew state.
if ! command -v yq >/dev/null 2>&1; then
  echo "ERROR: yq is not installed (required for plugin builds)" >&2
  echo "  macOS: brew install yq" >&2
  echo "  Linux: https://github.com/mikefarah/yq#install" >&2
  exit 1
fi

# Auto-seed .env from the example on first run so the deploy isn't a hard stop.
# The example ships working local defaults (BILLING_ENABLED=true, dev secrets);
# only optional keys (e.g. AI provider keys) need filling in for those features.
if [ ! -f "$DEPLOY_DIR/.env" ]; then
  if [ -f "$DEPLOY_DIR/.env.example" ]; then
    cp "$DEPLOY_DIR/.env.example" "$DEPLOY_DIR/.env"
    # Local plugin images run on THIS host, so build for the host arch. The
    # shipped PUBLISH_PLATFORM default (linux/amd64) forces QEMU emulation on
    # Apple Silicon, where the Rust toolchain segfaults building the base image.
    case "$(uname -m)" in
      arm64|aarch64) echo "PUBLISH_PLATFORM=linux/arm64" >> "$DEPLOY_DIR/.env" ;;
      *)             echo "PUBLISH_PLATFORM=linux/amd64" >> "$DEPLOY_DIR/.env" ;;
    esac
    # Fill the CHANGE_ME secret placeholders (Postgres/Mongo/JWT/registry) with
    # fresh random values so local does NOT run with literal CHANGE_ME creds.
    # Only on this freshly-seeded .env — never rotate an existing one (would
    # break already-initialized DB volumes whose passwords were baked on init).
    pb_gen_env_secrets "$DEPLOY_DIR/.env"
    echo "No .env found — created $DEPLOY_DIR/.env from .env.example (local defaults, secrets generated, PUBLISH_PLATFORM pinned to host arch)." >&2
    echo "  Review it and set any optional keys (e.g. AI provider keys) before you rely on those features." >&2
  else
    echo "ERROR: neither .env nor .env.example found at $DEPLOY_DIR" >&2
    echo "  Expected $DEPLOY_DIR/.env.example to seed the config." >&2
    exit 1
  fi
fi

# -----------------------------------------------------------------------
# Ensure TLS certificates exist
# -----------------------------------------------------------------------
CERT_DIR="$DEPLOY_DIR/certs"

# nginx gateway TLS + image-registry token-signing keypair — shared, idempotent
# generators (see deploy/bin/{nginx-tls,jwt-keys}.sh). Both skip when the files
# already exist, so re-running setup is cheap and doesn't rotate keys.
bash "$BIN_DIR/nginx-tls.sh" "$CERT_DIR"
# image-registry token-signing keypair → certs/image-registry-jwt.{key,crt},
# bind-mounted as /etc/registry/jwt-{private,public}.pem by the registry +
# image-registry containers. MUST exist before `compose up`, otherwise Docker
# creates the mount paths as empty DIRECTORIES and both containers crash-loop
# ("is a directory" / EISDIR reading the PEM). Idempotent (skips if present).
bash "$BIN_DIR/jwt-keys.sh" "$CERT_DIR"
# (No registry htpasswd: the registry uses token auth — REGISTRY_AUTH: token in
# docker-compose.yml; nothing mounts registry.passwd.)

# -----------------------------------------------------------------------
# Ensure MongoDB keyfile has correct permissions
# -----------------------------------------------------------------------
# Replica-set internal-auth keyfile — generated PER DEPLOY via the shared
# idempotent helper (it is gitignored/not tracked, so a fresh checkout has
# none). Skips if present; mongod requires 400/600, so tighten to 400 to match
# the read-only-mounted perms mongod validates.
KEYFILE="$DEPLOY_DIR/mongodb-keyfile"
# shellcheck source=/dev/null
source "$BIN_DIR/mongo-keyfile.sh"
pb_ensure_mongo_keyfile "$KEYFILE"
chmod 400 "$KEYFILE"

# -----------------------------------------------------------------------
# Ensure data directories exist
# -----------------------------------------------------------------------
echo "=== Ensuring data directories exist ==="
# Bind-mount sources under ./data/ — pre-created here so they're owned by the
# invoking user (Docker would otherwise auto-create a missing source as root).
# Keep this list in lockstep with the './data/*' bind mounts in
# docker-compose.yml. NOT created here (deliberately):
#   - buildkit-cache : a *named* Docker volume now, not ./data/buildkit-cache.
#   - registry-data / uploads : pre-object-storage leftovers, superseded by
#     MinIO (./data/minio-data). The registry no longer uses ./data/registry-data.
mkdir -p "$DEPLOY_DIR/data/db-data/mongodb" \
         "$DEPLOY_DIR/data/db-data/postgres" \
         "$DEPLOY_DIR/data/db-data/redis" \
         "$DEPLOY_DIR/data/db-data/loki" \
         "$DEPLOY_DIR/data/db-data/prometheus" \
         "$DEPLOY_DIR/data/db-data/alertmanager" \
         "$DEPLOY_DIR/data/minio-data" \
         "$DEPLOY_DIR/data/pgadmin-data" \
         "$DEPLOY_DIR/data/cache" \
         "$DEPLOY_DIR/data/tmp" \
         "$DEPLOY_DIR/data/promtail-data"

# Docker build scratch dir (single dir now — the durable cross-replica build
# context lives in object storage / MinIO, so this is per-node scratch: the
# transient incoming ZIP + the extracted build context). Two paths in play:
#   - Host: where docker-compose binds the volume from (created + chmod'd here)
#   - Container: laptop-style /data/plugins-data inside the plugin container,
#     matching the volumeMount in docker-compose.yml. The plugin code reads
#     DOCKER_BUILD_TEMP_ROOT / PLUGIN_UPLOAD_DIR to find it, so the env value
#     must equal the container-side bind target.
# the ec2 deploy keeps host=container path at /opt/pipeline/pipeline-data/*
# (its k8s hostPath mounts the same absolute path on both sides).
PLUGIN_DATA_HOST="$DEPLOY_DIR/data/plugins-data"
export DOCKER_BUILD_TEMP_ROOT="${DOCKER_BUILD_TEMP_ROOT:-/data/plugins-data}"
mkdir -p "$PLUGIN_DATA_HOST"

# Plugin container runs as node (UID 1000) — ensure the writable volume mount
chmod 1777 "$PLUGIN_DATA_HOST"

# Plugin builds run via a rootless buildkitd sidecar — no strategy choice,
# no dind, no certs to generate. See deploy/local/docker/docker-compose.yml.

# Register QEMU/binfmt when the build target arch differs from the host (e.g.
# building linux/amd64 plugin images on an arm64 box) — rootless buildkit can't
# do it itself. No-op on Docker Desktop (QEMU pre-registered) and on same-arch.
# PUBLISH_PLATFORM is read from .env (compose's default is linux/amd64).
# tail -1 (last-wins) matches docker compose's env_file precedence, so if the
# example's commented PUBLISH_PLATFORM is uncommented AND the seed appends one,
# ensure-binfmt targets the same arch compose builds for.
PUBLISH_PLATFORM="$(grep -E '^PUBLISH_PLATFORM=' "$DEPLOY_DIR/.env" 2>/dev/null | tail -1 | cut -d= -f2- || true)"
bash "$BIN_DIR/ensure-binfmt.sh" "${PUBLISH_PLATFORM:-linux/amd64}"

# -----------------------------------------------------------------------
# Start services
# -----------------------------------------------------------------------
echo "=== Starting Docker Compose ==="
# Detached: start the stack and RETURN (so an orchestrator like
# `pipeline-manager infra provision` can proceed to health checks + init-platform, and
# a direct run doesn't block on streamed container logs). Matches the README
# quick-start. Watch logs any time with: docker compose logs -f
"${DC[@]}" up -d --remove-orphans "$@"
echo "Stack started (detached). Follow logs with: ${DC[*]} logs -f"

# Access summary (mirrors the AWS targets' "Deployment Complete" output).
echo ""
echo "========================================"
echo "Deployment Complete — Local (Docker Compose)"
echo "========================================"
echo ""
echo "  Platform UI / API : https://localhost:8443"
echo "  Default admin     : admin@internal  (default password & overrides in docs/README.md — set PLATFORM_PASSWORD to change)"
echo ""
echo "  Dev tools:"
echo "    pgAdmin (Postgres UI)    : http://localhost:5480"
echo "    Mongo Express (Mongo UI) : http://localhost:27081"
echo "    Jaeger (tracing)         : http://localhost:16686"
echo "    Docker registry          : localhost:5000"
echo ""
echo "  Databases (postgres / mongodb / redis) run inside the compose network —"
echo "  reach them via the dev tools above, not a host port. Credentials live in"
echo "  ${DEPLOY_DIR}/.env."
echo ""
echo "  Next : ./deploy/bin/init-platform.sh docker        # register admin + (opt-in) load plugins/samples/compliance"
echo "  Stop : ${DC[*]} down                              # data persists in ${DEPLOY_DIR}/data"
echo "  Reset: ${DC[*]} down && rm -rf ${DEPLOY_DIR}/data  # wipe DBs for a clean re-init"
echo ""
