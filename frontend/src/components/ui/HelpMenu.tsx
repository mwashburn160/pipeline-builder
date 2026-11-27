// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The top-bar Help ("?") menu: the `help` section of `NAV_SECTIONS` — Help,
 * the API catalog and Downloads (the CLI).
 */
import { HelpCircle } from 'lucide-react';
import { HELP_MENU_SECTION } from '@/lib/nav';
import { TopBarMenu, TopBarMenuLink } from './TopBarMenu';

export function HelpMenu() {
  return (
    <TopBarMenu
      label="Help and resources"
      triggerClassName="p-1.5 rounded-lg text-fg-muted hover:text-fg hover:bg-surface-muted transition-colors"
      trigger={<HelpCircle className="w-5 h-5" aria-hidden="true" />}
    >
      {(close) => HELP_MENU_SECTION.items.map((item) => (
        <TopBarMenuLink key={item.href} href={item.href} icon={item.icon} onSelect={close}>
          {item.title}
        </TopBarMenuLink>
      ))}
    </TopBarMenu>
  );
}
