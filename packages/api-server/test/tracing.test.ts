// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { jest, describe, it, expect } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

jest.unstable_mockModule('@opentelemetry/sdk-node', () => ({
  NodeSDK: jest.fn(),
}));

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
  });

  describe('currentTraceId', () => {
    it('returns undefined when there is no active span', () => {
      expect(currentTraceId()).toBeUndefined();
    });
  });
});
