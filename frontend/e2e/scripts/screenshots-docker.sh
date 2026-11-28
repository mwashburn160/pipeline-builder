#!/usr/bin/env bash
# Copyright 2026 Pipeline Builder Contributors
# SPDX-License-Identifier: Apache-2.0
#
# Run the screenshot project inside the official Playwright image for the
# repo's @playwright/test version, so baselines are Linux renders that match CI.
# The app runs on the host (`next dev`, started here unless one is already
# listening); only the test runner and Linux Chromium run in the container.
#
#   frontend/e2e/scripts/screenshots-docker.sh                       # compare
#   frontend/e2e/scripts/screenshots-docker.sh --update-snapshots    # rewrite baselines
#
# Any arguments are passed to `playwright test`.
set -euo pipefail

FRONTEND="$(cd "$(dirname "$0")/../.." && pwd)"
REPO="$(cd "$FRONTEND/.." && pwd)"
PORT="${E2E_PORT:-3311}"
VERSION="$(node -p "require('$FRONTEND/node_modules/@playwright/test/package.json').version")"
IMAGE="mcr.microsoft.com/playwright:v${VERSION}-noble"

server_pid=""
if ! curl -fsS -o /dev/null "http://localhost:${PORT}"; then
  echo "starting next dev on :${PORT}"
  (cd "$FRONTEND" && NEXT_TELEMETRY_DISABLED=1 npx next dev -p "$PORT" >/tmp/pb-e2e-next-dev.log 2>&1) &
  server_pid=$!
  trap '[ -n "$server_pid" ] && kill "$server_pid" 2>/dev/null || true' EXIT
  for _ in $(seq 1 180); do curl -fsS -o /dev/null "http://localhost:${PORT}" && break; sleep 1; done
fi

docker run --rm --init --ipc=host \
  --add-host=host.docker.internal:host-gateway \
  --user "$(id -u):$(id -g)" -e HOME=/tmp \
  -v "$REPO:/work" -w /work/frontend \
  -e CI= -e E2E_BASE_URL="http://localhost:${PORT}" \
  "$IMAGE" \
  bash -c "node e2e/scripts/tcp-forward.mjs ${PORT} host.docker.internal & sleep 1; npx playwright test --project=screenshots $*"
