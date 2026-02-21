import {
  isDebugMode,
  formatFileSize,
  formatDuration,
  generateExecutionId,
  validateBoolean,
  TIMEOUTS,
  FILE_SIZE_LIMITS,
  ENV_VARS,
  STATUS_COLORS,
} from '../src/config/cli.constants';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('cli constants', () => {
  describe('TIMEOUTS', () => {
    it('should have expected timeout values', () => {
      expect(TIMEOUTS.HTTP_REQUEST).toBe(30000);
      expect(TIMEOUTS.CDK_COMMAND).toBe(0);
      expect(TIMEOUTS.HEALTH_CHECK).toBe(5000);
      expect(TIMEOUTS.UPLOAD).toBe(300000);
    });
  });

  describe('FILE_SIZE_LIMITS', () => {
    it('should have expected file size limits', () => {
      expect(FILE_SIZE_LIMITS.PLUGIN).toBe(100 * 1024 * 1024);
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

  describe('STATUS_COLORS', () => {
    it('should define color for each status', () => {
      expect(STATUS_COLORS.success).toBe('green');
      expect(STATUS_COLORS.error).toBe('red');
      expect(STATUS_COLORS.warning).toBe('yellow');
      expect(STATUS_COLORS.info).toBe('cyan');
      expect(STATUS_COLORS.debug).toBe('magenta');
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
    expect(formatFileSize(FILE_SIZE_LIMITS.PLUGIN)).toBe('100.00 MB');
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

  it('should return a 6-character string', () => {
    expect(generateExecutionId()).toHaveLength(6);
  });

  it('should return alphanumeric characters', () => {
    const id = generateExecutionId();
    expect(id).toMatch(/^[A-Z0-9]+$/);
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
