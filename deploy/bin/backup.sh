#!/usr/bin/env bash
# ============================================================================
# Pipeline Builder — Postgres + MongoDB (+ object storage) backup to S3
# ============================================================================
# One implementation for every deploy target; each target's bin/backup.sh is a
# thin wrapper that picks the connection mode:
#
#   --connect k8s     (minikube / ec2 / eks) the datastores run INSIDE the
#                     cluster, so their service names aren't resolvable from the
#                     host. Stands up short-lived `kubectl port-forward`s to
#                     postgres/mongodb (+ the object store when enabled), rewrites
#                     the connection env to the local tunnels, and tears them
#                     down on exit. The dump is LOGICAL (over the network), so it
#                     captures the real data wherever it physically lives (e.g.
#                     the minikube VM disk) — never a copy of an empty host folder.
#   --connect direct  (docker) connect to POSTGRES_HOST / MONGODB_URI /
#                     S3_ENDPOINT as given.
#
# Cron-friendly: writes timestamped dumps to s3://${BACKUP_BUCKET}/<env>/<date>/.
#
# Required env vars:
#   BACKUP_BUCKET            S3 bucket name (without s3:// prefix)
#   POSTGRES_HOST            postgres host (k8s: the in-cluster name is fine — rewritten)
#   POSTGRES_USER            postgres user
#   POSTGRES_PASSWORD        postgres password (consumed via PGPASSWORD)
#   POSTGRES_DB              postgres database name (default: pipeline_builder)
#   MONGODB_URI              full mongo connection string (k8s: rewritten to the tunnel)
#
# Optional:
#   ENV_NAME                 environment label embedded in S3 path (default: prod)
#   AWS_REGION               AWS region (default: us-east-1)
#   RETENTION_DAYS           prune objects older than this in S3 (default: 30; 0 disables)
#   DRY_RUN=1                print actions without executing (k8s: NO cluster needed)
#
# Port-forward tunables (--connect k8s):
#   PB_NAMESPACE (default pipeline-builder), PB_KUBE_CONTEXT (default current),
#   PG_LOCAL_PORT (15432), MONGO_LOCAL_PORT (27018), OBJECTSTORE_LOCAL_PORT (19000).
#
# Optional — object-storage backup:
#   Enabled when S3_BACKUP_TARGET_URL is set (the SOURCE side, S3_ENDPOINT +
#   RUSTFS_ROOT_ACCESS_KEY/SECRET_KEY, is already in every target's .env — only
#   the destination is opt-in). Mirrors each bucket to a durable backup target
#   with `rclone copy` (additive: copies new/changed objects, never deletes from
#   the backup — NOT `rclone sync`, which would delete from the backup whatever
#   a source deletion removed, defeating the point of a backup; verified live).
#   Requires the `rclone` binary.
#   S3_BACKUP_TARGET_URL          destination S3-compatible URL (e.g. https://s3.us-east-1.amazonaws.com)
#   S3_BACKUP_TARGET_ACCESS_KEY / _SECRET_KEY   destination credentials
#   S3_BACKUP_TARGET_BUCKET       destination bucket that receives the mirror (default: ${BACKUP_BUCKET})
#   OBJECTSTORE_BUCKETS           space-separated source buckets (default: PB_OBJECTSTORE_BUCKETS
#                                  in common.sh — every bucket the bootstrap Job creates)
#
# Usage:
#   deploy/<target>/bin/backup.sh               # dump + upload + prune
#   DRY_RUN=1 deploy/<target>/bin/backup.sh     # prints actions only
#
# Exit codes:
#   0  success (a failed retention prune only WARNs — the dumps already succeeded)
#   1  argument / required env var missing / port-forward not ready
#   2  dump or upload failed
# ============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=common.sh
. "$SCRIPT_DIR/common.sh"
# shellcheck source=db-connect.sh
. "$SCRIPT_DIR/db-connect.sh"

CONNECT=""
while [ $# -gt 0 ]; do
  case "$1" in
    --connect) [ $# -ge 2 ] || { echo "--connect requires k8s|direct" >&2; exit 1; }; CONNECT="$2"; shift ;;
    -h|--help) pb_usage_from_header "$SCRIPT_DIR/${BASH_SOURCE[0]##*/}"; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 1 ;;
  esac
  shift
done
case "$CONNECT" in k8s|direct) ;; *) echo "ERROR: --connect k8s|direct is required" >&2; exit 1 ;; esac

# --- Required env vars -------------------------------------------------------

require_env BACKUP_BUCKET POSTGRES_HOST POSTGRES_USER POSTGRES_PASSWORD MONGODB_URI

ENV_NAME="${ENV_NAME:-prod}"
AWS_REGION="${AWS_REGION:-us-east-1}"
POSTGRES_DB="${POSTGRES_DB:-pipeline_builder}"
RETENTION_DAYS="${RETENTION_DAYS:-30}"
DRY_RUN="${DRY_RUN:-0}"
OBJECTSTORE_BUCKETS="${OBJECTSTORE_BUCKETS:-$PB_OBJECTSTORE_BUCKETS}"
WANT_OBJECTSTORE=0
[ -n "${S3_BACKUP_TARGET_URL:-}" ] && WANT_OBJECTSTORE=1

