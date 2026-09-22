#!/usr/bin/env bash
# Validate the observability configs of every deploy target against the SAME
# pinned image digests the targets deploy, plus cross-target drift guards.
#
# Why: these configs are only parsed when a container boots, so a bad key (e.g.
# Loki's `deletion_mode` under compactor:, which the pinned image rejects) or a
# copy that drifted from its siblings (docker's prometheus.yml missing the
# external_labels Thanos requires) surfaced as a crash-loop on fresh provision.
# Validating against the deployed digest matters — newer images are stricter.
#
# Checks:
#   - loki -verify-config           deploy/shared/config/loki/loki-config.yml
#   - amtool check-config           deploy/shared/config/alertmanager/alertmanager.yml
#     (one copy for every target — see deploy/README.md "Shared config")
#   - promtool check config         every target's prometheus.yml (+ its rules)
#   - promtool test rules           any alert-rules.test.yml present
#   - docker compose config -q      deploy/local/docker
#   - drift: every prometheus.yml declares external_labels with `cluster` + `replica`.
#
# Usage: deploy/bin/validate-configs.sh     (needs docker; exits non-zero on any failure)
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT" || exit 1

TARGETS=(local/docker local/minikube aws/eks aws/ec2)
COMPOSE=deploy/local/docker/docker-compose.yml
FAILED=0

fail() { echo "FAIL: $*" >&2; FAILED=1; }
pass() { echo "ok:   $*"; }

# Resolve an image reference (repo@sha256:...) from the docker-compose pin, so
# this script can never validate against a different version than we deploy.
# Returns non-zero (it does NOT exit) when the pin is missing: this runs inside
# a command substitution, where `exit` only kills the subshell — the script has
# no `set -e`, so it used to sail on with an EMPTY image ref and "validate"
# against nothing. The callers below turn the non-zero into a real exit.
pinned_image() {
  local repo="$1" ref
  ref="$(grep -oE "${repo}@sha256:[0-9a-f]{64}" "$COMPOSE" | head -1)"
  [[ -n "$ref" ]] || { echo "cannot find pinned ${repo} image in ${COMPOSE}" >&2; return 1; }
  echo "$ref"
}

LOKI_IMAGE="$(pinned_image grafana/loki)" || exit 1
PROM_IMAGE="$(pinned_image prom/prometheus)" || exit 1
AM_IMAGE="$(pinned_image prom/alertmanager)" || exit 1

# Every k8s manifest must pin the same digest as compose — otherwise the
# validation above isn't testing what the cluster runs.
for img in "$LOKI_IMAGE" "$PROM_IMAGE" "$AM_IMAGE"; do
  repo="${img%@*}"
  while IFS= read -r ref; do
    [[ "$ref" == "$img" ]] || fail "image pin drift: ${ref} (compose pins ${img})"
  done < <(grep -rhoE "${repo}@sha256:[0-9a-f]{64}" deploy/*/*/k8s 2>/dev/null | sort -u)
done

SHARED=deploy/shared/config

if out="$(docker run --rm -v "$ROOT/$SHARED/loki:/cfg:ro" "$LOKI_IMAGE" \
    -config.file=/cfg/loki-config.yml -config.expand-env=true -verify-config 2>&1)"; then
  pass "loki       shared"
else
  fail "loki       shared"; echo "$out" >&2
fi

if out="$(docker run --rm --entrypoint amtool \
    -v "$ROOT/$SHARED/alertmanager:/cfg:ro" "$AM_IMAGE" \
    check-config /cfg/alertmanager.yml 2>&1)"; then
  pass "alertmgr   shared"
else
  fail "alertmgr   shared"; echo "$out" >&2
fi

for t in "${TARGETS[@]}"; do
  cfg="deploy/$t/config"

  # rule_files references /etc/prometheus/alert-rules.yml — mount it there.
  if out="$(docker run --rm --entrypoint promtool \
      -v "$ROOT/$cfg/prometheus:/etc/prometheus:ro" "$PROM_IMAGE" \
      check config /etc/prometheus/prometheus.yml 2>&1)"; then
    pass "prometheus $t"
  else
    fail "prometheus $t"; echo "$out" >&2
  fi

  if [[ -f "$cfg/prometheus/alert-rules.test.yml" ]]; then
    if out="$(docker run --rm --entrypoint promtool \
        -v "$ROOT/$cfg/prometheus:/t:ro" -w /t "$PROM_IMAGE" \
        test rules alert-rules.test.yml 2>&1)"; then
      pass "rule-tests $t"
    else
      fail "rule-tests $t"; echo "$out" >&2
    fi
  fi

  # Thanos sidecar exits 1 without these (see prometheus.yml comments).
  prom="$cfg/prometheus/prometheus.yml"
  if awk '/^global:/{g=1;next} /^[^ #]/{g=0} g' "$prom" | grep -q '^  external_labels:' \
     && grep -qE '^    cluster: ' "$prom" && grep -qE '^    replica: ' "$prom"; then
    pass "ext-labels $t"
  else
    fail "ext-labels $t: $prom must set global.external_labels.{cluster,replica}"
  fi
done

# Interpolate against .env.example so the check needs no real secrets.
if out="$(docker compose -f "$COMPOSE" --env-file deploy/local/docker/.env.example config -q 2>&1)"; then
  pass "compose    local/docker"
else
  fail "compose    local/docker"; echo "$out" >&2
fi

if [[ "$FAILED" -ne 0 ]]; then
  echo "config validation FAILED" >&2
  exit 1
fi
echo "all config checks passed"
