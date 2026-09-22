#!/usr/bin/env bash
set -euo pipefail

# Validate all catalog plugins. The spec schema, catalog metadata and Dockerfile
# rules (non-root final USER, no pipe-to-shell installers, every download through
# fetch-verified, …) are the ONE TypeScript implementation the upload API and
# publishers use — `pipeline-manager plugin validate --lint` — run per plugin.
# This script adds only what is specific to the repo tree (name = directory,
# category = parent directory, the files a catalog plugin must carry) and the
# optional Docker build + smoke run.
#
# Needs a built CLI: `npx nx run @pipeline-builder/pipeline-manager:post-compile` (or set
# PIPELINE_MANAGER to another invocation of it).
#
# Usage:
#   ./test-plugins.sh                       # test all plugins
#   ./test-plugins.sh language/java         # test a specific plugin
#   ./test-plugins.sh --spec-only           # only validate specs (no Docker checks)
#   ./test-plugins.sh --build               # build Docker images (slow)
#   PLUGINS_DIR=/tmp/p ./test-plugins.sh security/my-scan  # a tree outside the repo

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
. "$SCRIPT_DIR/common.sh"

# PLUGINS_DIR overrides the catalog root (a `<category>/<plugin>` tree), e.g. to
# check a scaffold from `pipeline-manager plugin new` outside the repo.
PLUGINS_DIR="${PLUGINS_DIR:-$DEPLOY_DIR/plugins}"
SPEC_ONLY=false
BUILD_IMAGES=false
SPECIFIC_PLUGIN=""
# PASSED/FAILED/SKIPPED/ERRORS are read & mutated by common.sh's
# log_*/print_results/print_errors_and_exit (sourced-globals contract).
# shellcheck disable=SC2034
PASSED=0
# shellcheck disable=SC2034
FAILED=0
# shellcheck disable=SC2034
SKIPPED=0
# shellcheck disable=SC2034
ERRORS=()

# ---- Argument parsing ----

while [ $# -gt 0 ]; do
  case "$1" in
    --spec-only) SPEC_ONLY=true; shift ;;
    --build)     BUILD_IMAGES=true; shift ;;
    --help|-h)
      echo "Usage: $0 [options] [category/plugin]"
      echo ""
      echo "Options:"
      echo "  --spec-only  Only validate specs (no Docker checks)"
      echo "  --build      Build Docker images (slow, requires Docker)"
      echo "  category/plugin  Test a specific plugin (e.g., language/java)"
      exit 0
      ;;
    *) SPECIFIC_PLUGIN="$1"; shift ;;
  esac
done

# ---- CLI --------------------------------------------------------------------

# shellcheck disable=SC2206  # a command line, split on purpose
PIPELINE_MANAGER=(${PIPELINE_MANAGER:-node "$DEPLOY_DIR/../packages/pipeline-manager/dist/cli.js"})

