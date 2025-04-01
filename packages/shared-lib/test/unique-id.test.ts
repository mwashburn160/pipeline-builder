import { describe, expect, test } from '@jest/globals';
import { UniqueId } from '../src/unique-id';

describe('UniqueId', () => {
  test('generate unique id', () => {
    let uniqueId = new UniqueId('organization', 'project');
    let id = uniqueId.generate('id');
    expect(id).toBe('A180509F');
  });

  test('generate unique id with specific length', () => {
    let uniqueId = new UniqueId('organization', 'project');
    let id = uniqueId.generate('id', 10);
    expect(id).toBe('A180509FA4');
  });
})

