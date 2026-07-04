# NuGet Publish Plugin — Publish packages to NuGet Gallery.
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder.
#
# Thin layer over pipeline-dotnet-base (one pinned .NET SDK, shared by all
# .NET plugins). `dotnet pack` / `dotnet nuget push` ship inside the SDK — no
# separate tool to install. No runtime dotnet-install — deterministic, no
# network at pipeline time.
#
# NUGET_API_KEY is injected at runtime via CodeBuild secrets (never baked).

FROM pipeline-dotnet-base:1.0

# Non-sensitive publish target default (overridable per-step via env).
ENV NUGET_SOURCE=https://api.nuget.org/v3/index.json

WORKDIR /app
CMD ["bash"]
