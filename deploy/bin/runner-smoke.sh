#!/usr/bin/env bash
# Copyright 2026 Pipeline Builder Contributors
# SPDX-License-Identifier: Apache-2.0
#
# Two-account smoke test for the pipeline runner, the platform's only execution
# path. An OPERATOR script, run by hand: it installs a real runner in a real
# target account and drives a real pipeline through it, end to end.
#
#   PLATFORM_TOKEN=... deploy/bin/runner-smoke.sh \
#     --platform-url https://platform.example --profile target-account \
#     --region us-east-1 --pipeline-id <platform pipeline id> [options]
#
#   --platform-url <url>     the platform (https; http only for localhost)
#   --profile <name>         AWS profile for the TARGET account (where the pipeline lives)
#   --region <region>        region for the runner stack
#   --pipeline-id <id>       a platform pipeline deployed in that account
#   --label <label>          runner label (default: smoke); the stack is pipeline-builder-runner-<runnerId>
#   --regions <csv>          passed to setup-runner (default: the stack region)
#   --pipeline-prefix <csv>  passed to setup-runner (default: derived from the org's pipelines)
#   --step-up <method>       passed to setup-runner (default: auto; set PLATFORM_PASSWORD for password)
#   --stop                   stop the execution the Re-run started, and wait for `stopped`
#   --teardown               finally run `setup-runner --delete` (revoke, then delete the stack)
#   --timeout <seconds>      how long to wait for each run request (default: 300)
#
# Steps (each prints PASS or FAIL; the FIRST failure exits non-zero and nothing
# after it runs — a failed install is never followed by a Re-run or a delete):
#   1. dry run        `setup-runner --dry-run --json` (no AWS or platform call)
#   2. install        `setup-runner --json` (register, deploy, send the endpoint)
#   3. runner active  GET /api/pipelines/runners shows this label active
#   4. signing key    the same list's `signingKey` names the org's active key id
#                     (its own, or the ancestor's it inherits); registering the
#                     org's first runner creates it, so none is a failure
#   5. runner jwks    the runner's OWN public JWKS,
#                     GET /api/pipelines/runner/runners/<runnerId>/jwks.json
#                     (no token sent), publishes that key id and no private
#                     key member
#   6. re-run queued  POST /api/pipelines/<id>/executions answers 202 with a requestId
#   7. execution started  the run request reaches `started` with an execution id
#   8. stop (--stop)  POST .../executions/<executionId>/stop, then `stopped`
#   9. teardown (--teardown)  `setup-runner --delete`
#
# Runners are on for every org (no feature flag) and every Run/Stop answers a
# queued run request, so a 409 NO_RUNNER / RUNNER_KEY_* answer is a failure
# with the platform's message relayed.
#
# SECRETS. The platform token comes from PLATFORM_TOKEN (or PLATFORM_TOKEN_FILE)
# and never from a flag: argv is visible to every user on the host through ps.
# It reaches curl through a config on STDIN (`-K -`), never an -H argument. The
# runner's endpoint URL (in the runners list, and in setup-runner's own output)
# is read into a 0600 temp file only, never printed; every line this script
# relays is passed through `_redact`, which masks the token and any Lambda
# Function URL / API Gateway host. Never debug this script with shell tracing
# (xtrace): it would print the token.
#
# Env: PLATFORM_TOKEN | PLATFORM_TOKEN_FILE, PLATFORM_PASSWORD (step-up),
# RUNNER_SMOKE_PM (default `pipeline-manager`; e.g. `node packages/pipeline-manager/dist/index.js`),
# RUNNER_SMOKE_POLL_SECONDS (default 5).

set -euo pipefail

usage() { sed -n '9,23p' "$0" | sed 's/^# \{0,1\}//' >&2; exit 2; }

PLATFORM_URL='' PROFILE='' REGION='' PIPELINE_ID='' LABEL='smoke' REGIONS='' PREFIX='' STEP_UP='auto'
DO_STOP=false TEARDOWN=false TIMEOUT=300
while [ "$#" -gt 0 ]; do
  case "$1" in
    --platform-url)    PLATFORM_URL="${2:?--platform-url needs a value}"; shift 2 ;;
    --profile)         PROFILE="${2:?--profile needs a value}"; shift 2 ;;
    --region)          REGION="${2:?--region needs a value}"; shift 2 ;;
    --pipeline-id)     PIPELINE_ID="${2:?--pipeline-id needs a value}"; shift 2 ;;
    --label)           LABEL="${2:?--label needs a value}"; shift 2 ;;
    --regions)         REGIONS="${2:?--regions needs a value}"; shift 2 ;;
    --pipeline-prefix) PREFIX="${2:?--pipeline-prefix needs a value}"; shift 2 ;;
    --step-up)         STEP_UP="${2:?--step-up needs a value}"; shift 2 ;;
    --timeout)         TIMEOUT="${2:?--timeout needs a value}"; shift 2 ;;
    --stop)            DO_STOP=true; shift ;;
    --teardown)        TEARDOWN=true; shift ;;
    -h|--help)         usage ;;
    # Deliberately no --token: see SECRETS above.
    *) echo "ERROR: unknown argument '$1' (the token is read from PLATFORM_TOKEN, never a flag)" >&2; exit 2 ;;
  esac
