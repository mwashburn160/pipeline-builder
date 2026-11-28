// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import type { ComponentProps } from 'react';
import dynamic from 'next/dynamic';
import type { ComposeModal as ComposeModalComponent } from '@/components/message/ComposeModal';

// Loaded on demand: compose only mounts while open, so it does not belong in
// the inbox's first paint.
const ComposeModal = dynamic(() => import('@/components/message/ComposeModal').then((m) => m.ComposeModal), { ssr: false });

type MessagesComposerProps = Omit<ComponentProps<typeof ComposeModalComponent>, 'isOpen'> & {
  /** Whether the composer is open. */
  open: boolean;
};

/**
 * The inbox's compose modal — mounted only while open (it starts a fresh draft
 * on every open anyway), so its chunk loads on first use.
 */
export function MessagesComposer({ open, ...props }: MessagesComposerProps) {
  if (!open) return null;
  return <ComposeModal isOpen {...props} />;
}
