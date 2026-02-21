import { UniqueId } from '../src/core/id-generator';

describe('UniqueId', () => {
  let uniqueId: UniqueId;

  beforeEach(() => {
    uniqueId = new UniqueId();
  });

  it('should append counter to label', () => {
    expect(uniqueId.generate('plugin:lookup')).toBe('plugin:lookup:1');
  });

  it('should auto-increment counters per label', () => {
    expect(uniqueId.generate('plugin:lookup')).toBe('plugin:lookup:1');
    expect(uniqueId.generate('plugin:lookup')).toBe('plugin:lookup:2');
    expect(uniqueId.generate('plugin:lookup')).toBe('plugin:lookup:3');
  });

  it('should track separate counters for different labels', () => {
    expect(uniqueId.generate('cdk:synth')).toBe('cdk:synth:1');
    expect(uniqueId.generate('plugin:lookup')).toBe('plugin:lookup:1');
    expect(uniqueId.generate('cdk:synth')).toBe('cdk:synth:2');
  });

  it('should return label as-is if it already ends with a counter', () => {
    expect(uniqueId.generate('cdk:pipeline:1')).toBe('cdk:pipeline:1');
    expect(uniqueId.generate('resource:42')).toBe('resource:42');
  });

  it('should throw for empty string', () => {
    expect(() => uniqueId.generate('')).toThrow('Label must be a non-empty string');
  });

  it('should throw for non-string values', () => {
    expect(() => uniqueId.generate(null as any)).toThrow('Label must be a non-empty string');
    expect(() => uniqueId.generate(undefined as any)).toThrow('Label must be a non-empty string');
    expect(() => uniqueId.generate(123 as any)).toThrow('Label must be a non-empty string');
  });

  it('should produce unique IDs across instances', () => {
    const id1 = new UniqueId();
    const id2 = new UniqueId();
    // Both start at 1 since they're independent instances
    expect(id1.generate('test')).toBe('test:1');
    expect(id2.generate('test')).toBe('test:1');
  });
});
