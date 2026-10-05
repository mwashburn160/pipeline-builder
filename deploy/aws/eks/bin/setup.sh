#!/usr/bin/env bash
set -euo pipefail
# =============================================================================
# Pipeline Builder — EKS Auto Mode deploy orchestration
# =============================================================================
# Stands up the EKS Auto Mode cluster and deploys the platform onto it, reusing
# this target's standalone k8s manifests (../k8s) and the same secret/configmap
# layout the ec2 target uses (so the service images need no per-target changes).
#
#   ./bin/setup.sh --domain pipeline-builder.com --hosted-zone-id Z... --region us-east-1 \
#     --slack-critical-url https://hooks.slack.com/services/T.../B.../...  \
#     --slack-warning-url  https://hooks.slack.com/services/T.../B.../...
#
# Ops-team Slack is REQUIRED to be decided, not required to exist: pass both
# URLs, or --no-ops-slack to deploy without them (platform alerts then stay in
# Alertmanager's UI; per-org destinations are unaffected). It is checked BEFORE
# the cluster is created, so a wrong answer costs seconds, not 20 minutes.
#
# Prereqs (provision checks these): aws, kubectl, openssl, envsubst. eksctl is auto-installed
# below if missing (latest binary). The final auto-init phase (AUTO_INIT, default on) additionally
# needs docker + yq for the plugin image builds — pass --no-auto-init to skip it on a host without them.
# NOTE: the AWS-infra phases (EFS, ACM, Pod Identity, Route 53) talk to LIVE AWS
# and are idempotent where possible — review before running in a shared account.
# =============================================================================
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DEPLOY_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"      # deploy/aws/eks
CONFIG_DIR="$DEPLOY_DIR/config"
NGINX_DIR="$DEPLOY_DIR/nginx"
K8S_DIR="$DEPLOY_DIR/k8s"
# deploy/bin (shared helpers and key generators).
BIN_DIR="$(cd "$SCRIPT_DIR/../../../bin" && pwd)"
ENV_FILE="$DEPLOY_DIR/.env"

# ---- Config (flags override) ----
CLUSTER_NAME="${CLUSTER_NAME:-pipeline-builder}"
REGION="${REGION:-us-east-1}"
DOMAIN="${DOMAIN:-}"
HOSTED_ZONE_ID="${HOSTED_ZONE_ID:-}"
DEPLOY_MODE="${DEPLOY_MODE:-private}"            # public (internet-facing ALB) | private (internal)
NAMESPACE="${NAMESPACE:-pipeline-builder}"
GHCR_TOKEN="${GHCR_TOKEN:-}"
GHCR_USER="${GHCR_USER:-mwashburn160}"
EKS_VERSION="${EKS_VERSION:-1.36}"               # pinned default for fresh installs; `latest` tracks newest, or --eks-version X
AUTO_INIT="${AUTO_INIT:-true}"                   # run init-platform at the end (parity with ec2 bootstrap Phase 10); --no-auto-init opts out
AUTO_INIT_OK=false                               # set true ONLY when auto-init actually exits 0 — the completion banner reads this, not AUTO_INIT
BUILDKIT_MEMORY_LIMIT="${BUILDKIT_MEMORY_LIMIT:-6144Mi}"  # buildkitd sidecar memory limit (build cgroup); raise for heavy builds, bound by node memory
# Email (SES) — provisioned by default (parity with ec2); --no-email opts out.
EMAIL_ENABLED="${EMAIL_ENABLED:-true}"
EMAIL_FROM="${EMAIL_FROM:-}"                     # default noreply@<domain> (set after parse)
EMAIL_FROM_NAME="${EMAIL_FROM_NAME:-pipeline-builder}"
CREATE_SES_IDENTITY="${CREATE_SES_IDENTITY:-true}"  # --no-create-ses-identity when domain is already a verified identity

# ---- Phase selection --------------------------------------------------------
# Every phase here is written to be re-runnable: .env is generated ONCE (Phase 4
# guards on the file existing, because regenerating would rotate DB passwords out
# from under the Retain'd pb-ebs volumes), key sync is additive-only, secrets and
# ConfigMaps go through `--dry-run=client | apply`, the Phase 5 AWS calls each
# look the resource up first, workloads are a kustomize apply, and the Route 53
# change is an UPSERT.
#
# What was missing was the ability to run a SUBSET. A config change, a new image
# tag or a tweaked manifest only needs phases 4-8 (~2 minutes), but reaching them
# meant re-walking phase 1's cluster check, phase 2's EFS and phase 3's ACM wait
# (~25 minutes of mostly no-ops) with no way to say otherwise. bin/startup.sh is
# the shorthand for exactly that subset, mirroring the startup.sh every other
# target has.
#
# 1b/1c count as 1, and 6a/6b as 6: the letters are sub-steps of their phase, not
# separately resumable points.
PHASE_FROM="${PHASE_FROM:-1}"
PHASE_TO="${PHASE_TO:-10}"

# True when phase $1 is inside the selected range. Used as `if pb_phase N; then`
# with the phase body left at column 0, so selecting phases does not re-indent —
# and therefore cannot silently alter — a single line of what the phases do.
pb_phase() {
  [ "$1" -ge "$PHASE_FROM" ] && [ "$1" -le "$PHASE_TO" ]
}
ALERT_EMAIL="${ALERT_EMAIL:-}"
# Ops-team Slack webhooks. Supplied at invocation (or in the environment)
# because on a FIRST run .env does not exist yet — it is seeded from
# .env.example in Phase 4, long after the pre-flight below needs a value.
SLACK_CRITICAL_WEBHOOK_URL="${SLACK_CRITICAL_WEBHOOK_URL:-}"
SLACK_WARNING_WEBHOOK_URL="${SLACK_WARNING_WEBHOOK_URL:-}"

while [ $# -gt 0 ]; do
  case "$1" in
    --cluster-name) CLUSTER_NAME="$2"; shift 2 ;;
    --region) REGION="$2"; shift 2 ;;
    --domain) DOMAIN="$2"; shift 2 ;;
    --hosted-zone-id) HOSTED_ZONE_ID="$2"; shift 2 ;;
    --deploy-mode) DEPLOY_MODE="$2"; shift 2 ;;
    --ghcr-token) GHCR_TOKEN="$2"; shift 2 ;;
    --email) EMAIL_ENABLED=true; shift ;;
    --no-email) EMAIL_ENABLED=false; shift ;;
    --no-create-ses-identity) CREATE_SES_IDENTITY=false; shift ;;
    --email-from) EMAIL_FROM="$2"; shift 2 ;;
    --email-from-name) EMAIL_FROM_NAME="$2"; shift 2 ;;
    --alert-email) ALERT_EMAIL="$2"; shift 2 ;;
    --slack-critical-url) SLACK_CRITICAL_WEBHOOK_URL="$2"; shift 2 ;;
    --slack-warning-url) SLACK_WARNING_WEBHOOK_URL="$2"; shift 2 ;;
    --no-ops-slack) SLACK_CRITICAL_WEBHOOK_URL=""; SLACK_WARNING_WEBHOOK_URL=""; PB_OPS_SLACK_OPT_OUT=1; shift ;;
    --eks-version) EKS_VERSION="$2"; shift 2 ;;
    --auto-init) AUTO_INIT=true; shift ;;
    --no-auto-init) AUTO_INIT=false; shift ;;
    --from-phase) PHASE_FROM="$2"; shift 2 ;;
    --to-phase) PHASE_TO="$2"; shift 2 ;;
    --only-phase) PHASE_FROM="$2"; PHASE_TO="$2"; shift 2 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done
[ -n "$DOMAIN" ] || { echo "ERROR: --domain is required" >&2; exit 1; }
[ -n "$HOSTED_ZONE_ID" ] || { echo "ERROR: --hosted-zone-id is required" >&2; exit 1; }
case "$DEPLOY_MODE" in public|private) ;; *) echo "ERROR: --deploy-mode must be public|private" >&2; exit 1 ;; esac

# Preflight required external tools before any AWS calls (fail fast, one error).
# eksctl is intentionally excluded — it's auto-installed below if missing.
# shellcheck source=/dev/null
. "$SCRIPT_DIR/../../../bin/common.sh"
preflight aws kubectl openssl jq envsubst
# istioctl is NOT preflighted — ensure_istioctl (before the mesh install) auto-
# installs the right version if it's missing. Same handling on every target.

EMAIL_FROM="${EMAIL_FROM:-noreply@$DOMAIN}"
SES_CONFIGURATION_SET="${CLUSTER_NAME}-email"    # stack-scoped so a 2nd cluster doesn't collide
# Kubernetes version: a fixed value (e.g. 1.36, the default) is used as-is; the special
# value `latest` resolves to the newest version EKS currently offers (so a deploy can
# track current Kubernetes without editing this script).
if [ "$EKS_VERSION" = latest ]; then
  EKS_VERSION=$(aws eks describe-cluster-versions --region "$REGION" \
    --query 'sort_by(clusterVersions, &to_number(clusterVersion))[-1].clusterVersion' --output text 2>/dev/null || true)
  case "$EKS_VERSION" in 1.*) ;; *) EKS_VERSION=1.36 ;; esac   # fallback (older aws CLI / no API)
fi
export CLUSTER_NAME REGION DOMAIN NAMESPACE EKS_VERSION BUILDKIT_MEMORY_LIMIT
ALB_SCHEME=$([ "$DEPLOY_MODE" = public ] && echo internet-facing || echo internal); export ALB_SCHEME

