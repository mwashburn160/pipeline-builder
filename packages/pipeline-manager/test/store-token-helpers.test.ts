// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `infra store-token` helpers: the stored secret's shape, the retire-after-store
 * rule for the replaced key, and the dry-run / result output.
 */

import { jest, describe, it, expect, afterEach } from '@jest/globals';
import type { AnyFn } from '@pipeline-builder/api-core/testing';

const revokeSiblingKey = jest.fn<AnyFn>();
jest.unstable_mockModule('../src/utils/service-account.js', () => ({
  provisionServiceAccountKey: jest.fn<AnyFn>(),
  adoptServiceAccountKey: jest.fn<AnyFn>(),
  passwordStepUp: jest.fn<AnyFn>(),
  totpStepUp: jest.fn<AnyFn>(),
  browserStepUp: jest.fn<AnyFn>(),
  revokeSiblingKey,
}));

const { buildSecretValue, chooseStepUp, printDryRunPlan, printStoredKey, readKeyInput, renewNameSuffix, retirePreviousKey } = await import('../src/commands/store-token.js');

const provisioned = {
  key: 'pb_sa_new',
  keyId: 'key-2',
  serviceAccountId: 'sa-1',
  serviceAccountName: 'automation',
  organizationId: 'org-1',
  expiresAt: '2026-10-22T00:00:00.000Z',
  scope: null,
};
const client = {} as Parameters<typeof retirePreviousKey>[0];

afterEach(() => {
  jest.restoreAllMocks();
  revokeSiblingKey.mockReset();
});

describe('renewNameSuffix', () => {
  it('names every secret\'s rotation stack after its trailing path segment, plus a hash of the whole name', () => {
    expect(renewNameSuffix('pipeline-builder/acme/platform')).toMatch(/^-platform-[0-9a-f]{8}$/);
    expect(renewNameSuffix('pipeline-builder/acme/reporting-ingest')).toMatch(/^-reporting-ingest-[0-9a-f]{8}$/);
    expect(renewNameSuffix('pipeline-builder/acme/registry_push')).toMatch(/^-registry-push-[0-9a-f]{8}$/);
    expect(renewNameSuffix('pipeline-builder/acme/platform')).toBe(renewNameSuffix('pipeline-builder/acme/platform'));
  });

  // Regression: the suffix was the leaf alone, and every org's platform secret
  // ends in `/platform` — two orgs rotated from one AWS account shared one
  // stack, role and Lambda, the second deploy re-pointing the first org's
  // rotation at its own secret (the first org's key then expired unrotated).
  it('keeps two orgs\' same-leaf secrets on separate stacks', () => {
    expect(renewNameSuffix('pipeline-builder/org-a/platform')).not.toBe(renewNameSuffix('pipeline-builder/org-b/platform'));
  });

  // The suffix lands in IAM role, Lambda function and EventBridge rule names (64 characters each).
  it('fits the 64-character resource-name limit for a long leaf', () => {
    const suffix = renewNameSuffix(`pipeline-builder/acme/${'x'.repeat(80)}`);
    expect(`pipeline-builder-token-renew${suffix}`.length).toBeLessThanOrEqual(64);
    expect(suffix).toMatch(/^-x+-[0-9a-f]{8}$/);
  });
});

describe('buildSecretValue', () => {
  it('stores the key as the Basic-auth password with the org as username, plus rotation metadata', () => {
    const value = JSON.parse(buildSecretValue(provisioned, 'https://pb.example.com', 3600));
    expect(value).toMatchObject({
      username: 'org-1',
      password: 'pb_sa_new',
      platformUrl: 'https://pb.example.com',
      serviceAccountId: 'sa-1',
      keyId: 'key-2',
      expiresIn: 3600,
    });
    expect(typeof value.createdAt).toBe('string');
  });
});

