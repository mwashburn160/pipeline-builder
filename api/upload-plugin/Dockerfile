ARG ALPINE_VERSION=3.22
ARG NODE_VERSION=24.9.0
FROM node:${NODE_VERSION}-alpine AS node
FROM alpine:${ALPINE_VERSION} AS certs
RUN apk update && \
    apk add ca-certificates --no-cache
COPY ./self-signed.crt /usr/local/share/ca-certificates/self-signed.crt
RUN update-ca-certificates
FROM alpine:${ALPINE_VERSION}
RUN apk update && \
    apk add curl openrc podman-docker podman-compose npm shadow shadow-subids --no-cache
RUN addgroup node && \
    adduser -h /home/node -D -G node node
RUN echo "node:100000:65536" >> /etc/subuid && \
    echo "node:100000:65536" >> /etc/subgid
RUN mkdir -p /var/lib/shared/overlay-images \   
             /var/lib/shared/overlay-layers \
             /var/lib/shared/vfs-images \
             /var/lib/shared/vfs-layers
RUN touch /var/lib/shared/overlay-images/images.lock && \
    touch /var/lib/shared/overlay-layers/layers.lock && \
    touch /var/lib/shared/vfs-images/images.lock && \
    touch /var/lib/shared/vfs-layers/layers.lock
    
ADD containers.conf /etc/containers/containers.conf
RUN touch /etc/containers/nodocker
RUN mkdir -p /var/lib/containers && \
    chmod 644 /etc/containers/containers.conf
VOLUME /var/lib/containers

ADD podman-containers.conf /home/node/.config/containers/containers.conf
RUN mkdir -p /home/node/.local/share/containers && \
    chown -R node:node /home/node
VOLUME /home/node/.local/share/containers

ENV BUILDAH_ISOLATION=chroot \
    _CONTAINERS_USERNS_CONFIGURED=""
COPY --from=node /usr/lib /usr/lib
COPY --from=node /usr/local/lib /usr/local/lib
COPY --from=node /usr/local/include /usr/local/include
COPY --from=node /usr/local/bin /usr/local/bin
COPY --from=certs /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt

WORKDIR /app
COPY --chown=node:node package.json .
COPY --chown=node:node lib/ /app
RUN --mount=type=secret,id=npmrc,target=.npmrc npm install --omit=dev
RUN chown -R node:node .

USER node
CMD ["node", "index.js"]