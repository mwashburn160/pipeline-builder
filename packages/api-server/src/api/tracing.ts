// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { trace } from '@opentelemetry/api';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { createLogger } from '@pipeline-builder/api-core';
import { Config } from '@pipeline-builder/pipeline-core';

const logger = createLogger('tracing');

let sdk: NodeSDK | null = null;

/**
 * Initialize OpenTelemetry tracing with OTLP HTTP exporter.
 * Idempotent — safe to call multiple times. Called automatically by
 * `createApp()` so every service gets tracing when `OTEL_TRACING_ENABLED=true`.
 *
 * Env vars:
 *   OTEL_TRACING_ENABLED=true|false     — master switch
 *   OTEL_EXPORTER_OTLP_ENDPOINT=URL      — collector endpoint (default http://localhost:4318/v1/traces)
 *   OTEL_SERVICE_NAME=my-service         — overrides the service label
 *
 * When enabled, Node SDK registers W3C trace-context propagation by default.
 * Outbound HTTP (fetch/axios/undici) carries `traceparent` automatically;
 * inbound HTTP extracts + re-uses it so traces span services end-to-end.
 */
export function initTracing(serviceName: string): void {
  const { tracing } = Config.getAny('observability') as { tracing: { enabled: boolean; endpoint: string } };

  if (!tracing.enabled) {
    logger.debug('OpenTelemetry tracing disabled (set OTEL_TRACING_ENABLED=true to enable)');
    return;
  }

  if (sdk) {
    logger.debug('OpenTelemetry already initialized');
    return;
  }

  const effectiveName = process.env.OTEL_SERVICE_NAME || serviceName;

  sdk = new NodeSDK({
    resource: resourceFromAttributes({
      'service.name': effectiveName,
      'service.namespace': 'pipeline-builder',
      'deployment.environment': process.env.NODE_ENV ?? 'development',
    }),
    traceExporter: new OTLPTraceExporter({ url: tracing.endpoint }),
    // Auto-instrument incoming/outgoing HTTP (and express) so every request
    // gets a server span — that span's trace id is what `currentTraceId()`
    // returns for enriching audit events + structured logs. `fs` is disabled
    // because file-IO spans are pure noise for request-level correlation.
    instrumentations: [
      getNodeAutoInstrumentations({
        '@opentelemetry/instrumentation-fs': { enabled: false },
      }),
    ],
  });

  sdk.start();
  logger.info(`OpenTelemetry tracing initialized for ${effectiveName}`, { endpoint: tracing.endpoint });

  // Graceful shutdown on common signals so buffered spans flush before exit.
  const shutdown = () => {
    void shutdownTracing().catch(err => logger.warn('Tracing shutdown error', { error: String(err) }));
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}

/**
 * Shutdown the OpenTelemetry SDK gracefully.
 */
export async function shutdownTracing(): Promise<void> {
  if (sdk) {
    await sdk.shutdown();
    sdk = null;
    logger.info('OpenTelemetry tracing shut down');
  }
}

/**
 * Returns the current active trace ID, or undefined when tracing is
 * disabled / no active span. Useful for enriching structured logs so an
 * operator can correlate a request across services via its trace ID.
 */
export function currentTraceId(): string | undefined {
  // Read the globally-registered tracer provider's active span — works whether
  // the SDK was started by `initTracing()` (createApp services) or by a `-r`
  // preload bootstrap (platform), since both register the same global provider
  // via @opentelemetry/api. Returns undefined when tracing is disabled / there
  // is no active span.
  return trace.getActiveSpan()?.spanContext()?.traceId;
}
