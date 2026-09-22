// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * routes/discounts.ts — every refusal branch of the discount admin +
 * self-service routes, with the discount helpers mocked (discounts.test.ts runs
 * the helpers for real on the happy paths). Money path: each refusal must stop
 * BEFORE any grant, billing event or audit record, and the bearer token must
 * never reach an audit record.
 */

import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { stubModule, type AnyFn } from '@pipeline-builder/api-core/testing';
import { apiCoreMock } from './helpers/mock-api-core.js';

const sendSuccess = jest.fn<AnyFn>();
const sendError = jest.fn<AnyFn>();
const sendBadRequest = jest.fn<AnyFn>();
const pass = (_req: unknown, _res: unknown, next: () => void) => next();

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  recordAudit: record,
  sendSuccess,
  sendError,
  sendBadRequest,
  requireAuth: () => pass,
  requirePermission: () => pass,
  requireSystemAdmin: pass,
  requireOrgAdminAssurance: () => pass,
  audited: () => pass,
  getParam: (params: Record<string, string>, key: string) => params[key],
  parseQueryInt: (v: unknown, d: number) => (v === undefined ? d : parseInt(String(v), 10)),
  parseQueryIntClamped: (v: unknown, d: number) => (v === undefined ? d : parseInt(String(v), 10)),
  parseQueryString: (v: unknown) => (typeof v === 'string' ? v : undefined),
  // The route's body validation outcome is set per request (`__invalid`).
  validateBody: (req: { body?: unknown; __invalid?: string }) => (req.__invalid ? { ok: false, error: req.__invalid } : { ok: true, value: req.body ?? {} }),
}));
jest.unstable_mockModule('@pipeline-builder/api-server', () => stubModule('@pipeline-builder/api-server', {
  withRoute: (fn: AnyFn) => async (req: { user?: { sub?: string } }, res: unknown) => fn({ req, res, orgId: 'org_1', userId: req.user?.sub ?? '' }),
}));

const createBillingEvent = jest.fn<AnyFn>(async () => undefined);
jest.unstable_mockModule('../src/helpers/billing-helpers.js', () => ({ createBillingEvent }));
const parseAuthoringForm = jest.fn<AnyFn>();
const encodeDiscountCode = jest.fn<AnyFn>(() => 'tok');
jest.unstable_mockModule('../src/helpers/discount-code.js', () => ({ parseAuthoringForm, encodeDiscountCode }));
const helpers = {
  discountsEnabled: jest.fn<AnyFn>(() => true),
  withinCeiling: jest.fn<AnyFn>(() => true),
  generateDiscountId: () => 'disc_1',
  resolveRedeemable: jest.fn<AnyFn>(),
  applyDiscountToOrg: jest.fn<AnyFn>(),
  previewDiscountForOrg: jest.fn<AnyFn>(),
  loadManageableSubscription: jest.fn<AnyFn>(),
};
jest.unstable_mockModule('../src/helpers/discount-helpers.js', () => helpers);
jest.unstable_mockModule('../src/helpers/root-org-guard.js', () => ({ refuseTeamBilling: pass }));

const chain = (rows: unknown[]) => ({ sort: () => ({ skip: () => ({ limit: async () => rows }) }) });
const Discount = { create: jest.fn<AnyFn>(), findById: jest.fn<AnyFn>(), findByIdAndUpdate: jest.fn<AnyFn>(), find: jest.fn<AnyFn>(), countDocuments: jest.fn<AnyFn>() };
jest.unstable_mockModule('../src/models/discount.js', () => ({ Discount }));
const record = jest.fn<AnyFn>();

const { createDiscountRoutes } = await import('../src/routes/discounts.js');

type Layer = { route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: AnyFn }> }; handle: AnyFn; regexp?: RegExp };
const router = createDiscountRoutes() as unknown as { stack: Layer[] };
const route = (method: string, path: string) => {
  const layer = router.stack.find((l) => l.route?.path === path && l.route.methods[method])!;
  return layer.route!.stack.at(-1)!.handle;
};
const req = (over: Record<string, unknown> = {}) => ({ user: { sub: 'admin-1' }, params: { id: 'disc_1' }, query: {}, body: {}, ...over });
const call = (method: string, path: string, over: Record<string, unknown> = {}) => route(method, path)(req(over), {});
const discount = (over: Record<string, unknown> = {}) => ({ _id: 'disc_1', value: 10, unit: 'percent', kind: 'once', isActive: true, ...over });

