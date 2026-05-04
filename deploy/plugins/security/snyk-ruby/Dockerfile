# Snyk Security Plugin — Ruby scanning
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
#
# Inherits from the snyk family base image (pipeline-snyk-base:1.0)
# which provides snyk CLI + (where applicable) Node.js. This file
# only adds the Ruby toolchain.

FROM pipeline-snyk-base:1.0

# ─── Ruby via rbenv ───
ENV RBENV_ROOT=/opt/rbenv
RUN git clone --depth 1 https://github.com/rbenv/rbenv.git ${RBENV_ROOT} && \
    git clone --depth 1 https://github.com/rbenv/ruby-build.git ${RBENV_ROOT}/plugins/ruby-build
RUN ${RBENV_ROOT}/bin/rbenv install 3.4.8 && \
    ${RBENV_ROOT}/bin/rbenv install 4.0.1 && \
    ${RBENV_ROOT}/bin/rbenv global 4.0.1
ENV PATH="${RBENV_ROOT}/shims:${RBENV_ROOT}/bin:${PATH}"
ENV RUBY_VERSION=4.0.1

WORKDIR /app
CMD ["bash"]
