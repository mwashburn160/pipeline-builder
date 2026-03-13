ARG NODE_VERSION=24.14.0
FROM node:${NODE_VERSION}-alpine
RUN apk update && \
    apk add ca-certificates curl docker-cli docker-cli-buildx --no-cache
COPY ./self-signed.crt /usr/local/share/ca-certificates/self-signed.crt
RUN update-ca-certificates

WORKDIR /app
COPY --chown=node:node package.json .
COPY --chown=node:node lib/ /app
RUN --mount=type=secret,id=npmrc,target=.npmrc npm install --omit=dev
RUN chown -R node:node node_modules

USER node
CMD ["node", "index.js"]
