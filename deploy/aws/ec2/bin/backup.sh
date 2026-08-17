#!/usr/bin/env bash
# ============================================================================
# Pipeline Builder — Postgres + MongoDB backup to S3 (via kubectl port-forward)
# ============================================================================
# k8s targets (minikube / ec2 / eks): the datastores run INSIDE the cluster, so
# their service names aren't resolvable from the host. This stands up short-lived
# `kubectl port-forward`s to postgres/mongodb (+minio when enabled), rewrites the
# connection env to the local tunnels, dumps to S3 with pg_dump/mongodump/mc,
# then tears the forwards down on exit. The dump is LOGICAL (over the network),
# so it captures the real data wherever it physically lives (e.g. the minikube VM
# disk) — never a copy of the empty host ./data/ folder.
#
# Required env vars:
#   BACKUP_BUCKET            S3 bucket name (without s3:// prefix)
#   POSTGRES_HOST            postgres host (in-cluster name is fine — rewritten)
#   POSTGRES_USER            postgres user
#   POSTGRES_PASSWORD        postgres password (consumed via PGPASSWORD)
#   POSTGRES_DB              postgres database name (default: pipeline_builder)
#   MONGODB_URI              full mongo connection string (rewritten to the tunnel)
#
# Optional:
#   ENV_NAME                 environment label embedded in S3 path (default: prod)
#   AWS_REGION               AWS region (default: us-east-1)
#   RETENTION_DAYS           prune objects older than this in S3 (default: 30; 0 disables)
#   DRY_RUN=1                print actions without executing (NO cluster needed)
#
# Port-forward tunables:
#   PB_NAMESPACE (default pipeline-builder), PB_KUBE_CONTEXT (default current),
#   PG_LOCAL_PORT (15432), MONGO_LOCAL_PORT (27018), MINIO_LOCAL_PORT (19000).
#
# Optional — MinIO object-storage backup (attachments/registry/loki/thanos):
#   Enabled when MINIO_ENDPOINT is set. Mirrors each MinIO bucket to a durable
#   backup target with `mc mirror` (additive: copies new/changed objects, never
#   deletes from the backup). Requires the `mc` (MinIO client) binary.
#   MINIO_ENDPOINT               source MinIO URL (in-cluster is fine — rewritten)
#   MINIO_ROOT_USER              source MinIO access key
#   MINIO_ROOT_PASSWORD          source MinIO secret key
#   MINIO_BACKUP_TARGET_URL      destination S3/MinIO URL (e.g. https://s3.us-east-1.amazonaws.com)
#   MINIO_BACKUP_TARGET_ACCESS_KEY / _SECRET_KEY   destination credentials
#   MINIO_BACKUP_TARGET_BUCKET   destination bucket that receives the mirror (default: ${BACKUP_BUCKET})
#   MINIO_BUCKETS                space-separated source buckets (default: "message-attachments registry loki thanos")
#
# Usage:
#   ./backup.sh                                 # port-forward + dump + upload + prune
#   DRY_RUN=1 ./backup.sh                       # prints actions; no cluster required
#
# Exit codes:
#   0  success (a failed retention prune only WARNs)
#   1  required env var missing / port-forward not ready
#   2  dump or upload failed
# ============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=../../../bin/common.sh
. "$SCRIPT_DIR/../../../bin/common.sh"

# --- Required env vars -------------------------------------------------------

require_env BACKUP_BUCKET POSTGRES_HOST POSTGRES_USER POSTGRES_PASSWORD MONGODB_URI

ENV_NAME="${ENV_NAME:-prod}"
AWS_REGION="${AWS_REGION:-us-east-1}"
POSTGRES_DB="${POSTGRES_DB:-pipeline_builder}"
RETENTION_DAYS="${RETENTION_DAYS:-30}"
DRY_RUN="${DRY_RUN:-0}"

# --- Port-forward connectivity (k8s) ----------------------------------------

