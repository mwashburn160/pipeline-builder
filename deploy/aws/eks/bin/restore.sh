#!/usr/bin/env bash
# eks restore — see deploy/bin/restore.sh for the env contract and options.
set -euo pipefail
exec "$(cd "$(dirname "$0")/../../../bin" && pwd)/restore.sh" --connect k8s "$@"
