#!/usr/bin/env bash
# ============================================================================
# Pipeline Builder — Postgres + MongoDB (+ MinIO) restore from S3
# ============================================================================
# Restores a backup pair (postgres + mongo) created by backup.sh. One
# implementation for every deploy target; each target's bin/restore.sh is a thin
# wrapper that picks the connection mode (see backup.sh):
#   --connect k8s     tunnel to the in-cluster datastores with kubectl port-forward
#   --connect direct  connect to POSTGRES_HOST / MONGODB_URI / MINIO_ENDPOINT as given
#
# DESTRUCTIVE — drops existing tables/collections before restore. REFUSES to run
# unless --confirm-destructive is passed. Every archive it is going to load is
# downloaded and gzip-integrity-checked FIRST, so a missing/corrupt backup fails
# while the existing data is still intact. --pg-only and --mongo-only are
# mutually exclusive (together they would select nothing).
#
# Required env vars:
#   BACKUP_BUCKET            S3 bucket name
#   POSTGRES_HOST            postgres hostname (k8s: rewritten to the tunnel)
#   POSTGRES_USER / POSTGRES_PASSWORD / POSTGRES_DB
#   MONGODB_URI              full mongo connection string (k8s: rewritten to the tunnel)
#
# Optional:
#   ENV_NAME                 environment label embedded in S3 path (default: prod)
#   AWS_REGION               AWS region (default: us-east-1)
#   Port-forward tunables: see backup.sh.
#
# MinIO object-storage restore (--minio): reverse-mirrors the backup target
# buckets back INTO the source MinIO. Standalone mode (does not touch the DBs).
# Same MINIO_* env as backup.sh (MINIO_ENDPOINT, MINIO_ROOT_USER/PASSWORD,
# MINIO_BACKUP_TARGET_URL, MINIO_BACKUP_TARGET_ACCESS_KEY/_SECRET_KEY,
# MINIO_BACKUP_TARGET_BUCKET, MINIO_BUCKETS). Requires `mc`.
#
# Usage (via the target wrapper, deploy/<target>/bin/restore.sh):
#   restore.sh --list                                              # list backups (no cluster needed)
#   restore.sh --date 2026/04/26 --confirm-destructive             # restore latest pair from a date
#   restore.sh --pg-key prod/2026/04/26/postgres-...sql.gz \
#              --mongo-key prod/2026/04/26/mongo-...archive.gz \
#              --confirm-destructive                               # restore specific keys
#   restore.sh --date 2026/04/26 --pg-only --confirm-destructive   # only postgres
#   restore.sh --date 2026/04/26 --mongo-only --confirm-destructive # only mongo
#   restore.sh --minio --confirm-destructive                       # restore MinIO buckets (blobs)
#
# Exit codes:
#   0  success
#   1  argument validation / missing env var / port-forward not ready
#   2  download or restore failed
#   3  --confirm-destructive not passed
# ============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=common.sh
. "$SCRIPT_DIR/common.sh"
# shellcheck source=db-connect.sh
. "$SCRIPT_DIR/db-connect.sh"

ENV_NAME="${ENV_NAME:-prod}"
AWS_REGION="${AWS_REGION:-us-east-1}"
CONNECT=""
LIST_ONLY=0
PG_ONLY=0
MONGO_ONLY=0
MINIO_RESTORE=0
CONFIRM=0
DATE=""
PG_KEY=""
MONGO_KEY=""

usage() {
  # Grep the RESOLVED script path (not the possibly-relative `$0`), so --help
  # can't exit non-zero under set -e+pipefail when the grep misses the file.
  sed -n '2,/^set -euo/p' "$SCRIPT_DIR/restore.sh" | grep '^#'
  exit "${1:-1}"
}

while [ $# -gt 0 ]; do
  case "$1" in
    --connect) [ $# -ge 2 ] || { echo "$1 requires k8s|direct" >&2; usage 1; }; CONNECT="$2"; shift ;;
    --list) LIST_ONLY=1 ;;
    --date) [ $# -ge 2 ] || { echo "$1 requires a value" >&2; usage 1; }; DATE="$2"; shift ;;
    --pg-key) [ $# -ge 2 ] || { echo "$1 requires a value" >&2; usage 1; }; PG_KEY="$2"; shift ;;
    --mongo-key) [ $# -ge 2 ] || { echo "$1 requires a value" >&2; usage 1; }; MONGO_KEY="$2"; shift ;;
    --pg-only) PG_ONLY=1 ;;
    --mongo-only) MONGO_ONLY=1 ;;
    --minio) MINIO_RESTORE=1 ;;
    --confirm-destructive) CONFIRM=1 ;;
    -h|--help) usage 0 ;;
    *) echo "unknown arg: $1" >&2; usage 1 ;;
  esac
  shift
