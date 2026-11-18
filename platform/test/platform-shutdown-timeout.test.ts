// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * A shutdown step that never finishes (here: Mongo's close) must not leave the
 * pod ignoring SIGTERM until SIGKILL — the force-exit timer fires exit(1).
 * Separate file from platform-shutdown.test.ts because the entrypoint can only
 * be booted once per module registry.
 */

import { describe, it, expect, afterAll } from '@jest/globals';
import { bootPlatform, waitFor, type PlatformBoot } from './helpers/platform-boot.js';

let boot: PlatformBoot;

afterAll(() => boot?.cleanup());

describe('platform graceful shutdown — hung teardown', () => {
  it('force-exits with 1 after the shutdown timeout', async () => {
    boot = await bootPlatform({ shutdownTimeoutMs: 100, mongoCloseHangs: true });
    boot.setReady(true);

    process.emit('SIGTERM');
    await waitFor(() => boot.events.includes('exit(1)'));

    expect(boot.events).toContain('mongo.close');
    expect(boot.events).not.toContain('exit(0)');
    expect(boot.exit).toHaveBeenCalledWith(1);
  });
});
