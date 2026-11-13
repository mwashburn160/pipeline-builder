#!/usr/bin/env bash
set -euo pipefail

# Load the managed toolchain release (deploy/toolchain) and every plugin in the
# catalog (deploy/plugins) into the platform — the toolchain first.
#
# Usage:
#   ./load-plugins.sh                                        # parallel mode (default)
#   ./load-plugins.sh --serial                               # one at a time with delays
#   ./load-plugins.sh --parallel 8                           # 8 concurrent uploads
#   ./load-plugins.sh --dry-run                              # validate only, no upload
#   ./load-plugins.sh --category language,security           # filter by category
#   ./load-plugins.sh --category toolchain                   # only the managed toolchain release
#   ./load-plugins.sh --rebuild                              # force rebuild all plugin.zip
#   ./load-plugins.sh --cleanup                              # remove plugin.zip + image.tar after upload

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
. "$SCRIPT_DIR/common.sh"

PLUGINS_DIR="$DEPLOY_DIR/plugins"
WORKER_SCRIPT="$SCRIPT_DIR/load-plugin-worker.sh"
UPLOAD_TIMEOUT=900
UPLOAD_RETRIES=${UPLOAD_RETRIES:-3}
UPLOAD_RETRY_DELAY=${UPLOAD_RETRY_DELAY:-30}
PARALLEL_JOBS=${PARALLEL_JOBS:-1}
UPLOAD_DELAY=${UPLOAD_DELAY:-5}
[[ "$UPLOAD_DELAY" =~ ^[0-9]+$ ]] || { echo "ERROR: UPLOAD_DELAY must be a non-negative integer (got: '$UPLOAD_DELAY')" >&2; exit 1; }
# Wait for the accepted builds to finish and report what actually happened.
# Bounded: at the deadline the run REPORTS what it saw rather than guessing —
# see the verify phase for why that distinction is the whole point.
VERIFY_BUILDS=${VERIFY_BUILDS:-true}
VERIFY_TIMEOUT=${VERIFY_TIMEOUT:-3600}
VERIFY_POLL=${VERIFY_POLL:-15}
[[ "$VERIFY_TIMEOUT" =~ ^[0-9]+$ ]] || { echo "ERROR: VERIFY_TIMEOUT must be a non-negative integer (got: '$VERIFY_TIMEOUT')" >&2; exit 1; }
[[ "$VERIFY_POLL" =~ ^[1-9][0-9]*$ ]] || { echo "ERROR: VERIFY_POLL must be a positive integer (got: '$VERIFY_POLL')" >&2; exit 1; }
SERIAL_MODE=false
DRY_RUN=false
REBUILD=false
CLEANUP=false
CATEGORY_FILTER=""

# ---- Argument parsing ----
#
# The deploy/bin convention (as in backup.sh / restore.sh): a value-taking flag
# asserts its value is THERE before reading it. A bare `"$2"` on a trailing flag
# dies under `set -u` with `$2: unbound variable`, naming neither flag nor script.

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run)   DRY_RUN=true; shift ;;
    --rebuild|--force) REBUILD=true; shift ;;
    --cleanup)   CLEANUP=true; shift ;;
    --no-verify) VERIFY_BUILDS=false; shift ;;
    --serial)    SERIAL_MODE=true; shift ;;
    --parallel)  [ $# -ge 2 ] || { echo "ERROR: $1 requires a value" >&2; exit 1; }
                 PARALLEL_JOBS="$2"
                 [[ "$PARALLEL_JOBS" =~ ^[1-9][0-9]*$ ]] || { echo "ERROR: --parallel requires a positive integer" >&2; exit 1; }
                 shift 2 ;;
    # Accumulate across repeated flags AND accept a comma-separated value, so
    # both `--category a,b` and `--category a --category b` load a+b. Plain
    # assignment silently kept only the LAST flag — a footgun that looked like
    # every category loaded when only one did.
    --category)  [ $# -ge 2 ] || { echo "ERROR: $1 requires a value" >&2; exit 1; }
                 CATEGORY_FILTER="${CATEGORY_FILTER:+$CATEGORY_FILTER,}$2"; shift 2 ;;
    --timeout)   [ $# -ge 2 ] || { echo "ERROR: $1 requires a value" >&2; exit 1; }
                 UPLOAD_TIMEOUT="$2"
                 [[ "$UPLOAD_TIMEOUT" =~ ^[1-9][0-9]*$ ]] || { echo "ERROR: --timeout requires a positive integer" >&2; exit 1; }
                 shift 2 ;;
    --help|-h)
      echo "Usage: $0 [options]"
      echo ""
      echo "Options:"
      echo "  --dry-run              Validate specs and rebuild zips, but skip upload"
      echo "  --rebuild              Force rebuild all plugin.zip files"
      echo "  --cleanup              Remove plugin.zip and image.tar after upload"
      echo "  --serial               Upload one at a time with delays"
      echo "  --parallel N           Number of concurrent uploads (default: 1)"
      echo "  --category CATEGORIES  Comma-separated categories (e.g., language,security);"
      echo "                         'toolchain' selects the managed toolchain release (deploy/toolchain)"
      echo "  --timeout SECONDS      Upload timeout in seconds (default: 900)"
      echo ""
      echo "Environment:"
      echo "  PLATFORM_TOKEN         JWT token (skips credential prompts and login)"
      echo "  PLATFORM_BASE_URL      Platform API URL (default: https://localhost:8443)"
      echo "  UPLOAD_RETRIES         Max retries on 503/connection failure (default: 3)"
      echo "  UPLOAD_RETRY_DELAY     Seconds between retries (default: 30)"
      echo "  PARALLEL_JOBS          Concurrent uploads (default: 1)"
      exit 0
      ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

