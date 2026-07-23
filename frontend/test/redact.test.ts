// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { redactDetails } from '../src/lib/redact';

describe('redactDetails', () => {
  it('redacts the account id in an ARN string value', () => {
    const out = redactDetails({ arn: 'arn:aws:kms:us-east-1:123456789012:key/abc' });
    expect(out.arn).toBe('arn:aws:kms:us-east-1:[REDACTED]:key/abc');
    expect(out.arn).not.toContain('123456789012');
  });

  it('redacts a bare 12-digit account id bounded by non-digits', () => {
    const out = redactDetails({ note: 'moved to 123456789012 today' });
    expect(out.note).toBe('moved to [REDACTED] today');
  });

  it('leaves longer digit runs untouched (only 12-digit account ids)', () => {
    const out = redactDetails({ id: '1234567890123456' });
    expect(out.id).toBe('1234567890123456');
  });

  it('masks values of sensitive-named keys', () => {
    const out = redactDetails({
      password: 'hunter2',
      token: 'abc.def.ghi',
      secret: 'shh',
      account: 'acme-corp',
      accountId: 'xyz',
    });
    expect(out.password).toBe('[REDACTED]');
    expect(out.token).toBe('[REDACTED]');
    expect(out.secret).toBe('[REDACTED]');
    expect(out.account).toBe('[REDACTED]');
    expect(out.accountId).toBe('[REDACTED]');
  });

  it('recurses into nested objects and arrays', () => {
    const out = redactDetails({
      nested: { apiKey: 'k', deeper: [{ note: 'id 123456789012' }] },
    });
    expect(out.nested.apiKey).toBe('[REDACTED]');
    expect(out.nested.deeper[0].note).toBe('id [REDACTED]');
  });

  it('round-trips a clean details object unchanged', () => {
    const clean = { action: 'org.updated', count: 3, ok: true, tags: ['a', 'b'] };
    expect(redactDetails(clean)).toEqual(clean);
  });

  it('does not mutate the input', () => {
    const input = {
      password: 'hunter2',
      arn: 'arn:aws:iam::123456789012:role/r',
      nested: { token: 't' },
    };
    const snapshot = JSON.parse(JSON.stringify(input));
    redactDetails(input);
    expect(input).toEqual(snapshot);
  });

  it('handles undefined input', () => {
    expect(redactDetails(undefined)).toBeUndefined();
  });
});