# Validate the object-store half of the configuration HERE, not at step [4/5].
# Checked there, a missing S3_BACKUP_TARGET_* or an absent `rclone` only
# surfaced after a full postgres + mongo dump and upload had already run — a
# slow, expensive way to learn the run was never going to complete.
if [ "$WANT_OBJECTSTORE" = "1" ]; then
  require_env S3_ENDPOINT RUSTFS_ROOT_ACCESS_KEY RUSTFS_ROOT_SECRET_KEY \
             S3_BACKUP_TARGET_URL S3_BACKUP_TARGET_ACCESS_KEY S3_BACKUP_TARGET_SECRET_KEY
  command -v rclone >/dev/null 2>&1 || { echo "ERROR: S3_BACKUP_TARGET_URL set but 'rclone' not found" >&2; exit 2; }
fi

# One EXIT trap for BOTH the temp workdir and any port-forwards.
WORKDIR=""
cleanup() {
  [ -n "$WORKDIR" ] && rm -rf "$WORKDIR"
  pb_pf_down
}
trap cleanup EXIT INT TERM

# Tunnel to the in-cluster datastores — UNLESS this is a DRY_RUN (the dump never
# connects then, so no cluster/kubectl is required).
if [ "$CONNECT" = k8s ] && [ "$DRY_RUN" != "1" ]; then
  pb_pf_up_db
  [ "$WANT_OBJECTSTORE" = "1" ] && pb_pf_up_objectstore
fi

TIMESTAMP=$(date -u +%Y%m%dT%H%M%SZ)
DATE_DIR=$(date -u +%Y/%m/%d)
S3_PREFIX="s3://${BACKUP_BUCKET}/${ENV_NAME}/${DATE_DIR}"

WORKDIR=$(mktemp -d)

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

# Verify both archives before they leave the host. `gzip -t` decompresses each
# member and checks its CRC, so a dump truncated at close (out of space on the
# temp filesystem) is caught HERE — not months later by the restore that was
# supposed to use it. restore.sh runs the same check before it drops anything.
if [ "$DRY_RUN" != "1" ]; then
  gzip -t "${PG_FILE}" || { echo "ERROR: the postgres dump failed its gzip integrity check — not uploading" >&2; exit 2; }
  gzip -t "${MONGO_FILE}" || { echo "ERROR: the mongo dump failed its gzip integrity check — not uploading" >&2; exit 2; }
fi

echo "[3/5] Uploading to ${S3_PREFIX}"
run aws s3 cp "${PG_FILE}" "${S3_PREFIX}/" --region "${AWS_REGION}" \
  || { echo "ERROR: s3 cp postgres failed" >&2; exit 2; }
run aws s3 cp "${MONGO_FILE}" "${S3_PREFIX}/" --region "${AWS_REGION}" \
  || { echo "ERROR: s3 cp mongo failed" >&2; exit 2; }

# --- Object storage (optional) ----------------------------------------------
# `rclone copy` is additive (copies new/changed objects; never deletes from the
# backup — unlike `rclone sync`, which deletes from the DESTINATION whatever
# vanished from the source, verified live before using it here), so a delete in
# the source can't wipe the backup — pair the target with bucket versioning for
# point-in-time recovery. A FAILURE here fails the run (exit 2): a backup that
# silently skips object storage is a false green, and so is a missing `rclone`
# once S3_BACKUP_TARGET_URL asks for it.
#
# Destination path keeps the literal `/minio/` segment (not `/objectstore/`)
# deliberately: it is durable S3 key history, not code, and any backups already
# sitting in a live bucket from before this migration used that prefix —
# renaming it here would silently split backup continuity into two prefixes
# with no code left that knows about the old one.
if [ "$WANT_OBJECTSTORE" = "1" ]; then
  echo "[4/5] Mirroring object-store buckets → ${S3_BACKUP_TARGET_URL:-<unset>}"
  # (env + `rclone` were validated up front, before the dumps)
  S3_BACKUP_TARGET_BUCKET="${S3_BACKUP_TARGET_BUCKET:-${BACKUP_BUCKET}}"
  # Isolate rclone's config to this run (don't touch the invoker's own config).
  RCLONE_CONFIG_FILE="${WORKDIR}/rclone.conf"

  if [ "$DRY_RUN" != "1" ]; then
    rclone_setup_config "$RCLONE_CONFIG_FILE"
    for b in ${OBJECTSTORE_BUCKETS}; do
      echo "  mirroring ${b} → ${S3_BACKUP_TARGET_BUCKET}/minio/${ENV_NAME}/${b}"
      rclone --config "$RCLONE_CONFIG_FILE" copy --quiet \
        "pbsrc:${b}" "pbdst:${S3_BACKUP_TARGET_BUCKET}/minio/${ENV_NAME}/${b}" \
        || { echo "ERROR: rclone copy of bucket ${b} failed" >&2; exit 2; }
    done
  else
    echo "  [dry-run] would rclone copy [${OBJECTSTORE_BUCKETS}] → pbdst:${S3_BACKUP_TARGET_BUCKET}/minio/${ENV_NAME}/"
  fi
else
  echo "[4/5] Object-store backup disabled (S3_BACKUP_TARGET_URL unset); skipping object-storage mirror"
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
    # Capture the key list first, THEN iterate — never put control flow on grep's
    # exit status: `grep -v '^$'` exits 1 when there is nothing to prune, which
    # under `set -o pipefail` would fail the step. `|| true` keeps an empty
    # result from failing the capture.
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
if [ "$WANT_OBJECTSTORE" = "1" ]; then
  echo "  objects:  ${S3_BACKUP_TARGET_BUCKET:-${BACKUP_BUCKET}}/minio/${ENV_NAME}/ (mirrored: ${OBJECTSTORE_BUCKETS})"
fi
