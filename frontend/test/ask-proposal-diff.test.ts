// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The safety properties of an EDIT proposal's review, as pure functions:
 *
 *  - only fields that ACTUALLY changed become rows (an unchanged field must
 *    never read as an edit);
 *  - a field that differs but was not declared in `changedFields` is refused,
 *    not rendered and not sent — that is the injection signal;
 *  - a secret-shaped field is reduced to set / not set and dropped from the
 *    payload (an API answering `hasWebhookSecret` cannot be diffed);
 *  - the payload is a projection of the rendered rows, so the reviewed diff IS
 *    the commit payload;
 *  - staleness is measured on the reviewed fields against a fresh read.
 */

import { describe, it, expect, jest } from '@jest/globals';
import {
  commitPayload, computeProposalDiff, describeValue, redactionFor, sameValue, staleFields,
} from '../src/components/ask/proposal-diff';

import { ASK_AGENT_PROVENANCE_NOTE, orgSettingsReview, proposalDiff, proposalReady, requiredPermissions } from '../src/components/ask/proposal';

// `proposal.ts` reaches the org-settings surface table, which imports the API
// client; nothing here calls it, so an empty client is enough.
jest.mock('@/lib/api', () => ({ __esModule: true, default: {} }));

describe('computeProposalDiff', () => {
  it('renders only the fields that actually changed', () => {
    const diff = computeProposalDiff(
      { pipelineName: 'web-ci', description: 'builds the web app', isActive: true },
      { pipelineName: 'web-ci-v2', description: 'builds the web app', isActive: true },
      ['pipelineName', 'description', 'isActive'],
    );

    expect(diff.rows.map((r) => r.field)).toEqual(['pipelineName']);
    expect(diff.rows[0]).toMatchObject({ from: 'web-ci', to: 'web-ci-v2' });
    // Declared but identical: dropped, so an unchanged field never reads as an edit.
    expect(diff.unchanged).toEqual(['description', 'isActive']);
    expect(diff.refused).toEqual([]);
  });

  it('refuses a field that differs but was never declared — it is not a row and not in the payload', () => {
    const diff = computeProposalDiff(
      { pipelineName: 'web-ci', visibility: 'private' },
      { pipelineName: 'web-ci-v2', visibility: 'public' },
      ['pipelineName'],
    );

    expect(diff.rows.map((r) => r.field)).toEqual(['pipelineName']);
    expect(diff.refused).toEqual(['visibility']);
    expect(commitPayload({ pipelineName: 'web-ci-v2', visibility: 'public' }, diff.rows))
      .toEqual({ pipelineName: 'web-ci-v2' });
  });

  it('ignores key ORDER inside an object value', () => {
    const diff = computeProposalDiff(
      { props: { b: 2, a: 1 } },
      { props: { a: 1, b: 2 } },
      ['props'],
    );
    expect(diff.rows).toEqual([]);
    expect(diff.unchanged).toEqual(['props']);
  });

  it('renders a long / multi-line value as a block so it can be read as a diff', () => {
    const diff = computeProposalDiff(
      { dockerfile: 'FROM alpine:3.20\nRUN apk add git' },
      { dockerfile: 'FROM alpine:3.21\nRUN apk add git' },
      ['dockerfile'],
    );
    expect(diff.rows[0].block).toBe(true);
  });
});

describe('secrets are never rendered (rule 4)', () => {
  it.each([
    ['webhookSecret', 'secret'],
    ['hasWebhookSecret', 'secret'],
    ['apiKey', 'secret'],
    ['signingKey', 'secret'],
    ['registryPassword', 'secret'],
    ['externalEmail', 'address'],
    ['webhookUrl', 'address'],
  ])('%s is presence-only', (field, kind) => {
    expect(redactionFor(field)).toBe(kind);
  });

  it('judges a field by what it is NAMED AFTER, not by a substring', () => {
    // `emailEnabled` is a boolean that mentions email; redacting it would make a
    // legitimate toggle unappliable. `externalEmail` IS the address.
    expect(redactionFor('emailEnabled')).toBeNull();
    expect(redactionFor('externalEmail')).toBe('address');
    expect(redactionFor('digestMode')).toBeNull();
    expect(redactionFor('notifyRescan')).toBeNull();
    expect(redactionFor('recipientMode')).toBeNull();
    expect(redactionFor('pipelineName')).toBeNull();
    expect(describeValue('daily', null)).toBe('daily');
  });

  it('never renders a secret VALUE, and never commits it', () => {
    const diff = computeProposalDiff(
      { hasWebhookSecret: false, digestMode: 'immediate' },
      { webhookSecret: 'hunter2-please-no', digestMode: 'daily' },
      ['webhookSecret', 'digestMode'],
    );

    const secretRow = diff.rows.find((r) => r.field === 'webhookSecret');
    expect(secretRow).toMatchObject({ redaction: 'secret', from: 'not set', to: 'set' });
    // The literal is nowhere in the rendered strings.
    expect(JSON.stringify(diff.rows)).not.toContain('hunter2');
    // …and it cannot be applied from here: excluded from the payload and counted.
    expect(diff.refused).toContain('webhookSecret');
    expect(commitPayload({ webhookSecret: 'hunter2-please-no', digestMode: 'daily' }, diff.rows))
      .toEqual({ digestMode: 'daily' });
  });
});

