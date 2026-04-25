// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

const mockSdkInstance = {
  start: jest.fn(),
  shutdown: jest.fn().mockResolvedValue(undefined),
};
const mockNodeSDK = jest.fn(() => mockSdkInstance);

jest.mock('@opentelemetry/sdk-node', () => ({
  NodeSDK: mockNodeSDK,
}));

jest.mock('@opentelemetry/exporter-trace-otlp-http', () => ({
  OTLPTraceExporter: jest.fn(),
}));

jest.mock('@opentelemetry/resources', () => ({
  resourceFromAttributes: (attrs: unknown) => attrs,
}));

const mockTracingConfig = { enabled: false, endpoint: 'http://localhost:4318/v1/traces' };

jest.mock('@pipeline-builder/api-core', () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }),
}));

jest.mock('@pipeline-builder/pipeline-core', () => ({
  Config: {
    getAny: () => ({ tracing: mockTracingConfig }),
  },
}));

import { initTracing, shutdownTracing, currentTraceId } from '../src/api/tracing';

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
