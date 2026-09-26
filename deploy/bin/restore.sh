#!/usr/bin/env bash
# ============================================================================
# Pipeline Builder — Postgres + MongoDB (+ object storage) restore from S3
# ============================================================================
# Restores a backup pair (postgres + mongo) created by backup.sh. One
# implementation for every deploy target; each target's bin/restore.sh is a thin
# wrapper that picks the connection mode (see backup.sh):
#   --connect k8s     tunnel to the in-cluster datastores with kubectl port-forward
#   --connect direct  connect to POSTGRES_HOST / MONGODB_URI / S3_ENDPOINT as given
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
# Object-storage restore (--object-store): reverse-mirrors the backup target
# buckets back INTO the source object store. Standalone mode (does not touch
# the DBs). Same env as backup.sh (S3_ENDPOINT, RUSTFS_ROOT_ACCESS_KEY/
# SECRET_KEY, S3_BACKUP_TARGET_URL, S3_BACKUP_TARGET_ACCESS_KEY/_SECRET_KEY,
# S3_BACKUP_TARGET_BUCKET, OBJECTSTORE_BUCKETS). Requires `rclone`.
#
# Usage (via the target wrapper, deploy/<target>/bin/restore.sh):
#   restore.sh --list                                              # list backups (no cluster needed)
#   restore.sh --date 2026/04/26 --confirm-destructive             # restore latest pair from a date
#   restore.sh --pg-key prod/2026/04/26/postgres-...sql.gz \
#              --mongo-key prod/2026/04/26/mongo-...archive.gz \
#              --confirm-destructive                               # restore specific keys
#   restore.sh --date 2026/04/26 --pg-only --confirm-destructive   # only postgres
#   restore.sh --date 2026/04/26 --mongo-only --confirm-destructive # only mongo
#   restore.sh --object-store --confirm-destructive                # restore object-store buckets (blobs)
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
OBJECTSTORE_RESTORE=0
CONFIRM=0
DATE=""
PG_KEY=""
MONGO_KEY=""

usage() {
  pb_usage_from_header "$SCRIPT_DIR/${BASH_SOURCE[0]##*/}"
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
    --object-store) OBJECTSTORE_RESTORE=1 ;;
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

# --- Object-storage restore (standalone) ------------------------------------
# Reverse the backup mirror: copy the backup target's buckets back INTO the
# source object store. Does not touch the DBs, so it exits when done.
if [ "$OBJECTSTORE_RESTORE" = "1" ]; then
  if [ "$CONFIRM" != "1" ]; then
    echo "ERROR: --object-store restore overwrites object-store data." >&2
    echo "       Re-run with --confirm-destructive to proceed." >&2
    exit 3
  fi
  require_env S3_ENDPOINT RUSTFS_ROOT_ACCESS_KEY RUSTFS_ROOT_SECRET_KEY \
             S3_BACKUP_TARGET_URL S3_BACKUP_TARGET_ACCESS_KEY S3_BACKUP_TARGET_SECRET_KEY
  command -v rclone >/dev/null 2>&1 || { echo "ERROR: 'rclone' not found" >&2; exit 2; }

  # Forward + repoint S3_ENDPOINT before writing the rclone config.
  [ "$CONNECT" = k8s ] && pb_pf_up_objectstore

  OBJECTSTORE_BUCKETS="${OBJECTSTORE_BUCKETS:-$PB_OBJECTSTORE_BUCKETS}"
  S3_BACKUP_TARGET_BUCKET="${S3_BACKUP_TARGET_BUCKET:-${BACKUP_BUCKET}}"
  RCLONE_CONFIG_FILE="${WORKDIR}/rclone.conf"

  rclone_setup_config "$RCLONE_CONFIG_FILE"
  for b in ${OBJECTSTORE_BUCKETS}; do
    echo "[object-store] restoring ${b} ← ${S3_BACKUP_TARGET_BUCKET}/minio/${ENV_NAME}/${b}"
    rclone --config "$RCLONE_CONFIG_FILE" copy --quiet \
      "pbdst:${S3_BACKUP_TARGET_BUCKET}/minio/${ENV_NAME}/${b}" "pbsrc:${b}" \
      || { echo "ERROR: rclone copy restore of bucket ${b} failed" >&2; exit 2; }
  done
  echo ""
  echo "=== Object-store restore complete (${OBJECTSTORE_BUCKETS}) ==="
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
