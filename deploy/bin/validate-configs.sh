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
#   - loki -verify-config           every target's config/loki/loki-config.yml
#   - promtail -check-syntax        every target's config/promtail/promtail-config.yml
#   - amtool check-config           every target's config/alertmanager/alertmanager.yml
#     (a per-target copy — see deploy/README.md "Per-target config")
#   - promtool check config         every target's prometheus.yml (+ its rules)
#   - promtool test rules           any alert-rules.test.yml present
#   - docker compose config -q      deploy/local/docker
#   - nginx -t                      every target's gateway config, against the
#     pinned nginx image, in BOTH admin-UI states on the AWS targets
#   - drift: every prometheus.yml declares external_labels with `cluster` + `replica`.
#
# Usage: deploy/bin/validate-configs.sh     (needs docker; exits non-zero on any failure)
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT" || exit 1

TARGETS=(local/docker local/minikube aws/eks aws/ec2)
# A stand-in for the in-pod ServiceAccount token the kubelet jobs authenticate
# with; its CONTENT is irrelevant, promtool only checks the file is readable.
_sa_token="$(mktemp)"; printf 'stub\n' > "$_sa_token"
trap 'rm -f "$_sa_token"' EXIT
COMPOSE=deploy/local/docker/docker-compose.yml
FAILED=0

fail() { echo "FAIL: $*" >&2; FAILED=1; }
pass() { echo "ok:   $*"; }

# Resolve an image reference (repo@sha256:...) from the docker-compose pin, so
# this script can never validate against a different version than we deploy.
# Returns non-zero (it does NOT exit) when the pin is missing: this runs inside
# a command substitution, where `exit` only kills the subshell, and the script
# has no `set -e` — so an `exit` here would leave an EMPTY image ref and
# "validate" against nothing. The callers below turn the non-zero into a real exit.
pinned_image() {
  local repo="$1" ref
  ref="$(grep -oE "${repo}@sha256:[0-9a-f]{64}" "$COMPOSE" | head -1)"
  [[ -n "$ref" ]] || { echo "cannot find pinned ${repo} image in ${COMPOSE}" >&2; return 1; }
  echo "$ref"
}

LOKI_IMAGE="$(pinned_image grafana/loki)" || exit 1
PROMTAIL_IMAGE="$(pinned_image grafana/promtail)" || exit 1
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

for t in "${TARGETS[@]}"; do
  cfg="deploy/$t/config"

  if out="$(docker run --rm -v "$ROOT/$cfg/loki:/cfg:ro" "$LOKI_IMAGE" \
      -config.file=/cfg/loki-config.yml -config.expand-env=true -verify-config 2>&1)"; then
    pass "loki       $t"
  else
    fail "loki       $t"; echo "$out" >&2
  fi

  if out="$(docker run --rm -v "$ROOT/$cfg/promtail:/cfg:ro" --entrypoint promtail \
      "$PROMTAIL_IMAGE" -config.file=/cfg/promtail-config.yml -config.expand-env=true \
      -check-syntax 2>&1)"; then
    pass "promtail   $t"
  else
    fail "promtail   $t"; echo "$out" >&2
  fi

  if out="$(docker run --rm --entrypoint amtool \
      -v "$ROOT/$cfg/alertmanager:/cfg:ro" "$AM_IMAGE" \
      check-config /cfg/alertmanager.yml 2>&1)"; then
    pass "alertmgr   $t"
  else
    fail "alertmgr   $t"; echo "$out" >&2
  fi

  # rule_files references /etc/prometheus/alert-rules.yml — mount it there.
  #
  # The ServiceAccount token is stubbed because promtool STATS every
  # credentials_file and fails on a missing one. The kubelet scrape jobs point at
  # the in-pod path, which by definition does not exist in a validator — so
  # without this stub a correct config fails here, and the only way to make the
  # check pass would be to stop authenticating the scrape. Found the hard way:
  # adding those jobs turned this check red on three targets.
  if out="$(docker run --rm --entrypoint promtool \
      -v "$ROOT/$cfg/prometheus:/etc/prometheus:ro" \
      -v "$_sa_token:/var/run/secrets/kubernetes.io/serviceaccount/token:ro" "$PROM_IMAGE" \
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

