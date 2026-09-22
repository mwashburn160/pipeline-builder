// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The anonymous submission pages (plan §4, W5):
 *  - `/plugins/submit`: upload → proof-of-work → inspect → accept-or-edit →
 *    email + terms → proof-of-work → submit → "check your email"; every call
 *    credential-free; a disabled instance, the daily limit, a taken name and
 *    field-level 400s are each shown where they belong;
 *  - `/plugins/submit/verify`: nothing is POSTed on load (mail scanners), only
 *    on the button; then the status and a bookmarkable status link;
 *  - `/plugins/submit/status`: gates, reason and the listing link.
 */
import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';

let routerQuery: Record<string, string> = {};
jest.mock('next/router', () => ({
  __esModule: true,
  useRouter: () => ({ isReady: true, query: routerQuery, asPath: '/plugins/submit', pathname: '/plugins/submit', push: jest.fn(), replace: jest.fn() }),
}));
jest.mock('@/hooks/useAuth', () => ({ __esModule: true, useAuth: () => ({ user: null, isAuthenticated: false, isInitialized: true }) }));
jest.mock('@/hooks/useDarkMode', () => ({ __esModule: true, useDarkMode: () => ({ isDark: false, toggle: () => undefined }) }));
jest.mock('@/generated/plugin-icons', () => ({ __esModule: true, PLUGIN_ICONS: {} }));
const solveInWorker = jest.fn<AnyFn>();
jest.mock('@/lib/plugin-submissions/proof-of-work', () => ({
  ...jest.requireActual<object>('@/lib/plugin-submissions/proof-of-work'),
  solveInWorker: (...a: unknown[]) => solveInWorker(...a),
}));

import SubmitPluginPage from '../pages/plugins/submit/index';
import VerifySubmissionPage from '../pages/plugins/submit/verify';
import SubmissionStatusPage from '../pages/plugins/submit/status';

const fetchMock = jest.fn<AnyFn>();
const realFetch = global.fetch;

function reply(status: number, body: Record<string, unknown>, headers: Record<string, string> = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k: string) => headers[k] ?? null },
    json: async () => body,
  };
}
const ok = (data: unknown, status = 200) => reply(status, { success: true, data });
const fail = (status: number, code: string, message: string, details?: Record<string, unknown>, headers?: Record<string, string>) =>
  reply(status, { success: false, statusCode: status, code, message, ...(details ? { details } : {}) }, headers);

const INSPECT = {
  plugin: { name: 'eslint-runner', version: '1.2.0', pluginType: 'CodeBuildStep', buildType: 'build_image', smokeTest: true },
  fields: [
    { field: 'summary', value: 'Run ESLint', source: 'spec', error: null },
    { field: 'license', value: 'MIT', source: 'dockerfile', error: null },
    { field: 'homepageUrl', value: null, source: null, error: 'Links must use https' },
  ],
  // The plugin service's shapes: lint `level`, heuristics `{ blocking, findings }` (no excerpts), the name gate.
  lint: [{ level: 'warning', message: 'Pin the base image tag' }, { level: 'error', message: 'USER root is not allowed' }],
  heuristics: { blocking: 1, findings: [{ id: 'miner.xmrig', severity: 'high', path: 'entrypoint.sh', line: 3 }] },
  name: { id: 'name', ok: false, message: 'community/eslint-runner is already listed' },
};

/** Route every submissions call; `submit` decides the final POST's answer. */
function routes(submit: () => unknown = () => ok({ id: 'sub-1', status: 'pending_verification' }, 202)) {
  fetchMock.mockImplementation(async (url: unknown, init?: RequestInit) => {
    const u = String(url);
    if (u.endsWith('/challenge')) return ok({ challenge: `ch-${fetchMock.mock.calls.length}`, difficulty: 4, expiresAt: '2026-09-21T00:10:00Z' });
    if (u.endsWith('/inspect')) return ok(INSPECT);
    if (u.endsWith('/api/public/plugin-submissions') && init?.method === 'POST') return submit();
    throw new Error(`unexpected ${u}`);
  });
}

