# CloudFormation Plugin — AWS Infrastructure Provisioning
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
# Validates, deploys, and manages CloudFormation stacks
# Includes cfn-lint for template validation

# ─── Tool versions (override with --build-arg) ───
ARG RAIN_VERSION=1.18.0

FROM pipeline-aws-cli-base:1.0

ARG RAIN_VERSION

RUN apt-retry-install python3 python3-pip

# ─── cfn-lint for CloudFormation template validation ───
RUN pip3 install --no-cache-dir --break-system-packages cfn-lint==1.31.1

# ─── rain for CloudFormation deployment (modern CLI) ───
RUN ARCH=$(dpkg --print-architecture) && curl -fsSL "https://github.com/aws-cloudformation/rain/releases/download/v${RAIN_VERSION}/rain-v${RAIN_VERSION}_linux-${ARCH}.zip" \
    -o /tmp/rain.zip && unzip -q /tmp/rain.zip -d /tmp && mv /tmp/rain-v${RAIN_VERSION}_linux-${ARCH}/rain /usr/local/bin/rain && rm -rf /tmp/rain*

# ─── Runtime configuration defaults ───
ENV CFN_TEMPLATE=""
ENV CFN_STACK_NAME=""
ENV CFN_ACTION=validate
ENV CFN_PARAMETERS=""
ENV CFN_CAPABILITIES=CAPABILITY_IAM,CAPABILITY_NAMED_IAM
ENV CFN_REGION=us-east-1

# Working directory for pipeline source
WORKDIR /app

# Default entrypoint — overridden by CodeBuildStep commands
CMD ["bash"]
