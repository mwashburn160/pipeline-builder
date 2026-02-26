#!/bin/bash
# =============================================================================
# Pipeline Builder - EC2 Shutdown Script
# =============================================================================
# Stops minikube and removes iptables forwarding rules.
# Run as root: sudo bash deploy/aws/ec2/bin/shutdown.sh
# =============================================================================
set -eu

PROFILE="pipeline-builder"

echo "=== Pipeline Builder EC2 Shutdown ==="

# Remove iptables DNAT rules
echo ""
echo "=== Removing iptables forwarding rules ==="
MINIKUBE_IP=$(su - minikube -c "minikube ip --profile=$PROFILE" 2>/dev/null || true)
if [ -n "$MINIKUBE_IP" ]; then
  iptables -t nat -D PREROUTING -p tcp --dport 443 -j DNAT --to-destination "${MINIKUBE_IP}:30443" 2>/dev/null || true
  iptables -t nat -D PREROUTING -p tcp --dport 80 -j DNAT --to-destination "${MINIKUBE_IP}:30080" 2>/dev/null || true
  echo "  iptables rules removed"
else
  echo "  Could not determine minikube IP — flushing NAT PREROUTING chain"
  iptables -t nat -F PREROUTING 2>/dev/null || true
fi

# Save cleaned iptables
iptables-save > /etc/sysconfig/iptables 2>/dev/null || true

# Stop minikube
echo ""
echo "=== Stopping Minikube ==="
su - minikube -c "minikube stop --profile=$PROFILE" || true
echo "  Minikube stopped"

echo ""
echo "=== Shutdown complete ==="
echo "  To restart: sudo -u minikube bash deploy/aws/ec2/bin/startup.sh"
echo "  Then re-run iptables setup from bootstrap.sh Phase 10"
