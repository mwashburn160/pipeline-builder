// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import winston from 'winston';
import { safeCreateRequire } from './safe-require.js';
import { SENSITIVE_KEY_PATTERN, REDACTED, maskLine } from './sensitive-patterns.js';

const { combine, timestamp, printf, colorize, errors, json } = winston.format;

// ESM has no global `require`; safeCreateRequire enables the synchronous,
// OPTIONAL lazy-load of @opentelemetry/api in getCurrentTraceId() below — a
// winston format callback must stay synchronous, so a dynamic import() won't
// work there. (CJS-bundle safe — see safe-require.ts.)
const require = safeCreateRequire(import.meta.url);

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
 * Per-request identity stamped onto every log entry, so log lines can be
 * attributed to the org that caused them.
 *
 * `orgId` is the tenancy key for the Logs surface: promtail routes each line to
 * its org's Loki tenant from this field (see `docs/plans/frontend-logs.md`). A
 * line written outside a request scope (startup, background worker, migration)
 * has no org and lands in the sysadmin-only `_infra` tenant — fail-closed.
 */
export interface LogContext {
  orgId?: string;
  userId?: string;
}

type LogContextProvider = () => LogContext | undefined;

let logContextProvider: LogContextProvider | undefined;

/**
 * Register the source of per-entry {@link LogContext}.
 *
 * A registration hook rather than a direct import because the request scope
 * lives in `pipeline-data`'s AsyncLocalStorage, and `pipeline-data` depends on
 * this package — importing it here would invert the dependency. `api-server`'s
 * tenant-context module owns the single call, which covers every service that
 * mounts `withTenantContext` (platform included).
 *
 * Pass `undefined` to unregister (tests).
 */
export function setLogContextProvider(fn: LogContextProvider | undefined): void {
  logContextProvider = fn;
}

/** Winston format stamping the ambient {@link LogContext}. Never throws: a
 *  provider that blows up must not take down logging. An entry that already
 *  carries an explicit `orgId` (a call site logging about ANOTHER org) keeps it
 *  — the ambient value never overwrites a deliberate one. */
const logContextFormat = winston.format((info) => {
  if (!logContextProvider) return info;
  let ctx: LogContext | undefined;
  try {
    ctx = logContextProvider();
  } catch {
    return info;
  }
  if (!ctx) return info;
  if (ctx.orgId && info.orgId === undefined) info.orgId = ctx.orgId;
  if (ctx.userId && info.userId === undefined) info.userId = ctx.userId;
  return info;
})();

// `SENSITIVE_KEY_PATTERN` (keys) and `maskLine` (secret-shaped values) both come
// from `sensitive-patterns.ts`, so the logger, platform's log-read path and the
// generated promtail `replace` stages mask the same things. See that module's
// header for why ingest-time masking is the authoritative layer.

function redactDeep(value: unknown, depth = 0): unknown {
  // Cap depth so a malicious / pathological circular object can't lock the logger.
  // Degrade to a placeholder rather than the raw subtree: returning `value` here
  // would log a secret-keyed field nested deeper than the cap in cleartext.
  if (depth > 6) return '[TRUNCATED]';
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

/**
 * Redact sensitive values from an ARBITRARY payload using the same key-pattern
 * rules the Winston `redactFormat` applies to log metadata. Use this for
 * payloads that reach an output channel OUTSIDE the logger — e.g. an SSE frame
 * pushed straight to a client — so a `password`/`token`/`secret` field is
 * masked there too. A top-level sensitive key is masked; nested objects/arrays
 * are walked (depth-capped) exactly as in the logger. Returns a redacted COPY;
 * primitives pass through unchanged.
 */
export function redactSensitive(value: unknown): unknown {
  if (value == null || typeof value !== 'object') return value;
  return redactDeep(value);
}

/** Winston format that masks values for sensitive-looking keys (PII / secrets).
 * Mutates `info` in place so winston's internal Symbol-keyed properties
 * (`Symbol.for('level')`, `Symbol.for('message')`, `Symbol.for('splat')`) survive
 * — rebuilding a fresh object via `Object.entries`/spread silently strips them,
 * which makes the Console transport drop every entry without warning. */
/** Keys the redactor must leave alone. `orgId`/`userId` are load-bearing: promtail
 *  routes a line to its Loki tenant by `orgId`, so redacting it would misfile the
 *  line into the sysadmin-only `_infra` tenant instead of the org's. Listed here
 *  (not merely "doesn't match the pattern today") so a future pattern edit can't
 *  silently break log tenancy. */
const PRESERVED_KEYS = new Set(['level', 'message', 'timestamp', 'service', 'trace_id', 'orgId', 'userId']);
const redactFormat = winston.format((info) => {
  for (const key of Object.keys(info)) {
    if (PRESERVED_KEYS.has(key)) continue;
    if (SENSITIVE_KEY_PATTERN.test(key)) {
      info[key] = REDACTED;
    } else {
      info[key] = redactDeep(info[key]);
    }
  }
  return info;
})();

/**
 * Winston format that masks secret-shaped VALUES in the rendered message and in
 * any string metadata.
 *
 * `redactFormat` above only masks values whose KEY looks sensitive. That misses
 * a secret embedded in free text — `logger.info('POST /x?token=abc')` — which
 * matters more than it looks: promtail's `output: { source: msg }` stage makes
 * the message string the entire shipped log line, so an unmasked message is an
 * unmasked log. Mutates in place to preserve winston's Symbol-keyed internals,
 * exactly as `redactFormat` does.
 */
const maskFormat = winston.format((info) => {
  if (typeof info.message === 'string') info.message = maskLine(info.message);
  for (const key of Object.keys(info)) {
    if (key === 'message') continue;
    const value = info[key];
    if (typeof value === 'string') info[key] = maskLine(value);
  }
  return info;
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
/** The logger `createLogger` returns. Exported so consumers can annotate exported
 *  loggers without depending on winston themselves. */
export type Logger = winston.Logger;

export function createLogger(serviceName: string): Logger {
  const logLevel = process.env.LOG_LEVEL || 'info';
  const logFormat = process.env.LOG_FORMAT || 'json';
  if (logFormat !== 'json' && logFormat !== 'text') {
    // eslint-disable-next-line no-console -- startup warning before logger is available
    console.warn(`Invalid LOG_FORMAT="${logFormat}", expected "json" or "text". Defaulting to "json".`);
  }
  const useJson = logFormat !== 'text';

  // Order matters: redact BEFORE serialization so masked keys never reach
  // the output. trace_id and the org/user context are stamped first so they
  // survive redaction (both are in PRESERVED_KEYS), then `maskFormat` scrubs
  // secret-shaped VALUES out of the rendered message — the key-based
  // `redactFormat` only covers metadata keys, and after promtail's
  // `output: source: msg` rewrite the shipped line IS the message string.
  const baseFormats = [
    errors({ stack: true }),
    timestamp({ format: 'YYYY-MM-DDTHH:mm:ss.SSSZ' }),
    traceIdFormat,
    logContextFormat,
    redactFormat,
    maskFormat,
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
