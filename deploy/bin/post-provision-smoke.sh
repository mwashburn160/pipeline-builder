#!/usr/bin/env bash
# Copyright 2026 Pipeline Builder Contributors
# SPDX-License-Identifier: Apache-2.0
#
# Post-provision smoke checks — the paths that fail SILENTLY after a deploy that
# otherwise looks green. Every target's setup runs this as its final phase.
#
#   post-provision-smoke.sh <k8s|docker> [--aws]
#
#   k8s     exec into the target's Deployments (NAMESPACE, default pipeline-builder)
#   docker  exec into the compose containers
#   --aws   also dry-run the pipeline service's CodePipeline credentials (eks/ec2)
#
# Checks (each prints PASS / WARN / SKIP with the reason; NONE is fatal — the
# deploy has already happened, and a half-failed smoke run must not abort the
# rest of a setup script. The summary line is what to read):
#   1. alert delivery — posts a synthetic warning alert INTO Alertmanager and
#      watches alertmanager_notifications_{total,failed_total}{integration="slack"}
#      move. This exercises the real route, the Slack Secret and the pod's egress
#      NetworkPolicy — not a curl from this host, which proves none of those.
#   2. email — sends one message through platform's own email service (its own
#      EMAIL_* config and egress) to SMOKE_EMAIL_TO (default ALERT_EMAIL).
#   3. CodePipeline (--aws) — GetPipelineState on a pipeline name that cannot
#      exist, from inside the pipeline pod. PipelineNotFoundException PROVES the
#      pod reached the API with working credentials and the codepipeline grant;
#      AccessDenied / a credential error / a timeout is the real failure.
#   4. denied connection (k8s) — a throwaway pod OUTSIDE the mesh, whose egress
#      no policy opens, tries 1.1.1.1:443. It must be BLOCKED; OPEN means the
#      CNI is not enforcing NetworkPolicy at all (see eks cluster/nodeclass.yaml).
#
# Env: NAMESPACE, PB_SMOKE_KUBECTL (default `kubectl`; ec2 passes
# `sudo -u minikube kubectl`), SMOKE_EMAIL_TO | ALERT_EMAIL, SLACK_CRITICAL_WEBHOOK_URL /
# SLACK_WARNING_WEBHOOK_URL (only to decide whether Slack is configured),
# SMOKE_SKIP=alert,email,codepipeline,netpol (comma list) to skip checks.

set -uo pipefail

MODE="${1:?usage: post-provision-smoke.sh <k8s|docker> [--aws]}"
AWS_CHECKS=false
[ "${2:-}" = "--aws" ] && AWS_CHECKS=true
NS="${NAMESPACE:-pipeline-builder}"
SKIP=",${SMOKE_SKIP:-},"
# Pinned like every other busybox in the manifests.
PROBE_IMAGE="busybox@sha256:dc2d74b28e4cf8984fa52af1f39bc7c3d9c73760b41a74d629f5d11b1ab28616"  # busybox:1.38

# Word-split on purpose: PB_SMOKE_KUBECTL may be a command prefix.
# shellcheck disable=SC2206
KC=(${PB_SMOKE_KUBECTL:-kubectl})

PASS=0; WARN=0
pass() { echo "  PASS  $1"; PASS=$((PASS + 1)); }
warn() { echo "  WARN  $1" >&2; WARN=$((WARN + 1)); }
skip() { echo "  SKIP  $1"; }

# _exec <workload> <cmd...> — run a command in the service's container.
_exec() {
  local svc="$1"; shift
  case "$MODE" in
    k8s)    "${KC[@]}" -n "$NS" exec "deploy/$svc" -- "$@" ;;
    docker) docker exec "$svc" "$@" ;;
    *)      echo "unknown mode $MODE" >&2; return 2 ;;
  esac
}

