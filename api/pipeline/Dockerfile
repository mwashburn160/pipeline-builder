ARG ALPINE_VERSION=3.22
ARG NODE_VERSION=24.9.0
FROM alpine:${ALPINE_VERSION} AS certs
RUN apk update && \
    apk add ca-certificates --no-cache
COPY ./self-signed.crt /usr/local/share/ca-certificates/self-signed.crt
RUN update-ca-certificates
FROM node:${NODE_VERSION}-alpine AS node
RUN apk update && \
    apk add curl --no-cache

COPY --from=certs /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt

WORKDIR /app
COPY --chown=node:node package.json .
COPY --chown=node:node lib/ /app
RUN --mount=type=secret,id=npmrc,target=.npmrc npm install --omit=dev
RUN chown -R node:node .

USER node
CMD ["node", "index.js"]