# .NET Plugin — build/test C#/F# applications on the shared pinned .NET SDK.
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder.
#
# Thin layer over pipeline-dotnet-base (one pinned .NET SDK, shared by all
# .NET plugins). No runtime dotnet-install — the SDK is baked into the base
# (deterministic, no network dependency at pipeline time). `dotnet` is on PATH
# and DOTNET_ROOT is set by the base.

FROM pipeline-dotnet-base:1.0

WORKDIR /app
CMD ["bash"]
