#!/usr/bin/env bash
# Copyright 2026 Pipeline Builder Contributors
# SPDX-License-Identifier: Apache-2.0
#
# Compose smoke: the BUILT pipeline-manager CLI against a REAL platform booted
# from deploy/local/docker. Run nightly by .github/workflows/nightly-smoke.yml
# (generated from projenrc/workflow.ts); runnable locally, one phase at a time:
#
#   compose-smoke.sh up      # setup.sh (keys, .env, `compose up -d`) + wait for /ready
#   compose-smoke.sh init    # init-platform.sh docker: admin + the managed toolchain release
#   compose-smoke.sh run     # device-flow login, status, pipeline create, pipeline synth
#   compose-smoke.sh logs    # collect compose + CLI logs into $SMOKE_DIR/logs
#   compose-smoke.sh down    # tear down — ONLY a stack this script started
#   compose-smoke.sh all     # up → init → run, logs on failure, always down
#
# The CLI must be built first (`pnpm nx run @pipeline-builder/pipeline-manager:post-compile`).
#
# LOGIN is the real `auth login` device flow, made non-interactive: the CLI is
# started with --no-browser, and the script plays the browser — it registers a
# throwaway user in its own org, signs that user in with a password, earns a
# step-up token and approves the printed user code (POST /auth/device/approve).
# The bootstrap admin is deliberately NOT used for this: its MFA-exception
# session only reaches enrolment and init's setup calls, so the platform
# refuses it on /auth/device/approve and on every other service.
#
# Needs no secrets: the service images are public and every credential is
# generated on the runner. Knobs (all optional):
#   SMOKE_DIR                   work dir (default: a fresh mktemp -d); logs land in $SMOKE_DIR/logs
#   SMOKE_SKIP_SYNTH=true       skip `init` and the synth (no toolchain build — ~5 min instead of ~40)
#   SMOKE_ALLOW_EXISTING_STACK=true  run against an already-provisioned deploy/local/docker
#                               (then `down` leaves it running and its data untouched)
#   PLATFORM_BASE_URL           default https://localhost:8443

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../../.." && pwd)"
DOCKER_DIR="$REPO_ROOT/deploy/local/docker"
CLI_JS="$REPO_ROOT/packages/pipeline-manager/dist/cli.js"
# Inside the (gitignored) data dir, so it goes when the data does.
OWNED_MARKER="$DOCKER_DIR/data/.compose-smoke-owned"

export PLATFORM_BASE_URL="${PLATFORM_BASE_URL:-https://localhost:8443}"
SMOKE_DIR="${SMOKE_DIR:-$(mktemp -d "${TMPDIR:-/tmp}/pm-compose-smoke.XXXXXX")}"
SMOKE_SKIP_SYNTH="${SMOKE_SKIP_SYNTH:-false}"
LOG_DIR="$SMOKE_DIR/logs"
SMOKE_HOME="$SMOKE_DIR/home"     # the CLI's HOME: its credential store lives here, never in yours
mkdir -p "$LOG_DIR" "$SMOKE_HOME"

say() { printf '\n=== %s ===\n' "$*"; }
# Hide a generated secret from the Actions log (a no-op anywhere else).
mask() { [ -z "${GITHUB_ACTIONS:-}" ] || echo "::add-mask::$1"; }
die() { echo "::error::compose-smoke: $*" >&2; exit 1; }
compose() { (cd "$DOCKER_DIR" && docker compose "$@"); }

# The CLI with an isolated HOME and the stack's dev CA trusted — verified TLS,
# not --no-verify-ssl. PLATFORM_CA_BUNDLE carries the PEM TEXT (pipeline-core
# platform-tls), and dev-ca.crt is the CA that issued the gateway's leaf.
cli() {
  HOME="$SMOKE_HOME" PLATFORM_CA_BUNDLE="$(cat "$DOCKER_DIR/certs/dev-ca.crt")" NO_COLOR=1 CI=true \
    node "$CLI_JS" "$@"
}

wait_ready() {
  local i
  for i in $(seq 1 90); do
    if [ "$(curl -sk -o /dev/null -w '%{http_code}' "$PLATFORM_BASE_URL/ready" || true)" = 200 ]; then
      echo "platform ready after ~$((i * 5))s"; return 0
    fi
    sleep 5
  done
  die "platform not ready at $PLATFORM_BASE_URL/ready after 450s"
}

