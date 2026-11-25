# dotnet security-scan Plugin — .NET Security Scanner.
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder.
#
# Thin layer over plugin-dotnet-base (one pinned .NET SDK, shared by all
# .NET plugins). This plugin's own tool — the `security-scan` global tool —
# is pinned and baked here (no runtime `dotnet tool install`, so it is
# deterministic with no network dependency at pipeline time).

FROM plugin-dotnet-base:1.0

ARG SECURITY_SCAN_VERSION=5.6.7
# Installed into ${DOTNET_ROOT}/tools (on PATH via the base, owned by uid 1000)
# rather than `--global` (~/.dotnet/tools of whichever user built the image,
# which is not on PATH and unreadable to a different runtime user).
#
# security-scan targets net6.0 at the newest (5.6.7, the project's last
# release), and the base carries only the .NET 10 runtime, so the tool aborted
# on every invocation ("You must install or update .NET"). Its runtimeconfig
# files are patched to roll forward across majors — scoped to this tool, not a
# DOTNET_ROLL_FORWARD for the whole image — and the help screen is run to fail
# the build if it still cannot start.
RUN set -eux; \
    dotnet tool install security-scan --tool-path "${DOTNET_ROOT}/tools" --version "${SECURITY_SCAN_VERSION}"; \
    for f in $(find "${DOTNET_ROOT}/tools/.store/security-scan" -name 'security-scan.runtimeconfig.json'); do \
      jq '.runtimeOptions.rollForward = "Major"' "$f" > "$f.tmp" && mv "$f.tmp" "$f"; \
    done; \
    "${DOTNET_ROOT}/tools/security-scan" --help | grep -q "v${SECURITY_SCAN_VERSION}"

WORKDIR /app
USER 1000:1000
CMD ["bash"]
