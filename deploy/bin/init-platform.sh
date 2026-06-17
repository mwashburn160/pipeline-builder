#!/usr/bin/env bash
set -euo pipefail

# Initialize the platform — register admin, optionally load plugins and pipelines.
#
# Usage:
#   ./init-platform.sh                                         # defaults to "local"
#   ./init-platform.sh local                                   # Docker Compose (https://localhost:8443)
#   ./init-platform.sh minikube                                # Minikube (tunnels via kubectl port-forward)
#   ./init-platform.sh ec2                                     # EC2 (requires PLATFORM_BASE_URL or stack name)
#   ./init-platform.sh eks                                     # EKS (port-forwards to nginx via kubectl; or set PLATFORM_BASE_URL)
#   ./init-platform.sh --cleanup ec2                           # Clean up plugin.zip + image.tar after upload

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
. "$SCRIPT_DIR/common.sh"

CLEANUP_AFTER_UPLOAD=false
# Default: keep current strict behavior — abort on the first plugin build failure.
# Pass --continue-on-build-failure to let init proceed when some plugins fail
# (e.g., transient apt mirror flap on 1 of 124 plugins). The successful tars
# still get loaded; the failed ones are skipped by load-plugins (no image.tar
# = no upload, no spurious 500).
CONTINUE_ON_BUILD_FAILURE=false

# Parse flags before the target argument
while [ $# -gt 0 ]; do
  case "$1" in
    --cleanup) CLEANUP_AFTER_UPLOAD=true; shift ;;
    --continue-on-build-failure) CONTINUE_ON_BUILD_FAILURE=true; shift ;;
    -*) echo "Unknown flag: $1" >&2; exit 1 ;;
    *) break ;;
  esac
done

TARGET="${1:-local}"
NAMESPACE="${NAMESPACE:-pipeline-builder}"   # env-overridable, matching push-base-images.sh
TUNNEL_PID=""

# Accept y / yes / true (any case) as affirmative, so the LOAD_* toggles and BUILD_BOOTSTRAP
# agree on what counts as "on" (BUILD_BOOTSTRAP's case test already allows y|yes|true).
_truthy() { case "$(printf '%s' "${1:-}" | tr '[:upper:]' '[:lower:]')" in y|yes|true) return 0 ;; *) return 1 ;; esac; }

# ---- Cleanup ----

