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
# Optional — MinIO object-storage backup (attachments/registry/loki/thanos):
#   Enabled when MINIO_ENDPOINT is set. Mirrors each MinIO bucket to a durable
#   backup target with `mc mirror` (additive: copies new/changed objects, never
#   deletes from the backup). Requires the `mc` (MinIO client) binary.
#   MINIO_ENDPOINT               source MinIO URL (e.g. http://minio:9000)
#   MINIO_ROOT_USER              source MinIO access key
#   MINIO_ROOT_PASSWORD          source MinIO secret key
#   MINIO_BACKUP_TARGET_URL      destination S3/MinIO URL (e.g. https://s3.us-east-1.amazonaws.com)
#   MINIO_BACKUP_TARGET_ACCESS_KEY / _SECRET_KEY   destination credentials
#   MINIO_BACKUP_TARGET_BUCKET   destination bucket that receives the mirror (default: ${BACKUP_BUCKET})
#   MINIO_BUCKETS                space-separated source buckets (default: "message-attachments registry loki thanos")
#
# Usage:
#   ./backup.sh                                 # backs up + uploads + prunes
#   DRY_RUN=1 ./backup.sh                       # prints actions without executing
#
# Exit codes:
#   0  success (a failed retention prune only WARNs and continues — it does NOT
#      fail the run, since the dumps already succeeded; an earlier `exit 3` here
#      caused spurious operator pages and was intentionally removed)
#   1  required env var missing
#   2  dump or upload failed
# ============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=common.sh
. "$SCRIPT_DIR/common.sh"

# --- Required env vars -------------------------------------------------------

require_env BACKUP_BUCKET POSTGRES_HOST POSTGRES_USER POSTGRES_PASSWORD MONGODB_URI

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
    "$@"
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
if [ -n "${MINIO_ENDPOINT:-}" ]; then
  echo "[4/5] Mirroring MinIO buckets → ${MINIO_BACKUP_TARGET_URL:-<unset>}"
  require_env MINIO_ROOT_USER MINIO_ROOT_PASSWORD \
             MINIO_BACKUP_TARGET_URL MINIO_BACKUP_TARGET_ACCESS_KEY MINIO_BACKUP_TARGET_SECRET_KEY
  # mc is REQUIRED once MinIO backup is enabled — a missing binary is a
  # misconfiguration, not a reason to silently skip object-storage backup.
  command -v mc >/dev/null 2>&1 || { echo "ERROR: MINIO_ENDPOINT set but 'mc' (MinIO client) not found" >&2; exit 2; }

  MINIO_BUCKETS="${MINIO_BUCKETS:-message-attachments registry loki thanos}"
  MINIO_BACKUP_TARGET_BUCKET="${MINIO_BACKUP_TARGET_BUCKET:-${BACKUP_BUCKET}}"
  # Isolate mc config to this run (don't touch the invoker's ~/.mc).
  MC_CONFIG_DIR="${WORKDIR}/.mc"

  if [ "$DRY_RUN" != "1" ]; then
    mc --config-dir "$MC_CONFIG_DIR" alias set pbsrc "$MINIO_ENDPOINT" "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null \
      || { echo "ERROR: mc alias set (source) failed" >&2; exit 2; }
    mc --config-dir "$MC_CONFIG_DIR" alias set pbdst "$MINIO_BACKUP_TARGET_URL" "$MINIO_BACKUP_TARGET_ACCESS_KEY" "$MINIO_BACKUP_TARGET_SECRET_KEY" >/dev/null \
      || { echo "ERROR: mc alias set (target) failed" >&2; exit 2; }
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

if [ "${RETENTION_DAYS}" -gt 0 ]; then
  echo "[5/5] Pruning backups older than ${RETENTION_DAYS} days"
  CUTOFF=$(date -u -v-"${RETENTION_DAYS}"d +%Y-%m-%dT%H:%M:%SZ 2>/dev/null \
        || date -u -d "${RETENTION_DAYS} days ago" +%Y-%m-%dT%H:%M:%SZ)
  if [ "$DRY_RUN" != "1" ]; then
    # Capture the key list first, THEN iterate — don't put control flow on grep's
    # exit status: `grep -v '^$'` exits 1 when there's nothing to prune, which
    # under `set -o pipefail` falsely failed the whole step (spurious exit 3 /
    # operator page). `|| true` keeps an empty result from failing the capture.
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
if [ -n "${MINIO_ENDPOINT:-}" ]; then
  echo "  minio:    ${MINIO_BACKUP_TARGET_BUCKET:-${BACKUP_BUCKET}}/minio/${ENV_NAME}/ (mirrored: ${MINIO_BUCKETS:-message-attachments registry loki thanos})"
fi
