// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import type { TextareaHTMLAttributes, Ref } from 'react';

interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  /** React 19 passes `ref` as a regular prop; spread onto the native
   *  `<textarea>` so callers can type-safely grab the DOM node. */
  ref?: Ref<HTMLTextAreaElement>;
}

/** Typed wrapper over the `.input` CSS layer for `<textarea>` controls. */
export function Textarea({ className = '', ...props }: TextareaProps) {
  return <textarea className={['input', className].filter(Boolean).join(' ')} {...props} />;
}