# ---- Helpers ----
log() { echo ""; echo "=== $1 ==="; }
# Shared k8s bring-up (deploy/bin/k8s-resources.sh): Secret/ConfigMap creators, add-on
# installs (pinned ISTIO/GATEWAY_API/KEDA versions) and the apply phase — plain kubectl.
# PB_KUBECTL/PB_NAMESPACE are consumed by the sourced k8s-resources.sh (cross-file use).
# shellcheck disable=SC2034
PB_KUBECTL="kubectl"
# shellcheck disable=SC2034
PB_NAMESPACE="$NAMESPACE"
. "$SCRIPT_DIR/../../../bin/k8s-resources.sh"

echo "=== EKS Auto Mode deploy: cluster=$CLUSTER_NAME region=$REGION mode=$DEPLOY_MODE k8s=$EKS_VERSION domain=$DOMAIN ==="

# eksctl: install the pinned binary if it's not already on PATH (a prereq, like kubectl).
ensure_eksctl

# Create (or adopt) the token-signing KMS key BEFORE Phase 1, and prove it is
# usable. Up front because `eksctl create cluster` is ~20 minutes and a key
# problem would otherwise surface in Phase 4, after that time is spent. The key
# is tagged with this cluster, so shutdown.sh can schedule deletion of the one
# it created without touching a key the account already had.
#
# The settings are read from the env FILE rather than the environment: .env is
# not sourced until Phase 4, and on a fresh install it does not exist yet, so
# .env.example — the file Phase 4 is about to seed it from — is the authority.
# AWS_REGION likewise comes from $REGION here, because .env supplies it only
# from Phase 4 onward and the CLI would otherwise fall back to the operator's
# default region and create the key somewhere else entirely.
TOKEN_SIGNING_MODE="$(pb_env_value TOKEN_SIGNING_MODE "$ENV_FILE" "$DEPLOY_DIR/.env.example")" \
TOKEN_SIGNING_KMS_KEY_ID="$(pb_env_value TOKEN_SIGNING_KMS_KEY_ID "$ENV_FILE" "$DEPLOY_DIR/.env.example")" \
AWS_REGION="$REGION" \
  pb_ensure_token_signing_kms_key "$CLUSTER_NAME" || exit 1

# Shared .env secret generator (deploy/bin/gen-env-secrets.sh) — sourced HERE,
# not at Phase 4, because the alert pre-flight below needs
# pb_check_alert_delivery and runs before the cluster is created. It is a
# pure function library with no side effects at source time.
. "$SCRIPT_DIR/../../../bin/gen-env-secrets.sh"

# Alert delivery, validated here for exactly the reason the KMS key above is:
# it used to run in Phase 4, so a placeholder webhook surfaced only AFTER
# `eksctl create cluster` (~20 min), a live EFS and an ACM certificate — all of
# which the operator then owns. It reads one file and needs none of that.
#
# Same authority chain as the KMS settings: the flag/environment first (the only
# way a FIRST run can answer, since Phase 4 has not seeded .env yet), then .env,
# then .env.example. Checking .env.example alone would read its CHANGE_ME and
# fail every first deploy by construction — the bug this ordering fixes.
_pb_slack_crit="${SLACK_CRITICAL_WEBHOOK_URL:-$(pb_env_value SLACK_CRITICAL_WEBHOOK_URL "$ENV_FILE" "$DEPLOY_DIR/.env.example")}"
_pb_slack_warn="${SLACK_WARNING_WEBHOOK_URL:-$(pb_env_value SLACK_WARNING_WEBHOOK_URL "$ENV_FILE" "$DEPLOY_DIR/.env.example")}"
if [ "${PB_OPS_SLACK_OPT_OUT:-0}" = 1 ]; then _pb_slack_crit=""; _pb_slack_warn=""; fi
_pb_slack_env=$(mktemp)
printf 'SLACK_CRITICAL_WEBHOOK_URL=%s\nSLACK_WARNING_WEBHOOK_URL=%s\n' "$_pb_slack_crit" "$_pb_slack_warn" > "$_pb_slack_env"
if ! pb_check_alert_delivery "$_pb_slack_env" "$CONFIG_DIR/alertmanager/alertmanager.yml"; then
  rm -f "$_pb_slack_env"
  echo "" >&2
  echo "  Nothing has been created yet. Supply them at invocation:" >&2
  echo "    ./bin/setup.sh --domain … --hosted-zone-id … \\" >&2
  echo "      --slack-critical-url https://hooks.slack.com/services/T…/B…/… \\" >&2
  echo "      --slack-warning-url  https://hooks.slack.com/services/T…/B…/…" >&2
  echo "  or deploy without ops-team Slack:  ./bin/setup.sh … --no-ops-slack" >&2
  echo "" >&2
  exit 1
fi
rm -f "$_pb_slack_env"

# ---- Phase 1: cluster (Auto Mode) ------------------------------------------
if pb_phase 1; then
log "Phase 1: EKS Auto Mode cluster"
if eksctl get cluster --name "$CLUSTER_NAME" --region "$REGION" >/dev/null 2>&1; then
  echo "  cluster $CLUSTER_NAME exists — skipping create"
else
  envsubst < "$DEPLOY_DIR/cluster/cluster.yaml" | eksctl create cluster -f -
fi
aws eks update-kubeconfig --name "$CLUSTER_NAME" --region "$REGION"

# ---- Phase 1b: custom NodePool (the cluster's compute ceiling) --------------
# MUST run before any workload. cluster.yaml disables the built-in
# `general-purpose` NodePool so that a bounded pool is the only place ordinary
# pods can land (see the comments in both files) — until this is applied the only
# pool is `system`, which is tainted CriticalAddonsOnly, so nothing of ours would
# schedule and every later phase would sit Pending.
#
# Idempotent: re-applying an unchanged NodePool is a no-op, and a changed one is
# picked up by Karpenter without recreating nodes (unless the change drifts them).
fi
if pb_phase 1; then
log "Phase 1b: NodeClass (NetworkPolicy enforcement) + NodePool (compute ceiling)"
# NetworkPolicy is NOT enforced on EKS Auto Mode until (1) the VPC CNI's
# network-policy controller is switched on through this ConfigMap and (2) the
# nodes' NodeClass sets `networkPolicy`. Without both, every policy in
# k8s/networkpolicy.yaml is accepted and then silently ignored — default-deny,
# the quarantine builder's narrow egress and the IMDS carve-outs included.
kubectl create configmap amazon-vpc-cni -n kube-system \
  --from-literal=enable-network-policy-controller=true \
  --dry-run=client -o yaml | kubectl apply -f -
# The `pipeline-builder` NodeClass = the EKS-managed `default` NodeClass's spec
# (same node role, subnets and SGs — so its EKS access entry already covers
# these nodes) with cluster/nodeclass.yaml's fields merged on top.
_nc_default=$(kubectl get nodeclasses.eks.amazonaws.com default -o json)
_nc_overlay=$(kubectl create --dry-run=client -o json -f "$DEPLOY_DIR/cluster/nodeclass.yaml")
jq -n --argjson d "$_nc_default" --argjson o "$_nc_overlay" \
  '$o | .spec = ($d.spec + $o.spec)' | kubectl apply -f -
unset _nc_default _nc_overlay
kubectl apply -f "$DEPLOY_DIR/cluster/nodepool.yaml"
# Fail loudly here rather than 200 lines later as unschedulable pods: without a
# usable NodePool the whole deploy is dead, and the reason is much harder to see
# from a Pending pod than from this message.
if ! kubectl wait --for=condition=Ready nodepool/pipeline-builder --timeout=120s >/dev/null 2>&1; then
  echo "ERROR: the pipeline-builder NodePool did not become Ready." >&2
  echo "       Nothing can schedule without it (general-purpose is disabled)." >&2
  echo "       Check: kubectl describe nodepool pipeline-builder" >&2
  echo "       A NotReady pool usually means the 'default' NodeClass is absent —" >&2
  echo "       which happens if autoModeConfig.nodePools in cluster/cluster.yaml" >&2
  echo "       was emptied (EKS only provisions it while a built-in pool is on)." >&2
  exit 1
fi
echo "  NodePool pipeline-builder ready (ceiling: 48 cpu / 96Gi)"
# The anonymous-submission build pool (same file). Not Ready means the
# plugin-quarantine-builder pod stays Pending — submissions then fail closed
# (the plugin service never falls back to the tenant buildkitd), so this is a
# warning, not a deploy failure: everything else works without it.
if ! kubectl wait --for=condition=Ready nodepool/plugin-quarantine --timeout=120s >/dev/null 2>&1; then
  echo "  WARNING: NodePool plugin-quarantine is not Ready — anonymous plugin submissions" >&2
  echo "           cannot build until it is. Check: kubectl describe nodepool plugin-quarantine" >&2
else
  echo "  NodePool plugin-quarantine ready (ceiling: 8 cpu / 32Gi, tainted pipeline-builder/quarantine)"
fi

# ---- Phase 1c: addons (after the NodePool, so they have somewhere to run) ----
# Split out of cluster.yaml on purpose — see the comments in cluster/addons.yaml.
# Idempotent: an addon that already exists is reported, not re-created.
fi
if pb_phase 1; then
log "Phase 1c: cluster addons"
envsubst < "$DEPLOY_DIR/cluster/addons.yaml" | eksctl create addon -f - 2>&1 \
  | grep -viE "already exists|created addon" || true
echo "  addons applied (aws-efs-csi-driver)"

VPC_ID=$(aws eks describe-cluster --name "$CLUSTER_NAME" --region "$REGION" --query 'cluster.resourcesVpcConfig.vpcId' --output text)
CLUSTER_SG=$(aws eks describe-cluster --name "$CLUSTER_NAME" --region "$REGION" --query 'cluster.resourcesVpcConfig.clusterSecurityGroupId' --output text)
echo "  vpc=$VPC_ID cluster-sg=$CLUSTER_SG"

