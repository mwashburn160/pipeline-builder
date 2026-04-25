// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

const InternalHttpClientCtor = jest.fn();

jest.mock('@pipeline-builder/api-core', () => ({
  InternalHttpClient: jest.fn().mockImplementation((cfg: unknown) => {
    InternalHttpClientCtor(cfg);
    return { __cfg: cfg };
  }),
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

import { messageClient } from '../src/helpers/message-client';

describe('messageClient', () => {
  it('is constructed with the configured message service host and port', () => {
    expect(InternalHttpClientCtor).toHaveBeenCalledWith({
      host: 'msg-host',
      port: 9100,
    });
  });

  it('exports a defined client instance', () => {
    expect(messageClient).toBeDefined();
  });
});
