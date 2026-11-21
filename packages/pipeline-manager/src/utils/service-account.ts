// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Provisioning the org's MACHINE identity for stored credentials.
 *
 * A credential the CLI parks in AWS Secrets Manager must not be a machine
 * SESSION belonging to whoever ran the command: a person's JWT would outlive
 * their employment, carry their authority, and make the audit trail read as if
 * they had personally pushed every image.
 *
 * What it writes is a `pb_sa_…` key on an org SERVICE ACCOUNT:
 *   - the account is the principal, so audit rows name it, not the operator;
 *   - its Roles are the narrowest that work — for a SCOPED credential that is no
 *     Roles at all, just the one capability (`reporting:ingest`, `registry:push`);
 *     otherwise one built-in machine Role (Pipeline Automation, Pipeline
 *     Registration), never the org Admin Role;
 *   - the key is opaque and short-lived at the point of use (5-minute exchanged
 *     tokens), so revoking it actually stops the automation;
 *   - it takes no seat and survives the operator leaving.
 *
 * Creating an account and issuing a key are BOTH step-up gated on the platform —
 * they mint durable bearer credentials, the same class of action a personal key
 * is gated for. HOW the operator steps up is a {@link StepUpProvider}: their
 * password, an authenticator-app code, or a browser approval (the device flow
 * with `step_up`, where passkeys and SSO / social re-sign-in work — the only
 * route for an account with no password). A step-up token is single-use and
 * lives about a minute, so one is minted immediately before each gated call —
 * and the platform's `provision-key` endpoint does the whole find-or-create +
 * issue (+ retire at the cap) behind ONE, so a run costs one approval.
 */

import { errorMessage } from '@pipeline-builder/api-core';
import type { SeedBundleId } from '@pipeline-builder/api-core';
import type { ApiClient } from './api-client.js';
import { printSuccess, printWarning } from './output-utils.js';

/** Step-up header the platform reads (see api-core `requireStepUp`). */
export const STEP_UP_HEADER = 'X-Step-Up-Token';

/**
 * Mints one single-use step-up token for the signed-in operator. Called once per
 * gated write, immediately before it.
 */
export type StepUpProvider = () => Promise<string>;

/** What the caller wants provisioned. */
export interface ProvisionKeyOptions {
  /** An authenticated client for the operator's own session. */
  client: ApiClient;
  /** How the operator re-verifies — every key write is step-up gated. */
  stepUp: StepUpProvider;
  /** Machine name of the service account (`[a-z0-9][a-z0-9_-]{1,63}`). */
  accountName: string;
  /** Human description recorded on a newly created account. */
  description: string;
  /**
   * The built-in Role (by seed bundle) to grant a NEWLY created account —
   * `pipeline_automation` for the platform credential, `pipeline_registration`
   * for the registration one. Absent for a scoped credential, which needs no
   * Role at all.
   */
  role?: SeedBundleId;
  /** Narrow capability scope stamped on the KEY (not the account). */
  scope?: string;
  /** Key lifetime in seconds (platform caps this at 365 days). */
  expiresInSeconds: number;
  /** Key label — shown on the org's service-accounts page. */
  keyName: string;
}

/** A freshly minted key, plus everything the secret needs to record about it. */
export interface ProvisionedKey {
  /** The raw `pb_sa_…` key — returned ONCE by the platform, never readable again. */
  key: string;
  keyId: string;
  serviceAccountId: string;
  serviceAccountName: string;
  organizationId: string;
  expiresAt: string;
  scope: string | null;
}

/** Narrow shape of a service-account listing entry. */
interface AccountSummary {
  id: string;
  name: string;
  keys?: Array<{ id: string; status: string; createdAt: string; scope?: string | null }>;
}

/** Unwrap api-core's `{ success, data }` envelope (some paths return data bare). */
function unwrap<T>(response: unknown): T {
  const body = response as { data?: T };
  return (body?.data ?? response) as T;
}

/** Step-up with the operator's password (`POST /auth/step-up`). */
export function passwordStepUp(client: ApiClient, password: string): StepUpProvider {
  return async () => {
    try {
      const res = await client.post<unknown>('/api/auth/step-up', { password });
      const token = unwrap<{ stepUpToken?: string }>(res)?.stepUpToken;
      if (!token) throw new Error('no stepUpToken in response');
      return token;
    } catch (err) {
      throw new Error(
        'Could not re-verify your password (step-up). Creating a service account and issuing its key '
        + 'are both step-up gated. Check the password passed via --password / PLATFORM_PASSWORD. '
        + `(${errorMessage(err)})`,
      );
    }
  };
}

/**
 * Step-up with an authenticator-app code (`POST /auth/step-up/totp`). `askCode`
 * is asked once per token — a code cannot be replayed, which is why the
 * single-call `provision-key` path matters here.
 */
