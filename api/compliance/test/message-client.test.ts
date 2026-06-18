// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { jest, describe, it, expect } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock());

// createServiceClient (pipeline-core) builds the client; stub it to tag which
// service it was asked for so we can assert without depending on call history
// (clearMocks wipes the module-load call before the test body runs).
jest.unstable_mockModule('@pipeline-builder/pipeline-core', () => ({
  createServiceClient: (service: string) => ({ service, post: jest.fn(), get: jest.fn() }),
}));

const { messageClient } = await import('../src/helpers/message-client.js');

describe('messageClient', () => {
  it('exports a client built via createServiceClient for the message service', () => {
    expect(messageClient).toBeDefined();
    expect((messageClient as unknown as { service: string }).service).toBe('message');
  });
});
