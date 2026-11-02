// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The ambient audit context: inbound correlation headers are validated and
 * length-capped (a junk value is dropped, never truncated into a different id),
 * AWS account ids never survive, and the principal is read lazily so a scope
 * opened before `requireAuth` still sees the verified token.
 */

import { describe, it, expect } from '@jest/globals';
import type { Request } from 'express';
import { SYSTEM_ORG_ID } from '../src/middleware/system-org.js';
import { auditAuthBlock, auditContextFromRequest, currentAuditContext, runWithAuditContext, sanitizeCorrelationId } from '../src/services/audit-context.js';

describe('sanitizeCorrelationId', () => {
  it('keeps bounded opaque ids', () => {
    expect(sanitizeCorrelationId('0192f1c4-7a3b-7c2d-8e9f-0a1b2c3d4e5f')).toBe('0192f1c4-7a3b-7c2d-8e9f-0a1b2c3d4e5f');
    expect(sanitizeCorrelationId('my-project:6a1b2c3d-0000-4000-8000-000000000000')).toBe('my-project:6a1b2c3d-0000-4000-8000-000000000000');
  });

  it('drops oversized, empty, and non-token values', () => {
    expect(sanitizeCorrelationId('x'.repeat(129))).toBeUndefined();
    expect(sanitizeCorrelationId('   ')).toBeUndefined();
    expect(sanitizeCorrelationId('a b')).toBeUndefined();
    expect(sanitizeCorrelationId('<script>')).toBeUndefined();
    expect(sanitizeCorrelationId(42)).toBeUndefined();
  });

  it('never keeps an AWS account id (a CodeBuild build ARN carries one)', () => {
    const out = sanitizeCorrelationId('arn:aws:codebuild:us-east-1:123456789012:build/proj:abc');
    expect(out).toBeDefined();
    expect(out).toBe('arn:aws:codebuild:us-east-1::build/proj:abc');
    expect(sanitizeCorrelationId('123456789012')).toBeUndefined();
  });

  it('does not mangle a uuid whose last group happens to be all digits', () => {
    expect(sanitizeCorrelationId('6a1b2c3d-0000-4000-8000-000000000000')).toBe('6a1b2c3d-0000-4000-8000-000000000000');
  });
});

describe('auditContextFromRequest', () => {
  it('records validated correlation headers and reads the principal lazily', () => {
    const req = {
      ip: '10.0.0.1',
      headers: {
        'user-agent': 'pb-cli/2.0',
        'x-pipeline-execution-id': 'exec-1',
        'x-codebuild-build-id': 'proj:build-1',
        'x-source-event-id': 'bad value with spaces',
      },
    } as unknown as Request;
    const ctx = auditContextFromRequest(req, { requestId: 'req-1', traceId: 'abc' });
    expect(ctx).toMatchObject({
      requestId: 'req-1',
      traceId: 'abc',
      ip: '10.0.0.1',
      userAgent: 'pb-cli/2.0',
      correlation: { pipelineExecutionId: 'exec-1', codebuildBuildId: 'proj:build-1' },
    });
    expect(ctx.correlation).not.toHaveProperty('sourceEventId');
    // Auth runs AFTER the scope opens: the getter sees the later `req.user`.
    expect(ctx.principal?.()).toBeUndefined();
    (req as { user?: unknown }).user = { sub: 'u1' };
    expect(ctx.principal?.()).toEqual({ sub: 'u1' });
  });
});

describe('runWithAuditContext', () => {
  it('scopes the context to the callback, merging nested scopes', () => {
    expect(currentAuditContext()).toBeUndefined();
    runWithAuditContext({ requestId: 'outer', job: { jobId: 'a' } }, () => {
      runWithAuditContext({ job: { runId: 'r' } }, () => {
        expect(currentAuditContext()).toMatchObject({ requestId: 'outer', job: { jobId: 'a', runId: 'r' } });
      });
      expect(currentAuditContext()?.job).toEqual({ jobId: 'a' });
    });
    expect(currentAuditContext()).toBeUndefined();
  });
});

describe('auditAuthBlock', () => {
  it('prefers the parent access key over the token jti, and omits absent fields', () => {
    expect(auditAuthBlock({ principalType: 'user', token_use: 'access', jti: 'own', parentKeyId: 'key-1' } as never))
      .toEqual({ principalType: 'user', tokenUse: 'access', keyId: 'key-1' });
  });

  it('marks a system-org human principal, but not a system-org service token', () => {
    expect(auditAuthBlock({ principalType: 'user', organizationId: SYSTEM_ORG_ID } as never)?.systemOrg).toBe(true);
    expect(auditAuthBlock({ principalType: 'service', sub: 'service:plugin', organizationId: SYSTEM_ORG_ID } as never))
      .toEqual({ principalType: 'service', service: 'plugin' });
  });

  it('is undefined without a principal', () => {
    expect(auditAuthBlock(undefined)).toBeUndefined();
  });
});
