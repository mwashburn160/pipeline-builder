// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from 'node:fs';
import { describe, it, expect, afterEach } from '@jest/globals';

import {
  isDebugMode,
  formatFileSize,
  formatDuration,
  generateExecutionId,
  validateBoolean,
  validateSort,
  assertShellSafe,
  TIMEOUTS,
  FILE_SIZE_LIMITS,
  ENV_VARS,
  meetsNodeVersionFloor,
  NODE_VERSION_FLOOR,
  pipelineStackName,
  defaultPipelineName,
} from '../src/config/cli.constants.js';

describe('defaultPipelineName', () => {
  it('keeps the name it always had for a clean pair', () => {
    expect(defaultPipelineName('my-org', 'spring-boot')).toBe('my_org-spring_boot-pipeline');
    expect(defaultPipelineName('Acme', 'api')).toBe('acme-api-pipeline');
  });

  it('appends a raw-pair hash for an underscore pair (it would otherwise share the hyphen pair\'s name)', () => {
    expect(defaultPipelineName('acme', 'spring_boot')).toMatch(/^acme-spring_boot-pipeline-[0-9a-f]{8}$/);
    expect(defaultPipelineName('acme', 'spring_boot')).not.toBe(defaultPipelineName('acme', 'spring-boot'));
  });

  it('appends a raw-pair hash for characters outside the clean set', () => {
    const lossy = defaultPipelineName('acme', 'my.app');
    expect(lossy).toMatch(/^acme-my_app-pipeline-[0-9a-f]{8}$/);
    expect(lossy).not.toBe(defaultPipelineName('acme', 'my_app'));
  });
});

describe('pipelineStackName', () => {
  it('lowercases, and leaves an already-clean name exactly as it was (no hash)', () => {
    expect(pipelineStackName('Spring-Boot', 'System')).toBe('spring-boot-system');
    expect(pipelineStackName('spring-boot', 'system')).toBe('spring-boot-system');
    expect(pipelineStackName('api', 'acme')).toBe('api-acme');
  });

  it('rewrites an underscore pair with a hash (CloudFormation allows no `_`), so it never shares the hyphen pair\'s stack', () => {
    expect(pipelineStackName('spring_boot', 'system')).toMatch(/^spring-boot-system-[0-9a-f]{8}$/);
    expect(pipelineStackName('my__app', 'acme_corp')).toMatch(/^my--app-acme-corp-[0-9a-f]{8}$/);
    expect(pipelineStackName('spring_boot', 'system')).not.toBe(pipelineStackName('spring-boot', 'system'));
    // Stable: the same raw pair always derives the same name (case-insensitive).
    expect(pipelineStackName('Spring_Boot', 'System')).toBe(pipelineStackName('spring_boot', 'system'));
  });

  const CFN = /^[A-Za-z][A-Za-z0-9-]*$/;

  it.each([
    ['my.app', 'acme', /^my-app-acme-[0-9a-f]{8}$/],
    ['my app', 'acme', /^my-app-acme-[0-9a-f]{8}$/],
    ['api', 'acme@corp', /^api-acme-corp-[0-9a-f]{8}$/],
    ['2fa-app', 'acme', /^pb-2fa-app-acme-[0-9a-f]{8}$/],
    ['-api', 'acme', /^pb--api-acme-[0-9a-f]{8}$/],
    ['Café', 'Acme', /^caf--acme-[0-9a-f]{8}$/],
  ])('rewrites %j / %j into a CloudFormation-valid name', (project, organization, expected) => {
    const name = pipelineStackName(project, organization);
    expect(name).toMatch(expected);
    expect(name).toMatch(CFN);
    expect(name.length).toBeLessThanOrEqual(128);
  });

  it('keeps rewritten names distinct from the plain name they resemble, and from each other', () => {
    const names = [
      pipelineStackName('my-app', 'acme'),
      pipelineStackName('my.app', 'acme'),
      pipelineStackName('my app', 'acme'),
      pipelineStackName('my@app', 'acme'),
    ];
    expect(new Set(names).size).toBe(names.length);
    expect(pipelineStackName('my.app', 'acme')).toBe(pipelineStackName('My.App', 'ACME'));
  });

  it('keeps a 128-character plain name, and truncates a longer one to 128 with a hash', () => {
    expect(pipelineStackName('a'.repeat(123), 'acme')).toBe(`${'a'.repeat(123)}-acme`);
    const long = pipelineStackName('a'.repeat(124), 'acme');
    expect(long).toHaveLength(128);
    expect(long).toMatch(/^a+-[0-9a-f]{8}$/);
    expect(long).toMatch(CFN);
    expect(pipelineStackName('a'.repeat(200), 'acme')).not.toBe(pipelineStackName('a'.repeat(201), 'acme'));
  });

  it('never ends the truncated base on a hyphen', () => {
    const name = pipelineStackName(`${'a'.repeat(118)}-.`, 'acme');
    expect(name).not.toMatch(/--[0-9a-f]{8}$/);
    expect(name).toMatch(CFN);
  });

  it.each([['', 'acme'], ['api', ''], ['  ', 'acme']])('refuses an empty project or organization (%j / %j)', (project, organization) => {
    expect(() => pipelineStackName(project, organization)).toThrow(/both are required/);
  });
});

