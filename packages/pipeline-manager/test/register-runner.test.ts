// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `pipeline register --runner <id or label>` picks the runner among the ones the
 * pipeline can be registered with — the list the dashboard's Register
 * deployment dialog offers — and refuses what the dialog would not allow.
 */

import { describe, expect, it, jest } from '@jest/globals';
import { pickRegisterRunner, resolveRegisterRunner } from '../src/utils/register-runner.js';

const runner = (id: string, label: string, extra: Record<string, unknown> = {}) => ({
  id, label, isOwn: true, ownerOrgName: null, regions: ['us-east-1'], health: 'healthy' as const, ...extra,
});
const facts = (runners: ReturnType<typeof runner>[], available = true) => ({ available, unavailableReason: available ? null : ('paused' as const), runners });
const DEFAULT = '11111111-1111-4111-8111-111111111111';
const PROD = '22222222-2222-4222-8222-222222222222';

describe('pickRegisterRunner', () => {
  it('matches an id exactly, and a label case-insensitively', () => {
    const f = facts([runner(DEFAULT, 'default'), runner(PROD, 'prod')]);
    expect(pickRegisterRunner(f, PROD.toUpperCase()).id).toBe(PROD);
    expect(pickRegisterRunner(f, 'Default').id).toBe(DEFAULT);
  });

  it('names the runners it could have picked when none matches', () => {
    expect(() => pickRegisterRunner(facts([runner(DEFAULT, 'default'), runner(PROD, 'shared', { isOwn: false, ownerOrgName: 'Parent' })]), 'nope'))
      .toThrow('Choose one of: default, shared (shared by Parent).');
    expect(() => pickRegisterRunner(facts([]), 'default')).toThrow('Your organization has no pipeline runner.');
  });

  it('asks for the id when a label names more than one runner', () => {
    const f = facts([runner(DEFAULT, 'default'), runner(PROD, 'default', { isOwn: false, ownerOrgName: 'Parent' })]);
    expect(() => pickRegisterRunner(f, 'default')).toThrow(/names more than one pipeline runner.*Pass its id/);
    expect(pickRegisterRunner(f, PROD).id).toBe(PROD);
  });

  it('refuses an unreachable runner, and any runner while runners are unavailable', () => {
    expect(() => pickRegisterRunner(facts([runner(DEFAULT, 'default', { health: 'unreachable' })]), 'default')).toThrow(/is unreachable/);
    expect(() => pickRegisterRunner(facts([runner(DEFAULT, 'default')], false), 'default')).toThrow(/No pipeline runner can link it right now \(paused\)/);
  });
});

it('resolveRegisterRunner reads the pipeline\'s register-runners list', async () => {
  const get = jest.fn(async (_url: string) => ({ success: true, data: facts([runner(DEFAULT, 'default')]) }));
  const picked = await resolveRegisterRunner({ get } as never, 'https://pb/api/pipelines', 'p 1', 'default');
  expect(picked.id).toBe(DEFAULT);
  expect(get).toHaveBeenCalledWith('https://pb/api/pipelines/p%201/register-runners');
});
