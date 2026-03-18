ARG NODE_VERSION=24.14.0

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

RUN apk update && \
    apk add ca-certificates --no-cache
COPY ./self-signed.crt /usr/local/share/ca-certificates/self-signed.crt
RUN update-ca-certificates

ENV NEXT_TELEMETRY_DISABLED=1

# Create non-root user
RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 nextjs

# Copy built application
COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

USER nextjs

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://localhost:3000').then(r => r.ok ? process.exit(0) : process.exit(1)).catch(() => process.exit(1))"

ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

CMD ["node", "server.js"]