const calls = () => fetchMock.mock.calls.map(([url, init]) => ({ url: String(url), init: (init ?? {}) as RequestInit }));

function expectNoCredentials() {
  for (const { url, init } of calls()) {
    expect(url).toMatch(/^\/api\/public\/plugin-submissions/);
    const headers = Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
    expect(headers).not.toHaveProperty('authorization');
    expect(headers).not.toHaveProperty('x-org-id');
    expect(init.credentials).toBe('omit');
  }
}

const zipFile = () => new File(['PK'], 'eslint-runner.zip', { type: 'application/zip' });

async function chooseZip() {
  fireEvent.change(screen.getByLabelText('Plugin package (.zip)'), { target: { files: [zipFile()] } });
  return screen.findByTestId('submission-review');
}

function fillAndSubmit(email = 'dev@example.com') {
  fireEvent.change(screen.getByLabelText(/Email address/), { target: { value: email } });
  fireEvent.click(screen.getByRole('checkbox'));
  fireEvent.click(screen.getByRole('button', { name: 'Submit for review' }));
}

beforeEach(() => {
  global.fetch = fetchMock as unknown as typeof fetch;
  fetchMock.mockReset();
  solveInWorker.mockReset();
  solveInWorker.mockImplementation(async (challenge: unknown) => ({ nonce: `n-for-${String(challenge)}`, attempts: 16 }));
  routerQuery = {};
});
afterEach(() => { global.fetch = realFetch; });

