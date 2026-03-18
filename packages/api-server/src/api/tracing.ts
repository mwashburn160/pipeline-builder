import { createLogger } from '@mwashburn160/api-core';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { NodeSDK } from '@opentelemetry/sdk-node';

const logger = createLogger('Tracing');

let sdk: NodeSDK | null = null;

/**
 * Initialize OpenTelemetry tracing with OTLP HTTP exporter.
 * Set OTEL_TRACING_ENABLED=true and OTEL_EXPORTER_OTLP_ENDPOINT to enable.
 *
 * @example
 * ```typescript
 * import { initTracing } from '@mwashburn160/api-server';
 * initTracing('pipeline-service');
 * ```
 */
export function initTracing(serviceName: string): void {
  if (process.env.OTEL_TRACING_ENABLED !== 'true') {
    logger.debug('OpenTelemetry tracing disabled (set OTEL_TRACING_ENABLED=true to enable)');
    return;
  }

  if (sdk) {
    logger.debug('OpenTelemetry already initialized');
    return;
  }

  const exporter = new OTLPTraceExporter({
    url: process.env.OTEL_EXPORTER_OTLP_ENDPOINT || 'http://localhost:4318/v1/traces',
  });

  sdk = new NodeSDK({
    resource: resourceFromAttributes({ 'service.name': serviceName }),
    traceExporter: exporter,
  });

  sdk.start();
  logger.info(`OpenTelemetry tracing initialized for ${serviceName}`);

  process.on('SIGTERM', () => {
    sdk?.shutdown().catch((err: unknown) => logger.error('OTel shutdown error', { error: err }));
  });
}

/**
 * Shutdown the OpenTelemetry SDK gracefully.
 */
export async function shutdownTracing(): Promise<void> {
  if (sdk) {
    await sdk.shutdown();
    sdk = null;
  }
}