# ---- The VPC's own CIDR(s) -> ${VPC_CIDR} in k8s/networkpolicy.yaml ---------
# Every public-egress rule in networkpolicy.yaml excepts the private ranges so a
# USER-SUPPLIED URL (a per-org alert webhook, an OIDC discovery document, SAML IdP
# metadata) cannot pivot from platform into an in-VPC service. That backstop was
# written against the RFC1918 constants, which silently assumes the VPC sits in
# one of them. It need not: eksctl's default is 192.168.0.0/16, a BYO VPC
# (cluster/cluster.yaml) can be anything, and AWS permits publicly-routable VPC
# CIDRs — in which case the constants except nothing that matters and the
# backstop is open. So the cluster's real CIDR is discovered and injected rather
# than assumed. Same pattern as PB_TRUSTED_PROXY_CIDRS below.
PB_VPC_CIDR=$(aws ec2 describe-vpcs --vpc-ids "$VPC_ID" --region "$REGION" \
  --query 'Vpcs[0].CidrBlock' --output text)
case "$PB_VPC_CIDR" in
  */*) ;;
  *) echo "ERROR: could not read the CIDR of $VPC_ID (got '$PB_VPC_CIDR') — networkpolicy.yaml's SSRF backstop needs it" >&2; exit 1 ;;
esac

# Is a CIDR inside one of the ranges networkpolicy.yaml already excepts? Compared
# NUMERICALLY on the first two octets, not by glob: CGNAT is 100.64/10, so the
# second octet runs 64-127, and a pattern like `100.1[01]*` reads as "covered"
# for 100.10.0.0/16, which is NOT in CGNAT. Declaring a real hole covered is the
# one failure this check must not have. AWS VPC CIDRs are /16-/28 and sit inside a
# single range, so testing the base address is sufficient.
_cidr_is_private() {
  local _a="${1%%.*}" _rest="${1#*.}" _b
  _b="${_rest%%.*}"
  case "$_a" in
    10) return 0 ;;
    192) [ "$_b" = 168 ] && return 0 ;;
    172) [ "$_b" -ge 16 ] 2>/dev/null && [ "$_b" -le 31 ] && return 0 ;;
    100) [ "$_b" -ge 64 ] 2>/dev/null && [ "$_b" -le 127 ] && return 0 ;;
  esac
  return 1
}

# A VPC may carry SECONDARY CIDR associations, and ${VPC_CIDR} is one token. Any
# association neither injected nor already covered by the constants is a hole in
# the backstop, so refuse rather than deploy one: this is the boundary that keeps a
# crafted webhook URL away from the cluster, and platform holds the token-signing
# keys that would make such a pivot expensive. Rare and deliberate by construction
# — it takes a BYO VPC with a non-RFC1918 secondary range.
_uncovered=""
for _c in $(aws ec2 describe-vpcs --vpc-ids "$VPC_ID" --region "$REGION" \
    --query 'Vpcs[0].CidrBlockAssociationSet[?CidrBlockState.State==`associated`].CidrBlock' --output text); do
  [ "$_c" = "$PB_VPC_CIDR" ] && continue          # the one ${VPC_CIDR} injects
  _cidr_is_private "$_c" && continue
  _uncovered="$_uncovered $_c"
done
if [ -n "$_uncovered" ]; then
  echo "ERROR: $VPC_ID has CIDR association(s) outside networkpolicy.yaml's excepted ranges:$_uncovered" >&2
  echo "       Add each as an \`except\` entry to every 0.0.0.0/0 egress rule in" >&2
  echo "       k8s/networkpolicy.yaml, or platform's user-supplied-URL fetches can reach them." >&2
  exit 1
fi
unset _uncovered
export PB_VPC_CIDR
echo "  egress backstop excepts this VPC: $PB_VPC_CIDR"

# ---- Phase 2: EFS (RWX volume: plugin uploads) -----------------------------
fi
if pb_phase 2; then
log "Phase 2: EFS filesystem"
# Idempotent via a creation token tied to the cluster name.
EFS_FILESYSTEM_ID=$(aws efs describe-file-systems --region "$REGION" \
  --query "FileSystems[?CreationToken=='pb-${CLUSTER_NAME}'].FileSystemId | [0]" --output text 2>/dev/null || true)
if [ -z "$EFS_FILESYSTEM_ID" ] || [ "$EFS_FILESYSTEM_ID" = None ]; then
  EFS_FILESYSTEM_ID=$(aws efs create-file-system --region "$REGION" --creation-token "pb-${CLUSTER_NAME}" \
    --encrypted --tags "Key=Name,Value=${CLUSTER_NAME}-efs" "Key=Project,Value=pipeline-builder" \
    --query FileSystemId --output text)
  echo "  created EFS $EFS_FILESYSTEM_ID — waiting for 'available'..."
  # Bounded wait (~5 min) so a stuck EFS fails the deploy instead of hanging
  # forever — matches the capped ACM/ALB polls elsewhere in this script.
  _efs_tries=0
  until [ "$(aws efs describe-file-systems --file-system-id "$EFS_FILESYSTEM_ID" --region "$REGION" --query 'FileSystems[0].LifeCycleState' --output text)" = available ]; do
    _efs_tries=$((_efs_tries + 1))
    [ "$_efs_tries" -ge 60 ] && { echo "ERROR: EFS $EFS_FILESYSTEM_ID did not become 'available' after ~5 min" >&2; exit 1; }
    sleep 5
  done
fi
export EFS_FILESYSTEM_ID
# SG allowing NFS (2049) from the cluster nodes (which carry the cluster SG).
EFS_SG=$(aws ec2 describe-security-groups --region "$REGION" \
  --filters "Name=vpc-id,Values=$VPC_ID" "Name=group-name,Values=${CLUSTER_NAME}-efs" \
  --query 'SecurityGroups[0].GroupId' --output text 2>/dev/null || true)
if [ -z "$EFS_SG" ] || [ "$EFS_SG" = None ]; then
  EFS_SG=$(aws ec2 create-security-group --region "$REGION" --vpc-id "$VPC_ID" \
    --group-name "${CLUSTER_NAME}-efs" --description "NFS from EKS nodes" --query GroupId --output text)
  aws ec2 authorize-security-group-ingress --region "$REGION" --group-id "$EFS_SG" \
    --protocol tcp --port 2049 --source-group "$CLUSTER_SG" >/dev/null
fi
# Mount targets in the cluster's private subnets (where Auto Mode nodes run).
for subnet in $(aws ec2 describe-subnets --region "$REGION" \
    --filters "Name=vpc-id,Values=$VPC_ID" "Name=tag:kubernetes.io/role/internal-elb,Values=1" \
    --query 'Subnets[].SubnetId' --output text); do
  aws efs create-mount-target --file-system-id "$EFS_FILESYSTEM_ID" --subnet-id "$subnet" \
    --security-groups "$EFS_SG" --region "$REGION" >/dev/null 2>&1 || true   # already-exists is fine
done
echo "  EFS $EFS_FILESYSTEM_ID ready (sg=$EFS_SG)"

# ---- Phase 3: ACM certificate (DNS-validated via Route 53) -----------------
fi
if pb_phase 3; then
log "Phase 3: ACM certificate for $DOMAIN"
ACM_CERT_ARN=$(aws acm list-certificates --region "$REGION" \
  --query "CertificateSummaryList[?DomainName=='$DOMAIN'].CertificateArn | [0]" --output text 2>/dev/null || true)
if [ -z "$ACM_CERT_ARN" ] || [ "$ACM_CERT_ARN" = None ]; then
  ACM_CERT_ARN=$(aws acm request-certificate --region "$REGION" --domain-name "$DOMAIN" \
    --validation-method DNS --query CertificateArn --output text)
  echo "  requested $ACM_CERT_ARN — publishing the DNS validation record..."
  # The validation record can take a moment to populate.
  RR_NAME=""; for _ in $(seq 1 12); do
    RR_NAME=$(aws acm describe-certificate --certificate-arn "$ACM_CERT_ARN" --region "$REGION" \
      --query 'Certificate.DomainValidationOptions[0].ResourceRecord.Name' --output text 2>/dev/null || true)
    [ -n "$RR_NAME" ] && [ "$RR_NAME" != None ] && break; sleep 5
  done
  RR_VALUE=$(aws acm describe-certificate --certificate-arn "$ACM_CERT_ARN" --region "$REGION" \
    --query 'Certificate.DomainValidationOptions[0].ResourceRecord.Value' --output text)
  aws route53 change-resource-record-sets --hosted-zone-id "$HOSTED_ZONE_ID" \
    --change-batch "{\"Changes\":[{\"Action\":\"UPSERT\",\"ResourceRecordSet\":{\"Name\":\"$RR_NAME\",\"Type\":\"CNAME\",\"TTL\":300,\"ResourceRecords\":[{\"Value\":\"$RR_VALUE\"}]}}]}" >/dev/null
fi
echo "  waiting for certificate ISSUED..."
aws acm wait certificate-validated --certificate-arn "$ACM_CERT_ARN" --region "$REGION"
export ACM_CERT_ARN
echo "  cert ready: $ACM_CERT_ARN"

# ---- Phase 4: .env + namespace + secrets/configmaps ------------------------
fi
# ---- Phase 1-3 outputs, when those phases were skipped -----------------------
# Phases 4-8 consume four values that phases 1-3 compute. Running a subset
# (bin/startup.sh, or --from-phase 4) must therefore LOOK THEM UP rather than
# inherit them, or `set -u` kills the run on the first unbound one.
#
# These are the same read-only queries phases 1-3 use to decide whether to create
# the resource, so a lookup here can only find what those phases would have
# found. Each FAILS LOUDLY when absent: an empty cert ARN or EFS id would
# otherwise envsubst into the manifests as an empty string and produce an Ingress
# with no certificate, or a StorageClass pointing at no filesystem — both of
# which apply cleanly and fail later, far from the cause.
if ! pb_phase 3; then
  log "Recovering phase 1-3 outputs (they were not run in this invocation)"
  VPC_ID=$(aws eks describe-cluster --name "$CLUSTER_NAME" --region "$REGION" \
    --query 'cluster.resourcesVpcConfig.vpcId' --output text 2>/dev/null || true)
  [ -n "$VPC_ID" ] && [ "$VPC_ID" != None ] \
    || { echo "ERROR: cluster $CLUSTER_NAME not found in $REGION — run the full setup first" >&2; exit 1; }
  PB_VPC_CIDR=$(aws ec2 describe-vpcs --vpc-ids "$VPC_ID" --region "$REGION" \
    --query 'Vpcs[0].CidrBlock' --output text)
  EFS_FILESYSTEM_ID=$(aws efs describe-file-systems --region "$REGION" \
    --query "FileSystems[?CreationToken=='pb-${CLUSTER_NAME}'].FileSystemId | [0]" --output text 2>/dev/null || true)
  [ -n "$EFS_FILESYSTEM_ID" ] && [ "$EFS_FILESYSTEM_ID" != None ] \
    || { echo "ERROR: no EFS filesystem for pb-${CLUSTER_NAME} — run phase 2 (--from-phase 2)" >&2; exit 1; }
  ACM_CERT_ARN=$(aws acm list-certificates --region "$REGION" \
    --query "CertificateSummaryList[?DomainName=='$DOMAIN'].CertificateArn | [0]" --output text 2>/dev/null || true)
  [ -n "$ACM_CERT_ARN" ] && [ "$ACM_CERT_ARN" != None ] \
    || { echo "ERROR: no ACM certificate for $DOMAIN — run phase 3 (--from-phase 3)" >&2; exit 1; }
  echo "  vpc=$VPC_ID cidr=$PB_VPC_CIDR efs=$EFS_FILESYSTEM_ID cert=${ACM_CERT_ARN##*/}"
