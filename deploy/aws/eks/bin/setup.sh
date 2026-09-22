#!/usr/bin/env bash
set -euo pipefail
# =============================================================================
# Pipeline Builder — EKS Auto Mode deploy orchestration
# =============================================================================
# Stands up the EKS Auto Mode cluster and deploys the platform onto it, reusing
# this target's standalone k8s manifests (../k8s) and the same secret/configmap
# layout the ec2 target uses (so the service images need no per-target changes).
#
#   ./bin/setup.sh --domain pipeline-builder.com --hosted-zone-id Z... --region us-east-1
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
BUILDKIT_MEMORY_LIMIT="${BUILDKIT_MEMORY_LIMIT:-6144Mi}"  # buildkitd sidecar memory limit (build cgroup); raise for heavy builds, bound by node memory
# Email (SES) — provisioned by default (parity with ec2); --no-email opts out.
EMAIL_ENABLED="${EMAIL_ENABLED:-true}"
EMAIL_FROM="${EMAIL_FROM:-}"                     # default noreply@<domain> (set after parse)
EMAIL_FROM_NAME="${EMAIL_FROM_NAME:-pipeline-builder}"
CREATE_SES_IDENTITY="${CREATE_SES_IDENTITY:-true}"  # --no-create-ses-identity when domain is already a verified identity
ALERT_EMAIL="${ALERT_EMAIL:-}"

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
    --eks-version) EKS_VERSION="$2"; shift 2 ;;
    --auto-init) AUTO_INIT=true; shift ;;
    --no-auto-init) AUTO_INIT=false; shift ;;
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
pb_ensure_token_signing_kms_key "$CLUSTER_NAME" || exit 1

# ---- Phase 1: cluster (Auto Mode) ------------------------------------------
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
log "Phase 1c: cluster addons"
envsubst < "$DEPLOY_DIR/cluster/addons.yaml" | eksctl create addon -f - 2>&1 \
  | grep -viE "already exists|created addon" || true
echo "  addons applied (aws-efs-csi-driver)"

VPC_ID=$(aws eks describe-cluster --name "$CLUSTER_NAME" --region "$REGION" --query 'cluster.resourcesVpcConfig.vpcId' --output text)
CLUSTER_SG=$(aws eks describe-cluster --name "$CLUSTER_NAME" --region "$REGION" --query 'cluster.resourcesVpcConfig.clusterSecurityGroupId' --output text)
echo "  vpc=$VPC_ID cluster-sg=$CLUSTER_SG"

# ---- Phase 2: EFS (RWX volume: plugin uploads) -----------------------------
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
log "Phase 4: secrets + configmaps"
# Shared .env secret generator (deploy/bin/gen-env-secrets.sh).
. "$SCRIPT_DIR/../../../bin/gen-env-secrets.sh"
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
# Source so secret values match exactly what ec2 startup.sh consumes.
set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a

# ALERT DELIVERY PRE-FLIGHT. Fails the provision while a Slack webhook URL is
# still a placeholder — alerting that 404s into nothing is indistinguishable
# from healthy alerting, so it has to be caught here and not at 3am.
pb_check_alert_delivery "$ENV_FILE" "$(pb_shared_dir)/config/alertmanager/alertmanager.yml" || exit 1

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
      aws iam attach-role-policy --role-name "$role_name" --policy-arn "$policy_arn" >/dev/null 2>&1 || true
      echo "  Pod Identity association exists ($sa SA); ensured ${policy_arn##*/} on role $role_name"
    else
      echo "  Pod Identity association exists for $sa but role lookup failed — attach ${policy_arn##*/} manually"
    fi
  fi
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

  # Scoped IAM policy (ses:SendEmail on THIS identity + From address only) — item 3.
  SES_POLICY_NAME="${CLUSTER_NAME}-eks-ses"
  SES_POLICY_ARN="arn:aws:iam::${ACCOUNT_ID}:policy/${SES_POLICY_NAME}"
  if ! aws iam get-policy --policy-arn "$SES_POLICY_ARN" >/dev/null 2>&1; then
    aws iam create-policy --policy-name "$SES_POLICY_NAME" \
      --policy-document "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Sid\":\"SesSendEmail\",\"Effect\":\"Allow\",\"Action\":\"ses:SendEmail\",\"Resource\":\"${SES_IDENTITY_ARN}\",\"Condition\":{\"StringEquals\":{\"ses:FromAddress\":\"${EMAIL_FROM}\"}}}]}" >/dev/null
    echo "  created scoped IAM policy $SES_POLICY_NAME (ses:SendEmail on $DOMAIN, From=$EMAIL_FROM)"
  else
    echo "  reusing IAM policy $SES_POLICY_NAME (edit it if --email-from changed)"
  fi
  # SES is consumed by the platform service → bind to the 'platform' SA.
  associate_pod_identity platform "$SES_POLICY_ARN"
