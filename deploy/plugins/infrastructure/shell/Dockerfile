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
#   - fetch-verified <url> <sha256> <dest> (pinned, checksum-verified downloads)
#
# If a user needs a tool that isn't in the base, they can either:
#   1. Use `apt-retry-install <pkg>` in their installCommands
#   2. Download a pinned release with `fetch-verified` (never pipe a remote
#      installer script into a shell)
#   3. Switch to a tool-specific plugin (snyk-go, terraform, etc.)
#
# (This previously built FROM bare ubuntu:24.04, which lacked the base helpers
# listed above and failed its own smokeTest's `which apt-retry-install`.)

FROM pipeline-plugin-base:24.04

WORKDIR /app
USER 1000:1000
CMD ["bash"]
