/**
 * @module utils/logger
 * @description Standardized Winston logger for all API microservices.
 */

import winston from 'winston';

const { combine, timestamp, printf, colorize, errors } = winston.format;

/**
 * Custom log format for console output.
 */
const consoleFormat = printf(({ level, message, timestamp, service, ...meta }) => {
  const serviceName = service ? `[${service}]` : '';
  const metaStr = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
  return `${timestamp} ${level} ${serviceName} ${message}${metaStr}`;
});

/**
 * Create a logger instance for a service.
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

  return winston.createLogger({
    level: logLevel,
    defaultMeta: { service: serviceName },
    format: combine(
      errors({ stack: true }),
      timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    ),
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
