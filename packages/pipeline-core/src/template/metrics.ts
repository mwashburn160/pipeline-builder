// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Prometheus metrics for template resolution. Optional — the module is
 * only wired up when `prom-client` is already present in the host
 * process (as is the case for api-server based services). Falls back to
 * no-op stubs when unavailable so pipeline-core stays usable outside
 * server contexts.
 */

import { safeCreateRequire } from '@pipeline-builder/api-core';

// ESM has no global `require`; safeCreateRequire enables the synchronous,
// OPTIONAL lazy-load of prom-client below (no-op stubs when it isn't installed).
// (CJS-bundle safe — see api-core's safe-require.ts.)
const require = safeCreateRequire(import.meta.url);

interface Counter { inc(labels?: Record<string, string>, value?: number): void }
interface Histogram { observe(labels: Record<string, string>, value: number): void }

function resolvePromClient(): any | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('prom-client');
  } catch {
    return null;
  }
}

const promClient = resolvePromClient();

function makeCounter(name: string, help: string, labelNames: string[]): Counter {
  if (!promClient) return { inc: () => { /* noop */ } };
  const existing = promClient.register.getSingleMetric(name);
  return existing ?? new promClient.Counter({ name, help, labelNames });
}

function makeHistogram(name: string, help: string, labelNames: string[], buckets: number[]): Histogram {
  if (!promClient) return { observe: () => { /* noop */ } };
  const existing = promClient.register.getSingleMetric(name);
  return existing ?? new promClient.Histogram({ name, help, labelNames, buckets });
}

export const templateResolutionsTotal = makeCounter(
  'pipeline_builder_template_resolutions_total',
  'Total number of template resolution operations',
  ['outcome', 'doc'],
);

export const templateResolutionDurationMs = makeHistogram(
  'pipeline_builder_template_resolution_duration_ms',
  'Template resolution duration in milliseconds',
  ['doc'],
  [1, 5, 10, 50, 100, 500, 1000],
);

export function recordResolution(doc: 'pipeline' | 'plugin', durationMs: number, success: boolean): void {
  templateResolutionsTotal.inc({ outcome: success ? 'success' : 'error', doc });
  templateResolutionDurationMs.observe({ doc }, durationMs);
}
