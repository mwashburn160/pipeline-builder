# Trivy Security Plugin — Java/Kotlin scanning
ARG TRIVY_VERSION=0.69.3
ARG TRIVY_PREV_VERSION=0.68.2
FROM aquasec/trivy:${TRIVY_VERSION} AS trivy-default
FROM aquasec/trivy:${TRIVY_PREV_VERSION} AS trivy-prev
FROM public.ecr.aws/docker/library/ubuntu:24.04
ARG TRIVY_VERSION
ARG TRIVY_PREV_VERSION
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
    git zip unzip curl jq ca-certificates build-essential gnupg \
    && rm -rf /var/lib/apt/lists/*
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*
ENV SDKMAN_DIR=/opt/sdkman
RUN curl -fsSL "https://get.sdkman.io?rcupdate=false" | bash
RUN bash -c "source ${SDKMAN_DIR}/bin/sdkman-init.sh && \
    sdk install java 17.0.18-tem && \
    sdk install java 21.0.10-tem && \
    sdk default java 21.0.10-tem && \
    sdk install maven 3.9.9 && \
    sdk install gradle 8.12"
ENV PATH="${SDKMAN_DIR}/candidates/java/current/bin:${SDKMAN_DIR}/candidates/maven/current/bin:${SDKMAN_DIR}/candidates/gradle/current/bin:${SDKMAN_DIR}/bin:${PATH}"
RUN mkdir -p /opt/trivy/versions
COPY --from=trivy-prev /usr/local/bin/trivy /opt/trivy/versions/trivy-${TRIVY_PREV_VERSION}
COPY --from=trivy-default /usr/local/bin/trivy /opt/trivy/versions/trivy-${TRIVY_VERSION}
RUN ln -sf /opt/trivy/versions/trivy-${TRIVY_VERSION} /usr/local/bin/trivy
ENV TRIVY_VERSION=${TRIVY_VERSION}
ENV TRIVY_SEVERITY=HIGH,CRITICAL
ENV TRIVY_FORMAT=json
WORKDIR /app
CMD ["bash"]
ENV JAVA_VERSION=21.0.10-tem
