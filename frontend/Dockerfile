ARG ALPINE_VERSION=3.22
ARG NODE_VERSION=24.9.0
# Cert stage
FROM alpine:${ALPINE_VERSION} AS certs
RUN apk update && \
    apk add ca-certificates --no-cache
COPY ./self-signed.crt /usr/local/share/ca-certificates/self-signed.crt
RUN update-ca-certificates

# Build stage
FROM node:${NODE_VERSION}-alpine AS builder

WORKDIR /app

# Install pnpm
RUN corepack enable && corepack prepare pnpm@latest --activate

# Copy package files
COPY package.json ./

# Install dependencies
RUN --mount=type=secret,id=npmrc,target=.npmrc pnpm install

# Copy source files
COPY . .

# Build the application
ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm build

# Production stage
FROM node:${NODE_VERSION}-alpine AS runner

WORKDIR /app

ENV NEXT_TELEMETRY_DISABLED=1

# Create non-root user
RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 nextjs

COPY --from=certs /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt

# Copy built application
COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

USER nextjs

EXPOSE 3000

ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

CMD ["node", "server.js"]
