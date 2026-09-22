// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The fail-closed guards of anonymous-submission moderation
 * (services/ecosystem/submission-moderation.ts), one by one, against mocked
 * stores: approval publishes the pinned quarantined digest into the community
 * publisher ONLY when every check holds, and any refusal leaves nothing behind
 * (no claim, no image copy, no row). The end-to-end happy path runs in
 * ecosystem-submissions.test.ts; this suite pins each refusal branch so a
 * refactor that drops one fails loudly.
 */

import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { stubModule, type AnyFn } from '@pipeline-builder/api-core/testing';
import { apiCoreMock } from './helpers/mock-api-core.js';

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({ recordAudit: recordAuditMock }));
jest.unstable_mockModule('@pipeline-builder/pipeline-core', () => stubModule('@pipeline-builder/pipeline-core', {
  Config: { get: () => ({ host: 'registry', port: 5000 }) },
}));

class EcosystemError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}
jest.unstable_mockModule('../src/services/ecosystem/context.js', () => ({ EcosystemError }));

const store = {
  atomically: jest.fn<AnyFn>(async (fn: () => Promise<unknown>) => fn()),
  listings: { byId: jest.fn<AnyFn>(), byName: jest.fn<AnyFn>(), insert: jest.fn<AnyFn>(), update: jest.fn<AnyFn>() },
  versions: { countForListing: jest.fn<AnyFn>(), get: jest.fn<AnyFn>(), insert: jest.fn<AnyFn>(), forListings: jest.fn<AnyFn>() },
  requests: { insert: jest.fn<AnyFn>(), list: jest.fn<AnyFn>(), transition: jest.fn<AnyFn>(), byId: jest.fn<AnyFn>() },
  OPEN_STATUSES: ['pending', 'pending_second_approval'],
  previousVersion: jest.fn<AnyFn>(async () => null),
  recomputeLatest: jest.fn<AnyFn>(async () => null),
};
jest.unstable_mockModule('../src/services/ecosystem/store.js', () => store);

const subs = { byId: jest.fn<AnyFn>(), list: jest.fn<AnyFn>(), transition: jest.fn<AnyFn>() };
// The owner lookup's real rule over the mocked rows: the first approved submission's email hash.
const listingOwnerHash = async (listingId: string): Promise<string | null> => {
  const approved = ((await subs.list({ listingId, statuses: ['approved', 'claimed'] })) ?? []) as Array<{ emailHash: string | null; createdAt: string }>;
  return [...approved].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())[0]?.emailHash ?? null;
};
jest.unstable_mockModule('../src/services/ecosystem/submissions-store.js', () => ({ submissions: subs, listingOwnerHash }));

const submissionsMod = {
  dropQuarantineArtifacts: jest.fn<AnyFn>(async () => undefined),
  submissionNameGate: jest.fn<AnyFn>(async () => ({ ok: true })),
};
jest.unstable_mockModule('../src/services/ecosystem/submissions.js', () => submissionsMod);
const configMod = {
  listingUrl: (name: string) => `https://pb/plugins/community/${name}`,
  statusUrl: (t: string) => `https://pb/status?token=${t}`,
  submissionConfig: jest.fn<AnyFn>(() => ({ emailHashSecret: 'secret' })),
};
jest.unstable_mockModule('../src/services/ecosystem/submission-config.js', () => configMod);
const guardsMod = {
  hashEmail: jest.fn<AnyFn>((email: string, secret: string) => `h(${email},${secret})`),
  statusTokenFor: (id: string) => `tok-${id}`,
  submitterEmail: jest.fn<AnyFn>(async () => 'dev@example.com'),
};
jest.unstable_mockModule('../src/services/ecosystem/submission-guards.js', () => guardsMod);

