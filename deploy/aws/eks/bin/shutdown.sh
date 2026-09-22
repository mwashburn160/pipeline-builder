#!/usr/bin/env bash
# SHELL OPTIONS — the missing `-e` is DELIBERATE, not an oversight. Teardown has
# to keep going past the first failure: a partially-provisioned or
# already-partly-deleted stack leaves some of these resources absent, and
# aborting on the first "not found" would strand every resource after it —
# exactly the cost (an orphaned ALB, EFS or node group billing indefinitely)
# that this script exists to avoid. Each step reports its own outcome instead.
# `-u` and `pipefail` still apply.
set -uo pipefail
# =============================================================================
# Pipeline Builder — EKS Auto Mode teardown
# =============================================================================
# Destroys what bin/setup.sh created, in dependency order so nothing leaks:
#   1. Ingress  → lets the AWS LB Controller deprovision the ALB (NOT eksctl-managed,
#                 so deleting the cluster first would orphan it).
#   2. Route 53 → removes the domain A-alias.
#   3. EFS      → mount targets + filesystem + SG, BEFORE the cluster (mount targets
#                 in the VPC subnets would otherwise block VPC deletion).
#   4. Cluster  → eksctl delete cluster (nodes, VPC, Pod Identity, CFN stacks).
#   5. ACM      → deletes the cert (only possible once the ALB releasing it is gone).
#   6. SES/IAM  → the SES identity/config-set/SNS topic and the three customer-managed
#                 IAM policies setup.sh creates (they belong to no stack, so nothing
#                 else would ever remove them).
#   7. EBS      → reports (or, with --delete-volumes, deletes) the Retain'd pb-ebs volumes.
#
#   ./bin/shutdown.sh --cluster-name pipeline-builder --region us-east-1 \
#       --domain pipeline-builder.com [--hosted-zone-id Z...] [--delete-volumes] [--yes]
#
# Pass --domain for a COMPLETE teardown — without it the cluster + EFS are removed but the
# ACM cert, Route 53 alias, and SES resources are LEFT BEHIND. --hosted-zone-id is optional:
# it's auto-discovered from --domain. --delete-volumes also removes the Retain'd pb-ebs EBS
# volumes (DB data — irreversible); without it they're reported, not deleted.
#
# Best-effort: continues past individual failures and warns, so a partial teardown
# still removes as much as possible.
# =============================================================================
CLUSTER_NAME="${CLUSTER_NAME:-pipeline-builder}"
REGION="${REGION:-us-east-1}"
DOMAIN="${DOMAIN:-}"
HOSTED_ZONE_ID="${HOSTED_ZONE_ID:-}"
NAMESPACE="${NAMESPACE:-pipeline-builder}"
ASSUME_YES=false
DELETE_VOLUMES=false

while [ $# -gt 0 ]; do
  case "$1" in
    --cluster-name) CLUSTER_NAME="$2"; shift 2 ;;
    --region) REGION="$2"; shift 2 ;;
    --domain) DOMAIN="$2"; shift 2 ;;
    --hosted-zone-id) HOSTED_ZONE_ID="$2"; shift 2 ;;
    --delete-volumes) DELETE_VOLUMES=true; shift ;;
    --yes|-y) ASSUME_YES=true; shift ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

log() { echo ""; echo "=== $1 ==="; }

# Auto-discover the hosted zone from --domain (walking up to the parent zone) so the
# operator only needs --domain. Explicit --hosted-zone-id always wins.
if [ -n "$DOMAIN" ] && [ -z "$HOSTED_ZONE_ID" ]; then
  n="$DOMAIN"
  while [ -n "$n" ]; do
    zid=$(aws route53 list-hosted-zones-by-name --dns-name "$n" \
      --query "HostedZones[?Name=='${n}.'].Id | [0]" --output text 2>/dev/null | sed 's#/hostedzone/##' || true)
    case "$zid" in Z*) HOSTED_ZONE_ID="$zid"; break ;; esac
    case "$n" in *.*) n="${n#*.}" ;; *) break ;; esac
  done
  [ -n "$HOSTED_ZONE_ID" ] && echo "  resolved hosted zone $HOSTED_ZONE_ID for $DOMAIN"
fi

# eksctl: install the pinned binary if it's not already on PATH (a prereq, like kubectl).
# shellcheck source=../../../bin/common.sh
. "$(cd "$(dirname "$0")" && pwd)/../../../bin/common.sh"
ensure_eksctl || { echo "ERROR: eksctl is required for teardown" >&2; exit 1; }

