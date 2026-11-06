# Pipeline Builder — AWS CLI Family Base Image
#
# Built tag: plugin-aws-cli-base:1.0
#
# Used as the FROM by 17 plugins that need AWS CLI v2:
#   artifact: docker-build, ecr-push, helm-push
#   deploy:   cdk-deploy, cdk-deploy-multi-region, cloudformation, ecs-deploy,
#             helm-deploy, kubectl-deploy, lambda-deploy, pulumi, serverless-framework,
#             terraform
#   infrastructure: cdk-synth, manual-approval-custom, s3-cache
#   notification: email-notify
#
# Each plugin previously did the same `curl awscli-exe-linux-${ARCH}.zip` +
# unzip + install dance (~30 MB AWS CLI install per image). Centralizing it
# saves ~500 MB across the fleet via Docker layer dedup, and gives one place
# to bump the AWS CLI version or add SHA256 verification.
#
# Pinned: AWS CLI v2 version + per-arch SHA-256 (AWS publishes a PGP .sig
# per zip but no checksum file; the digests below were computed from the
# official awscli.amazonaws.com versioned zips). Bump all three together.

FROM plugin-base:26.10

ARG AWS_CLI_VERSION=2.39.5
ARG AWS_CLI_SHA256_AMD64=fe0553306b3d001d162bc193d3b040027aab3466b9f910b50e702c122c0f3ff9
ARG AWS_CLI_SHA256_ARM64=ce7b03ebceed1dc6a0a8f27134a41a9a3b5671f09c57ab2e7fc6d43710dbaef3

USER root
RUN set -eux; \
    case "$(dpkg --print-architecture)" in \
      amd64) arch=x86_64;  sum="${AWS_CLI_SHA256_AMD64}" ;; \
      arm64) arch=aarch64; sum="${AWS_CLI_SHA256_ARM64}" ;; \
      *) echo "unsupported architecture: $(dpkg --print-architecture)" >&2; exit 1 ;; \
    esac; \
    fetch-verified "https://awscli.amazonaws.com/awscli-exe-linux-${arch}-${AWS_CLI_VERSION}.zip" "$sum" /tmp/awscli.zip; \
    unzip -q /tmp/awscli.zip -d /tmp; \
    /tmp/aws/install; \
    rm -rf /tmp/aws /tmp/awscli.zip; \
    aws --version

WORKDIR /app
USER 1000:1000
CMD ["bash"]