/** No money moved and nothing was recorded. */
const expectNoEffects = () => {
  expect(createBillingEvent).not.toHaveBeenCalled();
  expect(record).not.toHaveBeenCalled();
  expect(sendSuccess).not.toHaveBeenCalled();
};

beforeEach(() => {
  jest.clearAllMocks();
  helpers.discountsEnabled.mockReturnValue(true);
  helpers.withinCeiling.mockReturnValue(true);
  Discount.findById.mockResolvedValue(discount());
  Discount.findByIdAndUpdate.mockResolvedValue(discount({ isActive: false }));
  parseAuthoringForm.mockReturnValue({ value: 10, unit: 'percent', kind: 'once' });
});

describe('the feature gate', () => {
  it('404s every discount path while discounts are disabled, and passes through when enabled', () => {
    const gate = router.stack.find((l) => !l.route)!.handle;
    const next = jest.fn<AnyFn>();
    helpers.discountsEnabled.mockReturnValueOnce(false);
    gate({}, {}, next);
    expect(sendError).toHaveBeenCalledWith({}, 404, 'Discounts are not enabled', 'NOT_FOUND');
    expect(next).not.toHaveBeenCalled();
    gate({}, {}, next);
    expect(next).toHaveBeenCalled();
  });
});

describe('admin: mint', () => {
  it('refuses an invalid body, a malformed code and a value over the ceiling', async () => {
    await call('post', '/admin/discounts', { __invalid: 'code: Required' });
    expect(sendBadRequest).toHaveBeenCalledWith({}, 'code: Required', 'VALIDATION_ERROR');
    parseAuthoringForm.mockReturnValueOnce({ error: 'bad code' });
    await call('post', '/admin/discounts', { body: { code: 'x' } });
    expect(sendError).toHaveBeenCalledWith({}, 400, 'bad code', 'VALIDATION_ERROR');
    helpers.withinCeiling.mockReturnValueOnce(false);
    await call('post', '/admin/discounts', { body: { code: 'PCT90' } });
    expect(sendBadRequest).toHaveBeenLastCalledWith({}, 'Discount value exceeds the configured ceiling', 'DISCOUNT_CEILING_EXCEEDED');
    expect(Discount.create).not.toHaveBeenCalled();
    expectNoEffects();
  });

  it('mints with the upper-cased alias, a redeem-by date and the body campaign over the code\'s', async () => {
    parseAuthoringForm.mockReturnValueOnce({ value: 500, unit: 'dollar', kind: 'recurring', campaign: 'from-code' });
    Discount.create.mockImplementation(async (d: Record<string, unknown>) => ({ ...d, createdAt: new Date(0), redeemBy: d.redeemBy }));
    await call('post', '/admin/discounts', { body: { code: 'USD5', alias: 'launch', campaign: 'spring', redeemBy: '2026-12-31T00:00:00Z', targetOrgId: 'org_t' } });
    expect(Discount.create).toHaveBeenCalledWith(expect.objectContaining({ alias: 'LAUNCH', campaign: 'spring', redeemBy: new Date('2026-12-31T00:00:00Z'), targetOrgId: 'org_t', createdBy: 'admin-1' }));
    expect(createBillingEvent).toHaveBeenCalledWith('org_t', 'discount_generated', expect.anything(), undefined, 'admin-1');
    expect(sendSuccess).toHaveBeenCalledWith({}, 201, { discount: expect.objectContaining({ id: 'disc_1', alias: 'LAUNCH', redeemBy: '2026-12-31T00:00:00.000Z' }) });
  });
});