fi

if pb_phase 4; then
log "Phase 4: secrets + configmaps"
# (gen-env-secrets.sh is sourced above, before the Phase 0 alert pre-flight.)
# Generate .env from the template ONCE (regenerating would rotate DB passwords
# out from under existing PVC data on a re-run). Mirrors ec2 bootstrap.sh Phase 7.
if [ ! -f "$ENV_FILE" ]; then
  echo "  generating .env (with random secrets)"
  cp "$DEPLOY_DIR/.env.example" "$ENV_FILE"
  # Generated secrets common to every target (shared helper); then the eks-specific keys.
  pb_gen_env_secrets "$ENV_FILE" "$GHCR_USER"
  sed -i.bak "s|YOUR_DOMAIN_HERE|${DOMAIN}|g" "$ENV_FILE"
  # Anchored whole-line replace (matches ec2 bootstrap) so it can't rewrite a
  # GHCR_TOKEN= substring on another/comment line or double-apply.
  [ -n "$GHCR_TOKEN" ] && sed -i.bak "s|^GHCR_TOKEN=.*|GHCR_TOKEN=${GHCR_TOKEN}|" "$ENV_FILE"
  # Region is account-specific; SES is regional, so pin both to the deploy region.
  sed -i.bak "s|^AWS_REGION=.*|AWS_REGION=${REGION}|" "$ENV_FILE"
  sed -i.bak "s|^SES_REGION=.*|SES_REGION=${REGION}|" "$ENV_FILE"
  # Email wiring (the SES resources themselves are provisioned in Phase 5).
  sed -i.bak "s|^EMAIL_ENABLED=.*|EMAIL_ENABLED=${EMAIL_ENABLED}|" "$ENV_FILE"
  if [ "$EMAIL_ENABLED" = true ]; then
    sed -i.bak "s|^EMAIL_PROVIDER=.*|EMAIL_PROVIDER=ses|" "$ENV_FILE"
    sed -i.bak "s|^EMAIL_FROM=.*|EMAIL_FROM=${EMAIL_FROM}|" "$ENV_FILE"
    sed -i.bak "s|^EMAIL_FROM_NAME=.*|EMAIL_FROM_NAME=${EMAIL_FROM_NAME}|" "$ENV_FILE"
    sed -i.bak "s|^SES_CONFIGURATION_SET=.*|SES_CONFIGURATION_SET=${SES_CONFIGURATION_SET}|" "$ENV_FILE"
  fi
  rm -f "$ENV_FILE.bak"
else
  echo "  reusing existing .env"
fi
# Bring an EXISTING .env up to date with keys added to .env.example since it was
# generated (ADDITIVE ONLY — an existing value is never touched, so the DB
# passwords stay matched to the data on the Retain'd pb-ebs volumes). Without
# this a re-deploy onto an older .env never sees a newly added key and dies with
# a bare `unbound variable` under `set -u` — or materialises an empty secret.
# Same call the docker/minikube targets make.
pb_sync_env_keys "$ENV_FILE" "$DEPLOY_DIR/.env.example"
# A key the sync just appended still carries the example's domain placeholder
# (the substitutions above run only on the fresh-seed path). Re-apply it here —
# a no-op on an already-generated .env, since YOUR_DOMAIN_HERE is never a
# legitimate value. (ec2's bootstrap.sh runs its domain sed unguarded for the
# same reason.)
sed -i.bak "s|YOUR_DOMAIN_HERE|${DOMAIN}|g" "$ENV_FILE"; rm -f "$ENV_FILE.bak"

# Ops-team Slack webhooks from the flags/environment. OUTSIDE the fresh-seed
# branch on purpose: an operator may supply one on a RE-deploy, and the value
# has to reach .env or the Phase 4 pre-flight below still reads the placeholder
# the sync just appended. Guarded on non-empty for the same reason GHCR_TOKEN is
# — a re-run without the flag must not wipe a URL edited into .env by hand.
# `--no-ops-slack` writes the empty value deliberately, which is the documented
# "run without ops-team Slack" choice rather than an absent one.
for _pb_slack_key in SLACK_CRITICAL_WEBHOOK_URL SLACK_WARNING_WEBHOOK_URL; do
  eval "_pb_slack_val=\${${_pb_slack_key}:-}"
  if [ -n "$_pb_slack_val" ] || [ "${PB_OPS_SLACK_OPT_OUT:-0}" = 1 ]; then
    sed -i.bak "s|^${_pb_slack_key}=.*|${_pb_slack_key}=${_pb_slack_val}|" "$ENV_FILE"
    rm -f "$ENV_FILE.bak"
  fi
done
# Source so secret values match exactly what ec2 startup.sh consumes.
set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a

# ALERT DELIVERY PRE-FLIGHT. Fails the provision while a Slack webhook URL is
# still a placeholder — alerting that 404s into nothing is indistinguishable
# from healthy alerting, so it has to be caught here and not at 3am.
pb_check_alert_delivery "$ENV_FILE" "$CONFIG_DIR/alertmanager/alertmanager.yml" || exit 1

kubectl create namespace "$NAMESPACE" --dry-run=client -o yaml | kubectl apply -f -

# app-env ConfigMap from .env (non-comment, non-blank; ${VAR} refs expanded).
# Cumulative cleanup trap: also removes the registry-JWT temp dir (set below), so the
# private key can't leak in /tmp if `set -e` aborts between its mktemp and its rm.
CLEAN_ENV=$(mktemp); CERT_DIR=""
trap 'rm -f "$CLEAN_ENV"; [ -n "$CERT_DIR" ] && rm -rf "$CERT_DIR"' EXIT
# RESTRICTED envsubst: expand ONLY the two intentional references
# (OAUTH_CALLBACK_BASE_URL=${PLATFORM_FRONTEND_URL}, IMAGE_REGISTRY_PULL_HOST=${DOMAIN}).
# An unrestricted envsubst would treat a literal `$` in any secret (bcrypt hash,
# password) as a variable and silently blank/corrupt it. POSIX grep class
# `[[:space:]]` (not the GNU-only `\s`) keeps this correct when run from a Mac.
grep -Ev '^[[:space:]]*(#|$)' "$ENV_FILE" | sed "s|[\$]{PLATFORM_FRONTEND_URL}|${PLATFORM_FRONTEND_URL}|g; s|[\$]{DOMAIN}|${DOMAIN}|g" > "$CLEAN_ENV"
# Split into the app-env ConfigMap (settings) + app-secrets Secret (credentials);
# superuser/admin creds go to neither (see pb_split_app_env).
pb_app_env_resources "$CLEAN_ENV"
rm -f "$CLEAN_ENV"

# Application secrets + optional GHCR pull secret (shared creators).
pb_create_app_secrets
pb_create_ghcr_secret

# image-registry token-signing keypair — ephemeral (no gateway TLS; the ALB terminates it).
CERT_DIR=$(mktemp -d)
openssl genrsa -out "$CERT_DIR/jwt.key" 2048 >/dev/null 2>&1
openssl req -x509 -new -key "$CERT_DIR/jwt.key" -days 3650 \
  -subj "/CN=pipeline-image-registry-token-issuer" -out "$CERT_DIR/jwt.crt" >/dev/null 2>&1
pb_create_registry_secrets "$CERT_DIR/jwt.key" "$CERT_DIR/jwt.crt"

