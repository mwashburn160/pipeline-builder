# Email Notify Plugin — Pipeline Email Notifications
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
# Sends email via AWS SES or SMTP

FROM pipeline-aws-cli-base:1.0

# Build steps below need root (apt, writes under /usr/local, /opt or /etc);
# the image drops back to the unprivileged `plugin` user (uid 1000) at the end.
USER root

RUN apt-retry-install python3

# ─── Runtime configuration defaults ───
ENV EMAIL_PROVIDER=ses
ENV EMAIL_TO=""
ENV EMAIL_FROM=""
ENV EMAIL_SUBJECT="Pipeline Notification"
ENV PIPELINE_NAME=""
ENV PIPELINE_STATUS=""
ENV AWS_REGION=us-east-1

# Working directory for pipeline source
WORKDIR /app
USER 1000:1000

# Default entrypoint — overridden by CodeBuildStep commands
CMD ["bash"]