# _ready <workload> — wait (bounded) until the service can be exec'd into, so a
# check that runs seconds after `apply` / `up -d` does not warn on a pod that is
# merely still starting.
_ready() {
  local svc="$1" _
  case "$MODE" in
    k8s) "${KC[@]}" -n "$NS" rollout status "deploy/$svc" --timeout=180s >/dev/null 2>&1 && return 0 ;;
    docker)
      for _ in $(seq 1 36); do
        docker exec "$svc" true >/dev/null 2>&1 && return 0
        sleep 5
      done ;;
  esac
  warn "$svc is not ready — its checks are skipped"
  return 1
}

# ---- 1. alert delivery ------------------------------------------------------
_am_counter() {  # $1 = metric name; sums every slack-integration series
  _exec alertmanager wget -qO- http://localhost:9093/metrics 2>/dev/null \
    | awk -v m="$1" '$1 ~ "^"m"\\{" && $1 ~ /integration="slack"/ { s += $2 } END { print s + 0 }'
}

pb_smoke_alert() {
  if [ -z "${SLACK_CRITICAL_WEBHOOK_URL:-}${SLACK_WARNING_WEBHOOK_URL:-}" ]; then
    skip "alert delivery — ops-team Slack is disabled (both SLACK_*_WEBHOOK_URL empty)"
    return 0
  fi
  local sent0 fail0 sent fail _
  _ready alertmanager || return 0
  sent0=$(_am_counter alertmanager_notifications_total) || { warn "alert delivery — cannot read Alertmanager metrics"; return 0; }
  fail0=$(_am_counter alertmanager_notifications_failed_total)
  if ! _exec alertmanager wget -qO- --header 'Content-Type: application/json' \
      --post-data '[{"labels":{"alertname":"PipelineBuilderDeploySmokeTest","severity":"warning","tenancy":"platform","component":"deploy"},"annotations":{"summary":"Deploy smoke test — delivery check, safe to ignore","description":"Posted by deploy/bin/post-provision-smoke.sh after a provision."}}]' \
      http://localhost:9093/api/v2/alerts >/dev/null 2>&1; then
    warn "alert delivery — could not post a test alert to Alertmanager"
    return 0
  fi
  # group_wait is 30s; give it up to ~2 minutes.
  for _ in $(seq 1 24); do
    sleep 5
    sent=$(_am_counter alertmanager_notifications_total)
    fail=$(_am_counter alertmanager_notifications_failed_total)
    if awk -v a="$fail" -v b="$fail0" 'BEGIN { exit !(a > b) }'; then
      warn "alert delivery — Alertmanager FAILED to deliver the test alert to Slack (check the webhook URL and the allow-alertmanager-external-egress NetworkPolicy; kubectl -n $NS logs deploy/alertmanager)"
      return 0
    fi
    if awk -v a="$sent" -v b="$sent0" 'BEGIN { exit !(a > b) }'; then
      pass "alert delivery — test alert delivered to Slack (#ops-warnings)"
      return 0
    fi
  done
  warn "alert delivery — no Slack notification attempt within 2 minutes"
}

# ---- 2. email ---------------------------------------------------------------
pb_smoke_email() {
  local to="${SMOKE_EMAIL_TO:-${ALERT_EMAIL:-}}"
  if [ "${EMAIL_ENABLED:-false}" != true ]; then skip "email — EMAIL_ENABLED is not true"; return 0; fi
  if [ -z "$to" ]; then skip "email — set SMOKE_EMAIL_TO (or ALERT_EMAIL) to send a test message"; return 0; fi
  case "$to" in *[!A-Za-z0-9@._+-]*) warn "email — refusing an unusual recipient address: $to"; return 0 ;; esac
  local js out
  _ready platform || return 0
  js="const { emailService } = await import('/app/utils/email.js');
const ok = await emailService.send({ to: '${to}', subject: 'Pipeline Builder deploy smoke test',
  text: 'Sent by deploy/bin/post-provision-smoke.sh: outbound email from this deployment works.' });
process.exit(ok ? 0 : 1);"
  if out=$(_exec platform node --input-type=module -e "$js" 2>&1); then
    pass "email — test message sent to $to"
  else
    warn "email — platform could not send ($(printf '%s' "$out" | tail -1)); check EMAIL_* in .env and the platform egress NetworkPolicy"
  fi
}

