# Checkstyle Plugin — Java Code Style Enforcement
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
# Enforces coding standards for Java projects (Google, Sun, custom)
#
# Thin layer over pipeline-jvm-base (one pinned Corretto JDK + build tools).
# Only Checkstyle itself is added here — a single pinned all-in-one jar baked
# at build time (no runtime download; deterministic, no network at pipeline
# time). Bump CHECKSTYLE_VERSION and rebuild to change.

FROM pipeline-jvm-base:1.0

# Writes under /opt need root; dropped to uid 1000 at the end.
USER root

# Pinned jar + the two bundled configs at the same release tag, each with a
# pinned digest (upstream publishes no checksum file; digests computed from the
# checkstyle-${CHECKSTYLE_VERSION} release asset and tagged sources).
ARG CHECKSTYLE_VERSION=14.1.0
ARG CHECKSTYLE_JAR_SHA256=51e2bc7fed1bb56808aa39045f655a316194997acd24bac5195253dcf342b380
ARG CHECKSTYLE_GOOGLE_SHA256=34d2f4d282b7b1ae5790e117ea9c81cf3090bdc84e7460f08b59ee5f543b97bc
ARG CHECKSTYLE_SUN_SHA256=b66b3cdc2d22e24145e1ef29c0083daa5dec57c739278a6d9536d5f2d44fd358
RUN set -eux; \
    fetch-verified "https://github.com/checkstyle/checkstyle/releases/download/checkstyle-${CHECKSTYLE_VERSION}/checkstyle-${CHECKSTYLE_VERSION}-all.jar" \
       "${CHECKSTYLE_JAR_SHA256}" /opt/checkstyle/checkstyle.jar; \
    fetch-verified "https://raw.githubusercontent.com/checkstyle/checkstyle/checkstyle-${CHECKSTYLE_VERSION}/src/main/resources/google_checks.xml" \
       "${CHECKSTYLE_GOOGLE_SHA256}" /opt/checkstyle/configs/google_checks.xml; \
    fetch-verified "https://raw.githubusercontent.com/checkstyle/checkstyle/checkstyle-${CHECKSTYLE_VERSION}/src/main/resources/sun_checks.xml" \
       "${CHECKSTYLE_SUN_SHA256}" /opt/checkstyle/configs/sun_checks.xml

WORKDIR /app
USER 1000:1000
CMD ["bash"]
