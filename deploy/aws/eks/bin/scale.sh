#!/usr/bin/env bash
set -uo pipefail
# =============================================================================
# Pipeline Builder — EKS cost-saving scale down / scale up
# =============================================================================
# Unlike bin/shutdown.sh (which DELETES the cluster), this keeps the cluster,
# its control plane, and all data intact, and just removes the EC2 cost of
# running it idle — for a nightly/weekend pause, not a teardown.
#
# The EKS control plane cannot be paused — it's always-on and billed
# regardless (Amazon EKS: Amazon EKS Pricing, https://aws.amazon.com/eks/pricing/).
# The actual savings come from EC2: this cluster runs EKS Auto Mode
# (cluster/nodepool.yaml), which has no ASG-backed managed node group to
# scale to zero the way a traditional cluster would (see
# https://repost.aws/questions/QUIKUzqLUmRTugaSmSbo9gpA/how-to-shutdown-eks-to-save-cost
# and https://www.blinkops.com/blog/how-to-scale-down-aws-eks-clusters-nightly-to-lower-ec2-costs
# for that traditional approach). Instead: scale every Deployment/StatefulSet
# in the app namespace to 0 and Auto Mode's own node consolidation terminates
# the now-idle EC2 capacity on its own — confirmed live on this exact cluster
# (ztunnel/istio-cni-node logs showed "Evicted pod: Underutilized" events
# within minutes of workload replica counts dropping).
#
# Both `down` and `up` are idempotent and safe to re-run:
#   - `down` records each workload's current replica count (and each HPA's
#     current minReplicas) as an annotation BEFORE zeroing it, but only if
#     that annotation isn't already present — so running `down` twice never
#     overwrites a real count with a stale "0".
#   - `up` restores from those annotations and removes them; workloads with
#     no annotation (nothing to restore) are left alone.
#   - HPAs are scaled to minReplicas=0 too, in the same pass as their target
#     Deployment/StatefulSet — otherwise the HPA fights the scale-down and
#     re-creates the very replicas `down` just removed.
#
# Scope is deliberately just the app namespace (NAMESPACE below), not
# istio-system/kube-system/keda: those are small, mesh/cluster-management
# overhead needed for the scale-up itself to work cleanly, not the
# workloads actually driving EC2 cost.
#
#   ./bin/scale.sh down [--cluster-name pipeline-builder] [--region us-east-1] [--yes]
#   ./bin/scale.sh up   [--cluster-name pipeline-builder] [--region us-east-1]
#   ./bin/scale.sh status [--cluster-name pipeline-builder] [--region us-east-1]
# =============================================================================
CLUSTER_NAME="${CLUSTER_NAME:-pipeline-builder}"
REGION="${REGION:-us-east-1}"
NAMESPACE="${NAMESPACE:-pipeline-builder}"
ASSUME_YES=false
ACTION="${1:-}"
[ $# -gt 0 ] && shift

REPLICA_ANNOTATION="scaledown.pipeline-builder.io/original-replicas"
HPA_MIN_ANNOTATION="scaledown.pipeline-builder.io/original-min-replicas"

while [ $# -gt 0 ]; do
  case "$1" in
    --cluster-name) CLUSTER_NAME="$2"; shift 2 ;;
    --region) REGION="$2"; shift 2 ;;
    --namespace) NAMESPACE="$2"; shift 2 ;;
    --yes|-y) ASSUME_YES=true; shift ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

case "$ACTION" in
  down|up|status) ;;
  *) echo "Usage: $0 {down|up|status} [--cluster-name NAME] [--region REGION] [--namespace NS] [--yes]" >&2; exit 1 ;;
esac

log() { echo ""; echo "=== $1 ==="; }

aws eks update-kubeconfig --name "$CLUSTER_NAME" --region "$REGION" >/dev/null 2>&1 \
  || { echo "ERROR: could not reach cluster $CLUSTER_NAME in $REGION — is it running?" >&2; exit 1; }

# iterate_workloads <callback> — calls callback once per Deployment/StatefulSet
# in $NAMESPACE with: kind name currentReplicas savedReplicasAnnotation
iterate_workloads() {
  local _cb="$1" _kind _name _replicas _saved
  for _kind in deployment statefulset; do
    while IFS=$'\t' read -r _name _replicas _saved; do
      [ -n "$_name" ] || continue
      "$_cb" "$_kind" "$_name" "$_replicas" "$_saved"
    done < <(kubectl get "$_kind" -n "$NAMESPACE" -o jsonpath="{range .items[*]}{.metadata.name}{'\t'}{.spec.replicas}{'\t'}{.metadata.annotations.${REPLICA_ANNOTATION//./\\.}}{'\n'}{end}" 2>/dev/null)
  done
}

# iterate_hpas <callback> — calls callback once per HPA with:
# name currentMinReplicas savedMinReplicasAnnotation
iterate_hpas() {
  local _cb="$1" _name _min _saved
  while IFS=$'\t' read -r _name _min _saved; do
    [ -n "$_name" ] || continue
    "$_cb" "$_name" "$_min" "$_saved"
  done < <(kubectl get hpa -n "$NAMESPACE" -o jsonpath="{range .items[*]}{.metadata.name}{'\t'}{.spec.minReplicas}{'\t'}{.metadata.annotations.${HPA_MIN_ANNOTATION//./\\.}}{'\n'}{end}" 2>/dev/null)
}

