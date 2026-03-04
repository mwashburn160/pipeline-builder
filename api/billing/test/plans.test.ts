/**
 * Tests for billing plans routes.
 *
 * Uses mocks for Mongoose models and api-core utilities.
 */

// Mocks — must be defined before imports
const mockSendSuccess = jest.fn();
const mockSendError = jest.fn();

jest.mock('@mwashburn160/api-core', () => ({
  sendSuccess: mockSendSuccess,
  sendError: mockSendError,
  ErrorCode: {
    MISSING_REQUIRED_FIELD: 'MISSING_REQUIRED_FIELD',
    NOT_FOUND: 'NOT_FOUND',
    INTERNAL_ERROR: 'INTERNAL_ERROR',
  },
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }),
  getParam: jest.fn((params: Record<string, string>, key: string) => params[key]),
  errorMessage: jest.fn((e: unknown) => (e instanceof Error ? e.message : String(e))),
}));

const mockPlanFind = jest.fn();
const mockPlanFindOne = jest.fn();

jest.mock('../src/models/plan', () => ({
  Plan: {
    find: mockPlanFind,
    findOne: mockPlanFindOne,
  },
}));

import { createReadPlanRoutes } from '../src/routes/read-plans';

const planRouter = createReadPlanRoutes();

// Helpers

function mockReq(overrides: Record<string, unknown> = {}): any {
  return { params: {}, query: {}, headers: {}, ...overrides };
}

function mockRes(): any {
  const res: any = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

/** Extract the handler for a specific route/method from the router. */
function getHandler(method: string, path: string) {
  const layer = (planRouter as any).stack.find(
    (l: any) => l.route?.path === path && l.route?.methods[method],
  );
  if (!layer) throw new Error(`No handler for ${method.toUpperCase()} ${path}`);
  return layer.route.stack[0].handle;
}

// Tests

describe('GET /plans', () => {
  const handler = getHandler('get', '/plans');

  beforeEach(() => jest.clearAllMocks());

  it('returns all active plans', async () => {
    const plans = [
      { _id: 'dev', name: 'Developer', description: 'Free tier', tier: 'developer', prices: { monthly: 0, annual: 0 }, features: ['Basic'], isDefault: true, sortOrder: 0 },
      { _id: 'pro', name: 'Pro', description: 'Pro tier', tier: 'pro', prices: { monthly: 999, annual: 9999 }, features: ['All'], isDefault: false, sortOrder: 1 },
    ];

    mockPlanFind.mockReturnValue({ sort: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue(plans) }) });

    const req = mockReq();
    const res = mockRes();
    await handler(req, res);

    expect(mockSendSuccess).toHaveBeenCalledWith(res, 200, {
      plans: expect.arrayContaining([
        expect.objectContaining({ id: 'dev', name: 'Developer' }),
        expect.objectContaining({ id: 'pro', name: 'Pro' }),
      ]),
      total: 2,
    });
  });

  it('returns empty array when no plans exist', async () => {
    mockPlanFind.mockReturnValue({ sort: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue([]) }) });

    const req = mockReq();
    const res = mockRes();
    await handler(req, res);

    expect(mockSendSuccess).toHaveBeenCalledWith(res, 200, { plans: [], total: 0 });
  });

  it('returns 500 on database error', async () => {
    mockPlanFind.mockReturnValue({ sort: jest.fn().mockReturnValue({ lean: jest.fn().mockRejectedValue(new Error('DB error')) }) });

    const req = mockReq();
    const res = mockRes();
    await handler(req, res);

    expect(mockSendError).toHaveBeenCalledWith(res, 500, 'Failed to list plans', 'INTERNAL_ERROR');
  });
});

describe('GET /plans/:planId', () => {
  const handler = getHandler('get', '/plans/:planId');

  beforeEach(() => jest.clearAllMocks());

  it('returns a plan by ID', async () => {
    const plan = { _id: 'dev', name: 'Developer', description: 'Free tier', tier: 'developer', prices: { monthly: 0, annual: 0 }, features: ['Basic'], isDefault: true, sortOrder: 0 };
    mockPlanFindOne.mockReturnValue({ lean: jest.fn().mockResolvedValue(plan) });

    const req = mockReq({ params: { planId: 'dev' } });
    const res = mockRes();
    await handler(req, res);

    expect(mockSendSuccess).toHaveBeenCalledWith(res, 200, {
      plan: expect.objectContaining({ id: 'dev', name: 'Developer' }),
    });
  });

  it('returns 404 for missing plan', async () => {
    mockPlanFindOne.mockReturnValue({ lean: jest.fn().mockResolvedValue(null) });

    const req = mockReq({ params: { planId: 'nonexistent' } });
    const res = mockRes();
    await handler(req, res);

    expect(mockSendError).toHaveBeenCalledWith(res, 404, 'Plan not found', 'NOT_FOUND');
  });

  it('returns 400 for missing planId', async () => {
    const req = mockReq({ params: {} });
    const res = mockRes();
    await handler(req, res);

    expect(mockSendError).toHaveBeenCalledWith(res, 400, 'Plan ID is required', 'MISSING_REQUIRED_FIELD');
  });

  it('returns 500 on database error', async () => {
    mockPlanFindOne.mockReturnValue({ lean: jest.fn().mockRejectedValue(new Error('DB error')) });

    const req = mockReq({ params: { planId: 'dev' } });
    const res = mockRes();
    await handler(req, res);

    expect(mockSendError).toHaveBeenCalledWith(res, 500, 'Failed to get plan', 'INTERNAL_ERROR');
  });
});
