import {
  isPluginFilter,
  isPipelineFilter,
  validateCommonFilter,
  validatePluginFilter,
  validatePipelineFilter,
  sanitizeFilter,
  mergeFilters,
  filterToQueryString,
  createDefaultFilter,
  FilterBuilder,
  PluginFilterBuilder,
  PipelineFilterBuilder,
} from '../src/core/query-filters';
import type { CommonFilter, PluginFilter, PipelineFilter } from '../src/core/query-filters';

// ---------------------------------------------------------------------------
// Type Guards
// ---------------------------------------------------------------------------
describe('isPluginFilter', () => {
  it('should return true for filters with plugin-specific fields', () => {
    expect(isPluginFilter({ name: 'test' } as PluginFilter)).toBe(true);
    expect(isPluginFilter({ version: '1.0.0' } as PluginFilter)).toBe(true);
    expect(isPluginFilter({ imageTag: 'latest' } as PluginFilter)).toBe(true);
  });

  it('should return false for filters without plugin fields', () => {
    expect(isPluginFilter({ id: '123' })).toBe(false);
    expect(isPluginFilter({ isActive: true })).toBe(false);
  });
});

describe('isPipelineFilter', () => {
  it('should return true for filters with pipeline-specific fields', () => {
    expect(isPipelineFilter({ project: 'my-app' } as PipelineFilter)).toBe(true);
    expect(isPipelineFilter({ organization: 'my-org' } as PipelineFilter)).toBe(true);
    expect(isPipelineFilter({ pipelineName: 'deploy' } as PipelineFilter)).toBe(true);
  });

  it('should return false for filters without pipeline fields', () => {
    expect(isPipelineFilter({ id: '123' })).toBe(false);
    expect(isPipelineFilter({ isActive: true })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------
describe('validateCommonFilter', () => {
  it('should pass for valid filter', () => {
    expect(() => validateCommonFilter({ limit: 10, offset: 0, sort: 'name:asc' })).not.toThrow();
  });

  it('should pass for empty filter', () => {
    expect(() => validateCommonFilter({})).not.toThrow();
  });

  it('should reject limit < 1', () => {
    expect(() => validateCommonFilter({ limit: 0 })).toThrow('limit must be an integer between 1 and 1000');
  });

  it('should reject limit > 1000', () => {
    expect(() => validateCommonFilter({ limit: 1001 })).toThrow('limit must be an integer between 1 and 1000');
  });

  it('should reject negative offset', () => {
    expect(() => validateCommonFilter({ offset: -1 })).toThrow('offset must be a non-negative integer');
  });

  it('should reject invalid sort format', () => {
    expect(() => validateCommonFilter({ sort: 'invalid' })).toThrow('sort must be in format');
  });

  it('should accept valid sort format', () => {
    expect(() => validateCommonFilter({ sort: 'createdAt:desc' })).not.toThrow();
    expect(() => validateCommonFilter({ sort: 'name:asc' })).not.toThrow();
  });

  it('should accept string limit (coerced)', () => {
    expect(() => validateCommonFilter({ limit: '10' as any })).not.toThrow();
  });
});

describe('validatePluginFilter', () => {
  it('should validate common and plugin-specific fields', () => {
    expect(() => validatePluginFilter({ name: 'test', version: '1.0.0' })).not.toThrow();
  });

  it('should reject invalid version format', () => {
    expect(() => validatePluginFilter({ version: 'not-semver' })).toThrow('Invalid version format');
  });

  it('should accept semantic versions with prefix', () => {
    expect(() => validatePluginFilter({ version: '^2.0.0' })).not.toThrow();
    expect(() => validatePluginFilter({ version: '~1.2.3' })).not.toThrow();
  });

  it('should reject versionRange with min > max', () => {
    expect(() => validatePluginFilter({
      versionRange: { min: '2.0.0', max: '1.0.0' },
    })).toThrow('versionRange.min must be less than or equal to versionRange.max');
  });
});

describe('validatePipelineFilter', () => {
  it('should validate common filter properties', () => {
    expect(() => validatePipelineFilter({ limit: 10 })).not.toThrow();
    expect(() => validatePipelineFilter({ limit: 0 })).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Filter utilities
// ---------------------------------------------------------------------------
describe('sanitizeFilter', () => {
  it('should remove undefined and null values', () => {
    const filter = { id: '123', name: undefined, version: null } as unknown as PluginFilter;
    const result = sanitizeFilter(filter);
    expect(result).toEqual({ id: '123' });
  });

  it('should keep falsy non-null values', () => {
    const filter = { isActive: false, offset: 0 } as CommonFilter;
    const result = sanitizeFilter(filter);
    expect(result).toEqual({ isActive: false, offset: 0 });
  });
});

describe('mergeFilters', () => {
  it('should merge multiple filters', () => {
    const result = mergeFilters<PluginFilter>({ id: '1' }, { name: 'test' });
    expect(result).toEqual({ id: '1', name: 'test' });
  });

  it('should let later filters override earlier ones', () => {
    const result = mergeFilters<CommonFilter>({ limit: 10 }, { limit: 20 });
    expect(result).toEqual({ limit: 20 });
  });

  it('should sanitize during merge', () => {
    const result = mergeFilters<PluginFilter>(
      { id: '1', name: undefined } as any,
      { limit: 10 },
    );
    expect(result).toEqual({ id: '1', limit: 10 });
  });
});

describe('filterToQueryString', () => {
  it('should convert filter to query string', () => {
    const qs = filterToQueryString({ id: '123', isActive: true });
    expect(qs).toContain('id=123');
    expect(qs).toContain('isActive=true');
  });

  it('should handle arrays', () => {
    const qs = filterToQueryString({ id: ['a', 'b'] });
    expect(qs).toContain('id=a');
    expect(qs).toContain('id=b');
  });

  it('should handle object values as JSON', () => {
    const filter: PluginFilter = { versionRange: { min: '1.0.0' } };
    const qs = filterToQueryString(filter);
    expect(qs).toContain('versionRange=');
  });
});

describe('createDefaultFilter', () => {
  it('should create filter with default pagination', () => {
    const filter = createDefaultFilter<CommonFilter>();
    expect(filter.limit).toBe(50);
    expect(filter.offset).toBe(0);
    expect(filter.sort).toBe('createdAt:desc');
  });

  it('should apply overrides', () => {
    const filter = createDefaultFilter<CommonFilter>({ limit: 10 });
    expect(filter.limit).toBe(10);
    expect(filter.offset).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// FilterBuilder
// ---------------------------------------------------------------------------
describe('FilterBuilder', () => {
  it('should build filter with chained methods', () => {
    const filter = new FilterBuilder<CommonFilter>()
      .withId('123')
      .withIsActive(true)
      .withLimit(25)
      .withOffset(10)
      .build();

    expect(filter.id).toBe('123');
    expect(filter.isActive).toBe(true);
    expect(filter.limit).toBe(25);
    expect(filter.offset).toBe(10);
  });

  it('should build sort string', () => {
    const filter = new FilterBuilder<CommonFilter>().withSort('name', 'asc').build();
    expect(filter.sort).toBe('name:asc');
  });

  it('should default sort direction to asc', () => {
    const filter = new FilterBuilder<CommonFilter>().withSort('name').build();
    expect(filter.sort).toBe('name:asc');
  });

  it('should throw for invalid limit', () => {
    expect(() => new FilterBuilder<CommonFilter>().withLimit(-1)).toThrow();
    expect(() => new FilterBuilder<CommonFilter>().withLimit(1001)).toThrow();
    expect(() => new FilterBuilder<CommonFilter>().withLimit(1.5)).toThrow();
  });

  it('should throw for invalid offset', () => {
    expect(() => new FilterBuilder<CommonFilter>().withOffset(-1)).toThrow();
    expect(() => new FilterBuilder<CommonFilter>().withOffset(1.5)).toThrow();
  });

  it('should return immutable copy from getFilter', () => {
    const builder = new FilterBuilder<CommonFilter>().withId('123');
    const filter1 = builder.getFilter();
    const filter2 = builder.getFilter();
    expect(filter1).toEqual(filter2);
    expect(filter1).not.toBe(filter2);
  });

  it('should reset builder', () => {
    const builder = new FilterBuilder<CommonFilter>().withId('123').withIsActive(true);
    builder.reset();
    expect(builder.build()).toEqual({});
  });
});

describe('PluginFilterBuilder', () => {
  it('should add plugin-specific fields', () => {
    const filter = new PluginFilterBuilder()
      .withName('nodejs-build')
      .withVersion('1.0.0')
      .withImageTag('latest')
      .build();

    expect(filter.name).toBe('nodejs-build');
    expect(filter.version).toBe('1.0.0');
    expect(filter.imageTag).toBe('latest');
  });

  it('should support name pattern', () => {
    const filter = new PluginFilterBuilder().withNamePattern('nodejs-*').build();
    expect(filter.namePattern).toBe('nodejs-*');
  });

  it('should support version range', () => {
    const filter = new PluginFilterBuilder().withVersionRange('1.0.0', '2.0.0').build();
    expect(filter.versionRange).toEqual({ min: '1.0.0', max: '2.0.0' });
  });
});

describe('PipelineFilterBuilder', () => {
  it('should add pipeline-specific fields', () => {
    const filter = new PipelineFilterBuilder()
      .withProject('my-app')
      .withOrganization('my-org')
      .withPipelineName('deploy')
      .build();

    expect(filter.project).toBe('my-app');
    expect(filter.organization).toBe('my-org');
    expect(filter.pipelineName).toBe('deploy');
  });

  it('should support pattern fields', () => {
    const filter = new PipelineFilterBuilder()
      .withProjectPattern('app-*')
      .withOrganizationPattern('org-*')
      .withPipelineNamePattern('deploy-*')
      .build();

    expect(filter.projectPattern).toBe('app-*');
    expect(filter.organizationPattern).toBe('org-*');
    expect(filter.pipelineNamePattern).toBe('deploy-*');
  });
});
