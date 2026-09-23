// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The allowlist is a security boundary, so these tests assert what must be
 * ABSENT as hard as what must be present: a step-up-gated field, a security
 * control and a secret-bearing field each have a named test, and the refused
 * set is asserted because rule 10 makes it the injection signal.
 */

import { describe, it, expect } from '@jest/globals';

import {
  ASK_AGENT_PROPOSER,
  ORG_SETTING_PROPOSAL_ALLOWLIST,
  ORG_SETTING_PROPOSAL_EXCLUSIONS,
  ORG_SETTING_PROPOSAL_KEYS,
  PROPOSED_BY_DETAIL_KEY,
  askProposalAuditDetails,
  diffOrgSettings,
  isProposableOrgSetting,
  isValidOrgSettingValue,
  orgSettingRequests,
  orgSettingSpec,
  pickAllowed,
  type OrgSettingKey,
} from '../src/types/ask-proposals.js';
import { PLUGIN_SECURITY_DIGEST_MODES } from '../src/types/wire-vocabulary.js';

describe('audit provenance', () => {
  it('stamps proposedBy onto arbitrary details', () => {
    expect(askProposalAuditDetails({ fields: ['digestMode'] }))
      .toEqual({ fields: ['digestMode'], proposedBy: 'ask-agent' });
    expect(ASK_AGENT_PROPOSER).toBe('ask-agent');
    expect(PROPOSED_BY_DETAIL_KEY).toBe('proposedBy');
  });

  it('works with no details at all', () => {
    expect(askProposalAuditDetails()).toEqual({ proposedBy: 'ask-agent' });
  });

  it('cannot be overwritten by the caller', () => {
    expect(askProposalAuditDetails({ proposedBy: 'the-admin' }).proposedBy).toBe('ask-agent');
  });
});

describe('the allowlist itself', () => {
  it('exposes every entry as a key, with no duplicates', () => {
    expect(ORG_SETTING_PROPOSAL_KEYS).toHaveLength(ORG_SETTING_PROPOSAL_ALLOWLIST.length);
    expect(new Set(ORG_SETTING_PROPOSAL_KEYS).size).toBe(ORG_SETTING_PROPOSAL_KEYS.length);
    for (const key of ORG_SETTING_PROPOSAL_KEYS) expect(isProposableOrgSetting(key)).toBe(true);
  });

  it('is exactly the audited set — a new entry must be added deliberately', () => {
    expect([...ORG_SETTING_PROPOSAL_KEYS].sort()).toEqual([
      'complianceNotifications.digestMode',
      'complianceNotifications.emailEnabled',
      'complianceNotifications.notifyOnBlock',
      'complianceNotifications.notifyOnWarning',
      'pluginSecurityNotifications.digestMode',
      'pluginSecurityNotifications.notifyRescan',
      'reporting.incidentWindowHours',
    ]);
  });

  it('gives every entry a route, a permission and a stated reason', () => {
    for (const spec of ORG_SETTING_PROPOSAL_ALLOWLIST) {
      expect(spec.key).toBe(`${spec.surface}.${spec.field}`);
      expect(spec.api.path.startsWith('/')).toBe(true);
      expect(spec.permission.length).toBeGreaterThan(0);
      expect(spec.why.length).toBeGreaterThan(40);
      expect(spec.label.length).toBeGreaterThan(0);
    }
  });

  it('keeps the mirrored digest vocabulary in step with wire-vocabulary', () => {
    for (const spec of ORG_SETTING_PROPOSAL_ALLOWLIST) {
      if (spec.field !== 'digestMode') continue;
      expect(spec.shape).toEqual({ kind: 'enum', values: [...PLUGIN_SECURITY_DIGEST_MODES] });
    }
  });

  it('records why each excluded field was excluded', () => {
    expect(ORG_SETTING_PROPOSAL_EXCLUSIONS.length).toBeGreaterThan(0);
    for (const exclusion of ORG_SETTING_PROPOSAL_EXCLUSIONS) {
      expect(exclusion.why.length).toBeGreaterThan(10);
      expect(isProposableOrgSetting(exclusion.field)).toBe(false);
    }
  });
});

describe('what the allowlist must never contain', () => {
  const keys = new Set<string>(ORG_SETTING_PROPOSAL_KEYS);
  const fields = new Set(ORG_SETTING_PROPOSAL_ALLOWLIST.map((s) => s.field));

  it('has no step-up-gated field (PUT /organization/ai-config and friends)', () => {
    for (const key of [
      'organization.aiConfig', 'organization.mfaPolicy', 'organization.passwordPolicy',
      'organization.authenticatorPolicy', 'plugins.installPolicy', 'organization.restore',
    ]) {
      expect(keys.has(key)).toBe(false);
      expect(pickAllowed({ [key]: 'anything' }).refused).toEqual([key]);
    }
    for (const spec of ORG_SETTING_PROPOSAL_ALLOWLIST) {
      expect(spec.api.path).not.toContain('ai-config');
      expect(spec.api.path).not.toContain('install-policy');
    }
  });

  it('has no security control — MFA, SSO, impersonation, ownership, teams', () => {
    for (const key of [
      'organization.mfaPolicy', 'organization.impersonationPolicy', 'organization.idp',
      'organization.kmsConfig', 'organization.domains', 'organization.joinRequests',
      'organization.transferOwner', 'organization.teams',
    ]) {
      expect(keys.has(key)).toBe(false);
    }
  });

  it('has no secret-bearing or callback-target field', () => {
    for (const field of ['webhookUrl', 'webhookSecret', 'externalEmail', 'targetUsers', 'recipientMode']) {
      expect(fields.has(field)).toBe(false);
    }
    expect(pickAllowed({
      'complianceNotifications.webhookUrl': 'https://evil.example/x',
      'pluginSecurityNotifications.webhookSecret': 'hunter2',
    })).toMatchObject({
      allowed: {},
      refused: ['complianceNotifications.webhookUrl', 'pluginSecurityNotifications.webhookSecret'],
      refusedCount: 2,
    });
  });

  it('has no billing-owned retention field', () => {
    expect(keys.has('reporting.eventRetentionDays')).toBe(false);
    expect(keys.has('reporting.doraRetentionDays')).toBe(false);
  });
});

