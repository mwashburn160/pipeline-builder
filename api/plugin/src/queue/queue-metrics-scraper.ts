// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Periodic scraper that samples BullMQ queue depth and publishes it as a
 * Prometheus Gauge. BullMQ does not auto-export to Prometheus, so the
 * Observability dashboards need an in-process scraper.
 *
 * Cardinality: `queue` is bounded to 2 values (`plugin-build`, `plugin-build-dlq`)
 * and `state` is bounded to BullMQ's 6 states (`waiting`, `active`, `completed`,
 * `failed`, `delayed`, `paused`) → 12 series total. Safe to label.
 */

import { createLogger, errorMessage } from '@pipeline-builder/api-core';
import { setGauge } from '@pipeline-builder/api-server';
import type { Queue } from 'bullmq';

const logger = createLogger('queue-metrics-scraper');

/** Scrape interval. Picked to give Prometheus' 15s scrape ample fresh samples.
 *  Override via `PLUGIN_QUEUE_METRICS_INTERVAL_MS`. */
const DEFAULT_INTERVAL_MS = parseInt(process.env.PLUGIN_QUEUE_METRICS_INTERVAL_MS || '15000', 10);

/** BullMQ states reported by `getJobCounts`. Stable across BullMQ 5.x. */
const STATES = ['waiting', 'active', 'completed', 'failed', 'delayed', 'paused'] as const;

let timer: ReturnType<typeof setInterval> | null = null;

interface ScrapeTarget {
  /** Label value for the `queue` dimension on the gauge. */
  name: string;
  queue: Queue;
}

async function scrapeOnce(targets: ScrapeTarget[]): Promise<void> {
  await Promise.all(targets.map(async ({ name, queue }) => {
    try {
      const counts = await queue.getJobCounts(...STATES);
      for (const state of STATES) {
        setGauge('plugin_queue_jobs', { queue: name, state }, counts[state] ?? 0);
      }
    } catch (err) {
      // Don't crash the scraper on a transient Redis hiccup — the next tick
      // will retry. Log at warn so persistent failures surface.
      logger.warn('Failed to scrape queue counts', { queue: name, error: errorMessage(err) });
    }
  }));
}

/**
 * Start the scraper. Idempotent — calling twice is a no-op so the worker
 * boot path can call it unconditionally.
 *
 * @returns A `stop` function that clears the interval. Also registered as a
 *   SIGTERM handler so a graceful shutdown doesn't leave the timer running.
 */
export function startQueueMetricsScraper(
  targets: ScrapeTarget[],
  intervalMs: number = DEFAULT_INTERVAL_MS,
): () => void {
  if (timer) return stopQueueMetricsScraper;
  timer = setInterval(() => void scrapeOnce(targets), intervalMs);
  // First sample immediately so Prometheus sees data on its first scrape
  // (rather than waiting up to `intervalMs` after worker start).
  void scrapeOnce(targets);
  process.once('SIGTERM', stopQueueMetricsScraper);
  logger.info('Queue metrics scraper started', { intervalMs, queues: targets.map((t) => t.name) });
  return stopQueueMetricsScraper;
}

/** Stop the scraper. Exported for tests; production calls via the returned closure. */
export function stopQueueMetricsScraper(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
