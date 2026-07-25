// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import fs from 'fs';
import os from 'os';
import path from 'path';
import { jest, describe, it, expect, beforeAll, afterAll, beforeEach } from '@jest/globals';
import { Command } from 'commander';

// Mock cdk-utils so the bootstrap action does NOT shell out to the real CDK.
// The action still runs its real auditLog('bootstrap', …) call, which is what
// we are verifying here.
jest.unstable_mockModule('../src/utils/cdk-utils.js', () => ({
  ensureCdkAvailable: jest.fn(),
  executeCdkShellCommand: jest.fn(() => ({ success: true, duration: 1 })),
}));

const { bootstrap } = await import('../src/commands/bootstrap.js');

const AUDIT_DIR = path.join(os.homedir(), '.pipeline-manager');
const AUDIT_FILE = path.join(AUDIT_DIR, 'audit.log');

// Distinctive 12-digit AWS account id — must never reach the persisted audit line.
const ACCOUNT_ID = '123456789012';

let originalContent: string | null = null;

beforeAll(() => {
  try {
    originalContent = fs.readFileSync(AUDIT_FILE, 'utf-8');
  } catch {
    originalContent = null;
  }
});

afterAll(() => {
  if (originalContent !== null) {
    fs.writeFileSync(AUDIT_FILE, originalContent, { mode: 0o600 });
  } else {
    try { fs.unlinkSync(AUDIT_FILE); } catch { /* ignore */ }
  }
});

beforeEach(() => {
  // Start from a clean audit file so we can read exactly the bootstrap entry.
  if (!fs.existsSync(AUDIT_DIR)) fs.mkdirSync(AUDIT_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(AUDIT_FILE, '', { mode: 0o600 });
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

describe('bootstrap audit-log (account-id persistence prevention)', () => {
  it('should NOT persist the AWS account id when --account is passed', async () => {
    const program = new Command();
    program.exitOverride(); // never call process.exit during the test
    bootstrap(program);

    await program.parseAsync(
      ['bootstrap', '--account', ACCOUNT_ID, '--region', 'us-east-1'],
      { from: 'user' },
    );

    const content = fs.readFileSync(AUDIT_FILE, 'utf-8').trim();
    const bootstrapLine = content
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l))
      .find((e) => e.command === 'bootstrap');

    // The bootstrap operation was recorded…
    expect(bootstrapLine).toBeDefined();
    // …but the account id must never appear in the persisted line.
    expect(JSON.stringify(bootstrapLine)).not.toContain(ACCOUNT_ID);
    expect(bootstrapLine.details).not.toHaveProperty('account');
    // Safe metadata is still recorded.
    expect(bootstrapLine.details.region).toBe('us-east-1');
    expect(bootstrapLine.details.profile).toBe('default');
  });
});