describe('staleFields (rule 7)', () => {
  const rows = computeProposalDiff({ pipelineName: 'a' }, { pipelineName: 'b' }, ['pipelineName']).rows;

  it('refuses when a REVIEWED field moved since the draft was rendered', () => {
    expect(staleFields({ pipelineName: 'a' }, { pipelineName: 'someone-else-renamed-it' }, rows))
      .toEqual(['pipelineName']);
  });

  it('does not fire for an unrelated column moving (updatedAt churn)', () => {
    expect(staleFields({ pipelineName: 'a' }, { pipelineName: 'a', updatedAt: 'later' }, rows)).toEqual([]);
  });

  it('treats a vanished field as a move', () => {
    expect(staleFields({ pipelineName: 'a' }, {}, rows)).toEqual(['pipelineName']);
  });

  it('compares by value, not identity', () => {
    expect(sameValue({ a: [1, 2] }, { a: [1, 2] })).toBe(true);
    expect(sameValue({ a: [1, 2] }, { a: [2, 1] })).toBe(false);
  });
});

describe('proposalDiff provenance (rule 6)', () => {
  it('folds the agent marker into the note a change request files, BEFORE the diff is rendered', () => {
    const diff = proposalDiff({
      kind: 'install-change-request',
      id: 'i1',
      current: { version: '1.0.0' },
      proposed: { version: '1.4.2' },
      changedFields: ['version'],
      note: 'clears CVE-2026-1',
    });

    const note = diff.rows.find((r) => r.field === 'note');
    expect(note?.to).toContain('clears CVE-2026-1');
    expect(note?.to).toContain(ASK_AGENT_PROVENANCE_NOTE);
    // Reviewed == filed: the sentence the approver reads is a row the requester saw.
    expect(commitPayload({ version: '1.4.2', note: note?.to }, diff.rows).note).toBe(note?.to);
  });

  it('stamps the exemption reason the admin reviews', () => {
    const diff = proposalDiff({
      kind: 'compliance-exemption-request',
      request: { ruleId: 'r1', entityType: 'plugin', entityId: 'p1', reason: 'vendor image, fix pending' },
    });
    const reason = diff.rows.find((r) => r.field === 'reason');
    expect(reason?.to).toContain('vendor image, fix pending');
    expect(reason?.to).toContain('ask-agent');
  });
});

describe('proposalReady', () => {
  it('is false when every proposed field was refused — there is nothing to apply', () => {
    expect(proposalReady({
      kind: 'plugin-edit',
      id: 'pl1',
      current: { description: 'x' },
      proposed: { visibility: 'public' }, // not declared → refused
      changedFields: [],
    })).toBe(false);
  });

  it('is false for a setting the shared allowlist does not carry', () => {
    // A security control the agent has no row for: absent, not gated.
    expect(proposalReady({
      kind: 'org-settings-edit',
      id: 'o1',
      current: {},
      proposed: { 'organization.mfaPolicy': 'optional' },
    })).toBe(false);
  });

  it('is true for an allowlisted setting with a real change', () => {
    expect(proposalReady({
      kind: 'org-settings-edit',
      id: 'o1',
      current: { 'pluginSecurityNotifications.notifyRescan': true },
      proposed: { 'pluginSecurityNotifications.notifyRescan': false },
    })).toBe(true);
  });

  it('is false when the proposed value already matches — a no-op is not an edit', () => {
    expect(proposalReady({
      kind: 'org-settings-edit',
      id: 'o1',
      current: { 'pluginSecurityNotifications.notifyRescan': true },
      proposed: { 'pluginSecurityNotifications.notifyRescan': true },
    })).toBe(false);
  });
});

describe('orgSettingsReview (the shared allowlist decides)', () => {
  it('drops a value that does not match the declared shape, separately from a refusal', () => {
    const review = orgSettingsReview({
      kind: 'org-settings-edit',
      id: 'o1',
      current: { 'reporting.incidentWindowHours': 24 },
      proposed: {
        'reporting.incidentWindowHours': 5000, // outside the declared 1..720
        'organization.transferOwner': 'someone-else', // not on the allowlist at all
      },
    });
    expect(review.changes).toHaveLength(0);
    expect(review.invalid).toEqual(['reporting.incidentWindowHours']);
    expect(review.refused).toEqual(['organization.transferOwner']);
  });

  it('labels each row from the shared spec rather than from the wire', () => {
    const rows = proposalDiff({
      kind: 'org-settings-edit',
      id: 'o1',
      current: { 'complianceNotifications.digestMode': 'immediate' },
      proposed: { 'complianceNotifications.digestMode': 'weekly' },
    }).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ field: 'complianceNotifications.digestMode', label: 'Compliance notice cadence', from: 'immediate', to: 'weekly' });
  });
});

describe('requiredPermissions', () => {
  it('asks for EVERY surface an org-settings change touches', () => {
    const perms = requiredPermissions({
      kind: 'org-settings-edit',
      id: 'o1',
      current: { 'pluginSecurityNotifications.notifyRescan': true, 'complianceNotifications.emailEnabled': false },
      proposed: { 'pluginSecurityNotifications.notifyRescan': false, 'complianceNotifications.emailEnabled': true },
    });
    expect(perms.sort()).toEqual(['compliance:write', 'org:settings']);
  });

  it('adds a wire-supplied permission to the static floor rather than replacing it', () => {
    // A tampered stream can only make the gate stricter, never weaker.
    expect(requiredPermissions({
      kind: 'pipeline-edit',
      id: 'p1',
      commit: { path: '/pipelines/:id', permission: 'pipelines:read' },
    }).sort()).toEqual(['pipelines:read', 'pipelines:write']);
  });
});