export function totpStepUp(client: ApiClient, askCode: () => Promise<string>): StepUpProvider {
  return async () => {
    const code = (await askCode()).replace(/\s+/g, '');
    try {
      const res = await client.post<unknown>('/api/auth/step-up/totp', { code });
      const token = unwrap<{ stepUpToken?: string }>(res)?.stepUpToken;
      if (!token) throw new Error('no stepUpToken in response');
      return token;
    } catch (err) {
      throw new Error(`The authenticator code was not accepted (step-up). (${errorMessage(err)})`);
    }
  };
}

/**
 * Step-up by approving in a browser: the device flow with `step_up`, the same
 * one `auth pat` uses. The browser is where passkeys and SSO / social
 * re-sign-in work, so this is how an account with no password (and anyone who
 * would rather not type one) steps up. The token is bound to the USER, not the
 * session, so the operator's existing client spends it. `approve` runs the
 * device approval and returns its `step_up_token`.
 */
export function browserStepUp(approve: () => Promise<string | undefined>): StepUpProvider {
  return async () => {
    const token = await approve();
    if (!token) {
      throw new Error('The browser approval did not return a step-up confirmation — approve the code promptly and try again.');
    }
    return token;
  };
}

/** The org the operator's token is active in. */
async function resolveOrganizationId(client: ApiClient): Promise<string> {
  const res = await client.get<unknown>('/api/organization');
  const orgId = unwrap<{ organization?: { id?: string } }>(res)?.organization?.id;
  if (!orgId) {
    throw new Error('Could not resolve your active organization — the platform returned no organization for this token.');
  }
  return orgId;
}

/** Revoke one of an account's keys. Best-effort by contract — see the call sites. */
export async function revokeServiceAccountKey(
  client: ApiClient,
  stepUp: StepUpProvider,
  orgId: string,
  accountId: string,
  keyId: string,
): Promise<void> {
  await client.delete(
    `/api/organization/${orgId}/service-accounts/${accountId}/keys/${keyId}`,
    { [STEP_UP_HEADER]: await stepUp() },
  );
}

/**
 * Ensure the named service account exists and issue it a fresh key.
 *
 * Deliberately does NOT revoke anything the caller was previously holding: the
 * caller stores the new key first and retires the old one afterwards (see
 * `store-token`), so a failure at any point leaves a working credential in the
 * secret rather than an empty one.
 */
export async function provisionServiceAccountKey(opts: ProvisionKeyOptions): Promise<ProvisionedKey> {
  const organizationId = await resolveOrganizationId(opts.client);

  // One call, one step-up: find-or-create + issue (+ retire the oldest at the
  // cap) server-side.
  const res = unwrap<{
    serviceAccount: { id: string; name: string; created: boolean };
    key: string;
    accessKey: { id: string; expiresAt: string; scope: string | null };
    retiredKeyIds?: string[];
  }>(await opts.client.post<unknown>(
    `/api/organization/${organizationId}/service-accounts/provision-key`,
    {
      accountName: opts.accountName,
      description: opts.description,
      ...(opts.role ? { role: opts.role } : {}),
      ...(opts.scope ? { scope: opts.scope } : {}),
      key: { name: opts.keyName, expiresIn: opts.expiresInSeconds },
    },
    { [STEP_UP_HEADER]: await opts.stepUp() },
  ));
  printSuccess(res.serviceAccount.created
    ? `Created the '${opts.accountName}' service account`
    : `Reusing the existing '${opts.accountName}' service account`);
  for (const id of res.retiredKeyIds ?? []) {
    printWarning(`Service account '${opts.accountName}' was at its active-key limit — retired its oldest key (${id}).`);
  }
  return {
    key: res.key,
    keyId: res.accessKey.id,
    serviceAccountId: res.serviceAccount.id,
    serviceAccountName: res.serviceAccount.name,
    organizationId,
    expiresAt: res.accessKey.expiresAt,
    scope: res.accessKey.scope ?? null,
  };
}

/**
 * Retire `keyId` with `liveKey`, a SIBLING key on the same account
 * (`POST /auth/key/revoke`): the live key is the authorization, so no step-up —
 * and no password — is involved. Used to retire the key a run replaced, after
 * the new one is safely stored.
 */
export async function revokeSiblingKey(client: ApiClient, liveKey: string, keyId: string): Promise<void> {
  await client.post<unknown>('/api/auth/key/revoke', { key: liveKey, keyId });
}

/** What `store-token --from-key` needs to adopt a key issued in the web UI. */
export interface AdoptKeyOptions {
  /** An authenticated client for the operator's own session (reads only). */
  client: ApiClient;
  /** The pasted `pb_sa_…` key. */
  rawKey: string;
  /** The account this credential must belong to (`reporting-ingest`, …). */
  accountName: string;
  /** The scope the key must carry; undefined = an unscoped key. */
  scope?: string;
  /** Lifetime of the replacement key. */
  expiresInSeconds: number;
  keyName: string;
}

