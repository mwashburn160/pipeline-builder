// Mock uuid (ESM-only module) and createLogger (Winston open handles) before imports
jest.mock('uuid', () => ({
  v7: () => 'mock-uuid-v7',
}));
jest.mock('@mwashburn160/api-core', () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }),
}));

import { hasContext } from '../src/api/context-middleware';

describe('hasContext', () => {
  it('should return true when context is defined', () => {
    const req = { context: { requestId: '123', identity: {}, log: jest.fn() } } as any;
    expect(hasContext(req)).toBe(true);
  });

  it('should return false when context is undefined', () => {
    const req = {} as any;
    expect(hasContext(req)).toBe(false);
  });

  it('should return false when context is explicitly undefined', () => {
    const req = { context: undefined } as any;
    expect(hasContext(req)).toBe(false);
  });
});
