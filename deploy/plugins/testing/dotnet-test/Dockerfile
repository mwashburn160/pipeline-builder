# dotnet test Plugin — .NET Test Runner.
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder.
#
# Thin layer over pipeline-dotnet-base (one pinned .NET SDK, shared by all
# .NET plugins). `dotnet test` ships inside the SDK (no separate tool to
# install). No runtime dotnet-install — deterministic, no network at pipeline
# time.

FROM pipeline-dotnet-base:1.0

WORKDIR /app
CMD ["bash"]
