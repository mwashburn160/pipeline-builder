# Shell Plugin — Pure-OS plugin for arbitrary user commands
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
#
# This plugin installs nothing beyond the shared base image. It exists so
# users can run arbitrary install + build commands from their pipeline
# definition without needing to author a custom Dockerfile.
#
# What's available at runtime (from pipeline-plugin-base:24.04):
#   - bash, sh, coreutils, find, grep, sed, awk
#   - git, curl, wget, jq, ca-certificates, gnupg
#   - tar, gzip, xz-utils, zip, unzip
#   - apt-retry-install <pkgs> (for installing additional system packages)
#
# If a user needs a tool that isn't in the base, they can either:
#   1. Use `apt-retry-install <pkg>` in their installCommands
#   2. Use `curl ... | sh` to install via vendor script
#   3. Switch to a tool-specific plugin (snyk-go, terraform, etc.)

FROM pipeline-plugin-base:24.04

WORKDIR /app
CMD ["bash"]