# ---------------------------------------------------------------------------
# nginx -t on every gateway config.
#
# Nothing validated these. They are the single front door for every target, they
# are only parsed when the container boots, and a bad directive takes the whole
# ingress down on a fresh provision — the same failure mode as the Loki key this
# script was written for. The cross-target drift test parses them with its own
# parser, which proves the four copies AGREE, not that any of them is valid.
#
# Three things have to be faked, and none of them is the config under test:
#   * upstream + resolver names. nginx resolves those AT PARSE TIME and fails
#     hard on an unknown host, so every literal name is pointed at 127.0.0.1.
#     Variable hosts ($upstream_x) resolve per request and need nothing.
#   * the deploy-time includes (real-ip.conf, ask-upstream.conf) — generated by
#     pb_nginx_config, so a stub of the right shape is what the target gets.
#   * a TLS cert for the targets that terminate TLS themselves.
# It runs as root purely so nginx can write its pid file; the real pods run as
# UID 101 with a writable /run emptyDir (docker instead sets `pid /tmp/nginx.pid`,
# which is why only it carries that directive).
# ---------------------------------------------------------------------------
NGINX_IMAGE="$(pinned_image nginxinc/nginx-unprivileged)" || exit 1
_nginx_tmp="$(mktemp -d)"
# One trap for BOTH temps: a second `trap ... EXIT` replaces the first, so
# installing another here would have leaked the ServiceAccount-token stub.
trap 'rm -rf "$_nginx_tmp"; rm -f "$_sa_token"' EXIT

for t in "${TARGETS[@]}"; do
  ndir="deploy/$t/nginx"
  [ -f "$ndir/nginx.conf" ] || continue
  work="$_nginx_tmp/$(echo "$t" | tr / -)"
  mkdir -p "$work/njs" "$work/certs"
  cp "$ndir"/*.conf "$work/" 2>/dev/null
  cp "$ndir"/*.js "$work/njs/" 2>/dev/null
  printf 'set_real_ip_from 10.0.0.0/8;
' > "$work/real-ip.conf"
  printf 'upstream pb_ask { server ask:3000; }
' > "$work/ask-upstream.conf"
  openssl req -x509 -newkey rsa:2048 -nodes -keyout "$work/certs/nginx.key"     -out "$work/certs/nginx.crt" -days 1 -subj "/CN=localhost" >/dev/null 2>&1

  # Every name nginx resolves at parse time.
  mapfile -t _hosts < <(cat "$work"/*.conf 2>/dev/null     | grep -oE '(\bserver[[:space:]]+[A-Za-z][A-Za-z0-9._-]*|proxy_pass[[:space:]]+https?://[A-Za-z][A-Za-z0-9._-]*|^[[:space:]]*resolver[[:space:]]+[A-Za-z][A-Za-z0-9._-]*)'     | sed -E 's|.*[/[:space:]]||' | grep -v '^localhost$' | sort -u)

  # The AWS targets ship admin-uis.conf in one of two states; both must parse,
  # and the DISABLED pair is what a default deploy actually runs.
  for state in enabled disabled; do
    [ -f "$work/admin-uis.conf" ] || { [ "$state" = disabled ] && continue; }
    args=(--rm --user 0 --entrypoint nginx)
    for h in "${_hosts[@]}"; do [ -n "$h" ] && args+=(--add-host "$h:127.0.0.1"); done
    args+=(-v "$work/nginx.conf:/etc/nginx/nginx.conf:ro" -v "$work/njs:/etc/nginx/njs:ro")
    args+=(-v "$work/certs:/etc/nginx/certs:ro")
    args+=(-v "$work/real-ip.conf:/etc/nginx/real-ip.conf:ro" -v "$work/ask-upstream.conf:/etc/nginx/ask-upstream.conf:ro")
    if [ "$state" = enabled ]; then
      [ -f "$work/admin-uis.conf" ]      && args+=(-v "$work/admin-uis.conf:/etc/nginx/admin-uis.conf:ro")
      [ -f "$work/rustfs-console.conf" ] && args+=(-v "$work/rustfs-console.conf:/etc/nginx/rustfs-console.conf:ro")
    else
      [ -f "$work/admin-uis-disabled.conf" ]      && args+=(-v "$work/admin-uis-disabled.conf:/etc/nginx/admin-uis.conf:ro")
      [ -f "$work/rustfs-console-disabled.conf" ] && args+=(-v "$work/rustfs-console-disabled.conf:/etc/nginx/rustfs-console.conf:ro")
    fi
    if out="$(docker run "${args[@]}" "$NGINX_IMAGE" -t 2>&1)"; then
      pass "nginx      $t ($state)"
    else
      fail "nginx      $t ($state)"; echo "$out" >&2
    fi
    [ -f "$work/admin-uis.conf" ] || break   # local targets have only one state
  done
done

if [[ "$FAILED" -ne 0 ]]; then
  echo "config validation FAILED" >&2
  exit 1
fi
echo "all config checks passed"
