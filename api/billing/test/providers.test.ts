/**
 * Tests for payment providers and provider factory.
 */

jest.mock('@mwashburn160/api-core', () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }),
}));

import { StubPaymentProvider } from '../src/providers/stub-provider';

describe('StubPaymentProvider', () => {
  const provider = new StubPaymentProvider();

  it('createCustomer returns stub customer ID', async () => {
    const id = await provider.createCustomer('org-1', 'user@example.com');
    expect(id).toBe('stub_cus_org-1');
  });

  it('createSubscription returns stub external IDs', async () => {
    const result = await provider.createSubscription('cus-1', 'pro', 'monthly');
    expect(result.externalId).toMatch(/^stub_sub_/);
    expect(result.externalCustomerId).toBe('cus-1');
  });

  it('cancelSubscription resolves without error', async () => {
    await expect(provider.cancelSubscription('sub-1')).resolves.toBeUndefined();
  });

  it('updateSubscription resolves without error', async () => {
    await expect(provider.updateSubscription('sub-1', 'enterprise')).resolves.toBeUndefined();
  });

  it('reactivateSubscription resolves without error', async () => {
    await expect(provider.reactivateSubscription('sub-1')).resolves.toBeUndefined();
  });
});