# _lint_plugin <plugin_dir> <fqn> — the CLI's findings as PASS/WARN/FAIL lines.
# Everything it reports is an error except warnings (medium heuristics, the
# multi-line-command `set -e` hint). --spec-only drops the Dockerfile findings.
_lint_plugin() {
  local plugin_dir="$1" fqn="$2" report line
  report="$("${PIPELINE_MANAGER[@]}" --quiet plugin validate --dir "$plugin_dir" --lint --json 2>/dev/null || true)"
  if [ -z "$report" ]; then
    log_fail "pipeline-manager plugin validate produced no report" "$fqn"
    return
  fi
  while IFS= read -r line; do
    case "$line" in
      FAIL$'\t'*) log_fail "${line#FAIL$'\t'}" "$fqn" ;;
      WARN$'\t'*) log_warn "${line#WARN$'\t'}" ;;
      PASS$'\t'*) log_pass "${line#PASS$'\t'}" ;;
    esac
  done < <(SPEC_ONLY="$SPEC_ONLY" node -e '
    let raw = ""; process.stdin.on("data", (d) => (raw += d)).on("end", () => {
      let r;
      try { r = JSON.parse(raw); } catch { console.log("FAIL\tpipeline-manager plugin validate: unparseable report"); return; }
      const specOnly = process.env.SPEC_ONLY === "true";
      const keep = (m) => !(specOnly && m.startsWith("Dockerfile:"));
      const fails = [
        ...r.problems,
        ...r.catalog.filter((f) => f.error).map((f) => `catalog: ${f.field} would be blank — ${f.error}`),
        ...r.lint.filter((l) => l.level === "error").map((l) => l.message),
        ...r.heuristics.filter((h) => h.severity === "high").map((h) => `heuristics: ${h.message} (${h.path}:${h.line})`),
      ].filter(keep);
      const warns = [
        ...r.lint.filter((l) => l.level === "warning").map((l) => l.message),
        ...r.heuristics.filter((h) => h.severity === "medium").map((h) => `heuristics: ${h.message} (${h.path}:${h.line})`),
      ].filter(keep);
      for (const m of fails) console.log(`FAIL\t${m}`);
      for (const m of warns) console.log(`WARN\t${m}`);
      if (!fails.length) console.log(`PASS\tplugin validate --lint${specOnly ? " (spec only)" : ""}`);
    });' <<<"$report")
}

# ---- Repo-tree checks + optional build --------------------------------------

test_plugin() {
  local plugin_dir="${1%/}"
  local plugin_name category
  plugin_name="$(basename "$plugin_dir")"
  category="$(basename "$(dirname "$plugin_dir")")"
  local fqn="${category}/${plugin_name}"
  local specfile="${plugin_dir}/plugin-spec.yaml"
  local dockerfile="${plugin_dir}/Dockerfile"

  echo ""
  log_info "Testing ${fqn}"

  if [ ! -f "$specfile" ]; then
    log_fail "Missing plugin-spec.yaml" "$fqn"
    return
  fi

  # `|| true` on every get_spec_field: it is `grep | head | sed`, so an ABSENT
  # field returns non-zero and, under `set -euo pipefail`, aborted the ENTIRE
  # run at the first spec missing one — with no FAIL line for that plugin and no
  # summary. A missing field must be this plugin's failure, not the framework's.
  local plugin_type
  plugin_type=$(get_spec_field pluginType "$specfile" || true)
  if [ "$plugin_type" != "ManualApprovalStep" ] && [ ! -f "$dockerfile" ]; then
    log_fail "Missing Dockerfile" "$fqn"
    return
  fi

  local spec_name spec_category
  spec_name=$(get_spec_field name "$specfile" || true)
  if [ "$spec_name" != "$plugin_name" ]; then
    log_fail "Name mismatch: spec='${spec_name}' dir='${plugin_name}'" "$fqn"
  else
    log_pass "Name matches directory"
  fi
  spec_category=$(get_spec_field category "$specfile" || true)
  if [ "$spec_category" != "$category" ]; then
    log_fail "Category mismatch: spec='${spec_category}' directory='${category}'" "$fqn"
  else
    log_pass "Category matches directory"
  fi
  _lint_plugin "$plugin_dir" "$fqn"

  # --build: docker build, launch, runtime uid != 0, and the spec's smokeTest.
  if [ "$BUILD_IMAGES" = true ] && [ "$SPEC_ONLY" = false ] && [ "$plugin_type" != "ManualApprovalStep" ]; then
    local tag="plugin-test-${fqn//\//-}:latest"
    log_info "Building Docker image: ${tag}"
    if docker build -t "$tag" "$plugin_dir" > /dev/null 2>&1; then
      log_pass "Docker build successful"

      # Smoke test: actually run the image. Without this, a Dockerfile that
      # builds but produces an unrunnable image (broken ENTRYPOINT, missing
      # CMD shell, fs that 'cd /app' can't enter) reports PASS but blows up
      # at the first real CodeBuild execution.
      #
      # Default smoke test: launch bash, print OK. If plugin-spec.yaml has
      # a `smokeTest:` field, run that command too — gives plugin authors a
      # way to assert tool-specific invariants like `which snyk && snyk --version`.
      if docker run --rm --entrypoint=/bin/bash "$tag" -c 'echo OK' > /dev/null 2>&1; then
        log_pass "Image launches"
      else
        log_fail "Image fails to launch (broken CMD/ENTRYPOINT or shell)" "$fqn"
      fi

      # The image's effective runtime uid must not be root.
      local run_uid
      run_uid=$(docker run --rm --entrypoint=/bin/sh "$tag" -c 'id -u' 2>/dev/null || true)
      if [ -n "$run_uid" ] && [ "$run_uid" != "0" ]; then
        log_pass "Image runs as uid ${run_uid}"
      else
        log_fail "Image runs as root (uid '${run_uid}')" "$fqn"
      fi

      local smoke
      smoke=$(yq eval '.smokeTest // ""' "$specfile" 2>/dev/null)
      if [ -n "$smoke" ] && [ "$smoke" != "null" ]; then
        if docker run --rm --entrypoint=/bin/bash "$tag" -c "$smoke" > /dev/null 2>&1; then
          log_pass "Smoke test passed: ${smoke}"
        else
          log_fail "Smoke test failed: ${smoke}" "$fqn"
        fi
      fi

      docker rmi "$tag" > /dev/null 2>&1 || true
    else
      log_fail "Docker build failed" "$fqn"
    fi
  fi
}