describe('admin: issue a token (Mode B)', () => {
  it('needs an id, an existing and ACTIVE discount', async () => {
    await call('post', '/admin/discounts/:id/token', { params: {} });
    expect(sendError).toHaveBeenLastCalledWith({}, 400, 'id is required', 'MISSING_REQUIRED_FIELD');
    Discount.findById.mockResolvedValueOnce(null);
    await call('post', '/admin/discounts/:id/token');
    expect(sendError).toHaveBeenLastCalledWith({}, 404, 'Discount not found', 'NOT_FOUND');
    Discount.findById.mockResolvedValueOnce(discount({ isActive: false }));
    await call('post', '/admin/discounts/:id/token');
    expect(sendError).toHaveBeenLastCalledWith({}, 409, 'Cannot issue a token for an inactive discount', 'DISCOUNT_INACTIVE');
    expectNoEffects();
  });

  it('501s (and issues nothing) when the signing key is unavailable', async () => {
    encodeDiscountCode.mockImplementationOnce(() => { throw new Error('no key'); });
    await call('post', '/admin/discounts/:id/token');
    expect(sendError).toHaveBeenCalledWith({}, 501, 'Discount code signing is not configured', 'NOT_IMPLEMENTED');
    expectNoEffects();
  });

  it('binds the token to the target org, and never puts the token in the audit record', async () => {
    Discount.findById.mockResolvedValueOnce(discount({ targetOrgId: 'org_t' }));
    await call('post', '/admin/discounts/:id/token');
    expect(encodeDiscountCode).toHaveBeenCalledWith(expect.objectContaining({ id: 'disc_1', targetOrgId: 'org_t' }));
    expect(JSON.stringify(record.mock.calls)).not.toContain('tok');
    expect(sendSuccess).toHaveBeenCalledWith({}, 200, { token: 'tok' });
  });
});

describe('admin: direct grant (Mode A) and preview', () => {
  it.each([['apply'], ['preview']])('%s: refuses a missing id, an invalid body and an unknown discount', async (verb) => {
    await call('post', `/admin/discounts/:id/${verb}`, { params: {} });
    expect(sendError).toHaveBeenLastCalledWith({}, 400, 'id is required', 'MISSING_REQUIRED_FIELD');
    await call('post', `/admin/discounts/:id/${verb}`, { __invalid: 'targetOrgId: Required' });
    expect(sendBadRequest).toHaveBeenLastCalledWith({}, 'targetOrgId: Required', 'VALIDATION_ERROR');
    Discount.findById.mockResolvedValueOnce(null);
    await call('post', `/admin/discounts/:id/${verb}`, { body: { targetOrgId: 'org_t' } });
    expect(sendError).toHaveBeenLastCalledWith({}, 404, 'Discount not found', 'NOT_FOUND');
    expect(helpers.applyDiscountToOrg).not.toHaveBeenCalled();
    expectNoEffects();
  });

  it('apply: surfaces the helper\'s refusal and records nothing', async () => {
    helpers.applyDiscountToOrg.mockResolvedValueOnce({ ok: false, status: 409, error: 'already applied', code: 'DISCOUNT_ALREADY_APPLIED' });
    await call('post', '/admin/discounts/:id/apply', { body: { targetOrgId: 'org_t' } });
    expect(sendError).toHaveBeenCalledWith({}, 409, 'already applied', 'DISCOUNT_ALREADY_APPLIED');
    expect(record).not.toHaveBeenCalled();
  });

  it('apply: audits the grant against the TARGET org', async () => {
    helpers.applyDiscountToOrg.mockResolvedValueOnce({ ok: true, kind: 'credit', breakdown: { net: 1 } });
    await call('post', '/admin/discounts/:id/apply', { body: { targetOrgId: 'org_t' } });
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ action: 'billing.discount.apply', orgId: 'org_t', details: expect.objectContaining({ via: 'system' }) }));
  });

  it('preview: returns the dry run, or the helper\'s refusal', async () => {
    helpers.previewDiscountForOrg.mockResolvedValueOnce({ ok: false, status: 422, error: 'tier not eligible', code: 'DISCOUNT_NOT_APPLICABLE' });
    await call('post', '/admin/discounts/:id/preview', { body: { targetOrgId: 'org_t' } });
    expect(sendError).toHaveBeenCalledWith({}, 422, 'tier not eligible', 'DISCOUNT_NOT_APPLICABLE');
    helpers.previewDiscountForOrg.mockResolvedValueOnce({ ok: true, kind: 'credit', breakdown: { net: 2 } });
    await call('post', '/admin/discounts/:id/preview', { body: { targetOrgId: 'org_t' } });
    expect(sendSuccess).toHaveBeenCalledWith({}, 200, { applied: 'credit', priceBreakdown: { net: 2 } });
    expect(createBillingEvent).not.toHaveBeenCalled();
  });
});

