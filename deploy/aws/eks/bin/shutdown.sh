#!/usr/bin/env bash
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

# eksctl: prefer the binary, else the official image via Docker (mirrors setup.sh).
if command -v eksctl >/dev/null 2>&1; then
  eksctl() { command eksctl "$@"; }
else
  command -v docker >/dev/null 2>&1 || { echo "ERROR: need eksctl on PATH or Docker (for public.ecr.aws/eksctl/eksctl)" >&2; exit 1; }
  echo "  eksctl not found — using public.ecr.aws/eksctl/eksctl via Docker"
  mkdir -p "$HOME/.kube" "$HOME/.aws"
  eksctl() {
    docker run --rm -i \
      -v "$HOME/.aws:/root/.aws" -v "$HOME/.kube:/root/.kube" \
      -e AWS_PROFILE -e AWS_REGION -e AWS_DEFAULT_REGION \
      -e AWS_ACCESS_KEY_ID -e AWS_SECRET_ACCESS_KEY -e AWS_SESSION_TOKEN \
      public.ecr.aws/eksctl/eksctl "$@"
  }
fi

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
  REC=$(aws route53 list-resource-record-sets --hosted-zone-id "$HOSTED_ZONE_ID" \
    --query "ResourceRecordSets[?Name=='${DOMAIN}.' && Type=='A']" --output json 2>/dev/null || echo '[]')
  if [ "$REC" != '[]' ] && [ -n "$REC" ]; then
    echo "$REC" | sed 's/^\[//; s/\]$//' > /tmp/pb-eks-rr.json
    aws route53 change-resource-record-sets --hosted-zone-id "$HOSTED_ZONE_ID" \
      --change-batch "{\"Changes\":[{\"Action\":\"DELETE\",\"ResourceRecordSet\":$(cat /tmp/pb-eks-rr.json)}]}" >/dev/null 2>&1 \
      && echo "  deleted A-alias $DOMAIN" || echo "  WARNING: could not delete the $DOMAIN alias — remove it manually." >&2
    rm -f /tmp/pb-eks-rr.json
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
  EFS_SG=$(aws ec2 describe-security-groups --region "$REGION" \
    --filters "Name=group-name,Values=${CLUSTER_NAME}-efs" --query 'SecurityGroups[0].GroupId' --output text 2>/dev/null || true)
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

# ---- Phase 6: SES email resources ------------------------------------------
# Mirrors what the ec2 delete-stack removes. The cluster delete (Phase 4) already
# removed the Pod Identity association + its role, so the scoped policy detaches.
log "Phase 6: SES email resources"
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text 2>/dev/null || true)
if [ -n "$ACCOUNT_ID" ] && [ "$ACCOUNT_ID" != None ]; then
  SES_POLICY_ARN="arn:aws:iam::${ACCOUNT_ID}:policy/${CLUSTER_NAME}-eks-ses"
  if aws iam get-policy --policy-arn "$SES_POLICY_ARN" >/dev/null 2>&1; then
    for v in $(aws iam list-policy-versions --policy-arn "$SES_POLICY_ARN" --query 'Versions[?!IsDefaultVersion].VersionId' --output text 2>/dev/null); do
      aws iam delete-policy-version --policy-arn "$SES_POLICY_ARN" --version-id "$v" 2>/dev/null || true
    done
    aws iam delete-policy --policy-arn "$SES_POLICY_ARN" 2>/dev/null \
      && echo "  deleted IAM policy ${CLUSTER_NAME}-eks-ses" \
      || echo "  (IAM policy ${CLUSTER_NAME}-eks-ses still attached — delete once the cluster is fully gone)" >&2
  fi
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