describe('/plugins/submit', () => {
  it('explains moderation, the community namespace, the Unverified tier and claiming; offers sign-in', () => {
    routes();
    render(<SubmitPluginPage siteUrl="https://pb.example" />);
    expect(screen.getByRole('heading', { level: 1, name: 'Submit a plugin' })).toBeInTheDocument();
    expect(screen.getByText(/A moderator reviews every submission/)).toBeInTheDocument();
    expect(screen.getByText('community/<name>')).toBeInTheDocument();
    expect(screen.getAllByText('Unverified').length).toBeGreaterThan(0);
    expect(screen.getByText(/claim the listing/)).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: 'Sign in' }).some((a) => a.getAttribute('href') === '/login?returnTo=%2Fplugins%2Fsubmit')).toBe(true);
  });

  it('inspects after a proof-of-work, shows the detected fields, lint and heuristics, then submits only edited fields', async () => {
    routes();
    render(<SubmitPluginPage siteUrl="https://pb.example" />);
    const review = await chooseZip();

    // Inspect carried a solved challenge.
    const inspectCall = calls().find((c) => c.url.endsWith('/inspect'))!;
    const inspectBody = inspectCall.init.body as FormData;
    expect(inspectBody.get('plugin')).toBeInstanceOf(File);
    expect(JSON.parse(String(inspectBody.get('pow')))).toEqual({ challenge: 'ch-1', nonce: 'n-for-ch-1' });
    expect(solveInWorker).toHaveBeenCalledWith('ch-1', 4, expect.objectContaining({ signal: expect.anything() }));

    expect(within(review).getByText('community/eslint-runner')).toBeInTheDocument();
    expect(within(review).getByTestId('catalog-field-summary')).toHaveTextContent('Run ESLint');
    expect(within(review).getByTestId('catalog-field-homepageUrl')).toHaveTextContent('Not used: Links must use https');
    expect(within(review).getByTestId('lint-issues')).toHaveTextContent('Pin the base image tag');
    expect(within(review).getByTestId('finding-miner.xmrig')).toHaveTextContent('entrypoint.sh:3');
    expect(within(review).getByTestId('lint-issues')).toHaveTextContent('USER root is not allowed');
    expect(within(review).getByText('This package would fail the automated checks')).toBeInTheDocument();
    expect(within(review).getByTestId('name-check')).toHaveTextContent('community/eslint-runner is already listed');
    expect(within(review).queryByTestId('no-smoke-test')).not.toBeInTheDocument();

    // Edit the summary.
    fireEvent.click(within(review).getByRole('button', { name: 'Edit Summary' }));
    fireEvent.change(within(review).getByLabelText('New summary'), { target: { value: 'Lint JS fast' } });
    fireEvent.click(within(review).getByRole('button', { name: 'Save' }));

    fillAndSubmit(' dev@example.com ');
    expect(await screen.findByTestId('submission-sent')).toHaveTextContent('dev@example.com');

    const submitCall = calls().find((c) => c.url === '/api/public/plugin-submissions')!;
    const body = submitCall.init.body as FormData;
    expect(body.get('email')).toBe('dev@example.com');
    expect(body.get('acceptTerms')).toBe('true');
    expect(JSON.parse(String(body.get('metadata')))).toEqual({ summary: 'Lint JS fast' });
    // A FRESH challenge for the submit (each is single use).
    const pow = JSON.parse(String(body.get('pow')));
    expect(pow.challenge).not.toBe('ch-1');
    expect(solveInWorker).toHaveBeenCalledTimes(2);
    expectNoCredentials();
  });

  it('requires an email and the terms before doing any work', async () => {
    routes();
    render(<SubmitPluginPage siteUrl="https://pb.example" />);
    await chooseZip();
    const before = fetchMock.mock.calls.length;
    fireEvent.click(screen.getByRole('button', { name: 'Submit for review' }));
    expect(await screen.findByText('Enter the email address to confirm the submission with.')).toBeInTheDocument();
    expect(screen.getByText('Accept the submission terms to continue.')).toBeInTheDocument();
    expect(fetchMock.mock.calls.length).toBe(before);
  });

  it('SUBMISSIONS_DISABLED shows the not-enabled state with a sign-in link', async () => {
    fetchMock.mockResolvedValue(fail(404, 'SUBMISSIONS_DISABLED', 'Not found'));
    render(<SubmitPluginPage siteUrl="https://pb.example" />);
    fireEvent.change(screen.getByLabelText('Plugin package (.zip)'), { target: { files: [zipFile()] } });
    const disabled = await screen.findByTestId('submissions-disabled');
    expect(disabled).toHaveTextContent('Submissions are not enabled on this instance');
    expect(within(disabled).getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '/login?returnTo=%2Fplugins%2Fsubmit');
    expect(solveInWorker).not.toHaveBeenCalled();
  });

  it('SUBMISSION_LIMIT and NAME_TAKEN are explained and keep the form', async () => {
    routes(() => fail(429, 'SUBMISSION_LIMIT', 'Too many submissions', undefined, { 'Retry-After': '3600' }));
    render(<SubmitPluginPage siteUrl="https://pb.example" />);
    await chooseZip();
    fillAndSubmit();
    const err = await screen.findByTestId('submit-error');
    expect(err).toHaveAttribute('data-kind', 'limit');
    expect(screen.getByText('Submission limit reached')).toBeInTheDocument();
    expect(screen.getByText(/retry in about 60 min/)).toBeInTheDocument();
    expect(screen.getByTestId('submission-review')).toBeInTheDocument();

    routes(() => fail(409, 'NAME_TAKEN', 'community/eslint-runner was submitted from a different email address'));
    fireEvent.click(screen.getByRole('button', { name: 'Submit for review' }));
    await waitFor(() => expect(screen.getByTestId('submit-error')).toHaveAttribute('data-kind', 'name_taken'));
    expect(screen.getByText(/submitted from a different email address/)).toBeInTheDocument();
  });

  it('a validation 400 is shown on the fields it names', async () => {
    routes(() => fail(400, 'VALIDATION_ERROR', 'Invalid metadata: summary: Must be at most 160 characters', { fields: { email: 'Disposable addresses are not accepted' } }));
    render(<SubmitPluginPage siteUrl="https://pb.example" />);
    await chooseZip();
    fillAndSubmit();
    expect(await screen.findByTestId('catalog-field-error-summary')).toHaveTextContent('Must be at most 160 characters');
    expect(screen.getByText('Disposable addresses are not accepted')).toBeInTheDocument();
  });

  it('a refused proof-of-work is re-solved once automatically', async () => {
    let first = true;
    routes(() => {
      if (first) { first = false; return fail(400, 'PROOF_OF_WORK_INVALID', 'expired'); }
      return ok({ id: 'sub-2', status: 'pending_verification' }, 202);
    });
    render(<SubmitPluginPage siteUrl="https://pb.example" />);
    await chooseZip();
    fillAndSubmit();
    expect(await screen.findByTestId('submission-sent')).toBeInTheDocument();
    expect(solveInWorker).toHaveBeenCalledTimes(3);
  });
});