const publishImage = jest.fn<AnyFn>(async () => ({ imageRepository: 'public/community/my-linter' }));
jest.unstable_mockModule('../src/services/ecosystem/registry.js', () => ({ publishImage }));
jest.unstable_mockModule('../src/services/ecosystem/resign.js', () => ({ trustFor: () => 'unverified' }));
const announceNewVersion = jest.fn<AnyFn>(async () => undefined);
jest.unstable_mockModule('../src/services/ecosystem/install-notify.js', () => ({ announceNewVersion }));
jest.unstable_mockModule('../src/services/ecosystem/metadata.js', () => ({
  LISTING_FIELDS: ['summary', 'homepageUrl'],
  listingColumns: (v: Record<string, unknown>) => ({ summary: v.summary ?? null }),
  listingFieldValue: (l: Record<string, unknown>, f: string) => l[f] ?? null,
  // The real row rule over the policy doubles below.
  metadataRow: (field: string, value: unknown, previous: unknown, source: string | null, hasListing: boolean) => {
    const changed = hasListing ? JSON.stringify(value) !== JSON.stringify(previous) : value !== null;
    const isLink = field.endsWith('Url');
    return { field, value, previous, source, changed, userEdited: source === 'user', isLink, highlight: source === 'user' && isLink && changed };
  },
}));
const recordSubmission = jest.fn<AnyFn>();
jest.unstable_mockModule('../src/services/ecosystem/metrics.js', () => ({ recordSubmission }));
const notify = {
  notifySubmissionClaimed: jest.fn<AnyFn>(async () => undefined),
  notifySubmissionDecision: jest.fn<AnyFn>(async () => undefined),
  notifySubmissionQueued: jest.fn<AnyFn>(async () => undefined),
};
jest.unstable_mockModule('../src/services/ecosystem/notify.js', () => notify);
jest.unstable_mockModule('../src/services/ecosystem/policy.js', () => ({
  contractDiff: (a: unknown, b: unknown) => ({ from: a, to: b }),
  isLinkField: (f: string) => f.endsWith('Url'),
  latestVersion: (vs: string[]) => [...vs].sort().at(-1) ?? null,
  sameValue: (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b),
}));
const recordAuditMock = jest.fn<AnyFn>();
jest.unstable_mockModule('../src/helpers/plugin-spec.js', () => ({ specContractFields: () => ({ inputs: [] }) }));
const fetchImageSbom = jest.fn<AnyFn>(async () => ({ spdxVersion: 'SPDX-2.3' }));
jest.unstable_mockModule('../src/helpers/supply-chain.js', () => ({ fetchImageSbom }));
const scanSbom = jest.fn<AnyFn>(async () => ({ critical: 0, high: 1, scannedAt: new Date('2026-09-01T00:00:00Z') }));
jest.unstable_mockModule('../src/helpers/vuln-scan.js', () => ({ scanSbom }));

const mod = await import('../src/services/ecosystem/submission-moderation.js');

const DIGEST = 'sha256:' + 'a'.repeat(64);
const community = { id: 'pub-community', handle: 'community', tier: 'community' } as any;
const facts = {
  imageRepository: 'quarantine/sub-1', digest: DIGEST, vulnCritical: 0, vulnHigh: 0, vulnMedium: 0, vulnLow: 0, scannedAt: '2026-09-01T00:00:00Z', runAsRoot: false,
};
const submission = (over: Record<string, unknown> = {}) => ({
  id: 'sub-1',
  name: 'my-linter',
  version: '1.0.0',
  status: 'pending_review',
  emailHash: 'hash-owner',
  createdAt: '2026-09-01T00:00:00Z',
  verifiedAt: null,
  spec: { pluginType: 'CodeBuildStep' },
  dockerfile: 'FROM alpine',
  heuristics: null,
  catalog: { values: { summary: 'Lints', changelog: 'first' }, sources: { summary: 'detected' } },
  gateReport: { gates: [{ id: 'build', ok: true }], facts, completedAt: '2026-09-01T00:00:00Z' },
  ...over,
}) as any;
const request = (over: Record<string, unknown> = {}) => ({
  id: 'req-1',
  kind: 'submission',
  status: 'pending_second_approval',
  digest: DIGEST,
  version: '1.0.0',
  listingId: null,
  payload: { submissionId: 'sub-1', name: 'my-linter', version: '1.0.0' },
  ...over,
}) as any;
const liveListing = (over: Record<string, unknown> = {}) => ({ id: 'lst-1', name: 'my-linter', state: 'listed', publisherId: community.id, summary: 'Old', ...over }) as any;

/** Nothing that PUBLISHES happened: no claim, no image copy, no write. */
function expectNothingPublished(): void {
  expect(subs.transition).not.toHaveBeenCalled();
  expect(publishImage).not.toHaveBeenCalled();
  expect(store.versions.insert).not.toHaveBeenCalled();
  expect(store.listings.insert).not.toHaveBeenCalled();
}

