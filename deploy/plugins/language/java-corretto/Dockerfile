# Java/Kotlin Corretto Plugin — AWS Amazon Corretto JDK
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
#
# Thin layer over pipeline-jvm-base (one pinned Corretto JDK + Maven/Gradle/
# Kotlin, shared by all JVM plugins). JAVA_HOME, java/mvn/gradle/kotlin, and
# the JAVA_VERSION/KOTLIN_VERSION knobs are baked into the base — nothing to
# install here (single-version model; bump the base to change).

FROM pipeline-jvm-base:1.0

WORKDIR /app
CMD ["bash"]
