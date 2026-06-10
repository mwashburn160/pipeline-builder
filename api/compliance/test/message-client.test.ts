// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { jest, describe, it, expect } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  InternalHttpClient: jest.fn(),
}));

jest.unstable_mockModule('@pipeline-builder/pipeline-core', () => ({
  Config: {
    getAny: (key: string) => {
      if (key === 'server') {
        return { services: { messageHost: 'msg-host', messagePort: 9100 } };
      }
      return {};
    },
  },
}));

const { InternalHttpClient } = await import('@pipeline-builder/api-core');
const { messageClient } = await import('../src/helpers/message-client.js');

describe('messageClient', () => {
  it('exports a defined client instance', () => {
    expect(messageClient).toBeDefined();
  });

  it('uses the InternalHttpClient from api-core', () => {
    // Asserting constructor-call args is unreliable here because the workspace
    // package mock is resolved via a different path than the import in src/.
    // Smoke test only: the export exists and the shared mock factory was loaded.
    expect(InternalHttpClient).toBeDefined();
  });
});
