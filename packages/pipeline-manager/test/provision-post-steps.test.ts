// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from '@jest/globals';
import { resolvePostSteps, type PostStepOptions } from '../src/agent/post-steps.js';

const base: PostStepOptions = {
  target: 'local',
  url: 'https://localhost:8443',
  enabledLoadIds: [],
  buildBootstrap: false,
  init: true,
  smokeTest: false,
  events: false,
  steps: [],
};

describe('resolvePostSteps', () => {
  it('register only by default; runs init-platform with all loads = n', () => {
    const { steps } = resolvePostSteps(base);
    expect(steps.map((s) => s.id)).toEqual(['register']);
    const reg = steps[0]!;
    expect(reg.command).toBe('./deploy/bin/init-platform.sh local');
    expect(reg.env).toMatchObject({ BUILD_BOOTSTRAP: 'n', LOAD_PLUGINS: 'n', LOAD_PIPELINES: 'n', LOAD_COMPLIANCE: 'n' });
  });

  it('enabled loads flip the matching init-platform env to y', () => {
    const { steps } = resolvePostSteps({ ...base, enabledLoadIds: ['plugins', 'samples'], buildBootstrap: true });
    const reg = steps.find((s) => s.id === 'register')!;
    expect(reg.env).toMatchObject({ LOAD_PLUGINS: 'y', LOAD_PIPELINES: 'y', LOAD_COMPLIANCE: 'n', BUILD_BOOTSTRAP: 'y' });
  });

  it('--no-init drops the register step', () => {
    const { steps } = resolvePostSteps({ ...base, init: false, smokeTest: true });
    expect(steps.map((s) => s.id)).toEqual(['smoke-test']);
  });

  it('orders register → smoke → events bundle (store-token → setup-events) → custom', () => {
    const { steps } = resolvePostSteps({
      ...base,
      target: 'ec2',
      url: 'https://x.example.com',
      region: 'us-east-1',
      smokeTest: true,
      events: true,
      steps: ['echo hi'],
    });
    expect(steps.map((s) => s.id)).toEqual(['register', 'smoke-test', 'store-token', 'events', 'custom-1']);
    // On AWS, register is surfaced (run on the box) with the resolved URL baked in so the
    // operator copy-pastes a correct line regardless of their shell's PLATFORM_BASE_URL.
    const reg = steps.find((s) => s.id === 'register')!;
    expect(reg.command).toBe('PLATFORM_BASE_URL=https://x.example.com ./deploy/bin/init-platform.sh ec2');
    // store-token must precede setup-events (the Lambda reads the secret it writes).
    const storeToken = steps.find((s) => s.id === 'store-token')!;
    expect(storeToken.command).toContain('store-token --region us-east-1');
    expect(storeToken.command).not.toContain('--secret-name'); // derives the pattern, never passed
    const events = steps.find((s) => s.id === 'events')!;
    expect(events.command).toContain('setup-events --region us-east-1');
    expect(events.command).not.toContain('--secret-name');
  });

  it('events is skipped (not silently dropped) on non-AWS targets', () => {
    const { steps, skipped } = resolvePostSteps({ ...base, events: true });
    expect(steps.map((s) => s.id)).not.toContain('events');
    expect(skipped.map((s) => s.id)).toContain('events');
  });

  it('smoke-test is skipped when there is no platform URL', () => {
    const { steps, skipped } = resolvePostSteps({ ...base, url: null, init: false, smokeTest: true });
    expect(steps).toHaveLength(0);
    expect(skipped.map((s) => s.id)).toContain('smoke-test');
  });
});