/**
 * Adopt a key the operator issued in the web UI — the `store-token` route for an
 * account with no password (Google / GitHub / SSO sign-up, passkey-only), which
 * cannot pass the CLI's password step-up but CAN issue a key in the browser,
 * where passkey and provider re-authentication work.
 *
 * Nothing here is step-up gated, because the key itself is the authority:
 *  1. IDENTIFY it with an exchange (`/auth/token/exchange` → its key id), and find
 *     the account that owns that id in the operator's own org listing. A key on
 *     the wrong account, or with the wrong scope, is refused BEFORE anything is
 *     minted — storing an unscoped key as the ingest secret is exactly the
 *     silent 403 this command exists to prevent.
 *  2. ROTATE it (`/auth/key/rotate`): the stored credential is a fresh sibling,
 *     never the string that passed through a clipboard or a terminal.
 *  3. RETIRE the pasted key with the new one (`/auth/key/revoke`). Best-effort:
 *     on failure it is still a valid key on the same account that expires on its
 *     own, and the caller is told so.
 */
export async function adoptServiceAccountKey(opts: AdoptKeyOptions): Promise<ProvisionedKey> {
  const rawKey = opts.rawKey.trim();
  if (!rawKey.startsWith('pb_sa_')) {
    throw new Error(
      'That is not a service-account key (expected pb_sa_…). Issue one in the web UI on the organization\'s '
      + `Service accounts page, on the '${opts.accountName}' account, and pass it with --from-key.`,
    );
  }

  let pastedKeyId: string | undefined;
  try {
    pastedKeyId = unwrap<{ keyId?: string }>(await opts.client.post<unknown>('/api/auth/token/exchange', { key: rawKey }))?.keyId;
  } catch (err) {
    throw new Error(
      `The platform refused the key (${errorMessage(err)}). It may be revoked or expired, its account disabled, `
      + 'or limited to IP addresses this machine is not on.',
    );
  }
  if (!pastedKeyId) throw new Error('The platform accepted the key but did not say which key it is — cannot verify it.');

  const organizationId = await resolveOrganizationId(opts.client);
  const res = await opts.client.get<unknown>(`/api/organization/${organizationId}/service-accounts`);
  const accounts = unwrap<{ serviceAccounts?: AccountSummary[] }>(res)?.serviceAccounts ?? [];
  const owner = accounts.find((a) => (a.keys ?? []).some((k) => k.id === pastedKeyId));
  if (!owner) {
    throw new Error(
      `That key does not belong to a service account in your active organization (${organizationId}). `
      + 'Switch to the organization it was issued in, or issue a new one there.',
    );
  }
  if (owner.name !== opts.accountName) {
    throw new Error(
      `That key is on the '${owner.name}' service account, but this credential must be on '${opts.accountName}'. `
      + `Issue a key on '${opts.accountName}' instead${opts.scope ? ` (with the ${opts.scope} scope)` : ''}.`,
    );
  }
  const pastedScope = owner.keys?.find((k) => k.id === pastedKeyId)?.scope ?? null;
  if ((pastedScope ?? null) !== (opts.scope ?? null)) {
    throw new Error(
      `That key carries ${pastedScope ? `the '${pastedScope}' scope` : 'no scope'}, but this credential needs `
      + `${opts.scope ? `exactly the '${opts.scope}' scope` : 'an unscoped key'}. Issue a new key with the right scope.`,
    );
  }

  const rotated = unwrap<{ key: string; keyId: string; expiresAt: string; scope: string | null }>(
    await opts.client.post<unknown>('/api/auth/key/rotate', { key: rawKey, name: opts.keyName, expiresIn: opts.expiresInSeconds }),
  );
  if (!rotated?.key || !rotated.keyId) throw new Error('Key rotation returned no key.');
  printSuccess(`Replaced the pasted key with a fresh one on '${owner.name}' (${rotated.keyId})`);

  try {
    await revokeSiblingKey(opts.client, rotated.key, pastedKeyId);
    printSuccess(`Retired the pasted key (${pastedKeyId})`);
  } catch (err) {
    printWarning(
      `Could not retire the pasted key (${pastedKeyId}): ${errorMessage(err)}. It still works until it expires — `
      + 'revoke it on the Service accounts page.',
    );
  }

  return {
    key: rotated.key,
    keyId: rotated.keyId,
    serviceAccountId: owner.id,
    serviceAccountName: owner.name,
    organizationId,
    expiresAt: rotated.expiresAt,
    scope: rotated.scope ?? null,
  };
}
