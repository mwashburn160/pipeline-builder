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

describe('PluginOptionsSchema guard', () => {
  it('accepts a version range through filter', () => {
    const result = PipelineCreateSchema.safeParse(basePipeline({
      plugin: { name: 'jest', alias: 'unit', filter: { version: '^1' }, metadata: { NODE_ENV: 'test' } },
    }));
    expect(result.success).toBe(true);
  });

  it('rejects a top-level `version` on a step plugin reference', () => {
    const result = PipelineCreateSchema.safeParse(basePipeline({ plugin: { name: 'jest', version: '1.0.0' } }));
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find(i => i.path.join('.') === 'props.stages.0.steps.0.plugin.version');
      expect(issue?.message).toMatch(/filter: \{ version/);
    }
  });

  it('accepts a `publisher` on a plugin reference (installed listings, §3.5)', () => {
    const result = PipelineCreateSchema.safeParse(basePipeline({
      plugin: { publisher: 'acme', name: 'terraform-plan', filter: { version: '^1' } },
    }));
    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.data.props.stages?.[0] as { steps: Array<{ plugin: Record<string, unknown> }> }).steps[0]!.plugin.publisher).toBe('acme');
    }
  });

  it.each(['Acme', 'acme_corp', '-acme', 'a'.repeat(40)])('rejects the malformed publisher handle %s', (publisher) => {
    const result = PipelineCreateSchema.safeParse(basePipeline({ plugin: { publisher, name: 'jest' } }));
    expect(result.success).toBe(false);
  });

  it('applies to the synth plugin too', () => {
    const body = basePipeline({ plugin: { name: 'jest' } });
    (body.props.synth.plugin as Record<string, unknown>).version = '1.0.0';
    const result = PipelineCreateSchema.safeParse(body);
    expect(result.success).toBe(false);
  });
});

describe('StageSchema', () => {
  it('keeps a stage\'s `environment` (DORA deploy attribution) through parsing', () => {
    const body = basePipeline({ plugin: { name: 'cdk-deploy' } });
    (body.props.stages[0] as Record<string, unknown>).environment = 'production';
    const result = PipelineCreateSchema.safeParse(body);
    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.data.props.stages?.[0] as Record<string, unknown>).environment).toBe('production');
    }
  });
});