describe('retirePreviousKey', () => {
  it('revokes the replaced key on the same account WITH THE NEW KEY — no password / step-up involved', async () => {
    // It used to take the operator's password for a step-up, so a run by an
    // account with no password could never retire what it replaced.
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    await retirePreviousKey(client, provisioned, { keyId: 'key-1', serviceAccountId: 'sa-1' });
    expect(revokeSiblingKey).toHaveBeenCalledWith(client, 'pb_sa_new', 'key-1');
  });

  it('never revokes the key it just stored (a secret already naming it)', async () => {
    await retirePreviousKey(client, provisioned, { keyId: 'key-2', serviceAccountId: 'sa-1' });
    expect(revokeSiblingKey).not.toHaveBeenCalled();
  });

  it('leaves keys on another account (or none at all) alone', async () => {
    await retirePreviousKey(client, provisioned, { keyId: 'key-1', serviceAccountId: 'sa-other' });
    await retirePreviousKey(client, provisioned, {});
    expect(revokeSiblingKey).not.toHaveBeenCalled();
  });

  it('only warns when the revoke fails — the new key is already stored', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    revokeSiblingKey.mockRejectedValueOnce(new Error('boom'));
    await expect(retirePreviousKey(client, provisioned, { keyId: 'key-1', serviceAccountId: 'sa-1' })).resolves.toBeUndefined();
    expect(warn.mock.calls.flat().join(' ')).toContain('could not revoke the previous one (key-1)');
  });
});

describe('readKeyInput (--from-key)', () => {
  it('reads stdin for "-" and a file otherwise, trimmed', () => {
    const read = jest.fn((p: string | number) => (p === 0 ? 'pb_sa_fromstdin\n' : '  pb_sa_fromfile  '));
    expect(readKeyInput('-', read)).toBe('pb_sa_fromstdin');
    expect(read).toHaveBeenCalledWith(0);
    expect(readKeyInput('/tmp/k', read)).toBe('pb_sa_fromfile');
  });
  it('refuses empty input and anything that is not exactly one token', () => {
    expect(() => readKeyInput('-', () => '  \n')).toThrow(/empty/);
    expect(() => readKeyInput('-', () => 'pb_sa_a pb_sa_b')).toThrow(/exactly one key/);
  });
});

describe('store-token output', () => {
  const plan = {
    serviceAccount: 'automation',
    roles: 'Pipeline Automation',
    scope: '(none — the account\'s Role is its authority)',
    secretName: 'pipeline-builder/<orgId>/platform',
    region: 'us-east-1',
    expiresInDays: 30,
  };

  it('prints the dry-run plan as JSON', () => {
    const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    printDryRunPlan(plan, true);
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toEqual({ success: true, dryRun: true, ...plan });
  });

  it('prints the dry-run plan for a person', () => {
    const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    printDryRunPlan(plan, false);
    expect(log.mock.calls.flat().join('\n')).toContain('automation');
  });

  it('prints the stored key as JSON, with the schedule', () => {
    const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    printStoredKey({
      json: true,
      secretName: 's',
      arn: 'arn:secret:s',
      region: 'us-east-1',
      accountName: 'automation',
      provisioned,
      days: 30,
      scheduleExpression: 'cron(0 0 * * ? *)',
    });
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({ success: true, keyId: 'key-2', schedule: 'cron(0 0 * * ? *)' });
  });

  it('prints the stored key for a person, with the manual-rotation hint when unscheduled', () => {
    const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    printStoredKey({
      json: false,
      secretName: 's',
      arn: undefined,
      region: 'us-east-1',
      accountName: 'automation',
      provisioned,
      days: 30,
      scheduleExpression: undefined,
    });
    expect(log.mock.calls.flat().join('\n')).toContain('store-token --expires-days 30');
  });
});

describe('chooseStepUp', () => {
  it('auto: the password when given (CI / provision keep working unchanged)', () => {
    expect(chooseStepUp({ password: 'pw', interactive: false })).toBe('password');
  });
  it('auto: no password in a terminal → browser approval, which works for passwordless accounts', () => {
    expect(chooseStepUp({ interactive: true })).toBe('browser');
  });
  it('no password and no terminal: fails up front, naming PLATFORM_PASSWORD and --from-key', () => {
    expect(() => chooseStepUp({ interactive: false })).toThrow(/PLATFORM_PASSWORD.*--from-key/s);
  });
  it('honours an explicit totp / browser choice, even with a password set', () => {
    expect(chooseStepUp({ requested: 'totp', password: 'pw', interactive: true })).toBe('totp');
    expect(chooseStepUp({ requested: 'browser', password: 'pw', interactive: true })).toBe('browser');
  });
  it('explicit password without one, and unknown methods, are refused', () => {
    expect(() => chooseStepUp({ requested: 'password', interactive: true })).toThrow(/needs the password/);
    expect(() => chooseStepUp({ requested: 'sms', interactive: true })).toThrow(/Unknown --step-up/);
  });
});