phase_up() {
  if [ -d "$DOCKER_DIR/data" ] && [ "${SMOKE_ALLOW_EXISTING_STACK:-false}" != true ]; then
    die "$DOCKER_DIR/data exists — a local stack is already provisioned. Set SMOKE_ALLOW_EXISTING_STACK=true to smoke-test it (it is then left running), or wipe it first."
  fi
  # Claim the stack BEFORE booting it, so a bring-up that dies half-way is
  # still torn down by `down`.
  if [ ! -d "$DOCKER_DIR/data" ]; then mkdir -p "$DOCKER_DIR/data" && touch "$OWNED_MARKER"; fi
  say "Booting deploy/local/docker (setup.sh)"
  bash "$DOCKER_DIR/bin/setup.sh"
  wait_ready
}

phase_init() {
  if [ "$SMOKE_SKIP_SYNTH" = true ]; then echo "SMOKE_SKIP_SYNTH=true — skipping init-platform (no toolchain release)"; return 0; fi
  say "init-platform.sh docker (admin + managed toolchain release; catalog loads off)"
  LOAD_PLUGINS=n LOAD_TEMPLATES=n LOAD_COMPLIANCE=n \
    bash "$REPO_ROOT/deploy/bin/init-platform.sh" docker </dev/null
}

json_post() { # url body [extra curl args…] → body on stdout
  local url="$1" body="$2"; shift 2
  curl -sk --max-time 60 -X POST "$url" -H 'Content-Type: application/json' "$@" --data-binary @- <<<"$body"
}

