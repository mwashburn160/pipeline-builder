# Trivy Security Plugin — Ruby scanning
ARG TRIVY_VERSION=0.69.3
ARG TRIVY_PREV_VERSION=0.68.2
FROM aquasec/trivy:${TRIVY_VERSION} AS trivy-default
FROM aquasec/trivy:${TRIVY_PREV_VERSION} AS trivy-prev
FROM public.ecr.aws/docker/library/ubuntu:24.04
ARG TRIVY_VERSION
ARG TRIVY_PREV_VERSION
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
    git curl jq ca-certificates build-essential gnupg \
    libssl-dev zlib1g-dev libyaml-dev libreadline-dev libffi-dev \
    && rm -rf /var/lib/apt/lists/*
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*
ENV RBENV_ROOT=/opt/rbenv
RUN git clone https://github.com/rbenv/rbenv.git ${RBENV_ROOT} \
    && git clone https://github.com/rbenv/ruby-build.git ${RBENV_ROOT}/plugins/ruby-build
RUN ${RBENV_ROOT}/bin/rbenv install 3.4.8 && \
    ${RBENV_ROOT}/bin/rbenv install 4.0.1 && \
    ${RBENV_ROOT}/bin/rbenv global 4.0.1
ENV PATH="${RBENV_ROOT}/shims:${RBENV_ROOT}/bin:${PATH}"
RUN mkdir -p /opt/trivy/versions
COPY --from=trivy-prev /usr/local/bin/trivy /opt/trivy/versions/trivy-${TRIVY_PREV_VERSION}
COPY --from=trivy-default /usr/local/bin/trivy /opt/trivy/versions/trivy-${TRIVY_VERSION}
RUN ln -sf /opt/trivy/versions/trivy-${TRIVY_VERSION} /usr/local/bin/trivy
ENV TRIVY_VERSION=${TRIVY_VERSION}
ENV TRIVY_SEVERITY=HIGH,CRITICAL
ENV TRIVY_FORMAT=json
WORKDIR /app
CMD ["bash"]
ENV RUBY_VERSION=4.0.1
