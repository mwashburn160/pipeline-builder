// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createLogger } from '@mwashburn160/api-core';
import { Config } from '@mwashburn160/pipeline-core';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { NodeSDK } from '@opentelemetry/sdk-node';

const logger = createLogger('Tracing');

let sdk: NodeSDK | null = null;

/**
 * Initialize OpenTelemetry tracing with OTLP HTTP exporter.
 * Configured via `Config.get('observability').tracing`.
 *
 * @example
 * ```typescript
 * import { initTracing } from '@mwashburn160/api-server';
 * initTracing('pipeline-service');
 * ```
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

  const exporter = new OTLPTraceExporter({
    url: tracing.endpoint,
  });

  sdk = new NodeSDK({
    resource: resourceFromAttributes({ 'service.name': serviceName }),
    traceExporter: exporter,
  });

  sdk.start();
  logger.info(`OpenTelemetry tracing initialized for ${serviceName}`);
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
