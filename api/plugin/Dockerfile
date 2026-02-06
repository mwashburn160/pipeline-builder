ARG NODE_VERSION=24-alpine

FROM node:${NODE_VERSION}

# Install Docker CLI only (no daemon — uses host socket via volume mount)
RUN apk add --no-cache docker-cli docker-cli-buildx ca-certificates curl

# Trust self-signed registry certificate
COPY ./self-signed.crt /usr/local/share/ca-certificates/self-signed.crt
RUN update-ca-certificates

WORKDIR /app

COPY --chown=node:node package.json .
COPY --chown=node:node lib/ /app
RUN --mount=type=secret,id=npmrc,target=.npmrc npm install --omit=dev
RUN chown -R node:node .

# Create uploads + tmp dirs for multer and ZIP extraction
RUN mkdir -p uploads tmp && chown -R node:node uploads tmp

# node user needs access to the Docker socket (mounted at runtime).
# Add node to the 'ping' group (GID 999) which typically matches the
# host's 'docker' group GID. If your host docker GID differs, override
# via --group-add in compose or adjust this value.
RUN addgroup node ping 2>/dev/null || true

USER node
CMD ["node", "index.js"]