beforeEach(() => {
  jest.clearAllMocks();
  subs.byId.mockResolvedValue(submission());
  subs.list.mockResolvedValue([]);
  subs.transition.mockResolvedValue({ id: 'sub-1' });
  store.listings.byId.mockResolvedValue(null);
  store.listings.byName.mockResolvedValue(null);
  store.listings.insert.mockImplementation(async (row: Record<string, unknown>) => ({ id: 'lst-new', ...row }));
  store.listings.update.mockImplementation(async (id: string, patch: Record<string, unknown>) => ({ id, name: 'my-linter', ...patch }));
  store.versions.countForListing.mockResolvedValue(0);
  store.versions.get.mockResolvedValue(null);
  store.versions.insert.mockImplementation(async (row: Record<string, unknown>) => ({ id: 'ver-1', ...row }));
  store.versions.forListings.mockResolvedValue([{ version: '1.0.0', yankedAt: null }]);
  store.requests.transition.mockResolvedValue({ id: 'req-1' });
  submissionsMod.submissionNameGate.mockResolvedValue({ ok: true });
  guardsMod.submitterEmail.mockResolvedValue('dev@example.com');
  configMod.submissionConfig.mockReturnValue({ emailHashSecret: 'secret' });
});

describe('publishSubmission — fail-closed guards', () => {
  it('refuses a request that is not on the community publisher', async () => {
    await expect(mod.publishSubmission(request(), { ...community, handle: 'acme' }, 'mod-2'))
      .rejects.toThrow('Submission requests belong to the community publisher.');
    expect(subs.byId).not.toHaveBeenCalled();
    expectNothingPublished();
  });

  it('404s when the request carries no submission id, or the submission is gone', async () => {
    await expect(mod.publishSubmission(request({ payload: {} }), community, 'mod-2')).rejects.toBeInstanceOf(EcosystemError);
    subs.byId.mockResolvedValue(null);
    await expect(mod.publishSubmission(request(), community, 'mod-2')).rejects.toThrow('The submission no longer exists.');
    expectNothingPublished();
  });

  it('refuses a submission that is no longer pending review', async () => {
    subs.byId.mockResolvedValue(submission({ status: 'rejected' }));
    await expect(mod.publishSubmission(request(), community, 'mod-2')).rejects.toThrow('The submission is rejected.');
    expectNothingPublished();
  });

  it.each([
    ['no gate report', { gateReport: null }],
    ['a report without facts', { gateReport: { gates: [{ id: 'build', ok: true }], completedAt: 'x' } }],
    ['a failed gate', { gateReport: { gates: [{ id: 'build', ok: true }, { id: 'scan', ok: false }], facts, completedAt: 'x' } }],
    ['a malformed report (gates not an array)', { gateReport: { gates: 'nope', facts } }],
  ])('refuses %s', async (_label, over) => {
    subs.byId.mockResolvedValue(submission(over));
    await expect(mod.publishSubmission(request(), community, 'mod-2')).rejects.toThrow('The submission has no passing gate report.');
    expectNothingPublished();
  });

  it.each([
    ['the request pinned no digest', { digest: null }],
    ['the quarantined digest moved', { digest: 'sha256:' + 'b'.repeat(64) }],
    ['the version differs from the pinned one', { version: '2.0.0' }],
  ])('fails closed with PLUGIN_DIGEST_MISMATCH when %s', async (_label, over) => {
    const err = await mod.publishSubmission(request(over), community, 'mod-2').catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'PLUGIN_DIGEST_MISMATCH', message: 'The quarantined build no longer matches the digest the request pinned.' });
    expectNothingPublished();
  });

  it('re-runs the name gate at approval and refuses a name that no longer passes', async () => {
    submissionsMod.submissionNameGate.mockResolvedValue({ ok: false, message: 'reserved' });
    const err = await mod.publishSubmission(request(), community, 'mod-2').catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'NAME_TAKEN', message: 'The name no longer passes: reserved' });
    expect(submissionsMod.submissionNameGate).toHaveBeenCalledWith('my-linter', 'hash-owner');
    expectNothingPublished();
  });

  it.each([
    ['suspended', { state: 'suspended' }],
    ['delisted', { state: 'delisted' }],
    ['owned by another publisher', { publisherId: 'pub-acme' }],
  ])('refuses an existing listing that is %s (not live under community)', async (_label, over) => {
    store.listings.byName.mockResolvedValue(liveListing(over));
    await expect(mod.publishSubmission(request(), community, 'mod-2')).rejects.toThrow('community/my-linter is not live under the community publisher.');
    expectNothingPublished();
  });

  it('reads the pinned listing by id when the request carries one', async () => {
    store.listings.byId.mockResolvedValue(liveListing({ state: 'suspended' }));
    await expect(mod.publishSubmission(request({ listingId: 'lst-1' }), community, 'mod-2')).rejects.toThrow('is not live');
    expect(store.listings.byId).toHaveBeenCalledWith('lst-1');
    expect(store.listings.byName).not.toHaveBeenCalled();
  });

  it('refuses to extend a listing whose first approved submission came from another submitter', async () => {
    store.listings.byName.mockResolvedValue(liveListing());
    store.versions.countForListing.mockResolvedValue(2);
    subs.list.mockResolvedValue([
      { emailHash: 'hash-later', createdAt: '2026-08-02T00:00:00Z' },
      { emailHash: 'hash-first-owner', createdAt: '2026-08-01T00:00:00Z' },
    ]);
    await expect(mod.publishSubmission(request(), community, 'mod-2')).rejects.toThrow('community/my-linter belongs to another submitter.');
    expect(subs.list).toHaveBeenCalledWith({ listingId: 'lst-1', statuses: ['approved', 'claimed'] });
    expectNothingPublished();
  });

  it('treats a non-empty listing with NO recorded owner as someone else\'s, not as open', async () => {
    store.listings.byName.mockResolvedValue(liveListing());
    store.versions.countForListing.mockResolvedValue(1);
    subs.list.mockResolvedValue([]);
    await expect(mod.publishSubmission(request(), community, 'mod-2')).rejects.toThrow('belongs to another submitter');
    expectNothingPublished();
  });

  it('refuses a version already published to the listing', async () => {
    store.listings.byName.mockResolvedValue(liveListing());
    store.versions.countForListing.mockResolvedValue(1);
    subs.list.mockResolvedValue([{ emailHash: 'hash-owner', createdAt: '2026-08-01T00:00:00Z' }]);
    store.versions.get.mockResolvedValue({ id: 'ver-old', version: '1.0.0' });
    await expect(mod.publishSubmission(request(), community, 'mod-2')).rejects.toThrow('1.0.0 is already published to community/my-linter.');
    expectNothingPublished();
  });

  it('refuses when the pending_review → publishing claim is lost (expired or decided meanwhile)', async () => {
    subs.transition.mockResolvedValueOnce(null);
    await expect(mod.publishSubmission(request(), community, 'mod-2')).rejects.toThrow('The submission changed state meanwhile (expired or decided); nothing was published.');
    expect(publishImage).not.toHaveBeenCalled();
  });

  it('hands the claim back when the image copy fails, and still surfaces the original error', async () => {
    publishImage.mockRejectedValueOnce(new Error('registry down'));
    subs.transition.mockResolvedValueOnce({ id: 'sub-1' }).mockRejectedValueOnce(new Error('db down'));
    await expect(mod.publishSubmission(request(), community, 'mod-2')).rejects.toThrow('registry down');
    expect(subs.transition).toHaveBeenLastCalledWith('sub-1', 'publishing', { status: 'pending_review' });
    expect(store.versions.insert).not.toHaveBeenCalled();
  });

  it('rolls back and hands the claim back when the final publishing → approved transition loses', async () => {
    subs.transition
      .mockResolvedValueOnce({ id: 'sub-1' }) // claim
      .mockResolvedValueOnce(null) // publishing → approved (inside the tx)
      .mockResolvedValueOnce({ id: 'sub-1' }); // hand-back
    await expect(mod.publishSubmission(request(), community, 'mod-2')).rejects.toThrow('The submission changed state meanwhile; nothing was published.');
    expect(subs.transition).toHaveBeenLastCalledWith('sub-1', 'publishing', { status: 'pending_review' });
    expect(recordAuditMock).not.toHaveBeenCalled();
  });
});

