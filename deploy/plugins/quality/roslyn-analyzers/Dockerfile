# Roslyn Analyzers Plugin — .NET Static Analysis.
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder.
#
# Thin layer over plugin-dotnet-base (one pinned .NET SDK, shared by all
# .NET plugins). The Roslyn analyzers run inside `dotnet build` — no separate
# tool to install. No runtime dotnet-install — deterministic, no network at
# pipeline time.

FROM plugin-dotnet-base:1.0

WORKDIR /app
USER 1000:1000
CMD ["bash"]
