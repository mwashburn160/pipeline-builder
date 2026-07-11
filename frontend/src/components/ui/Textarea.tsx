// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import type { TextareaHTMLAttributes } from 'react';

/** Typed wrapper over the `.input` CSS layer for `<textarea>` controls. */
export function Textarea({ className = '', ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={['input', className].filter(Boolean).join(' ')} {...props} />;
}
