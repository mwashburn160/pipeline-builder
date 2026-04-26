#!/usr/bin/env bash
# ============================================================================
# Pipeline Builder — Postgres + MongoDB restore from S3
# ============================================================================
# Restores a backup pair (postgres + mongo) created by backup.sh.
# DESTRUCTIVE — drops existing tables/collections before restore. Will REFUSE
# to run unless --confirm-destructive is passed.
#
# Required env vars:
#   BACKUP_BUCKET            S3 bucket name
#   POSTGRES_HOST            postgres hostname
#   POSTGRES_USER            postgres user
#   POSTGRES_PASSWORD        postgres password
#   POSTGRES_DB              postgres database name
#   MONGODB_URI              full mongo connection string
#
# Optional:
#   ENV_NAME                 environment label embedded in S3 path (default: prod)
#   AWS_REGION               AWS region (default: us-east-1)
#
# Usage:
#   ./restore.sh --list                                              # list available backups
#   ./restore.sh --date 2026/04/26 --confirm-destructive             # restore latest pair from a date
#   ./restore.sh --pg-key prod/2026/04/26/postgres-...sql.gz \
#                --mongo-key prod/2026/04/26/mongo-...archive.gz \
#                --confirm-destructive                                # restore specific keys
#   ./restore.sh --date 2026/04/26 --pg-only --confirm-destructive   # only postgres
#   ./restore.sh --date 2026/04/26 --mongo-only --confirm-destructive # only mongo
#
# Exit codes:
#   0  success
#   1  argument validation / missing env var
#   2  download or restore failed
#   3  user did not pass --confirm-destructive
# ============================================================================

set -euo pipefail

ENV_NAME="${ENV_NAME:-prod}"
AWS_REGION="${AWS_REGION:-us-east-1}"
LIST_ONLY=0
PG_ONLY=0
MONGO_ONLY=0
CONFIRM=0
DATE=""
PG_KEY=""
MONGO_KEY=""

usage() {
  grep '^#' "$0" | head -40
  exit 1
}

while [ $# -gt 0 ]; do
  case "$1" in
    --list) LIST_ONLY=1 ;;
    --date) DATE="$2"; shift ;;
    --pg-key) PG_KEY="$2"; shift ;;
    --mongo-key) MONGO_KEY="$2"; shift ;;
    --pg-only) PG_ONLY=1 ;;
    --mongo-only) MONGO_ONLY=1 ;;
    --confirm-destructive) CONFIRM=1 ;;
    -h|--help) usage ;;
    *) echo "unknown arg: $1" >&2; usage ;;
  esac
  shift
done

require() {
  if [ -z "${!1:-}" ]; then echo "ERROR: required env var '$1' not set" >&2; exit 1; fi
}
require BACKUP_BUCKET

# --- List mode --------------------------------------------------------------

if [ "$LIST_ONLY" = "1" ]; then
  echo "Available backups in s3://${BACKUP_BUCKET}/${ENV_NAME}/:"
  aws s3 ls "s3://${BACKUP_BUCKET}/${ENV_NAME}/" --recursive --region "${AWS_REGION}" \
    | awk '{print $1, $2, $4}' | sort -k1,2
  exit 0
fi

# --- Validate restore args --------------------------------------------------

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

WORKDIR=$(mktemp -d)
trap 'rm -rf "$WORKDIR"' EXIT

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

# --- Postgres restore -------------------------------------------------------

if [ "$MONGO_ONLY" != "1" ]; then
  if [ -z "$PG_KEY" ]; then
    echo "ERROR: no postgres key resolved" >&2; exit 1
  fi
  require POSTGRES_HOST
  require POSTGRES_USER
  require POSTGRES_PASSWORD
  require POSTGRES_DB

  PG_LOCAL="${WORKDIR}/$(basename "${PG_KEY}")"
  echo ""
  echo "[postgres] downloading s3://${BACKUP_BUCKET}/${PG_KEY} → ${PG_LOCAL}"
  aws s3 cp "s3://${BACKUP_BUCKET}/${PG_KEY}" "${PG_LOCAL}" --region "${AWS_REGION}" \
    || { echo "ERROR: postgres download failed" >&2; exit 2; }

  echo "[postgres] restoring into ${POSTGRES_USER}@${POSTGRES_HOST}/${POSTGRES_DB}"
  PGPASSWORD="${POSTGRES_PASSWORD}" gunzip -c "${PG_LOCAL}" | \
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
  if [ -z "$MONGO_KEY" ]; then
    echo "ERROR: no mongo key resolved" >&2; exit 1
  fi
  require MONGODB_URI

  MONGO_LOCAL="${WORKDIR}/$(basename "${MONGO_KEY}")"
  echo ""
  echo "[mongo] downloading s3://${BACKUP_BUCKET}/${MONGO_KEY} → ${MONGO_LOCAL}"
  aws s3 cp "s3://${BACKUP_BUCKET}/${MONGO_KEY}" "${MONGO_LOCAL}" --region "${AWS_REGION}" \
    || { echo "ERROR: mongo download failed" >&2; exit 2; }

  echo "[mongo] restoring (--drop) into MONGODB_URI"
  mongorestore --uri="${MONGODB_URI}" --gzip --archive="${MONGO_LOCAL}" --drop \
    || { echo "ERROR: mongorestore failed" >&2; exit 2; }
  echo "[mongo] restore complete"
fi

echo ""
echo "=== Restore complete ==="