done

die() { echo "ERROR: $1" >&2; exit 2; }
[ -n "$PLATFORM_URL" ] && [ -n "$PROFILE" ] && [ -n "$REGION" ] && [ -n "$PIPELINE_ID" ] \
  || die "--platform-url, --profile, --region and --pipeline-id are required (--help)"
case "$PLATFORM_URL" in
  https://*|http://localhost*|http://127.0.0.1*) PLATFORM_URL="${PLATFORM_URL%/}" ;;
  *) die "--platform-url must be https:// (http only for localhost)" ;;
esac
[[ "$PROFILE" =~ ^[A-Za-z0-9._-]{1,64}$ ]] || die "--profile is not a profile name"
[[ "$REGION" =~ ^[a-z]{2}(-[a-z]+)+-[0-9]{1,2}$ ]] || die "--region is not an AWS region"
[[ "$PIPELINE_ID" =~ ^[A-Za-z0-9-]{1,64}$ ]] || die "--pipeline-id is not a pipeline id"
[[ "$LABEL" =~ ^[a-z0-9][a-z0-9-]{0,31}$ ]] || die "--label must be 1-32 lowercase letters, digits or '-'"
[[ "$TIMEOUT" =~ ^[0-9]{1,5}$ ]] || die "--timeout is a number of seconds"
[[ "$STEP_UP" =~ ^(auto|password|totp|browser)$ ]] || die "--step-up is auto, password, totp or browser"

if [ -z "${PLATFORM_TOKEN:-}" ] && [ -n "${PLATFORM_TOKEN_FILE:-}" ]; then
  [ -r "$PLATFORM_TOKEN_FILE" ] || die "PLATFORM_TOKEN_FILE is not readable"
  PLATFORM_TOKEN="$(tr -d '\r\n' < "$PLATFORM_TOKEN_FILE")"
