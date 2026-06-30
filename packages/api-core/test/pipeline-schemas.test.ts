// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from '@jest/globals';

import { PipelineCreateSchema } from '../src/validation/pipeline-schemas.js';

const basePipeline = (step: Record<string, unknown>) => ({
  project: 'demo',
  organization: 'acme',
  props: {
    project: 'demo',
    organization: 'acme',
    synth: { plugin: { name: 'cdk-synth' } },
    stages: [{ stageName: 'Build', alias: 'BuildAndPackage', steps: [step] }],
  },
});

describe('StageStepSchema guard', () => {
  it('accepts a valid step (plugin + metadata + position + preCommands)', () => {
    const result = PipelineCreateSchema.safeParse(basePipeline({
      plugin: { name: 'java', metadata: { JAVA_VERSION: '25', GRADLE_TASK: 'assemble' } },
      position: 'pre',
      preCommands: ['echo before'],
      postCommands: ['echo after'],
      timeout: 30,
    }));
    expect(result.success).toBe(true);
  });

  it('rejects a top-level `commands` field with a helpful message', () => {
    const result = PipelineCreateSchema.safeParse(basePipeline({
      plugin: { name: 'java' },
      commands: ['./gradlew assemble'],
    }));
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find(i => i.path.includes('commands'));
      expect(issue).toBeDefined();
      expect(issue!.message).toMatch(/not a step field/);
      expect(issue!.message).toMatch(/preCommands\/postCommands|GRADLE_TASK/);
    }
  });
});
