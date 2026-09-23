// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Business-metric helpers for the platform service.
 *
 * The lazy counter/histogram/gauge maps are api-server's shared
 * `createMetricHelpers` factory — the SAME implementation (and the same
 * histogram buckets) its own `incCounter`/`observe`/`setGauge` are built from,
 * so a metric emitted by platform and one emitted by any other service can
 * never disagree about its shape.
 *
 * What stays here is the one thing that differs: the registry. Platform runs
 * its own Express setup rather than api-server's `createApp`, so it owns the
 * registry its `/metrics` endpoint serves and injects it on app boot
 * (`setMetricsRegistry`, called from `index.ts`). The factory takes a THUNK for
 * exactly that reason — the registry does not exist at import time.
 */

import { createMetricHelpers, type MetricHelpers } from '@pipeline-builder/api-server';
import type { Registry } from 'prom-client';

let registry: Registry | null = null;
let helpers: MetricHelpers | null = null;

/** Wire the registry from index.ts on app boot — exactly once. */
export function setMetricsRegistry(r: Registry): void {
  registry = r;
}

function ensureRegistry(): Registry {
  if (!registry) {
    throw new Error('Metrics registry not set — call setMetricsRegistry() during app boot');
  }
  return registry;
}

/**
 * The helpers, built on first emission (never at import time) so a module that
 * merely imports this file does not need a registry — and neither does a test
 * that loads one.
 */
function metrics(): MetricHelpers {
  helpers ??= createMetricHelpers(ensureRegistry);
  return helpers;
}

export function incCounter(name: string, labels: Record<string, string> = {}, value = 1): void {
  metrics().incCounter(name, labels, value);
}

export function observe(name: string, labels: Record<string, string>, value: number): void {
  metrics().observe(name, labels, value);
}

export function setGauge(name: string, labels: Record<string, string>, value: number): void {
  metrics().setGauge(name, labels, value);
}
