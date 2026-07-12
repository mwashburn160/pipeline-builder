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
# Shared Secret/ConfigMap creators (deploy/bin/k8s-resources.sh) — plain kubectl, this namespace.
PB_KUBECTL="kubectl"; PB_NAMESPACE="$NAMESPACE"
. "$SCRIPT_DIR/../../../bin/k8s-resources.sh"

echo "=== EKS Auto Mode deploy: cluster=$CLUSTER_NAME region=$REGION mode=$DEPLOY_MODE k8s=$EKS_VERSION domain=$DOMAIN ==="

# eksctl: install the latest binary if it's not already on PATH (a prereq, like kubectl).
if ! command -v eksctl >/dev/null 2>&1; then
  echo "  eksctl not found — installing the latest binary..."
  case "$(uname -m)" in x86_64|amd64) _arch=amd64 ;; aarch64|arm64) _arch=arm64 ;; *) _arch=amd64 ;; esac
  _bindir=/usr/local/bin; [ -w "$_bindir" ] || _bindir="$HOME/.local/bin"; mkdir -p "$_bindir"
  curl -fsSL "https://github.com/eksctl-io/eksctl/releases/latest/download/eksctl_$(uname -s)_${_arch}.tar.gz" | tar xz -C "$_bindir" eksctl
  chmod +x "$_bindir/eksctl"
  case ":$PATH:" in *":$_bindir:"*) ;; *) PATH="$_bindir:$PATH"; export PATH ;; esac
  echo "  installed eksctl to $_bindir"
fi

# ---- Phase 1: cluster (Auto Mode) ------------------------------------------
log "Phase 1: EKS Auto Mode cluster"
if eksctl get cluster --name "$CLUSTER_NAME" --region "$REGION" >/dev/null 2>&1; then
  echo "  cluster $CLUSTER_NAME exists — skipping create"
else
  envsubst < "$DEPLOY_DIR/cluster/cluster.yaml" | eksctl create cluster -f -
fi
aws eks update-kubeconfig --name "$CLUSTER_NAME" --region "$REGION"
VPC_ID=$(aws eks describe-cluster --name "$CLUSTER_NAME" --region "$REGION" --query 'cluster.resourcesVpcConfig.vpcId' --output text)
CLUSTER_SG=$(aws eks describe-cluster --name "$CLUSTER_NAME" --region "$REGION" --query 'cluster.resourcesVpcConfig.clusterSecurityGroupId' --output text)
echo "  vpc=$VPC_ID cluster-sg=$CLUSTER_SG"

# ---- Phase 2: EFS (RWX volumes: registry, loki, plugin uploads) ------------
log "Phase 2: EFS filesystem"
# Idempotent via a creation token tied to the cluster name.
EFS_FILESYSTEM_ID=$(aws efs describe-file-systems --region "$REGION" \
  --query "FileSystems[?CreationToken=='pb-${CLUSTER_NAME}'].FileSystemId | [0]" --output text 2>/dev/null || true)
if [ -z "$EFS_FILESYSTEM_ID" ] || [ "$EFS_FILESYSTEM_ID" = None ]; then
  EFS_FILESYSTEM_ID=$(aws efs create-file-system --region "$REGION" --creation-token "pb-${CLUSTER_NAME}" \
    --encrypted --tags "Key=Name,Value=${CLUSTER_NAME}-efs" "Key=Project,Value=pipeline-builder" \
    --query FileSystemId --output text)
  echo "  created EFS $EFS_FILESYSTEM_ID — waiting for 'available'..."
  until [ "$(aws efs describe-file-systems --file-system-id "$EFS_FILESYSTEM_ID" --region "$REGION" --query 'FileSystems[0].LifeCycleState' --output text)" = available ]; do sleep 5; done
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
  [ -n "$GHCR_TOKEN" ] && sed -i.bak "s|GHCR_TOKEN=|GHCR_TOKEN=${GHCR_TOKEN}|" "$ENV_FILE"
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
# Source so secret values match exactly what ec2 startup.sh consumes.
set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a

