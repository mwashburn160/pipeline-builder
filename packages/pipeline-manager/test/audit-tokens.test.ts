// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `audit tokens` exit-code contract (cron-friendly): 0 all clear, 1 at-risk,
 * 2 scan failure.
 *
 * Pinned regression: a secret the scan could not READ, could not PARSE, or that
 * recorded no expiry was skipped with a warning — so an access-denied sweep, or
 * a store holding only broken credentials, reported "all clear" and exited 0.
 */

import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { AnyFn } from '@pipeline-builder/api-core/testing';

const listSecrets = jest.fn<AnyFn>();
const getSecretValue = jest.fn<AnyFn>();
jest.unstable_mockModule('../src/utils/aws-secrets.js', () => ({ listSecrets, getSecretValue, getSecretArn: jest.fn(), upsertSecret: jest.fn() }));

const { auditTokens } = await import('../src/commands/audit-tokens.js');
const { Command } = await import('commander');

class ExitError extends Error { constructor(readonly code?: number) { super(`__EXIT_${code}__`); } }
const logged: string[] = [];

beforeEach(() => {
  logged.length = 0;
  listSecrets.mockReset();
  getSecretValue.mockReset();
  for (const m of ['log', 'error', 'warn', 'info'] as const) {
    jest.spyOn(console, m).mockImplementation((...a: unknown[]) => { logged.push(a.map(String).join(' ')); });
  }
  // The first exit wins: the command's catch would otherwise turn the thrown
  // ExitError into a second exit(2).
  let first: number | undefined;
  jest.spyOn(process, 'exit').mockImplementation(((c?: number) => {
    if (first === undefined) first = c;
    throw new ExitError(first);
  }) as never);
});

async function exitCodeOf(args: string[] = []): Promise<number | undefined> {
  const program = new Command();
  program.exitOverride();
  auditTokens(program.command('audit'));
  try {
    await program.parseAsync(['node', 'pm', 'audit', 'tokens', '--region', 'us-east-1', ...args]);
  } catch (e) {
    if (e instanceof ExitError) return e.code;
    throw e;
  }
  return undefined;
}

const secret = (name: string) => ({ name: `pipeline-builder/org-1/${name}`, arn: `arn:${name}` });
const KEY = 'pb_sa_0123456789abcdef0123456789abcdef';
const inDays = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString();

describe('audit tokens exit codes', () => {
  it('exits 0 when every stored key is valid past --warn-days', async () => {
    listSecrets.mockResolvedValue({ secrets: [secret('platform')], truncated: false });
    getSecretValue.mockResolvedValue(JSON.stringify({ password: KEY, expiresAt: inDays(30) }));
    expect(await exitCodeOf()).toBe(0);
  });

  it('exits 1 for an expiring key', async () => {
    listSecrets.mockResolvedValue({ secrets: [secret('platform')], truncated: false });
    getSecretValue.mockResolvedValue(JSON.stringify({ password: KEY, expiresAt: inDays(2) }));
    expect(await exitCodeOf()).toBe(1);
  });

  it('exits 2 (scan failure) when a secret cannot be read, instead of reporting all clear', async () => {
    listSecrets.mockResolvedValue({ secrets: [secret('platform')], truncated: false });
    getSecretValue.mockRejectedValue(Object.assign(new Error('not authorized'), { name: 'AccessDeniedException' }));
    expect(await exitCodeOf()).toBe(2);
    expect(logged.join('\n')).toContain('could not be read');
  });

  it('reports the unreadable secrets in --json output', async () => {
    listSecrets.mockResolvedValue({ secrets: [secret('platform')], truncated: false });
    getSecretValue.mockRejectedValue(new Error('throttled'));
    expect(await exitCodeOf(['--json'])).toBe(2);
    const doc = JSON.parse(logged.find((l) => l.trim().startsWith('{'))!);
    expect(doc.unreadable).toEqual([{ secretName: 'pipeline-builder/org-1/platform', error: 'throttled' }]);
  });

  it('exits 1 for a secret that is not JSON or records no expiry (an unusable credential)', async () => {
    listSecrets.mockResolvedValue({ secrets: [secret('platform')], truncated: false });
    getSecretValue.mockResolvedValue('not json');
    expect(await exitCodeOf()).toBe(1);
    expect(logged.join('\n')).toContain('not valid JSON');

    getSecretValue.mockResolvedValue(JSON.stringify({ password: KEY }));
    expect(await exitCodeOf(['--json'])).toBe(1);
    const doc = JSON.parse(logged.filter((l) => l.trim().startsWith('{')).pop()!);
    expect(doc.entries).toEqual([expect.objectContaining({ status: 'unverifiable', reason: expect.stringContaining('no expiresAt') })]);
    expect(doc.entries[0]).not.toHaveProperty('expiresAt');
  });
});
