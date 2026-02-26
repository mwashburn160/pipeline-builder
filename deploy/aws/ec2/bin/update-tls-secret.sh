#!/bin/bash
# =============================================================================
# Pipeline Builder - Let's Encrypt TLS Secret Update Hook
# =============================================================================
# Called by certbot's --deploy-hook after successful certificate renewal.
# Updates the nginx-tls-secret in Kubernetes and restarts nginx.
#
# Certbot sets these environment variables:
#   RENEWED_LINEAGE  - Path to renewed cert (e.g., /etc/letsencrypt/live/domain)
#   RENEWED_DOMAINS  - Space-separated list of renewed domains
# =============================================================================
set -eu

NAMESPACE="pipeline-builder"
MINIKUBE_USER="minikube"
PROFILE="pipeline-builder"

# Use certbot-provided path or detect from domain
CERT_DIR="${RENEWED_LINEAGE:-}"
if [ -z "$CERT_DIR" ]; then
  echo "ERROR: RENEWED_LINEAGE not set — this script should be called by certbot deploy-hook"
  exit 1
fi

echo "=== Updating TLS secret from renewed certificate ==="
echo "  Cert dir: $CERT_DIR"
echo "  Domains: ${RENEWED_DOMAINS:-unknown}"

# Set kubeconfig for the minikube user
export KUBECONFIG="/home/${MINIKUBE_USER}/.minikube/profiles/${PROFILE}/kubeconfig"

# Update the nginx-tls-secret
kubectl create secret tls nginx-tls-secret \
  --cert="$CERT_DIR/fullchain.pem" \
  --key="$CERT_DIR/privkey.pem" \
  -n "$NAMESPACE" \
  --dry-run=client -o yaml | kubectl apply -f -
echo "  nginx-tls-secret updated"

# Rolling restart nginx to pick up new cert
kubectl rollout restart deployment/nginx -n "$NAMESPACE"
echo "  nginx deployment restarted"

echo "=== TLS secret update complete ==="