describe('publishSubmission — the approved path', () => {
  it('a NEW listing: creates it, links the request, approves, audits and tells the submitter (no N-announce)', async () => {
    await mod.publishSubmission(request(), community, 'mod-2');
    expect(publishImage).toHaveBeenCalledWith(expect.objectContaining({ sourceRepository: 'quarantine/sub-1', digest: DIGEST, publisherHandle: 'community', publisherOrgId: null }));
    expect(store.listings.insert).toHaveBeenCalledWith(expect.objectContaining({ publisherId: community.id, name: 'my-linter', latestVersion: '1.0.0' }));
    expect(store.requests.transition).toHaveBeenCalledWith('req-1', 'approved', { listingId: 'lst-new' });
    expect(store.versions.insert).toHaveBeenCalledWith(expect.objectContaining({ listingId: 'lst-new', breaking: false, changelog: 'first', publishedBy: 'mod-2' }));
    expect(subs.transition).toHaveBeenCalledWith('sub-1', 'publishing', expect.objectContaining({ status: 'approved', listingId: 'lst-new', decidedBy: 'mod-2', reason: null }));
    expect(recordAuditMock).toHaveBeenCalledWith(expect.objectContaining({ action: 'plugin.submission.approve' }));
    expect(recordSubmission).toHaveBeenCalledWith('approved');
    expect(notify.notifySubmissionDecision).toHaveBeenCalledWith(expect.objectContaining({ email: 'dev@example.com', approved: true }));
    expect(announceNewVersion).not.toHaveBeenCalled();
  });

  it('an EXISTING listing of the same submitter: a major bump is breaking, the request is not re-linked, installers are told', async () => {
    store.listings.byId.mockResolvedValue(liveListing());
    store.versions.countForListing.mockResolvedValue(1);
    subs.list.mockResolvedValue([{ emailHash: 'hash-owner', createdAt: '2026-08-01T00:00:00Z' }]);
    subs.byId.mockResolvedValue(submission({ version: '2.0.0', catalog: null }));
    store.previousVersion.mockResolvedValueOnce({ version: '1.4.0' });
    guardsMod.submitterEmail.mockResolvedValue(null);
    await mod.publishSubmission(request({ listingId: 'lst-1', version: '2.0.0' }), community, 'mod-2');
    expect(store.listings.insert).not.toHaveBeenCalled();
    expect(store.requests.transition).not.toHaveBeenCalled();
    expect(store.versions.insert).toHaveBeenCalledWith(expect.objectContaining({ listingId: 'lst-1', breaking: true, changelog: null }));
    expect(notify.notifySubmissionDecision).not.toHaveBeenCalled();
    expect(announceNewVersion).toHaveBeenCalledWith(community, expect.objectContaining({ id: 'lst-1' }), expect.objectContaining({ id: 'ver-1' }));
  });

  it('an EMPTY listing shell is extendable by anyone (no versions → no owner to check)', async () => {
    store.listings.byName.mockResolvedValue(liveListing({ state: 'unmaintained' }));
    store.versions.countForListing.mockResolvedValue(0);
    await mod.publishSubmission(request(), community, 'mod-2');
    expect(store.versions.insert).toHaveBeenCalledWith(expect.objectContaining({ listingId: 'lst-1' }));
    expect(announceNewVersion).not.toHaveBeenCalled();
  });
});

