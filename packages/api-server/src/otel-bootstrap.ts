// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared OpenTelemetry preload bootstrap for every Pipeline Builder service.
 *
 * Preload it BEFORE the app's own code with:
 *   node -r @pipeline-builder/api-server/lib/otel-bootstrap.js index.js
 * (see each service's Dockerfile CMD + `start` script).
 *
 * Why a preload and not `initTracing()` from createApp/index.ts:
 * OpenTelemetry auto-instrumentation patches modules at *require time* via
 * require-in-the-middle. If `http`/`express` are already in the require cache
 * when the SDK starts, the HTTP server is never wrapped, so no inbound server
 * span — and therefore no trace id — is ever created. A `-r` preload guarantees
 * the SDK's hooks are installed before the first `require('http')`.
 *
 * Self-contained on purpose: it imports ONLY OpenTelemetry packages and reads
 * `process.env` directly. It must NOT import this package's own barrel (or
 * api-core / pipeline-core), because those transitively require express — which
 * would load express before the SDK starts and defeat the preload. This is why
 * the bootstrap lives in its own entrypoint file rather than reusing
 * `initTracing()` from `api/tracing.ts`.
 *
 * No-op unless `OTEL_TRACING_ENABLED=true`. Service name comes from
 * `OTEL_SERVICE_NAME` (falling back to `SERVICE_NAME`), which every service
 * already sets in its deploy env.
 */
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { NodeSDK } from '@opentelemetry/sdk-node';

if (process.env.OTEL_TRACING_ENABLED === 'true') {
  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT || 'http://localhost:4318/v1/traces';
  const serviceName = process.env.OTEL_SERVICE_NAME || process.env.SERVICE_NAME || 'api';

  const sdk = new NodeSDK({
    resource: resourceFromAttributes({
      'service.name': serviceName,
      'service.namespace': 'pipeline-builder',
      'deployment.environment': process.env.NODE_ENV ?? 'development',
    }),
    traceExporter: new OTLPTraceExporter({ url: endpoint }),
    // `fs` spans are noise for request-level correlation; everything else
    // (http/express/mongo/pg/…) is auto-instrumented so inbound requests get a
    // server span whose trace id flows onto audit events + structured logs.
    instrumentations: [
      getNodeAutoInstrumentations({
        '@opentelemetry/instrumentation-fs': { enabled: false },
      }),
    ],
  });

  sdk.start();
  // eslint-disable-next-line no-console
  console.log(`[otel] tracing initialized for ${serviceName} -> ${endpoint}`);

  const shutdown = () => {
    void sdk.shutdown().catch(() => undefined);
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}