phase_run() {
  [ -f "$CLI_JS" ] || die "$CLI_JS not found — build the CLI first (pnpm nx run @pipeline-builder/pipeline-manager:post-compile)"
  local stamp email password org jwt step_up code login_pid i status_json pipeline_id out_dir
  stamp="$(date +%s)"
  email="smoke-${stamp}@smoke.invalid"
  org="smoke-${stamp}"
  password="Smk-$(openssl rand -hex 16)-Aa1!"
  mask "$password"

  say "Register a throwaway user ($email, org $org)"
  json_post "$PLATFORM_BASE_URL/api/auth/register" \
    "$(PB_PW="$password" jq -n --arg e "$email" --arg o "$org" '{username: ("smoke" + ($o | ltrimstr("smoke-"))), email: $e, password: env.PB_PW, organizationName: $o}')" \
    -o "$LOG_DIR/register.json" -w '%{http_code}\n' | grep -qE '^20[01]$' || { cat "$LOG_DIR/register.json" >&2; die "register failed"; }

  say "auth login — the real device flow (--no-browser)"
  cli auth login --url "$PLATFORM_BASE_URL" --no-browser >"$LOG_DIR/login.out" 2>&1 &
  login_pid=$!
  code=""
  for i in $(seq 1 30); do
    code="$(sed -n 's/.*Your code:[[:space:]]*\([A-Z0-9-]*\).*/\1/p' "$LOG_DIR/login.out" | head -1)"
    [ -n "$code" ] && break
    kill -0 "$login_pid" 2>/dev/null || break
    sleep 1
  done
  [ -n "$code" ] || { cat "$LOG_DIR/login.out" >&2; die "auth login printed no user code"; }
  echo "user code: $code"

  # The browser's half: sign in, step up, approve the code.
  jwt="$(json_post "$PLATFORM_BASE_URL/api/auth/login" "$(PB_PW="$password" jq -n --arg id "$email" '{identifier: $id, password: env.PB_PW}')" | jq -r '.data.accessToken // empty')"
  [ -n "$jwt" ] || die "password sign-in for the smoke user failed"
  mask "$jwt"
  step_up="$(json_post "$PLATFORM_BASE_URL/api/auth/step-up" "$(PB_PW="$password" jq -n '{password: env.PB_PW}')" -H "Authorization: Bearer $jwt" | jq -r '.data.stepUpToken // empty')"
  [ -n "$step_up" ] || die "step-up for the smoke user failed"
  json_post "$PLATFORM_BASE_URL/api/auth/device/approve" "$(jq -n --arg c "$code" '{userCode: $c}')" \
    -H "Authorization: Bearer $jwt" -H "X-Step-Up-Token: $step_up" -o "$LOG_DIR/approve.json" -w '%{http_code}\n' \
    | grep -qE '^20[0-9]$' || { cat "$LOG_DIR/approve.json" >&2; kill "$login_pid" 2>/dev/null || true; die "device approval was refused"; }

  wait "$login_pid" || { cat "$LOG_DIR/login.out" >&2; die "auth login exited non-zero after approval"; }
  grep -q 'Signed in' "$LOG_DIR/login.out" || die "auth login did not report 'Signed in'"
  jq -e --arg u "$PLATFORM_BASE_URL" '.activePlatform == $u and (.sessions | length) == 1 and ([.sessions[]][0].refreshToken | length) > 0' \
    "$SMOKE_HOME/.pipeline-manager/credentials.json" >/dev/null || die "credentials.json does not hold the new session"
  echo "signed in; session stored under the smoke HOME"

  say "status --json"
  status_json="$(cli status --json 2>"$LOG_DIR/status.err")"
  printf '%s\n' "$status_json" >"$LOG_DIR/status.json"
  jq -e --arg e "$email" '.["Signed In"] == "yes" and .["Signed In As"] == $e and .["Platform Health"] == "reachable"' \
    <<<"$status_json" >/dev/null || { cat "$LOG_DIR/status.json" "$LOG_DIR/status.err" >&2; die "status does not report a signed-in session"; }

  if [ "$SMOKE_SKIP_SYNTH" = true ]; then echo "SMOKE_SKIP_SYNTH=true — skipping pipeline create/synth"; return 0; fi

  say "pipeline create (sample props)"
  jq -n --arg o "$org" '{project: "smoke", organization: $o,
      synth: {source: {type: "github", options: {repo: "acme/smoke", branch: "main"}}, plugin: {name: "cdk-synth"}}}' \
    >"$SMOKE_DIR/props.json"
  (cd "$SMOKE_DIR" && cli pipeline create -f props.json) >"$LOG_DIR/create.out" 2>&1 || { cat "$LOG_DIR/create.out" >&2; die "pipeline create failed"; }
  pipeline_id="$(ls "$SMOKE_DIR/output" | sed -n 's/^pipeline-\(.*\)\.json$/\1/p' | head -1)"
  [ -n "$pipeline_id" ] || die "pipeline create wrote no output/pipeline-<id>.json"
  echo "pipeline: $pipeline_id"

  say "pipeline synth (the toolchain release's CDK CLI)"
  local cdk_version
  cdk_version="$(yq -r '.toolchain.awsCdk' "$REPO_ROOT/deploy/toolchain/pipeline-bootstrap/plugin-spec.yaml")"
  npm install --silent --no-audit --no-fund --prefix "$SMOKE_DIR/tools" "aws-cdk@$cdk_version" >/dev/null
  out_dir="$SMOKE_DIR/cdk.out"
  # Nothing pulls an image here (no CodeBuild runs), but the synth refuses a
  # localhost pull host on principle — name a public-looking one.
  PATH="$SMOKE_DIR/tools/node_modules/.bin:$PATH" IMAGE_REGISTRY_PULL_HOST=registry.smoke.invalid \
    cli pipeline synth --id "$pipeline_id" --output "$out_dir" --quiet --no-notices >"$LOG_DIR/synth.out" 2>&1 \
    || { tail -100 "$LOG_DIR/synth.out" >&2; die "pipeline synth failed"; }
  [ -f "$out_dir/manifest.json" ] || die "synth wrote no cloud assembly"
  ls "$out_dir"/*.template.json >/dev/null 2>&1 || die "synth wrote no CloudFormation template"
  jq -e '[.Resources[] | select(.Type == "AWS::CodePipeline::Pipeline")] | length == 1' "$out_dir"/*.template.json >/dev/null \
    || die "the synthesized template has no CodePipeline"
  echo "synth OK: $(ls "$out_dir")"
}

phase_logs() {
  say "Collecting logs into $LOG_DIR"
  compose ps -a >"$LOG_DIR/compose-ps.txt" 2>&1 || true
  compose logs --no-color --timestamps >"$LOG_DIR/compose.log" 2>&1 || true
  local svc
  for svc in $(compose ps -a --services 2>/dev/null || true); do
    compose logs --no-color --timestamps "$svc" >"$LOG_DIR/service-$svc.log" 2>&1 || true
  done
}

phase_down() {
  if [ ! -f "$OWNED_MARKER" ]; then
    echo "The stack was not started by compose-smoke — leaving it running."
    return 0
  fi
  say "Tearing down (containers, volumes, data)"
  compose down -v --remove-orphans || true
  # The bind-mounted ./data is written by container users (often root), so
  # remove it from a container. .env, certs/ and the keyfile are KEPT: they may
  # predate this run, and setup.sh reuses them idempotently.
  docker run --rm -v "$DOCKER_DIR:/stack" alpine:3.22 rm -rf /stack/data || rm -rf "$DOCKER_DIR/data" || true
}

case "${1:-all}" in
  up) phase_up ;;
  init) phase_init ;;
  run) phase_run ;;
  logs) phase_logs ;;
  down) phase_down ;;
  all)
    trap 'rc=$?; [ "$rc" -eq 0 ] || phase_logs; phase_down; exit "$rc"' EXIT
    phase_up; phase_init; phase_run
    say "compose smoke PASSED (logs: $LOG_DIR)" ;;
  *) echo "usage: $0 [up|init|run|logs|down|all]" >&2; exit 2 ;;
esac
