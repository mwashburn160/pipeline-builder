// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Session-assurance fixtures: the global step-up dialog ("Confirm it's you")
 * and the idle sign-out warning ("Are you still there?").
 *
 *  - {@link STRONG_USER}: an owner holding a passkey AND an authenticator app,
 *    so the step-up dialog offers both second factors (and the password).
 *  - {@link stubGatedWrite}: `POST /api/pipelines` refused with
 *    STEP_UP_REQUIRED until it carries the step-up token the stub minted.
 *  - {@link addVirtualPasskey}: a Chromium virtual authenticator holding one
 *    resident credential for `localhost`, plus the step-up WebAuthn endpoints
 *    answering with a challenge for it.
 *  - {@link stubIdleSession}: `POST /api/auth/refresh` modelled as the server's
 *    idle clock, in the page's (faked) time.
 *  - {@link openStepUp} / {@link openIdleWarning}: sign in and bring the dialog
 *    up, for the a11y scans and screenshots.
 */

import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { expect, type Locator, type Page } from '@playwright/test';
import { OWNER, fakeJwt, ok, signedInPage, type Backend, type StubUser } from '../backend';

/** An owner with every factor: password, one passkey, an authenticator app. */
export const STRONG_USER: StubUser = {
  ...OWNER,
  authFactors: { hasPassword: true, passkeyCount: 1, hasTotp: true, providers: [] },
};

/** The token every step-up path in the stub mints. */
export const STEP_UP_TOKEN = 'su-e2e';

/** A pipeline the Upload tab accepts as-is. */
export const GATED_PIPELINE_PROPS = {
  project: 'web', organization: 'acme',
  synth: { source: { type: 'github', options: { repo: 'acme/web' } }, plugin: { name: 'cdk-synth' } },
};

/**
 * `POST /api/pipelines` refuses with STEP_UP_REQUIRED unless the request
 * carries {@link STEP_UP_TOKEN}; then it is created.
 */
export function stubGatedWrite(api: Backend): void {
  api.on('POST /api/pipelines', (call) => (call.headers['x-step-up-token'] === STEP_UP_TOKEN
    ? { status: 201, json: { success: true, data: { inserted: true, pipeline: { id: 'pl-new' } } } }
    : { status: 401, json: { success: false, code: 'STEP_UP_REQUIRED', message: 'Confirm it is you to create a pipeline.' } }));
}

/** Open Create pipeline → Upload, paste valid props and submit: the write the gate refuses. */
export async function submitGatedWrite(page: Page): Promise<void> {
  await page.goto('/dashboard/pipelines');
  await page.getByRole('button', { name: 'Create pipeline' }).first().click();
  const create = page.getByRole('dialog', { name: 'Create pipeline' });
  await expect(create).toBeVisible();
  await create.getByRole('tab', { name: 'Upload' }).click();
  await create.getByLabel('Pipeline Props (JSON)').fill(JSON.stringify(GATED_PIPELINE_PROPS));
  await create.getByRole('button', { name: 'Create', exact: true }).click();
}

const b64 = (buf: Buffer) => buf.toString('base64');
const b64url = (buf: Buffer) => buf.toString('base64url');

/**
 * Give the browser a passkey for `localhost` (a CDP virtual authenticator that
 * answers without a prompt) and stub the step-up WebAuthn ceremony around it.
 * The verify endpoint mints {@link STEP_UP_TOKEN} — the stub does not check
 * the assertion's signature (the platform does); a spec asserts its shape.
 */
export async function addVirtualPasskey(page: Page, api: Backend): Promise<{ credentialId: string }> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2', transport: 'internal', hasResidentKey: true,
      hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true,
    },
  });
  const credentialId = randomBytes(16);
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  await cdp.send('WebAuthn.addCredential', {
    authenticatorId,
    credential: {
      credentialId: b64(credentialId),
      isResidentCredential: true,
      rpId: 'localhost',
      privateKey: b64(privateKey.export({ format: 'der', type: 'pkcs8' }) as Buffer),
      userHandle: b64(Buffer.from(OWNER.id)),
      signCount: 0,
    },
  });
  api.on('POST /api/auth/step-up/webauthn/options', ok({
    ceremonyId: 'cer-1',
    options: {
      challenge: b64url(randomBytes(32)),
      rpId: 'localhost',
      timeout: 60_000,
      userVerification: 'preferred',
      allowCredentials: [{ id: b64url(credentialId), type: 'public-key', transports: ['internal'] }],
    },
  }));
  api.on('POST /api/auth/step-up/webauthn/verify', ok({ ok: true, stepUpToken: STEP_UP_TOKEN, expiresAt: Date.now() + 60_000, method: 'webauthn' }));
  return { credentialId: b64url(credentialId) };
}

/** The platform's words for a wrong code (`TOTP_ERROR_MAP[TOTP_INVALID_CODE]`). */
export const TOTP_REFUSAL = 'That code isn\'t right. Check your authenticator app and try the current code.';

