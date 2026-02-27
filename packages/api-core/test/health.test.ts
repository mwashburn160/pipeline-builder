import { createHealthCheck, createHealthRouter } from '../src/routes/health';

// Mock sendSuccess and sendError from response utilities
jest.mock('../src/utils/response', () => ({
  sendSuccess: jest.fn((res: any, statusCode: number, data?: any) => {
    res.status(statusCode).json({ success: true, statusCode, ...data });
  }),
  sendError: jest.fn((res: any, statusCode: number, msg: string, _code?: string, data?: any) => {
    res.status(statusCode).json({ success: false, statusCode, message: msg, ...data });
  }),
}));

function mockReq(): any {
  return {};
}

function mockRes(): any {
  const res: any = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

describe('createHealthCheck', () => {
  it('returns 200 with healthy status', async () => {
    const handler = createHealthCheck({ serviceName: 'test-service' });
    const res = mockRes();

    await handler(mockReq(), res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: true,
        status: 'healthy',
        service: 'test-service',
      }),
    );
  });

  it('includes version when provided', async () => {
    const handler = createHealthCheck({ serviceName: 'test-service', version: '1.2.3' });
    const res = mockRes();

    await handler(mockReq(), res);

    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ version: '1.2.3' }),
    );
  });

  it('returns 503 when a dependency is disconnected', async () => {
    const handler = createHealthCheck({
      serviceName: 'test-service',
      checkDependencies: async () => ({
        database: 'connected',
        cache: 'disconnected',
      }),
    });
    const res = mockRes();

    await handler(mockReq(), res);

    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        status: 'unhealthy',
      }),
    );
  });

  it('returns 200 when all dependencies are connected', async () => {
    const handler = createHealthCheck({
      serviceName: 'test-service',
      checkDependencies: async () => ({
        database: 'connected',
        cache: 'connected',
      }),
    });
    const res = mockRes();

    await handler(mockReq(), res);

    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('returns 503 when checkDependencies throws', async () => {
    const handler = createHealthCheck({
      serviceName: 'test-service',
      checkDependencies: async () => {
        throw new Error('Cannot reach dependency');
      },
    });
    const res = mockRes();

    await handler(mockReq(), res);

    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'unhealthy',
        dependencies: { check: 'disconnected' },
      }),
    );
  });

  it('includes uptime and timestamp', async () => {
    const handler = createHealthCheck({ serviceName: 'test-service' });
    const res = mockRes();

    await handler(mockReq(), res);

    const response = res.json.mock.calls[0][0];
    expect(response.timestamp).toBeDefined();
    expect(typeof response.uptime).toBe('number');
    expect(response.uptime).toBeGreaterThanOrEqual(0);
  });
});

describe('createHealthRouter', () => {
  it('returns a Router instance', () => {
    const router = createHealthRouter({ serviceName: 'test-service' });
    expect(router).toBeDefined();
    expect(typeof router).toBe('function'); // Express Router is a function
  });
});
