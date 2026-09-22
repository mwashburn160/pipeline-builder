#!/usr/bin/env bash
# eks backup — see deploy/bin/backup.sh for the env contract and options.
set -euo pipefail
exec "$(cd "$(dirname "$0")/../../../bin" && pwd)/backup.sh" --connect k8s "$@"
