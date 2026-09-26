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

  it('accepts a `publisher` on a plugin reference (installed listings)', () => {
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

/**
 * Reserved tag keys are refused at the schema, not silently dropped.
 *
 * `props.tags` carries TENANCY and attribution: the events Lambda reads
 * `pb.pipeline-id` and `pb.deploys` off the stack to decide whose reports an
 * execution belongs to, and `OrgId` drives cost attribution. A caller able to set
 * them could point another org's executions at its own pipeline.
 *
 * This is the EARLY-FEEDBACK half of the defence — `PipelineBuilder` drops them
 * again at synth, because the construct can be used directly without the API. The
 * schema exists so a caller learns WHICH key was refused instead of wondering why
 * its tag vanished.
 */
describe('reserved props.tags keys', () => {
  const withTags = (tags: Record<string, string>) => ({
    project: 'demo',
    organization: 'acme',
    props: {
      project: 'demo',
      organization: 'acme',
      synth: { plugin: { name: 'cdk-synth' } },
      tags,
    },
  });

  it('accepts ordinary cost-allocation tags', () => {
    const result = PipelineCreateSchema.safeParse(withTags({ team: 'payments', costCenter: 'cc-42' }));
    expect(result.success).toBe(true);
  });

  it.each(['OrgId', 'pipeline-builder', 'project', 'organization'])('refuses the reserved key %s', (key) => {
    const result = PipelineCreateSchema.safeParse(withTags({ [key]: 'x' }));
    expect([key, result.success]).toEqual([key, false]);
  });

  it('refuses reserved keys case-insensitively', () => {
    // AWS tag keys are case-sensitive, so `orgid` would be a DIFFERENT tag — but
    // accepting it invites confusion about which one attribution reads.
    expect(PipelineCreateSchema.safeParse(withTags({ orgid: 'x' })).success).toBe(false);
  });

  it.each(['pb.deploys', 'pb.pipeline-id', 'pb.anything-added-later'])('refuses the pb. prefix: %s', (key) => {
    const result = PipelineCreateSchema.safeParse(withTags({ [key]: 'x' }));
    expect([key, result.success]).toEqual([key, false]);
  });

  it('refuses the aws: prefix, which CloudFormation rejects anyway', () => {
    expect(PipelineCreateSchema.safeParse(withTags({ 'aws:cloudformation:stack-name': 'x' })).success).toBe(false);
  });

  it('names the offending key in the error, so the caller can fix it', () => {
    const result = PipelineCreateSchema.safeParse(withTags({ OrgId: 'attacker-org' }));
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(JSON.stringify(result.error.issues)).toContain('OrgId');
    }
  });

  it('refuses the whole body when ONE of several tags is reserved', () => {
    // Partial acceptance would silently drop the reserved key and report success.
    expect(PipelineCreateSchema.safeParse(withTags({ team: 'payments', OrgId: 'x' })).success).toBe(false);
  });

  it('accepts a config with no tags at all', () => {
    const result = PipelineCreateSchema.safeParse({
      project: 'demo',
      organization: 'acme',
      props: { project: 'demo', organization: 'acme', synth: { plugin: { name: 'cdk-synth' } } },
    });
    expect(result.success).toBe(true);
  });
});

/**
 * `isActive` is declared on the create schema. It used to be stripped — the schema
 * is strict-by-default — so the CLI's `--no-active` was silently dropped and every
 * pipeline came up active. There is deliberately no `isDefault`:
 * `pipeline_project_org_unique` allows one pipeline per (project, organization,
 * org), so the row created in a slot IS that slot's default and a `false` could
 * not be honoured.
 */
describe('create-time lifecycle flags', () => {
  const body = (over: Record<string, unknown>) => ({
    project: 'demo',
    organization: 'acme',
    props: { project: 'demo', organization: 'acme', synth: { plugin: { name: 'cdk-synth' } } },
    ...over,
  });

  it('keeps isActive: false instead of stripping it', () => {
    const result = PipelineCreateSchema.safeParse(body({ isActive: false }));
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.isActive).toBe(false);
  });

  it('leaves isActive undefined when not sent, so the service default applies', () => {
    const result = PipelineCreateSchema.safeParse(body({}));
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.isActive).toBeUndefined();
  });

  it('does not carry an isDefault field', () => {
    const result = PipelineCreateSchema.safeParse(body({ isDefault: false }));
    expect(result.success).toBe(true);
    if (result.success) expect('isDefault' in result.data).toBe(false);
  });
});
