// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `infra store-token` helpers: the stored secret's shape, the retire-after-store
 * rule for the replaced key, and the dry-run / result output.
 */

import { jest, describe, it, expect, afterEach } from '@jest/globals';
import type { AnyFn } from '@pipeline-builder/api-core/testing';

const revokeServiceAccountKey = jest.fn<AnyFn>();
jest.unstable_mockModule('../src/utils/service-account.js', () => ({
  provisionServiceAccountKey: jest.fn<AnyFn>(),
  revokeServiceAccountKey,
}));

const { buildSecretValue, printDryRunPlan, printStoredKey, retirePreviousKey } = await import('../src/commands/store-token.js');

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
  revokeServiceAccountKey.mockReset();
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
  it('revokes the replaced key on the same account', async () => {
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    await retirePreviousKey(client, 'pw', provisioned, { keyId: 'key-1', serviceAccountId: 'sa-1' });
    expect(revokeServiceAccountKey).toHaveBeenCalledWith(client, 'pw', 'org-1', 'sa-1', 'key-1');
  });

  it('leaves keys on another account (or none at all) alone', async () => {
    await retirePreviousKey(client, 'pw', provisioned, { keyId: 'key-1', serviceAccountId: 'sa-other' });
    await retirePreviousKey(client, 'pw', provisioned, {});
    expect(revokeServiceAccountKey).not.toHaveBeenCalled();
  });

  it('only warns when the revoke fails — the new key is already stored', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    revokeServiceAccountKey.mockRejectedValueOnce(new Error('boom'));
    await expect(retirePreviousKey(client, 'pw', provisioned, { keyId: 'key-1', serviceAccountId: 'sa-1' })).resolves.toBeUndefined();
    expect(warn.mock.calls.flat().join(' ')).toContain('could not revoke the previous one (key-1)');
  });
});

describe('store-token output', () => {
  const plan = {
    serviceAccount: 'automation',
    roles: 'org admin',
    scope: '(none — full platform credential)',
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
    expect(log.mock.calls.flat().join('\n')).toContain('store-token --days 30');
  });
});