fi
[ -n "${PLATFORM_TOKEN:-}" ] || die "set PLATFORM_TOKEN (or PLATFORM_TOKEN_FILE) to a platform token of an org admin"
case "$PLATFORM_TOKEN" in *[[:space:]\"\\]*) die "PLATFORM_TOKEN contains whitespace, a quote or a backslash" ;; esac
# pipeline-manager reads both from the environment (never from its argv).
export PLATFORM_TOKEN PLATFORM_BASE_URL="$PLATFORM_URL"

for tool in curl jq awk; do command -v "$tool" >/dev/null 2>&1 || die "$tool is required"; done
# Word-split on purpose: RUNNER_SMOKE_PM may be a command prefix.
# shellcheck disable=SC2206
PM=(${RUNNER_SMOKE_PM:-pipeline-manager})
command -v "${PM[0]}" >/dev/null 2>&1 || die "${PM[0]} not found (set RUNNER_SMOKE_PM)"
POLL="${RUNNER_SMOKE_POLL_SECONDS:-5}"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/runner-smoke.XXXXXX")"
chmod 700 "$WORK"
trap 'rm -rf "$WORK"' EXIT
umask 077

# Mask the token and any runner endpoint in a stream. The token is read from the
# environment inside awk, so it is never an argument of any process.
_redact() {
  awk 'BEGIN { t = ENVIRON["PLATFORM_TOKEN"] }
  {
    line = $0
    if (t != "") { while ((i = index(line, t)) > 0) line = substr(line, 1, i - 1) "<token>" substr(line, i + length(t)) }
    gsub(/[A-Za-z0-9.-]*\.lambda-url\.[A-Za-z0-9.-]+[A-Za-z0-9\/._-]*/, "<runner-endpoint>", line)
    gsub(/[A-Za-z0-9.-]*\.execute-api\.[A-Za-z0-9.-]+[A-Za-z0-9\/._-]*/, "<runner-endpoint>", line)
    print line
  }'
}

STEP=0
pass() { STEP=$((STEP + 1)); echo "  PASS  $1"; }
fail() {
  echo "  FAIL  $1" >&2
  [ "$#" -lt 2 ] || printf '%s\n' "$2" | _redact | sed 's/^/        /' >&2
  if [ "$TEARDOWN" = true ] && [ "$STEP" -ge 2 ]; then
    echo "        --teardown did NOT run (stopped at the first failure). Remove the runner with:" >&2
    echo "        pipeline-manager infra setup-runner --region $REGION --label $LABEL --profile $PROFILE --delete" >&2
  fi
  exit 1
}

# _api <METHOD> <path> [json-body] — the HTTP status on stdout, the body in $WORK/body.
_api() {
  local method="$1" path="$2" data="${3:-}" args
  args=(-sS --max-time 30 -o "$WORK/body" -w '%{http_code}' -X "$method" -K -)
  if [ -n "$data" ]; then
    printf '%s' "$data" > "$WORK/req.json"
    args+=(-H 'Content-Type: application/json' --data-binary "@$WORK/req.json")
  fi
  : > "$WORK/body"
  local code
  code="$(printf 'header = "Authorization: Bearer %s"\n' "$PLATFORM_TOKEN" \
    | curl "${args[@]}" "$PLATFORM_URL$path" 2>"$WORK/curl.err")" || code=000
  printf '%s' "${code:-000}"
}

# _jwks — the runner's public JWKS, fetched WITHOUT the token (the route is
# public, and a runner fetches it with no credential at all); the HTTP status on
# stdout, the body in $WORK/jwks. The empty config on stdin keeps curl's
# invocation the same shape as _api's.
_jwks() {
  local code
  : > "$WORK/jwks"
  code="$(printf '' | curl -sS --max-time 30 -o "$WORK/jwks" -w '%{http_code}' -X GET -K - \
    "$PLATFORM_URL/api/pipelines/runner/runners/$RUNNER_ID/jwks.json" 2>"$WORK/curl.err")" || code=000
  printf '%s' "${code:-000}"
}

# _setup_runner <args...> — setup-runner with this run's target; JSON in $WORK/pm.json.
_setup_runner() {
  local extra=()
  [ -z "$REGIONS" ] || extra+=(--regions "$REGIONS")
  [ -z "$PREFIX" ] || extra+=(--pipeline-prefix "$PREFIX")
  "${PM[@]}" infra setup-runner --region "$REGION" --label "$LABEL" --profile "$PROFILE" \
    ${extra[@]+"${extra[@]}"} "$@" --json > "$WORK/pm.json" 2> >(_redact >&2)
}

# _wait_request <want-status> — poll the run request until it reaches <want-status>.
_wait_request() {
  local want="$1" deadline code st exec err
  deadline=$(( $(date +%s) + TIMEOUT ))
  while :; do
    code="$(_api GET "/api/pipelines/$PIPELINE_ID/run-requests/$REQUEST_ID")"
    [ "$code" = 200 ] || return 3
    st="$(jq -r '.data.status // empty' "$WORK/body")"
    exec="$(jq -r '.data.executionId // empty' "$WORK/body")"
    err="$(jq -r '.data.errorCode // empty' "$WORK/body")"
    LAST_STATUS="$st${err:+ ($err)}"
    case "$st" in
      "$want")
        [ "$want" != started ] || [ -n "$exec" ] || return 1
        [ -z "$exec" ] || EXECUTION_ID="$exec"
        return 0 ;;
      failed|expired|stopped|started) return 1 ;;
    esac
    [ "$(date +%s)" -lt "$deadline" ] || return 2
    sleep "$POLL"
  done
}

echo ""
echo "=== Runner smoke test: label $LABEL, region $REGION, pipeline $PIPELINE_ID ==="

# ---- 1. dry run --------------------------------------------------------------
_setup_runner --dry-run || fail "dry run — setup-runner --dry-run exited non-zero"
[ "$(jq -r '.success == true and .dryRun == true' "$WORK/pm.json" 2>/dev/null)" = true ] \
  || fail "dry run — no dry-run plan in setup-runner's output"
pass "dry run — plan for $(jq -r '.stackName // "?"' "$WORK/pm.json")"

# ---- 2. install --------------------------------------------------------------
_setup_runner --step-up "$STEP_UP" || fail "install — setup-runner exited non-zero (see its messages above)"
[ "$(jq -r '.success == true' "$WORK/pm.json" 2>/dev/null)" = true ] || fail "install — setup-runner reported no success"
RUNNER_ID="$(jq -r '.runnerId // empty' "$WORK/pm.json")"
[[ "$RUNNER_ID" =~ ^[A-Za-z0-9-]{1,64}$ ]] || fail "install — setup-runner returned no runner id"
pass "install — runner $RUNNER_ID $(jq -r '.action // "installed"' "$WORK/pm.json")"

# ---- 3. runner active --------------------------------------------------------
# The runners list carries the endpoint URL: it stays in $WORK/body and only the
# status/health fields are ever read out of it.
STATUS='' HEALTH=''
for _ in $(seq 1 12); do
  code="$(_api GET /api/pipelines/runners)"
  [ "$code" = 200 ] || fail "runner active — GET /api/pipelines/runners answered HTTP $code"
  STATUS="$(jq -r --arg id "$RUNNER_ID" '.data.own[]? | select(.id == $id) | .status' "$WORK/body")"
  HEALTH="$(jq -r --arg id "$RUNNER_ID" '.data.own[]? | select(.id == $id) | .health' "$WORK/body")"
  [ "$STATUS" != active ] || break
  sleep "$POLL"
