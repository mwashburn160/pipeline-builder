// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { AIGenerateBodySchema, PluginDeployGeneratedSchema } from '../src/validation/ai-schemas';

describe('AIGenerateBodySchema', () => {
  const validBody = {
    prompt: 'Build a Node.js pipeline with testing',
    provider: 'anthropic',
    model: 'claude-sonnet-4-20250514',
  };

  it('accepts a valid body', () => {
    const result = AIGenerateBodySchema.safeParse(validBody);
    expect(result.success).toBe(true);
  });

  it('accepts body with optional apiKey', () => {
    const result = AIGenerateBodySchema.safeParse({ ...validBody, apiKey: 'sk-123' });
    expect(result.success).toBe(true);
  });

  it('rejects empty prompt', () => {
    const result = AIGenerateBodySchema.safeParse({ ...validBody, prompt: '' });
    expect(result.success).toBe(false);
  });

  it('rejects prompt exceeding 5000 characters', () => {
    const result = AIGenerateBodySchema.safeParse({ ...validBody, prompt: 'x'.repeat(5001) });
    expect(result.success).toBe(false);
  });

  it('accepts prompt at exactly 5000 characters', () => {
    const result = AIGenerateBodySchema.safeParse({ ...validBody, prompt: 'x'.repeat(5000) });
    expect(result.success).toBe(true);
  });

  it('rejects missing provider', () => {
    const result = AIGenerateBodySchema.safeParse({ prompt: 'test', model: 'gpt-4o' });
    expect(result.success).toBe(false);
  });

  it('rejects missing model', () => {
    const result = AIGenerateBodySchema.safeParse({ prompt: 'test', provider: 'openai' });
    expect(result.success).toBe(false);
  });

  it('rejects empty apiKey', () => {
    const result = AIGenerateBodySchema.safeParse({ ...validBody, apiKey: '' });
    expect(result.success).toBe(false);
  });
});

describe('PluginDeployGeneratedSchema', () => {
  const validBody = {
    name: 'python-linter',
    version: '1.0.0',
    commands: ['pylint src/'],
    dockerfile: 'FROM python:3.12\nRUN pip install pylint',
  };

  it('accepts a valid body', () => {
    const result = PluginDeployGeneratedSchema.safeParse(validBody);
    expect(result.success).toBe(true);
  });

  it('applies default pluginType', () => {
    const result = PluginDeployGeneratedSchema.parse(validBody);
    expect(result.pluginType).toBe('CodeBuildStep');
  });

  it('applies default computeType', () => {
    const result = PluginDeployGeneratedSchema.parse(validBody);
    expect(result.computeType).toBe('MEDIUM');
  });

  it('applies default accessModifier', () => {
    const result = PluginDeployGeneratedSchema.parse(validBody);
    expect(result.accessModifier).toBe('private');
  });

  it('requires at least one command', () => {
    const result = PluginDeployGeneratedSchema.safeParse({ ...validBody, commands: [] });
    expect(result.success).toBe(false);
  });

  it('rejects missing name', () => {
    const { name: _, ...rest } = validBody;
    const result = PluginDeployGeneratedSchema.safeParse(rest);
    expect(result.success).toBe(false);
  });

  it('rejects missing version', () => {
    const { version: _, ...rest } = validBody;
    const result = PluginDeployGeneratedSchema.safeParse(rest);
    expect(result.success).toBe(false);
  });

  it('rejects missing dockerfile', () => {
    const { dockerfile: _, ...rest } = validBody;
    const result = PluginDeployGeneratedSchema.safeParse(rest);
    expect(result.success).toBe(false);
  });

  it('accepts optional fields', () => {
    const result = PluginDeployGeneratedSchema.safeParse({
      ...validBody,
      description: 'A linter plugin',
      keywords: ['python', 'lint'],
      env: { PYTHON_VERSION: '3.12' },
      buildArgs: { PIP_NO_CACHE_DIR: '1' },
      primaryOutputDirectory: './reports',
      installCommands: ['pip install -r requirements.txt'],
    });
    expect(result.success).toBe(true);
  });
});
