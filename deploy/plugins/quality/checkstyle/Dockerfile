# Checkstyle Plugin — Java Code Style Enforcement
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
# Enforces coding standards for Java projects (Google, Sun, custom)
#
# Thin layer over plugin-jvm-base (one pinned Corretto JDK + build tools).
# Only Checkstyle itself is added here — a single pinned all-in-one jar baked
# at build time (no runtime download; deterministic, no network at pipeline
# time). Bump CHECKSTYLE_VERSION and rebuild to change.

FROM plugin-jvm-base:1.0

# Writes under /opt need root; dropped to uid 1000 at the end.
USER root

# Pinned jar + the two bundled configs at the same release tag, each with a
# pinned digest (upstream publishes no checksum file; digests computed from the
# checkstyle-${CHECKSTYLE_VERSION} release asset and tagged sources).
ARG CHECKSTYLE_VERSION=14.3.0
ARG CHECKSTYLE_JAR_SHA256=754e218ab1fcabb1e1c5f8530e9d3aa37636806c22987bb279dd907a6ee749b2
ARG CHECKSTYLE_GOOGLE_SHA256=9bf56b9b160e84daa48cd37d63f556a8d342e057de82c89f332bbb290550767d
ARG CHECKSTYLE_SUN_SHA256=ede05411c753dad4bbb261c51896418f80cbf92301d356be09174dae03dfc9fc
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