// Tests

describe('cli constants', () => {
  describe('TIMEOUTS', () => {
    it('should have expected timeout values', () => {
      expect(TIMEOUTS.HTTP_REQUEST).toBe(30000);
      expect(TIMEOUTS.HEALTH_CHECK).toBe(5000);
    });
  });

  describe('FILE_SIZE_LIMITS', () => {
    it('should have expected file size limits', () => {
      expect(FILE_SIZE_LIMITS.PLUGIN).toBe(4 * 1024 * 1024 * 1024);
      expect(FILE_SIZE_LIMITS.PIPELINE_PROPS).toBe(10 * 1024 * 1024);
    });
  });

  describe('ENV_VARS', () => {
    it('should define all expected env var names', () => {
      expect(ENV_VARS.PLATFORM_TOKEN).toBe('PLATFORM_TOKEN');
      expect(ENV_VARS.PLATFORM_BASE_URL).toBe('PLATFORM_BASE_URL');
      expect(ENV_VARS.CLI_CONFIG_PATH).toBe('CLI_CONFIG_PATH');
      expect(ENV_VARS.DEBUG).toBe('DEBUG');
    });
  });

});

describe('isDebugMode', () => {
  const origDebug = process.env.DEBUG;

  afterEach(() => {
    if (origDebug === undefined) {
      delete process.env.DEBUG;
    } else {
      process.env.DEBUG = origDebug;
    }
  });

  it('should return true when options.debug is true', () => {
    expect(isDebugMode({ debug: true })).toBe(true);
  });

  it('should return false when options.debug is false', () => {
    expect(isDebugMode({ debug: false })).toBe(false);
  });

  it('should fall back to DEBUG env var when no options', () => {
    process.env.DEBUG = 'true';
    expect(isDebugMode()).toBe(true);
  });

  it('should return false when DEBUG env var is not "true"', () => {
    process.env.DEBUG = 'false';
    expect(isDebugMode()).toBe(false);
  });

  it('should return false when no options and no env var', () => {
    delete process.env.DEBUG;
    expect(isDebugMode()).toBe(false);
  });

  it('should prefer options.debug over env var', () => {
    process.env.DEBUG = 'true';
    expect(isDebugMode({ debug: false })).toBe(false);
  });
});

describe('formatFileSize', () => {
  it('should format 0 bytes', () => {
    expect(formatFileSize(0)).toBe('0 B');
  });

  it('should format bytes', () => {
    expect(formatFileSize(500)).toBe('500.00 B');
  });

  it('should format kilobytes', () => {
    expect(formatFileSize(1024)).toBe('1.00 KB');
    expect(formatFileSize(1536)).toBe('1.50 KB');
  });

  it('should format megabytes', () => {
    expect(formatFileSize(1024 * 1024)).toBe('1.00 MB');
  });

  it('should format gigabytes', () => {
    expect(formatFileSize(1024 * 1024 * 1024)).toBe('1.00 GB');
  });

  it('should format large sizes', () => {
    expect(formatFileSize(FILE_SIZE_LIMITS.PLUGIN)).toBe('4.00 GB');
  });
});

describe('formatDuration', () => {
  it('should format milliseconds', () => {
    expect(formatDuration(500)).toBe('500ms');
    expect(formatDuration(999)).toBe('999ms');
  });

  it('should format seconds', () => {
    expect(formatDuration(1000)).toBe('1.00s');
    expect(formatDuration(2500)).toBe('2.50s');
  });

  it('should format minutes and seconds', () => {
    expect(formatDuration(60000)).toBe('1m 0s');
    expect(formatDuration(90000)).toBe('1m 30s');
    expect(formatDuration(125000)).toBe('2m 5s');
  });
});