done
[ "$STATUS" = active ] || fail "runner active — runner $RUNNER_ID is '${STATUS:-missing}' on the platform (expected active)"
[ "$HEALTH" != unreachable ] || fail "runner active — runner $RUNNER_ID is active but unreachable"
pass "runner active — $RUNNER_ID active, ${HEALTH:-healthy}"

# ---- 4. signing key ----------------------------------------------------------
# Key ids and dates only: the list never carries key material.
KID="$(jq -r '.data.signingKey // {} | (.active.kid // .inheritedFrom.activeKid // empty)' "$WORK/body")"
[[ "$KID" =~ ^[A-Za-z0-9_-]{8,64}$ ]] \
  || fail "signing key — the org has no active runner signing key (it is created with the org's first runner; or generate one in Settings -> Pipeline runners)"
if [ "$(jq -r '.data.signingKey.unreadable // false' "$WORK/body")" = true ]; then
  fail "signing key — the org's signing key can't be read (RUNNER_KEY_UNREADABLE); see docs/runbooks/secret-rotation.md"
fi
pass "signing key — active key $KID"

# ---- 5. runner jwks ----------------------------------------------------------
code="$(_jwks)"
[ "$code" = 200 ] || fail "runner jwks — GET /api/pipelines/runner/runners/$RUNNER_ID/jwks.json answered HTTP $code"
[ "$(jq -r '[.keys[]? | has("d") or has("p") or has("q")] | any' "$WORK/jwks" 2>/dev/null)" = false ] \
  || fail "runner jwks — the JWKS carries a private key member"
[ "$(jq -r --arg kid "$KID" '[.keys[]? | select(.kid == $kid and .kty == "OKP" and .crv == "Ed25519")] | length' "$WORK/jwks" 2>/dev/null)" = 1 ] \
  || fail "runner jwks — the runner's JWKS does not publish the active key $KID"
pass "runner jwks — $(jq -r '.keys | length' "$WORK/jwks") key(s), active $KID published"

# ---- 6. re-run ---------------------------------------------------------------
code="$(_api POST "/api/pipelines/$PIPELINE_ID/executions" '{}')"
[ "$code" = 202 ] || fail "re-run queued — POST executions answered HTTP $code" "$(jq -r '.message // .error.message // empty' "$WORK/body" 2>/dev/null)"
REQUEST_ID="$(jq -r '.data.requestId // empty' "$WORK/body")"
[ -n "$REQUEST_ID" ] || fail "re-run queued — the 202 carried no run request id"
pass "re-run queued — request $REQUEST_ID"

# ---- 7. started --------------------------------------------------------------
LAST_STATUS='' EXECUTION_ID=''
if _wait_request started; then
  pass "execution started — execution $EXECUTION_ID"
else
  rc=$?
  case "$rc" in
    2) fail "execution started — still '${LAST_STATUS:-queued}' after ${TIMEOUT}s" ;;
    3) fail "execution started — could not read run request $REQUEST_ID" ;;
    *) fail "execution started — the run request ended '${LAST_STATUS:-unknown}'" ;;
  esac
fi

# ---- 8. stop (optional) ------------------------------------------------------
if [ "$DO_STOP" = true ]; then
  code="$(_api POST "/api/pipelines/$PIPELINE_ID/executions/$EXECUTION_ID/stop" '{"reason":"runner smoke test"}')"
  [ "$code" = 202 ] || fail "stop — POST stop answered HTTP $code" "$(jq -r '.message // .error.message // empty' "$WORK/body" 2>/dev/null)"
  REQUEST_ID="$(jq -r '.data.requestId // empty' "$WORK/body")"
  [ -n "$REQUEST_ID" ] || fail "stop — the 202 carried no run request id"
  if _wait_request stopped; then
    pass "stop — execution $EXECUTION_ID stopped"
  else
    fail "stop — the stop request ended '${LAST_STATUS:-unknown}' (or timed out after ${TIMEOUT}s)"
  fi
fi

# ---- 9. teardown (optional) --------------------------------------------------
if [ "$TEARDOWN" = true ]; then
  _setup_runner --delete --step-up "$STEP_UP" || fail "teardown — setup-runner --delete exited non-zero"
  [ "$(jq -r '.action // empty' "$WORK/pm.json")" = deleted ] || fail "teardown — setup-runner --delete reported no deletion"
  pass "teardown — runner revoked, stack deleted"
fi

echo "  runner smoke: all $STEP step(s) passed"