# ---- 3. CodePipeline credentials -------------------------------------------
pb_smoke_codepipeline() {
  local js out
  _ready pipeline || return 0
  js="const { CodePipelineClient, GetPipelineStateCommand } = await import('@aws-sdk/client-codepipeline');
try {
  await new CodePipelineClient({}).send(new GetPipelineStateCommand({ name: 'pb-smoke-test-does-not-exist' }));
  console.log('UNEXPECTED_FOUND');
} catch (e) { console.log(e.name || String(e)); }"
  out=$(_exec pipeline node --input-type=module -e "$js" 2>&1 | tail -1)
  case "$out" in
    PipelineNotFoundException) pass "codepipeline — pipeline pod reached CodePipeline with working credentials" ;;
    *) warn "codepipeline — GetPipelineState dry-run returned '$out' (expected PipelineNotFoundException): check the pipeline SA's Pod Identity / instance role and allow-pipeline-external-egress" ;;
  esac
}

# ---- 4. denied connection ---------------------------------------------------
# A pod OUTSIDE the mesh (dataplane-mode none), labelled so that no egress
# policy but DNS + in-namespace applies. Its connection to the public internet
# must be dropped. DNS must still work, or "blocked" proves nothing.
pb_probe_denied_connection() {
  local out
  out=$("${KC[@]}" -n "$NS" run "pb-netpol-probe-$$" --rm -i --restart=Never --quiet \
    --image="$PROBE_IMAGE" \
    --labels="app=pb-netpol-probe,istio.io/dataplane-mode=none" \
    --overrides='{"spec":{"automountServiceAccountToken":false,"securityContext":{"runAsNonRoot":true,"runAsUser":65534,"seccompProfile":{"type":"RuntimeDefault"}},"containers":[{"name":"probe","image":"'"$PROBE_IMAGE"'","command":["sh","-c","nslookup one.one.one.one >/dev/null 2>&1 || { echo NODNS; exit 0; }; if nc -z -w 5 1.1.1.1 443; then echo OPEN; else echo BLOCKED; fi"],"securityContext":{"allowPrivilegeEscalation":false,"capabilities":{"drop":["ALL"]}},"resources":{"requests":{"cpu":"10m","memory":"16Mi"},"limits":{"cpu":"50m","memory":"32Mi"}}}]}}' \
    2>&1 | tail -1)
  case "$out" in
    BLOCKED) pass "network policy — a denied connection is denied (NetworkPolicy is enforced)" ;;
    OPEN)    warn "network policy — NOT ENFORCED: a pod no policy allows reached 1.1.1.1:443. Every NetworkPolicy in k8s/networkpolicy.yaml is inert on this CNI (EKS: check kube-system/amazon-vpc-cni and the pipeline-builder NodeClass)" ;;
    NODNS)   warn "network policy — probe pod could not resolve DNS, so the result is inconclusive" ;;
    *)       warn "network policy — probe did not run cleanly: $out" ;;
  esac
}

echo ""
echo "=== Post-provision smoke checks ($MODE) ==="
case "$SKIP" in *,alert,*) skip "alert delivery (SMOKE_SKIP)" ;; *) pb_smoke_alert ;; esac
case "$SKIP" in *,email,*) skip "email (SMOKE_SKIP)" ;; *) pb_smoke_email ;; esac
if [ "$AWS_CHECKS" = true ]; then
  case "$SKIP" in *,codepipeline,*) skip "codepipeline (SMOKE_SKIP)" ;; *) pb_smoke_codepipeline ;; esac
fi
if [ "$MODE" = k8s ]; then
  case "$SKIP" in *,netpol,*) skip "network policy (SMOKE_SKIP)" ;; *) pb_probe_denied_connection ;; esac
fi
echo "  smoke: ${PASS} passed, ${WARN} warning(s)"
[ "$WARN" -eq 0 ] || echo "  (warnings are non-fatal — the deploy completed; fix them before relying on alerts/email)" >&2
exit 0