do_down_workload() {
  local kind="$1" name="$2" replicas="$3" saved="$4"
  if [ -n "$saved" ]; then
    echo "  $kind/$name already scaled down (was $saved) — skipping"
    return
  fi
  if [ "${replicas:-0}" = "0" ]; then
    echo "  $kind/$name already at 0 replicas — skipping"
    return
  fi
  kubectl annotate "$kind" "$name" -n "$NAMESPACE" "${REPLICA_ANNOTATION}=${replicas}" --overwrite >/dev/null \
    && kubectl scale "$kind" "$name" -n "$NAMESPACE" --replicas=0 >/dev/null \
    && echo "  $kind/$name: $replicas -> 0" \
    || echo "  WARNING: failed to scale down $kind/$name" >&2
}

do_down_hpa() {
  local name="$1" min="$2" saved="$3"
  if [ -n "$saved" ]; then
    echo "  hpa/$name already scaled down (minReplicas was $saved) — skipping"
    return
  fi
  if [ "${min:-0}" = "0" ]; then
    echo "  hpa/$name already at minReplicas=0 — skipping"
    return
  fi
  kubectl annotate hpa "$name" -n "$NAMESPACE" "${HPA_MIN_ANNOTATION}=${min}" --overwrite >/dev/null \
    && kubectl patch hpa "$name" -n "$NAMESPACE" --type=merge -p "{\"spec\":{\"minReplicas\":0}}" >/dev/null \
    && echo "  hpa/$name: minReplicas $min -> 0" \
    || echo "  WARNING: failed to scale down hpa/$name" >&2
}

do_up_workload() {
  local kind="$1" name="$2" replicas="$3" saved="$4"
  if [ -z "$saved" ]; then
    echo "  $kind/$name: no saved replica count — leaving at $replicas"
    return
  fi
  kubectl scale "$kind" "$name" -n "$NAMESPACE" --replicas="$saved" >/dev/null \
    && kubectl annotate "$kind" "$name" -n "$NAMESPACE" "${REPLICA_ANNOTATION}-" >/dev/null 2>&1 \
    && echo "  $kind/$name: 0 -> $saved" \
    || echo "  WARNING: failed to scale up $kind/$name" >&2
}

do_up_hpa() {
  local name="$1" min="$2" saved="$3"
  if [ -z "$saved" ]; then
    echo "  hpa/$name: no saved minReplicas — leaving at $min"
    return
  fi
  kubectl patch hpa "$name" -n "$NAMESPACE" --type=merge -p "{\"spec\":{\"minReplicas\":${saved}}}" >/dev/null \
    && kubectl annotate hpa "$name" -n "$NAMESPACE" "${HPA_MIN_ANNOTATION}-" >/dev/null 2>&1 \
    && echo "  hpa/$name: minReplicas 0 -> $saved" \
    || echo "  WARNING: failed to scale up hpa/$name" >&2
}

show_status() {
  log "Status: $NAMESPACE"
  echo "Workloads (kind/name  current/saved replicas):"
  for kind in deployment statefulset; do
    kubectl get "$kind" -n "$NAMESPACE" -o jsonpath="{range .items[*]}  $kind/{.metadata.name}  {.spec.replicas}{'\t'}saved={.metadata.annotations.${REPLICA_ANNOTATION//./\\.}}{'\n'}{end}" 2>/dev/null
  done
  echo
  echo "HPAs (name  current/saved minReplicas):"
  kubectl get hpa -n "$NAMESPACE" -o jsonpath="{range .items[*]}  hpa/{.metadata.name}  {.spec.minReplicas}{'\t'}saved={.metadata.annotations.${HPA_MIN_ANNOTATION//./\\.}}{'\n'}{end}" 2>/dev/null
  echo
  echo "Nodes:"
  kubectl get nodes --no-headers 2>/dev/null | wc -l | xargs echo "  count:"
}

case "$ACTION" in
  down)
    echo "=== Scale down: cluster=$CLUSTER_NAME namespace=$NAMESPACE ==="
    echo "This scales every Deployment/StatefulSet in '$NAMESPACE' to 0 replicas"
    echo "and every HPA's minReplicas to 0. The cluster, control plane, and all"
    echo "persistent data (EBS/EFS) are left untouched — only compute cost drops,"
    echo "as EKS Auto Mode consolidates/terminates now-idle EC2 capacity on its own."
    echo "Run '$0 up ...' to restore every original replica count."
    if [ "$ASSUME_YES" != true ]; then
      printf 'Proceed? [y/N] '
      read -r REPLY
      case "$REPLY" in [Yy]*) ;; *) echo "Aborted."; exit 1 ;; esac
    fi
    log "Phase 1: scale HPAs to minReplicas=0 (so they don't fight the workload scale-down)"
    iterate_hpas do_down_hpa
    log "Phase 2: scale Deployments/StatefulSets to 0"
    iterate_workloads do_down_workload
    log "Done"
    echo "Compute will drain over the next few minutes as Auto Mode consolidates nodes."
    echo "Check progress with: kubectl get nodes"
    ;;
  up)
    echo "=== Scale up: cluster=$CLUSTER_NAME namespace=$NAMESPACE ==="
    log "Phase 1: restore HPA minReplicas"
    iterate_hpas do_up_hpa
    log "Phase 2: restore Deployment/StatefulSet replica counts"
    iterate_workloads do_up_workload
    log "Done"
    echo "New EC2 capacity will provision over the next few minutes as pods go Pending."
    echo "Check progress with: kubectl get pods -n $NAMESPACE -w"
    ;;
  status)
    show_status
    ;;
esac