describe('rejectSubmission', () => {
  it('rejects a pending submission, drops its artifacts and tells the submitter why', async () => {
    await mod.rejectSubmission(request(), 'malware', 'mod-1');
    expect(subs.transition).toHaveBeenCalledWith('sub-1', 'pending_review', expect.objectContaining({ status: 'rejected', reason: 'malware', decidedBy: 'mod-1' }));
    expect(submissionsMod.dropQuarantineArtifacts).toHaveBeenCalled();
    expect(recordSubmission).toHaveBeenCalledWith('rejected');
    expect(notify.notifySubmissionDecision).toHaveBeenCalledWith(expect.objectContaining({ approved: false, reason: 'malware' }));
  });

  it('does nothing further when the submission was no longer pending', async () => {
    subs.transition.mockResolvedValueOnce(null);
    await mod.rejectSubmission(request(), 'late', 'mod-1');
    expect(submissionsMod.dropQuarantineArtifacts).not.toHaveBeenCalled();
    expect(recordAuditMock).not.toHaveBeenCalled();
  });

  it('skips the email when the submitter\'s address is gone', async () => {
    guardsMod.submitterEmail.mockResolvedValue(null);
    await mod.rejectSubmission(request(), 'spam', 'mod-1');
    expect(notify.notifySubmissionDecision).not.toHaveBeenCalled();
  });
});

