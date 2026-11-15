// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * GET /invitation/:token — the public preview names EVERY OAuth provider the
 * invitee can accept with (configured here AND allowed by the invitation), not
 * just Google.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { mockConfig } from './helpers/config-mock.js';
import { controllerHelperMock } from './helpers/controller-helper-mock.js';
import { apiCoreMock } from './helpers/mock-api-core.js';

const mockGetByToken = jest.fn<(...a: unknown[]) => Promise<unknown>>();
let enabled: string[] = [];

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  sendError: (res: any, status: number, msg: string) => res.status(status).json({ success: false, message: msg }),
  sendSuccess: (res: any, status: number, data: unknown) => res.status(status).json({ success: true, data }),
}));
jest.unstable_mockModule('../src/config/index.js', () => mockConfig({}));
jest.unstable_mockModule('../src/utils/validation.js', () => ({ validateBody: jest.fn(), sendInvitationSchema: {} }));
jest.unstable_mockModule('../src/services/oauth-providers.js', () => ({
  verifyOAuthCode: jest.fn(),
  enabledOAuthProviders: () => enabled,
  OAUTH_ERROR_MAP: {},
}));
jest.unstable_mockModule('../src/helpers/controller-helper.js', () => controllerHelperMock());
jest.unstable_mockModule('../src/services/index.js', () => ({
  invitationService: { getByToken: (...a: unknown[]) => mockGetByToken(...a) },
  auditService: { createEvent: jest.fn() },
}));
jest.unstable_mockModule('../src/helpers/audit.js', () => ({ audit: jest.fn() }));

const { getInvitation } = await import('../src/controllers/invitation.js');

/** An invitation document with the model's real acceptance rules. */
function invitation(over: { invitationType: 'email' | 'oauth' | 'any'; allowedOAuthProviders?: string[]; valid?: boolean }) {
  const valid = over.valid ?? true;
  return {
    email: 'invitee@x.com',
    role: 'member',
    status: valid ? 'pending' : 'expired',
    expiresAt: new Date(),
    organizationId: { name: 'Org' },
    invitedBy: { username: 'admin' },
    invitationType: over.invitationType,
    allowedOAuthProviders: over.allowedOAuthProviders,
    isValid: () => valid,
    canAcceptViaEmail: () => valid && over.invitationType !== 'oauth',
    canAcceptViaOAuth: (p: string) => valid && over.invitationType !== 'email'
      && (!over.allowedOAuthProviders?.length || over.allowedOAuthProviders.includes(p)),
  };
}

async function preview(): Promise<Record<string, unknown>> {
  const res: any = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  await getInvitation({ params: { token: 'tok' } } as any, res);
  return (res.json.mock.calls[0][0] as { data: { invitation: Record<string, unknown> } }).data.invitation;
}

describe('GET /invitation/:token — acceptProviders', () => {
  beforeEach(() => { enabled = ['google', 'github', 'microsoft']; });

  it('lists every enabled provider for an unrestricted invitation', async () => {
    mockGetByToken.mockResolvedValue(invitation({ invitationType: 'any' }));
    const inv = await preview();
    expect(inv.acceptProviders).toEqual(['google', 'github', 'microsoft']);
    expect(inv).not.toHaveProperty('canAcceptViaGoogle');
  });

  it('intersects the invitation\'s allowed providers with the enabled ones', async () => {
    // gitlab is allowed but not configured here; github is both.
    mockGetByToken.mockResolvedValue(invitation({ invitationType: 'oauth', allowedOAuthProviders: ['github', 'gitlab'] }));
    expect((await preview()).acceptProviders).toEqual(['github']);
  });

  it('is empty for an email-only invitation', async () => {
    mockGetByToken.mockResolvedValue(invitation({ invitationType: 'email' }));
    const inv = await preview();
    expect(inv.acceptProviders).toEqual([]);
    expect(inv.canAcceptViaEmail).toBe(true);
  });

  it('is empty once the invitation is no longer valid', async () => {
    mockGetByToken.mockResolvedValue(invitation({ invitationType: 'any', valid: false }));
    expect((await preview()).acceptProviders).toEqual([]);
  });
});