# The ES256 user-token signing key (platform only). Unlike the registry keypair
# this one must SURVIVE the deploy — regenerating it would invalidate every
# session — so it is written to the persistent cert dir, not the temp one, and
# the generator skips when it already exists. Skipped entirely under
# TOKEN_SIGNING_MODE=kms, where the private key never leaves AWS.
if [ "${TOKEN_SIGNING_MODE:-local}" = "local" ]; then
  bash "$BIN_DIR/token-signing-keys.sh" "$DEPLOY_DIR/certs"
fi
pb_create_token_signing_secret "$DEPLOY_DIR/certs/token-signing/token-signing.key" "$DEPLOY_DIR/certs/token-signing/token-signing-previous.key"

# The plugin-image signing keypair. Persistent cert dir for the same reason as
# the user-token key: regenerating it would orphan the signature on every plugin
# image already pushed. Runs in BOTH modes — local generates the private key
# (mounted by image-registry ONLY) plus its public half; kms writes no private
# key and exports the public half from KMS by alias (so YOUR credentials need
# kms:GetPublicKey here; image-registry's own kms:Sign grant is Phase 5). Plugin
# only ever gets the public Secret — see pb_create_plugin_signing_secrets.
AWS_REGION="$REGION" bash "$BIN_DIR/plugin-signing-keys.sh" "$DEPLOY_DIR/certs"
pb_create_plugin_signing_secrets "$DEPLOY_DIR/certs/plugin-signing"

# PER-SERVICE ES256 keys for INTERNAL service-to-service tokens. Like the
# user-token key these must SURVIVE the deploy (regenerating one would break
# every in-flight internal call from that service), so they live in the
# persistent cert dir and the generator skips existing keys. One
# `service-key-<name>` Secret per service — mounted by that service ALONE, which
# is what stops a compromised pod signing as another — plus the public
# `service-key-bundle` every service verifies against.
bash "$BIN_DIR/service-signing-keys.sh" "$DEPLOY_DIR/certs"
pb_create_service_key_secrets "$DEPLOY_DIR/certs/service-keys"
rm -rf "$CERT_DIR"

# Generate the MongoDB replica-set keyfile per-deploy (idempotent; the keyfile is
# never committed). pb_create_config_maps reads it directly.
# shellcheck source=/dev/null
. "$SCRIPT_DIR/../../../bin/mongo-keyfile.sh"
pb_ensure_mongo_keyfile "$DEPLOY_DIR/mongodb-keyfile"

# The ALB's subnets — the ONLY peers nginx trusts X-Forwarded-For from
# (real_ip; see nginx.conf CLIENT IP). The ALB lands in the subnets tagged for
# its scheme, so those CIDRs are exactly the addresses it connects from.
_alb_subnet_tag=$([ "$DEPLOY_MODE" = public ] && echo kubernetes.io/role/elb || echo kubernetes.io/role/internal-elb)
PB_TRUSTED_PROXY_CIDRS=$(aws ec2 describe-subnets --region "$REGION" \
  --filters "Name=vpc-id,Values=$VPC_ID" "Name=tag:${_alb_subnet_tag},Values=1" \
  --query 'Subnets[].CidrBlock' --output text)
[ -n "$PB_TRUSTED_PROXY_CIDRS" ] || { echo "ERROR: no subnets tagged ${_alb_subnet_tag}=1 in $VPC_ID — cannot derive the ALB CIDRs nginx must trust" >&2; exit 1; }
export PB_TRUSTED_PROXY_CIDRS
echo "  nginx trusts X-Forwarded-For from the ALB subnets: $PB_TRUSTED_PROXY_CIDRS"

# Config-file ConfigMaps + MongoDB keyfile (same set the ec2 manifests expect).
pb_create_config_maps "$DEPLOY_DIR" "$CONFIG_DIR" "$NGINX_DIR"

# ---- Phase 5: SES email + Pod Identity IAM ---------------------------------
# Parity with the ec2 target's in-stack SES (template.yaml): Easy-DKIM identity +
# Route 53 CNAMEs, a configuration set, a bounce/complaint SNS topic, and a
# Pod Identity association carrying policies SCOPED to exactly what the pods need
# (ses:SendEmail on this identity; codepipeline:Start/StopPipelineExecution on
# this account's pipelines) — never the *FullAccess managed policies. Idempotent.
#
# Pod Identity binds ONE IAM role per ServiceAccount, and — critically — each
# workload runs as its OWN named SA (platform, pipeline, message, …), NOT the
# namespace 'default' SA (see k8s/istio.yaml + each Deployment's
# serviceAccountName). So a grant must be associated with the SA of the pod that
# actually needs it: SES (ses:SendEmail) → the 'platform' SA (platform/src/utils
# /email.ts sends), and CodePipeline Start/Stop → the 'pipeline' SA (api/pipeline
# pipeline-execution-service). Binding to 'default' would strand the credentials.
fi
if pb_phase 5; then
log "Phase 5: SES email + Pod Identity IAM"
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)

# Associate a ServiceAccount with a scoped policy via Pod Identity: create the
# association (SA → role carrying the policy) if absent, else back-fill the policy
# onto the existing role (attach-role-policy is idempotent). Requires the Pod
# Identity agent (bundled with EKS Auto Mode). Args: <sa-name> <policy-arn>.
associate_pod_identity() {
  local sa="$1" policy_arn="$2"
  local assoc
  assoc=$(aws eks list-pod-identity-associations --cluster-name "$CLUSTER_NAME" --region "$REGION" \
    --namespace "$NAMESPACE" --query "associations[?serviceAccount=='${sa}'].associationId | [0]" --output text 2>/dev/null || true)
  if [ -z "$assoc" ] || [ "$assoc" = "None" ]; then
    eksctl create podidentityassociation --cluster "$CLUSTER_NAME" --region "$REGION" \
      --namespace "$NAMESPACE" --service-account-name "$sa" \
      --permission-policy-arns "$policy_arn" 2>/dev/null \
      && echo "  Pod Identity associated ($sa SA → ${policy_arn##*/})" \
      || echo "  Pod Identity association failed for $sa — check: eksctl get podidentityassociation --cluster $CLUSTER_NAME"
  else
    local role_arn role_name
    role_arn=$(aws eks describe-pod-identity-association --cluster-name "$CLUSTER_NAME" --region "$REGION" \
      --association-id "$assoc" --query "association.roleArn" --output text 2>/dev/null || true)
    role_name="${role_arn##*/}"
    if [ -n "$role_name" ] && [ "$role_name" != "None" ]; then
      # Report the OUTCOME. This used to swallow the failure with `|| true` and
      # then print "ensured ..." unconditionally — so a denied attach, a wrong
      # ARN, or the 20-managed-policies-per-role cap all read as success, and the
      # workload failed later with an AccessDenied nowhere near the cause.
      # Still non-fatal (the create branch above only warns too): one missing
      # grant should not abort a deploy, but it must not claim to have worked.
      local _attach_err
      if _attach_err=$(aws iam attach-role-policy --role-name "$role_name" --policy-arn "$policy_arn" 2>&1); then
        echo "  Pod Identity association exists ($sa SA); ensured ${policy_arn##*/} on role $role_name"
      else
        echo "  WARNING: could NOT attach ${policy_arn##*/} to role $role_name — $sa will run without it: ${_attach_err##*: }" >&2
      fi
    else
      echo "  Pod Identity association exists for $sa but role lookup failed — attach ${policy_arn##*/} manually"
    fi
  fi
}

# Create ONE scoped, customer-managed IAM policy and bind it to ONE
# ServiceAccount via Pod Identity — the shape every grant below takes.
# The policy is created on first run and REUSED, never rewritten: an input that
# changed (a different From address, a re-pointed KMS alias) needs the policy
# edited or deleted by hand, which the reuse line says.
# Args: <service-account> <policy-name-suffix> <policy-document-json> <what-it-grants>
grant_pod_identity() {
  local sa="$1" suffix="$2" doc="$3" what="$4"
  local name="${CLUSTER_NAME}-eks-${suffix}"
  local arn="arn:aws:iam::${ACCOUNT_ID}:policy/${name}"
  if aws iam get-policy --policy-arn "$arn" >/dev/null 2>&1; then
    echo "  reusing IAM policy $name — delete it to rebuild from changed inputs ($what)"
  else
    aws iam create-policy --policy-name "$name" --policy-document "$doc" >/dev/null
    echo "  created scoped IAM policy $name ($what)"
  fi
  associate_pod_identity "$sa" "$arn"
}