echo "=== EKS teardown: cluster=$CLUSTER_NAME region=$REGION domain=${DOMAIN:-<none>} ==="
echo "This DELETES the cluster, its nodes, and the EFS filesystem."
if [ -n "$DOMAIN" ]; then
  echo "Plus (--domain given): the ACM cert, Route 53 alias, and SES identity/config-set/SNS."
else
  echo ""
  echo "  ⚠ WARNING: --domain NOT given. The cluster + EFS will be deleted, but the ACM cert,"
  echo "    Route 53 alias, and SES resources will be LEFT BEHIND. Re-run with --domain (the"
  echo "    hosted zone is auto-discovered) for a complete teardown."
  echo ""
fi
[ "$DELETE_VOLUMES" = true ] \
  && echo "--delete-volumes: the Retain'd pb-ebs EBS volumes (DB data) WILL be deleted." \
  || echo "EBS volumes on pb-ebs (Retain) are kept (pass --delete-volumes to remove them)."
if [ "$ASSUME_YES" != true ]; then
  printf 'Type the cluster name "%s" to confirm: ' "$CLUSTER_NAME"
  read -r REPLY
  [ "$REPLY" = "$CLUSTER_NAME" ] || { echo "Did not match — nothing destroyed."; exit 1; }
fi

CLUSTER_EXISTS=false
eksctl get cluster --name "$CLUSTER_NAME" --region "$REGION" >/dev/null 2>&1 && CLUSTER_EXISTS=true

# ---- Phase 1: Ingress → ALB ------------------------------------------------
log "Phase 1: delete Ingress (deprovision the ALB)"
if [ "$CLUSTER_EXISTS" = true ]; then
  aws eks update-kubeconfig --name "$CLUSTER_NAME" --region "$REGION" >/dev/null 2>&1 || true
  if kubectl get ingress pb-ingress -n "$NAMESPACE" >/dev/null 2>&1; then
    kubectl delete ingress pb-ingress -n "$NAMESPACE" --ignore-not-found
    echo "  waiting for the AWS LB Controller to tear down the ALB..."
    sleep 30   # give the controller time before the cluster (and the controller) go away
  else
    echo "  no pb-ingress — skipping"
  fi
else
  echo "  cluster not found — skipping (ALB, if any, may need manual cleanup)"
fi

# ---- Phase 2: Route 53 alias -----------------------------------------------
log "Phase 2: Route 53 alias for $DOMAIN"
if [ -n "$DOMAIN" ] && [ -n "$HOSTED_ZONE_ID" ]; then
  # `| [0]` returns the single matching record-set as a JSON OBJECT (or null), so it embeds
  # directly in the change-batch — no array-bracket sed surgery and no fixed /tmp temp file.
  REC=$(aws route53 list-resource-record-sets --hosted-zone-id "$HOSTED_ZONE_ID" \
    --query "ResourceRecordSets[?Name=='${DOMAIN}.' && Type=='A'] | [0]" --output json 2>/dev/null || echo 'null')
  if [ "$REC" != 'null' ] && [ -n "$REC" ]; then
    aws route53 change-resource-record-sets --hosted-zone-id "$HOSTED_ZONE_ID" \
      --change-batch "{\"Changes\":[{\"Action\":\"DELETE\",\"ResourceRecordSet\":${REC}}]}" >/dev/null 2>&1 \
      && echo "  deleted A-alias $DOMAIN" || echo "  WARNING: could not delete the $DOMAIN alias — remove it manually." >&2
  else
    echo "  no A-alias for $DOMAIN — skipping"
  fi
else
  echo "  --domain/--hosted-zone-id not given — skipping"
fi

# ---- Phase 3: EFS (before the cluster/VPC) ---------------------------------
log "Phase 3: EFS filesystem"
EFS_ID=$(aws efs describe-file-systems --region "$REGION" \
  --query "FileSystems[?CreationToken=='pb-${CLUSTER_NAME}'].FileSystemId | [0]" --output text 2>/dev/null || true)
