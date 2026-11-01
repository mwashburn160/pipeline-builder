// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0
/**
 * The case chip's status wording, against the REAL helper.
 *
 * Imported rather than mirrored: the sibling `isUnreadFor` test in this suite
 * keeps its own copy of the function and says it "should fail" if the semantics
 * change — which a copy cannot do. `caseStatusLabel` is exported so this test
 * breaks when the mapping does.
 *
 * The mapping is a judgement call, not a formatting detail. The stored status
 * names who is being waited ON (`awaiting_customer` = we are waiting for the
 * customer), which reads exactly backwards to a tenant looking at their own
 * case: they would see "awaiting customer" and think the ball is with support.
 * So the label is rewritten from the reader's side.
 */

import { describe, it, expect } from '@jest/globals';
import { caseStatusLabel, responseTargetLabel, caseTitle } from '../src/components/message/MessageList';

describe('caseStatusLabel — written from the reader side', () => {
  it('inverts the two awaiting states so the tenant reads who holds the ball', () => {
    expect(caseStatusLabel('awaiting_support')).toBe('waiting on us');
    expect(caseStatusLabel('awaiting_customer')).toBe('waiting on you');
  });

  it('passes the unambiguous states through', () => {
    expect(caseStatusLabel('open')).toBe('open');
    expect(caseStatusLabel('resolved')).toBe('resolved');
    expect(caseStatusLabel('closed')).toBe('closed');
  });

  it('falls back to "open" for an unknown status rather than showing a raw enum', () => {
    // A status added server-side before the UI knows about it must not surface
    // as `awaiting_third_party` in a chip a customer reads. "open" is the safe
    // default: it is true of every non-terminal state.
    expect(caseStatusLabel('awaiting_third_party')).toBe('open');
    expect(caseStatusLabel('')).toBe('open');
  });

  it('never returns a string containing an underscore', () => {
    // The whole point of the mapping: no stored enum should ever reach a user.
    for (const s of ['open', 'awaiting_support', 'awaiting_customer', 'resolved', 'closed', 'something_new']) {
      expect(caseStatusLabel(s)).not.toMatch(/_/);
    }
  });
});

describe('responseTargetLabel — the promise, attached to the case', () => {
  it('names the sold target for each level', () => {
    expect(responseTargetLabel('support_standard')).toBe('2 business days');
    expect(responseTargetLabel('support_priority')).toBe('next business day');
    expect(responseTargetLabel('support_premium')).toBe('8 hours, any day');
  });

  it('returns null for an unknown level rather than another level commitment', () => {
    // A level this build does not know about must not be described with
    // someone else's promise. Null lets the caller omit the phrase instead.
    expect(responseTargetLabel('support_enterprise_bespoke')).toBeNull();
    expect(responseTargetLabel('')).toBeNull();
  });

  it('never states the targets in BUSINESS HOURS, the unit that misled', () => {
    // "48 business hours" reads as two days and means six working days, so the
    // old wording overstated the commitment by about three times. Business DAYS
    // is the unit a customer can check against their own calendar.
    for (const level of ['support_standard', 'support_priority', 'support_premium']) {
      expect(responseTargetLabel(level)).not.toMatch(/business hours?/i);
    }
  });

  it('gives EVERY level a number, premium included', () => {
    // The regression this pins: premium was once the only level with no stated
    // target, so the ladder went blank on the one axis a buyer compares and the
    // top rung read as less of a commitment than the middle one.
    for (const level of ['support_standard', 'support_priority', 'support_premium']) {
      expect(responseTargetLabel(level)).toMatch(/\d|next/);
    }
  });

  it('puts premium alone on a clock that does not stop, without promising an hour', () => {
    // "any day" IS the 24×7 claim, and it is premium's alone. The figure stays
    // at hour-scale-or-worse on purpose: a one-hour severity promise would be
    // sold against a rota with no pager integration to wake it.
    expect(responseTargetLabel('support_premium')).toMatch(/any day/);
    expect(responseTargetLabel('support_standard')).not.toMatch(/any day/);
    expect(responseTargetLabel('support_priority')).not.toMatch(/any day/);
    expect(responseTargetLabel('support_premium')).not.toMatch(/Sev-1|1 hour/i);
  });

  it('improves monotonically, so no step reads as a downgrade', () => {
    // standard → priority → premium: 2 business days, then 1, then 8 hours on a
    // seven-day clock. Each step has to be better on the SAME axis or the price
    // increase has nothing behind it.
    expect(responseTargetLabel('support_standard')).toMatch(/2 business days/);
    expect(responseTargetLabel('support_priority')).toMatch(/next business day/);
    expect(responseTargetLabel('support_premium')).toMatch(/^8 hours/);
  });
});

describe('caseTitle', () => {
  const base = {
    threadId: 't', displayNumber: 1042, severity: 'high',
    openedWithIncident: false, tenantContact: null,
    firstResponseAt: null, createdAt: '2026-01-01T00:00:00.000Z', closedAt: null,
  };

  it('carries the number, the status and the target the case was opened under', () => {
    expect(caseTitle({ ...base, status: 'awaiting_support', level: 'support_premium' })).toBe(
      'Case #1042 — waiting on us. First-response target: 8 hours, any day',
    );
  });

  it('OMITS the target phrase for an unknown level instead of inventing one', () => {
    expect(caseTitle({ ...base, status: 'open', level: 'mystery' })).toBe('Case #1042 — open');
  });

  it('describes a case by the level FROZEN at open, not the plan held now', () => {
    // A downgraded account still sees the commitment its open case was raised
    // under — which is the whole reason `level` is frozen onto the row.
    expect(caseTitle({ ...base, status: 'open', level: 'support_standard' })).toContain('2 business days');
  });
});
