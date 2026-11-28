// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Platform-operator stub data and helpers:
 *  - `stubOrganizations(api)`: the all-orgs roster (`GET /organizations`) with
 *    one tenant, Acme, whose per-org KMS binding is configured;
 *  - `stubKmsConfig(api, …)`: that binding (`GET …/kms-config`), optionally
 *    with an earlier change's runner-key re-wrap still pending;
 *  - `openKmsConfig(page)`: signs in as SYSADMIN and opens Acme's "KMS Config"
 *    modal from the All organizations row menu (for the a11y scan and the
 *    screenshot specs as well as the re-wrap journey);
 *  - `stubCascade(api)`: the cascade outbox with one dead and one done leg, and
 *    a stateful redrive that puts the dead leg back to pending.
 */

import { expect, type Locator, type Page } from '@playwright/test';
import { SYSADMIN, ok, signedInPage, type Backend } from '../backend';

export const ACME_ID = '000000000000000000000a01';

export const ACME_ORG = {
  id: ACME_ID, name: 'Acme', slug: 'acme', ownerId: 'u-1', memberCount: 3, tier: 'pro',
  kmsConfigured: true, idpConfigured: false, parentOrgId: null,
  createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-11-01T00:00:00Z',
};

export function stubOrganizations(api: Backend) {
  api.on('GET /api/organizations', ok({ organizations: [ACME_ORG], pagination: { total: 1, offset: 0, limit: 25, hasMore: false } }));
}

export function stubKmsConfig(api: Backend, opts: { rewrapPending?: boolean } = {}) {
  const state = { rewrapPending: opts.rewrapPending ?? false };
  api.on(`GET /api/admin/orgs/${ACME_ID}/kms-config`, () => ok({ configured: true, keyId: 'alias/pb-org-acme', runnerRewrapPending: state.rewrapPending }));
  return state;
}

/** Open Acme's KMS Config modal on All organizations, signed in as the operator. */
export async function openKmsConfig(page: Page, opts: { rewrapPending?: boolean } = {}): Promise<{ api: Backend; dialog: Locator }> {
  const api = await signedInPage(page, SYSADMIN);
  stubOrganizations(api);
  stubKmsConfig(api, opts);
  await page.goto('/dashboard/organizations');
  const row = page.getByRole('row', { name: /Acme/ });
  await row.getByRole('button', { name: 'More actions' }).click();
  await page.getByRole('menuitem', { name: 'KMS config' }).click();
  const dialog = page.getByRole('dialog', { name: 'KMS Config — Acme' });
  await expect(dialog.getByText('alias/pb-org-acme')).toBeVisible();
  return { api, dialog };
}

const leg = (id: string, service: string, status: 'pending' | 'done' | 'dead', extra: Record<string, unknown> = {}) => ({
  id, kind: 'org.deleted', subjectId: ACME_ID, service, status, attempts: 0,
  nextAttemptAt: '2026-11-20T00:00:00Z', lastError: null, lastStatusCode: null, completedAt: null,
  createdAt: '2026-11-19T00:00:00Z', updatedAt: '2026-11-20T00:00:00Z', ...extra,
});

export function stubCascade(api: Backend) {
  const legs = [
    leg('leg-billing', 'billing', 'dead', { attempts: 8, lastStatusCode: 503, lastError: 'billing unavailable' }),
    leg('leg-pipeline', 'pipeline', 'done', { attempts: 1, completedAt: '2026-11-19T01:00:00Z' }),
  ];
  api.on('GET /api/admin/cascade', (call) => {
    const status = call.query.get('status');
    const rows = status ? legs.filter((l) => l.status === status) : legs;
    return ok({ legs: rows, pagination: { total: rows.length, limit: 50, offset: 0, hasMore: false } });
  });
  api.on('POST /api/admin/cascade/leg-billing/redrive', (call) => {
    const row = legs[0];
    const { resetAttempts } = call.json as { resetAttempts: boolean };
    Object.assign(row, { status: 'pending', attempts: resetAttempts ? 0 : row.attempts, updatedAt: '2026-11-27T00:00:00Z' });
    return { json: { success: true, message: 'Cascade leg to billing queued for redelivery', data: { leg: row } } };
  });
  return { legs };
}
