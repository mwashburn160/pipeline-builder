// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for `logAuditEvent` — the cross-service audit-log boundary.
 *
 * This helper had NO test, despite being the point where every non-platform
 * service writes its audit trail to the durable log store. Three properties
 * matter, and all three are security properties rather than conveniences:
 *
 *  1. The line is tagged `eventCategory: 'audit'` so Loki/CloudWatch can route
 *     it into the audit index. An event that loses the tag silently vanishes
 *     from the audit trail while the mutation still succeeds.
 *  2. AWS ACCOUNT IDS ARE SCRUBBED before the event reaches the durable store.
 *     This is the persistence boundary the "never persist an AWS account id"
 *     rule targets, and the logger's own secret redaction does NOT cover them.
 *  3. It is BEST-EFFORT: a transport that throws must never propagate, because
 *     an audit-write failure must not roll back the caller's mutation.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import type winston from 'winston';
import type { AuditEvent } from '../src/types/audit-events.js';
import { logAuditEvent } from '../src/utils/audit.js';

/** Minimal winston double: `info` + `warn` are the only methods logAuditEvent uses. */
function makeLogger() {
  return {
    info: jest.fn(),
    warn: jest.fn(),
  } as unknown as winston.Logger & { info: jest.Mock; warn: jest.Mock };
}

const copyEvent = (over: Partial<AuditEvent> = {}): AuditEvent => ({
  event: 'registry.tag.copy',
  actor: 'user@example.com',
  source: 'app:1.0.0',
  target: 'app:1.0.1',
  ...over,
} as AuditEvent);

let logger: ReturnType<typeof makeLogger>;

beforeEach(() => {
  logger = makeLogger();
});

describe('logAuditEvent', () => {
  it('writes a single structured line tagged as an audit event', () => {
    logAuditEvent(logger, copyEvent());

    expect(logger.info).toHaveBeenCalledTimes(1);
    const [message, payload] = logger.info.mock.calls[0] as [string, Record<string, unknown>];
    expect(message).toBe('audit');
    expect(payload.eventCategory).toBe('audit');
    expect(payload.event).toBe('registry.tag.copy');
    expect(payload.actor).toBe('user@example.com');
  });

  it('carries the correlation ids through, so a line can be pivoted to its request/trace', () => {
    logAuditEvent(logger, copyEvent({ requestId: 'req-42', traceId: 'abc123' }));

    const [, payload] = logger.info.mock.calls[0] as [string, Record<string, unknown>];
    expect(payload.requestId).toBe('req-42');
    expect(payload.traceId).toBe('abc123');
  });

  it('lets a caller-supplied eventCategory WIN over the audit tag (documented gap)', () => {
    // `logAuditEvent` builds `{ eventCategory: 'audit', ...audit }` — the spread
    // comes LAST, so an event carrying its own `eventCategory` overwrites the
    // tag and routes itself out of the audit index. Today only the typed
    // `AuditEvent` union reaches this function, and none of its members declare
    // `eventCategory`, so TypeScript blocks it at every real call site; this is
    // latent, not exploitable. Pinned deliberately so that if the union ever
    // gains a passthrough/`details`-style member, this test fails and forces the
    // decision rather than letting an audit line silently relabel itself.
    // The hardening fix, if it is ever wanted, is to spread `...audit` FIRST.
    logAuditEvent(logger, copyEvent({ eventCategory: 'not-audit' } as Partial<AuditEvent>));

    const [, payload] = logger.info.mock.calls[0] as [string, Record<string, unknown>];
    expect(payload.eventCategory).toBe('not-audit');
  });

  describe('AWS account-id scrubbing (the persistence boundary)', () => {
    it('redacts a bare 12-digit account id anywhere in the event', () => {
      logAuditEvent(logger, copyEvent({ source: 'arn:aws:ecr:us-east-1:123456789012:repository/app' }));

      const [, payload] = logger.info.mock.calls[0] as [string, Record<string, unknown>];
      expect(payload.source).toBe('arn:aws:ecr:us-east-1:[REDACTED]:repository/app');
      expect(JSON.stringify(payload)).not.toContain('123456789012');
    });

    it('redacts an account-NAMED key wholesale, even when the value is a number', () => {
      logAuditEvent(logger, copyEvent({ accountId: 123456789012 } as Partial<AuditEvent>));

      const [, payload] = logger.info.mock.calls[0] as [string, Record<string, unknown>];
      expect(payload.accountId).toBe('[REDACTED]');
    });

    it('scrubs nested details rather than only top-level fields', () => {
      logAuditEvent(logger, copyEvent({
        details: { failure: 'role arn:aws:iam::210987654321:role/build denied' },
      } as Partial<AuditEvent>));

      const [, payload] = logger.info.mock.calls[0] as [string, Record<string, unknown>];
      expect(JSON.stringify(payload)).not.toContain('210987654321');
      expect((payload.details as Record<string, string>).failure).toContain('[REDACTED]');
    });

    it('leaves a 13-digit millisecond timestamp intact (no clipping inside longer numbers)', () => {
      logAuditEvent(logger, copyEvent({ details: { at: '1717171717171' } } as Partial<AuditEvent>));

      const [, payload] = logger.info.mock.calls[0] as [string, Record<string, unknown>];
      expect((payload.details as Record<string, string>).at).toBe('1717171717171');
    });

    it('does not mutate the caller\'s event object', () => {
      const event = copyEvent({ source: 'arn:aws:ecr:us-east-1:123456789012:repository/app' });
      logAuditEvent(logger, event);

      expect((event as { source: string }).source).toBe('arn:aws:ecr:us-east-1:123456789012:repository/app');
    });
  });

  describe('best-effort delivery (an audit failure must not fail the mutation)', () => {
    it('swallows a throwing transport and falls back to a warn', () => {
      logger.info.mockImplementation(() => { throw new Error('transport exploded'); });

      expect(() => logAuditEvent(logger, copyEvent())).not.toThrow();

      expect(logger.warn).toHaveBeenCalledTimes(1);
      const [message, meta] = logger.warn.mock.calls[0] as [string, Record<string, unknown>];
      expect(message).toBe('Failed to emit audit event');
      // The fallback names the event that was lost, so the gap is greppable.
      expect(meta.event).toBe('registry.tag.copy');
      expect(meta.error).toBe('transport exploded');
    });

    it('stringifies a non-Error throw rather than losing the reason', () => {
      logger.info.mockImplementation(() => { throw 'stringly typed'; });

      logAuditEvent(logger, copyEvent());

      const [, meta] = logger.warn.mock.calls[0] as [string, Record<string, unknown>];
      expect(meta.error).toBe('stringly typed');
    });

    it('gives up silently when the fallback warn ALSO throws', () => {
      logger.info.mockImplementation(() => { throw new Error('primary down'); });
      logger.warn.mockImplementation(() => { throw new Error('logger unrecoverable'); });

      // The caller's mutation must still succeed — this is the whole point.
      expect(() => logAuditEvent(logger, copyEvent())).not.toThrow();
    });
  });
});