if [ "${EMAIL_ENABLED:-false}" = true ]; then
  SES_IDENTITY_ARN="arn:aws:ses:${REGION}:${ACCOUNT_ID}:identity/${DOMAIN}"
  SES_CONFIG_SET="${SES_CONFIGURATION_SET:-${CLUSTER_NAME}-email}"
  TOPIC_NAME="${CLUSTER_NAME}-email-events"

  # SES domain identity (Easy DKIM) + the 3 DKIM CNAMEs to the PUBLIC zone.
  if [ "${CREATE_SES_IDENTITY:-true}" = true ]; then
    aws sesv2 create-email-identity --email-identity "$DOMAIN" --region "$REGION" >/dev/null 2>&1 \
      || echo "  SES identity $DOMAIN already exists — reusing"
    for tok in $(aws sesv2 get-email-identity --email-identity "$DOMAIN" --region "$REGION" \
        --query 'DkimAttributes.Tokens' --output text 2>/dev/null); do
      aws route53 change-resource-record-sets --hosted-zone-id "$HOSTED_ZONE_ID" \
        --change-batch "{\"Changes\":[{\"Action\":\"UPSERT\",\"ResourceRecordSet\":{\"Name\":\"${tok}._domainkey.${DOMAIN}\",\"Type\":\"CNAME\",\"TTL\":1800,\"ResourceRecords\":[{\"Value\":\"${tok}.dkim.amazonses.com\"}]}}]}" >/dev/null
    done
    echo "  SES identity + DKIM CNAMEs published (verification is async)"
  fi

  # Configuration set + bounce/complaint SNS topic (visibility before SES throttles).
  aws sesv2 create-configuration-set --configuration-set-name "$SES_CONFIG_SET" --region "$REGION" \
    --reputation-options ReputationMetricsEnabled=true >/dev/null 2>&1 \
    || echo "  config set $SES_CONFIG_SET already exists"
  TOPIC_ARN=$(aws sns create-topic --name "$TOPIC_NAME" --region "$REGION" --query TopicArn --output text)
  aws sns set-topic-attributes --topic-arn "$TOPIC_ARN" --region "$REGION" --attribute-name Policy \
    --attribute-value "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Sid\":\"AllowSesPublish\",\"Effect\":\"Allow\",\"Principal\":{\"Service\":\"ses.amazonaws.com\"},\"Action\":\"sns:Publish\",\"Resource\":\"${TOPIC_ARN}\",\"Condition\":{\"StringEquals\":{\"AWS:SourceAccount\":\"${ACCOUNT_ID}\"}}}]}" >/dev/null
  aws sesv2 create-configuration-set-event-destination --configuration-set-name "$SES_CONFIG_SET" --region "$REGION" \
    --event-destination-name bounces-complaints \
    --event-destination "{\"Enabled\":true,\"MatchingEventTypes\":[\"BOUNCE\",\"COMPLAINT\",\"REJECT\"],\"SnsDestination\":{\"TopicArn\":\"${TOPIC_ARN}\"}}" >/dev/null 2>&1 \
    || echo "  event destination already exists"
  if [ -n "${ALERT_EMAIL:-}" ]; then
    aws sns subscribe --topic-arn "$TOPIC_ARN" --protocol email --notification-endpoint "$ALERT_EMAIL" --region "$REGION" >/dev/null \
      && echo "  subscribed $ALERT_EMAIL to $TOPIC_NAME (confirm the email AWS sends)"
  fi
  echo "  SES config set $SES_CONFIG_SET → SNS $TOPIC_NAME"

  # ses:SendEmail on THIS identity + From address only, consumed by the platform
  # service → bind to the 'platform' SA.
  grant_pod_identity platform ses \
    "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Sid\":\"SesSendEmail\",\"Effect\":\"Allow\",\"Action\":\"ses:SendEmail\",\"Resource\":\"${SES_IDENTITY_ARN}\",\"Condition\":{\"StringEquals\":{\"ses:FromAddress\":\"${EMAIL_FROM}\"}}}]}" \
    "ses:SendEmail on $DOMAIN, From=$EMAIL_FROM"
else
  echo "  EMAIL_ENABLED!=true — skipping SES resources"
fi

# CodePipeline run/cancel grant for the pipeline service (ALWAYS). Scoped to
# codepipeline actions on THIS account's pipelines — names vary per org/project,
# so a single-resource ARN isn't possible; the account+service scope is the
# tightest bound. Consumed by api/pipeline's pipeline-execution-service, which
# resolves the CodePipeline name from the registry and calls Start/Stop.
# Consumed by the pipeline service → bind to the 'pipeline' SA.
grant_pod_identity pipeline pipeline-exec \
  "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Sid\":\"CodePipelineExec\",\"Effect\":\"Allow\",\"Action\":[\"codepipeline:StartPipelineExecution\",\"codepipeline:StopPipelineExecution\",\"codepipeline:GetPipelineState\",\"codepipeline:GetPipelineExecution\"],\"Resource\":\"arn:aws:codepipeline:*:${ACCOUNT_ID}:*\"}]}" \
  "codepipeline Start/Stop on this account's pipelines"

# ---- AWS Marketplace billing provider --------------------------------------
# WITHOUT THIS, BILLING_PROVIDER=aws-marketplace CANNOT WORK. The provider
# (api/billing/src/providers/aws-marketplace-provider.ts) calls ResolveCustomer
# on sign-up, GetEntitlements to read what the customer bought, and
# BatchMeterUsage to report add-on consumption. docs/billing-providers.md lists
# `aws-marketplace` as a supported provider and both AWS .env.example files offer
# it, but no IAM grant for it existed — and worse, `billing` had NO Pod Identity
# association at all, so the pod had no AWS credentials to be denied with. An
# operator who selected the provider got a credential-resolution failure, not
# even an AccessDenied they could diagnose.
#
# `Resource: "*"` is not laziness: the AWS Marketplace Metering and Entitlement
# APIs do not support resource-level permissions. The bound is the ACTION list
# (three read/meter calls, no subscribe/modify) plus the product code the service
# sends — AWS rejects a mismatch, so another seller's product cannot be metered
# with these credentials.
#
# Only granted when the provider is actually selected, so a stub/stripe install
# keeps a billing SA with no AWS access at all.
if [ "${BILLING_PROVIDER:-stub}" = "aws-marketplace" ]; then
  [ -n "${AWS_MARKETPLACE_PRODUCT_CODE:-}" ] || {
    echo "ERROR: BILLING_PROVIDER=aws-marketplace needs AWS_MARKETPLACE_PRODUCT_CODE in .env." >&2
    echo "       See docs/billing-providers.md — the product code is what binds metering to YOUR listing." >&2
    exit 1; }
  grant_pod_identity billing marketplace \
    "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Sid\":\"AwsMarketplaceBilling\",\"Effect\":\"Allow\",\"Action\":[\"aws-marketplace:ResolveCustomer\",\"aws-marketplace:GetEntitlements\",\"aws-marketplace:BatchMeterUsage\"],\"Resource\":\"*\"}]}" \
    "aws-marketplace ResolveCustomer/GetEntitlements/BatchMeterUsage for $AWS_MARKETPLACE_PRODUCT_CODE"
else
  echo "  BILLING_PROVIDER=${BILLING_PROVIDER:-stub} — no AWS Marketplace grant for billing"
fi

# Plugin-image signing via KMS (PLUGIN_SIGNING_MODE=kms only). image-registry is
# the ONLY signer, so kms:Sign + kms:GetPublicKey on exactly the plugin-signing
# key goes to the 'image-registry' SA — never to 'plugin', whose pod shares a
# network namespace with the buildkitd that runs tenant Dockerfile steps (and
# whose egress deliberately cannot reach the Pod Identity agent). The app and
# every env var name the key BY ALIAS; the ARN is resolved here only because an
# IAM policy Resource must be a key ARN (aliases are not IAM resources), and it
# stays in a local shell variable — never written to .env or any config.
# image-registry reaches the agent + KMS via allow-image-registry-kms-egress
# (k8s/networkpolicy.yaml).
if [ "${PLUGIN_SIGNING_MODE:-local}" = "kms" ]; then
  case "${PLUGIN_SIGNING_KMS_KEY_ID:-}" in
    alias/?*) ;;
    *) echo "ERROR: PLUGIN_SIGNING_MODE=kms needs PLUGIN_SIGNING_KMS_KEY_ID=alias/<name> in .env (by alias, never ARN)" >&2; exit 1 ;;
  esac
  _plugin_signing_key_arn=$(aws kms describe-key --key-id "$PLUGIN_SIGNING_KMS_KEY_ID" --region "$REGION" \
    --query KeyMetadata.Arn --output text)
  # Plugin-image signing is performed by image-registry → bind to that SA.
  grant_pod_identity image-registry plugin-signing \
    "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Sid\":\"PluginImageSigning\",\"Effect\":\"Allow\",\"Action\":[\"kms:Sign\",\"kms:GetPublicKey\"],\"Resource\":\"${_plugin_signing_key_arn}\"}]}" \
    "kms:Sign + kms:GetPublicKey on $PLUGIN_SIGNING_KMS_KEY_ID"
  unset _plugin_signing_key_arn
else
  echo "  PLUGIN_SIGNING_MODE=local — no KMS grant for image-registry"
fi

# User-token signing via KMS (TOKEN_SIGNING_MODE=kms, the AWS default). This is
# the key that mints a PERSON's session, so the grant goes to 'platform' and to
# nothing else — no other workload may ever mint a user token. Same alias-only
# rule as plugin signing: an ARN embeds the AWS account id and platform's own
# validation rejects one, so the ARN is resolved here purely because an IAM
# policy Resource must be a key ARN, and it never leaves this shell.
# platform reaches the Pod Identity agent + KMS via k8s/networkpolicy.yaml,
# which already allows 169.254.170.23 for exactly this.
if [ "${TOKEN_SIGNING_MODE:-local}" = "kms" ]; then
  case "${TOKEN_SIGNING_KMS_KEY_ID:-}" in
    alias/?*) ;;
    *) echo "ERROR: TOKEN_SIGNING_MODE=kms needs TOKEN_SIGNING_KMS_KEY_ID=alias/<name> in .env (by alias, never ARN)." >&2
       echo "       This should be unreachable — pb_ensure_token_signing_kms_key validated it before Phase 1." >&2
       exit 1 ;;
  esac
  _token_signing_key_arn=$(aws kms describe-key --key-id "$TOKEN_SIGNING_KMS_KEY_ID" --region "$REGION" \
    --query KeyMetadata.Arn --output text)
  grant_pod_identity platform token-signing \
    "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Sid\":\"TokenSigning\",\"Effect\":\"Allow\",\"Action\":[\"kms:Sign\",\"kms:GetPublicKey\"],\"Resource\":\"${_token_signing_key_arn}\"}]}" \
    "kms:Sign + kms:GetPublicKey on $TOKEN_SIGNING_KMS_KEY_ID"
  unset _token_signing_key_arn
else
  echo "  TOKEN_SIGNING_MODE=local — no KMS grant for platform"
