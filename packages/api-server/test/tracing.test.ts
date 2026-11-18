// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { jest, describe, it, expect } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock());

const { shutdownTracing, currentTraceId } = await import('../src/api/tracing.js');

describe('tracing', () => {
  describe('shutdownTracing', () => {
    it('is a no-op when the SDK was never initialized', async () => {
      // Production starts tracing via the otel-bootstrap `--import` preload,
      // not this module, so the module-local `sdk` stays null and shutdown
      // resolves without touching an SDK.
      await expect(shutdownTracing()).resolves.toBeUndefined();
    });

    it('awaits the shutdown the otel-bootstrap preload published', async () => {
      // The preload's SDK is the only one production runs. shutdownTracing
      // used to consult a module-local handle nothing ever set, so the flush
      // before process.exit(0) never happened.
      const key = Symbol.for('pipeline-builder.otel.shutdown');
      let flushed = false;
      (globalThis as Record<symbol, unknown>)[key] = async () => {
        await new Promise((r) => setImmediate(r));
        flushed = true;
      };
      try {
        await shutdownTracing();
        expect(flushed).toBe(true);
      } finally {
        delete (globalThis as Record<symbol, unknown>)[key];
      }
    });
  });

  describe('currentTraceId', () => {
    it('returns undefined when there is no active span', () => {
      expect(currentTraceId()).toBeUndefined();
    });
  });
});