/**
 * `POST /api/auth/step-up/totp`: `123456` passes; anything else gets the
 * platform's own refusal — a 401 with the message and no `code`.
 */
export function stubTotpStepUp(api: Backend): void {
  api.on('POST /api/auth/step-up/totp', (call) => ((call.json as { code?: string })?.code === '123456'
    ? ok({ ok: true, stepUpToken: STEP_UP_TOKEN, expiresAt: Date.now() + 60_000, method: 'totp', via: 'totp', recoveryCodesRemaining: 10 })
    : { status: 401, json: { success: false, message: TOTP_REFUSAL } }));
}

/**
 * Sign in as {@link STRONG_USER}, make the gated write and wait for the global
 * step-up dialog. Every factor path is stubbed, so the dialog is live.
 */
export async function openStepUp(page: Page): Promise<{ api: Backend; dialog: Locator }> {
  const api = await signedInPage(page, STRONG_USER);
  stubGatedWrite(api);
  stubTotpStepUp(api);
  api.on('POST /api/auth/step-up', ok({ ok: true, stepUpToken: STEP_UP_TOKEN, expiresAt: Date.now() + 60_000, method: 'password' }));
  await submitGatedWrite(page);
  const dialog = page.getByRole('dialog', { name: "Confirm it's you" });
  await expect(dialog).toBeVisible();
  // The factors arrive from the profile read: the options are rendered.
  await expect(dialog.getByRole('button', { name: 'Use a passkey' })).toBeVisible();
  return { api, dialog };
}

// ---------------------------------------------------------------------------
// Idle sign-out
// ---------------------------------------------------------------------------

/** The org's idle timeout the stub serves. */
export const IDLE_TIMEOUT_MINUTES = 15;

/** A fixed, deterministic moment to start the faked browser clock at. */
export const IDLE_CLOCK_START = new Date('2026-11-27T09:00:00Z');

export interface IdleSession {
  /** The `activity` each refresh reported, in order. */
  activity: () => Array<string | undefined>;
  /** True once `POST /api/auth/logout` was called. */
  signedOut: () => boolean;
}

/**
 * Model the platform's idle clock in `POST /api/auth/refresh`. The server's
 * "now" is the page's own (faked) clock, read at each request, so the token's
 * `iat` and the session's `idleExpiresAt` agree with the browser and the
 * client's skew correction is zero. A refresh reporting `activity: 'user'`
 * (or the first one, the sign-in) moves the last-active moment; `passive`
 * refreshes leave it. After `POST /api/auth/logout` the refresh refuses.
 */
export function stubIdleSession(page: Page, api: Backend, timeoutMinutes = IDLE_TIMEOUT_MINUTES): IdleSession {
  const activity: Array<string | undefined> = [];
  let lastActiveAt: number | null = null;
  let signedOut = false;
  const serverNow = async () => {
    try { return await page.evaluate(() => Date.now()); } catch { return lastActiveAt ?? IDLE_CLOCK_START.getTime(); }
  };
  api.on('POST /api/auth/refresh', async (call) => {
    if (signedOut) return { status: 401, json: { success: false, message: 'No session' } };
    const now = await serverNow();
    const reported = (call.json as { activity?: string } | null)?.activity;
    activity.push(reported);
    if (lastActiveAt === null || reported === 'user') lastActiveAt = now;
    const iat = Math.floor(now / 1000);
    return ok({
      accessToken: fakeJwt({ iat, exp: iat + 3600 }),
      expiresIn: 3600,
      session: { idleTimeoutMinutes: timeoutMinutes, idleExpiresAt: new Date(lastActiveAt + timeoutMinutes * 60_000).toISOString() },
    });
  });
  api.on('POST /api/auth/logout', () => { signedOut = true; return ok(); });
  return { activity: () => [...activity], signedOut: () => signedOut };
}

/**
 * Signed in with a faked clock at {@link IDLE_CLOCK_START} and the idle clock
 * stubbed. Navigate, then move time with `page.clock.fastForward`.
 */
export async function idleSignedInPage(page: Page): Promise<{ api: Backend; idle: IdleSession }> {
  await page.clock.install({ time: IDLE_CLOCK_START });
  const api = await signedInPage(page);
  const idle = stubIdleSession(page, api);
  return { api, idle };
}

/** Sign in, then run the faked clock to 1m50s before the idle deadline: the warning is up. */
export async function openIdleWarning(page: Page): Promise<{ api: Backend; dialog: Locator }> {
  const { api } = await idleSignedInPage(page);
  await page.goto('/dashboard');
  await expect(page.getByText(`Welcome back, ${OWNER.username}`)).toBeVisible();
  await page.clock.fastForward(`${IDLE_TIMEOUT_MINUTES - 2}:10`);
  const dialog = page.getByRole('dialog', { name: 'Are you still there?' });
  await expect(dialog).toBeVisible();
  return { api, dialog };
}
