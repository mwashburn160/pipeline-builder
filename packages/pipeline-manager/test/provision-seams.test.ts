// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import path from 'node:path';
import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import type { PostStep } from '../src/agent/post-steps.js';

// Mock the I/O boundary the seams touch; let the pure helpers (assembleCommand,
// bootstrapCommand, resolvePostSteps, redactSecrets) run for real.
const runScript = jest.fn<(...a: unknown[]) => Promise<{ code: number; tail: string }>>();
const entrypointExists = jest.fn<(...a: unknown[]) => boolean>();
const matchIssues = jest.fn<(...a: unknown[]) => unknown[]>();

jest.unstable_mockModule('../src/agent/executor.js', () => ({
  runScript,
  entrypointExists,
  executionBlocked: jest.fn(() => null),
}));
jest.unstable_mockModule('../src/agent/troubleshoot.js', () => ({
  matchIssues,
  sesPostDeployGuidance: jest.fn(() => []),
}));
// Keep AI deterministically OFF (no SDK load, no diagnosis branch).
jest.unstable_mockModule('../src/agent/ai.js', () => ({
  isAiConfigured: () => false,
  diagnoseFailure: jest.fn(),
  parseGoal: jest.fn(),
}));

const { runPostSteps, bootstrapAndLocate, runDeployWithRetry } = await import('../src/commands/provision.js');
const { TARGETS } = await import('../src/agent/targets.js');

const step = (id: string, command: string): PostStep => ({ id, label: id, command });

beforeEach(() => {
  runScript.mockReset();
  entrypointExists.mockReset();
  matchIssues.mockReset();
  process.exitCode = undefined;
});
afterEach(() => {
  process.exitCode = undefined; // don't leak a failure exit code into jest
});

describe('runPostSteps — local execution vs AWS surfacing', () => {
  it('runs register locally (local target)', async () => {
    runScript.mockResolvedValue({ code: 0, tail: '' });
    await runPostSteps([step('register', './init-platform.sh'), step('smoke-test', 'curl /health')],
      [], 'local', '/cwd', {}, { yes: true });
    const ran = runScript.mock.calls.map((c) => c[0]);
    expect(ran).toContain('./init-platform.sh');
    expect(ran).toContain('curl /health');
  });

  it('SURFACES register/store-token/events on ec2 (does NOT run them); runs smoke-test', async () => {
    runScript.mockResolvedValue({ code: 0, tail: '' });
    await runPostSteps(
      [step('register', './init-platform.sh ec2'), step('store-token', 'pm store-token'),
        step('events', 'pm setup-events'), step('smoke-test', 'curl /health')],
      [], 'ec2', '/cwd', {}, { yes: true });
    const ran = runScript.mock.calls.map((c) => c[0]);
    expect(ran).not.toContain('./init-platform.sh ec2');
    expect(ran).not.toContain('pm store-token');
    expect(ran).not.toContain('pm setup-events');
    expect(ran).toContain('curl /health');
  });

  it('sets exitCode=1 when a step fails (and stops)', async () => {
    runScript.mockResolvedValue({ code: 1, tail: 'boom' });
    await runPostSteps([step('register', './a.sh'), step('smoke-test', './b.sh')],
      [], 'local', '/cwd', {}, { yes: true });
    expect(process.exitCode).toBe(1);
    expect(runScript).toHaveBeenCalledTimes(1); // breaks on first failure
  });

  it('is a no-op for an empty step list', async () => {
    await runPostSteps([], [], 'local', '/cwd', {}, { yes: true });
    expect(runScript).not.toHaveBeenCalled();
  });
});

describe('bootstrapAndLocate — cwd / bootstrapped / ok contract', () => {
  const spec = TARGETS.local;
  const bootstrap = { repo: 'https://x/y.git', ref: 'main', workdir: 'pb', paths: [], full: false };

  it('--repo success: ok, bootstrapped, cwd repointed into the clone', async () => {
    runScript.mockResolvedValue({ code: 0, tail: '' });
    entrypointExists.mockReturnValue(true);
    const r = await bootstrapAndLocate(spec, bootstrap, 'git clone …', [], '/start', { yes: true });
    expect(r.ok).toBe(true);
    expect(r.bootstrapped).toBe(true);
    expect(r.cwd).toBe(path.resolve('/start', 'pb'));
    expect(runScript).toHaveBeenCalledTimes(1);
  });

  it('--repo clone failure: ok=false, exitCode=1', async () => {
    runScript.mockResolvedValue({ code: 1, tail: '' });
    const r = await bootstrapAndLocate(spec, bootstrap, 'git clone …', [], '/start', { yes: true });
    expect(r.ok).toBe(false);
    expect(process.exitCode).toBe(1);
  });

  it('no bootstrap + entrypoint present: ok, not bootstrapped, cwd unchanged, no clone', async () => {
    entrypointExists.mockReturnValue(true);
    const r = await bootstrapAndLocate(spec, bootstrap, null, [], '/start', { yes: true });
    expect(r.ok).toBe(true);
    expect(r.bootstrapped).toBe(false);
    expect(r.cwd).toBe('/start');
    expect(runScript).not.toHaveBeenCalled();
  });

  it('no bootstrap + entrypoint missing (non-interactive): ok=false, exitCode=1', async () => {
    entrypointExists.mockReturnValue(false);
    const r = await bootstrapAndLocate(spec, bootstrap, null, [], '/start', { yes: true });
    expect(r.ok).toBe(false);
    expect(process.exitCode).toBe(1);
  });
});

describe('runDeployWithRetry — retry + auto-fix', () => {
  const spec = TARGETS.local;

  it('succeeds on the first attempt (one run)', async () => {
    runScript.mockResolvedValue({ code: 0, tail: '' });
    const r = await runDeployWithRetry(spec, 'https://localhost:8443', '/cwd', { region: 'us' }, {}, { retries: '1', yes: true });
    expect(r.succeeded).toBe(true);
    expect(runScript).toHaveBeenCalledTimes(1);
  });

  it('applies a param fix and retries to success', async () => {
    runScript
      .mockResolvedValueOnce({ code: 1, tail: 'SES identity already exists' })
      .mockResolvedValueOnce({ code: 0, tail: '' });
    matchIssues.mockReturnValue([
      { cause: 'SES identity exists', suggestion: 'skip identity creation', retryable: true, paramFix: { key: 'noCreateSesIdentity', value: true } },
    ]);
    const r = await runDeployWithRetry(spec, 'url', '/cwd', { region: 'us' }, {}, { retries: '1', yes: true });
    expect(r.succeeded).toBe(true);
    expect(r.runParams.noCreateSesIdentity).toBe(true);
    expect(runScript).toHaveBeenCalledTimes(2);
  });

  it('gives up (one run) when the failure has no retryable issue', async () => {
    runScript.mockResolvedValue({ code: 1, tail: 'unrecoverable' });
    matchIssues.mockReturnValue([]);
    const r = await runDeployWithRetry(spec, 'url', '/cwd', {}, {}, { retries: '2', yes: true });
    expect(r.succeeded).toBe(false);
    expect(runScript).toHaveBeenCalledTimes(1);
  });
});
