# Selenium Plugin — Cross-Browser WebDriver Testing
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
# Supports Chrome and Firefox with WebDriver automation

FROM public.ecr.aws/docker/library/ubuntu:24.04

# Avoid interactive prompts
ENV DEBIAN_FRONTEND=noninteractive

# System dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    zip \
    unzip \
    curl \
    wget \
    jq \
    ca-certificates \
    gnupg \
    xvfb \
    fonts-liberation \
    python3 \
    python3-pip \
    python3-venv \
    && rm -rf /var/lib/apt/lists/*

# ─── Node.js via nvm ───
ENV NVM_DIR=/opt/nvm
RUN mkdir -p ${NVM_DIR} \
    && curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
RUN bash -c "source ${NVM_DIR}/nvm.sh && \
    nvm install 22 && \
    nvm install 24 && \
    nvm alias default 24" \
    && ln -s ${NVM_DIR}/versions/node/$(ls ${NVM_DIR}/versions/node/ | grep '^v24') ${NVM_DIR}/versions/node/v24 \
    && ln -s ${NVM_DIR}/versions/node/$(ls ${NVM_DIR}/versions/node/ | grep '^v22') ${NVM_DIR}/versions/node/v22
ENV PATH="${NVM_DIR}/versions/node/v24/bin:${PATH}"

# ─── Chrome/Chromium ───
RUN curl -fsSL https://dl.google.com/linux/linux_signing_key.pub | gpg --dearmor -o /usr/share/keyrings/google-chrome.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/google-chrome.gpg] http://dl.google.com/linux/chrome/deb/ stable main" \
    > /etc/apt/sources.list.d/google-chrome.list \
    && apt-get update && apt-get install -y --no-install-recommends \
    google-chrome-stable \
    && rm -rf /var/lib/apt/lists/*

# ─── ChromeDriver ───
RUN CHROME_VERSION=$(google-chrome --version | grep -oP '\d+\.\d+\.\d+') \
    && (curl -fsSL "https://storage.googleapis.com/chrome-for-testing-public/${CHROME_VERSION}.0/linux64/chromedriver-linux64.zip" \
        -o /tmp/chromedriver.zip \
    || curl -fsSL "https://edgedl.me.gvt1.com/edgedl/chrome/chrome-for-testing/$(echo ${CHROME_VERSION} | cut -d. -f1).0.0.0/linux64/chromedriver-linux64.zip" \
        -o /tmp/chromedriver.zip \
    || (echo "ERROR: Failed to download ChromeDriver for Chrome ${CHROME_VERSION}" && exit 1)) \
    && unzip -q /tmp/chromedriver.zip -d /tmp/ \
    && mv /tmp/chromedriver-linux64/chromedriver /usr/local/bin/ \
    && chmod +x /usr/local/bin/chromedriver \
    && rm -rf /tmp/chromedriver*

# ─── Selenium for Python ───
RUN pip3 install --break-system-packages selenium webdriver-manager

# Default Node.js version
ENV NODE_VERSION=24
ENV SELENIUM_BROWSER=chrome

# Working directory for pipeline source
WORKDIR /app

# Default entrypoint — overridden by CodeBuildStep commands
CMD ["bash"]