describe('admin: list / inspect / edit / revoke', () => {
  it('lists with campaign, target and active filters (never tokens)', async () => {
    Discount.find.mockReturnValue(chain([discount({ createdAt: new Date(0) })]));
    Discount.countDocuments.mockResolvedValue(1);
    await call('get', '/admin/discounts', { query: { campaign: 'spring', targetOrgId: 'org_t', active: 'true', limit: '10', offset: '5' } });
    expect(Discount.find).toHaveBeenCalledWith({ campaign: 'spring', targetOrgId: 'org_t', isActive: true });
    expect(sendSuccess).toHaveBeenCalledWith({}, 200, { discounts: [expect.objectContaining({ id: 'disc_1', createdAt: '1970-01-01T00:00:00.000Z' })], pagination: { total: 1, limit: 10, offset: 5 } });
    await call('get', '/admin/discounts', { query: { active: 'false' } });
    expect(Discount.find).toHaveBeenLastCalledWith({ isActive: false });
    await call('get', '/admin/discounts');
    expect(Discount.find).toHaveBeenLastCalledWith({});
  });

  it('inspects one — 400 without an id, 404 when unknown', async () => {
    await call('get', '/admin/discounts/:id', { params: {} });
    expect(sendError).toHaveBeenLastCalledWith({}, 400, 'id is required', 'MISSING_REQUIRED_FIELD');
    Discount.findById.mockResolvedValueOnce(null);
    await call('get', '/admin/discounts/:id');
    expect(sendError).toHaveBeenLastCalledWith({}, 404, 'Discount not found', 'NOT_FOUND');
    await call('get', '/admin/discounts/:id');
    expect(sendSuccess).toHaveBeenCalledWith({}, 200, { discount: expect.objectContaining({ id: 'disc_1' }) });
  });

  it('edit: refuses no id, an invalid body, no updatable field and an unknown discount', async () => {
    await call('put', '/admin/discounts/:id', { params: {} });
    expect(sendError).toHaveBeenLastCalledWith({}, 400, 'id is required', 'MISSING_REQUIRED_FIELD');
    await call('put', '/admin/discounts/:id', { __invalid: 'bad' });
    expect(sendBadRequest).toHaveBeenLastCalledWith({}, 'bad', 'VALIDATION_ERROR');
    await call('put', '/admin/discounts/:id', { body: {} });
    expect(sendError).toHaveBeenLastCalledWith({}, 400, 'No updatable fields provided', 'VALIDATION_ERROR');
    Discount.findByIdAndUpdate.mockResolvedValueOnce(null);
    await call('put', '/admin/discounts/:id', { body: { maxRedemptions: 5 } });
    expect(sendError).toHaveBeenLastCalledWith({}, 404, 'Discount not found', 'NOT_FOUND');
    expectNoEffects();
  });

  it('edit: a plain edit is not a revoke; isActive:false is (event + audit)', async () => {
    Discount.findByIdAndUpdate.mockResolvedValueOnce(discount());
    await call('put', '/admin/discounts/:id', { body: { maxRedemptions: 5, redeemBy: '2027-01-01T00:00:00Z', appliesToTiers: ['pro'] } });
    expect(Discount.findByIdAndUpdate).toHaveBeenCalledWith('disc_1', { $set: { maxRedemptions: 5, redeemBy: new Date('2027-01-01T00:00:00Z'), appliesToTiers: ['pro'] } }, { new: true });
    expect(record).not.toHaveBeenCalled();
    await call('put', '/admin/discounts/:id', { body: { isActive: false } });
    expect(createBillingEvent).toHaveBeenCalledWith('org_1', 'discount_revoked', { discountId: 'disc_1' }, undefined, 'admin-1');
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ action: 'billing.discount.revoke' }));
  });

  it('hard revoke: 400 / 404, then deactivates, emits against the target org and audits', async () => {
    await call('delete', '/admin/discounts/:id', { params: {} });
    expect(sendError).toHaveBeenLastCalledWith({}, 400, 'id is required', 'MISSING_REQUIRED_FIELD');
    Discount.findByIdAndUpdate.mockResolvedValueOnce(null);
    await call('delete', '/admin/discounts/:id');
    expect(sendError).toHaveBeenLastCalledWith({}, 404, 'Discount not found', 'NOT_FOUND');
    expect(record).not.toHaveBeenCalled();
    Discount.findByIdAndUpdate.mockResolvedValueOnce(discount({ isActive: false, targetOrgId: 'org_t' }));
    await call('delete', '/admin/discounts/:id');
    expect(Discount.findByIdAndUpdate).toHaveBeenLastCalledWith('disc_1', { $set: { isActive: false } }, { new: true });
    expect(createBillingEvent).toHaveBeenCalledWith('org_t', 'discount_revoked', { discountId: 'disc_1' }, undefined, 'admin-1');
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ action: 'billing.discount.revoke', targetId: 'disc_1' }));
  });
});