else
  echo "  EMAIL_ENABLED!=true — skipping SES resources"
fi

# CodePipeline run/cancel grant for the pipeline service (ALWAYS). Scoped to
# codepipeline actions on THIS account's pipelines — names vary per org/project,
# so a single-resource ARN isn't possible; the account+service scope is the
# tightest bound. Consumed by api/pipeline's pipeline-execution-service, which
# resolves the CodePipeline name from the registry and calls Start/Stop.
PIPE_POLICY_NAME="${CLUSTER_NAME}-eks-pipeline-exec"
PIPE_POLICY_ARN="arn:aws:iam::${ACCOUNT_ID}:policy/${PIPE_POLICY_NAME}"
if ! aws iam get-policy --policy-arn "$PIPE_POLICY_ARN" >/dev/null 2>&1; then
  aws iam create-policy --policy-name "$PIPE_POLICY_NAME" \
    --policy-document "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Sid\":\"CodePipelineExec\",\"Effect\":\"Allow\",\"Action\":[\"codepipeline:StartPipelineExecution\",\"codepipeline:StopPipelineExecution\",\"codepipeline:GetPipelineState\",\"codepipeline:GetPipelineExecution\"],\"Resource\":\"arn:aws:codepipeline:*:${ACCOUNT_ID}:*\"}]}" >/dev/null
  echo "  created scoped IAM policy $PIPE_POLICY_NAME (codepipeline Start/Stop on this account's pipelines)"
else
  echo "  reusing IAM policy $PIPE_POLICY_NAME"
fi
# CodePipeline exec is consumed by the pipeline service → bind to the 'pipeline' SA.
associate_pod_identity pipeline "$PIPE_POLICY_ARN"

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
  SIGN_POLICY_NAME="${CLUSTER_NAME}-eks-plugin-signing"
  SIGN_POLICY_ARN="arn:aws:iam::${ACCOUNT_ID}:policy/${SIGN_POLICY_NAME}"
  if ! aws iam get-policy --policy-arn "$SIGN_POLICY_ARN" >/dev/null 2>&1; then
    aws iam create-policy --policy-name "$SIGN_POLICY_NAME" \
      --policy-document "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Sid\":\"PluginImageSigning\",\"Effect\":\"Allow\",\"Action\":[\"kms:Sign\",\"kms:GetPublicKey\"],\"Resource\":\"${_plugin_signing_key_arn}\"}]}" >/dev/null
    echo "  created scoped IAM policy $SIGN_POLICY_NAME (kms:Sign + kms:GetPublicKey on $PLUGIN_SIGNING_KMS_KEY_ID)"
  else
    echo "  reusing IAM policy $SIGN_POLICY_NAME (edit it if $PLUGIN_SIGNING_KMS_KEY_ID now targets a different key)"
  fi
  unset _plugin_signing_key_arn
  # Plugin-image signing is performed by image-registry → bind to the 'image-registry' SA.
  associate_pod_identity image-registry "$SIGN_POLICY_ARN"
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
  TOKEN_POLICY_NAME="${CLUSTER_NAME}-eks-token-signing"
  TOKEN_POLICY_ARN="arn:aws:iam::${ACCOUNT_ID}:policy/${TOKEN_POLICY_NAME}"
  if ! aws iam get-policy --policy-arn "$TOKEN_POLICY_ARN" >/dev/null 2>&1; then
    aws iam create-policy --policy-name "$TOKEN_POLICY_NAME" \
      --policy-document "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Sid\":\"TokenSigning\",\"Effect\":\"Allow\",\"Action\":[\"kms:Sign\",\"kms:GetPublicKey\"],\"Resource\":\"${_token_signing_key_arn}\"}]}" >/dev/null
    echo "  created scoped IAM policy $TOKEN_POLICY_NAME (kms:Sign + kms:GetPublicKey on $TOKEN_SIGNING_KMS_KEY_ID)"
  else
    echo "  reusing IAM policy $TOKEN_POLICY_NAME (edit it if $TOKEN_SIGNING_KMS_KEY_ID now targets a different key)"
  fi
  unset _token_signing_key_arn
  associate_pod_identity platform "$TOKEN_POLICY_ARN"
