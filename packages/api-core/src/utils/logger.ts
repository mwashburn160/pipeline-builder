// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import winston from 'winston';

const { combine, timestamp, printf, colorize, errors, json } = winston.format;

/**
 * Custom log format for human-readable console output.
 */
const consoleFormat = printf(({ level, message, timestamp, service, ...meta }) => {
  const serviceName = service ? `[${service}]` : '';
  const metaStr = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
  return `${timestamp} ${level} ${serviceName} ${message}${metaStr}`;
});

/**
 * Lazy lookup of OpenTelemetry trace ID. Returns undefined when tracing
 * isn't initialized or @opentelemetry/api isn't installed — never throws.
 * Cheap: a single property read after the first successful lookup.
 */
let _otelApi: { trace?: { getActiveSpan(): { spanContext(): { traceId: string } } | undefined } } | null | undefined;
function getCurrentTraceId(): string | undefined {
  if (_otelApi === undefined) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      _otelApi = require('@opentelemetry/api');
    } catch {
      _otelApi = null;
    }
  }
  if (!_otelApi) return undefined;
  try {
    return _otelApi.trace?.getActiveSpan()?.spanContext().traceId;
  } catch {
    return undefined;
  }
}

/** Winston format that stamps `trace_id` on every entry when an OTel span is active. */
const traceIdFormat = winston.format((info) => {
  const traceId = getCurrentTraceId();
  if (traceId) info.trace_id = traceId;
  return info;
})();

/**
 * Keys that should never appear in logs. Match is case-insensitive and
 * anchored substring — `Authorization`, `auth_header`, `MY_PASSWORD` all hit.
 * Add a new term here only if you've seen real-world leakage; over-redaction
 * makes incident debugging harder.
 */
const SENSITIVE_KEY_PATTERN = /password|secret|bearer|api[_-]?key|cookie|token|^auth(orization|_header)?$|stripe[_-]?(key|secret)|mongo(db)?[_-]?uri/i;
const REDACTED = '[REDACTED]';

function redactDeep(value: unknown, depth = 0): unknown {
  // Cap depth so a malicious / pathological circular object can't lock the logger.
  if (depth > 6) return value;
  if (value == null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (SENSITIVE_KEY_PATTERN.test(k)) {
      out[k] = REDACTED;
    } else {
      out[k] = redactDeep(v, depth + 1);
    }
  }
  return out;
}

/** Winston format that masks values for sensitive-looking keys (PII / secrets). */
const redactFormat = winston.format((info) => {
  const { level, message, timestamp, service, trace_id, ...meta } = info;
  const safe = redactDeep(meta) as Record<string, unknown>;
  return { level, message, timestamp, service, trace_id, ...safe };
})();

/**
 * Create a logger instance for a service.
 *
 * When LOG_FORMAT=json (default), outputs structured JSON for Loki ingestion:
 *   {"level":"info","message":"Server started","service":"pipeline","timestamp":"..."}
 *
 * When LOG_FORMAT=text, outputs colorized human-readable format:
 *   2026-02-13T10:30:00.000Z info [pipeline] Server started
 *
 * @param serviceName - Name of the service for log identification
 * @returns Configured Winston logger instance
 *
 * @example
 * ```typescript
 * import { createLogger } from '@pipeline-builder/api-core';
 *
 * const logger = createLogger('get-plugin');
 * logger.info('Server started', { port: 3000 });
 * logger.error('Database error', { error: err.message });
 * ```
 */
export function createLogger(serviceName: string): winston.Logger {
  const logLevel = process.env.LOG_LEVEL || 'info';
  const logFormat = process.env.LOG_FORMAT || 'json';
  if (logFormat !== 'json' && logFormat !== 'text') {
    // eslint-disable-next-line no-console -- startup warning before logger is available
    console.warn(`Invalid LOG_FORMAT="${logFormat}", expected "json" or "text". Defaulting to "json".`);
  }
  const useJson = logFormat !== 'text';

  // Order matters: redact BEFORE serialization so masked keys never reach
  // the output. trace_id is stamped first so it survives redaction.
  const baseFormats = [
    errors({ stack: true }),
    timestamp({ format: 'YYYY-MM-DDTHH:mm:ss.SSSZ' }),
    traceIdFormat,
    redactFormat,
  ];

  if (useJson) {
    return winston.createLogger({
      level: logLevel,
      defaultMeta: { service: serviceName },
      format: combine(...baseFormats, json()),
      transports: [new winston.transports.Console()],
    });
  }

  return winston.createLogger({
    level: logLevel,
    defaultMeta: { service: serviceName },
    format: combine(...baseFormats),
    transports: [
      new winston.transports.Console({
        format: combine(colorize(), consoleFormat),
      }),
    ],
  });
}

/**
 * Default logger instance (service name from SERVICE_NAME env var or 'api').
 */
export const logger = createLogger(process.env.SERVICE_NAME || 'api');

export default logger;