done
case "$CONNECT" in k8s|direct) ;; *) echo "ERROR: --connect k8s|direct is required" >&2; exit 1 ;; esac

require_env BACKUP_BUCKET

WORKDIR=""
cleanup() {
  [ -n "$WORKDIR" ] && rm -rf "$WORKDIR"
  pb_pf_down
}
trap cleanup EXIT INT TERM

# --- List mode (S3 only; no datastore connection) ---------------------------

if [ "$LIST_ONLY" = "1" ]; then
  echo "Available backups in s3://${BACKUP_BUCKET}/${ENV_NAME}/:"
  aws s3 ls "s3://${BACKUP_BUCKET}/${ENV_NAME}/" --recursive --region "${AWS_REGION}" \
    | awk '{print $1, $2, $4}' | sort -k1,2
  exit 0
fi

WORKDIR=$(mktemp -d)

# --- MinIO object-storage restore (standalone) ------------------------------
# Reverse the backup mirror: copy the backup target's buckets back INTO the
# source MinIO. Does not touch the DBs, so it exits when done.
if [ "$MINIO_RESTORE" = "1" ]; then
  if [ "$CONFIRM" != "1" ]; then
    echo "ERROR: --minio restore overwrites MinIO objects." >&2
    echo "       Re-run with --confirm-destructive to proceed." >&2
    exit 3
  fi
  require_env MINIO_ENDPOINT MINIO_ROOT_USER MINIO_ROOT_PASSWORD \
             MINIO_BACKUP_TARGET_URL MINIO_BACKUP_TARGET_ACCESS_KEY MINIO_BACKUP_TARGET_SECRET_KEY
  command -v mc >/dev/null 2>&1 || { echo "ERROR: 'mc' (MinIO client) not found" >&2; exit 2; }

  # Forward + repoint MINIO_ENDPOINT before configuring the mc aliases.
  [ "$CONNECT" = k8s ] && pb_pf_up_minio

  MINIO_BUCKETS="${MINIO_BUCKETS:-$PB_MINIO_BUCKETS}"
  MINIO_BACKUP_TARGET_BUCKET="${MINIO_BACKUP_TARGET_BUCKET:-${BACKUP_BUCKET}}"
  MC_CONFIG_DIR="${WORKDIR}/.mc"

  mc_setup_aliases "$MC_CONFIG_DIR"
  for b in ${MINIO_BUCKETS}; do
    echo "[minio] restoring ${b} ← ${MINIO_BACKUP_TARGET_BUCKET}/minio/${ENV_NAME}/${b}"
    mc --config-dir "$MC_CONFIG_DIR" mb --ignore-existing "pbsrc/${b}" >/dev/null 2>&1 || true
    mc --config-dir "$MC_CONFIG_DIR" mirror --overwrite --quiet \
      "pbdst/${MINIO_BACKUP_TARGET_BUCKET}/minio/${ENV_NAME}/${b}" "pbsrc/${b}" \
      || { echo "ERROR: mc mirror restore of bucket ${b} failed" >&2; exit 2; }
  done
  echo ""
  echo "=== MinIO restore complete (${MINIO_BUCKETS}) ==="
  exit 0
fi

# --- Validate restore args --------------------------------------------------

# --pg-only AND --mongo-only together select NOTHING: both restore blocks below
# are skipped and the script would print "Restore complete" having restored
# nothing. A restore that restores nothing must never report success.
if [ "$PG_ONLY" = "1" ] && [ "$MONGO_ONLY" = "1" ]; then
  echo "ERROR: --pg-only and --mongo-only are mutually exclusive (together they restore nothing)" >&2
  exit 1
fi

if [ -z "$DATE" ] && [ -z "$PG_KEY" ] && [ -z "$MONGO_KEY" ]; then
  echo "ERROR: provide either --date <YYYY/MM/DD> or --pg-key/--mongo-key" >&2
  usage
fi

if [ "$CONFIRM" != "1" ]; then
  echo "ERROR: restore is destructive (drops tables/collections before reload)." >&2
  echo "       Re-run with --confirm-destructive to proceed." >&2
  exit 3
fi

# --- Resolve keys via --date if provided ----------------------------------

