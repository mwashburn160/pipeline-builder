#!/usr/bin/env bash
# Copyright 2026 Pipeline Builder Contributors
# SPDX-License-Identifier: Apache-2.0
#
# Port-forward tunnels to the in-cluster datastores, for backup.sh/restore.sh
# (--connect k8s). SOURCE this file — it defines functions only. Like common.sh
# it sets no shell options; failures RETURN non-zero.
#
# Tunables (env): PB_NAMESPACE (default pipeline-builder), PB_KUBE_CONTEXT
# (default: current context), PG_LOCAL_PORT (15432), MONGO_LOCAL_PORT (27018),
# MINIO_LOCAL_PORT (19000).
#
# After pb_pf_up_db / pb_pf_up_minio the connection env points at the tunnels:
# POSTGRES_HOST=127.0.0.1 + PGPORT, MONGODB_URI rewritten, MINIO_ENDPOINT
# rewritten. The caller's EXIT trap must call pb_pf_down.

PB_PF_PIDS=()

_pb_pf_start() {
  local _ctx=()
  [ -n "${PB_KUBE_CONTEXT:-}" ] && _ctx=(--context "$PB_KUBE_CONTEXT")
  kubectl "${_ctx[@]+"${_ctx[@]}"}" -n "${PB_NAMESPACE:-pipeline-builder}" port-forward "svc/$1" "$2:$3" >/dev/null 2>&1 &
  PB_PF_PIDS+=("$!")
}

# Wait for a forwarded local port to accept a TCP connection (bash /dev/tcp), so
# a dump/restore never starts before the tunnel is actually up.
_pb_pf_wait() {
  local port="$1" name="$2" tries=0
  while [ "$tries" -lt 60 ]; do
    if (exec 3<>"/dev/tcp/127.0.0.1/${port}") 2>/dev/null; then return 0; fi
    sleep 0.5; tries=$((tries + 1))
  done
  echo "ERROR: port-forward for ${name} (127.0.0.1:${port}) never became ready" >&2
  return 1
}

# pb_rewrite_mongo_uri <uri> <host:port> — retarget a mongodb:// URI at a single
# port-forwarded mongod: swap the host authority, DROP replicaSet (one forwarded
# member would otherwise trigger RS discovery of unreachable internal
# hostnames), and force directConnection=true. Credentials / db / authSource
# are preserved. mongodb+srv:// can't be forwarded member-by-member, so it is
# returned unchanged.
pb_rewrite_mongo_uri() {
  local uri="$1" hp="$2" rest creds query path newq kv
  case "$uri" in
    mongodb://*) rest="${uri#mongodb://}" ;;
    *) echo "$uri"; return 0 ;;
  esac
  if [[ "$rest" == *@* ]]; then creds="${rest%%@*}@"; rest="${rest#*@}"; else creds=""; fi
  if [[ "$rest" == *\?* ]]; then query="${rest#*\?}"; rest="${rest%%\?*}"; else query=""; fi
  if [[ "$rest" == */* ]]; then path="/${rest#*/}"; else path=""; fi
  newq="directConnection=true"
  if [ -n "$query" ]; then
    local oldIFS="$IFS"
    set -f; IFS='&'
    for kv in $query; do
      case "$kv" in ''|replicaSet=*|directConnection=*) : ;; *) newq="${newq}&${kv}" ;; esac
    done
    IFS="$oldIFS"; set +f
  fi
  echo "mongodb://${creds}${hp}${path}?${newq}"
}

# Forward postgres + mongodb and repoint the DB env at the tunnels.
pb_pf_up_db() {
  local _pg="${PG_LOCAL_PORT:-15432}" _mongo="${MONGO_LOCAL_PORT:-27018}"
  preflight kubectl || return 1
  echo "=== port-forward → postgres 127.0.0.1:${_pg} · mongodb 127.0.0.1:${_mongo} (ns ${PB_NAMESPACE:-pipeline-builder}${PB_KUBE_CONTEXT:+, context ${PB_KUBE_CONTEXT}}) ==="
  _pb_pf_start postgres "$_pg" 5432
  _pb_pf_start mongodb  "$_mongo" 27017
  _pb_pf_wait "$_pg" postgres || return 1
  _pb_pf_wait "$_mongo" mongodb || return 1
  # pg_dump/psql honour PGPORT, so only host+port change.
  export POSTGRES_HOST="127.0.0.1" PGPORT="$_pg"
  MONGODB_URI="$(pb_rewrite_mongo_uri "${MONGODB_URI:-}" "127.0.0.1:${_mongo}")"
}

# Forward minio and repoint MINIO_ENDPOINT at the tunnel.
pb_pf_up_minio() {
  local _minio="${MINIO_LOCAL_PORT:-19000}"
  preflight kubectl || return 1
  echo "=== port-forward → minio 127.0.0.1:${_minio} ==="
  _pb_pf_start minio "$_minio" 9000
  _pb_pf_wait "$_minio" minio || return 1
  export MINIO_ENDPOINT="http://127.0.0.1:${_minio}"
}

pb_pf_down() {
  local _pid
  for _pid in "${PB_PF_PIDS[@]+"${PB_PF_PIDS[@]}"}"; do
    [ -n "$_pid" ] && kill "$_pid" 2>/dev/null || true
  done
}
