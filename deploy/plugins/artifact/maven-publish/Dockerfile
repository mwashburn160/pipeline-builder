# Maven Publish Plugin — Publish artifacts to Maven Central
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
# Publishes Java/Kotlin artifacts to Maven Central via OSSRH or custom repository
# Requires OSSRH_USERNAME + OSSRH_PASSWORD + GPG_PASSPHRASE injected at runtime via CodeBuild secrets
#
# Thin layer over pipeline-jvm-base (one pinned Corretto JDK + Maven; gpg comes
# from the shared plugin base). Nothing to install here — MAVEN_REPOSITORY_URL
# and the credentials are runtime config/secrets.

FROM pipeline-jvm-base:1.0

WORKDIR /app
CMD ["bash"]
