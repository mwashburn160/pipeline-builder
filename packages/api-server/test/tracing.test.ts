// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { jest, describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

const mockSdkInstance = {
  start: jest.fn(),
  shutdown: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
};
const mockNodeSDK = jest.fn(() => mockSdkInstance);

jest.unstable_mockModule('@opentelemetry/sdk-node', () => ({
  NodeSDK: mockNodeSDK,
}));

jest.unstable_mockModule('@opentelemetry/exporter-trace-otlp-http', () => ({
  OTLPTraceExporter: jest.fn(),
}));

jest.unstable_mockModule('@opentelemetry/resources', () => ({
  resourceFromAttributes: (attrs: unknown) => attrs,
}));

const mockTracingConfig = { enabled: false, endpoint: 'http://localhost:4318/v1/traces' };

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock());

jest.unstable_mockModule('@pipeline-builder/pipeline-core', () => ({
  Config: {
    getAny: () => ({ tracing: mockTracingConfig }),
  },
}));

const { initTracing, shutdownTracing, currentTraceId } = await import('../src/api/tracing.js');

describe('tracing', () => {
  beforeEach(() => {
    mockNodeSDK.mockClear();
    mockSdkInstance.start.mockClear();
    mockSdkInstance.shutdown.mockClear();
    mockTracingConfig.enabled = false;
  });

  afterEach(async () => {
    await shutdownTracing();
  });

  describe('initTracing', () => {
    it('does nothing when tracing is disabled', () => {
      mockTracingConfig.enabled = false;
      initTracing('svc');
      expect(mockNodeSDK).not.toHaveBeenCalled();
    });

    it('starts the NodeSDK when tracing is enabled', () => {
      mockTracingConfig.enabled = true;
      initTracing('svc');
      expect(mockNodeSDK).toHaveBeenCalledTimes(1);
      expect(mockSdkInstance.start).toHaveBeenCalled();
    });

    it('is idempotent', () => {
      mockTracingConfig.enabled = true;
      initTracing('svc');
      initTracing('svc');
      expect(mockNodeSDK).toHaveBeenCalledTimes(1);
    });
  });

  describe('shutdownTracing', () => {
    it('is a no-op when SDK was never initialized', async () => {
      await expect(shutdownTracing()).resolves.toBeUndefined();
      expect(mockSdkInstance.shutdown).not.toHaveBeenCalled();
    });

    it('shuts down when initialized', async () => {
      mockTracingConfig.enabled = true;
      initTracing('svc');
      await shutdownTracing();
      expect(mockSdkInstance.shutdown).toHaveBeenCalled();
    });
  });

  describe('currentTraceId', () => {
    it('returns undefined when tracing is not initialized', () => {
      expect(currentTraceId()).toBeUndefined();
    });
  });
});
