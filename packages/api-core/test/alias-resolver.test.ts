/**
 * Tests for the alias resolver utility.
 */

import { resolveRecipientAlias, _resetAliasCache } from '../src/utils/alias-resolver';

jest.mock('../src/middleware/auth', () => ({
  SYSTEM_ORG_ID: 'system',
}));

describe('resolveRecipientAlias', () => {
  beforeEach(() => {
    _resetAliasCache();
  });

  afterAll(() => {
    _resetAliasCache();
    delete process.env.SUPPORT_ALIASES;
  });

  it('resolves a configured alias to the system org', () => {
    process.env.SUPPORT_ALIASES = 'support@pipeline-builder,help@pipeline-builder';
    const result = resolveRecipientAlias('support@pipeline-builder');

    expect(result.resolvedOrgId).toBe('system');
    expect(result.wasAlias).toBe(true);
    expect(result.originalValue).toBe('support@pipeline-builder');
  });

  it('resolves aliases case-insensitively', () => {
    process.env.SUPPORT_ALIASES = 'support@pipeline-builder';
    const result = resolveRecipientAlias('Support@Pipeline-Builder');

    expect(result.resolvedOrgId).toBe('system');
    expect(result.wasAlias).toBe(true);
  });

  it('does not resolve unrecognized values', () => {
    process.env.SUPPORT_ALIASES = 'support@pipeline-builder';
    const result = resolveRecipientAlias('other-org');

    expect(result.resolvedOrgId).toBe('other-org');
    expect(result.wasAlias).toBe(false);
    expect(result.originalValue).toBe('other-org');
  });

  it('passes through "system" unchanged', () => {
    process.env.SUPPORT_ALIASES = 'support@pipeline-builder';
    const result = resolveRecipientAlias('system');

    expect(result.resolvedOrgId).toBe('system');
    expect(result.wasAlias).toBe(false);
  });

  it('passes through "*" unchanged', () => {
    process.env.SUPPORT_ALIASES = 'support@pipeline-builder';
    const result = resolveRecipientAlias('*');

    expect(result.resolvedOrgId).toBe('*');
    expect(result.wasAlias).toBe(false);
  });

  it('handles empty SUPPORT_ALIASES gracefully', () => {
    process.env.SUPPORT_ALIASES = '';
    const result = resolveRecipientAlias('support@pipeline-builder');

    expect(result.resolvedOrgId).toBe('support@pipeline-builder');
    expect(result.wasAlias).toBe(false);
  });

  it('handles missing SUPPORT_ALIASES env var', () => {
    delete process.env.SUPPORT_ALIASES;
    const result = resolveRecipientAlias('support@pipeline-builder');

    expect(result.resolvedOrgId).toBe('support@pipeline-builder');
    expect(result.wasAlias).toBe(false);
  });

  it('trims whitespace from aliases', () => {
    process.env.SUPPORT_ALIASES = ' support@pipeline-builder , help@pipeline-builder ';
    const result = resolveRecipientAlias('support@pipeline-builder');

    expect(result.resolvedOrgId).toBe('system');
    expect(result.wasAlias).toBe(true);
  });

  it('supports multiple aliases', () => {
    process.env.SUPPORT_ALIASES = 'support@pipeline-builder,help@pipeline-builder,info@pipeline-builder';

    expect(resolveRecipientAlias('support@pipeline-builder').wasAlias).toBe(true);
    expect(resolveRecipientAlias('help@pipeline-builder').wasAlias).toBe(true);
    expect(resolveRecipientAlias('info@pipeline-builder').wasAlias).toBe(true);
    expect(resolveRecipientAlias('unknown@pipeline-builder').wasAlias).toBe(false);
  });
});

