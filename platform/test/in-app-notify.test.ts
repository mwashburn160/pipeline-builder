// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * In-app notification delivery: both variants go through api-core's
 * `sendSystemNotification` (whose transport and non-2xx handling are tested in
 * api-core) at platform's configured message-service address, and a disabled
 * message service reaches nobody.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { mockConfig } from './helpers/config-mock.js';
import { apiCoreMock } from './helpers/mock-api-core.js';

const mockSend = jest.fn<(...a: unknown[]) => Promise<boolean>>();
const messageConfig = { enabled: true, serviceHost: 'message', servicePort: 3000, serviceTimeout: 5000 };

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  sendSystemNotification: (...a: unknown[]) => mockSend(...a),
}));
jest.unstable_mockModule('../src/config/index.js', () => mockConfig({ message: messageConfig }));

const { sendInAppNotification, sendInAppNotificationConfirmed } = await import('../src/helpers/in-app-notify.js');
const notice = { recipientOrgId: 'org-1', subject: 's', content: 'c' };

beforeEach(() => { jest.clearAllMocks(); messageConfig.enabled = true; });

describe('in-app notifications', () => {
  it('confirmed: reports the delivery outcome, signed as platform at the configured address', async () => {
    mockSend.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    await expect(sendInAppNotificationConfirmed(notice)).resolves.toBe(true);
    await expect(sendInAppNotificationConfirmed(notice)).resolves.toBe(false);
    expect(mockSend).toHaveBeenCalledWith(notice, {
      service: { host: 'message', port: 3000, timeout: 5000 },
      serviceName: 'platform',
    });
  });

  it('a disabled message service reaches nobody', async () => {
    messageConfig.enabled = false;
    await expect(sendInAppNotificationConfirmed(notice)).resolves.toBe(false);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('fire-and-forget: same delivery path, never throws', async () => {
    mockSend.mockResolvedValue(false);
    await expect(sendInAppNotification(notice)).resolves.toBeUndefined();
    expect(mockSend).toHaveBeenCalledTimes(1);
  });
});