else
  echo "  TOKEN_SIGNING_MODE=local — no KMS grant for platform"
fi

# ---- Phase 6: KEDA (plugin ScaledObject CRD) -------------------------------
log "Phase 6: KEDA operator"
# Auto Mode does NOT bundle KEDA; plugin.yaml's ScaledObject needs it.
pb_install_keda 180s

# ---- Phase 6a: metrics-server (HPA cpu/mem + KEDA cpu/mem triggers) ---------
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
log "Phase 7: apply workloads"
# Supply-chain gate (ENFORCED): every ghcr image the manifests reference must
# carry a valid cosign signature from this repo's release workflow before we run
# it. Refuses the deploy on an unsigned/look-alike image. Break-glass:
# SKIP_IMAGE_SIGNATURE_VERIFY=1. EKS pulls the CI-published (signed) images.
bash "$BIN_DIR/verify-image-signatures.sh"
# Only our deploy tokens are expanded (sed), so $host / $1$... in the inline
# nginx/pgbouncer configmaps survive. istiod gate + apply + mesh re-enrollment
# restart: pb_apply_manifests (shared with minikube/ec2). No LEAN on eks.
pb_apply_manifests "$K8S_DIR" \
  "s|[\$]{EFS_FILESYSTEM_ID}|${EFS_FILESYSTEM_ID}|g; s|[\$]{ACM_CERT_ARN}|${ACM_CERT_ARN}|g; s|[\$]{DOMAIN}|${DOMAIN}|g; s|[\$]{ALB_SCHEME}|${ALB_SCHEME}|g; s|[\$]{BUILDKIT_MEMORY_LIMIT}|${BUILDKIT_MEMORY_LIMIT}|g" \
  0

# Base plugin images are seeded by init-platform.sh (the post-deploy step),
# the same as ec2/minikube — not here. See the final hint below.

# ---- Phase 8: Route 53 alias → ALB -----------------------------------------
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
    || echo "  WARNING: auto-init exited non-zero — re-run by hand: env -u PLATFORM_BASE_URL ./deploy/bin/init-platform.sh eks" >&2
else
  echo "  skipped (AUTO_INIT=false / --no-auto-init)"
fi

# ---- Phase 10: post-provision smoke checks (non-fatal) ----------------------
# Test alert through Alertmanager -> Slack, a test email through platform,
# a CodePipeline credential dry-run from the pipeline pod, and a probe that a
# connection the NetworkPolicies deny really is denied (Auto Mode ignores
# NetworkPolicy unless Phase 1b's ConfigMap + NodeClass took effect).
log "Phase 10: post-provision smoke checks"
NAMESPACE="$NAMESPACE" ALERT_EMAIL="${ALERT_EMAIL:-}" bash "$BIN_DIR/post-provision-smoke.sh" k8s --aws || true

echo ""
echo "=== EKS deploy complete. URL: https://${DOMAIN} ==="
if [ "$AUTO_INIT" = true ]; then
  echo "    Platform initialized (admin + plugins/compliance/pipelines)."
  echo "    Re-run the loads any time: ./deploy/bin/init-platform.sh eks"
else
  echo "    Initialize the platform:   ./deploy/bin/init-platform.sh eks   # register admin + load plugins (port-forwards nginx)"
fi