if [ -n "$EFS_ID" ] && [ "$EFS_ID" != None ]; then
  for mt in $(aws efs describe-mount-targets --file-system-id "$EFS_ID" --region "$REGION" \
      --query 'MountTargets[].MountTargetId' --output text 2>/dev/null); do
    aws efs delete-mount-target --mount-target-id "$mt" --region "$REGION" 2>/dev/null || true
  done
  echo "  waiting for mount targets to drain..."
  for _ in $(seq 1 30); do
    n=$(aws efs describe-mount-targets --file-system-id "$EFS_ID" --region "$REGION" --query 'length(MountTargets)' --output text 2>/dev/null || echo 0)
    [ "$n" = 0 ] && break; sleep 5
  done
  aws efs delete-file-system --file-system-id "$EFS_ID" --region "$REGION" 2>/dev/null \
    && echo "  deleted EFS $EFS_ID" || echo "  WARNING: could not delete EFS $EFS_ID — remove it manually." >&2
  # Scope the SG lookup to the cluster's VPC — group names are unique only within a VPC, so a
  # same-named SG in another VPC (e.g. a 2nd cluster) must not be selected/deleted. Phase 3 runs
  # BEFORE the cluster delete, so the VPC is still discoverable; fall back to name-only if it's
  # already gone (the EFS itself is uniquely scoped by its pb-<cluster> creation token).
  EFS_SG_FILTERS=("Name=group-name,Values=${CLUSTER_NAME}-efs")
  CLUSTER_VPC=$(aws eks describe-cluster --name "$CLUSTER_NAME" --region "$REGION" \
    --query 'cluster.resourcesVpcConfig.vpcId' --output text 2>/dev/null || true)
  case "$CLUSTER_VPC" in vpc-*) EFS_SG_FILTERS+=("Name=vpc-id,Values=$CLUSTER_VPC") ;; esac
  EFS_SG=$(aws ec2 describe-security-groups --region "$REGION" \
    --filters "${EFS_SG_FILTERS[@]}" --query 'SecurityGroups[0].GroupId' --output text 2>/dev/null || true)
  if [ -n "$EFS_SG" ] && [ "$EFS_SG" != None ]; then
    aws ec2 delete-security-group --group-id "$EFS_SG" --region "$REGION" 2>/dev/null \
      && echo "  deleted EFS SG $EFS_SG" || echo "  (EFS SG $EFS_SG delete deferred — retry after the cluster is gone)" >&2
  fi
else
  echo "  no EFS for pb-${CLUSTER_NAME} — skipping"
fi

# ---- Phase 4: cluster ------------------------------------------------------
log "Phase 4: delete cluster"
if [ "$CLUSTER_EXISTS" = true ]; then
  eksctl delete cluster --name "$CLUSTER_NAME" --region "$REGION" --disable-nodegroup-eviction
else
  echo "  cluster $CLUSTER_NAME not found — skipping"
fi

# ---- Phase 5: ACM cert -----------------------------------------------------
log "Phase 5: ACM certificate"
if [ -n "$DOMAIN" ]; then
  CERT_ARN=$(aws acm list-certificates --region "$REGION" \
    --query "CertificateSummaryList[?DomainName=='$DOMAIN'].CertificateArn | [0]" --output text 2>/dev/null || true)
  if [ -n "$CERT_ARN" ] && [ "$CERT_ARN" != None ]; then
    aws acm delete-certificate --certificate-arn "$CERT_ARN" --region "$REGION" 2>/dev/null \
      && echo "  deleted cert $CERT_ARN" || echo "  WARNING: cert $CERT_ARN still in use — delete it once the ALB is fully gone." >&2
  else
    echo "  no cert for $DOMAIN — skipping"
  fi
else
  echo "  --domain not given — skipping"
fi

# ---- Phase 6: SES email + the customer-managed IAM policies -----------------
# Mirrors what the ec2 delete-stack removes. The cluster delete (Phase 4) already
# removed the Pod Identity associations + their roles, so these policies detach.
#
# The policies are created by bin/setup.sh with `aws iam create-policy` — they
# belong to no CloudFormation stack, so NOTHING else deletes them. All three must
# be named here: <cluster>-eks-ses (Phase 5, EMAIL_ENABLED), -eks-pipeline-exec
# (Phase 5, ALWAYS created), -eks-plugin-signing (Phase 5, kms mode) and
# -eks-token-signing (Phase 5, TOKEN_SIGNING_MODE=kms — the AWS default). Deleting
# only the SES one left the rest orphaned in the account after a teardown that
# claims to leak nothing.
log "Phase 6: SES email + IAM policies"
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text 2>/dev/null || true)

