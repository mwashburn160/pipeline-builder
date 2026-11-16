// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from '@jest/globals';
import { App, Stack } from 'aws-cdk-lib';
import { buildRegistryPayload } from '../src/utils/registry.js';
import { pipelineStackName } from '../src/utils/stack-name.js';

describe('pipeline stack name', () => {
  it.each([
    ['spring_boot', 'system', 'spring-boot-system'],
    ['spring-boot', 'system', 'spring-boot-system'],
    ['My_App', 'My_Org', 'my-app-my-org'],
    ['app', 'acme', 'app-acme'],
  ])('deploys and registers %s / %s under the same valid name', async (project, organization, expected) => {
    const stack = new Stack(new App(), pipelineStackName(project, organization));
    expect(stack.stackName).toBe(expected);
    const payload = await buildRegistryPayload({ id: 'p-1', orgId: 'o-1', project, organization }, 'us-east-1');
    expect(payload.stackName).toBe(stack.stackName);
    expect(payload.project).toBe(project);
    expect(payload.organization).toBe(organization);
  });
});