fi

# ---- kms:Decrypt for secret encryption -------------------------------------
# WITHOUT THIS THE KMS SECRET-ENCRYPTION MODES CANNOT WORK. Org-scoped secrets
# (AI provider keys, IdP client secrets, notification webhook secrets) are
# AES-256-GCM encrypted under a master that KMS WRAPS; recovering it is a
# `kms:Decrypt` call. Until now the only KMS grants in this stack were
# kms:Sign + kms:GetPublicKey for token/plugin signing, so both KMS modes —
# documented in docs/environment-variables.md and reachable from the step-up
# gated /admin/orgs/:orgId/kms-config API — failed at runtime on a grant nobody
# had written. api-core warms the provider at boot, so the symptom is now a
# startup abort rather than a 500 on the first secret read.
#
# Two modes, two scoping strategies, additive and independent:
#   - SINGLE-MASTER (SECRET_ENCRYPTION_KMS_KEY_ID): one key, known here, so the
#     grant is scoped to exactly its ARN.
#   - PER-ORG (SECRET_ENCRYPTION_PER_ORG_KMS=true): operators create a CMK per
#     org through the admin API, so no ARN exists at provision time. Scoped by
#     RESOURCE TAG instead of `Resource: "*"` — tag each per-org CMK
#     `pipeline-builder:secret-encryption=true` or Decrypt is denied.
#
# Both platform AND plugin get it: plugin encrypts org secrets of its own (the
# security-notification address and webhook secret) and initializes the same
# base provider. plugin never gets the per-org grant — the per-org resolver
# reads platform's Mongo, which plugin cannot reach, so it stays on the base.
if [ -n "${SECRET_ENCRYPTION_KMS_KEY_ID:-}" ]; then
  case "${SECRET_ENCRYPTION_KMS_KEY_ID}" in
    arn:*) echo "ERROR: SECRET_ENCRYPTION_KMS_KEY_ID must be alias/<name> or a key UUID, never an ARN (it embeds the AWS account id)." >&2; exit 1 ;;
  esac
  [ -n "${SECRET_ENCRYPTION_KMS_CIPHERTEXT:-}" ] || {
    echo "ERROR: SECRET_ENCRYPTION_KMS_KEY_ID is set but SECRET_ENCRYPTION_KMS_CIPHERTEXT is empty." >&2
    echo "       Generate and wrap the master:  head -c 32 /dev/urandom | base64" >&2
    echo "       then: aws kms encrypt --key-id $SECRET_ENCRYPTION_KMS_KEY_ID --plaintext <that> --output text --query CiphertextBlob" >&2
    exit 1; }
  _secret_key_arn=$(aws kms describe-key --key-id "$SECRET_ENCRYPTION_KMS_KEY_ID" --region "$REGION" \
    --query KeyMetadata.Arn --output text)
  for _sa in platform plugin; do
    grant_pod_identity "$_sa" "secret-encryption-${_sa}" \
      "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Sid\":\"SecretEncryptionUnwrap\",\"Effect\":\"Allow\",\"Action\":\"kms:Decrypt\",\"Resource\":\"${_secret_key_arn}\"}]}" \
      "kms:Decrypt on $SECRET_ENCRYPTION_KMS_KEY_ID (secret-encryption master)"
  done
  unset _secret_key_arn _sa
else
  echo "  SECRET_ENCRYPTION_KMS_KEY_ID unset — secrets use the plaintext SECRET_ENCRYPTION_KEY master"
fi

if [ "${SECRET_ENCRYPTION_PER_ORG_KMS:-false}" = true ]; then
  grant_pod_identity platform secret-encryption-per-org \
    "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Sid\":\"PerOrgSecretEncryptionUnwrap\",\"Effect\":\"Allow\",\"Action\":\"kms:Decrypt\",\"Resource\":\"*\",\"Condition\":{\"StringEquals\":{\"aws:ResourceTag/pipeline-builder:secret-encryption\":\"true\"}}}]}" \
    "kms:Decrypt on CMKs tagged pipeline-builder:secret-encryption=true (per-org masters)"
  echo "  NOTE: tag every per-org CMK \`pipeline-builder:secret-encryption=true\` or its Decrypt is denied."
else
  echo "  SECRET_ENCRYPTION_PER_ORG_KMS!=true — no per-org KMS grant"
fi

# ---- Phase 6: KEDA (plugin ScaledObject CRD) -------------------------------
fi
if pb_phase 6; then
log "Phase 6: KEDA operator"
# Auto Mode does NOT bundle KEDA; plugin.yaml's ScaledObject needs it.
pb_install_keda 180s

# ---- Phase 6a: metrics-server (HPA cpu/mem + KEDA cpu/mem triggers) ---------
fi
if pb_phase 6; then
log "Phase 6a: metrics-server"
# EKS Auto Mode does NOT bundle metrics-server (minikube ships it as an addon;
# ec2/local enable that addon — there is no equivalent here). Without it every
# Resource (cpu/memory) HPA and the plugin ScaledObject's cpu/mem triggers
# report <unknown> / FailedGetResourceMetric and never scale. The upstream
# manifest works on EKS as-is: kubelet serving certs are cluster-CA signed, so
# no --kubelet-insecure-tls patch is needed (unlike the minikube targets).
kubectl apply -f https://github.com/kubernetes-sigs/metrics-server/releases/download/v0.7.2/components.yaml
kubectl wait --for=condition=Available deployment/metrics-server -n kube-system --timeout=180s 2>/dev/null || echo "  metrics-server not ready yet (HPAs will reconcile once it is)"

# ---- Phase 6b: Istio ambient service mesh ----------------------------------
fi
if pb_phase 6; then
log "Phase 6b: Istio ambient mesh ($ISTIO_VERSION)"
# AWS recommends EKS Auto Mode + Istio ambient; the install itself is shared
# (pb_install_istio_ambient — see it for the ordering/Gateway API rationale).
#
# Auto Mode / multi-node specifics:
#   - istio-cni + ztunnel run as privileged host-net DaemonSets. Their default
#     tolerations (operator: Exists) already schedule them on every Auto Mode
#     node; if AWS's guidance pins different CNI conf/bin dirs for the managed
#     VPC CNI, add --set values.cni.cniConfDir=... / cniBinDir=... here.
#   - istiod HA: 2 replicas across AZs (pilot.replicaCount=2).
#   - Node SecurityGroups MUST allow node<->node HBONE :15008 (cross-node mTLS)
#     plus istiod xDS :15012 / webhook :15017. Auto Mode manages the node SG —
#     confirm these are permitted (see docs/aws-deployment.md).
# Auto-installs exactly $ISTIO_VERSION if the host has none or another version.
ensure_istioctl "$ISTIO_VERSION"
PB_MESH_ROLLOUT_TIMEOUT=180s pb_install_istio_ambient --set values.pilot.replicaCount=2
# PodDisruptionBudget so an AZ/node drain never takes istiod to zero.
kubectl -n istio-system create poddisruptionbudget istiod --selector=app=istiod --min-available=1 --dry-run=client -o yaml | kubectl apply -f - 2>/dev/null || true

echo "  Istio ambient installed (HA istiod + ztunnel + istio-cni)"

# ---- Phase 7: apply workloads (kustomize overlay) --------------------------
fi
if pb_phase 7; then
log "Phase 7: apply workloads"
# Supply-chain gate (ENFORCED): every ghcr image the manifests reference must
# carry a valid cosign signature from this repo's release workflow before we run
# it. Refuses the deploy on an unsigned/look-alike image. Break-glass:
# SKIP_IMAGE_SIGNATURE_VERIFY=1. EKS pulls the CI-published (signed) images.
bash "$BIN_DIR/verify-image-signatures.sh"
# Only our deploy tokens are expanded (sed), so $host / $1$... in the inline
# nginx/pgbouncer configmaps survive. istiod gate + apply + mesh re-enrollment
# restart: pb_apply_manifests (shared with minikube/ec2). No LEAN on eks.
# The kube-dns ClusterIP, for networkpolicy.yaml's DNS egress rule. That rule
# needs an EXPLICIT ipBlock (see the long comment there: a `to`-less allow does
# not override the per-app `except` denies under the VPC CNI policy controller),
# and the service CIDR is a cluster creation parameter, so it is READ, never
# assumed. Fail loudly: a wrong or empty value here takes DNS down for every pod.
PB_DNS_CLUSTER_IP=$($PB_KUBECTL -n kube-system get svc kube-dns -o jsonpath='{.spec.clusterIP}' 2>/dev/null)
case "$PB_DNS_CLUSTER_IP" in
  *.*.*.*) ;;
  *) echo "ERROR: could not read the kube-dns ClusterIP (got '$PB_DNS_CLUSTER_IP') — networkpolicy.yaml's DNS egress rule needs it. Is the coredns addon installed (cluster/addons.yaml)?" >&2; exit 1 ;;
esac
export PB_DNS_CLUSTER_IP
echo "  DNS egress allowed to the cluster resolver: $PB_DNS_CLUSTER_IP"
pb_apply_manifests "$K8S_DIR" \
  "s|[\$]{EFS_FILESYSTEM_ID}|${EFS_FILESYSTEM_ID}|g; s|[\$]{ACM_CERT_ARN}|${ACM_CERT_ARN}|g; s|[\$]{DOMAIN}|${DOMAIN}|g; s|[\$]{ALB_SCHEME}|${ALB_SCHEME}|g; s|[\$]{BUILDKIT_MEMORY_LIMIT}|${BUILDKIT_MEMORY_LIMIT}|g; s|[\$]{VPC_CIDR}|${PB_VPC_CIDR}|g; s|[\$]{DNS_CLUSTER_IP}|${PB_DNS_CLUSTER_IP}|g" \
  0