describe('generateExecutionId', () => {
  it('should return an uppercase string', () => {
    const id = generateExecutionId();
    expect(id).toBe(id.toUpperCase());
  });

  it('should return an 8-character hex string', () => {
    expect(generateExecutionId()).toHaveLength(8);
  });

  it('should return uppercase hex characters', () => {
    const id = generateExecutionId();
    expect(id).toMatch(/^[A-F0-9]+$/);
  });

  it('should generate unique IDs', () => {
    const ids = new Set(Array.from({ length: 20 }, () => generateExecutionId()));
    expect(ids.size).toBeGreaterThan(1);
  });
});

describe('validateBoolean', () => {
  it.each(['true', 'True', 'TRUE', '1', 'yes', 'Yes', 'y', 'Y'])(
    'should return true for "%s"',
    (value) => {
      expect(validateBoolean(value, 'field')).toBe(true);
    },
  );

  it.each(['false', 'False', 'FALSE', '0', 'no', 'No', 'n', 'N'])(
    'should return false for "%s"',
    (value) => {
      expect(validateBoolean(value, 'field')).toBe(false);
    },
  );

  it('should trim whitespace', () => {
    expect(validateBoolean('  true  ', 'field')).toBe(true);
  });

  it('should throw for invalid values', () => {
    expect(() => validateBoolean('maybe', 'myField')).toThrow(
      'Invalid boolean value for myField: "maybe"',
    );
  });

  it('should include field name in error message', () => {
    expect(() => validateBoolean('xyz', 'isActive')).toThrow('isActive');
  });
});

describe('validateSort', () => {
  it('should return valid sort strings', () => {
    expect(validateSort('createdAt:asc')).toBe('createdAt:asc');
    expect(validateSort('name:desc')).toBe('name:desc');
    expect(validateSort('updated_at:asc')).toBe('updated_at:asc');
  });

  it('should return undefined for undefined input', () => {
    expect(validateSort(undefined)).toBeUndefined();
  });

  it('should throw for invalid format', () => {
    expect(() => validateSort('invalid')).toThrow('Invalid sort format');
    expect(() => validateSort('field:up')).toThrow('Invalid sort format');
    expect(() => validateSort(':asc')).toThrow('Invalid sort format');
  });
});

describe('assertShellSafe', () => {
  it('should accept safe strings', () => {
    expect(() => assertShellSafe('my-profile', 'profile')).not.toThrow();
    expect(() => assertShellSafe('us-east-1', 'region')).not.toThrow();
    expect(() => assertShellSafe('123456789012', 'account')).not.toThrow();
    expect(() => assertShellSafe('cdk.out', 'output')).not.toThrow();
  });

  it('should reject strings with shell metacharacters', () => {
    expect(() => assertShellSafe('profile; rm -rf /', 'profile')).toThrow('unsafe characters');
    expect(() => assertShellSafe('$(whoami)', 'field')).toThrow('unsafe characters');
    expect(() => assertShellSafe('`id`', 'field')).toThrow('unsafe characters');
    expect(() => assertShellSafe('a|b', 'field')).toThrow('unsafe characters');
    expect(() => assertShellSafe('a&b', 'field')).toThrow('unsafe characters');
    expect(() => assertShellSafe('a\nb', 'field')).toThrow('unsafe characters');
  });

  it('should include field name in error message', () => {
    expect(() => assertShellSafe('bad;input', 'myField')).toThrow('myField');
  });
});

describe('Node.js version floor', () => {
  it('is read from package.json engines.node (one source for npm and the start-up warning)', () => {
    const engines = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf-8')).engines.node as string;
    expect(engines).toContain(NODE_VERSION_FLOOR);
    expect(NODE_VERSION_FLOOR).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('compares versions component-wise', () => {
    expect(meetsNodeVersionFloor('v26.13.1', '26.13.1')).toBe(true);
    expect(meetsNodeVersionFloor('v26.14.0', '26.13.1')).toBe(true);
    expect(meetsNodeVersionFloor('v27.0.0', '26.13.1')).toBe(true);
    expect(meetsNodeVersionFloor('v26.13.0', '26.13.1')).toBe(false);
    expect(meetsNodeVersionFloor('v24.9.0', '26.13.1')).toBe(false);
    expect(meetsNodeVersionFloor('v26.2.0', '26.13.1')).toBe(false);
  });
});
