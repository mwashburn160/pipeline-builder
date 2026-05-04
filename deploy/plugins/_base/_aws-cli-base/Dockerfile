# Pipeline Builder — AWS CLI Family Base Image
#
# Built tag: pipeline-aws-cli-base:1.0
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
# Note: AWS CLI v2 is multi-platform; the install script auto-detects ARCH.
# We don't pin a specific version because AWS releases breaking changes
# rarely on v2; if you need to pin, override AWS_CLI_VERSION at build time.

FROM pipeline-plugin-base:24.04

ARG AWS_CLI_VERSION="latest"

RUN set -eux; \
    ARCH=$(uname -m); \
    if [ "$AWS_CLI_VERSION" = "latest" ]; then \
      _url="https://awscli.amazonaws.com/awscli-exe-linux-${ARCH}.zip"; \
    else \
      _url="https://awscli.amazonaws.com/awscli-exe-linux-${ARCH}-${AWS_CLI_VERSION}.zip"; \
    fi; \
    for i in 1 2 3 4 5; do \
      curl -fsSL "$_url" -o /tmp/awscli.zip && break \
        || { echo "AWS CLI download attempt $i failed; sleeping $((i * 10))s"; sleep $((i * 10)); }; \
    done; \
    unzip -q /tmp/awscli.zip -d /tmp; \
    /tmp/aws/install; \
    rm -rf /tmp/aws /tmp/awscli.zip; \
    aws --version