# delete_managed_policy <policy-name> — drop the non-default versions (a policy
# with versions cannot be deleted) then the policy. Absent = nothing to do;
# still-attached = report, since the role goes away with the cluster stacks.
delete_managed_policy() {
  local _name="$1" _arn="arn:aws:iam::${ACCOUNT_ID}:policy/$1" _v
  aws iam get-policy --policy-arn "$_arn" >/dev/null 2>&1 || return 0
  for _v in $(aws iam list-policy-versions --policy-arn "$_arn" --query 'Versions[?!IsDefaultVersion].VersionId' --output text 2>/dev/null); do
    aws iam delete-policy-version --policy-arn "$_arn" --version-id "$_v" 2>/dev/null || true
  done
  aws iam delete-policy --policy-arn "$_arn" 2>/dev/null \
    && echo "  deleted IAM policy ${_name}" \
    || echo "  (IAM policy ${_name} still attached — delete once the cluster is fully gone)" >&2
}

if [ -n "$ACCOUNT_ID" ] && [ "$ACCOUNT_ID" != None ]; then
  delete_managed_policy "${CLUSTER_NAME}-eks-ses"
  delete_managed_policy "${CLUSTER_NAME}-eks-pipeline-exec"
  delete_managed_policy "${CLUSTER_NAME}-eks-plugin-signing"
  delete_managed_policy "${CLUSTER_NAME}-eks-token-signing"
  aws sns delete-topic --topic-arn "arn:aws:sns:${REGION}:${ACCOUNT_ID}:${CLUSTER_NAME}-email-events" --region "$REGION" 2>/dev/null \
    && echo "  deleted SNS topic ${CLUSTER_NAME}-email-events" || true
fi
aws sesv2 delete-configuration-set --configuration-set-name "${CLUSTER_NAME}-email" --region "$REGION" 2>/dev/null \
  && echo "  deleted config set ${CLUSTER_NAME}-email" || true
if [ -n "$DOMAIN" ]; then
  # Remove the DKIM CNAMEs (need the tokens BEFORE deleting the identity).
  if [ -n "$HOSTED_ZONE_ID" ]; then
    for tok in $(aws sesv2 get-email-identity --email-identity "$DOMAIN" --region "$REGION" --query 'DkimAttributes.Tokens' --output text 2>/dev/null); do
      aws route53 change-resource-record-sets --hosted-zone-id "$HOSTED_ZONE_ID" \
        --change-batch "{\"Changes\":[{\"Action\":\"DELETE\",\"ResourceRecordSet\":{\"Name\":\"${tok}._domainkey.${DOMAIN}\",\"Type\":\"CNAME\",\"TTL\":1800,\"ResourceRecords\":[{\"Value\":\"${tok}.dkim.amazonses.com\"}]}}]}" >/dev/null 2>&1 || true
    done
  fi
  aws sesv2 delete-email-identity --email-identity "$DOMAIN" --region "$REGION" 2>/dev/null \
    && echo "  deleted SES identity $DOMAIN" || echo "  (SES identity $DOMAIN not found / kept)"
fi

# ---- Phase 7: Retain'd pb-ebs EBS volumes ----------------------------------
# pb-ebs uses ReclaimPolicy=Retain, so the DB volumes survive the cluster delete.
# After the cluster is gone they're detached (status=available). Deleted only with
# --delete-volumes (they hold data); otherwise reported.
log "Phase 7: Retain'd EBS volumes (pb-ebs)"
VOLS=$(aws ec2 describe-volumes --region "$REGION" \
  --filters "Name=tag:kubernetes.io/created-for/pvc/namespace,Values=$NAMESPACE" "Name=status,Values=available" \
  --query 'Volumes[].VolumeId' --output text 2>/dev/null || true)
if [ -n "$VOLS" ] && [ "$VOLS" != None ]; then
  if [ "$DELETE_VOLUMES" = true ]; then
    for v in $VOLS; do
      aws ec2 delete-volume --volume-id "$v" --region "$REGION" 2>/dev/null \
        && echo "  deleted volume $v" || echo "  WARNING: could not delete $v (still attached? retry shortly)" >&2
    done
  else
    echo "  kept (DB data) — re-run with --delete-volumes to remove, or delete manually:"
    for v in $VOLS; do echo "    aws ec2 delete-volume --volume-id $v --region $REGION"; done
  fi
else
  echo "  none found"
fi

log "Teardown complete"