kubectl create namespace "$NAMESPACE" --dry-run=client -o yaml | kubectl apply -f -

# app-env ConfigMap from .env (non-comment, non-blank; ${VAR} refs expanded).
# Cumulative cleanup trap: also removes the registry-JWT temp dir (set below), so the
# private key can't leak in /tmp if `set -e` aborts between its mktemp and its rm.
CLEAN_ENV=$(mktemp); CERT_DIR=""
trap 'rm -f "$CLEAN_ENV"; [ -n "$CERT_DIR" ] && rm -rf "$CERT_DIR"' EXIT
grep -v '^\s*#' "$ENV_FILE" | grep -v '^\s*$' | envsubst > "$CLEAN_ENV"
pb_app_env_configmap "$CLEAN_ENV"
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
rm -rf "$CERT_DIR"

# Config-file ConfigMaps + MongoDB keyfile (same set the ec2 manifests expect).
pb_create_config_maps "$DEPLOY_DIR" "$CONFIG_DIR" "$NGINX_DIR"

# ---- Phase 5: SES email + Pod Identity IAM ---------------------------------
# Parity with the ec2 target's in-stack SES (template.yaml): Easy-DKIM identity +
# Route 53 CNAMEs, a configuration set, a bounce/complaint SNS topic, and a
# Pod Identity association carrying policies SCOPED to exactly what the pods need
# (ses:SendEmail on this identity; codepipeline:Start/StopPipelineExecution on
# this account's pipelines) — never the *FullAccess managed policies. Idempotent.
#
# The whole namespace shares the 'default' ServiceAccount, and Pod Identity binds
# ONE IAM role per SA — so a single association carries EVERY policy the pods
# need. SES is conditional (--no-email); the CodePipeline-exec grant is always
# applied because the pipeline service's run/cancel endpoints
# (api/pipeline pipeline-execution-service → Start/StopPipelineExecution) need it.
log "Phase 5: SES email + Pod Identity IAM"
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
POLICY_ARNS=()  # accumulated below; attached to the 'default' SA role at the end

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
  POLICY_ARNS+=("$SES_POLICY_ARN")
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
  echo "  created scoped IAM policy $PIPE_POLICY_NAME (codepipeline Start/Stop on account $ACCOUNT_ID)"
else
  echo "  reusing IAM policy $PIPE_POLICY_NAME"
fi
POLICY_ARNS+=("$PIPE_POLICY_ARN")

# Attach every collected policy to the 'default' SA's Pod Identity role. One
# association per SA: create it (carrying all policies) if absent, else attach
# each policy to the existing role — attach-role-policy is idempotent, so this
# also back-fills the CodePipeline policy onto a role a prior SES-only run made.
# Requires the Pod Identity agent (bundled with EKS Auto Mode).
POLICY_CSV=$(IFS=,; echo "${POLICY_ARNS[*]}")
EXISTING_ASSOC=$(aws eks list-pod-identity-associations --cluster-name "$CLUSTER_NAME" --region "$REGION" \
  --namespace "$NAMESPACE" --query "associations[?serviceAccount=='default'].associationId | [0]" --output text 2>/dev/null || true)
if [ -z "$EXISTING_ASSOC" ] || [ "$EXISTING_ASSOC" = "None" ]; then
  eksctl create podidentityassociation --cluster "$CLUSTER_NAME" --region "$REGION" \
    --namespace "$NAMESPACE" --service-account-name default \
    --permission-policy-arns "$POLICY_CSV" 2>/dev/null \
    && echo "  Pod Identity associated (default SA → ${#POLICY_ARNS[@]} scoped policies)" \
    || echo "  Pod Identity association failed — check: eksctl get podidentityassociation --cluster $CLUSTER_NAME"
