// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useCallback, useMemo } from 'react';
import { useFetch } from '@/hooks/useFetch';
import type { useMessages } from '@/hooks/useMessages';
import api from '@/lib/api';
import type { Message } from '@/types';
import type { MemberOption } from './RecipientPicker';

/**
 * What the composer needs from the inbox: recent recipients, the send handler,
 * member / org-directory search, the account's reachable orgs (fetched only
 * while composing) and the attachment upload.
 */
export function useInboxCompose({ messages, currentOrgId, resolveOrgName, sendMessage, isSuperAdmin, canWrite, showCompose }: {
  messages: Message[];
  currentOrgId: string;
  resolveOrgName: (id?: string | null) => string | undefined;
  sendMessage: ReturnType<typeof useMessages>['sendMessage'];
  isSuperAdmin: boolean;
  canWrite: boolean;
  showCompose: boolean;
}) {
  // Recent recipients — distinct counterparty orgs from the loaded inbox,
  // most-recent first, for a one-tap quick-pick in compose. Excludes broadcasts
  // and the caller's own org; labels resolve to names (id fallback).
  const recentRecipients = useMemo(() => {
    const seen = new Set<string>();
    const out: { value: string; label: string }[] = [];
    for (const m of messages) {
      if (m.messageType === 'announcement') continue;
      const isMine = m.orgId.toLowerCase() === currentOrgId;
      const otherId = isMine ? m.recipientOrgId : m.orgId;
      const otherName = isMine ? m.recipientOrgName : m.orgName;
      if (!otherId || otherId === '*') continue;
      const key = otherId.toLowerCase();
      if (key === currentOrgId || seen.has(key)) continue;
      seen.add(key);
      out.push({ value: otherId, label: otherName || resolveOrgName(otherId) || otherId });
      if (out.length >= 6) break;
    }
    return out;
  }, [messages, currentOrgId, resolveOrgName]);

  // A failed send REJECTS with the server's reason; letting it propagate is
  // what puts that reason in the composer's alert (ComposeModal's
  // send mutation surfaces it) while the form stays open for a retry.
  const handleSend = useCallback(async (data: Parameters<typeof sendMessage>[0]): Promise<boolean> => {
    const result = await sendMessage(data);
    return result !== null;
  }, [sendMessage]);

  // Member search backing the compose "specific user" typeahead. Server-side
  // search over the selected org's roster; caps the page and maps to the minimal
  // shape the picker needs. Best-effort — a failure yields no suggestions.
  const fetchMembers = useCallback(async (orgId: string, search: string): Promise<MemberOption[]> => {
    try {
      const res = await api.getOrganizationMembers(orgId, { search, limit: 10, status: 'active' });
      return (res.data?.members ?? []).map((m) => ({ id: m.id, username: m.username, email: m.email }));
    } catch {
      return [];
    }
  }, []);

  // Cross-org directory search backing the compose recipient combobox —
  // SYSADMIN ONLY, since only sysadmins may message an org they don't belong to
  // (the send-reachability gate is bypassed for isSystemAdmin). Reuses the
  // sysadmin org roster (GET /api/organizations, supports `search`); best-effort.
  const searchRecipients = useCallback(async (query: string): Promise<{ value: string; label: string }[]> => {
    const q = query.trim();
    if (!isSuperAdmin || !q) return [];
    try {
      const res = await api.listOrganizations({ search: q, limit: 10 });
      return (res.data?.organizations ?? [])
        .filter((o) => o.id.toLowerCase() !== currentOrgId)
        .map((o) => ({ value: o.id, label: o.name }));
    } catch {
      return [];
    }
  }, [isSuperAdmin, currentOrgId]);

  // Compose recipients: every org in the caller's account (root + teams), from
  // the message service's own reachability listing — the same set its send gate
  // admits, not just the orgs this user happens to belong to. Fetched only while
  // composing, and only for `messages:write` holders (the endpoint's gate).
  const recipientOrgsQ = useFetch(async () => {
    if (!canWrite || !showCompose) return [];
    const res = await api.getRecipientOrgs();
    return res.data?.orgs ?? [];
  }, [canWrite, showCompose, currentOrgId]);
  const recipientSuggestions = useMemo(
    () => (recipientOrgsQ.data ?? [])
      .filter((o) => o.orgId.toLowerCase() !== currentOrgId)
      .map((o) => ({ value: o.orgId, label: o.name, isTeam: o.isTeam })),
    [recipientOrgsQ.data, currentOrgId],
  );

  // Upload one attachment; returns its metadata (id linked on send).
  const uploadAttachment = useCallback(async (file: File) => {
    const res = await api.uploadAttachment(file);
    if (!res.data?.attachment) throw new Error('Upload failed');
    return res.data.attachment;
  }, []);

  return { recentRecipients, handleSend, fetchMembers, searchRecipients, recipientSuggestions, uploadAttachment };
}