cleanup() {
  if [ -n "$TUNNEL_PID" ]; then
    kill "$TUNNEL_PID" 2>/dev/null || true
    wait "$TUNNEL_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

# ---- Resolve platform URL ----

case "$TARGET" in
  local)
    PLATFORM_BASE_URL=${PLATFORM_BASE_URL:-https://localhost:8443}
    ;;
  minikube)
    if [ -n "${PLATFORM_BASE_URL:-}" ]; then
      echo "Using PLATFORM_BASE_URL=$PLATFORM_BASE_URL"
    else
      if curl -s -k -o /dev/null -w "" "https://localhost:8443/" 2>/dev/null; then
        echo "=== Reusing existing port-forward on localhost:8443 ==="
      else
        echo "=== Setting up port-forward to nginx ==="
        kubectl port-forward svc/nginx 8443:8443 -n "$NAMESPACE" > /dev/null 2>&1 &
        TUNNEL_PID=$!
        sleep 2
        if ! kill -0 "$TUNNEL_PID" 2>/dev/null; then
          echo "ERROR: Port-forward failed. Is the cluster running?" >&2
          exit 1
        fi
        echo "  Forwarding localhost:8443 -> nginx:8443"
      fi
      PLATFORM_BASE_URL="https://localhost:8443"
    fi
    ;;
  ec2)
    if [ -n "${PLATFORM_BASE_URL:-}" ]; then
      echo "Using PLATFORM_BASE_URL=$PLATFORM_BASE_URL"
    else
      # Try to resolve URL from CloudFormation stack outputs
      STACK_NAME="${STACK_NAME:-pipeline-builder}"
      echo "=== Resolving URL from CloudFormation stack: $STACK_NAME ==="
      APP_URL=$(aws cloudformation describe-stacks \
        --stack-name "$STACK_NAME" \
        --query 'Stacks[0].Outputs[?OutputKey==`ApplicationURL`].OutputValue' \
        --output text 2>/dev/null || true)
      if [ -z "$APP_URL" ] || [ "$APP_URL" = "None" ]; then
        echo "ERROR: Could not resolve ApplicationURL from stack '$STACK_NAME'." >&2
        echo "  Set PLATFORM_BASE_URL or STACK_NAME manually." >&2
        exit 1
      fi
      PLATFORM_BASE_URL="$APP_URL"
      echo "  Resolved: $PLATFORM_BASE_URL"
    fi
    ;;
  eks)
    if [ -n "${PLATFORM_BASE_URL:-}" ]; then
      echo "Using PLATFORM_BASE_URL=$PLATFORM_BASE_URL"
    else
      # EKS nginx serves plain HTTP on 8080 (TLS terminates at the ALB). Reach it via a
      # kubectl port-forward so init works from anywhere with cluster access, independent of
      # whether the ALB / Route 53 record is ready yet (mirrors minikube). Override with
      # PLATFORM_BASE_URL to hit the public domain directly instead.
      if curl -s -o /dev/null -w "" "http://localhost:8080/" 2>/dev/null; then
        echo "=== Reusing existing port-forward on localhost:8080 ==="
      else
        echo "=== Setting up port-forward to nginx (8080) ==="
        kubectl port-forward svc/nginx 8080:8080 -n "$NAMESPACE" > /dev/null 2>&1 &
        TUNNEL_PID=$!
        sleep 2
        if ! kill -0 "$TUNNEL_PID" 2>/dev/null; then
          echo "ERROR: Port-forward failed. Is the EKS cluster reachable (kubectl) and nginx running?" >&2
          exit 1
        fi
        echo "  Forwarding localhost:8080 -> nginx:8080"
      fi
      PLATFORM_BASE_URL="http://localhost:8080"
    fi
    ;;
  *)
    echo "Usage: $0 [local|minikube|ec2|eks]" >&2
    exit 1
    ;;
esac

# ---- Main ----

echo ""
echo "=== Initializing platform ($TARGET) ==="
echo "  URL: $PLATFORM_BASE_URL"

# Deployment posture (ec2): "public" vs "private" (inside-AWS-only). The cert
# + networking posture is set earlier by .env + bootstrap.sh; here we surface
# it and, for private mode, gate on the VPC prerequisites CodeBuild needs to
# pull plugin images — failing fast beats half-loading then 502/pull errors.
if [ "$TARGET" = "ec2" ]; then
  DEPLOY_MODE="${DEPLOY_MODE:-public}"
  echo "  Deploy mode: ${DEPLOY_MODE}"
  if [ "$DEPLOY_MODE" = "private" ]; then
    echo "  Internal (inside-AWS-only): CodeBuild is VPC-attached and pulls plugin images via the private gateway."
    _missing=()
    [ -n "${PIPELINE_VPC_ID:-}" ]    || _missing+=("PIPELINE_VPC_ID")
    [ -n "${PIPELINE_SUBNET_IDS:-}" ] || _missing+=("PIPELINE_SUBNET_IDS")
    if [ "${#_missing[@]}" -gt 0 ]; then
      echo "  ERROR: private mode requires these in .env: ${_missing[*]}" >&2
      echo "         (VPC + private subnets for the synthesized CodeBuild projects)" >&2
      echo "  Also confirm provisioned: VPC endpoints (S3,Logs,SecretsManager,KMS,STS,CodeBuild[,ECR])," >&2
      echo "  a Route53 PRIVATE zone for ${DOMAIN:-<domain>} -> the gateway private IP, and build egress (NAT/mirrors)." >&2
      exit 1
    fi
    echo "  VPC config present. (Ensure the VPC endpoints + private hosted zone above are actually in place.)"
  fi
fi
echo ""

# Up to 300s: the platform container's own healthcheck start_period is 180s.
wait_for_health 60 5

