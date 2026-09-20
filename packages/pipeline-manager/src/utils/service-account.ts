// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Provisioning the org's MACHINE identity for stored credentials (#12 / #N2).
 *
 * Every credential the CLI parks in AWS Secrets Manager used to be a machine
 * SESSION belonging to whoever ran the command: a person's JWT, renewed daily by
 * re-minting it under that person's session. It outlived their employment, it
 * carried their authority, and the audit trail read as if they had personally
 * pushed every image.
 *
 * What it writes instead is a `pb_sa_…` key on an org SERVICE ACCOUNT:
 *   - the account is the principal, so audit rows name it, not the operator;
 *   - its Roles are the narrowest that work — for a SCOPED credential that is no
 *     Roles at all, just the one capability (`reporting:ingest`, `registry:push`);
 *   - the key is opaque and short-lived at the point of use (5-minute exchanged
 *     tokens), so revoking it actually stops the automation;
 *   - it takes no seat and survives the operator leaving.
 *
 * Creating an account and issuing a key are BOTH step-up gated on the platform —
 * they mint durable bearer credentials, the same class of action a personal key
 * is gated for. So this module needs the operator's password (`--password` or
 * `PLATFORM_PASSWORD`), which is also the only reason `store-token` still has a
 * password path at all. A step-up token is single-use and lives about a minute,
 * so one is minted immediately before each gated call.
 */

import { errorMessage } from '@pipeline-builder/api-core';
import type { ApiClient } from './api-client.js';
import { printInfo, printSuccess, printWarning } from './output-utils.js';

/** Step-up header the platform reads (see api-core `requireStepUp`). */
const STEP_UP_HEADER = 'X-Step-Up-Token';

/** What the caller wants provisioned. */
export interface ProvisionKeyOptions {
  /** An authenticated client for the operator's own session. */
  client: ApiClient;
  /** The operator's password — required, because every key write is step-up gated. */
  password: string;
  /** Machine name of the service account (`[a-z0-9][a-z0-9_-]{1,63}`). */
  accountName: string;
  /** Human description recorded on a newly created account. */
  description: string;
  /**
   * Roles to grant a NEWLY created account: `'admin'` for the full-privilege
   * platform credential (synth/deploy callbacks, plugin lookup, image push),
   * `'none'` for a scoped credential, which needs no Roles at all.
   */
  roles: 'admin' | 'none';
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
  keys?: Array<{ id: string; status: string; createdAt: string }>;
}

/** HTTP status of a failed CLI request, or undefined for a transport error.
 *  `ApiError` carries it directly; a raw axios error only on the response. */
function statusOf(err: unknown): number | undefined {
  const e = err as { status?: number; response?: { status?: number } };
  const status = e?.status ?? e?.response?.status;
  return typeof status === 'number' ? status : undefined;
}

/** The platform's error code on a failed request, when it sent one. */
function errorCodeOf(err: unknown): string | undefined {
  const data = (err as { response?: { data?: { error?: { code?: string }; code?: string } } })?.response?.data;
  return data?.error?.code ?? data?.code;
}

/** Unwrap api-core's `{ success, data }` envelope (some paths return data bare). */
function unwrap<T>(response: unknown): T {
  const body = response as { data?: T };
  return (body?.data ?? response) as T;
}

/**
 * Mint a single-use step-up token for the signed-in operator. Short-lived by
 * design, so callers mint one immediately before each gated write rather than
 * holding one across the whole command.
 */
async function stepUp(client: ApiClient, password: string): Promise<string> {
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
}

/** The org the operator's token is active in. */
export async function resolveOrganizationId(client: ApiClient): Promise<string> {
  const res = await client.get<unknown>('/api/organization');
  const orgId = unwrap<{ organization?: { id?: string } }>(res)?.organization?.id;
  if (!orgId) {
    throw new Error('Could not resolve your active organization — the platform returned no organization for this token.');
  }
  return orgId;
}

/**
 * The org Role to give a full-privilege machine account: its Super Admin role if
 * the org has one (the system org does), else its Admin role. Both are subject to
 * the ordinary assignment ceiling on the platform side, so this can never grant
 * the account more than the operator holds.
 */
async function resolveAdminRoleId(client: ApiClient, orgId: string): Promise<string> {
  const res = await client.get<unknown>(`/api/organization/${orgId}/roles`);
  const roles = unwrap<{ roles?: Array<{ id: string; grantsRole?: string }> }>(res)?.roles ?? [];
  const role = roles.find((r) => r.grantsRole === 'superadmin') ?? roles.find((r) => r.grantsRole === 'admin');
  if (!role) {
    throw new Error(`Organization ${orgId} has no admin role to grant the machine service account.`);
  }
  return role.id;
}