NS="${PB_NAMESPACE:-pipeline-builder}"
PG_LOCAL_PORT="${PG_LOCAL_PORT:-15432}"
MONGO_LOCAL_PORT="${MONGO_LOCAL_PORT:-27018}"
MINIO_LOCAL_PORT="${MINIO_LOCAL_PORT:-19000}"
KCTX_ARGS=()
[ -n "${PB_KUBE_CONTEXT:-}" ] && KCTX_ARGS=(--context "$PB_KUBE_CONTEXT")
WANT_MINIO=0
[ -n "${MINIO_ENDPOINT:-}" ] && WANT_MINIO=1

# Single cleanup for BOTH the temp workdir and the port-forwards (one EXIT trap).
PF_PIDS=()
WORKDIR=""
cleanup() {
  [ -n "$WORKDIR" ] && rm -rf "$WORKDIR"
  if [ ${#PF_PIDS[@]} -gt 0 ]; then
    local pid
    for pid in "${PF_PIDS[@]}"; do [ -n "$pid" ] && kill "$pid" 2>/dev/null || true; done
  fi
}
trap cleanup EXIT INT TERM

start_pf() {
  kubectl "${KCTX_ARGS[@]}" -n "$NS" port-forward "svc/$1" "$2:$3" >/dev/null 2>&1 &
  PF_PIDS+=("$!")
}

# Wait for a forwarded local port to accept a TCP connection (bash /dev/tcp), so
# we never launch a dump before the tunnel is actually up.
wait_port() {
  local port="$1" name="$2" tries=0
  while [ "$tries" -lt 60 ]; do
    if (exec 3<>"/dev/tcp/127.0.0.1/${port}") 2>/dev/null; then exec 3>&- 3<&-; return 0; fi
    sleep 0.5; tries=$((tries + 1))
  done
  echo "ERROR: port-forward for ${name} (127.0.0.1:${port}) never became ready" >&2
  return 1
}

# Rewrite a mongodb:// URI to target a single port-forwarded mongod: swap the host
# authority for 127.0.0.1:<local>, DROP replicaSet (a single forwarded member
# would otherwise trigger RS discovery of unreachable internal hostnames), and
# force directConnection=true. Credentials / db / authSource are preserved.
rewrite_mongo_uri() {
  local uri="$1" hp="$2" rest creds query path newq kv
  case "$uri" in
    mongodb://*) rest="${uri#mongodb://}" ;;
    *) echo "$uri"; return 0 ;; # mongodb+srv:// can't be forwarded member-by-member
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

# Bring up the tunnels + repoint the connection env — UNLESS this is a DRY_RUN
# (the dump never connects then, so no cluster/kubectl is required).
if [ "$DRY_RUN" != "1" ]; then
  preflight kubectl
  echo "=== port-forward → in-cluster datastores (ns ${NS}${PB_KUBE_CONTEXT:+, context ${PB_KUBE_CONTEXT}}) ==="
  echo "  postgres 127.0.0.1:${PG_LOCAL_PORT} · mongodb 127.0.0.1:${MONGO_LOCAL_PORT}$([ "$WANT_MINIO" = "1" ] && echo " · minio 127.0.0.1:${MINIO_LOCAL_PORT}")"
  start_pf postgres "$PG_LOCAL_PORT" 5432
  start_pf mongodb  "$MONGO_LOCAL_PORT" 27017
  [ "$WANT_MINIO" = "1" ] && start_pf minio "$MINIO_LOCAL_PORT" 9000
  wait_port "$PG_LOCAL_PORT" postgres
  wait_port "$MONGO_LOCAL_PORT" mongodb
  [ "$WANT_MINIO" = "1" ] && wait_port "$MINIO_LOCAL_PORT" minio
  # Postgres: pg_dump honours PGPORT, so only host+port change.
  export POSTGRES_HOST="127.0.0.1" PGPORT="$PG_LOCAL_PORT"
  MONGODB_URI="$(rewrite_mongo_uri "$MONGODB_URI" "127.0.0.1:${MONGO_LOCAL_PORT}")"
  [ "$WANT_MINIO" = "1" ] && MINIO_ENDPOINT="http://127.0.0.1:${MINIO_LOCAL_PORT}"
fi

TIMESTAMP=$(date -u +%Y%m%dT%H%M%SZ)
DATE_DIR=$(date -u +%Y/%m/%d)
S3_PREFIX="s3://${BACKUP_BUCKET}/${ENV_NAME}/${DATE_DIR}"

WORKDIR=$(mktemp -d)  # cleaned up by the EXIT trap above (alongside the forwards)

PG_FILE="${WORKDIR}/postgres-${TIMESTAMP}.sql.gz"
MONGO_FILE="${WORKDIR}/mongo-${TIMESTAMP}.archive.gz"

run() {
  if [ "$DRY_RUN" = "1" ]; then
    echo "[dry-run] $*"
  else
    "$@"
  fi
}

echo "=== Backup ==="
echo "  env:        ${ENV_NAME}"
echo "  region:     ${AWS_REGION}"
echo "  pg target:  ${POSTGRES_USER}@${POSTGRES_HOST}:${PGPORT:-5432}/${POSTGRES_DB}"
echo "  mongo:      [redacted]"
echo "  s3 prefix:  ${S3_PREFIX}"
echo "  retention:  ${RETENTION_DAYS} days"
echo "  dry-run:    ${DRY_RUN}"
echo ""

# --- Postgres dump ----------------------------------------------------------

echo "[1/5] Dumping postgres → ${PG_FILE}"
if [ "$DRY_RUN" != "1" ]; then
  PGPASSWORD="${POSTGRES_PASSWORD}" pg_dump \
    --host="${POSTGRES_HOST}" \
    --username="${POSTGRES_USER}" \
    --dbname="${POSTGRES_DB}" \
    --no-owner --no-acl --clean --if-exists \
    | gzip -9 > "${PG_FILE}" || { echo "ERROR: pg_dump failed" >&2; exit 2; }
fi

# --- MongoDB dump -----------------------------------------------------------

echo "[2/5] Dumping mongodb → ${MONGO_FILE}"
if [ "$DRY_RUN" != "1" ]; then
  mongodump --uri="${MONGODB_URI}" --archive="${MONGO_FILE}" --gzip \
    || { echo "ERROR: mongodump failed" >&2; exit 2; }
fi

# --- Upload to S3 ----------------------------------------------------------

echo "[3/5] Uploading to ${S3_PREFIX}"
run aws s3 cp "${PG_FILE}" "${S3_PREFIX}/" --region "${AWS_REGION}" \
  || { echo "ERROR: s3 cp postgres failed" >&2; exit 2; }
run aws s3 cp "${MONGO_FILE}" "${S3_PREFIX}/" --region "${AWS_REGION}" \
  || { echo "ERROR: s3 cp mongo failed" >&2; exit 2; }

# --- MinIO object storage (optional) ----------------------------------------
# Mirror the MinIO buckets (attachments/registry/loki/thanos blobs) to a durable
# backup target. Enabled by setting MINIO_ENDPOINT. `mc mirror` is additive
# (copies new/changed objects; never deletes from the backup), so a delete in
# the source can't wipe the backup — pair the target with bucket versioning for
# point-in-time recovery. A FAILURE here fails the run (exit 2): a backup that
# silently skips object storage is a false green.
if [ "$WANT_MINIO" = "1" ]; then
  echo "[4/5] Mirroring MinIO buckets → ${MINIO_BACKUP_TARGET_URL:-<unset>}"
  require_env MINIO_ROOT_USER MINIO_ROOT_PASSWORD \
             MINIO_BACKUP_TARGET_URL MINIO_BACKUP_TARGET_ACCESS_KEY MINIO_BACKUP_TARGET_SECRET_KEY
  command -v mc >/dev/null 2>&1 || { echo "ERROR: MINIO_ENDPOINT set but 'mc' (MinIO client) not found" >&2; exit 2; }

  MINIO_BUCKETS="${MINIO_BUCKETS:-message-attachments registry loki thanos}"
  MINIO_BACKUP_TARGET_BUCKET="${MINIO_BACKUP_TARGET_BUCKET:-${BACKUP_BUCKET}}"
  MC_CONFIG_DIR="${WORKDIR}/.mc"

  if [ "$DRY_RUN" != "1" ]; then
    mc_setup_aliases "$MC_CONFIG_DIR"
    for b in ${MINIO_BUCKETS}; do
      echo "  mirroring ${b} → ${MINIO_BACKUP_TARGET_BUCKET}/minio/${ENV_NAME}/${b}"
      mc --config-dir "$MC_CONFIG_DIR" mirror --overwrite --quiet \
        "pbsrc/${b}" "pbdst/${MINIO_BACKUP_TARGET_BUCKET}/minio/${ENV_NAME}/${b}" \
        || { echo "ERROR: mc mirror of bucket ${b} failed" >&2; exit 2; }
    done
  else
    echo "  [dry-run] would mc mirror [${MINIO_BUCKETS}] → pbdst/${MINIO_BACKUP_TARGET_BUCKET}/minio/${ENV_NAME}/"
  fi
else
  echo "[4/5] MinIO backup disabled (MINIO_ENDPOINT unset); skipping object-storage mirror"
fi

# --- Retention -------------------------------------------------------------

# A non-numeric RETENTION_DAYS must only WARN (a failed prune shouldn't fail an
# otherwise-successful backup). Under `set -e`, `[ abc -gt 0 ]` errors and aborts,
# so coerce anything non-integer to 0 (skip prune) with a warning.
case "${RETENTION_DAYS}" in
  ''|*[!0-9]*) echo "  WARN: RETENTION_DAYS='${RETENTION_DAYS}' is not a positive integer — skipping prune"; RETENTION_DAYS=0 ;;
esac
if [ "${RETENTION_DAYS}" -gt 0 ]; then
  echo "[5/5] Pruning backups older than ${RETENTION_DAYS} days"
  CUTOFF=$(date -u -v-"${RETENTION_DAYS}"d +%Y-%m-%dT%H:%M:%SZ 2>/dev/null \
        || date -u -d "${RETENTION_DAYS} days ago" +%Y-%m-%dT%H:%M:%SZ)
  if [ "$DRY_RUN" != "1" ]; then
    prune_keys=$(aws s3api list-objects-v2 \
      --bucket "${BACKUP_BUCKET}" \
      --prefix "${ENV_NAME}/" \
      --region "${AWS_REGION}" \
      --query "Contents[?LastModified<'${CUTOFF}'].Key" \
      --output text 2>/dev/null \
      | tr '\t' '\n' | grep -v '^$' || true)
    for key in $prune_keys; do
      echo "  pruning $key"
      aws s3 rm "s3://${BACKUP_BUCKET}/${key}" --region "${AWS_REGION}" \
        || { echo "WARN: failed to prune $key (continuing)" >&2; }
    done
  else
    echo "  [dry-run] would prune objects with LastModified < ${CUTOFF}"
  fi
else
  echo "[5/5] Retention disabled (RETENTION_DAYS=0); skipping prune"
fi

echo ""
echo "=== Backup complete ==="
echo "  postgres: ${S3_PREFIX}/$(basename "${PG_FILE}")"
echo "  mongo:    ${S3_PREFIX}/$(basename "${MONGO_FILE}")"
if [ "$WANT_MINIO" = "1" ]; then
  echo "  minio:    ${MINIO_BACKUP_TARGET_BUCKET:-${BACKUP_BUCKET}}/minio/${ENV_NAME}/ (mirrored: ${MINIO_BUCKETS:-message-attachments registry loki thanos})"
fi
