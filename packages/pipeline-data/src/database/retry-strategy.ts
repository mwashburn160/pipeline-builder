/**
 * @module database/retry-strategy
 * @description Implements an exponential backoff retry strategy for establishing reliable database connections.
 */

import { createLogger } from '@mwashburn160/api-core';

const logger = createLogger('RetryStrategy');

/**
 * Configuration for connection retry strategy
 */
export interface RetryConfig {
  /** Maximum number of retry attempts */
  maxRetries: number;
  /** Base delay between retries in milliseconds */
  baseDelay: number;
}

/**
 * Implements exponential backoff retry strategy for database connections.
 *
 * Features:
 * - Exponential backoff with configurable base delay
 * - Attempt tracking and logging
 * - Graceful failure after max retries
 *
 * @example
 * ```typescript
 * const strategy = new ConnectionRetryStrategy({ maxRetries: 3, baseDelay: 1000 });
 *
 * const result = await strategy.execute(async () => {
 *   return await db.query('SELECT 1');
 * });
 * ```
 */
export class ConnectionRetryStrategy {
  private attempts = 0;

  constructor(private readonly config: RetryConfig) {}

  /**
   * Executes an operation with retry logic
   *
   * @param operation - Async function to execute with retries
   * @returns Promise resolving to operation result
   * @throws Error if all retry attempts fail
   */
  async execute<T>(operation: () => Promise<T>): Promise<T> {
    this.attempts = 0;

    while (this.attempts < this.config.maxRetries) {
      try {
        const result = await operation();
        if (this.attempts > 0) {
          logger.info('Operation succeeded after retry');
        }
        return result;
      } catch (error) {
        this.attempts++;

        if (this.attempts >= this.config.maxRetries) {
          logger.error(`Max retry attempts (${this.config.maxRetries}) reached`);
          throw error;
        }

        const delay = this.calculateBackoff(this.attempts);
        logger.warn(
          `Operation failed (attempt ${this.attempts}/${this.config.maxRetries}), retrying in ${delay}ms...`,
          { error: error instanceof Error ? error.message : String(error) },
        );

        await this.sleep(delay);
      }
    }

    throw new Error('Retry logic failed unexpectedly');
  }

  /**
   * Handles connection errors with retry tracking
   *
   * @param error - Error that occurred
   * @param testConnection - Function to test if connection is restored
   */
  async handleConnectionError(error: Error, testConnection: () => Promise<boolean>): Promise<void> {
    this.attempts++;

    logger.error(
      `Connection error (attempt ${this.attempts}/${this.config.maxRetries}):`,
      error.message,
    );

    if (this.attempts < this.config.maxRetries) {
      const delay = this.calculateBackoff(this.attempts);
      logger.info(`Retrying connection in ${delay}ms...`);

      await this.sleep(delay);

      try {
        const isHealthy = await testConnection();
        if (isHealthy) {
          logger.info('Connection restored');
          this.attempts = 0; // Reset on successful connection
        } else {
          logger.error('Connection test failed after retry');
        }
      } catch (retryError) {
        logger.error('Retry failed:', retryError);
      }
    } else {
      logger.error('Max connection retry attempts reached');
    }
  }

  /**
   * Resets the attempt counter
   * Call this after a successful operation
   */
  reset(): void {
    this.attempts = 0;
  }

  /**
   * Gets the current attempt count
   */
  getAttempts(): number {
    return this.attempts;
  }

  /**
   * Calculates exponential backoff delay
   *
   * @param attempt - Current attempt number (1-indexed)
   * @returns Delay in milliseconds
   */
  private calculateBackoff(attempt: number): number {
    return this.config.baseDelay * Math.pow(2, attempt - 1);
  }

  /**
   * Sleeps for the specified duration
   *
   * @param ms - Milliseconds to sleep
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
