// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `deployment` on each Recently deleted row: what a purge does to the
 * tombstone's stack — removed through its linked deploy-capable runner
 * (`stackRemovedOnPurge`), or left in the account.
 */

import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { ORG, runnerRow, testDeps } from './helpers/runner-fakes.js';

process.env.JWT_SECRET ||= 'deleted-pipeline-deployment-test-secret';

const { deletedPipelineDeployment } = await import('../src/routes/read-pipelines.js');
const { setRunnerDepsForTesting } = await import('../src/runners/deps.js');
const { pipelineRegistryService } = await import('../src/services/pipeline-registry-service.js');

afterEach(() => { jest.restoreAllMocks(); setRunnerDepsForTesting(null); });

const PID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaab';
const reg = (runnerId: string | null) => ({ registryId: 'r', stackName: 'shop-acme', region: 'us-east-1', pipelineName: 'p', runnerId });

describe('deletedPipelineDeployment', () => {
  it('null when the pipeline was never registered', async () => {
    jest.spyOn(pipelineRegistryService, 'deploymentOf').mockResolvedValue(null);
    setRunnerDepsForTesting(testDeps());
    expect(await deletedPipelineDeployment(PID)).toBeNull();
  });

  it('a linked runner listing deploy:1 removes the stack on purge; one without it (or no runner) leaves it', async () => {
    const deps = testDeps();
    const capable = runnerRow({ label: 'deployer', capabilities: ['deploy:1'], orgId: ORG });
    const old = runnerRow({ label: 'old' });
    deps.store.runners.set(capable.id, capable);
    deps.store.runners.set(old.id, old);
    setRunnerDepsForTesting(deps);
    const spy = jest.spyOn(pipelineRegistryService, 'deploymentOf');
    spy.mockResolvedValueOnce(reg(capable.id));
    expect(await deletedPipelineDeployment(PID)).toEqual({
      stackName: 'shop-acme', region: 'us-east-1', runner: { id: capable.id, label: 'deployer', capabilities: ['deploy:1'] }, stackRemovedOnPurge: true,
    });
    spy.mockResolvedValueOnce(reg(old.id));
    expect(await deletedPipelineDeployment(PID)).toMatchObject({ runner: { label: 'old', capabilities: [] }, stackRemovedOnPurge: false });
    spy.mockResolvedValueOnce(reg(null));
    expect(await deletedPipelineDeployment(PID)).toMatchObject({ runner: null, stackRemovedOnPurge: false });
  });
});
