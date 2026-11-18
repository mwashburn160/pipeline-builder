// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createLogger, getErrorRetryDecision, sleep, type RetryConfig } from '@pipeline-builder/api-core';

const logger = createLogger('retry-strategy');

export type { RetryConfig };

/**
 * Retry tracking for the Postgres pool's health-probe recovery.
 *
 * When the pool reports an error, `handleConnectionError` waits a jittered
 * exponential backoff and probes the connection; a healthy probe resets the
 * budget. The backoff DECISION (how many attempts, how long to wait, jitter) is
 * api-core's `getErrorRetryDecision` — this class owns only the attempt
 * tracking and logging. Jitter keeps a pool of replicas from probing in
 * lockstep after a database blip.
 *
 * `maxRetries` means what it says: N probes after errors before giving up until
 * the next `reset()` or successful probe.
 *
 * There is deliberately no generic "retry this operation" method: retrying an
 * arbitrary query on every error would re-run permanent failures (a unique
 * violation, a constraint error) as if they were transient.
 */
export class ConnectionRetryStrategy {
  private attempts = 0;

  constructor(private readonly config: RetryConfig) {}

  /**
   * Handles connection errors with retry tracking.
   *
   * @param error - Error that occurred
   * @param testConnection - Function to test if connection is restored
   */
  async handleConnectionError(error: Error, testConnection: () => Promise<boolean>): Promise<void> {
    // Decide from the attempts already spent (zero-based), THEN record this one,
    // so `maxRetries: N` allows exactly N probes.
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
    await sleep(decision.delayMs);

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
}
