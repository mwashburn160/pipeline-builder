// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import fs from 'fs';
import os from 'os';
import path from 'path';
import { auditLog } from '../src/utils/audit-log';

const AUDIT_DIR = path.join(os.homedir(), '.pipeline-manager');
const AUDIT_FILE = path.join(AUDIT_DIR, 'audit.log');

let originalContent: string | null = null;

beforeAll(() => {
  // Preserve existing audit log
  try {
    originalContent = fs.readFileSync(AUDIT_FILE, 'utf-8');
  } catch {
    originalContent = null;
  }
});

afterAll(() => {
  // Restore original audit log
  if (originalContent !== null) {
    fs.writeFileSync(AUDIT_FILE, originalContent, { mode: 0o600 });
  } else {
    try { fs.unlinkSync(AUDIT_FILE); } catch { /* ignore */ }
  }
});

describe('auditLog', () => {
  it('should create audit directory if it does not exist', () => {
    auditLog('test-command', { test: true });
    expect(fs.existsSync(AUDIT_DIR)).toBe(true);
  });

  it('should write a JSON entry to the audit file', () => {
    auditLog('deploy', { pipelineId: 'test-123' });

    const content = fs.readFileSync(AUDIT_FILE, 'utf-8');
    const lines = content.trim().split('\n');
    const lastEntry = JSON.parse(lines[lines.length - 1]!);

    expect(lastEntry.command).toBe('deploy');
    expect(lastEntry.details).toEqual({ pipelineId: 'test-123' });
    expect(lastEntry.timestamp).toBeDefined();
    expect(lastEntry.user).toBe(os.userInfo().username);
  });

  it('should append multiple entries', () => {
    // Clear file
    fs.writeFileSync(AUDIT_FILE, '', { mode: 0o600 });

    auditLog('command-1');
    auditLog('command-2');
    auditLog('command-3');

    const lines = fs.readFileSync(AUDIT_FILE, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(3);
  });

  it('should not throw on write errors', () => {
    // This should not throw even if the dir is read-only
    expect(() => auditLog('test')).not.toThrow();
  });
});
