// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useState } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { Input } from '@/components/ui/Input';

interface PrivateRepoFieldsProps {
  value: string;
  onChange: (token: string) => void;
  disabled?: boolean;
}

/**
 * "Private repository?" disclosure with the access-token field behind it.
 * The collapse is local state — nothing outside needs to know whether the
 * section is open, only what token was typed.
 */
export function PrivateRepoFields({ value, onChange, disabled }: PrivateRepoFieldsProps) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="flex items-center text-xs text-fg-muted hover:text-fg"
      >
        {open ? <ChevronUp className="w-3 h-3 mr-1" /> : <ChevronDown className="w-3 h-3 mr-1" />}
        Private repository?
      </button>
      {open && (
        <div className="mt-2">
          <Input
            type="password"
            autoComplete="off"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder="Personal access token for private repos"
            className="text-sm"
            disabled={disabled}
          />
        </div>
      )}
    </div>
  );
}
