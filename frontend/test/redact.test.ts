// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { redactDetails, redactString } from '../src/lib/redact';

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

describe('redactString', () => {
  it('redacts the account segment of an ARN', () => {
    expect(redactString('arn:aws:kms:us-east-1:123456789012:key/abc'))
      .toBe('arn:aws:kms:us-east-1:[REDACTED]:key/abc');
  });

  it('redacts a bare 12-digit account id', () => {
    expect(redactString('123456789012')).toBe('[REDACTED]');
  });

  it('leaves shorter/longer digit runs untouched', () => {
    expect(redactString('1234567890')).toBe('1234567890');
    expect(redactString('1234567890123456')).toBe('1234567890123456');
  });

  it('redacts every occurrence in a string', () => {
    expect(redactString('a 123456789012 b 210987654321 c'))
      .toBe('a [REDACTED] b [REDACTED] c');
  });
});

/**
 * Per-surface assertions: each display surface fixed in this change feeds an
 * account-id-bearing value through `redactString`/`redactDetails`. These lock
 * the helper output at the exact shape each surface renders so a 12-digit
 * account id (incl. the account segment of an ARN) can never reach the DOM.
 */
describe('display-surface redaction', () => {
  it('KMS keyId ARN (orgs detail) is scrubbed before display/copy', () => {
    const keyId = 'arn:aws:kms:us-east-1:123456789012:key/1234-abcd';
    expect(redactString(keyId)).not.toContain('123456789012');
  });

  it('observability log raw line + parsed field are scrubbed', () => {
    const line = 'pulled image 123456789012.dkr.ecr.us-east-1.amazonaws.com/app:latest';
    expect(redactString(line)).toBe(
      'pulled image [REDACTED].dkr.ecr.us-east-1.amazonaws.com/app:latest',
    );
    // A nested-object field value goes through redactDetails.
    const field = redactDetails({ role: 'arn:aws:iam::123456789012:role/r' });
    expect(field.role).toBe('arn:aws:iam::[REDACTED]:role/r');
  });

  it('logs page message is scrubbed', () => {
    expect(redactString('assumed 123456789012')).toBe('assumed [REDACTED]');
  });

  it('registry manifest Env / history entries are scrubbed', () => {
    const env = 'ECR_REGISTRY=123456789012.dkr.ecr.us-east-1.amazonaws.com';
    expect(redactString(env)).not.toContain('123456789012');
    const createdBy = '/bin/sh -c #(nop) ARG ACCOUNT=123456789012';
    expect(redactString(createdBy)).toBe('/bin/sh -c #(nop) ARG ACCOUNT=[REDACTED]');
  });

  it('JWT claim values are scrubbed while keys are preserved', () => {
    // String claim value.
    expect(redactString('arn:aws:sts::123456789012:assumed-role/x'))
      .toBe('arn:aws:sts::[REDACTED]:assumed-role/x');
    // Object claim value via redactDetails.
    const claim = redactDetails({ scope: 'acct:123456789012' });
    expect(claim.scope).toBe('acct:[REDACTED]');
  });
});
