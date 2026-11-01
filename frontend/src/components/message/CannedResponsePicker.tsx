// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useState } from 'react';
import { Select } from '@/components/ui/Select';
import { useFetch } from '@/hooks/useFetch';
import api from '@/lib/api';
import type { CannedResponse } from '@/types';

interface CannedResponsePickerProps {
  /** Called with the template body when one is chosen. */
  onPick: (body: string) => void;
}

/**
 * Insert a reusable reply into the staff reply box.
 *
 * The templates are SYSTEM-WIDE — the vendor's own wording for recurring
 * questions, authored once rather than retyped badly fifty times — so there is
 * no org scope here and the read is staff-gated as hard as the writes (the
 * table carries no `org_id`, so there is no tenancy boundary underneath it to
 * fall back on).
 *
 * INSERTS, never sends. Picking a template fills the box and leaves the cursor
 * there, because the whole value of a canned reply is the part the staff member
 * then changes — a template that sends itself is a macro, and a macro answering
 * a support case is how a customer gets a reply to a question they did not ask.
 *
 * Renders nothing when the library is empty. A picker with no options is worse
 * than no picker: it implies a feature that has not been set up and invites a
 * click that does nothing.
 */
export function CannedResponsePicker({ onPick }: CannedResponsePickerProps) {
  const [key, setKey] = useState(0);
  const templates = useFetch(async () => {
    const res = await api.getCannedResponses();
    return res.data?.responses ?? [];
  }, []);

  const list: CannedResponse[] = templates.data ?? [];
  if (templates.loading || list.length === 0) return null;

  return (
    <Select
      // Remounted after each pick so the control returns to its placeholder:
      // it is an insert action, not a value, and leaving the last choice
      // selected would read as "this reply is that template".
      key={key}
      defaultValue=""
      aria-label="Insert a canned reply"
      className="text-xs"
      onChange={(e) => {
        const picked = list.find((t) => t.id === e.target.value);
        if (!picked) return;
        onPick(picked.body);
        setKey((k) => k + 1);
      }}
    >
      <option value="">Insert a canned reply…</option>
      {list.map((t) => <option key={t.id} value={t.id}>{t.title}</option>)}
    </Select>
  );
}
