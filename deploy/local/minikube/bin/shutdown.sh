#!/usr/bin/env bash
set -euo pipefail

# =============================================================================
# Pipeline Builder - Minikube Shutdown (graceful STOP; PRESERVES data)
# =============================================================================
# Stops port-forwards, then `minikube stop` — which halts the VM but PRESERVES
# its persistent disk. All hostPath data (postgres, mongodb, minio buckets on the
# VM's own /data disk) AND the full cluster state (workloads, PVCs, secrets) are
# kept, so the next start brings everything back with no re-provisioning.
#
# This deliberately does NOT delete the namespace / manifests / secrets — that
# would drop the PVCs and force a full re-setup. To WIPE everything instead, run:
#   minikube delete --profile=pipeline-builder
# =============================================================================

NAMESPACE="pipeline-builder"
PROFILE="pipeline-builder"

log() { echo ""; echo "=== $1 ==="; }

log "Stopping port-forwards"
pkill -f "kubectl port-forward.*-n $NAMESPACE" 2>/dev/null || true

log "Stopping Minikube (preserves the VM disk + cluster state)"
minikube stop --profile="$PROFILE" || true

echo ""
echo "=== Shutdown complete ==="
echo "  Data preserved on the minikube VM disk (postgres / mongodb / minio buckets)."
echo "  Restart: bash deploy/local/minikube/bin/setup.sh"
echo "           (or a quick 'minikube start --profile=pipeline-builder', then re-run"
echo "            setup.sh to re-establish port-forwards)"
echo "  Wipe ALL data: minikube delete --profile=pipeline-builder"
