// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for the MongoDB connection helper.
 */

const mockConnect = jest.fn();
const mockSet = jest.fn();
const onHandlers: Record<string, (...args: unknown[]) => void> = {};
const mockOn = jest.fn((event: string, handler: (...args: unknown[]) => void) => {
  onHandlers[event] = handler;
});

jest.mock('mongoose', () => ({
  __esModule: true,
  default: {
    set: (...args: unknown[]) => mockSet(...args),
    connect: (...args: unknown[]) => mockConnect(...args),
    connection: {
      on: (event: string, handler: (...args: unknown[]) => void) => mockOn(event, handler),
    },
  },
}));

const mockLogger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
};

jest.mock('@pipeline-builder/api-core', () => ({
  createLogger: () => mockLogger,
}));

import { connectDatabase } from '../src/helpers/database';

describe('connectDatabase', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    Object.keys(onHandlers).forEach((k) => delete onHandlers[k]);
  });

  it('sets strictQuery and connects with the provided URI', async () => {
    mockConnect.mockResolvedValue(undefined);

    await connectDatabase('mongodb://localhost:27017/test');

    expect(mockSet).toHaveBeenCalledWith('strictQuery', true);
    expect(mockConnect).toHaveBeenCalledWith('mongodb://localhost:27017/test');
  });

  it('registers error, disconnected, and reconnected handlers', async () => {
    mockConnect.mockResolvedValue(undefined);

    await connectDatabase('mongodb://localhost/test');

    expect(mockOn).toHaveBeenCalledWith('error', expect.any(Function));
    expect(mockOn).toHaveBeenCalledWith('disconnected', expect.any(Function));
    expect(mockOn).toHaveBeenCalledWith('reconnected', expect.any(Function));
  });

  it('logs an error from the error handler', async () => {
    mockConnect.mockResolvedValue(undefined);
    await connectDatabase('mongodb://localhost/test');

    onHandlers.error?.(new Error('boom'));

    expect(mockLogger.error).toHaveBeenCalledWith(
      'MongoDB connection error',
      { error: 'boom' },
    );
  });

  it('logs warnings on disconnect and info on reconnect', async () => {
    mockConnect.mockResolvedValue(undefined);
    await connectDatabase('mongodb://localhost/test');

    onHandlers.disconnected?.();
    onHandlers.reconnected?.();

    expect(mockLogger.warn).toHaveBeenCalledWith('MongoDB disconnected');
    expect(mockLogger.info).toHaveBeenCalledWith('MongoDB reconnected');
  });

  it('propagates connection failures', async () => {
    mockConnect.mockRejectedValue(new Error('refused'));

    await expect(connectDatabase('mongodb://bad/test')).rejects.toThrow('refused');
  });
});
