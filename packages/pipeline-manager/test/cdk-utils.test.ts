// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

jest.mock('child_process');

import path from 'path';
import { execSync } from 'child_process';
import {
  checkCdkAvailable,
  ensureCdkAvailable,
  executeCdkShellCommand,
  getCdkInfo,
  resolveBoilerplatePath,
} from '../src/utils/cdk-utils';

const mockExecSync = execSync as jest.MockedFunction<typeof execSync>;

describe('getCdkInfo', () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  it('should return available and version when cdk --version succeeds', () => {
    mockExecSync.mockReturnValue('2.240.0' as any);
    const info = getCdkInfo();
    expect(info.available).toBe(true);
    expect(info.version).toBe('2.240.0');
    expect(mockExecSync).toHaveBeenCalledWith('cdk --version', { encoding: 'utf-8', stdio: 'pipe' });
  });

  it('should return unavailable with error when cdk --version throws', () => {
    mockExecSync.mockImplementation(() => {
      throw new Error('command not found');
    });
    const info = getCdkInfo();
    expect(info.available).toBe(false);
    expect(info.version).toBeNull();
    expect(info.error).toBe('command not found');
  });
});

describe('checkCdkAvailable', () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  it('should return true when cdk is available', () => {
    mockExecSync.mockReturnValue('2.240.0' as any);
    expect(checkCdkAvailable()).toBe(true);
  });

  it('should return false when cdk is not available', () => {
    mockExecSync.mockImplementation(() => {
      throw new Error('command not found');
    });
    expect(checkCdkAvailable()).toBe(false);
  });
});

describe('ensureCdkAvailable', () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  it('should return void when cdk is available', () => {
    mockExecSync.mockReturnValue('2.240.0' as any);
    expect(() => ensureCdkAvailable()).not.toThrow();
  });

  it('should throw when cdk is not available', () => {
    const consoleSpy = jest.spyOn(console, 'log').mockImplementation();
    mockExecSync.mockImplementation(() => {
      throw new Error('command not found');
    });
    expect(() => ensureCdkAvailable()).toThrow('AWS CDK not found');
    consoleSpy.mockRestore();
  });

  it('should print install hint when cdk is missing', () => {
    const consoleSpy = jest.spyOn(console, 'log').mockImplementation();
    mockExecSync.mockImplementation(() => {
      throw new Error('command not found');
    });
    try { ensureCdkAvailable(); } catch { /* expected */ }
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('npm install -g aws-cdk'),
    );
    consoleSpy.mockRestore();
  });
});

describe('resolveBoilerplatePath', () => {
  it('should resolve boilerplate.js as a sibling of the caller directory parent', () => {
    const callerDir = '/usr/local/lib/node_modules/@pipeline-builder/pipeline-manager/dist/commands';
    expect(resolveBoilerplatePath(callerDir))
      .toBe(path.join(callerDir, '..', 'boilerplate.js'));
  });

  it('should produce an absolute path when given an absolute caller', () => {
    const result = resolveBoilerplatePath('/abs/path/dist/commands');
    expect(path.isAbsolute(result)).toBe(true);
    expect(result.endsWith('boilerplate.js')).toBe(true);
  });
});

describe('executeCdkShellCommand', () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  it('should execute command with inherited stdio by default', () => {
    mockExecSync.mockReturnValue(Buffer.from(''));
    const result = executeCdkShellCommand('cdk bootstrap aws://123/us-east-1');

    expect(result.success).toBe(true);
    expect(typeof result.duration).toBe('number');
    expect(mockExecSync).toHaveBeenCalledWith(
      'cdk bootstrap aws://123/us-east-1',
      expect.objectContaining({ stdio: ['inherit', 'inherit', 'pipe'] }),
    );
  });

  it('should use pipe stdio when showOutput is false', () => {
    mockExecSync.mockReturnValue(Buffer.from(''));
    executeCdkShellCommand('cdk synth', { showOutput: false });

    expect(mockExecSync).toHaveBeenCalledWith(
      'cdk synth',
      expect.objectContaining({ stdio: 'pipe' }),
    );
  });

  it('should merge extra env vars into process.env', () => {
    mockExecSync.mockReturnValue(Buffer.from(''));
    executeCdkShellCommand('cdk deploy', { env: { PIPELINE_PROPS: 'abc123' } });

    const callArgs = mockExecSync.mock.calls[0]![1] as { env: Record<string, string> };
    expect(callArgs.env.PIPELINE_PROPS).toBe('abc123');
  });

  it('should return duration in milliseconds', () => {
    mockExecSync.mockReturnValue(Buffer.from(''));
    const result = executeCdkShellCommand('cdk bootstrap aws://123/us-east-1');

    expect(result.duration).toBeGreaterThanOrEqual(0);
  });

  it('should throw on execution failure', () => {
    mockExecSync.mockImplementation(() => {
      throw new Error('CDK failed');
    });

    expect(() => executeCdkShellCommand('cdk deploy')).toThrow('CDK failed');
  });

  it('should log error to stderr when debug is true and command fails', () => {
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation();
    mockExecSync.mockImplementation(() => {
      throw new Error('CDK failed');
    });

    expect(() => executeCdkShellCommand('cdk deploy', { debug: true })).toThrow('CDK failed');
    expect(consoleSpy).toHaveBeenCalledWith('CDK execution failed:', expect.any(Error));
    consoleSpy.mockRestore();
  });

  it('should not log error when debug is false and command fails', () => {
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation();
    mockExecSync.mockImplementation(() => {
      throw new Error('CDK failed');
    });

    expect(() => executeCdkShellCommand('cdk deploy', { debug: false })).toThrow('CDK failed');
    expect(consoleSpy).not.toHaveBeenCalled();
    consoleSpy.mockRestore();
  });
});