# ---- Helpers ----

is_eligible_plugin() {
  [ -f "$1/plugin-spec.yaml" ] || return 1
  local _pt
  # An absent field yields "" (get_spec_field's contract), not a failure.
  _pt=$(get_spec_field pluginType "$1/plugin-spec.yaml")
  [ "$_pt" = "ManualApprovalStep" ] && return 0
  [ -f "$1/Dockerfile" ] && return 0
  local _bt
  _bt=$(get_spec_field buildType "$1/config.yaml")
  [ "$_bt" = "prebuilt" ] && return 0
  return 1
}

# ---- Category selection ----

# The managed toolchain release (deploy/toolchain) is loaded on an unfiltered
# run, and on a filtered one only when it names the `toolchain` pseudo-category;
# it is never one of the catalog categories walked below.
LOAD_TOOLCHAIN=false
if [ -n "$CATEGORY_FILTER" ]; then
  CATEGORIES=$(echo "$CATEGORY_FILTER" | tr ',' ' ')
elif [ -t 0 ]; then
  select_categories "$PLUGINS_DIR" || exit 0
  CATEGORIES=$(echo "$SELECTED_CATEGORIES" | tr ',' ' ')
  # "Load all" answers every catalog category; that run loads the toolchain too.
  [ "$SELECTED_CATEGORIES" = "$(list_categories "$PLUGINS_DIR" | paste -sd, -)" ] && LOAD_TOOLCHAIN=true
else
  CATEGORIES=$(list_categories "$PLUGINS_DIR")
  LOAD_TOOLCHAIN=true
fi
_catalog_categories=""
for category in $CATEGORIES; do
  if [ "$category" = "$TOOLCHAIN_CATEGORY" ]; then LOAD_TOOLCHAIN=true; else _catalog_categories="$_catalog_categories $category"; fi
done
CATEGORIES="${_catalog_categories# }"

# ---- Build plugin list + count ----
#
# The managed toolchain release (deploy/toolchain: pipeline-bootstrap +
# cdk-synth, one version) goes FIRST and serially, in MANAGED_TOOLCHAIN_PLUGINS
# order (bootstrap before cdk-synth) — not in the parallel pool, where the order
# is lost. Both halves are required: half a release is not a release. The
# catalog (deploy/plugins) follows in the usual order.
MANAGED_LIST=""
PLUGIN_LIST=""
TOTAL=0
if [ "$LOAD_TOOLCHAIN" = true ]; then
  for _managed in $MANAGED_TOOLCHAIN_PLUGINS; do
    plugin_dir="${TOOLCHAIN_DIR}/${_managed}/"
    if [ ! -d "$plugin_dir" ] || ! is_eligible_plugin "$plugin_dir"; then
      echo "ERROR: ${plugin_dir} is missing or not loadable — the managed toolchain release needs both halves." >&2
      exit 1
    fi
    MANAGED_LIST="${MANAGED_LIST}${plugin_dir} "
    TOTAL=$((TOTAL + 1))
  done
