// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { trace } from '@opentelemetry/api';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { createLogger } from '@pipeline-builder/api-core';

const logger = createLogger('tracing');

// Module-local SDK handle. Production services start tracing through the
// `otel-bootstrap.js` `--import` preload, which registers its own SDK on the
// global provider — so this stays null and `shutdownTracing()` is a no-op.
// It is retained because `server.ts` calls `shutdownTracing()` on shutdown.
let sdk: NodeSDK | null = null;

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
  // Read the globally-registered tracer provider's active span. The SDK is
  // started by the `otel-bootstrap.js` `--import` preload, which registers the
  // global provider via @opentelemetry/api. Returns undefined when tracing is
  // disabled / there is no active span.
  return trace.getActiveSpan()?.spanContext()?.traceId;
}
