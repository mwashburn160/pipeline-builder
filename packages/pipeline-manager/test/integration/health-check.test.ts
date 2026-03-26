/**
 * Integration tests for pipeline-manager.
 *
 * These tests require a running platform instance.
 * Skip if PLATFORM_BASE_URL is not set.
 *
 * Run with: PLATFORM_BASE_URL=https://localhost:8443 npx jest test/integration/
 */

const PLATFORM_URL = process.env.PLATFORM_BASE_URL;

const describeIfPlatform = PLATFORM_URL ? describe : describe.skip;

describeIfPlatform('integration: platform health', () => {
  it('should reach the platform health endpoint', async () => {
    const response = await fetch(`${PLATFORM_URL}/health`, {
      signal: AbortSignal.timeout(10000),
    });
    expect(response.ok).toBe(true);
  });

  it('should reject invalid credentials', async () => {
    const response = await fetch(`${PLATFORM_URL}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier: 'invalid@test.com', password: 'wrong' }),
      signal: AbortSignal.timeout(10000),
    });
    expect(response.status).toBeGreaterThanOrEqual(400);
  });
});

describeIfPlatform('integration: API requires authentication', () => {
  it('should reject unauthenticated pipeline list request', async () => {
    const response = await fetch(`${PLATFORM_URL}/api/pipelines`, {
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(10000),
    });
    expect(response.status).toBe(401);
  });

  it('should reject unauthenticated plugin list request', async () => {
    const response = await fetch(`${PLATFORM_URL}/api/plugins`, {
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(10000),
    });
    expect(response.status).toBe(401);
  });
});

const PLATFORM_TOKEN = process.env.PLATFORM_TOKEN;
const describeIfAuth = (PLATFORM_URL && PLATFORM_TOKEN) ? describe : describe.skip;

describeIfAuth('integration: authenticated API', () => {
  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${PLATFORM_TOKEN}`,
  };

  it('should list pipelines', async () => {
    const response = await fetch(`${PLATFORM_URL}/api/pipelines`, {
      headers,
      signal: AbortSignal.timeout(10000),
    });
    expect(response.ok).toBe(true);
    const data = await response.json() as Record<string, unknown>;
    expect(data.success).toBe(true);
  });

  it('should list plugins', async () => {
    const response = await fetch(`${PLATFORM_URL}/api/plugins`, {
      headers,
      signal: AbortSignal.timeout(10000),
    });
    expect(response.ok).toBe(true);
    const data = await response.json() as Record<string, unknown>;
    expect(data.success).toBe(true);
  });

  it('should generate a token', async () => {
    const response = await fetch(`${PLATFORM_URL}/api/user/generate-token`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ expiresIn: 3600 }),
      signal: AbortSignal.timeout(10000),
    });
    expect(response.ok).toBe(true);
    const data = await response.json() as Record<string, unknown>;
    const inner = (data.data || data) as Record<string, unknown>;
    expect(inner.accessToken).toBeDefined();
  });
});
