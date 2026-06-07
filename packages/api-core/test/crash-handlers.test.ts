// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { installCrashHandlers } from '../src/utils/crash-handlers';

const mockLogger = { error: jest.fn() } as unknown as import('winston').Logger;

describe('installCrashHandlers', () => {
  const origEnv = process.env.NODE_ENV;
  afterEach(() => {
    process.env.NODE_ENV = origEnv;
    jest.restoreAllMocks();
  });

  it('is a no-op under NODE_ENV=test (never competes with the test runner)', () => {
    process.env.NODE_ENV = 'test';
    const onSpy = jest.spyOn(process, 'on').mockImplementation(() => process);
    installCrashHandlers(mockLogger);
    expect(onSpy).not.toHaveBeenCalled();
  });

  it('registers uncaughtException + unhandledRejection outside the test env', () => {
    process.env.NODE_ENV = 'production';
    // Mock so no real process-level handler leaks into the jest worker.
    const onSpy = jest.spyOn(process, 'on').mockImplementation(() => process);
    installCrashHandlers(mockLogger);
    const events = onSpy.mock.calls.map((c) => c[0]);
    expect(events).toEqual(expect.arrayContaining(['uncaughtException', 'unhandledRejection']));
  });
});
