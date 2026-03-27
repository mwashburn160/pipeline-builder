ARG NODE_VERSION=24.14.0

# Build stage — install production dependencies only
FROM node:${NODE_VERSION}-alpine AS deps
WORKDIR /app
COPY package.json .
RUN --mount=type=secret,id=npmrc,target=.npmrc npm install --omit=dev

# Production stage
FROM node:${NODE_VERSION}-alpine
RUN apk update && \
    apk add ca-certificates curl --no-cache
COPY ./self-signed.crt /usr/local/share/ca-certificates/self-signed.crt
RUN update-ca-certificates 2>/dev/null

WORKDIR /app
COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json .
COPY --chown=node:node lib/ /app

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -f http://localhost:3000/health || exit 1

USER node
CMD ["node", "index.js"]
