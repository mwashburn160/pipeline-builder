// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The top-bar avatar menu: who you are signed in as, your own settings (the
 * `account` section of `NAV_SECTIONS`), the theme, and sign out.
 */
import { LogOut, Moon, Sun } from 'lucide-react';
import { ACCOUNT_MENU_SECTION } from '@/lib/nav';
import type { User } from '@/types';
import { TopBarMenu, TopBarMenuButton, TopBarMenuDivider, TopBarMenuLink } from './TopBarMenu';

interface AvatarMenuProps {
  user: User;
  isDark: boolean;
  onToggleDark: () => void;
  onLogout: () => void;
}

export function AvatarMenu({ user, isDark, onToggleDark, onLogout }: AvatarMenuProps) {
  // Initials from whatever the token actually carries: `username` is typed as
  // required but arrives from a JWT, and a session without one must still
  // render a menu, not a blank top bar.
  const initials = (user.username || user.email || '?').slice(0, 2);
  return (
    <TopBarMenu
      label="Account menu"
      widthClassName="w-60"
      triggerClassName="grid h-8 w-8 place-items-center rounded-full bg-surface-muted text-2xs font-semibold uppercase text-fg-muted hover:text-fg hover:ring-2 hover:ring-brand/30 transition-colors"
      trigger={<span aria-hidden="true">{initials}</span>}
    >
      {(close) => (
        <>
          <div className="px-3 py-2 border-b border-default mb-1">
            <p className="truncate text-sm font-medium text-fg">{user.username}</p>
            {user.email && <p className="truncate text-xs text-fg-subtle">{user.email}</p>}
          </div>
          {ACCOUNT_MENU_SECTION.items.map((item) => (
            <TopBarMenuLink key={item.href} href={item.href} icon={item.icon} onSelect={close}>
              {item.title}
            </TopBarMenuLink>
          ))}
          <TopBarMenuDivider />
          <TopBarMenuButton icon={isDark ? Sun : Moon} onSelect={() => { close(); onToggleDark(); }}>
            {isDark ? 'Light mode' : 'Dark mode'}
          </TopBarMenuButton>
          <TopBarMenuButton icon={LogOut} danger onSelect={() => { close(); onLogout(); }}>
            Sign out
          </TopBarMenuButton>
        </>
      )}
    </TopBarMenu>
  );
}