describe('self-service', () => {
  it.each([['/subscriptions/:id/discounts/preview'], ['/subscriptions/:id/discounts']])('%s: refuses an invalid body and an unknown code', async (path) => {
    await call('post', path, { __invalid: 'code: Required' });
    expect(sendBadRequest).toHaveBeenLastCalledWith({}, 'code: Required', 'VALIDATION_ERROR');
    helpers.resolveRedeemable.mockResolvedValueOnce(null);
    await call('post', path, { body: { code: 'NOPE' } });
    expect(sendError).toHaveBeenLastCalledWith({}, 404, 'Invalid or unknown discount code', 'DISCOUNT_NOT_FOUND');
    expectNoEffects();
  });

  it('preview surfaces the helper\'s refusal', async () => {
    helpers.resolveRedeemable.mockResolvedValueOnce(discount());
    helpers.previewDiscountForOrg.mockResolvedValueOnce({ ok: false, status: 409, error: 'exhausted', code: 'DISCOUNT_EXHAUSTED' });
    await call('post', '/subscriptions/:id/discounts/preview', { body: { code: 'X' } });
    expect(sendError).toHaveBeenCalledWith({}, 409, 'exhausted', 'DISCOUNT_EXHAUSTED');
  });

  it('redeem surfaces the helper\'s refusal without auditing, and audits a success as self-service', async () => {
    helpers.resolveRedeemable.mockResolvedValue(discount());
    helpers.applyDiscountToOrg.mockResolvedValueOnce({ ok: false, status: 403, error: 'targeted elsewhere', code: 'DISCOUNT_NOT_APPLICABLE' });
    await call('post', '/subscriptions/:id/discounts', { body: { code: 'X' } });
    expect(sendError).toHaveBeenCalledWith({}, 403, 'targeted elsewhere', 'DISCOUNT_NOT_APPLICABLE');
    expect(record).not.toHaveBeenCalled();
    helpers.applyDiscountToOrg.mockResolvedValueOnce({ ok: true, kind: 'credit', breakdown: {} });
    await call('post', '/subscriptions/:id/discounts', { body: { code: 'X' } });
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ details: expect.objectContaining({ via: 'self-service', affectedOrgId: 'org_1' }) }));
  });

  it('remove: 400 without an id, 404 without a subscription or when the recurring discount is a different one', async () => {
    await call('delete', '/subscriptions/:id/discounts/:discountId', { params: {} });
    expect(sendError).toHaveBeenLastCalledWith({}, 400, 'discountId is required', 'MISSING_REQUIRED_FIELD');
    helpers.loadManageableSubscription.mockResolvedValueOnce(null);
    await call('delete', '/subscriptions/:id/discounts/:discountId', { params: { discountId: 'disc_1' } });
    expect(sendError).toHaveBeenLastCalledWith({}, 404, 'No active subscription', 'NOT_FOUND');
    const save = jest.fn<AnyFn>();
    helpers.loadManageableSubscription.mockResolvedValueOnce({ recurringDiscount: { discountId: 'other' }, save });
    await call('delete', '/subscriptions/:id/discounts/:discountId', { params: { discountId: 'disc_1' } });
    expect(sendError).toHaveBeenLastCalledWith({}, 404, 'No active recurring discount with that id', 'NOT_FOUND');
    expect(save).not.toHaveBeenCalled();
    expectNoEffects();
  });

  it('remove: clears the standing discount, emits and audits', async () => {
    const sub = { _id: { toString: () => 'sub_1' }, recurringDiscount: { discountId: 'disc_1' } as unknown, save: jest.fn<AnyFn>(async () => undefined) };
    helpers.loadManageableSubscription.mockResolvedValueOnce(sub);
    await call('delete', '/subscriptions/:id/discounts/:discountId', { params: { discountId: 'disc_1' } });
    expect(sub.recurringDiscount).toBeNull();
    expect(sub.save).toHaveBeenCalled();
    expect(createBillingEvent).toHaveBeenCalledWith('org_1', 'discount_removed', { discountId: 'disc_1' }, 'sub_1', 'admin-1');
    expect(sendSuccess).toHaveBeenCalledWith({}, 200, { removed: 'disc_1' });
  });
});
