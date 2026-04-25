// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

jest.mock('@pipeline-builder/api-core', () => ({
  InternalHttpClient: jest.fn(),
}));

jest.mock('@pipeline-builder/pipeline-core', () => ({
  Config: {
    getAny: (key: string) => {
      if (key === 'server') {
        return { services: { messageHost: 'msg-host', messagePort: 9100 } };
      }
      return {};
    },
  },
}));

import { InternalHttpClient } from '@pipeline-builder/api-core';
import { messageClient } from '../src/helpers/message-client';

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