# Base plugin images are seeded by init-platform.sh (the post-deploy step),
# the same as ec2/minikube — not here. See the final hint below.

# ---- Phase 8: Route 53 alias → ALB -----------------------------------------
fi
if pb_phase 8; then
log "Phase 8: Route 53 record → ALB"
echo "  waiting for the ALB Ingress address..."
ALB_HOST=""
for _ in $(seq 1 60); do
  ALB_HOST=$(kubectl get ingress pb-ingress -n "$NAMESPACE" -o jsonpath='{.status.loadBalancer.ingress[0].hostname}' 2>/dev/null || true)
  [ -n "$ALB_HOST" ] && break; sleep 10
done
if [ -n "$ALB_HOST" ]; then
  # The ALB can be eventually-consistent in elbv2 the instant the Ingress publishes its
  # hostname, so poll until its CanonicalHostedZoneId resolves to a real zone (Z...). Without
  # this guard a transient `None` would be submitted as the alias HostedZoneId and `set -e`
  # would abort the whole deploy at the very last step.
  ALB_ZONE=""
  for _ in $(seq 1 12); do
    ALB_ZONE=$(aws elbv2 describe-load-balancers --region "$REGION" \
      --query "LoadBalancers[?DNSName=='$ALB_HOST'].CanonicalHostedZoneId | [0]" --output text 2>/dev/null || true)
    case "$ALB_ZONE" in Z*) break ;; *) ALB_ZONE=""; sleep 5 ;; esac
  done
  if [ -n "$ALB_ZONE" ]; then
    aws route53 change-resource-record-sets --hosted-zone-id "$HOSTED_ZONE_ID" \
      --change-batch "{\"Changes\":[{\"Action\":\"UPSERT\",\"ResourceRecordSet\":{\"Name\":\"$DOMAIN\",\"Type\":\"A\",\"AliasTarget\":{\"HostedZoneId\":\"$ALB_ZONE\",\"DNSName\":\"$ALB_HOST\",\"EvaluateTargetHealth\":false}}}]}" >/dev/null
    echo "  $DOMAIN → $ALB_HOST"
  else
    echo "  WARNING: ALB $ALB_HOST not yet resolvable in elbv2 — create the Route 53 alias manually once it is." >&2
  fi
else
  echo "  WARNING: the ALB Ingress had no address yet — create the Route 53 alias once it provisions." >&2
fi

# ---- Phase 9: initialize the platform (parity with ec2 bootstrap Phase 10) -
# AUTO_INIT (default true) runs init-platform.sh once the workloads are applied:
# registers the admin user and loads plugins + compliance rules + sample pipeline templates
# (building the CodeBuild bootstrap image and the plugin images first). Every prompt
# is env-gated to "y" so it runs non-interactively, and it port-forwards to nginx via
# kubectl — so this works in BOTH deploy modes (the internal ALB isn't reachable from
# here in private mode) without waiting on ALB/DNS warm-up. init-platform self-waits on
# platform health, so it's fine that Phase 7's pods may still be starting. Never fatal:
# a non-zero exit is logged so the operator can re-run by hand. --no-auto-init skips it.
# NOTE: the plugin image builds need Docker + yq on THIS machine and dominate the runtime.
fi
if pb_phase 9; then
log "Phase 9: initialize platform (AUTO_INIT=$AUTO_INIT)"
INIT_PLATFORM="$DEPLOY_DIR/../../bin/init-platform.sh"
if [ "$AUTO_INIT" = true ]; then
  # Resolve the initial admin password: use an operator-supplied value
  # (PLATFORM_PASSWORD / ADMIN_PASSWORD) if present, otherwise generate a strong
  # RANDOM secret so the shared dev default is NEVER used. Write it to a root-only
  # creds file for retrieval — the password itself is never echoed.
  _admin_pw="${PLATFORM_PASSWORD:-${ADMIN_PASSWORD:-}}"
  if [ -z "$_admin_pw" ]; then
    _admin_pw="$(openssl rand -base64 24 | tr -d '=+/' | cut -c1-32)"
    _cred_file="$DEPLOY_DIR/.admin-credentials"
    ( umask 177; printf 'identifier=%s\npassword=%s\n' "${PLATFORM_IDENTIFIER:-admin@internal}" "$_admin_pw" > "$_cred_file" )
    echo "  generated a random initial admin password → $_cred_file (chmod 600; not echoed)"
  fi
  # Force the kubectl port-forward path: `env -u PLATFORM_BASE_URL` strips any value
  # the operator exported (e.g. https://<domain>), which the eks init branch would
  # otherwise honor — and the public URL almost never resolves THIS instant (the Route 53
  # alias was created seconds ago in Phase 8, and DNS/negative-cache lags). Port-forward
  # goes straight through the API server, so init works regardless of DNS/ALB warm-up and
  # in both deploy modes (the internal ALB isn't reachable from here in private mode).
  env -u PLATFORM_BASE_URL \
    BUILD_BOOTSTRAP=y LOAD_PLUGINS=y LOAD_COMPLIANCE=y LOAD_TEMPLATES=y NAMESPACE="$NAMESPACE" \
    PLATFORM_PASSWORD="$_admin_pw" \
    bash "$INIT_PLATFORM" --continue-on-build-failure eks \
    && AUTO_INIT_OK=true \
    || echo "  WARNING: auto-init exited non-zero — re-run by hand (the LOAD_* gates are REQUIRED; they default to OFF): env -u PLATFORM_BASE_URL BUILD_BOOTSTRAP=y LOAD_PLUGINS=y LOAD_COMPLIANCE=y LOAD_TEMPLATES=y ./deploy/bin/init-platform.sh eks" >&2
else
  echo "  skipped (AUTO_INIT=false / --no-auto-init)"
fi

# ---- Phase 10: post-provision smoke checks (non-fatal) ----------------------
# Test alert through Alertmanager -> Slack, a test email through platform,
# a CodePipeline credential dry-run from the pipeline pod, and a probe that a
# connection the NetworkPolicies deny really is denied (Auto Mode ignores
# NetworkPolicy unless Phase 1b's ConfigMap + NodeClass took effect).
fi
if pb_phase 10; then
log "Phase 10: post-provision smoke checks"
NAMESPACE="$NAMESPACE" ALERT_EMAIL="${ALERT_EMAIL:-}" bash "$BIN_DIR/post-provision-smoke.sh" k8s --aws || true
fi

# ---- Summary ----------------------------------------------------------------
# OUTSIDE the phase guards: a partial run (bin/startup.sh, or --from-phase) still
# needs to say what it did and where things are. Only a run that reached the last
# phase may call itself a complete deploy — otherwise this would announce
# "deploy complete" after re-applying a ConfigMap.
echo ""
if pb_phase 1 && pb_phase 10; then
  echo "=== EKS deploy complete. URL: https://${DOMAIN} ==="
else
  echo "=== EKS phases ${PHASE_FROM}-${PHASE_TO} applied. URL: https://${DOMAIN} ==="
fi
DOMAIN="$DOMAIN" pb_dev_tools eks
# Report the OUTCOME, not the flag. This used to branch on "$AUTO_INIT" alone, so a
# deploy whose auto-init had just failed still printed "Platform initialized" — the
# operator had no reason to look, and the platform had no plugins, templates or
# compliance rules.
if ! pb_phase 9; then
  # Phase 9 did not run in this invocation, so this says nothing about whether
  # the platform IS initialized — only that this run did not touch it. Claiming
  # "NOT INITIALIZED" here would be a false alarm after every bin/startup.sh.
  echo "    Platform init not run in this invocation (phases ${PHASE_FROM}-${PHASE_TO})."
  echo "    If this is a fresh cluster:  env -u PLATFORM_BASE_URL BUILD_BOOTSTRAP=y LOAD_PLUGINS=y LOAD_COMPLIANCE=y LOAD_TEMPLATES=y ./deploy/bin/init-platform.sh eks"
elif [ "$AUTO_INIT" = true ] && [ "$AUTO_INIT_OK" = true ]; then
  echo "    Platform initialized (admin + plugins/compliance/pipelines)."
  echo "    Re-run the loads any time: env -u PLATFORM_BASE_URL BUILD_BOOTSTRAP=y LOAD_PLUGINS=y LOAD_COMPLIANCE=y LOAD_TEMPLATES=y ./deploy/bin/init-platform.sh eks"
elif [ "$AUTO_INIT" = true ]; then
  # Says INCOMPLETE, not "nothing loaded". init runs in stages — admin user,
  # then plugins, then templates, then compliance — and the plugin stage now also
  # verifies that the accepted uploads actually BUILT. A failure in a later stage
  # leaves the earlier ones done, so claiming "No admin user, plugins, templates
  # or compliance rules" would send the operator to re-run work that succeeded.
  # The init output above says which stage stopped.
  echo "    INITIALIZATION INCOMPLETE — auto-init exited non-zero above. Read its output for the stage that failed:"
  echo "      a blocked plugin BUILD (PLUGIN_VULN_GATE) leaves the admin user, templates and compliance rules in place."
  echo "    Run it by hand:            env -u PLATFORM_BASE_URL BUILD_BOOTSTRAP=y LOAD_PLUGINS=y LOAD_COMPLIANCE=y LOAD_TEMPLATES=y ./deploy/bin/init-platform.sh eks"
else
  echo "    Initialize the platform:   env -u PLATFORM_BASE_URL BUILD_BOOTSTRAP=y LOAD_PLUGINS=y LOAD_COMPLIANCE=y LOAD_TEMPLATES=y ./deploy/bin/init-platform.sh eks   # port-forwards nginx; without the LOAD_* gates only the admin user is created"
fi
