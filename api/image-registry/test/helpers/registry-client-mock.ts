// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * A `services/registry-client.js` mock that provides EVERY export, so a suite
 * only names the calls it cares about. ESM module mocks must be complete: a
 * missing export fails the whole suite at link time ("does not provide an export
 * named …") the moment any module under test imports it — which is what broke
 * three suites when the plugin-ecosystem publication code started using more of
 * the client. Keep the name list in step with registry-client.ts.
 */
import { jest } from '@jest/globals';

const REGISTRY_CLIENT_EXPORTS = [
  'mintRepositoryPushToken', 'mintRepositoryPullToken', 'listRepositories', 'listRepositoriesUnderPrefix',
  'listTags', 'getManifest', 'deleteManifest', 'putManifest', 'deleteTag', 'uploadSmallBlob', 'headManifest',
  'headBlob', 'getBlobStream', 'getBlobJson', 'mountBlob',
] as const;

/** 404-shaped errors — the real client's `isNotFound` contract. */
export const isNotFound = (e: unknown): boolean => (e as { response?: { status?: number } })?.response?.status === 404;

export function registryClientMock(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const mock: Record<string, unknown> = { isNotFound };
  for (const name of REGISTRY_CLIENT_EXPORTS) mock[name] = jest.fn();
  return { ...mock, ...overrides };
}
