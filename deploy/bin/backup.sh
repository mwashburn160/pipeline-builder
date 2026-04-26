#!/usr/bin/env bash
# ============================================================================
# Pipeline Builder — Postgres + MongoDB backup to S3
# ============================================================================
# Cron-friendly: writes timestamped dumps to s3://${BACKUP_BUCKET}/<env>/<date>/.
# Exits non-zero on any failure (dump, upload, or missing required env var).
#
# Required env vars:
#   BACKUP_BUCKET            S3 bucket name (without s3:// prefix)
#   POSTGRES_HOST            postgres hostname (e.g. postgres, db.internal)
#   POSTGRES_USER            postgres user
#   POSTGRES_PASSWORD        postgres password (consumed via PGPASSWORD)
#   POSTGRES_DB              postgres database name (default: pipeline_builder)
#   MONGODB_URI              full mongo connection string
#
# Optional:
#   ENV_NAME                 environment label embedded in S3 path (default: prod)
#   AWS_REGION               AWS region (default: us-east-1)
#   RETENTION_DAYS           prune objects older than this in S3 (default: 30; 0 disables)
#
# Usage:
#   ./backup.sh                                 # backs up + uploads + prunes
#   DRY_RUN=1 ./backup.sh                       # prints actions without executing
#
# Exit codes:
#   0  success
#   1  required env var missing
#   2  dump or upload failed
#   3  retention prune failed (backups did succeed)
# ============================================================================

set -euo pipefail

# --- Required env vars -------------------------------------------------------

require() {
  local var=$1
  if [ -z "${!var:-}" ]; then
    echo "ERROR: required env var '$var' is not set" >&2
    exit 1
  fi
}

require BACKUP_BUCKET
require POSTGRES_HOST
require POSTGRES_USER
require POSTGRES_PASSWORD
require MONGODB_URI

ENV_NAME="${ENV_NAME:-prod}"
AWS_REGION="${AWS_REGION:-us-east-1}"
POSTGRES_DB="${POSTGRES_DB:-pipeline_builder}"
RETENTION_DAYS="${RETENTION_DAYS:-30}"
DRY_RUN="${DRY_RUN:-0}"

TIMESTAMP=$(date -u +%Y%m%dT%H%M%SZ)
DATE_DIR=$(date -u +%Y/%m/%d)
S3_PREFIX="s3://${BACKUP_BUCKET}/${ENV_NAME}/${DATE_DIR}"

WORKDIR=$(mktemp -d)
trap 'rm -rf "$WORKDIR"' EXIT

PG_FILE="${WORKDIR}/postgres-${TIMESTAMP}.sql.gz"
MONGO_FILE="${WORKDIR}/mongo-${TIMESTAMP}.archive.gz"

run() {
  if [ "$DRY_RUN" = "1" ]; then
    echo "[dry-run] $*"
  else
    eval "$@"
  fi
}

echo "=== Backup ==="
echo "  env:        ${ENV_NAME}"
echo "  region:     ${AWS_REGION}"
echo "  pg target:  ${POSTGRES_USER}@${POSTGRES_HOST}/${POSTGRES_DB}"
echo "  mongo:      [redacted]"
echo "  s3 prefix:  ${S3_PREFIX}"
echo "  retention:  ${RETENTION_DAYS} days"
echo "  dry-run:    ${DRY_RUN}"
echo ""

# --- Postgres dump ----------------------------------------------------------

echo "[1/4] Dumping postgres → ${PG_FILE}"
if [ "$DRY_RUN" != "1" ]; then
  PGPASSWORD="${POSTGRES_PASSWORD}" pg_dump \
    --host="${POSTGRES_HOST}" \
    --username="${POSTGRES_USER}" \
    --dbname="${POSTGRES_DB}" \
    --no-owner --no-acl --clean --if-exists \
    | gzip -9 > "${PG_FILE}" || { echo "ERROR: pg_dump failed" >&2; exit 2; }
fi

# --- MongoDB dump -----------------------------------------------------------

echo "[2/4] Dumping mongodb → ${MONGO_FILE}"
if [ "$DRY_RUN" != "1" ]; then
  mongodump --uri="${MONGODB_URI}" --archive="${MONGO_FILE}" --gzip \
    || { echo "ERROR: mongodump failed" >&2; exit 2; }
fi

# --- Upload to S3 ----------------------------------------------------------

echo "[3/4] Uploading to ${S3_PREFIX}"
run "aws s3 cp '${PG_FILE}' '${S3_PREFIX}/' --region '${AWS_REGION}'" \
  || { echo "ERROR: s3 cp postgres failed" >&2; exit 2; }
run "aws s3 cp '${MONGO_FILE}' '${S3_PREFIX}/' --region '${AWS_REGION}'" \
  || { echo "ERROR: s3 cp mongo failed" >&2; exit 2; }

# --- Retention -------------------------------------------------------------

if [ "${RETENTION_DAYS}" -gt 0 ]; then
  echo "[4/4] Pruning backups older than ${RETENTION_DAYS} days"
  CUTOFF=$(date -u -v-"${RETENTION_DAYS}"d +%Y-%m-%dT%H:%M:%SZ 2>/dev/null \
        || date -u -d "${RETENTION_DAYS} days ago" +%Y-%m-%dT%H:%M:%SZ)
  if [ "$DRY_RUN" != "1" ]; then
    aws s3api list-objects-v2 \
      --bucket "${BACKUP_BUCKET}" \
      --prefix "${ENV_NAME}/" \
      --region "${AWS_REGION}" \
      --query "Contents[?LastModified<'${CUTOFF}'].Key" \
      --output text 2>/dev/null \
      | tr '\t' '\n' \
      | grep -v '^$' \
      | while read -r key; do
          echo "  pruning $key"
          aws s3 rm "s3://${BACKUP_BUCKET}/${key}" --region "${AWS_REGION}" \
            || { echo "WARN: failed to prune $key (continuing)" >&2; }
        done || { echo "ERROR: prune step failed" >&2; exit 3; }
  else
    echo "  [dry-run] would prune objects with LastModified < ${CUTOFF}"
  fi
else
  echo "[4/4] Retention disabled (RETENTION_DAYS=0); skipping prune"
fi

echo ""
echo "=== Backup complete ==="
echo "  postgres: ${S3_PREFIX}/$(basename "${PG_FILE}")"
echo "  mongo:    ${S3_PREFIX}/$(basename "${MONGO_FILE}")"
