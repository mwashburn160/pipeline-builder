jest.mock('child_process');

import { execSync } from 'child_process';
import { checkCdkAvailable, executeCdkShellCommand } from '../src/utils/cdk-utils';

const mockExecSync = execSync as jest.MockedFunction<typeof execSync>;

describe('checkCdkAvailable', () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  it('should return true when cdk --version succeeds', () => {
    mockExecSync.mockReturnValue(Buffer.from('2.240.0'));
    expect(checkCdkAvailable()).toBe(true);
    expect(mockExecSync).toHaveBeenCalledWith('cdk --version', { stdio: 'ignore' });
  });

  it('should return false when cdk --version throws', () => {
    mockExecSync.mockImplementation(() => {
      throw new Error('command not found');
    });
    expect(checkCdkAvailable()).toBe(false);
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
      expect.objectContaining({ stdio: 'inherit' }),
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
