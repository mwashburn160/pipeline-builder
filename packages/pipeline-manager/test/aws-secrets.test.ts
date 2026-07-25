// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for listSecrets pagination — specifically the `truncated` signal
 * that lets audit-tokens avoid reporting a clean "all valid" from an INCOMPLETE
 * scan (an expiring token past the paging cap would otherwise be missed).
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';

const mockSend = jest.fn<() => Promise<{ SecretList?: Array<{ Name?: string; ARN?: string }>; NextToken?: string }>>();

jest.unstable_mockModule('@aws-sdk/client-secrets-manager', () => ({
  __esModule: true,
  SecretsManagerClient: class { send = mockSend; },
  ListSecretsCommand: class { constructor(public input: unknown) {} },
  CreateSecretCommand: class { constructor(public input: unknown) {} },
  PutSecretValueCommand: class { constructor(public input: unknown) {} },
  UpdateSecretCommand: class { constructor(public input: unknown) {} },
  DescribeSecretCommand: class { constructor(public input: unknown) {} },
  GetSecretValueCommand: class { constructor(public input: unknown) {} },
}));

const { listSecrets } = await import('../src/utils/aws-secrets.js');

const opts = { region: 'us-east-1' };

describe('listSecrets pagination', () => {
  beforeEach(() => {
    mockSend.mockReset();
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('collects all pages and reports truncated=false when the token runs out', async () => {
    mockSend
      .mockResolvedValueOnce({ SecretList: [{ Name: 'a/platform', ARN: 'arn:a' }], NextToken: 't1' })
      .mockResolvedValueOnce({ SecretList: [{ Name: 'b/platform', ARN: 'arn:b' }] }); // no NextToken → done

    const { secrets, truncated } = await listSecrets('pipeline-builder/', opts, 10);

    expect(secrets.map((s) => s.name)).toEqual(['a/platform', 'b/platform']);
    expect(truncated).toBe(false);
    expect(mockSend).toHaveBeenCalledTimes(2);
  });

  it('reports truncated=true when the maxPages cap is hit with a NextToken still present', async () => {
    // Every page returns a NextToken, so the cap is what stops the sweep.
    mockSend.mockResolvedValue({ SecretList: [{ Name: 'x/platform', ARN: 'arn:x' }], NextToken: 'more' });

    const { secrets, truncated } = await listSecrets('pipeline-builder/', opts, 2);

    expect(truncated).toBe(true);
    expect(secrets).toHaveLength(2); // one per page, capped at 2 pages
    expect(mockSend).toHaveBeenCalledTimes(2);
  });

  it('skips entries missing Name or ARN', async () => {
    mockSend.mockResolvedValueOnce({ SecretList: [{ Name: 'ok/platform', ARN: 'arn:ok' }, { Name: 'no-arn' }, { ARN: 'no-name' }] });

    const { secrets } = await listSecrets('pipeline-builder/', opts, 10);
    expect(secrets.map((s) => s.name)).toEqual(['ok/platform']);
  });
});