fi
for category in $CATEGORIES; do
  for plugin_dir in "${PLUGINS_DIR}/${category}"/*/; do
    is_eligible_plugin "$plugin_dir" || continue
    PLUGIN_LIST="${PLUGIN_LIST}${plugin_dir}\n"
    TOTAL=$((TOTAL + 1))
  done
done

# pipeline-bootstrap is only ever uploaded PREBUILT: its image is the release's
# exact bits, built, scanned and pushed to library/ by build-plugin-images.sh's
# base stage (cdk-synth is FROM it by digest). A source build at upload time would
# be different bits under the same immutable version.
for plugin_dir in $MANAGED_LIST; do
  if [ "$(basename "$plugin_dir")" = pipeline-bootstrap ] && [ ! -f "${plugin_dir}image.tar" ]; then
    echo "ERROR: ${plugin_dir}image.tar is missing — the managed toolchain release cannot be loaded without it." >&2
    echo "  Build it first: deploy/bin/build-plugin-images.sh --category toolchain" >&2
    exit 1
  fi
done

# Loading nothing is not a successful load. An empty list means the plugins tree
# is missing or `--category` named something that does not exist; falling through
# printed a 0/0/0 summary and exited 0, which init-platform.sh and CI read as a
# clean load.
if [ "$TOTAL" -eq 0 ]; then
  echo "ERROR: no eligible plugins found under $PLUGINS_DIR for categories: ${CATEGORY_FILTER:-all}" >&2
  echo "  Known categories: $TOOLCHAIN_CATEGORY $(list_categories "$PLUGINS_DIR" | tr '\n' ' ')" >&2
  exit 1
fi

# ---- Auth ----

echo "=== Plugin Loader ==="
echo "  URL:        $PLATFORM_BASE_URL"
echo "  Mode:       $([ "$SERIAL_MODE" = true ] && echo "serial" || echo "parallel (${PARALLEL_JOBS} workers)")"
echo "  Dry-run:    $DRY_RUN"
echo "  Rebuild:    $REBUILD"
echo "  Categories: ${CATEGORY_FILTER:-all}"
echo ""

JWT_TOKEN=""
[ "$DRY_RUN" = false ] && require_auth

# ---- Upload ----

COUNTER_DIR=$(mktemp -d)
[ -n "$COUNTER_DIR" ] && [ -d "$COUNTER_DIR" ] || { echo "ERROR: failed to create temp directory" >&2; exit 1; }
trap 'rm -rf "$COUNTER_DIR"' EXIT INT TERM
touch "$COUNTER_DIR/succeeded" "$COUNTER_DIR/skipped" "$COUNTER_DIR/failed" "$COUNTER_DIR/uploaded"

export PLATFORM_BASE_URL JWT_TOKEN UPLOAD_TIMEOUT UPLOAD_RETRIES UPLOAD_RETRY_DELAY
export DRY_RUN REBUILD COUNTER_DIR PLUGINS_DIR DEPLOY_DIR SCRIPT_DIR

START_TIME=$(date +%s)
echo ""
echo "=== Processing $TOTAL plugin(s) ==="

PROCESSED=0
# The managed release first, serially, in order. A failed bootstrap upload stops
# cdk-synth from being uploaded alone: half a release is not a release. (An
# already-present version — exit 2 — is fine: the pair can still complete.)
_bootstrap_failed=false
if [ -n "$MANAGED_LIST" ]; then
  echo ""
  echo "--- managed toolchain release ---"
  for plugin_dir in $MANAGED_LIST; do
    PROCESSED=$((PROCESSED + 1))
    _mname=$(basename "$plugin_dir")
    echo "  [$PROCESSED/$TOTAL] $TOOLCHAIN_CATEGORY/${_mname}"
    if [ "$_mname" = cdk-synth ] && [ "$_bootstrap_failed" = true ]; then
      echo "  FAIL $TOOLCHAIN_CATEGORY/cdk-synth (not uploaded: its pipeline-bootstrap half failed)"
      echo "1" >> "$COUNTER_DIR/failed"
      continue
    fi
    _wrc=0
    "$WORKER_SCRIPT" "$plugin_dir" || _wrc=$?
    [ "$_mname" = pipeline-bootstrap ] && [ "$_wrc" -eq 1 ] && _bootstrap_failed=true
  done
fi

if [ "$SERIAL_MODE" = true ]; then
  while IFS= read -r plugin_dir; do
    [ -n "$plugin_dir" ] || continue
    PROCESSED=$((PROCESSED + 1))
    echo "  [$PROCESSED/$TOTAL] $(basename "$(dirname "$plugin_dir")")/$(basename "$plugin_dir")"
    "$WORKER_SCRIPT" "$plugin_dir" || true
    remaining=$((TOTAL - PROCESSED))
    [ "$DRY_RUN" = false ] && [ "$UPLOAD_DELAY" -gt 0 ] && [ "$remaining" -gt 0 ] && sleep "$UPLOAD_DELAY"
  done < <(printf '%b' "$PLUGIN_LIST")
else
  # `|| true`: a worker exits 1 (fail) or 2 (skip/already-exists); xargs returns
  # 123 for any 1-125 exit, which under `set -e` would abort before the summary.
  # The real result lives in the counter files; the exit gate at the end of the
  # script propagates any failure.
  [ -n "$PLUGIN_LIST" ] && { printf '%b' "$PLUGIN_LIST" | xargs -P "$PARALLEL_JOBS" -I{} "$WORKER_SCRIPT" "{}" || true; }
fi

# ---- Summary ----

SUCCEEDED=$(wc -l < "$COUNTER_DIR/succeeded" | tr -d ' ')
SKIPPED=$(wc -l < "$COUNTER_DIR/skipped" | tr -d ' ')
FAILED=$(wc -l < "$COUNTER_DIR/failed" | tr -d ' ')

DURATION=$(( $(date +%s) - START_TIME ))
print_summary "$TOTAL" "$SUCCEEDED" "$FAILED" "$SKIPPED" "$DURATION"

# Every plugin must land in exactly one bucket. A worker that dies before it can
# write a counter (OOM-killed, killed by the xargs `-P` teardown, aborted by an
# unguarded `set -e` path) is otherwise INVISIBLE: FAILED stays 0 and the exit
# gate below reports a clean load for plugins that never uploaded. Reconcile.
ACCOUNTED=$((SUCCEEDED + SKIPPED + FAILED))
if [ "$ACCOUNTED" -ne "$TOTAL" ]; then
  echo "" >&2
  echo "ERROR: $((TOTAL - ACCOUNTED)) of $TOTAL plugin(s) produced no result at all" >&2
  echo "  (succeeded=$SUCCEEDED skipped=$SKIPPED failed=$FAILED). A worker died before" >&2
  echo "  recording its outcome — treating the run as failed rather than green." >&2
  exit 1
fi

# ---- Verify the builds actually finished -----------------------------------
#
# The upload answers 202 Accepted; the image build, the cosign signature, the
# grype scan and PLUGIN_VULN_GATE all run asynchronously after it. Counting the
# 202s alone reported "119/119 succeeded" for an install in which 80 builds had
# failed terminally and only 37 plugins were live — the load looked clean and
# most of the catalogue was missing.
#
# THIS USED TO BE REMOVED, and for a sound reason: the previous version polled
# until every accepted plugin had a version and reported a FAILED load
# otherwise, which could not tell the two outcomes that matter apart — a build
# that FAILED, and a build that has not FINISHED. Any fixed budget expired
# mid-run on a cold cluster and declared ~100 healthy plugins failed, naming
# PLUGIN_VULN_GATE as the likely cause: a confident, wrong diagnosis.
#
# What makes it safe now is that both signals exist separately, so there are
# THREE outcomes rather than two:
#   built          — the version row carries an image digest (or the plugin is
#                    metadata_only and produces no image by design)
#   failed         — the build queue says so, WITH the reason, from
#                    /plugins/queue/triage's grouped categories
#   still building — accepted, not yet either of the above
#
# The deadline bounds how long this WAITS; it never decides the verdict. At the
# deadline "still building" is reported as itself and the run stays green on it.
# Only a build the queue reports as FAILED makes this red, because only that is
# a fact rather than an absence.

if [ "$VERIFY_BUILDS" = true ] && [ "$DRY_RUN" = false ] && [ "$SUCCEEDED" -gt 0 ]; then
  echo ""
  echo "=== Verifying $SUCCEEDED accepted build(s) ==="
  echo "  (waiting up to ${VERIFY_TIMEOUT}s; a timeout reports what it saw, it does not fail the run)"

  _api_get() {
    _curl_authed -s --insecure --max-time 60 "${PLATFORM_BASE_URL}$1" 2>/dev/null || true
  }

  # `name<TAB>version` of what this run uploaded. Checked by NAME+VERSION rather
  # than by total count: a catalogue that already holds most of its plugins makes
  # a total meaningless, and `--rebuild` re-uploads versions that already exist.
  _want_count=$(wc -l < "$COUNTER_DIR/uploaded" | tr -d ' ')

  _deadline=$(( $(date +%s) + VERIFY_TIMEOUT ))
  _built=0 _failed=0 _timed_out=false
  while :; do
    # The system org's own plugins, with the two fields that decide "built".
    # A high limit in one page: the catalogue is ~120 and paging here would
    # make the loop's arithmetic depend on page boundaries.
    _list=$(_api_get "/api/plugins?limit=500")
    _built=$(
      printf '%s' "$_list" | python3 -c '
import json, sys
try:
    body = json.load(sys.stdin)
except Exception:
    print(0); raise SystemExit
rows = (body.get("data") or {}).get("plugins") or []
want = set()
with open(sys.argv[1], encoding="utf-8") as fh:
    for line in fh:
        parts = line.rstrip("\n").split("\t")
        if len(parts) >= 2 and parts[0]:
            want.add((parts[0], parts[1]))
done = 0
for r in rows:
    key = (r.get("name"), r.get("version"))
    if key not in want:
        continue
    # A metadata_only plugin (an approval step) produces no image by design, so
    # its presence IS completion; anything else needs the digest the build
    # writes once the image is pushed, signed and SBOM-attested.
    if r.get("buildType") == "metadata_only" or r.get("imageDigest"):
        done += 1
print(done)
' "$COUNTER_DIR/uploaded" 2>/dev/null || echo 0
    )
    _failed=$(
      printf '%s' "$(_api_get /api/plugins/queue/triage)" | python3 -c '
import json, sys
try:
    body = json.load(sys.stdin)
except Exception:
    print(0); raise SystemExit
print((body.get("data") or {}).get("totalFailed") or 0)
' 2>/dev/null || echo 0
    )
    [ "$(( _built + _failed ))" -ge "$_want_count" ] && break
    if [ "$(date +%s)" -ge "$_deadline" ]; then _timed_out=true; break; fi
    printf '\r  built=%s failed=%s of %s ...' "$_built" "$_failed" "$_want_count"
    sleep "$VERIFY_POLL"
  done
  printf '\r%s\r' "                                             "

  _pending=$(( _want_count - _built - _failed ))
  [ "$_pending" -lt 0 ] && _pending=0
  echo "  built:          $_built"
  echo "  failed:         $_failed"
  echo "  still building: $_pending"

  if [ "$_failed" -gt 0 ]; then
    echo ""
    echo "  Failures by category (from /plugins/queue/triage):"
    printf '%s' "$(_api_get /api/plugins/queue/triage)" | python3 -c '
import json, sys
try:
    body = json.load(sys.stdin)
except Exception:
    raise SystemExit
for g in ((body.get("data") or {}).get("groups") or []):
    names = ", ".join((g.get("pluginNames") or [])[:8])
    count = g.get("count")
    category = g.get("category")
    suffix = " - " + names if names else ""
    print("    {0}x {1}{2}".format(count, category, suffix))
' 2>/dev/null || echo "    (could not read the triage breakdown)"
    echo ""
    echo "  The Builds page (Queue / Failed-Triage) carries the full reason per" >&2
    echo "  plugin, including the CVE and fixed version for a PLUGIN_VULN_GATE." >&2
    echo "ERROR: $_failed build(s) failed after a clean upload — the catalogue is incomplete." >&2
    FAILED=$((FAILED + _failed))
  elif [ "$_timed_out" = true ]; then
    echo ""
    echo "  WARN: still building at the ${VERIFY_TIMEOUT}s deadline. This is NOT a failure —"
    echo "  builds land at roughly one a minute on a cold cluster. Re-run with a larger"
    echo "  VERIFY_TIMEOUT, or watch the Builds page."
  fi
fi


# ---- Cleanup ----

if [ "$CLEANUP" = true ]; then
  echo ""
  echo "=== Cleaning up build artifacts ==="
  _cleaned=0
  # The toolchain halves this run loaded ($MANAGED_LIST), then the catalog.
  _cleanup_dirs="$MANAGED_LIST"
  for category in $CATEGORIES; do
    for _pdir in "${PLUGINS_DIR}/${category}"/*/; do
      [ -d "$_pdir" ] || continue
      _cleanup_dirs="${_cleanup_dirs}${_pdir} "
    done
  done
  for _pdir in $_cleanup_dirs; do
    for _artifact in "${_pdir%/}/plugin.zip" "${_pdir%/}/image.tar"; do
      [ -f "$_artifact" ] && rm -f "$_artifact" && _cleaned=$((_cleaned + 1))
    done
  done
  echo "  Removed ${_cleaned} artifact file(s)"
fi

echo ""
echo "=== Done ==="

# Propagate partial-failure to the exit code so CI / init-platform.sh catches it
# instead of a masked green (matches load-templates.sh).
[ "$FAILED" -gt 0 ] && exit 1
exit 0
