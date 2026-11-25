// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * spawnCdkShellCommand — the abortable `cdk` run the runner deploy job uses so
 * a wiped deploy session (cancelled / expired: 401 from the facade) stops cdk
 * mid-run. Real child processes (no child_process mock in this file).
 */

import { describe, expect, it } from '@jest/globals';

const { spawnCdkShellCommand } = await import('../src/utils/cdk-utils.js');

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe('spawnCdkShellCommand', () => {
  it('resolves with the duration when the command exits 0', async () => {
    const r = await spawnCdkShellCommand('true', { showOutput: false });
    expect(r.duration).toBeGreaterThanOrEqual(0);
  });

  it('rejects with the exit status when the command fails', async () => {
    await expect(spawnCdkShellCommand('exit 3', { showOutput: false })).rejects.toThrow(/exit(ed)? .*3/i);
  });

  it('passes the extra env to the command', async () => {
    await expect(spawnCdkShellCommand('test "$PB_SPAWN_PROBE" = yes', { showOutput: false, env: { PB_SPAWN_PROBE: 'yes' } })).resolves.toBeDefined();
  });

  it('an abort kills the whole process group and rejects at once', async () => {
    const controller = new AbortController();
    let pid = 0;
    const started = Date.now();
    const run = spawnCdkShellCommand('sleep 30 & echo $! > /dev/null; wait', {
      showOutput: false,
      signal: controller.signal,
      onSpawn: (p) => { pid = p; },
    });
    setTimeout(() => controller.abort(), 200);
    await expect(run).rejects.toMatchObject({ name: 'AbortError' });
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(pid).toBeGreaterThan(0);
    // The group leader is gone.
    await new Promise((r) => setTimeout(r, 200));
    expect(alive(pid)).toBe(false);
  });

  it('an already aborted signal never starts the command', async () => {
    const controller = new AbortController();
    controller.abort();
    let spawned = false;
    await expect(spawnCdkShellCommand('true', { showOutput: false, signal: controller.signal, onSpawn: () => { spawned = true; } }))
      .rejects.toMatchObject({ name: 'AbortError' });
    expect(spawned).toBe(false);
  });
});