else
  ASSOC_ROLE_ARN=$(aws eks describe-pod-identity-association --cluster-name "$CLUSTER_NAME" --region "$REGION" \
    --association-id "$EXISTING_ASSOC" --query "association.roleArn" --output text 2>/dev/null || true)
  ASSOC_ROLE_NAME="${ASSOC_ROLE_ARN##*/}"
  if [ -n "$ASSOC_ROLE_NAME" ] && [ "$ASSOC_ROLE_NAME" != "None" ]; then
    for arn in "${POLICY_ARNS[@]}"; do
      aws iam attach-role-policy --role-name "$ASSOC_ROLE_NAME" --policy-arn "$arn" >/dev/null 2>&1 || true
    done
    echo "  Pod Identity association exists (default SA); ensured ${#POLICY_ARNS[@]} policies on role $ASSOC_ROLE_NAME"
  else
    echo "  Pod Identity association exists but role lookup failed — attach $PIPE_POLICY_NAME manually"
  fi
fi

# ---- Phase 6: KEDA (plugin ScaledObject CRD) -------------------------------
log "Phase 6: KEDA operator"
# plugin.yaml ships a keda.sh/v1alpha1 ScaledObject; Auto Mode does NOT bundle
# KEDA, so install the CRDs+operator first or the manifest apply below fails with
# "no matches for kind ScaledObject" (mirrors ec2/bin/startup.sh).
kubectl apply --server-side -f https://github.com/kedacore/keda/releases/download/v2.16.1/keda-2.16.1.yaml
kubectl wait --for=condition=Available deployment/keda-operator -n keda --timeout=180s 2>/dev/null || echo "  KEDA not ready yet (the ScaledObject will reconcile once it is)"

# ---- Phase 7: apply workloads (kustomize overlay) --------------------------
log "Phase 7: apply workloads"
# Restricted envsubst: ONLY our deploy tokens are expanded, so $host / $1$... in
# the inline nginx/pgbouncer configmaps are left intact.
kubectl kustomize "$K8S_DIR" \
  | envsubst '${EFS_FILESYSTEM_ID} ${ACM_CERT_ARN} ${DOMAIN} ${ALB_SCHEME} ${BUILDKIT_MEMORY_LIMIT}' \
  | kubectl apply -f -

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
# registers the admin user and loads plugins + compliance rules + sample pipelines
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
  # Force the kubectl port-forward path: `env -u PLATFORM_BASE_URL` strips any value
  # the operator exported (e.g. https://<domain>), which the eks init branch would
  # otherwise honor — and the public URL almost never resolves THIS instant (the Route 53
  # alias was created seconds ago in Phase 8, and DNS/negative-cache lags). Port-forward
  # goes straight through the API server, so init works regardless of DNS/ALB warm-up and
  # in both deploy modes (the internal ALB isn't reachable from here in private mode).
  env -u PLATFORM_BASE_URL \
    BUILD_BOOTSTRAP=y LOAD_PLUGINS=y LOAD_COMPLIANCE=y LOAD_PIPELINES=y NAMESPACE="$NAMESPACE" \
    bash "$INIT_PLATFORM" --continue-on-build-failure eks \
    || echo "  WARNING: auto-init exited non-zero — re-run by hand: env -u PLATFORM_BASE_URL ./deploy/bin/init-platform.sh eks" >&2
else
  echo "  skipped (AUTO_INIT=false / --no-auto-init)"
fi

echo ""
echo "=== EKS deploy complete. URL: https://${DOMAIN} ==="
if [ "$AUTO_INIT" = true ]; then
  echo "    Platform initialized (admin + plugins/compliance/pipelines)."
  echo "    Re-run the loads any time: ./deploy/bin/init-platform.sh eks"
else
  echo "    Initialize the platform:   ./deploy/bin/init-platform.sh eks   # register admin + load plugins (port-forwards nginx)"
fi
