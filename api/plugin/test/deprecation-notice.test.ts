// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The deprecation notice: event N14, addressed to the org approvers of
 * every org whose pipelines use the version — as per-org recipient RULES, so the
 * publisher never learns who installed and no notice names another org.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { stubModule } from '@pipeline-builder/api-core/testing';
import { apiCoreMock } from './helpers/mock-api-core.js';

const mockFindOrgsUsingVersion = jest.fn<(...a: any[]) => Promise<string[]>>();
const mockEnqueue = jest.fn<(...a: any[]) => Promise<string>>();
const mockIncCounter = jest.fn();

jest.unstable_mockModule('../src/services/plugin-service.js', () => ({
  pluginService: { findOrgsUsingVersion: mockFindOrgsUsingVersion },
}));
jest.unstable_mockModule('../src/services/ecosystem-notifications.js', () => ({
  enqueueEcosystemNotification: mockEnqueue,
}));
jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock());
jest.unstable_mockModule('@pipeline-builder/api-server', () => stubModule('@pipeline-builder/api-server', { incCounter: mockIncCounter }));
const mockDeprecateListed = jest.fn(async (..._a: unknown[]) => 0);
jest.unstable_mockModule('../src/services/ecosystem/version-deprecation.js', () => ({ deprecateListedFromSource: mockDeprecateListed }));

const { onPluginDeprecated, renderDeprecationNotice, DEPRECATION_RECIPIENT_CHUNK } = await import('../src/helpers/deprecation-notice.js');
const { parseEcosystemNotifyRequest } = await import('@pipeline-builder/api-core');

const plugin = {
  id: 'p-1',
  orgId: 'publisher-org',
  name: 'trivy',
  version: '1.2.0',
  isDefault: true,
  visibility: 'public',
  deprecationMessage: 'Use 2.x',
};

describe('onPluginDeprecated → N14', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockEnqueue.mockResolvedValue('sent');
  });

  it('notifies each using org\'s approvers via org_permission rules', async () => {
    mockFindOrgsUsingVersion.mockResolvedValue(['org-a', 'org-b']);
    await onPluginDeprecated(plugin, 'u-1');

    expect(mockFindOrgsUsingVersion).toHaveBeenCalledWith(plugin);
    // A listed copy of the version is deprecated too.
    expect(mockDeprecateListed).toHaveBeenCalledWith(plugin, 'u-1');
    expect(mockEnqueue).toHaveBeenCalledTimes(1);
    const [event, recipients, content] = mockEnqueue.mock.calls[0]!;
    expect(event).toBe('N14');
    expect(recipients).toEqual([
      { kind: 'org_permission', orgId: 'org-a', permission: 'plugin_installs:manage', inheritFromRoot: true },
      { kind: 'org_permission', orgId: 'org-b', permission: 'plugin_installs:manage', inheritFromRoot: true },
    ]);
    // The relay would accept it.
    expect(typeof parseEcosystemNotifyRequest({ event, recipients, ...(content as object) })).toBe('object');
    expect(mockIncCounter).toHaveBeenCalledWith('plugin_deprecations_total');
    expect(mockIncCounter).toHaveBeenCalledWith('plugin_deprecation_notices_total');
  });

  it('never addresses the publisher org\'s managers or names the using orgs in the body', async () => {
    mockFindOrgsUsingVersion.mockResolvedValue(['org-a']);
    await onPluginDeprecated(plugin, 'u-1');
    const [, recipients, content] = mockEnqueue.mock.calls[0]! as [string, any[], { subject: string; text: string }];
    expect(recipients.every((r) => r.kind === 'org_permission' && r.permission === 'plugin_installs:manage')).toBe(true);
    expect(recipients.some((r) => r.permission === 'publishers:manage')).toBe(false);
    expect(content.text).not.toContain('org-a');
    expect(content.subject).not.toContain('org-a');
  });

  it('sends nothing when no pipeline uses the version', async () => {
    mockFindOrgsUsingVersion.mockResolvedValue([]);
    await onPluginDeprecated(plugin, 'u-1');
    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  it('splits a large audience into relay-sized requests', async () => {
    const orgs = Array.from({ length: DEPRECATION_RECIPIENT_CHUNK * 2 + 1 }, (_, i) => `org-${i}`);
    mockFindOrgsUsingVersion.mockResolvedValue(orgs);
    await onPluginDeprecated(plugin, 'u-1');
    expect(mockEnqueue).toHaveBeenCalledTimes(3);
    expect((mockEnqueue.mock.calls[0]![1] as unknown[]).length).toBe(DEPRECATION_RECIPIENT_CHUNK);
    expect((mockEnqueue.mock.calls[2]![1] as unknown[]).length).toBe(1);
  });

  it('never rejects: a lookup or send failure is counted and swallowed', async () => {
    mockFindOrgsUsingVersion.mockRejectedValue(new Error('db down'));
    await expect(onPluginDeprecated(plugin, 'u-1')).resolves.toBeUndefined();
    expect(mockIncCounter).toHaveBeenCalledWith('plugin_deprecation_notice_failures_total');

    mockFindOrgsUsingVersion.mockResolvedValue(['org-a']);
    mockEnqueue.mockRejectedValue(new Error('invalid'));
    await expect(onPluginDeprecated(plugin, 'u-1')).resolves.toBeUndefined();
  });
});

describe('renderDeprecationNotice', () => {
  it('names the version and carries the publisher\'s message', () => {
    const n = renderDeprecationNotice(plugin);
    expect(n.subject).toBe('Plugin trivy@1.2.0 is deprecated');
    expect(n.text).toContain('Reason: Use 2.x');
  });

  it('omits the reason line when there is no message', () => {
    expect(renderDeprecationNotice({ ...plugin, deprecationMessage: '  ' }).text).not.toContain('Reason:');
    expect(renderDeprecationNotice({ ...plugin, deprecationMessage: null }).text).not.toContain('Reason:');
  });
});