if [ -n "$DATE" ]; then
  echo "Resolving latest pair under s3://${BACKUP_BUCKET}/${ENV_NAME}/${DATE}/"
  if [ -z "$PG_KEY" ] && [ "$MONGO_ONLY" != "1" ]; then
    PG_KEY=$(aws s3 ls "s3://${BACKUP_BUCKET}/${ENV_NAME}/${DATE}/" --region "${AWS_REGION}" \
      | awk '{print $4}' | grep '^postgres-' | sort | tail -1 || true)
    [ -n "$PG_KEY" ] && PG_KEY="${ENV_NAME}/${DATE}/${PG_KEY}"
  fi
  if [ -z "$MONGO_KEY" ] && [ "$PG_ONLY" != "1" ]; then
    MONGO_KEY=$(aws s3 ls "s3://${BACKUP_BUCKET}/${ENV_NAME}/${DATE}/" --region "${AWS_REGION}" \
      | awk '{print $4}' | grep '^mongo-' | sort | tail -1 || true)
    [ -n "$MONGO_KEY" ] && MONGO_KEY="${ENV_NAME}/${DATE}/${MONGO_KEY}"
  fi
fi

# --- Fetch + verify EVERY archive before anything is dropped ----------------
# The load steps are destructive from their first statement — pg_dump's
# `--clean --if-exists` DROPs live INSIDE the archive, and `mongorestore --drop`
# drops each collection as it streams it. So a missing key, a failed download or
# a truncated archive has to surface HERE, not half-way through a restore that
# has already dropped postgres and is about to fail on mongo.
_fetch_dump() {  # _fetch_dump <label> <s3 key> <local path>
  echo ""
  echo "[$1] downloading s3://${BACKUP_BUCKET}/$2 → $3"
  aws s3 cp "s3://${BACKUP_BUCKET}/$2" "$3" --region "${AWS_REGION}" \
    || { echo "ERROR: $1 download failed" >&2; exit 2; }
  # `gzip -t` decompresses the whole member and checks its CRC — a truncated or
  # corrupt object fails now, while the existing data is still intact.
  gzip -t "$3" \
    || { echo "ERROR: $1 archive failed its gzip integrity check — refusing to restore from $3" >&2; exit 2; }
  echo "[$1] archive verified"
}

PG_LOCAL=""
MONGO_LOCAL=""
if [ "$MONGO_ONLY" != "1" ]; then
  if [ -z "$PG_KEY" ]; then
    echo "ERROR: no postgres key resolved" >&2; exit 1
  fi
  require_env POSTGRES_HOST POSTGRES_USER POSTGRES_PASSWORD POSTGRES_DB
  PG_LOCAL="${WORKDIR}/$(basename "${PG_KEY}")"
  _fetch_dump postgres "$PG_KEY" "$PG_LOCAL"
fi
if [ "$PG_ONLY" != "1" ]; then
  if [ -z "$MONGO_KEY" ]; then
    echo "ERROR: no mongo key resolved" >&2; exit 1
  fi
  require_env MONGODB_URI
  MONGO_LOCAL="${WORKDIR}/$(basename "${MONGO_KEY}")"
  _fetch_dump mongo "$MONGO_KEY" "$MONGO_LOCAL"
fi

# Forward postgres+mongodb once for the DB restore(s) below.
[ "$CONNECT" = k8s ] && pb_pf_up_db

# --- Postgres restore -------------------------------------------------------

if [ "$MONGO_ONLY" != "1" ]; then
  echo ""
  echo "[postgres] restoring into ${POSTGRES_USER}@${POSTGRES_HOST}:${PGPORT:-5432}/${POSTGRES_DB}"
  gunzip -c "${PG_LOCAL}" | \
    PGPASSWORD="${POSTGRES_PASSWORD}" psql \
      --host="${POSTGRES_HOST}" \
      --username="${POSTGRES_USER}" \
      --dbname="${POSTGRES_DB}" \
      --set ON_ERROR_STOP=on \
    || { echo "ERROR: psql restore failed" >&2; exit 2; }
  echo "[postgres] restore complete"
fi

# --- MongoDB restore --------------------------------------------------------

if [ "$PG_ONLY" != "1" ]; then
  echo ""
  echo "[mongo] restoring (--drop)"
  mongorestore --uri="${MONGODB_URI}" --gzip --archive="${MONGO_LOCAL}" --drop \
    || { echo "ERROR: mongorestore failed" >&2; exit 2; }
  echo "[mongo] restore complete"
fi

echo ""
echo "=== Restore complete ==="