/** Find an existing account by name (the name is the stable machine identifier). */
async function findAccount(client: ApiClient, orgId: string, name: string): Promise<AccountSummary | undefined> {
  const res = await client.get<unknown>(`/api/organization/${orgId}/service-accounts`);
  const accounts = unwrap<{ serviceAccounts?: AccountSummary[] }>(res)?.serviceAccounts ?? [];
  return accounts.find((a) => a.name === name);
}

/**
 * Create the account if it isn't there yet, and return its id. IDEMPOTENT: a
 * re-run reuses the existing account (including the 409 race where two runs
 * create it at once), and never re-grants Roles — an operator who narrowed the
 * account's Roles by hand must not have that undone by the next `store-token`.
 */
async function ensureAccount(opts: ProvisionKeyOptions, orgId: string): Promise<string> {
  const existing = await findAccount(opts.client, orgId, opts.accountName);
  if (existing) {
    printInfo('Reusing the existing service account', { account: opts.accountName, id: existing.id });
    return existing.id;
  }

  const roleIds = opts.roles === 'admin' ? [await resolveAdminRoleId(opts.client, orgId)] : [];
  try {
    const res = await opts.client.post<unknown>(
      `/api/organization/${orgId}/service-accounts`,
      { name: opts.accountName, description: opts.description, roleIds },
      { [STEP_UP_HEADER]: await stepUp(opts.client, opts.password) },
    );
    const account = unwrap<{ serviceAccount?: { id?: string } }>(res)?.serviceAccount;
    if (!account?.id) throw new Error('service-account create returned no id');
    printSuccess(`Created the '${opts.accountName}' service account`);
    return account.id;
  } catch (err) {
    if (statusOf(err) === 409) {
      const raced = await findAccount(opts.client, orgId, opts.accountName);
      if (raced) return raced.id;
    }
    throw err;
  }
}

/** Revoke one of an account's keys. Best-effort by contract — see the call sites. */
export async function revokeServiceAccountKey(
  client: ApiClient,
  password: string,
  orgId: string,
  accountId: string,
  keyId: string,
): Promise<void> {
  await client.delete(
    `/api/organization/${orgId}/service-accounts/${accountId}/keys/${keyId}`,
    { [STEP_UP_HEADER]: await stepUp(client, password) },
  );
}

/**
 * Issue a key, self-healing past the per-account active-key cap: at the cap the
 * OLDEST active key is retired and the mint retried once. The cap exists to bound
 * a compromise, not to make provisioning fail, and the credential a re-run is
 * replacing is the very thing that should go.
 */
async function issueKey(
  opts: ProvisionKeyOptions,
  orgId: string,
  accountId: string,
): Promise<{ key: string; accessKey: { id: string; expiresAt: string; scope: string | null } }> {
  const body = {
    name: opts.keyName,
    expiresIn: opts.expiresInSeconds,
    ...(opts.scope ? { scope: opts.scope } : {}),
  };
  const mint = async () => unwrap<{ key: string; accessKey: { id: string; expiresAt: string; scope: string | null } }>(
    await opts.client.post<unknown>(
      `/api/organization/${orgId}/service-accounts/${accountId}/keys`,
      body,
      { [STEP_UP_HEADER]: await stepUp(opts.client, opts.password) },
    ),
  );

  try {
    return await mint();
  } catch (err) {
    if (statusOf(err) !== 409 && errorCodeOf(err) !== 'SA_KEY_LIMIT') throw err;
    const account = await findAccount(opts.client, orgId, opts.accountName);
    const oldest = (account?.keys ?? [])
      .filter((k) => k.status === 'active')
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
    if (!oldest) throw err;
    printWarning(`Service account '${opts.accountName}' is at its active-key limit — retiring its oldest key (${oldest.id}).`);
    await revokeServiceAccountKey(opts.client, opts.password, orgId, accountId, oldest.id);
    return mint();
  }
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
  const serviceAccountId = await ensureAccount(opts, organizationId);
  const { key, accessKey } = await issueKey(opts, organizationId, serviceAccountId);
  return {
    key,
    keyId: accessKey.id,
    serviceAccountId,
    serviceAccountName: opts.accountName,
    organizationId,
    expiresAt: accessKey.expiresAt,
    scope: accessKey.scope ?? null,
  };
}
