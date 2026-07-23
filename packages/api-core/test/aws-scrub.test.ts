// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from '@jest/globals';

import { scrubAwsIdentifiers, scrubAwsIdentifiersFromString } from '../src/utils/aws-scrub.js';

describe('scrubAwsIdentifiersFromString', () => {
  it('redacts a bare 12-digit AWS account id', () => {
    expect(scrubAwsIdentifiersFromString('acct 123456789012 done')).toBe('acct [REDACTED] done');
  });

  it('redacts the account segment of an ARN', () => {
    expect(scrubAwsIdentifiersFromString('arn:aws:kms:us-east-1:123456789012:key/abc'))
      .toBe('arn:aws:kms:us-east-1:[REDACTED]:key/abc');
  });

  it('leaves shorter/longer digit runs intact (10-digit epoch, 13-digit ms)', () => {
    expect(scrubAwsIdentifiersFromString('t=1720000000 ms=1720000000000')).toBe('t=1720000000 ms=1720000000000');
  });
});

describe('scrubAwsIdentifiers (deep)', () => {
  it('scrubs nested string values and array elements', () => {
    const input = {
      message: 'failed for arn:aws:iam::123456789012:role/deploy',
      nested: { list: ['ok', 'id 210987654321 here'] },
    };
    const out = scrubAwsIdentifiers(input);
    expect(out.message).toBe('failed for arn:aws:iam::[REDACTED]:role/deploy');
    expect(out.nested.list[1]).toBe('id [REDACTED] here');
    // Input is not mutated.
    expect(input.message).toContain('123456789012');
  });

  it('drops account-named keys wholesale (string or number)', () => {
    const out = scrubAwsIdentifiers({ account: '123456789012', accountId: 987654321098, keep: 'x' });
    expect(out.account).toBe('[REDACTED]');
    expect(out.accountId).toBe('[REDACTED]');
    expect(out.keep).toBe('x');
  });

  it('passes non-account numbers and booleans through unchanged', () => {
    const out = scrubAwsIdentifiers({ count: 42, ok: true, ratio: 1720000000000 });
    expect(out).toEqual({ count: 42, ok: true, ratio: 1720000000000 });
  });
});
