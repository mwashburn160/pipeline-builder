// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useCallback, useMemo, useState } from 'react';
import type { useAuthGuard } from '@/hooks/useAuthGuard';
import { useFetch } from '@/hooks/useFetch';
import api from '@/lib/api';
import { aliasLocalPart } from '@/lib/support-label';
import { SYSTEM_ORG_ID } from '@/lib/constants';
import type { Message, SupportCaseSummary } from '@/types';

type InboxUser = ReturnType<typeof useAuthGuard>['user'];

/** Org id → display name for the inbox, and a resolver over it. */
export function useInboxOrgNames(
  organizations: ReadonlyArray<{ id: string; name: string }>,
  messages: Message[],
  supportAlias: string,
) {
  // Client-side org id → name map for DISPLAY backfill. Prefers the authoritative
  // `orgName`/`recipientOrgName` the server enriches onto each message, falls back
  // to the caller's own org memberships, and special-cases the system support org.
  // Lets the UI show a name even before/without server-side name resolution.
  const orgNameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const o of organizations) m.set(o.id.toLowerCase(), o.name);
    for (const msg of messages) {
      if (msg.orgName) m.set(msg.orgId.toLowerCase(), msg.orgName);
      if (msg.recipientOrgName && msg.recipientOrgId !== '*') {
        m.set(msg.recipientOrgId.toLowerCase(), msg.recipientOrgName);
      }
    }
    // The system tenant is the support desk: show the primary support alias's
    // local-part (e.g. "support") — override its raw org name ("system"), which is
    // enriched onto messages and would otherwise win.
    m.set(SYSTEM_ORG_ID, aliasLocalPart(supportAlias));
    return m;
  }, [organizations, messages, supportAlias]);

  const resolveOrgName = useCallback(
    (id?: string | null): string | undefined => (id ? orgNameById.get(id.toLowerCase()) : undefined),
    [orgNameById],
  );

  return { orgNameById, resolveOrgName };
}

/**
 * Options for the sender and counterparty filters: teammates (fetched on first
 * use of the sender select) and every org the inbox knows a name for.
 */
export function useInboxFilterOptions({ user, currentOrgId, from, org, orgNameById }: {
  user: InboxUser;
  currentOrgId: string;
  /** The active sender filter (`user:<id>` names a teammate). */
  from: string;
  /** The active counterparty-org filter. */
  org: string;
  orgNameById: Map<string, string>;
}) {
  // Teammates for "Sent by <person>": fetched on first use of the sender
  // select (or when a linked URL already names one), not on every inbox load.
  const [membersWanted, setMembersWanted] = useState(false);
  const wantMembers = membersWanted || from.startsWith('user:');
  const membersQ = useFetch(async () => {
    if (!wantMembers || !user?.organizationId) return [];
    try {
      const res = await api.getOrganizationMembers(user.organizationId, { limit: 50, status: 'active' });
      return (res.data?.members ?? []).map((m) => ({ id: m.id, label: m.username || m.email || m.id }));
    } catch {
      return []; // best-effort: no teammate options, the relative choices still work
    }
  }, [wantMembers, currentOrgId]);
  const teammateOptions = useMemo(() => {
    const list = (membersQ.data ?? []).filter((m) => m.id !== user?.id);
    const linked = from.startsWith('user:') ? from.slice('user:'.length) : '';
    if (linked && !list.some((m) => m.id === linked) && linked !== user?.id) list.unshift({ id: linked, label: linked });
    return list;
  }, [membersQ.data, from, user?.id]);
  // Counterparty orgs: every org this inbox knows a name for (memberships +
  // orgs on loaded rows), minus our own, plus a linked one not yet seen.
  const counterpartyOptions = useMemo(() => {
    const out = [...orgNameById.entries()]
      .filter(([id]) => id !== currentOrgId && id !== '*')
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name));
    if (org && !out.some((o) => o.id === org.toLowerCase())) out.unshift({ id: org, name: org });
    return out;
  }, [orgNameById, currentOrgId, org]);

  return { setMembersWanted, teammateOptions, counterpartyOptions };
}

/** The org's support cases (keyed by thread) and its designated support contacts. */
export function useSupportDesk(currentOrgId: string) {
  /**
   * The org's support cases, keyed by `threadId` so a row looks itself up.
   *
   * Fetched once per org rather than per row: the case identity IS the root
   * message id, so one list joins onto every support row in the inbox without
   * an N+1. Scoped server-side by RLS — there is no org parameter to get wrong.
   *
   * Failure resolves to `{}` rather than an error state: a missing case chip
   * degrades a row to exactly how it looked before cases existed, which is not
   * worth interrupting an inbox for.
   */
  const supportCasesQ = useFetch(async () => {
    const res = await api.getSupportCases();
    const byThread: Record<string, SupportCaseSummary> = {};
    for (const c of res.data?.cases ?? []) byThread[c.threadId] = c;
    return byThread;
  }, [currentOrgId]);

  /**
   * This org's designated support contacts — the handover candidates.
   *
   * Fetched alongside the cases rather than per-case: the list is per ORG, so
   * one request serves every case in the inbox. Failure resolves to `[]`, which
   * hides the handover control rather than breaking the panel — a picker with no
   * candidates is worse than no picker.
   */
  const supportContactsQ = useFetch(async () => {
    const res = await api.getSupportContacts();
    return res.data?.contacts ?? [];
  }, [currentOrgId]);

  return { supportCasesQ, supportContactsQ };
}
