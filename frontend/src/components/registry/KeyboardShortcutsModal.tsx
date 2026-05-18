// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { Modal } from '@/components/ui/Modal';

interface KeyboardShortcutsModalProps {
  onClose: () => void;
}

interface Shortcut {
  keys: string[];
  description: string;
}

const SHORTCUTS: Shortcut[] = [
  { keys: ['j'], description: 'Move repository selection down' },
  { keys: ['k'], description: 'Move repository selection up' },
  { keys: ['/'], description: 'Focus the repository filter' },
  { keys: ['c'], description: 'Copy the active tag' },
  { keys: ['d'], description: 'Delete the active tag' },
  { keys: ['?'], description: 'Show this shortcuts overlay' },
  { keys: ['Esc'], description: 'Close any open modal' },
];

/**
 * Shortcuts overlay shown when the operator presses `?`. The shortcuts
 * themselves are wired at the page level — this modal just documents them
 * so the keyboard surface is discoverable instead of buried in a tip.
 */
export function KeyboardShortcutsModal({ onClose }: KeyboardShortcutsModalProps) {
  return (
    <Modal title="Keyboard shortcuts" onClose={onClose} maxWidth="max-w-md">
      <ul className="divide-y divide-gray-100 dark:divide-gray-800">
        {SHORTCUTS.map((s) => (
          <li key={s.keys.join('+')} className="flex items-center justify-between py-2">
            <span className="text-sm text-gray-700 dark:text-gray-300">{s.description}</span>
            <span className="flex gap-1">
              {s.keys.map((k) => (
                <kbd
                  key={k}
                  className="px-2 py-0.5 text-xs font-mono border border-gray-300 dark:border-gray-600 rounded bg-gray-50 dark:bg-gray-800 text-gray-700 dark:text-gray-200"
                >
                  {k}
                </kbd>
              ))}
            </span>
          </li>
        ))}
      </ul>
      <div className="mt-4 text-xs text-gray-500 dark:text-gray-400">
        Shortcuts are disabled while typing in a form field or while any modal is open.
      </div>
    </Modal>
  );
}