describe('request bookkeeping', () => {
  it('inserts an anonymous, org-less submission request and announces it', async () => {
    store.requests.insert.mockImplementation(async (row: Record<string, unknown>) => ({ id: 'req-9', ...row }));
    const r = await mod.insertSubmissionRequest(submission(), community, null, DIGEST);
    expect(r).toMatchObject({ kind: 'submission', submittedOrgId: null, listingId: null, payload: { submissionId: 'sub-1', newListing: true } });
    await mod.announceSubmissionRequest(submission(), r as any, liveListing(), DIGEST);
    expect(notify.notifySubmissionQueued).toHaveBeenCalledWith({ name: 'my-linter', version: '1.0.0', newListing: false });
  });

  it('checks for and closes the open moderation request of a submission', async () => {
    store.requests.list.mockResolvedValueOnce([]).mockResolvedValueOnce([{ id: 'r1', status: 'pending' }, { id: 'r2', status: 'pending_second_approval' }]);
    await expect(mod.hasOpenSubmissionRequest('sub-1')).resolves.toBe(false);
    await mod.closeSubmissionRequest('sub-1', 'expired');
    expect(store.requests.transition).toHaveBeenCalledTimes(2);
    expect(store.requests.transition).toHaveBeenCalledWith('r2', 'pending_second_approval', expect.objectContaining({ status: 'rejected', reason: 'expired' }));
  });
});

describe('submissionSnapshot + review', () => {
  it('falls back to the spec defaults when the submission leaves fields out', async () => {
    const snap = await mod.submissionSnapshot(submission({ spec: {}, catalog: null, dockerfile: null }), { ...facts, runAsRoot: null });
    expect(snap).toMatchObject({ pluginType: 'CodeBuildStep', computeType: 'SMALL', failureBehavior: 'fail', category: 'unknown', keywords: [], runAsRoot: undefined, license: undefined, readmeHtml: undefined });
  });

  it('renders the README, keeps keywords and license from the accepted catalog values', async () => {
    const snap = await mod.submissionSnapshot(submission({ catalog: { values: { readme: '# Hi', keywords: ['lint'], license: 'MIT', category: 'quality' } } }), facts);
    expect(snap).toMatchObject({ keywords: ['lint'], license: 'MIT', category: 'quality' });
    expect(typeof snap.readmeHtml).toBe('string');
  });

  it('diffs a submission against the previous approved version of its listing', async () => {
    store.listings.byId.mockResolvedValue(liveListing({ homepageUrl: 'https://old' }));
    store.previousVersion.mockResolvedValueOnce({ version: '0.9.0', vulnCritical: 1, vulnHigh: 2, specSnapshot: { dockerfile: 'FROM debian' } });
    subs.byId.mockResolvedValue(submission({ verifiedAt: '2026-09-01T01:00:00Z', catalog: { values: { summary: 'Lints', homepageUrl: 'https://evil' }, sources: { homepageUrl: 'user' } } }));
    const review = await mod.submissionReview(request({ listingId: 'lst-1' }));
    expect(review).toMatchObject({ newListing: false, previousVersion: '0.9.0', dockerfile: { changed: true }, vuln: { previous: { critical: 1, high: 2 } } });
    expect(review.metadata.find((m) => m.field === 'homepageUrl')).toMatchObject({ changed: true, userEdited: true, isLink: true, highlight: true });
    expect(review.sbomUrl).toBe('/api/plugins/ecosystem/requests/req-1/submission-sbom');
  });

  it('a review with no gate report shows no contract, vuln or SBOM links', async () => {
    subs.byId.mockResolvedValue(submission({ gateReport: null, dockerfile: null }));
    const review = await mod.submissionReview(request());
    expect(review).toMatchObject({ newListing: true, gateReport: null, contract: null, vuln: null, sbomUrl: null, scanUrl: null, dockerfile: { changed: false } });
    expect(review.metadata.find((m) => m.field === 'summary')).toMatchObject({ changed: true, previous: null });
  });
});

