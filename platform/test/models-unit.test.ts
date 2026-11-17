// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * DB-free unit coverage for the Mongoose models: schema defaults, document
 * methods and validate/save hooks, exercised on in-memory documents.
 */
import { jest, describe, it, expect } from '@jest/globals';
import { mockConfig } from './helpers/config-mock.js';

jest.unstable_mockModule('../src/config/index.js', () => mockConfig({
  auth: { passwordMinLength: 8, passwordSaltRounds: 4 },
  invitation: { expirationDays: 7 },
}));

const { DEFAULT_TIER, PLAN_TIERS } = await import('@pipeline-builder/api-core');
const { Types } = await import('mongoose');
const { default: Organization } = await import('../src/models/organization.js');
const { default: Invitation } = await import('../src/models/invitation.js');
const { default: User } = await import('../src/models/user.js');

type Hooked = { schema: { s: { hooks: { execPre: (name: string, ctx: unknown, args: unknown[]) => Promise<void> } } } };
const runPre = (model: unknown, hook: string, doc: unknown) =>
  (model as Hooked).schema.s.hooks.execPre(hook, doc, []);

/** Stub `Model.find(...).select(...).lean()` to resolve the given rows. */
function stubFind(rows: Array<{ slug: string }>) {
  const lean = jest.fn(async () => rows);
  const select = jest.fn(() => ({ lean }));
  return jest.spyOn(Organization, 'find').mockReturnValue({ select } as never);
}

describe('Organization model', () => {
  it('fills every quota limit and usage default from the default tier', () => {
    const org = new Organization({ name: 'Acme Corp' });
    const limits = PLAN_TIERS[DEFAULT_TIER].limits as unknown as Record<string, number>;
    const quotas = (org.toObject() as unknown as { quotas: Record<string, number> }).quotas;
    for (const key of Object.keys(quotas)) {
      if (key in limits) expect(quotas[key]).toBe(limits[key]);
    }
    const usage = (org.toObject() as unknown as { usage: Record<string, { used: number; resetAt: Date }> }).usage;
    for (const entry of Object.values(usage)) {
      expect(entry.used).toBe(0);
      expect(entry.resetAt).toBeInstanceOf(Date);
    }
    expect(org._id).toBeInstanceOf(Types.ObjectId);
  });

  it('derives a slug from the name on validate', async () => {
    const find = stubFind([]);
    const org = new Organization({ name: 'Acme Corp' });
    await org.validate().catch(() => undefined);
    expect(find).toHaveBeenCalled();
    expect(org.slug).toBe('acme-corp');
  });

  it('picks the next free slug when the base collides', async () => {
    stubFind([{ slug: 'acme-corp' }]);
    const org = new Organization({ name: 'Acme Corp' });
    await org.validate().catch(() => undefined);
    expect(org.slug).not.toBe('acme-corp');
    expect(org.slug.startsWith('acme-corp')).toBe(true);
  });

  it('keeps an explicitly set slug', async () => {
    const find = stubFind([]);
    const org = new Organization({ name: 'Acme Corp', slug: 'custom' });
    await org.validate().catch(() => undefined);
    expect(find).not.toHaveBeenCalled();
    expect(org.slug).toBe('custom');
  });
});

describe('Invitation model', () => {
  const base = () => ({
    email: 'a@example.com',
    organizationId: new Types.ObjectId(),
    invitedBy: new Types.ObjectId(),
    role: 'member',
  });

  it('generates a token and expiry on validate', async () => {
    const inv = new Invitation(base());
    await inv.validate().catch(() => undefined);
    expect(inv.token).toMatch(/^[0-9a-f]{64}$/);
    const days = (inv.expiresAt.getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(6.9);
    expect(days).toBeLessThanOrEqual(7);
  });

  it('keeps a pre-set token and expiry', async () => {
    const expiresAt = new Date(Date.now() + 1000);
    const inv = new Invitation({ ...base(), token: 'fixed', expiresAt });
    await inv.validate().catch(() => undefined);
    expect(inv.token).toBe('fixed');
    expect(inv.expiresAt).toEqual(expiresAt);
  });

  it('isExpired / isValid track status and expiry', () => {
    const future = new Date(Date.now() + 60_000);
    const past = new Date(Date.now() - 60_000);
    expect(new Invitation({ ...base(), expiresAt: future }).isExpired()).toBe(false);
    expect(new Invitation({ ...base(), expiresAt: past }).isExpired()).toBe(true);
    expect(new Invitation({ ...base(), expiresAt: future }).isValid()).toBe(true);
    expect(new Invitation({ ...base(), expiresAt: past }).isValid()).toBe(false);
    expect(new Invitation({ ...base(), expiresAt: future, status: 'accepted' }).isValid()).toBe(false);
  });

  it('canAcceptViaOAuth honours type and provider allow-list', () => {
    const expiresAt = new Date(Date.now() + 60_000);
    expect(new Invitation({ ...base(), expiresAt }).canAcceptViaOAuth('github')).toBe(true);
    expect(new Invitation({ ...base(), expiresAt, invitationType: 'email' }).canAcceptViaOAuth('github')).toBe(false);
    const limited = new Invitation({ ...base(), expiresAt, invitationType: 'oauth', allowedOAuthProviders: ['google'] });
    expect(limited.canAcceptViaOAuth('google')).toBe(true);
    expect(limited.canAcceptViaOAuth('github')).toBe(false);
    expect(new Invitation({ ...base(), expiresAt: new Date(Date.now() - 1) }).canAcceptViaOAuth('github')).toBe(false);
  });

  it('canAcceptViaEmail refuses oauth-only and invalid invitations', () => {
    const expiresAt = new Date(Date.now() + 60_000);
    expect(new Invitation({ ...base(), expiresAt }).canAcceptViaEmail()).toBe(true);
    expect(new Invitation({ ...base(), expiresAt, invitationType: 'oauth' }).canAcceptViaEmail()).toBe(false);
    expect(new Invitation({ ...base(), expiresAt: new Date(Date.now() - 1) }).canAcceptViaEmail()).toBe(false);
  });
});

describe('User model', () => {
  it('hashes a strong password on save and compares it', async () => {
    const user = new User({ email: 'u@example.com', username: 'u1', password: 'Str0ng!Passw0rd' });
    await runPre(User, 'save', user);
    expect(user.password).not.toBe('Str0ng!Passw0rd');
    await expect(user.comparePassword('Str0ng!Passw0rd')).resolves.toBe(true);
    await expect(user.comparePassword('wrong')).resolves.toBe(false);
  });

  it('rejects a too-short password', async () => {
    const user = new User({ email: 'u@example.com', username: 'u1', password: 'Ab1!' });
    await expect(runPre(User, 'save', user)).rejects.toThrow(/at least 8/);
  });

  it('rejects a password that fails a strength rule', async () => {
    const user = new User({ email: 'u@example.com', username: 'u1', password: 'alllowercase' });
    await expect(runPre(User, 'save', user)).rejects.toThrow();
  });

  it('skips hashing when there is no password', async () => {
    const user = new User({ email: 'u@example.com', username: 'u1' });
    await runPre(User, 'save', user);
    expect(user.password).toBeUndefined();
    await expect(user.comparePassword('anything')).resolves.toBe(false);
  });
});