# Register admin user
echo ""
echo "=== Registering admin user ==="
# Non-interactive: take the admin credentials from the environment, falling back to
# the dev defaults when unset. Export PLATFORM_IDENTIFIER / PLATFORM_PASSWORD to
# override (always set them on a non-local/production target).
PLATFORM_IDENTIFIER="${PLATFORM_IDENTIFIER:-admin@internal}"
PLATFORM_PASSWORD="${PLATFORM_PASSWORD:-SecurePassword123!}"
# A non-local target reaching this with the well-known dev password means an
# internet-facing platform would ship with a public credential — warn loudly (don't fail,
# so automated deploys still complete). Set PLATFORM_PASSWORD to silence, or change it post-login.
if [ "$TARGET" != local ] && [ "$PLATFORM_PASSWORD" = 'SecurePassword123!' ]; then
  echo "  WARNING: registering the admin with the DEFAULT dev password on target '$TARGET'." >&2
  echo "           Set PLATFORM_PASSWORD (+ PLATFORM_IDENTIFIER) to a strong secret before exposing the platform, or change it immediately after first login." >&2
fi
REG_STATUS=$(curl -X POST "${PLATFORM_BASE_URL}/api/auth/register" \
  -k -s -o /dev/null -w "%{http_code}" \
  -H 'Content-Type: application/json' \
  -d "$(jq -n --arg email "$PLATFORM_IDENTIFIER" --arg pw "$PLATFORM_PASSWORD" \
    '{username: "admin", email: $email, password: $pw, organizationName: "system"}')")

case "$(classify_status "$REG_STATUS")" in
  ok)     echo "  Admin user created." ;;
  exists) echo "  Admin user already exists (HTTP $REG_STATUS) — continuing." ;;
  *)      echo "  Admin registration FAILED (HTTP $REG_STATUS) — platform not ready or erroring, not a conflict." >&2
          exit 1 ;;
esac

echo ""
echo "=== Logging in ==="
login

# Build + publish the CodeBuild bootstrap image (pipeline-bootstrap:1.0).
# Backs CODEBUILD_DEFAULT_IMAGE so cold-start synth runs against an image
# with pipeline-manager pre-installed, instead of paying ~30s for the
# npm install on every pipeline. Idempotent — push step skips when the
# tag is already in the registry library, so this is cheap to re-run.
# Independent of plugin loading: the runtime image is needed even when
# plugins aren't being uploaded (e.g. operator only refreshing services).
#
# Non-interactive runs (no TTY): skip by default. Set BUILD_BOOTSTRAP=true
# in CI env to opt in, BUILD_BOOTSTRAP=false to be explicit. Auto-running
# a docker build + registry push under set -e on a headless host wasn't
# what callers wanted.
echo ""
BUILD_BOOTSTRAP="${BUILD_BOOTSTRAP:-}"
if [ -z "$BUILD_BOOTSTRAP" ] && [ -t 0 ]; then
  printf "Build + publish CodeBuild bootstrap image (pipeline-bootstrap:1.0)? [Y/n] "
  read -r BUILD_BOOTSTRAP
  BUILD_BOOTSTRAP="${BUILD_BOOTSTRAP:-y}"
fi
case "$BUILD_BOOTSTRAP" in
  y|Y|yes|true) DEPLOY_TARGET="$TARGET" "$SCRIPT_DIR/build-codebuild-bootstrap.sh" ;;
  *)            echo "  Skipping CodeBuild bootstrap image." ;;
esac

# Gate a sample load on the backend services it actually talks to — beyond the
# platform readiness already waited for above. The plugin upload and pipeline
# bulk both validate via the compliance service, which can still be crash-
# looping on its own DB connection while the platform is already serving; without
# this gate the load races ahead and every item fails with opaque errors. Tunable
# via READY_MAX_RETRIES (default 60) / READY_INTERVAL (default 5s) = up to 5min.
gate_services_ready() {
  local _svc _failed=""
  for _svc in "$@"; do
    wait_for_service_ready "$_svc" "${READY_MAX_RETRIES:-60}" "${READY_INTERVAL:-5}" || _failed="${_failed} ${_svc}"
  done
  if [ -n "$_failed" ]; then
    echo "  ERROR: dependent service(s) not ready:${_failed}. Re-run this load once they are healthy." >&2
    return 1
  fi
  return 0
}

