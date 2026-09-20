// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createLogger, getErrorRetryDecision, type RetryConfig, errorMessage } from '@pipeline-builder/api-core';

const logger = createLogger('retry-strategy');

export type { RetryConfig };

/**
 * Exponential-backoff retry for database connections.
 *
 * The backoff DECISION (how many attempts, how long to wait, jitter) is
 * api-core's `getErrorRetryDecision` — this class owns only the connection-
 * specific concerns (attempt tracking, logging, the health-probe recovery
 * path). It previously carried a second, subtly different implementation: its
 * own `RetryConfig` (`baseDelay` rather than `retryDelayMs`), no jitter — so a
 * pool of replicas retried in lockstep after a database blip — and an
 * off-by-one in the loop condition that gave `maxRetries: 3` only TWO retries.
 *
 * `maxRetries` now means what it says: N retries AFTER the initial attempt, so
 * `{ maxRetries: 3 }` makes up to 4 attempts total.
 *
 * @example
 * ```typescript
 * const strategy = new ConnectionRetryStrategy({ maxRetries: 3, retryDelayMs: 1000 });
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
   * Executes an operation, retrying transient failures with jittered
   * exponential backoff.
   *
   * @param operation - Async function to execute with retries
   * @returns Promise resolving to operation result
   * @throws the last error once the retry budget is exhausted
   */
  async execute<T>(operation: () => Promise<T>): Promise<T> {
    this.attempts = 0;

    // `attempt` is ZERO-BASED and counts retries already made, matching
    // getErrorRetryDecision's contract: it allows a retry while
    // `attempt < maxRetries`, so the loop makes maxRetries + 1 attempts.
    for (let attempt = 0; ; attempt++) {
      try {
        const result = await operation();
        if (attempt > 0) {
          logger.info('Operation succeeded after retry');
        }
        return result;
      } catch (error) {
        this.attempts = attempt + 1;
        const decision = getErrorRetryDecision(attempt, this.config);
        if (!decision.shouldRetry) {
          logger.error(`Max retry attempts (${this.config.maxRetries}) reached`);
          throw error;
        }

        logger.warn(
          `Operation failed (attempt ${this.attempts}/${this.config.maxRetries}), retrying in ${decision.delayMs}ms...`,
          { error: errorMessage(error) },
        );

        await this.sleep(decision.delayMs);
      }
    }
  }

  /**
   * Handles connection errors with retry tracking.
   *
   * @param error - Error that occurred
   * @param testConnection - Function to test if connection is restored
   */
  async handleConnectionError(error: Error, testConnection: () => Promise<boolean>): Promise<void> {
    // Decide from the attempts already spent (zero-based), THEN record this one,
    // so the budget matches `execute`'s.
    const decision = getErrorRetryDecision(this.attempts, this.config);
    this.attempts++;

    logger.error(
      `Connection error (attempt ${this.attempts}/${this.config.maxRetries}):`,
      error.message,
    );

    if (!decision.shouldRetry) {
      logger.error('Max connection retry attempts reached');
      return;
    }

    logger.info(`Retrying connection in ${decision.delayMs}ms...`);
    await this.sleep(decision.delayMs);

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
  }

  /**
   * Resets the attempt counter.
   * Call this after a successful operation.
   */
  reset(): void {
    this.attempts = 0;
  }

  /**
   * Gets the current attempt count.
   */
  getAttempts(): number {
    return this.attempts;
  }

  /**
   * Sleeps for the specified duration.
   *
   * @param ms - Milliseconds to sleep
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
