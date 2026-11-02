// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `infra setup-events` repoints the ingestion Lambda at a platform secret — a
 * sensitive operation, so it writes a local audit entry (as store-token does)
 * BEFORE the deploy. The deploy is made to fail here: the entry must already be
 * on disk, carrying the operation metadata and nothing else.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { jest, describe, it, expect, afterAll, beforeEach } from '@jest/globals';
import { Command } from 'commander';

// audit-log resolves its path at import time from os.homedir(), so the spy has
// to be installed before the dynamic import below (HOME alone is not honored).
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-setup-events-audit-'));
jest.spyOn(os, 'homedir').mockImplementation(() => HOME);

const execFileSync = jest.fn(() => { throw new Error('deploy stubbed'); });
jest.unstable_mockModule('child_process', () => ({ execFileSync }));
jest.unstable_mockModule('../src/utils/platform-secret.js', () => ({
  resolvePlatformSecretName: jest.fn(async () => 'pipeline-builder/org-1/platform'),
}));

const { setupEvents } = await import('../src/commands/setup-events.js');

const AUDIT_FILE = path.join(HOME, '.pipeline-manager', 'audit.log');

// `--profile` writes AWS_PROFILE (applyAwsProfile); put it back afterwards.
const savedProfile = process.env.AWS_PROFILE;

afterAll(() => {
  if (savedProfile === undefined) delete process.env.AWS_PROFILE; else process.env.AWS_PROFILE = savedProfile;
  fs.rmSync(HOME, { recursive: true, force: true });
});

beforeEach(() => {
  process.env.PLATFORM_BASE_URL = 'https://platform.example.com';
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
});

describe('setup-events audit-log', () => {
  it('records the operation before deploying, with the scoped secret it points at', async () => {
    const program = new Command();
    program.exitOverride();
    setupEvents(program);

    // The stubbed deploy fails, and handleError re-throws once process.exit is a no-op.
    await expect(program.parseAsync(
      ['setup-events', '--region', 'us-east-1', '--scoped-ingest', '--with-dora'],
      { from: 'user' },
    )).rejects.toThrow('deploy stubbed');

    expect(execFileSync).toHaveBeenCalled(); // reached the deploy, which failed
    const lines = fs.readFileSync(AUDIT_FILE, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0]!);
    expect(entry.command).toBe('setup-events');
    expect(entry.details).toMatchObject({
      stack: expect.any(String),
      region: 'us-east-1',
      secretName: 'pipeline-builder/org-1/reporting-ingest',
      scopedIngest: true,
      dora: true,
      packageVersion: 'latest',
    });
    expect(entry.details.executionId).toMatch(/^[0-9A-F]{8}$/);
  });

  it('records the unscoped defaults when no flags are passed', async () => {
    fs.writeFileSync(AUDIT_FILE, '', { mode: 0o600 });
    const program = new Command();
    program.exitOverride();
    setupEvents(program);

    await expect(program.parseAsync(
      ['setup-events', '--region', 'us-east-1', '--package-version', '1.2.3', '--profile', 'ops'],
      { from: 'user' },
    )).rejects.toThrow('deploy stubbed');

    const entry = JSON.parse(fs.readFileSync(AUDIT_FILE, 'utf-8').trim());
    expect(entry.details).toMatchObject({
      secretName: 'pipeline-builder/org-1/platform',
      scopedIngest: false,
      dora: false,
      packageVersion: '1.2.3',
      profile: 'ops',
    });
  });

  it('records nothing when PLATFORM_BASE_URL is unset (fails before any change)', async () => {
    fs.writeFileSync(AUDIT_FILE, '', { mode: 0o600 });
    delete process.env.PLATFORM_BASE_URL;
    const program = new Command();
    program.exitOverride();
    setupEvents(program);

    await expect(program.parseAsync(['setup-events', '--region', 'us-east-1'], { from: 'user' }))
      .rejects.toThrow('PLATFORM_BASE_URL not set');
    expect(fs.readFileSync(AUDIT_FILE, 'utf-8')).toBe('');
  });
});