# Load plugins
echo ""
# Env-overridable (LOAD_PLUGINS=y|n) for non-interactive / automated runs (e.g.
# `pipeline-manager provision`); prompt only on a TTY when unset.
LOAD_PLUGINS="${LOAD_PLUGINS:-}"
if [ -z "$LOAD_PLUGINS" ] && [ -t 0 ]; then
  printf "Load plugins? [y/N] "
  read -r LOAD_PLUGINS
fi
LOAD_PLUGINS="${LOAD_PLUGINS:-n}"
if _truthy "$LOAD_PLUGINS"; then

  # ---- Plugin build strategy ----
  BUILD_STRATEGY="${PLUGIN_BUILD_STRATEGY:-}"
  if [ -z "$BUILD_STRATEGY" ] && [ -t 0 ]; then
    echo ""
    echo "  Plugin build strategy:"
    echo "    1) prebuilt     — Use pre-built images bundled as image.tar"
    echo "    2) build_image  — Build from Dockerfile at upload time (default)"
    echo ""
    printf "  Select [1/2] (default: 2): "
    read -r _strategy_choice
    case "$_strategy_choice" in
      1|prebuilt) BUILD_STRATEGY="prebuilt" ;;
      *)          BUILD_STRATEGY="build_image" ;;
    esac
  fi
  BUILD_STRATEGY="${BUILD_STRATEGY:-build_image}"

  # ---- Category selection ----
  SELECTED_CATEGORIES=""
  if [ -n "${PLUGIN_CATEGORY:-}" ]; then
    SELECTED_CATEGORIES="$PLUGIN_CATEGORY"
  elif [ -t 0 ]; then
    select_categories "$DEPLOY_DIR/plugins" || exit 0
  fi

  CATEGORY_ARG=""
  [ -n "$SELECTED_CATEGORIES" ] && CATEGORY_ARG="--category $SELECTED_CATEGORIES"

  # Base images must be present in the in-cluster registry for *both*
  # strategies — even build_image plugin Dockerfiles use bare
  # `FROM pipeline-plugin-base:24.04`, which buildkit resolves at
  # build-time via the registry mirror.
  #
  # Strategy selection:
  #   prebuilt    → full build-plugin-images.sh handles bases internally,
  #                 so we go straight to it (no --bases-only step).
  #   build_image → bases never get built by the full script (it only
  #                 builds per-plugin images), so we run --bases-only
  #                 to seed the registry before plugin uploads start.
  #
  # DEPLOY_TARGET is consumed by push-base-images.sh to pick the right
  # transport: local→docker-sidecar on backend-network, minikube/ec2→
  # crane-in-kubectl-run-pod inside the cluster.
  if [ "$BUILD_STRATEGY" = "prebuilt" ]; then
    echo ""
    BUILD_ARGS=""
    [ "${FORCE_REBUILD:-}" != "true" ] || BUILD_ARGS="$BUILD_ARGS --force"
    # The build script returns non-zero if any plugin failed to build. Under
    # `set -e` that aborts init entirely — typical case is one bad apt mirror
    # killing the whole bootstrap. With --continue-on-build-failure we log
    # and proceed; load-plugins will skip plugins lacking an image.tar.
    BUILD_RC=0
    # shellcheck disable=SC2086
    DEPLOY_TARGET="$TARGET" "$SCRIPT_DIR/build-plugin-images.sh" $BUILD_ARGS $CATEGORY_ARG || BUILD_RC=$?
    if [ "$BUILD_RC" -ne 0 ]; then
      if [ "$CONTINUE_ON_BUILD_FAILURE" = "true" ]; then
        echo "  WARNING: build-plugin-images exited $BUILD_RC — continuing per --continue-on-build-failure" >&2
      else
        echo "  ERROR: build-plugin-images exited $BUILD_RC. Re-run with --continue-on-build-failure to proceed with the plugins that did build." >&2
        exit "$BUILD_RC"
      fi
    fi
    echo ""
  elif [ "${BASES_PREBUILT:-false}" = "true" ]; then
    # build_image strategy, bases PREBUILT — trust the in-cluster registry already holds
    # the `FROM` bases (seeded out-of-band). Per-plugin images are still built at upload
    # time by the plugin service's buildkitd, which resolves them from the registry.
    # (No deploy target takes this path today; it is a manual escape hatch.)
    # sidecar — BASE_BUILDER=buildkit — and leaves BASES_PREBUILT unset.)
    echo ""
    echo "  Base images: PREBUILT (BASES_PREBUILT=true) — skipping the base build; trusting the registry."
    echo ""
  else
    # build_image strategy — seed the in-cluster registry with base
    # images, since the per-plugin build step is skipped on this path
    # but plugin Dockerfiles still reference the bases.
    echo ""
    BASES_ARGS="--bases-only"
    # FORCE_REBUILD must still force a rebuild of the base images on this
    # (now-default) path, mirroring the prebuilt branch above.
    [ "${FORCE_REBUILD:-}" != "true" ] || BASES_ARGS="$BASES_ARGS --force"
    # shellcheck disable=SC2086
    DEPLOY_TARGET="$TARGET" "$SCRIPT_DIR/build-plugin-images.sh" $BASES_ARGS
    echo ""
  fi

  # Re-authenticate before upload (token may have expired during prebuilt image builds)
  echo ""
  echo "=== Refreshing auth token ==="
  login

  CLEANUP_ARG=""
  [ "$CLEANUP_AFTER_UPLOAD" = true ] && CLEANUP_ARG="--cleanup"

  # The upload validates each plugin via compliance — wait for both the plugin
  # and compliance services before starting, so the upload doesn't race a
  # still-starting compliance service.
  gate_services_ready compliance plugin || exit 1

  # shellcheck disable=SC2086
  PLATFORM_BASE_URL="$PLATFORM_BASE_URL" \
    PLATFORM_TOKEN="$JWT_TOKEN" \
    SKIP_MISSING_IMAGE_TAR="$CONTINUE_ON_BUILD_FAILURE" \
    "$SCRIPT_DIR/load-plugins.sh" --rebuild $CATEGORY_ARG $CLEANUP_ARG
