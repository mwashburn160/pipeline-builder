ARG NODE_VERSION=24.14.0

# CA certificates stage — shared base with self-signed cert trust
FROM node:${NODE_VERSION}-alpine AS certs
RUN apk update && apk add ca-certificates --no-cache
COPY ./self-signed.crt /usr/local/share/ca-certificates/self-signed.crt
RUN update-ca-certificates 2>/dev/null

# Production stage
# Next.js standalone bundle is built OUTSIDE Docker by `pnpm nx run frontend:build`
# (output: 'standalone' in next.config). The .next/standalone/ tree carries its
# own pruned node_modules so no install runs in the image. Matches the api
# services' pattern and avoids the workspace:* resolution that broke in-container
# `pnpm install`.
FROM node:${NODE_VERSION}-alpine
COPY --from=certs /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt

ENV NEXT_TELEMETRY_DISABLED=1

RUN addgroup --system --gid 1001 nodejs && adduser --system --uid 1001 nextjs

WORKDIR /app
COPY --chown=nextjs:nodejs .next/standalone/ ./
COPY --chown=nextjs:nodejs .next/static/ ./frontend/.next/static/
COPY --chown=nextjs:nodejs public/ ./frontend/public/

USER nextjs

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://localhost:3000').then(r => r.ok ? process.exit(0) : process.exit(1)).catch(() => process.exit(1))"

ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

CMD ["node", "frontend/server.js"]
