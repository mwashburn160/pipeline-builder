// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * src/otel-bootstrap.ts — the `--import` preload. Off unless
 * OTEL_TRACING_ENABLED=true; when on it registers the ESM hook (a hook that
 * cannot register degrades to no instrumentation, never a crash), starts the
 * SDK with the service identity + OTLP endpoint and fs spans disabled, and
 * shuts it down once on SIGTERM/SIGINT.
 */

import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

const start = jest.fn();
const shutdown = jest.fn(async () => undefined);
const sdkOptions: unknown[] = [];
const register = jest.fn();
const exporterUrls: unknown[] = [];
const autoConfig: unknown[] = [];

jest.unstable_mockModule('node:module', () => ({ register }));
jest.unstable_mockModule('@opentelemetry/sdk-node', () => ({
  NodeSDK: class { constructor(o: unknown) { sdkOptions.push(o); } start() { start(); } shutdown() { return shutdown(); } },
}));
jest.unstable_mockModule('@opentelemetry/exporter-trace-otlp-http', () => ({
  OTLPTraceExporter: class { constructor(o: { url: string }) { exporterUrls.push(o.url); } },
}));
jest.unstable_mockModule('@opentelemetry/resources', () => ({ resourceFromAttributes: (a: Record<string, unknown>) => ({ attributes: a }) }));
jest.unstable_mockModule('@opentelemetry/auto-instrumentations-node', () => ({
  getNodeAutoInstrumentations: (c: unknown) => { autoConfig.push(c); return ['auto']; },
}));

const env = { ...process.env };
let onceSpy: ReturnType<typeof jest.spyOn>;
const handlers: Record<string, () => void> = {};

beforeEach(() => {
  jest.resetModules();
  process.env = { ...env };
  sdkOptions.length = 0;
  exporterUrls.length = 0;
  autoConfig.length = 0;
  start.mockClear();
  shutdown.mockClear();
  register.mockReset();
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  onceSpy = jest.spyOn(process, 'once').mockImplementation(((event: string, fn: () => void) => { handlers[event] = fn; return process; }) as never);
});
afterEach(() => { process.env = env; onceSpy.mockRestore(); });

describe('otel-bootstrap', () => {
  it('does nothing unless OTEL_TRACING_ENABLED=true', async () => {
    delete process.env.OTEL_TRACING_ENABLED;
    await import('../src/otel-bootstrap.js');
    expect(start).not.toHaveBeenCalled();
    expect(register).not.toHaveBeenCalled();
  });

  it('starts the SDK with the service identity, endpoint and fs spans off; shuts down on a signal', async () => {
    process.env.OTEL_TRACING_ENABLED = 'true';
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://jaeger:4318/v1/traces';
    process.env.OTEL_SERVICE_NAME = 'plugin';
    process.env.NODE_ENV = 'production';
    await import('../src/otel-bootstrap.js');
    expect(register).toHaveBeenCalledWith('@opentelemetry/instrumentation/hook.mjs', expect.any(String));
    expect(exporterUrls).toEqual(['http://jaeger:4318/v1/traces']);
    expect(sdkOptions[0]).toMatchObject({ resource: { attributes: { 'service.name': 'plugin', 'service.namespace': 'pipeline-builder', 'deployment.environment': 'production' } } });
    expect(autoConfig[0]).toEqual({ '@opentelemetry/instrumentation-fs': { enabled: false } });
    expect(start).toHaveBeenCalledTimes(1);
    handlers.SIGTERM!();
    expect(shutdown).toHaveBeenCalledTimes(1);
  });

  it('falls back to SERVICE_NAME / the default endpoint, and survives an ESM hook that cannot register', async () => {
    process.env.OTEL_TRACING_ENABLED = 'true';
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    delete process.env.OTEL_SERVICE_NAME;
    delete process.env.NODE_ENV;
    process.env.SERVICE_NAME = 'billing';
    register.mockImplementation(() => { throw new Error('no hook'); });
    await import('../src/otel-bootstrap.js');
    expect(console.warn).toHaveBeenCalledWith('[otel] ESM instrumentation hook not registered:', 'no hook');
    expect(exporterUrls).toEqual(['http://localhost:4318/v1/traces']);
    expect(sdkOptions[0]).toMatchObject({ resource: { attributes: { 'service.name': 'billing', 'deployment.environment': 'development' } } });
    expect(start).toHaveBeenCalledTimes(1);
  });
});
