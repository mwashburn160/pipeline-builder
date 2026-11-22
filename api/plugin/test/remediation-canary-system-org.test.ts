// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The canary fixtures wait for the system org. On a new install the plugin
 * service's first rescan pass completes before init-platform.sh registers the
 * administrator (which creates the system org), and every fixture queued then
 * failed compliance with "parent-org lookup failed ... HTTP 404", tripping its
 * circuit breaker and leaving 11 failed builds in the queue on every install.
 */

import { describe, expect, it, jest } from '@jest/globals';

import { ensureRemediationCanaries } from '../src/services/remediation/canary.js';

describe('ensureRemediationCanaries', () => {
  it('queues nothing, and does not touch the store, while the system org does not exist', async () => {
    const enqueue = jest.fn(async () => {});
    const ready = jest.fn(async () => false);
    await expect(ensureRemediationCanaries(enqueue, ready)).resolves.toBe(0);
    expect(ready).toHaveBeenCalledTimes(1);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('never throws when the readiness check itself rejects', async () => {
    const enqueue = jest.fn(async () => {});
    await expect(ensureRemediationCanaries(enqueue, async () => { throw new Error('boom'); })).resolves.toBe(0);
    expect(enqueue).not.toHaveBeenCalled();
  });
});