describe('/plugins/submit/verify', () => {
  it('does not POST on load; confirms on the button and shows the status link', async () => {
    routerQuery = { token: 'magic-tok' };
    fetchMock.mockResolvedValue(ok({ id: 'sub-1', status: 'pending_review', statusToken: 'stat tok' }));
    render(<VerifySubmissionPage />);
    expect(screen.getByTestId('verify-prompt')).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /Confirm submission/ }));
    const result = await screen.findByTestId('verify-result');
    expect(result).toHaveTextContent('Checks and moderation in progress');
    expect(screen.getByTestId('status-link')).toHaveTextContent('/plugins/submit/status?token=stat%20tok');
    expect(within(result).getByRole('link', { name: 'Open the status page' })).toHaveAttribute('href', '/plugins/submit/status?token=stat%20tok');

    const [[url, init]] = fetchMock.mock.calls as Array<[string, RequestInit]>;
    expect(url).toBe('/api/public/plugin-submissions/verify');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ token: 'magic-tok' });
    expectNoCredentials();
  });

  it('explains a used or expired link', async () => {
    routerQuery = { token: 'old' };
    fetchMock.mockResolvedValue(fail(400, 'VALIDATION_ERROR', 'Invalid or expired token'));
    render(<VerifySubmissionPage />);
    fireEvent.click(screen.getByRole('button', { name: /Confirm submission/ }));
    expect(await screen.findByTestId('verify-error')).toHaveTextContent(/already used, or older than 30 minutes/);
  });

  it('without a token, says so and sends nothing', () => {
    render(<VerifySubmissionPage />);
    expect(screen.getByText('No confirmation token')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Confirm submission/ })).not.toBeInTheDocument();
  });
});

describe('/plugins/submit/status', () => {
  it('shows failed gates and the reason', async () => {
    routerQuery = { token: 'st' };
    fetchMock.mockResolvedValue(ok({
      id: 'sub-1', name: 'eslint-runner', version: '1.2.0', status: 'gate_failed', reason: 'The smoke test failed',
      gates: [{ id: 'spec', ok: true, message: 'Spec is valid' }, { id: 'smoke_test', ok: false, message: 'Smoke test exited 1' }],
    }));
    render(<SubmissionStatusPage />);
    const card = await screen.findByTestId('submission-status');
    expect(card).toHaveTextContent('community/eslint-runner');
    expect(card).toHaveTextContent('Failed an automated check');
    expect(screen.getByText('Automated checks (1 failed)')).toBeInTheDocument();
    expect(screen.getByTestId('gate-smoke_test')).toHaveAttribute('data-ok', 'false');
    expect(screen.getByTestId('status-reason')).toHaveTextContent('The smoke test failed');
    expect(fetchMock.mock.calls[0][0]).toBe('/api/public/plugin-submissions/status?token=st');
    expectNoCredentials();
  });

  it('links the listing once approved', async () => {
    routerQuery = { token: 'st' };
    fetchMock.mockResolvedValue(ok({
      id: 'sub-1', name: 'eslint-runner', version: '1.2.0', status: 'approved', gates: [],
      listing: { publisher: 'community', name: 'eslint-runner' },
    }));
    render(<SubmissionStatusPage />);
    expect(await screen.findByTestId('listing-link')).toHaveAttribute('href', '/plugins/community/eslint-runner');
  });

  it('an unknown token is a dead end, not a retry loop', async () => {
    routerQuery = { token: 'nope' };
    fetchMock.mockResolvedValue(fail(404, 'NOT_FOUND', 'Not found'));
    render(<SubmissionStatusPage />);
    expect(await screen.findByTestId('status-error')).toHaveTextContent(/No submission matches/);
  });
});
