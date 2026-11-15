// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from '@jest/globals';
import { pickRuleAttributes } from '../src/utils/compliance-attributes.js';
import { RULE_FIELDS, parseRuleField, ruleFieldError } from '../src/types/wire-vocabulary.js';

describe('ruleFieldError', () => {
  it.each([
    ['plugin', 'name'], ['plugin', 'signed'], ['plugin', '$count(tags)'], ['plugin', 'metadata.aws:cdk:codebuild:buildenvironment:privileged'],
    ['plugin', '$keys(env)'], ['pipeline', 'pipelineName'], ['pipeline', 'props.stages'], ['pipeline', '$count(props.stages)'],
    ['pipeline', 'stepFacts.testSteps'], ['pipeline', 'labels.team'],
  ] as const)('%s accepts %s', (target, field) => {
    expect(ruleFieldError(target, field)).toBeNull();
  });

  it.each([
    ['pipeline', 'timeoutInMinutes'], ['pipeline', 'name'], ['pipeline', '$count(stages)'], ['pipeline', 'stepFacts.unknown'],
    ['plugin', 'privileged'], ['plugin', 'pipelineName'], ['plugin', 'metadata'.slice(0, 4)],
  ] as const)('%s refuses %s', (target, field) => {
    expect(ruleFieldError(target, field)).toMatch(/is not a field a (plugin|pipeline) has/);
  });

  it('an open root is readable only below it, and a listed leaf is not open', () => {
    expect(ruleFieldError('pipeline', 'props')).toBeNull();
    expect(ruleFieldError('pipeline', 'propsX.y')).not.toBeNull();
    expect(ruleFieldError('plugin', 'name.first')).not.toBeNull();
  });

  it('refuses an unknown field function', () => {
    expect(ruleFieldError('plugin', '$sum(keywords)')).toBe('Unknown field function "$sum()"; use one of $count(), $length(), $keys(), $lines()');
  });

  it('parseRuleField splits a computed field', () => {
    expect(parseRuleField('$count(props.stages)')).toEqual({ fn: 'count', path: 'props.stages' });
    expect(parseRuleField('name')).toEqual({ path: 'name' });
  });

  it('lists each path once per target', () => {
    for (const fields of Object.values(RULE_FIELDS)) {
      const paths = fields.map((f) => f.path);
      expect(new Set(paths).size).toBe(paths.length);
    }
  });
});

describe('pickRuleAttributes', () => {
  it('copies the stored fields rules read and nothing else', () => {
    const picked = pickRuleAttributes('pipeline', {
      id: 'p1', orgId: 'o', pipelineName: 'n', description: 'd', props: { stages: [] }, ownerId: 'u', links: [], deletedAt: null,
    });
    expect(picked).toEqual({ pipelineName: 'n', description: 'd', props: { stages: [] }, ownerId: 'u' });
  });

  it('never copies a derived field from the caller', () => {
    const picked = pickRuleAttributes('plugin', { name: 'x', signed: true, scanned: true, tags: ['t'] });
    expect(picked).toEqual({ name: 'x' });
    expect(pickRuleAttributes('pipeline', { pipelineName: 'n', stepFacts: { testSteps: 9 } })).toEqual({ pipelineName: 'n' });
  });

  it('skips fields the source does not have', () => {
    expect(pickRuleAttributes('plugin', { name: 'x', description: undefined })).toEqual({ name: 'x' });
  });
});