# ---- Main ----

echo -e "${BLUE}Plugin Testing Framework${NC}"
echo "========================"
echo "  Plugins: ${PLUGINS_DIR}"
echo "  Mode:    $([ "$SPEC_ONLY" = true ] && echo "spec-only" || echo "full")$([ "$BUILD_IMAGES" = true ] && echo " +docker-build" || echo "")"

# The CLI must be built — without it every plugin would fail with "no report".
# --build also needs docker, and yq for the smokeTest lookup.
preflight node
if [ "${PIPELINE_MANAGER[0]}" = node ] && [ ! -f "${PIPELINE_MANAGER[1]}" ]; then
  echo -e "${RED}pipeline-manager is not built (${PIPELINE_MANAGER[1]}): run npx nx run @pipeline-builder/pipeline-manager:post-compile${NC}" >&2
  exit 1
fi
if [ "$BUILD_IMAGES" = true ]; then
  preflight docker yq
fi

if [ -n "$SPECIFIC_PLUGIN" ]; then
  plugin_path="${PLUGINS_DIR}/${SPECIFIC_PLUGIN}"
  if [ -d "$plugin_path" ]; then
    test_plugin "$plugin_path"
  else
    echo -e "${RED}Plugin not found: ${SPECIFIC_PLUGIN}${NC}"
    exit 1
  fi
else
  for category_dir in "${PLUGINS_DIR}"/*/; do
    [ -d "$category_dir" ] || continue
    # Skip `_`-prefixed dirs (e.g. _base — shared base image, not a plugin).
    case "$(basename "$category_dir")" in _*) continue ;; esac
    for plugin_dir in "${category_dir}"/*/; do
      [ -d "$plugin_dir" ] || continue
      test_plugin "$plugin_dir"
    done
  done
fi

# ---- Summary ----

print_results

# Testing nothing is not a pass. An empty/mis-pointed PLUGINS_DIR makes the walk
# above match no plugin, and print_errors_and_exit would then print
# "All tests passed!" and exit 0 on an empty ERRORS[] — a green catalog gate
# that validated zero plugins.
if [ "$((PASSED + FAILED + SKIPPED))" -eq 0 ]; then
  echo -e "${RED}ERROR: no plugins were tested (is ${PLUGINS_DIR} populated?) — refusing to report success.${NC}" >&2
  exit 1
fi

print_errors_and_exit "All tests passed!"
