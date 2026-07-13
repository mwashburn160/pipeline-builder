// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared OpenTelemetry preload bootstrap for every Pipeline Builder service.
 *
 * Preload it BEFORE the app's own code with (services are ESM, so `--import`,
 * not the CJS `-r`):
 *   node --import @pipeline-builder/api-server/lib/otel-bootstrap.js index.js
 * (see each service's Dockerfile CMD).
 *
 * Why a preload and not a programmatic SDK start from createApp/index.ts:
 * OpenTelemetry auto-instrumentation patches modules as they load. If
 * `http`/`express` are already loaded when the SDK starts, the HTTP server is
 * never wrapped, so no inbound server span — and therefore no trace id — is ever
 * created. The `--import` preload runs fully before `index.js` loads any
 * instrumented module. Because the services are ESM, we also register the
 * import-in-the-middle ESM loader hook below — require-in-the-middle alone only
 * patches CJS `require()`, which an ESM app never uses.
 *
 * Self-contained on purpose: it imports ONLY OpenTelemetry packages and reads
 * `process.env` directly. It must NOT import this package's own barrel (or
 * api-core / pipeline-core), because those transitively require express — which
 * would load express before the SDK starts and defeat the preload. This is why
 * the bootstrap lives in its own entrypoint file rather than starting the SDK
 * from within `api/tracing.ts`.
 *
 * No-op unless `OTEL_TRACING_ENABLED=true`. Service name comes from
 * `OTEL_SERVICE_NAME` (falling back to `SERVICE_NAME`), which every service
 * already sets in its deploy env.
 */
import { register } from 'node:module';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { NodeSDK } from '@opentelemetry/sdk-node';

if (process.env.OTEL_TRACING_ENABLED === 'true') {
  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT || 'http://localhost:4318/v1/traces';
  const serviceName = process.env.OTEL_SERVICE_NAME || process.env.SERVICE_NAME || 'api';

  // Enable ESM instrumentation: register the import-in-the-middle hook before any
  // instrumented module is imported. Wrapped so a hook-resolution failure
  // degrades to no-instrumentation (today's behaviour) rather than crashing the
  // service on startup.
  try {
    register('@opentelemetry/instrumentation/hook.mjs', import.meta.url);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[otel] ESM instrumentation hook not registered:', (err as Error).message);
  }

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