describe('pickAllowed', () => {
  it('keeps allowlisted fields and drops everything else, reporting the drop', () => {
    const result = pickAllowed({
      'reporting.incidentWindowHours': 48,
      'complianceNotifications.digestMode': 'daily',
      'organization.mfaPolicy': { required: false },
      'requireMfa': false,
    });
    expect(result.allowed).toEqual({
      'reporting.incidentWindowHours': 48,
      'complianceNotifications.digestMode': 'daily',
    });
    expect(result.refused).toEqual(['organization.mfaPolicy', 'requireMfa']);
    expect(result.refusedCount).toBe(2);
    expect(result.invalid).toEqual([]);
  });

  it('reports a bad value separately from a refused field', () => {
    const result = pickAllowed({
      'reporting.incidentWindowHours': 0,
      'complianceNotifications.digestMode': 'hourly',
      'complianceNotifications.emailEnabled': 'yes',
    });
    expect(result.allowed).toEqual({});
    expect(result.refused).toEqual([]);
    expect(result.refusedCount).toBe(0);
    expect([...result.invalid].sort()).toEqual([
      'complianceNotifications.digestMode',
      'complianceNotifications.emailEnabled',
      'reporting.incidentWindowHours',
    ]);
  });

  it('enforces each declared shape', () => {
    const integer = orgSettingSpec('reporting.incidentWindowHours')!;
    expect(isValidOrgSettingValue(integer, 1)).toBe(true);
    expect(isValidOrgSettingValue(integer, 720)).toBe(true);
    expect(isValidOrgSettingValue(integer, 721)).toBe(false);
    expect(isValidOrgSettingValue(integer, 1.5)).toBe(false);
    expect(isValidOrgSettingValue(integer, '48')).toBe(false);

    const boolean = orgSettingSpec('pluginSecurityNotifications.notifyRescan')!;
    expect(isValidOrgSettingValue(boolean, false)).toBe(true);
    expect(isValidOrgSettingValue(boolean, 'false')).toBe(false);

    const enumerated = orgSettingSpec('complianceNotifications.digestMode')!;
    expect(isValidOrgSettingValue(enumerated, 'weekly')).toBe(true);
    expect(isValidOrgSettingValue(enumerated, 'never')).toBe(false);
  });

  it('reads untrusted input defensively', () => {
    for (const candidate of [undefined, null, 'digestMode=daily', 42, ['reporting.incidentWindowHours']]) {
      expect(pickAllowed(candidate)).toEqual({ allowed: {}, refused: [], invalid: [], refusedCount: 0 });
    }
  });

  it('has no spec for a key it does not know', () => {
    expect(orgSettingSpec('organization.mfaPolicy')).toBeUndefined();
    expect(isProposableOrgSetting('organization.mfaPolicy')).toBe(false);
  });
});

describe('diffOrgSettings + orgSettingRequests', () => {
  it('drops no-op fields and keeps real changes in allowlist order', () => {
    const changes = diffOrgSettings(
      { 'reporting.incidentWindowHours': 24, 'complianceNotifications.digestMode': 'daily' },
      { 'reporting.incidentWindowHours': 48, 'complianceNotifications.digestMode': 'daily' },
    );
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ from: 24, to: 48 });
    expect(changes[0]!.spec.key).toBe('reporting.incidentWindowHours');
  });

  it('treats an absent current value as a change', () => {
    const changes = diffOrgSettings({}, { 'complianceNotifications.notifyOnWarning': true });
    expect(changes).toHaveLength(1);
    expect(changes[0]!.from).toBeUndefined();
  });

  it('ignores a proposed key that is not on the allowlist', () => {
    const proposed = { 'organization.mfaPolicy': false } as Record<string, boolean>;
    expect(diffOrgSettings({}, proposed as Partial<Record<OrgSettingKey, boolean>>)).toEqual([]);
  });

  it('groups the reviewed diff into one request per surface, using API field names', () => {
    const { allowed } = pickAllowed({
      'complianceNotifications.digestMode': 'weekly',
      'complianceNotifications.emailEnabled': true,
      'reporting.incidentWindowHours': 12,
    });
    const requests = orgSettingRequests(diffOrgSettings({}, allowed));
    expect(requests).toEqual([
      {
        surface: 'reporting',
        method: 'PUT',
        path: '/reports/settings/incidents',
        permission: 'org:settings',
        body: { incidentWindowHours: 12 },
      },
      {
        surface: 'complianceNotifications',
        method: 'PUT',
        path: '/compliance/notification-preferences',
        permission: 'compliance:write',
        body: { emailEnabled: true, digestMode: 'weekly' },
      },
    ]);
  });

  it('produces nothing when nothing changed', () => {
    expect(orgSettingRequests([])).toEqual([]);
  });
});
