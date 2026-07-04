# Checkstyle Plugin — Java Code Style Enforcement
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
# Enforces coding standards for Java projects (Google, Sun, custom)
#
# Thin layer over pipeline-jvm-base (one pinned Corretto JDK + build tools).
# Only Checkstyle itself is added here — a single pinned all-in-one jar baked
# at build time (no runtime download; deterministic, no network at pipeline
# time). Bump CHECKSTYLE_VERSION and rebuild to change.

FROM pipeline-jvm-base:1.0

ARG CHECKSTYLE_VERSION=10.21.1
RUN mkdir -p /opt/checkstyle/configs \
    && curl -fsSL "https://github.com/checkstyle/checkstyle/releases/download/checkstyle-${CHECKSTYLE_VERSION}/checkstyle-${CHECKSTYLE_VERSION}-all.jar" \
       -o /opt/checkstyle/checkstyle.jar \
    && curl -fsSL "https://raw.githubusercontent.com/checkstyle/checkstyle/checkstyle-${CHECKSTYLE_VERSION}/src/main/resources/google_checks.xml" \
       -o /opt/checkstyle/configs/google_checks.xml \
    && curl -fsSL "https://raw.githubusercontent.com/checkstyle/checkstyle/checkstyle-${CHECKSTYLE_VERSION}/src/main/resources/sun_checks.xml" \
       -o /opt/checkstyle/configs/sun_checks.xml

WORKDIR /app
CMD ["bash"]
