// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Business-metric helpers for the platform service. Mirrors api-server's
 * `incCounter` / `observe` / `setGauge` API so call sites look identical
 * across services — but writes to platform's own registry (defined in
 * `index.ts`) so the `/metrics` endpoint exposes them.
 *
 * The platform service runs its own Express setup (not api-server's
 * createApp), which is why we duplicate the helpers here. If platform
 * ever migrates to createApp, this file can be deleted in favor of the
 * api-server exports.
 */

import { Counter, Gauge, Histogram, Registry } from 'prom-client';

let registry: Registry | null = null;
const counters = new Map<string, Counter<string>>();
const histograms = new Map<string, Histogram<string>>();
const gauges = new Map<string, Gauge<string>>();

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

function humanize(name: string): string {
  return name.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
}

export function incCounter(name: string, labels: Record<string, string> = {}, value = 1): void {
  let c = counters.get(name);
  if (!c) {
    c = new Counter({ name, help: humanize(name), labelNames: Object.keys(labels), registers: [ensureRegistry()] });
    counters.set(name, c);
  }
  c.inc(labels, value);
}

export function observe(name: string, labels: Record<string, string>, value: number): void {
  let h = histograms.get(name);
  if (!h) {
    h = new Histogram({
      name,
      help: humanize(name),
      labelNames: Object.keys(labels),
      buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 300],
      registers: [ensureRegistry()],
    });
    histograms.set(name, h);
  }
  h.observe(labels, value);
}

export function setGauge(name: string, labels: Record<string, string>, value: number): void {
  let g = gauges.get(name);
  if (!g) {
    g = new Gauge({ name, help: humanize(name), labelNames: Object.keys(labels), registers: [ensureRegistry()] });
    gauges.set(name, g);
  }
  g.set(labels, value);
}
