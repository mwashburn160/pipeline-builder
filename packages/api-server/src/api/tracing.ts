// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { trace, SpanStatusCode, type Span, type Attributes } from '@opentelemetry/api';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { createLogger } from '@pipeline-builder/api-core';

const logger = createLogger('tracing');

/** Shared tracer for hand-authored spans. */
const tracer = trace.getTracer('pipeline-builder');

/**
 * Run `fn` inside a new active span named `name`.
 *
 * Auto-instrumentation only covers inbound HTTP/express/mongo/pg; the paths that
 * actually get debugged in an incident — AI generation, the out-of-band BullMQ
 * plugin build (runs detached from any inbound span), long async work — show no
 * span detail without a hand-authored one. Wrap those with this.
 *
 * Safe when tracing is disabled: with no SDK registered, `startActiveSpan` runs
 * the callback with a no-op span, so this adds negligible overhead and never
 * changes behavior. On throw, the span is marked ERROR and the exception
 * recorded, then re-thrown unchanged. Always ends the span.
 */
export async function withSpan<T>(
  name: string,
  fn: (span: Span) => Promise<T>,
  attributes?: Attributes,
): Promise<T> {
  return tracer.startActiveSpan(name, async (span) => {
    if (attributes) span.setAttributes(attributes);
    try {
      const result = await fn(span);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      span.recordException(error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
      throw err;
    } finally {
      span.end();
    }
  });
}

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
