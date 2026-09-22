// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The `/api/images` per-repository gate's rules for the plugin ecosystem's
 * namespaces: `public/*` is pull-open to any authenticated caller and
 * APPEND-ONLY through this API — nobody writes it, superadmins included (only
 * the internal publish/yank/gc routes do, as the management identity);
 * `registry-meta/*` (publication records) is closed to everyone.
 */

import { jest, describe, it, expect } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock());

const { canReadRepo, canWriteRepo } = await import('../src/routes/images/repo-access.js');
const { repoOwnerOrgId } = await import('../src/services/namespaces.js');

const users = {
  member: { organizationId: 'acme' },
  systemOrg: { organizationId: '000000000000000000000001' },
  superAdmin: { organizationId: 'platform', isSuperAdmin: true },
};

describe('public/*', () => {
  it.each(Object.entries(users))('is readable by %s', (_name, user) => {
    expect(canReadRepo(user, 'public/acme/scanner')).toBe(true);
  });

  it('is not readable anonymously', () => {
    expect(canReadRepo(undefined, 'public/acme/scanner')).toBe(false);
  });

  it.each(Object.entries(users))('is NOT writable by %s (append-only)', (_name, user) => {
    expect(canWriteRepo(user, 'public/acme/scanner')).toBe(false);
  });

  it('is not writable even by the publisher org', () => {
    expect(canWriteRepo({ organizationId: 'acme' }, 'public/acme/scanner')).toBe(false);
  });

  it('has no owning org for audit purposes (ownership lives in the publication record)', () => {
    expect(repoOwnerOrgId('public/acme/scanner')).toBeUndefined();
  });
});

describe('registry-meta/*', () => {
  it.each(Object.entries(users))('is neither readable nor writable by %s', (_name, user) => {
    expect(canReadRepo(user, 'registry-meta/publications/acme/scanner')).toBe(false);
    expect(canWriteRepo(user, 'registry-meta/publications/acme/scanner')).toBe(false);
  });
});

describe('unchanged namespaces', () => {
  it('keeps org-<id>/* private to its org, and superadmin-writable', () => {
    expect(canReadRepo(users.member, 'org-acme/x')).toBe(true);
    expect(canReadRepo(users.member, 'org-other/x')).toBe(false);
    expect(canWriteRepo(users.superAdmin, 'org-other/x')).toBe(true);
  });
});

// Anonymous plugin submissions: never listed, read,
// written or copied through /api/images — superadmins included.
describe('quarantine/*', () => {
  const REPO = 'quarantine/0f3a2b1c-aaaa-4bbb-8ccc-123456789abc';

  it.each(Object.entries(users))('is NOT readable by %s', (_name, user) => {
    expect(canReadRepo(user, REPO)).toBe(false);
  });

  it.each(Object.entries(users))('is NOT writable by %s', (_name, user) => {
    expect(canWriteRepo(user, REPO)).toBe(false);
  });

  it('is owned by the system org (only a system-org service token may sign/publish from it)', () => {
    expect(repoOwnerOrgId(REPO)).toBe('000000000000000000000001');
  });
});
