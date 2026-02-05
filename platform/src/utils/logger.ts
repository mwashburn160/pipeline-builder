import winston from 'winston';
import { config } from '../config';

const logger = winston.createLogger({
  level: config.logger.level,
  defaultMeta: { service: 'platform-api' },
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.colorize(),
    winston.format.printf(({ level, message, timestamp, ...meta }) => {
      const metaStr = Object.keys(meta).length > 1
        ? ` ${JSON.stringify(meta)}`
        : '';
      return `${timestamp} [${level}]: ${message}${metaStr}`;
    }),
  ),
  transports: [new winston.transports.Console()],
  exceptionHandlers: [new winston.transports.Console()],
  rejectionHandlers: [new winston.transports.Console()],
});

export default logger;
