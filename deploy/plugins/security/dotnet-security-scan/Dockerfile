# dotnet security-scan Plugin — .NET Security Scanner.
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder.
#
# Thin layer over pipeline-dotnet-base (one pinned .NET SDK, shared by all
# .NET plugins). This plugin's own tool — the `security-scan` global tool —
# is pinned and baked here (no runtime `dotnet tool install`, so it is
# deterministic with no network dependency at pipeline time).

FROM pipeline-dotnet-base:1.0

# TODO(confirm): pin the intended security-scan (Security Code Scan) version.
ARG SECURITY_SCAN_VERSION=5.6.7
RUN dotnet tool install --global security-scan --version "${SECURITY_SCAN_VERSION}"

WORKDIR /app
CMD ["bash"]