describe('claims', () => {
  it('hashes only a VERIFIED claimant email, and only with a configured secret', () => {
    expect(mod.claimantEmailHash({ email: undefined, emailVerified: true } as any)).toBeNull();
    expect(mod.claimantEmailHash({ email: 'a@b.c', emailVerified: false } as any)).toBeNull();
    configMod.submissionConfig.mockReturnValueOnce({ emailHashSecret: '' });
    expect(mod.claimantEmailHash({ email: 'a@b.c', emailVerified: true } as any)).toBeNull();
    expect(mod.claimantEmailHash({ email: ' A@B.C ', emailVerified: true } as any)).toBe('h(a@b.c,secret)');
  });

  it('tells whether a claim comes from the listing\'s submitter — null when it cannot be told', async () => {
    expect(await mod.claimEmailMatch(request({ kind: 'transfer' }))).toBeNull();
    expect(await mod.claimEmailMatch(request({ kind: 'claim', payload: { target: {} } }))).toBeNull();
    subs.list.mockResolvedValueOnce([]);
    expect(await mod.claimEmailMatch(request({ kind: 'claim', payload: { target: { listingId: 'lst-1' }, claimantEmailHash: 'x' } }))).toBeNull();
    subs.list.mockResolvedValueOnce([{ emailHash: 'hash-owner', createdAt: '2026-08-01' }]);
    expect(await mod.claimEmailMatch(request({ kind: 'claim', payload: { target: { listingId: 'lst-1' }, claimantEmailHash: 'hash-owner' } }))).toBe(true);
  });

  it('links the claimer\'s own approved submissions, skipping ones that changed meanwhile, and never throws', async () => {
    const input = { listing: liveListing(), claimantEmailHash: 'hash-owner', userId: 'u1', orgId: 'o1', actor: 'mod-1', publisherHandle: 'community' };
    expect(await mod.linkClaimedSubmissions({ ...input, claimantEmailHash: null })).toBe(0);
    subs.list.mockResolvedValueOnce([{ id: 's1', emailHash: 'hash-owner' }, { id: 's2', emailHash: 'hash-owner' }, { id: 's3', emailHash: 'someone-else' }]);
    subs.transition.mockResolvedValueOnce({ id: 's1' }).mockResolvedValueOnce(null);
    expect(await mod.linkClaimedSubmissions(input)).toBe(2);
    expect(recordSubmission).toHaveBeenCalledTimes(1);
    expect(notify.notifySubmissionClaimed).toHaveBeenCalledWith({ userId: 'u1', orgId: 'o1', listing: 'community/my-linter' });
    subs.list.mockRejectedValueOnce(new Error('db down'));
    expect(await mod.linkClaimedSubmissions(input)).toBe(0);
  });
});

describe('quarantined SBOM + scan downloads', () => {
  it('404s an unknown or non-submission request, and a submission without a quarantined build', async () => {
    store.requests.byId.mockResolvedValueOnce(null);
    await expect(mod.submissionSbom('nope')).rejects.toThrow('Submission request not found');
    store.requests.byId.mockResolvedValueOnce(request({ kind: 'new_listing' }));
    await expect(mod.submissionSbom('req-1')).rejects.toThrow('Submission request not found');
    store.requests.byId.mockResolvedValueOnce(request());
    subs.byId.mockResolvedValueOnce(submission({ gateReport: null }));
    await expect(mod.submissionSbom('req-1')).rejects.toThrow('The submission has no quarantined build');
    expect(fetchImageSbom).not.toHaveBeenCalled();
  });

  it('fetches the signed SBOM of the pinned quarantined digest and scans it now', async () => {
    store.requests.byId.mockResolvedValue(request());
    const scan = await mod.submissionScan('req-1');
    expect(fetchImageSbom).toHaveBeenCalledWith(expect.objectContaining({ name: 'my-linter', imageDigest: DIGEST, imageRepository: 'quarantine/sub-1' }), { host: 'registry', port: 5000 });
    expect(scanSbom).toHaveBeenCalledWith({ spdxVersion: 'SPDX-2.3' }, 'rescan');
    expect(scan).toMatchObject({ high: 1, scannedAt: '2026-09-01T00:00:00.000Z' });
  });
});
