/**
 * @module utils/logger
 * @description Standardized Winston logger for all API microservices.
 */

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
 * import { createLogger } from '@mwashburn160/api-core';
 *
 * const logger = createLogger('get-plugin');
 * logger.info('Server started', { port: 3000 });
 * logger.error('Database error', { error: err.message });
 * ```
 */
export function createLogger(serviceName: string): winston.Logger {
  const logLevel = process.env.LOG_LEVEL || 'info';
  const useJson = (process.env.LOG_FORMAT || 'json') !== 'text';

  const baseFormats = [
    errors({ stack: true }),
    timestamp({ format: 'YYYY-MM-DDTHH:mm:ss.SSSZ' }),
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
