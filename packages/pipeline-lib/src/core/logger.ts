/**
 * Log levels for the application logger
 */
export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
  NONE = 4,
}

/**
 * Logger configuration options
 */
export interface LoggerOptions {
  /** Minimum log level to output */
  level?: LogLevel;
  /** Prefix for all log messages */
  prefix?: string;
  /** Whether to include timestamps */
  timestamps?: boolean;
}

/**
 * Structured log entry
 */
export interface LogEntry {
  level: keyof typeof LogLevel;
  message: string;
  timestamp: string;
  prefix?: string;
  args?: unknown[];
}

/**
 * Application logger with configurable log levels
 * 
 * @example
 * ```typescript
 * import { logger } from './logger';
 * 
 * logger.debug('Detailed info for debugging');
 * logger.info('General information');
 * logger.warn('Warning message');
 * logger.error('Error occurred', error);
 * ```
 */
class Logger {
  private level: LogLevel;
  private prefix: string;
  private timestamps: boolean;

  constructor(options: LoggerOptions = {}) {
    this.level = options.level ?? this.parseLevel(process.env.LOG_LEVEL);
    this.prefix = options.prefix ?? '';
    this.timestamps = options.timestamps ?? true;
  }

  /**
   * Parse log level from string environment variable
   */
  private parseLevel(level?: string): LogLevel {
    if (!level) return LogLevel.INFO;

    const levels: Record<string, LogLevel> = {
      debug: LogLevel.DEBUG,
      info: LogLevel.INFO,
      warn: LogLevel.WARN,
      error: LogLevel.ERROR,
      none: LogLevel.NONE,
    };

    return levels[level.toLowerCase()] ?? LogLevel.INFO;
  }

  /**
   * Format the log message with optional timestamp and prefix
   */
  private format(level: string, message: string): string {
    const parts: string[] = [];

    if (this.timestamps) {
      parts.push(`[${new Date().toISOString()}]`);
    }

    parts.push(`[${level.toUpperCase()}]`);

    if (this.prefix) {
      parts.push(`[${this.prefix}]`);
    }

    parts.push(message);

    return parts.join(' ');
  }

  /**
   * Check if a log level is enabled
   */
  isLevelEnabled(level: LogLevel): boolean {
    return this.level <= level;
  }

  /**
   * Check if debug logging is enabled
   */
  isDebugEnabled(): boolean {
    return this.isLevelEnabled(LogLevel.DEBUG);
  }

  /**
   * Log a debug message (verbose, for development)
   */
  debug(message: string, ...args: unknown[]): void {
    if (this.level <= LogLevel.DEBUG) {
      console.debug(this.format('debug', message), ...args);
    }
  }

  /**
   * Log an info message (general information)
   */
  info(message: string, ...args: unknown[]): void {
    if (this.level <= LogLevel.INFO) {
      console.log(this.format('info', message), ...args);
    }
  }

  /**
   * Log a warning message (potential issues)
   */
  warn(message: string, ...args: unknown[]): void {
    if (this.level <= LogLevel.WARN) {
      console.warn(this.format('warn', message), ...args);
    }
  }

  /**
   * Log an error message (errors and exceptions)
   */
  error(message: string, ...args: unknown[]): void {
    if (this.level <= LogLevel.ERROR) {
      console.error(this.format('error', message), ...args);
    }
  }

  /**
   * Create a child logger with a specific prefix
   * 
   * @example
   * ```typescript
   * const dbLogger = logger.child('Database');
   * dbLogger.info('Connected'); // [INFO] [Database] Connected
   * ```
   */
  child(prefix: string): Logger {
    const childPrefix = this.prefix ? `${this.prefix}:${prefix}` : prefix;
    return new Logger({
      level: this.level,
      prefix: childPrefix,
      timestamps: this.timestamps,
    });
  }

  /**
   * Set the log level at runtime
   */
  setLevel(level: LogLevel): void {
    this.level = level;
  }

  /**
   * Get the current log level
   */
  getLevel(): LogLevel {
    return this.level;
  }

  /**
   * Create a new logger instance with custom options
   */
  static create(options: LoggerOptions): Logger {
    return new Logger(options);
  }
}

/**
 * Default logger instance
 * Configure via LOG_LEVEL environment variable: debug, info, warn, error, none
 */
export const logger = new Logger();

/**
 * Create a child logger for a specific module
 * 
 * @example
 * ```typescript
 * const log = createLogger('Pipeline');
 * log.info('Building...'); // [INFO] [Pipeline] Building...
 * ```
 */
export function createLogger(prefix: string): Logger {
  return logger.child(prefix);
}