else
  echo "  Skipping plugin loading."
fi

# Load pipelines
echo ""
# Env-overridable (LOAD_PIPELINES=y|n) for non-interactive runs; prompt on a TTY when unset.
LOAD_PIPELINES="${LOAD_PIPELINES:-}"
if [ -z "$LOAD_PIPELINES" ] && [ -t 0 ]; then
  printf "Load sample pipelines? [y/N] "
  read -r LOAD_PIPELINES
fi
LOAD_PIPELINES="${LOAD_PIPELINES:-n}"
if _truthy "$LOAD_PIPELINES"; then
  # The pipeline bulk-create validates each item via compliance — wait for both
  # services so the load doesn't race a still-starting compliance service (the
  # failure that motivated this gate).
  gate_services_ready compliance pipeline || exit 1
  PLATFORM_BASE_URL="$PLATFORM_BASE_URL" PLATFORM_TOKEN="$JWT_TOKEN" "$SCRIPT_DIR/load-pipelines.sh"
else
  echo "  Skipping pipeline loading."
fi

# Load compliance rules and policy templates
echo ""
# Env-overridable (LOAD_COMPLIANCE=y|n) for non-interactive runs; prompt on a TTY when unset.
LOAD_COMPLIANCE="${LOAD_COMPLIANCE:-}"
if [ -z "$LOAD_COMPLIANCE" ] && [ -t 0 ]; then
  printf "Load sample compliance rules and policy templates? [y/N] "
  read -r LOAD_COMPLIANCE
fi
LOAD_COMPLIANCE="${LOAD_COMPLIANCE:-n}"
if _truthy "$LOAD_COMPLIANCE"; then
  # load-compliance talks straight to the compliance service — wait for it.
  gate_services_ready compliance || exit 1
  PLATFORM_BASE_URL="$PLATFORM_BASE_URL" PLATFORM_TOKEN="$JWT_TOKEN" "$SCRIPT_DIR/load-compliance.sh"
else
  echo "  Skipping compliance loading."
fi

# Default observability dashboards are seeded automatically by the platform
# service's in-process seeder on every cold start (it writes org_id='system'
# rows directly, needs no auth, and is idempotent by `(orgId='system', name)`).
# No separate load step is required here.

echo ""
echo "=== Initialization complete ==="
